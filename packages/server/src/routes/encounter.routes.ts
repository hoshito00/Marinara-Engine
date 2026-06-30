// ──────────────────────────────────────────────
// Routes: Combat Encounter (non-streaming JSON)
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { createChatsStorage } from "../services/storage/chats.storage.js";
import { createConnectionsStorage } from "../services/storage/connections.storage.js";
import { createCharactersStorage } from "../services/storage/characters.storage.js";
import { createGameStateStorage } from "../services/storage/game-state.storage.js";
import { createLorebooksStorage } from "../services/storage/lorebooks.storage.js";
import { mapSheetAttributesToRPG } from "../services/game/skill-check.service.js";
import { createLLMProvider } from "../services/llm/provider-registry.js";
import type { ChatMessage } from "../services/llm/base-provider.js";
import { logger, logDebugOverride } from "../lib/logger.js";
import { normalizeRpgStatPools, stripMacroComments } from "@marinara-engine/shared";
import type {
  EncounterInitRequest,
  EncounterActionRequest,
  EncounterSummaryRequest,
  NarrativeStyle,
  CombatPartyMember,
  CombatEnemy,
  CombatPlayerActions,
  CombatActionResult,
  EncounterLogEntry,
  HoshitoEncounterInitRequest,
  HoshitoEncounterActionRequest,
  HoshitoEncounterActionResponse,
  HoshitoCombatState,
  RPGStatsConfig,
} from "@marinara-engine/shared";
import {
  HOSHITO_RESISTANCE_MULTIPLIERS,
} from "@marinara-engine/shared";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

const COMBAT_BLUEPRINT_OUTPUT_TOKENS = 12000;

function cardPromptText(value: unknown): string {
  return typeof value === "string" ? stripMacroComments(value).trim() : "";
}

function configuredHpMax(rpgStats: RPGStatsConfig | undefined): number | null {
  if (!rpgStats?.enabled) return null;
  const hpPool = normalizeRpgStatPools(rpgStats).find((pool) =>
    /^(?:hp|health|health points?|hit points?)$/i.test(pool.name.trim()),
  );
  const max = Number(hpPool?.max ?? rpgStats.hp?.max);
  return Number.isFinite(max) && max > 0 ? max : null;
}

/** Resolve a connection (handles "random" pool + baseUrl fallback). */
async function resolveConnection(
  connections: ReturnType<typeof createConnectionsStorage>,
  connId: string | null,
  chatConnectionId: string | null,
) {
  let id = connId ?? chatConnectionId;
  if (id === "random") {
    const pool = await connections.listRandomPool();
    if (!pool.length) throw new Error("No connections marked for the random pool");
    id = pool[Math.floor(Math.random() * pool.length)].id;
  }
  if (!id) throw new Error("No API connection configured");
  const conn = await connections.getWithKey(id);
  if (!conn) throw new Error("API connection not found");

  let baseUrl = conn.baseUrl;
  if (!baseUrl) {
    const { PROVIDERS } = await import("@marinara-engine/shared");
    const providerDef = PROVIDERS[conn.provider as keyof typeof PROVIDERS];
    baseUrl = providerDef?.defaultBaseUrl ?? "";
  }
  // Claude (Subscription) uses the local Claude Agent SDK and has no HTTP
  // endpoint — return a sentinel so the gate passes. The provider ignores it.
  if (!baseUrl && conn.provider === "claude_subscription") baseUrl = "claude-agent-sdk://local";
  if (!baseUrl && conn.provider === "openai_chatgpt") baseUrl = "openai-chatgpt://codex-auth";
  if (!baseUrl) throw new Error("No base URL configured for this connection");

  return { conn, baseUrl };
}

/** Extract reliable JSON from an LLM response that may include markdown fences. */
function parseJSON(raw: string): unknown {
  // Strip code fences (```json ... ``` or ``` ... ```)
  let cleaned = raw
    .trim()
    .replace(/^```(?:json|markdown)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "");
  // Find the first { and use balanced braces to find the matching }
  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in AI response");
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(cleaned.substring(start, i + 1));
    }
  }
  throw new Error("Unbalanced JSON in AI response");
}

function fallbackActionResult(input: EncounterActionRequest): CombatActionResult {
  return {
    combatStats: {
      party: input.combatStats.party,
      enemies: input.combatStats.enemies,
    },
    playerActions: input.playerActions ?? { attacks: [], items: [] },
    enemyActions: [],
    partyActions: [],
    narrative: "",
  };
}

/** Build character context from the chat's character IDs. */
async function buildCharacterContext(chars: ReturnType<typeof createCharactersStorage>, characterIds: string[]) {
  let ctx = "";
  for (const cid of characterIds) {
    const row = await chars.getById(cid);
    if (!row) continue;
    const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    ctx += `<character="${data.name}">\n`;
    if (data.description) ctx += `${data.description}\n`;
    if (data.personality) ctx += `${data.personality}\n`;
    // RPG stats from the character card (Marinara extension). Surface the
    // configured max HP so the combat-init AI honors the user-defined value
    // instead of inventing one for allies. Only `max` is exposed because
    // combat should always start at full HP regardless of the card's stale
    // `value` field — narrative damage applies after combat begins.
    const rpg = data.extensions?.rpgStats as RPGStatsConfig | undefined;
    const allyMaxHp = configuredHpMax(rpg);
    if (rpg?.enabled && allyMaxHp) {
      ctx += `Max HP: ${allyMaxHp}\n`;
      if (Array.isArray(rpg.attributes) && rpg.attributes.length > 0) {
        ctx += `Attributes: ${rpg.attributes.map((a: { name: string; value: number }) => `${a.name} ${a.value}`).join(", ")}\n`;
      }
    }
    ctx += `</character>\n\n`;
  }
  return ctx;
}

/**
 * Build persona context. Prefers the chat-scoped persona (`chat.personaId`)
 * before falling back to the globally active persona — mirrors the same
 * resolution order used elsewhere (see `chats.routes.ts`). Without this, a
 * user who picks a per-chat persona but doesn't have a matching global active
 * persona ends up named "User" in combat because the encounter prompt's
 * `${personaName}` placeholder defaulted to that string.
 */
async function buildPersonaContext(chars: ReturnType<typeof createCharactersStorage>, chatPersonaId: string | null) {
  const allPersonas = await chars.listPersonas();
  const persona =
    (chatPersonaId ? allPersonas.find((p) => p.id === chatPersonaId) : null) ??
    allPersonas.find((p) => p.isActive === "true");
  if (!persona) return { personaName: "User", personaCtx: "No persona information available." };
  let ctx = `Name: ${persona.name}\n`;
  const description = cardPromptText(persona.description);
  const personality = cardPromptText(persona.personality);
  const backstory = cardPromptText(persona.backstory);
  const appearance = cardPromptText(persona.appearance);
  if (description) ctx += `${description}\n`;
  if (personality) ctx += `${personality}\n`;
  if (backstory) ctx += `${backstory}\n`;
  if (appearance) ctx += `${appearance}\n`;
  // Surface configured persona stats (status bars + RPG attributes) so the
  // combat-init AI uses the user-defined HP instead of inventing values.
  // `personaStats` is stored as a JSON string of { enabled, bars, rpgStats? }.
  let personaStats: Record<string, unknown> | null = null;
  if (persona.personaStats) {
    if (typeof persona.personaStats === "string") {
      try {
        personaStats = JSON.parse(persona.personaStats);
      } catch {
        personaStats = null;
      }
    } else {
      personaStats = persona.personaStats as Record<string, unknown>;
    }
  }
  // Only configured maxes are exposed — combat always starts at full HP.
  // The bar/stat `value` field is the running gameplay value and is not
  // authoritative for combat entry.
  if (personaStats?.enabled && Array.isArray(personaStats.bars) && personaStats.bars.length > 0) {
    const renderedBars: string[] = [];
    for (const bar of personaStats.bars as Array<{ name: string; value: number; max: number }>) {
      const max = Number(bar.max);
      if (Number.isFinite(max) && max > 0) {
        renderedBars.push(`- ${bar.name} max: ${max}\n`);
      }
    }
    if (renderedBars.length > 0) {
      ctx += `Persona Stat Bars (configured max for each):\n${renderedBars.join("")}`;
    }
  }
  const personaRpg = personaStats?.rpgStats as RPGStatsConfig | undefined;
  const personaMaxHp = configuredHpMax(personaRpg);
  if (personaRpg?.enabled && personaMaxHp) {
    ctx += `Persona RPG Stats:\n`;
    ctx += `- Max HP: ${personaMaxHp}\n`;
    if (Array.isArray(personaRpg.attributes) && personaRpg.attributes.length > 0) {
      ctx += `- Attributes: ${personaRpg.attributes.map((a) => `${a.name} ${a.value}`).join(", ")}\n`;
    }
  }
  // Surface configured Hoshito stats (domains, attributes, grades) so the combat-init AI
  // uses the user's EXACT custom layout — names, grades, and Sparks — instead of inventing
  // a default 9-attribute schema. `hoshitoStats` is the freeform domain/attribute structure
  // configured in the Persona Editor; only non-default (renamed) layouts benefit from this,
  // but it is always emitted when enabled so the GM never has to guess.
  const personaHoshito = personaStats?.hoshitoStats as
    | {
        enabled?: boolean;
        level?: number;
        domains?: Array<{ name: string; attributes: Array<{ name: string; grade: string; sparks: number; vestigeSparks: number }> }>;
        verve?: number;
        storyPoints?: number;
        healthMaxOverride?: number;
        staggerMaxOverride?: number;
        apMaxOverride?: number;
        isExalted?: boolean;
        merits?: Array<{ category: string; name: string; description: string; sparkGrantAttribute?: string; dormant?: boolean }>;
        coreMerits?: Array<{ type: string; description: string; attributeGrant?: string; grantedSpark?: boolean }>;
      }
    | undefined;
  if (personaHoshito?.enabled && Array.isArray(personaHoshito.domains) && personaHoshito.domains.length > 0) {
    ctx += `Persona Hoshito Stats (use these EXACT Domain/Attribute names and Grades — do not invent a different layout):\n`;
    ctx += `- Level: ${personaHoshito.level ?? 1}\n`;
    for (const domain of personaHoshito.domains) {
      const attrList = domain.attributes
        .map((a) => `${a.name} ${a.grade}${a.sparks > 0 ? ` (${a.sparks} Spark${a.sparks > 1 ? "s" : ""})` : ""}${a.vestigeSparks > 0 ? ` (${a.vestigeSparks} Vestige)` : ""}`)
        .join(", ");
      ctx += `- ${domain.name}: ${attrList}\n`;
    }
    if (personaHoshito.verve != null) ctx += `- Verve: ${personaHoshito.verve}\n`;
    if (personaHoshito.storyPoints != null) ctx += `- Story Points: ${personaHoshito.storyPoints}\n`;
    if (personaHoshito.healthMaxOverride) ctx += `- Health max override: ${personaHoshito.healthMaxOverride}\n`;
    if (personaHoshito.staggerMaxOverride) ctx += `- Stagger max override: ${personaHoshito.staggerMaxOverride}\n`;
    if (personaHoshito.apMaxOverride) ctx += `- AP max override: ${personaHoshito.apMaxOverride}\n`;
    if (personaHoshito.isExalted) ctx += `- Exalted: true (level cap 52, F+ markers active)\n`;
    if (personaHoshito.coreMerits && personaHoshito.coreMerits.length > 0) {
      ctx += `- Core Merits:\n`;
      for (const cm of personaHoshito.coreMerits) {
        const grant = cm.grantedSpark ? "1 Spark" : cm.attributeGrant ? `Grade step on ${cm.attributeGrant}` : "no grant set";
        ctx += `  - [${cm.type}] ${cm.description} (${grant})\n`;
      }
    }
    if (personaHoshito.merits && personaHoshito.merits.length > 0) {
      ctx += `- Merits:\n`;
      for (const m of personaHoshito.merits) {
        const spark = m.sparkGrantAttribute ? `, Spark → ${m.sparkGrantAttribute}` : "";
        const dormant = m.dormant ? ", dormant" : "";
        ctx += `  - [${m.category}] ${m.name}: ${m.description}${spark}${dormant}\n`;
      }
    }
  }
  return { personaName: persona.name, personaCtx: ctx };
}

/** Get the latest game state context string for the chat. */
async function buildGameStateContext(
  gsStorage: ReturnType<typeof createGameStateStorage>,
  chatId: string,
  personaName: string,
  chatMeta?: Record<string, unknown> | null,
) {
  const gs = await gsStorage.getLatest(chatId);
  if (!gs) return "";
  let ctx = "";
  if (gs.location) ctx += `Location: ${gs.location}\n`;
  if (gs.weather) ctx += `Weather: ${gs.weather}\n`;
  if (gs.time) ctx += `Time: ${gs.time}\n`;
  if (gs.date) ctx += `Date: ${gs.date}\n`;

  const playerStats = gs.playerStats
    ? typeof gs.playerStats === "string"
      ? JSON.parse(gs.playerStats)
      : gs.playerStats
    : null;
  if (playerStats) {
    ctx += `\n${personaName}'s Stats:\n`;
    if (playerStats.stats?.length) {
      for (const s of playerStats.stats) ctx += `  ${s.name}: ${s.value}/${s.max}\n`;
    }
    if (playerStats.inventory?.length) {
      ctx += `${personaName}'s Inventory:\n`;
      for (const item of playerStats.inventory) {
        ctx += `  - ${item.name}${item.quantity > 1 ? ` x${item.quantity}` : ""}\n`;
      }
    }
    if (playerStats.attributes) {
      const a = playerStats.attributes;
      ctx += `Attributes: STR ${a.str}, DEX ${a.dex}, CON ${a.con}, INT ${a.int}, WIS ${a.wis}, CHA ${a.cha}\n`;
    }
    // Live Hoshito character data — current Health/Stagger (not just maxes), Domains/Grades/
    // Sparks with their actual configured names, Strand, Exaltation, and Resistances. Combat
    // init and action prompts both pull from this string, so this is the GM's only window into
    // the character's real Hoshito layout during an active session.
    const h = playerStats.hoshitoStats as
      | {
          level?: number;
          domains?: Array<{ name: string; attributes: Array<{ name: string; grade: string; sparks: number; vestigeSparks: number }> }>;
          strand?: { name: string; primaryAttribute: string };
          health?: number; healthMax?: number;
          stagger?: number; staggerMax?: number;
          apMax?: number;
          coins?: number;
          verve?: number; storyPoints?: number;
          isExalted?: boolean;
          resistances?: Array<{ type: string; healthTier: string; staggerTier: string }>;
          merits?: Array<{ category: string; name: string; description: string; sparkGrantAttribute?: string; dormant?: boolean }>;
          coreMerits?: Array<{
            type: string;
            description: string;
            attributeGrant?: string;
            grantedSpark?: boolean;
            transformations?: Array<{ merit: { category: string; name: string; description: string }; level: number; narrative: string }>;
          }>;
        }
      | undefined;
    if (h && Array.isArray(h.domains) && h.domains.length > 0) {
      ctx += `\n${personaName}'s Hoshito Character (use these EXACT names/grades — do not invent a different layout):\n`;
      ctx += `- Level: ${h.level ?? 1}${h.isExalted ? " (Exalted — cap 52)" : ""}\n`;
      for (const domain of h.domains) {
        const attrList = domain.attributes
          .map((attr) => `${attr.name} ${attr.grade}${attr.sparks > 0 ? ` (${attr.sparks} Spark${attr.sparks > 1 ? "s" : ""})` : ""}${attr.vestigeSparks > 0 ? ` (${attr.vestigeSparks} Vestige)` : ""}`)
          .join(", ");
        ctx += `- ${domain.name}: ${attrList}\n`;
      }
      if (h.strand) ctx += `- Strand: ${h.strand.name} (Primary: ${h.strand.primaryAttribute})\n`;
      if (h.healthMax != null) ctx += `- Health: ${h.health ?? h.healthMax}/${h.healthMax}\n`;
      if (h.staggerMax != null) ctx += `- Stagger: ${h.stagger ?? h.staggerMax}/${h.staggerMax}\n`;
      if (h.apMax != null) ctx += `- AP max: ${h.apMax}\n`;
      if (h.coins != null) ctx += `- Coins: ${h.coins}\n`;
      if (h.verve != null) ctx += `- Verve: ${h.verve}\n`;
      if (h.storyPoints != null) ctx += `- Story Points: ${h.storyPoints}\n`;
      if (h.resistances && h.resistances.length > 0) {
        ctx += `- Resistances: ${h.resistances.map((r) => `${r.type} (HP ${r.healthTier} / Stagger ${r.staggerTier})`).join(", ")}\n`;
      }
      if (h.coreMerits && h.coreMerits.length > 0) {
        ctx += `- Core Merits:\n`;
        for (const cm of h.coreMerits) {
          const grant = cm.grantedSpark ? "1 Spark" : cm.attributeGrant ? `Grade step on ${cm.attributeGrant}` : "no grant set";
          ctx += `  - [${cm.type}] ${cm.description} (${grant})\n`;
          if (cm.transformations && cm.transformations.length > 0) {
            for (const t of cm.transformations) {
              ctx += `    - Lv${t.level} transformation: [${t.merit.category}] ${t.merit.name} — ${t.merit.description}${t.narrative ? ` (${t.narrative})` : ""}\n`;
            }
          }
        }
      }
      if (h.merits && h.merits.length > 0) {
        ctx += `- Merits:\n`;
        for (const m of h.merits) {
          const spark = m.sparkGrantAttribute ? `, Spark → ${m.sparkGrantAttribute}` : "";
          const dormant = m.dormant ? ", dormant" : "";
          ctx += `  - [${m.category}] ${m.name}: ${m.description}${spark}${dormant}\n`;
        }
      }
    }
  }

  // Fallback: if playerStats.attributes is missing (it is never seeded today),
  // surface the player's Game Mode character-sheet attributes so the encounter
  // init prompt can scale combat stats to match the build.
  if (!playerStats?.attributes && chatMeta) {
    const cards = Array.isArray(chatMeta.gameCharacterCards)
      ? (chatMeta.gameCharacterCards as Array<Record<string, unknown>>)
      : [];
    const playerCard = cards[0];
    const rpgStats = playerCard?.rpgStats as { attributes?: Array<{ name: string; value: number }> } | undefined;
    const mapped = mapSheetAttributesToRPG(rpgStats?.attributes);
    const ordered: Array<keyof typeof mapped> = ["str", "dex", "con", "int", "wis", "cha"];
    const present = ordered.filter((k) => mapped[k] != null);
    if (present.length > 0) {
      const labels: Record<string, string> = {
        str: "STR",
        dex: "DEX",
        con: "CON",
        int: "INT",
        wis: "WIS",
        cha: "CHA",
      };
      const line = present.map((k) => `${labels[k]} ${mapped[k]}`).join(", ");
      ctx += `${personaName}'s Character Sheet Attributes: ${line}\n`;
    }
  }

  const presentChars = gs.presentCharacters
    ? typeof gs.presentCharacters === "string"
      ? JSON.parse(gs.presentCharacters)
      : gs.presentCharacters
    : [];
  if (presentChars.length) {
    ctx += `\nPresent Characters:\n`;
    for (const pc of presentChars) {
      ctx += `  - ${pc.name} (${pc.mood}): ${pc.action}\n`;
    }
  }
  return ctx;
}

// ──────────────────────────────────────────────
// Prompt Builders
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// Hoshito Prompt Builders
// ──────────────────────────────────────────────

/**
 * System knowledge block injected into both Hoshito prompts.
 * Teaches the GM the Hoshito combat rules in compact form.
 */
const HOSHITO_RULES_BLOCK = `
=== HOSHITO COMBAT RULES (read before generating any combat data) ===

DICE TIERS
Mastery Die (weapon/skill tier): Untrained→d6 · Trained→d8 · Expert→d10 · Master→d12
Speed Die (AGI Grade):  E→d4 · D→d6 · C→d8 · B→d10 · A→d12 · S→d14 · SS→d16 · SSS→d18 · EX→d20

COMBAT RESOURCES (all live values — update them each action)
• Health & Stagger are separate damage pools. Health hits 0 = KO. Stagger hits 0 = Staggered.
• Staggered: no Skills/Speed Dice/AP recovery/resistances/Stagger regain this Scene.
• AP (Action Points): typically 3 (heroes), 2 (minions), 4-5 (elites/bosses). Resets at turn start.
• Coins: start at 3. Spend to retry a Clash. Regain 1 when you Stagger or Eliminate a target.
• coinBonus = Attribute Grade Mod of the relevant skill + Domain Spark total for that Domain.
• Morale: bidirectional, −45 to +45, starts at 0 each encounter.
  Thresholds:  +45 → +3 Power | +30 → +2 | +15 → +1 | 0 → 0 | −15 → −1 | −30 → −2 | −45 → −3.
• masteryMod = (relevant Attribute Grade Mod) + (Domain Sparks on that Attribute) + (Morale modifier).

CLASH RESOLUTION (one round of attack vs defense)
1. Attacker rolls masteryDie + masteryMod.
2. Defender may expend a Speed Die to roll it + defender's masteryMod (or speedDice.modifier).
   If no Speed Die is available → Unopposed (attacker auto-wins; no Morale change).
3. Compare totals. Higher = win. Tie = both take half damage.
4. Win result: attacker deals healthDamage + staggerDamage to defender.
   Damage guidelines: healthDamage ≈ attacker's rolled Power / 4 (rounded down, minimum 1).
   staggerDamage ≈ same as healthDamage (or slightly higher if attacker is relentless).
5. Morale: Clash win → winner +3 Morale, loser −3. Tie or Unopposed → 0.
6. Coin retry: loser may spend a Coin before damage is applied.
   Retry Power = original Power + coinBonus. If retry beats winner's Power, outcome flips.

DIE RESISTANCE (applied to Power after Clash resolution, before calculating damage — round down)
Resistance tiers: Fatal ×${HOSHITO_RESISTANCE_MULTIPLIERS.Fatal} · Weak ×${HOSHITO_RESISTANCE_MULTIPLIERS.Weak} · Normal ×${HOSHITO_RESISTANCE_MULTIPLIERS.Normal} · Endured ×${HOSHITO_RESISTANCE_MULTIPLIERS.Endured} · Ineffective ×${HOSHITO_RESISTANCE_MULTIPLIERS.Ineffective} · Immune ×${HOSHITO_RESISTANCE_MULTIPLIERS.Immune}
Health and Stagger resistances are tracked SEPARATELY per damage type (Slash/Pierce/Blunt/Spectral/Elemental/Empyreal).
Only non-Normal entries are stored in resistances[]. All unspecified types default to Normal ×1.
Example: if a creature has Endured (×0.5) for Slash on Health, a 12-Power Slash attack deals floor(12 × 0.5) = 6 Health damage.

DEFAULT STAT FORMULAS (use Hoshito character stats from context when available; otherwise estimate)
Health max = 25 + (MIG_GradeMod + WIL_GradeMod) × 5
Stagger max = 15 + (VIT_GradeMod + INT_GradeMod) × 5
AP max = 3 + floor(PSY_GradeMod / 3)
Grade mods: F=−1, E=0, D=+1, C=+2, B=+3, A=+4, S=+5, SS=+6, SSS=+7, EX=+9

MERITS (rewards, discoveries, and consequences a character accumulates — context lists them per-character)
• Feat: a trained discipline. Grants 1 Attribute Spark. Two Feats can fuse into one stronger Feat at Level Up.
• Artifact: a significant object. Grants 1 Attribute Spark. Weapons/Shields set the Mastery die size; Trinkets instead grant a flat
  Power modifier by rarity (Common +1 / Uncommon +2 / Rare +3 / Legendary +4).
• Ability: a maneuver or technique — no Spark, a new axis of action rather than a numerical boost. The primary reward of Strand progression.
• Augment: a permanent, usually irreversible modification to the self. Grants Attribute Sparks directly.
• Contact: a person, faction, or relationship. No Spark — purely narrative, but opens and closes doors skill and power cannot.
A Merit marked dormant is acknowledged but not yet narratively active — do not let it affect rolls or fiction until reactivated.

CORE MERITS (every character has exactly three: Ancestry, Heritage, Background)
Each is a written origin (the description field) that grants either one Grade step on a chosen Attribute, or 1 Spark if that Attribute
is already at the Grade D creation cap (see grantedSpark). At Levels 7, 14, 21, 26 — or a narratively pivotal moment — a Core Merit may
transform: add one Ability Merit, one Feat, or one Vestige Spark, thematically linked to that Core Merit's origin description. A Core
Merit's transformations[] list is the running record of these grants; treat its narrative field as canon for what that moment meant.

ENEMY GUIDELINES (when enemies have no defined stats)
• Weak minion: Health 30–50, Stagger 20–35, masteryDie "d6", AP 2, Speed d4–d6
• Standard enemy: Health 50–90, Stagger 35–60, masteryDie "d8", AP 3, Speed d6–d8
• Elite: Health 90–140, Stagger 60–90, masteryDie "d10", AP 4, Speed d8–d10
• Boss: Health 150+, Stagger 100+, masteryDie "d12", AP 5, Speed d10–d12

=== END HOSHITO RULES ===
`.trim();

function buildHoshitoInitPrompt(
  personaName: string,
  personaCtx: string,
  characterCtx: string,
  chatHistory: ChatMessage[],
  gameStateCtx: string,
  spellbookCtx: string,
): ChatMessage[] {
  const msgs: ChatMessage[] = [];

  let system = `You are an expert game master running a Hoshito TTRPG encounter for ${personaName}.\n\n`;
  system += `${HOSHITO_RULES_BLOCK}\n\n`;

  if (characterCtx) {
    system += `Characters:\n<characters>\n${characterCtx}</characters>\n\n`;
  }
  system += `Persona (${personaName}):\n<persona>\n${personaCtx}\n</persona>\n\n`;
  if (gameStateCtx) {
    system += `Game state:\n<context>\n${gameStateCtx}</context>\n\n`;
  }
  if (spellbookCtx) {
    system += `Known abilities / spellbook:\n<spellbook>\n${spellbookCtx}</spellbook>\n\n`;
  }

  system += `Chat history before the encounter:\n<history>\n`;
  msgs.push({ role: "system", content: system });

  for (const m of chatHistory) {
    msgs.push({ role: m.role as "user" | "assistant", content: m.content });
  }

  let inst = `</history>\n\nCombat begins now.\n\n`;
  inst += `Analyze the context. Determine who is in the party, who the enemies are, and what this encounter's stakes are.\n`;
  inst += `Use the Hoshito rules above to populate every combatant's stats accurately.\n`;
  inst += `If ${personaName}'s Hoshito character stats are defined in the persona/context (Grades, derived Health/Stagger/AP), use those EXACT values. Do NOT invent or rebalance defined stats.\n\n`;
  inst += `Return ONLY a valid JSON object matching this TypeScript shape:\n\n`;
  inst += `{\n`;
  inst += `  "round": 1,\n`;
  inst += `  "environment": "Brief combat environment description",\n`;
  inst += `  "party": [\n`;
  inst += `    {\n`;
  inst += `      "name": "${personaName}",\n`;
  inst += `      "health": X, "healthMax": X,\n`;
  inst += `      "stagger": X, "staggerMax": X,\n`;
  inst += `      "ap": X, "apMax": X,\n`;
  inst += `      "coins": 3, "coinBonus": X,\n`;
  inst += `      "morale": 0,\n`;
  inst += `      "masteryDie": "d6"|"d8"|"d10"|"d12",\n`;
  inst += `      "masteryMod": X,\n`;
  inst += `      "speedDice": { "dieType": "d4"|"d6"|"d8"|"d10"|"d12"|"d14"|"d16"|"d18"|"d20", "modifier": X, "initiativeResult": X, "remaining": 1, "total": 1 },\n`;
  inst += `      "powerGuardAvailable": true,\n`;
  inst += `      "isStaggered": false,\n`;
  inst += `      "statusEffects": [],\n`;
  inst += `      "isPlayer": true,\n`;
  inst += `      "sprite": null,\n`;
  inst += `      "agiGrade": "E"|"D"|"C"|"B"|"A"|"S"|"SS"|"SSS"|"EX",\n`;
  inst += `      "magicAlignment": "spectral"|"elemental"|"empyreal" (omit if none),\n`;
  inst += `      "resistances": [] (populate only non-Normal entries if the character has resistances)\n`;
  inst += `    }\n`;
  inst += `  ],\n`;
  inst += `  "enemies": [\n`;
  inst += `    {\n`;
  inst += `      "name": "Enemy Name",\n`;
  inst += `      "health": X, "healthMax": X,\n`;
  inst += `      "stagger": X, "staggerMax": X,\n`;
  inst += `      "ap": X, "apMax": X,\n`;
  inst += `      "coins": 3, "coinBonus": X,\n`;
  inst += `      "morale": 0,\n`;
  inst += `      "masteryDie": "d6"|"d8"|"d10"|"d12",\n`;
  inst += `      "masteryMod": X,\n`;
  inst += `      "speedDice": { "dieType": "d4"|...|"d20", "modifier": 0, "initiativeResult": X, "remaining": 1, "total": 1 },\n`;
  inst += `      "powerGuardAvailable": true,\n`;
  inst += `      "isStaggered": false,\n`;
  inst += `      "statusEffects": [],\n`;
  inst += `      "isPlayer": false,\n`;
  inst += `      "sprite": "emoji or null",\n`;
  inst += `      "resistances": [] (only non-Normal entries)\n`;
  inst += `    }\n`;
  inst += `  ],\n`;
  inst += `  "initiativeQueue": [\n`;
  inst += `    { "name": "combatant name", "initiativeResult": X, "agiGrade": "grade", "isPlayer": true|false, "hasActed": false }\n`;
  inst += `  ]\n`;
  inst += `}\n\n`;
  inst += `Rules:\n`;
  inst += `- initiativeQueue: all combatants ordered by initiativeResult descending. Roll each combatant's Speed Die for their initiativeResult.\n`;
  inst += `- resistances array: empty [] for most combatants. Only include entries for damage types that are NOT Normal. Use: { "type": "Slash"|"Pierce"|"Blunt"|"Spectral"|"Elemental"|"Empyreal", "healthTier": "tier", "staggerTier": "tier" }.\n`;
  inst += `- statusEffects array: empty [] to start unless a condition carries over from the narrative.\n`;
  inst += `- masteryMod for enemies: use a modest positive value (0–4) scaled to their power level.\n`;
  inst += `- Return ONLY the JSON object — no prose, no fences, no keys outside the schema.\n`;
  inst += `- All text (names, descriptions, environment) must match the language of the chat history above.\n`;

  msgs.push({ role: "user", content: inst });
  return msgs;
}

function buildHoshitoActionPrompt(
  personaName: string,
  personaCtx: string,
  action: { type: string; description: string; target?: string; dieRole?: string; spendCoin?: boolean },
  combatState: HoshitoCombatState,
  spellbookCtx: string,
): ChatMessage[] {
  const msgs: ChatMessage[] = [];

  let system = `You are the game master resolving a Hoshito combat action. Do NOT play as ${personaName} — only narrate outcomes and control enemies.\n\n`;
  system += `${HOSHITO_RULES_BLOCK}\n\n`;
  system += `<persona>\n${personaCtx}\n</persona>\n\n`;
  if (spellbookCtx) {
    system += `<spellbook>\n${spellbookCtx}</spellbook>\n\n`;
  }
  msgs.push({ role: "system", content: system });

  // Current state summary
  let state = `=== CURRENT COMBAT STATE (Round ${combatState.round}) ===\n`;
  state += `Environment: ${combatState.environment || "Unknown"}\n\n`;

  state += `PARTY:\n`;
  for (const c of combatState.party) {
    const res = (c.resistances ?? []).map(r => `${r.type}:HP×${r.healthTier}/SGR×${r.staggerTier}`).join(", ");
    state += `• ${c.name}${c.isPlayer ? " [PLAYER]" : ""}: HP ${c.health}/${c.healthMax} · SGR ${c.stagger}/${c.staggerMax} · AP ${c.ap}/${c.apMax} · Coins ${c.coins} · Morale ${c.morale >= 0 ? "+" : ""}${c.morale}\n`;
    state += `  MasteryDie: ${c.masteryDie} · MasteryMod: ${c.masteryMod >= 0 ? "+" : ""}${c.masteryMod} · SpeedDice: ${c.speedDice.dieType} (${c.speedDice.remaining}/${c.speedDice.total} remaining) · PowerGuard: ${c.powerGuardAvailable ? "available" : "spent"} · Staggered: ${c.isStaggered}\n`;
    if (res) state += `  Resistances: ${res}\n`;
    if (c.statusEffects?.length) state += `  Statuses: ${c.statusEffects.map(s => s.name).join(", ")}\n`;
  }

  state += `\nENEMIES:\n`;
  for (const e of combatState.enemies) {
    const res = (e.resistances ?? []).map(r => `${r.type}:HP×${r.healthTier}/SGR×${r.staggerTier}`).join(", ");
    state += `• ${e.name} ${e.sprite ?? ""}: HP ${e.health}/${e.healthMax} · SGR ${e.stagger}/${e.staggerMax} · AP ${e.ap}/${e.apMax} · Coins ${e.coins} · Morale ${e.morale >= 0 ? "+" : ""}${e.morale}\n`;
    state += `  MasteryDie: ${e.masteryDie} · MasteryMod: ${e.masteryMod >= 0 ? "+" : ""}${e.masteryMod} · SpeedDice: ${e.speedDice.dieType} (${e.speedDice.remaining}/${e.speedDice.total} remaining) · Staggered: ${e.isStaggered}\n`;
    if (res) state += `  Resistances: ${res}\n`;
    if (e.statusEffects?.length) state += `  Statuses: ${e.statusEffects.map(s => s.name).join(", ")}\n`;
  }

  state += `\n${personaName}'s Action: [${action.type.toUpperCase()}] ${action.description}`;
  if (action.target) state += ` → Target: ${action.target}`;
  if (action.dieRole) state += ` · Die Role: ${action.dieRole}`;
  if (action.spendCoin) state += ` · Spending a Coin on retry`;
  state += `\n\n`;

  state += `=== INSTRUCTIONS ===\n`;
  state += `1. Resolve the action using Hoshito rules (Clash → resistance → damage → Morale update).\n`;
  state += `2. Have enemies act in turn order (highest initiative not yet acted). Enemies also follow Clash rules.\n`;
  state += `3. Apply all resource changes (Health, Stagger, AP, Coins, Morale, Speed Dice remaining, statusEffects) to updatedState.\n`;
  state += `4. When Health ≤ 0, combatant is eliminated. When Stagger ≤ 0, set isStaggered: true (no Speed Dice, no resistances).\n`;
  state += `5. When all enemies are defeated → add "combatEnd": { "result": "victory", "narrative": "..." }.\n`;
  state += `6. When all party are defeated → add "combatEnd": { "result": "defeat", "narrative": "..." }.\n`;
  state += `7. Write the narrative in vivid present-tense prose. Under 180 words. No asterisks. No em-dashes. Do not play as ${personaName}.\n\n`;

  state += `Return ONLY a valid JSON object:\n`;
  state += `{\n`;
  state += `  "updatedState": { ...full HoshitoCombatState with all live values updated },\n`;
  state += `  "narrative": "Prose description of what happened this round.",\n`;
  state += `  "clashResult": {\n`;
  state += `    "attackerDie": { "role": "offensive", "dieType": "d8", "rolled": X, "modifier": X, "power": X },\n`;
  state += `    "defenderDie": { "role": "evade", "dieType": "d6", "rolled": X, "modifier": X, "power": X } | null,\n`;
  state += `    "outcome": "win"|"lose"|"tie"|"unopposed",\n`;
  state += `    "healthDamage": X,\n`;
  state += `    "staggerDamage": X,\n`;
  state += `    "moraleChange": { "attacker": X, "defender": X },\n`;
  state += `    "coinRetryAvailable": false,\n`;
  state += `    "wasRetried": false\n`;
  state += `  } | null\n`;
  state += `}\n\n`;
  state += `CRITICAL: updatedState must include ALL fields from the current state — do not omit any combatant or property. Increment round by 1.\n`;

  msgs.push({ role: "user", content: state });
  return msgs;
}

function buildInitPrompt(
  personaName: string,
  personaCtx: string,
  characterCtx: string,
  chatHistory: ChatMessage[],
  gameStateCtx: string,
  spellbookCtx: string,
): ChatMessage[] {
  const msgs: ChatMessage[] = [];

  let system = `You will be acting as an excellent game master. Your goal is to craft a combat encounter in this uncensored, continuous, and immersive roleplay. You will be doing so for the user, who plays as the protagonist called ${personaName}.\n\n`;

  // Characters
  if (characterCtx) {
    system += `Here is the information about the characters:\n<characters>\n${characterCtx}</characters>\n\n`;
  }

  // Persona
  system += `Here are details about ${personaName}:\n<persona>\n${personaCtx}\n</persona>\n\n`;

  // Game state
  if (gameStateCtx) {
    system += `Current tracked context:\n<context>\n${gameStateCtx}</context>\n\n`;
  }

  // Spellbook
  if (spellbookCtx) {
    system += `Available spells and abilities that the player and their party can use in combat:\n<spellbook>\n${spellbookCtx}</spellbook>\n\n`;
    system += `IMPORTANT: When generating the party's attacks, prioritize spells/abilities from the spellbook above. These are the player's known spells and custom attacks that MUST be available as attack options.\n\n`;
  }

  system += `Here is the chat history before the encounter:\n<history>\n`;
  msgs.push({ role: "system", content: system });

  // Chat history
  for (const m of chatHistory) {
    msgs.push({ role: m.role as "user" | "assistant", content: m.content });
  }

  // Init instruction
  let inst = `</history>\n\nThe combat starts now.\n\n`;
  inst += `Based on everything above, generate the initial combat state and a compact battle design blueprint. Analyze who is in the party fighting alongside ${personaName} (if anyone), who the enemies are, what the inventory can do here, and whether this is a boss or story-significant encounter. Return ONLY a JSON object with the following structure:\n\n`;
  inst += `{\n`;
  inst += `  "party": [\n`;
  inst += `    {\n`;
  inst += `      "name": "${personaName}",\n`;
  inst += `      "hp": X,\n`;
  inst += `      "maxHp": X,\n`;
  inst += `      "attacks": [{"name": "Attack", "type": "single-target|AoE|both", "description": "what it does", "power": 1.2, "cooldown": 0, "element": "optional", "statusEffect": "optional"}],\n`;
  inst += `      "items": ["Item Name x3"],\n`;
  inst += `      "statuses": [],\n`;
  inst += `      "isPlayer": true\n`;
  inst += `    }\n`;
  inst += `  ],\n`;
  inst += `  "enemies": [\n`;
  inst += `    {\n`;
  inst += `      "name": "Enemy Name",\n`;
  inst += `      "hp": X,\n`;
  inst += `      "maxHp": X,\n`;
  inst += `      "attacks": [{"name": "Attack1", "type": "single-target|AoE|both", "description": "what it does", "power": 1.3, "cooldown": 2, "element": "optional", "statusEffect": "optional"}],\n`;
  inst += `      "statuses": [],\n`;
  inst += `      "description": "Brief enemy description",\n`;
  inst += `      "sprite": "emoji or brief visual description"\n`;
  inst += `    }\n`;
  inst += `  ],\n`;
  inst += `  "environment": "Brief description of the combat environment",\n`;
  inst += `  "styleNotes": {\n`;
  inst += `    "environmentType": "forest|dungeon|desert|cave|city|ruins|snow|water|castle|wasteland|plains|mountains|swamp|volcanic|spaceship|mansion",\n`;
  inst += `    "atmosphere": "bright|dark|foggy|stormy|calm|eerie|chaotic|peaceful",\n`;
  inst += `    "timeOfDay": "dawn|day|dusk|night|twilight",\n`;
  inst += `    "weather": "clear|rainy|snowy|windy|stormy|overcast"\n`;
  inst += `  },\n`;
  inst += `  "itemEffects": [\n`;
  inst += `    {"name":"Inventory item name","target":"self|ally|enemy|any","type":"heal|damage|buff|debuff|status|utility","description":"what this item does in this fight","power":0.3,"element":"optional","status":{"name":"Wet","emoji":"💧","duration":2,"modifier":-2,"stat":"defense"},"consumes":true}\n`;
  inst += `  ],\n`;
  inst += `  "mechanics": [\n`;
  inst += `    {"name":"Boss mechanic name","description":"clear rule and stakes","ownerName":"Boss name","trigger":"round_interval|hp_threshold|on_hit|on_attack|passive","interval":5,"hpThreshold":50,"counterplay":"how the player can respond","effectType":"damage_all|damage_one|buff_self|debuff_party|status_party|status_enemy","power":0.45,"element":"optional","status":{"name":"Stunned","emoji":"⚡","duration":1,"modifier":-3,"stat":"speed"}}\n`;
  inst += `  ],\n`;
  inst += `  "dialogueCues": [\n`;
  inst += `    {"speaker":"Named ally or named enemy","type":"main|side|extra|thought|whisper","expression":"angry","content":"A short battle line.","trigger":"intro|round|attack|hit|charge|phase_75|phase_50|phase_25|low_hp|victory|defeat","round":2,"everyNRounds":5}\n`;
  inst += `  ],\n`;
  inst += `  "visuals": {"isBossFight": false, "enemyImagePrompts": [{"name":"Enemy Name","prompt":"portrait prompt"}], "backgroundPrompt": "optional boss arena background prompt", "illustrationPrompt": "optional boss fight splash illustration prompt", "slug": "optional-short-slug"}\n`;
  inst += `}\n\n`;
  inst += `IMPORTANT NOTES:\n`;
  inst += `- attacks: each has "name" and "type" (single-target, AoE, or both). Add cooldown/status/element only when useful.\n`;
  inst += `- allies: include ${personaName} and any party members or nearby NPCs clearly fighting on ${personaName}'s side. Give allies battle-specific attacks inspired by their cards/context.\n`;
  inst += `- enemies: weak enemies can have one simple attack; bosses and elites should have multiple attacks and one memorable mechanic.\n`;
  inst += `- items: DO NOT invent inventory. itemEffects must only describe how existing inventory items from context work in this encounter. Examples: potion heals, bottle of alcohol can wet/prime a target for fire.\n`;
  inst += `- mechanics: use sparingly. Boss charge attacks should include interval, counterplay, effectType, and a matching dialogueCue with trigger "charge".\n`;
  inst += `- dialogueCues: optional, short, and only for named allies, named enemies, bosses, or important NPCs. Generic unnamed enemies should not get voiced lines.\n`;
  inst += `- visuals: set isBossFight true only for bosses/story-significant enemies. backgroundPrompt/illustrationPrompt are optional and only for important fights.\n`;
  inst += `- statuses: format {"name":"Status","emoji":"💀","duration":X,"modifier":-2,"stat":"attack|defense|speed|hp"}\n`;
  inst += `- HP values: if the persona section above lists a configured Max HP (from stat bars named HP/Health/etc, or from "Max HP" under Persona RPG Stats), use that EXACT number for the player's maxHp, and set hp = maxHp so combat starts at full health. If a character ally has a "Max HP: N" line in its block, do the same for that ally. Do NOT invent or "rebalance" a defined Max HP, and do NOT start any combatant below full HP at combat init. Only invent HP for combatants (enemies, unstatted allies) that have no defined HP in the context.\n`;
  inst += `- RPG attribute scaling: when the context lists Attributes for the player or an ally (STR/DEX/CON/INT/WIS/CHA, on a roughly 8-20 D&D-style scale), let those values shape the generated stats: high STR → stronger physical attack power; high DEX → higher speed and accuracy; high CON → larger HP pool when HP is not already defined; high INT/WIS/CHA → stronger magical/support attack power for casters. Treat 10 as average and scale proportionally. Do NOT override an explicitly configured Max HP using these attributes.\n`;
  inst += `- Use the player's stats/inventory from the context to populate their data. Return ONLY the JSON.\n`;
  inst += `- Write ALL text values (environment, descriptions, attack names, item names, etc.) in the same language the chat history is written in.\n`;

  msgs.push({ role: "user", content: inst });
  return msgs;
}

function buildActionPrompt(
  personaName: string,
  personaCtx: string,
  characterCtx: string,
  chatHistory: ChatMessage[],
  action: string,
  combatStats: { party: CombatPartyMember[]; enemies: CombatEnemy[]; environment: string },
  playerActions: CombatPlayerActions | null,
  encounterLog: EncounterLogEntry[],
  narrative: NarrativeStyle,
  spellbookCtx: string,
): ChatMessage[] {
  const msgs: ChatMessage[] = [];

  let system = `You are the game master managing this combat encounter. You must not play as ${personaName} — only describe what happens as a result of their actions and control NPCs/enemies.\n\n`;
  if (characterCtx) {
    system += `<characters>\n${characterCtx}</characters>\n\n`;
  }
  system += `<persona>\n${personaCtx}\n</persona>\n\n`;
  if (spellbookCtx) {
    system += `Available spells and abilities:\n<spellbook>\n${spellbookCtx}</spellbook>\n\n`;
  }
  msgs.push({ role: "system", content: system });

  // Recent chat history for context (already sliced to historyDepth by caller)
  for (const m of chatHistory) {
    msgs.push({ role: m.role as "user" | "assistant", content: m.content });
  }

  // Previous combat actions
  if (encounterLog.length) {
    let log = "Previous Combat Actions:\n";
    for (const e of encounterLog) {
      log += `- ${e.action}\n`;
      if (e.result) log += `  ${e.result}\n`;
    }
    msgs.push({ role: "user", content: log });
  }

  // Current combat state + action + response format
  let state = `Current Combat State:\n`;
  state += `Environment: ${combatStats.environment || "Unknown location"}\n\n`;
  state += `Party Members:\n`;
  for (const m of combatStats.party) {
    state += `- ${m.name}${m.isPlayer ? " (Player)" : ""}: ${m.hp}/${m.maxHp} HP\n`;
    const attacks = m.isPlayer && playerActions?.attacks ? playerActions.attacks : m.attacks;
    const items = m.isPlayer && playerActions?.items ? playerActions.items : m.items;
    if (attacks?.length) state += `  Attacks: ${attacks.map((a) => (typeof a === "string" ? a : a.name)).join(", ")}\n`;
    if (items?.length) state += `  Items: ${items.join(", ")}\n`;
    if (m.statuses?.length) state += `  Status Effects: ${m.statuses.map((s) => `${s.emoji} ${s.name}`).join(", ")}\n`;
  }
  state += `\nEnemies:\n`;
  for (const e of combatStats.enemies) {
    state += `- ${e.name} (${e.sprite || ""}): ${e.hp}/${e.maxHp} HP\n`;
    if (e.description) state += `  ${e.description}\n`;
    if (e.attacks?.length) state += `  Attacks: ${e.attacks.map((a) => a.name).join(", ")}\n`;
    if (e.statuses?.length) state += `  Status Effects: ${e.statuses.map((s) => `${s.emoji} ${s.name}`).join(", ")}\n`;
  }

  state += `\n${personaName}'s Action: ${action}\n\n`;
  state += `Respond ONLY with a JSON object:\n`;
  state += `{\n`;
  state += `  "combatStats": {\n`;
  state += `    "party": [{"name":"Name","hp":X,"maxHp":X,"statuses":[],"isPlayer":true|false}],\n`;
  state += `    "enemies": [{"name":"Name","hp":X,"maxHp":X,"statuses":[]}]\n`;
  state += `  },\n`;
  state += `  "playerActions": {\n`;
  state += `    "attacks": [{"name":"Attack","type":"single-target|AoE|both"}],\n`;
  state += `    "items": ["Item Name x3"]\n`;
  state += `  },\n`;
  state += `  "enemyActions": [{"enemyName":"Name","action":"what they do","target":"target"}],\n`;
  state += `  "partyActions": [{"memberName":"Name","action":"what they do","target":"target"}],\n`;
  state += `  "narrative": "The roleplay description of what happens"\n`;
  state += `}\n\n`;
  state += `If all enemies defeated: add "combatEnd": true, "result": "victory".\n`;
  state += `If all party defeated: add "combatEnd": true, "result": "defeat".\n`;
  state += `If interrupted: add "combatEnd": true, "result": "interrupted".\n\n`;
  state += `Update items/attacks if consumed. Status durations decrease each turn (remove at 0).\n`;
  state += `Scale difficulty: powerful foes take multiple rounds, weak foes fall quickly.\n`;
  state += `Write the narrative in ${narrative.tense} tense ${narrative.person}-person ${narrative.narration} from ${narrative.pov}'s point of view.\n`;
  state += `Build novel prose, vary structures, avoid GPTisms and purple prose. No asterisks or em-dashes. Under 150 words. Do not play for ${personaName}.\n`;
  state += `Write in the same language the chat history is written in.\n`;

  msgs.push({ role: "user", content: state });
  return msgs;
}

function buildSummaryPrompt(
  personaName: string,
  personaCtx: string,
  characterCtx: string,
  encounterLog: EncounterLogEntry[],
  result: string,
  narrative: NarrativeStyle,
): ChatMessage[] {
  const msgs: ChatMessage[] = [];

  let system = `You are summarizing a combat encounter that just concluded.\n\n`;
  if (characterCtx) {
    system += `<characters>\n${characterCtx}</characters>\n\n`;
  }
  system += `<persona>\n${personaCtx}\n</persona>\n\n`;
  msgs.push({ role: "system", content: system });

  let user = `Combat has ended with result: ${result}\n\nFull Combat Log:\n`;
  encounterLog.forEach((entry, i) => {
    user += `\nRound ${i + 1}:\n${entry.action}\n${entry.result}\n`;
  });
  user += `\n\nProvide a narrative summary of the entire fight.\n`;
  user += `Write in ${narrative.tense} tense ${narrative.person}-person ${narrative.narration} from ${narrative.pov}'s point of view.\n`;
  user += `Build novel prose, vary structures, avoid GPTisms and purple prose. Include dialogue from enemies/NPCs in direct quotes. Express ${personaName}'s actions using only indirect speech.\n`;
  user += `No asterisks, ellipses, or em-dashes. Explicit content allowed. Finish naturally.\n`;
  user += `Write in the same language the combat log is written in.\n`;

  msgs.push({ role: "user", content: user });
  return msgs;
}

// ──────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────

export async function encounterRoutes(app: FastifyInstance) {
  const chats = createChatsStorage(app.db);
  const connections = createConnectionsStorage(app.db);
  const chars = createCharactersStorage(app.db);
  const gsStorage = createGameStateStorage(app.db);
  const lbStorage = createLorebooksStorage(app.db);

  /** Load spellbook entries and format them as context text. */
  async function loadSpellbookContext(spellbookId: string | null | undefined): Promise<string> {
    if (!spellbookId) return "";
    const entries = await lbStorage.listEntriesByLorebooks([spellbookId]);
    if (!entries.length) return "";
    let ctx = "";
    for (const entry of entries) {
      if (!entry.enabled) continue;
      const e = entry as Record<string, unknown>;
      ctx += `<spell name="${e.name}">\n${e.content}\n</spell>\n`;
    }
    return ctx;
  }

  // ───────────────────────── INIT ─────────────────────────
  app.post<{ Body: EncounterInitRequest }>("/init", async (req, reply) => {
    const { chatId, connectionId, settings, spellbookId, debugMode } = req.body;
    const debugLog = (message: string, ...args: unknown[]) => {
      logDebugOverride(debugMode === true, message, ...args);
    };

    if (!chatId || !settings) {
      return reply.status(400).send({ error: "Missing required fields: chatId, settings" });
    }

    try {
      const chat = await chats.getById(chatId);
      if (!chat) return reply.status(404).send({ error: "Chat not found" });

      const { conn, baseUrl } = await resolveConnection(connections, connectionId, chat.connectionId);
      const provider = createLLMProvider(
        conn.provider,
        baseUrl,
        conn.apiKey,
        conn.maxContext,
        conn.openrouterProvider,
        conn.maxTokensOverride,
      );

      const characterIds: string[] = JSON.parse(chat.characterIds as string);
      const characterCtx = await buildCharacterContext(chars, characterIds);
      const { personaName, personaCtx } = await buildPersonaContext(chars, chat.personaId ?? null);
      let chatMeta: Record<string, unknown> | null = null;
      if (typeof chat.metadata === "string") {
        try {
          chatMeta = JSON.parse(chat.metadata) as Record<string, unknown>;
        } catch {
          chatMeta = null;
        }
      } else {
        chatMeta = (chat.metadata as Record<string, unknown> | null) ?? null;
      }
      const gameStateCtx = await buildGameStateContext(gsStorage, chatId, personaName, chatMeta);
      const spellbookCtx = await loadSpellbookContext(spellbookId);

      // Get recent chat messages for history
      const chatMessages = await chats.listMessages(chatId);
      const depth = settings.historyDepth || 8;
      const recentMsgs: ChatMessage[] = chatMessages.slice(-depth).map((m: any) => ({
        role: (m.role === "narrator" ? "system" : m.role) as "user" | "assistant" | "system",
        content: m.content as string,
      }));

      const prompt = buildInitPrompt(personaName, personaCtx, characterCtx, recentMsgs, gameStateCtx, spellbookCtx);
      debugLog(
        "[debug/game/combat:init] request chatId=%s model=%s historyMessages=%d settings=%s",
        chatId,
        conn.model ?? "",
        recentMsgs.length,
        JSON.stringify(settings),
      );
      debugLog("[debug/game/combat:init] prompt messages:\n%s", JSON.stringify(prompt, null, 2));

      const result = await provider.chatComplete(prompt, {
        model: conn.model,
        temperature: 0.8,
        maxTokens: COMBAT_BLUEPRINT_OUTPUT_TOKENS,
      });
      debugLog(
        "[debug/game/combat:init] raw response chatId=%s model=%s chars=%d\n%s",
        chatId,
        conn.model ?? "",
        result.content?.length ?? 0,
        result.content ?? "",
      );

      if (!result.content) {
        return reply.status(502).send({ error: "No response from AI" });
      }

      let combatState: Record<string, unknown>;
      try {
        combatState = parseJSON(result.content) as Record<string, unknown>;
      } catch {
        return reply.status(502).send({ error: "AI returned invalid JSON" });
      }

      if (!combatState?.party || !combatState?.enemies) {
        return reply.status(502).send({ error: "Invalid combat data returned by AI" });
      }
      debugLog("[debug/game/combat:init] parsed response:\n%s", JSON.stringify(combatState, null, 2));

      await chats.patchMetadata(chatId, { encounterActive: true }, { touchUpdatedAt: false });

      return { combatState };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.warn(err, "[game/combat:init] Encounter init failed");
      return reply.status(500).send({ error: `Encounter init failed: ${message}` });
    }
  });

  // ───────────────────────── ACTION ─────────────────────────
  app.post<{ Body: EncounterActionRequest }>("/action", async (req, reply) => {
    const { chatId, connectionId, action, combatStats, playerActions, encounterLog, settings, spellbookId } = req.body;

    if (!chatId || !action || !combatStats || !settings) {
      return reply.status(400).send({ error: "Missing required fields: chatId, action, combatStats, settings" });
    }

    try {
      const chat = await chats.getById(chatId);
      if (!chat) return reply.status(404).send({ error: "Chat not found" });

      const { conn, baseUrl } = await resolveConnection(connections, connectionId, chat.connectionId);
      const provider = createLLMProvider(
        conn.provider,
        baseUrl,
        conn.apiKey,
        conn.maxContext,
        conn.openrouterProvider,
        conn.maxTokensOverride,
      );

      const characterIds: string[] = JSON.parse(chat.characterIds as string);
      const characterCtx = await buildCharacterContext(chars, characterIds);
      const { personaName, personaCtx } = await buildPersonaContext(chars, chat.personaId ?? null);
      const spellbookCtx = await loadSpellbookContext(spellbookId);

      const chatMessages = await chats.listMessages(chatId);
      const depth = settings.historyDepth || 8;
      const recentMsgs: ChatMessage[] = chatMessages.slice(-depth).map((m: any) => ({
        role: (m.role === "narrator" ? "system" : m.role) as "user" | "assistant" | "system",
        content: m.content as string,
      }));

      const prompt = buildActionPrompt(
        personaName,
        personaCtx,
        characterCtx,
        recentMsgs,
        action,
        combatStats,
        playerActions,
        encounterLog ?? [],
        settings.combatNarrative,
        spellbookCtx,
      );

      const result = await provider.chatComplete(prompt, {
        model: conn.model,
        temperature: 0.8,
        maxTokens: 8192,
      });

      if (!result.content) {
        return { result: fallbackActionResult(req.body), invalid: true };
      }

      let actionResult: Record<string, unknown>;
      try {
        actionResult = parseJSON(result.content) as Record<string, unknown>;
      } catch {
        return { result: fallbackActionResult(req.body), invalid: true };
      }

      if (!actionResult?.combatStats) {
        return { result: fallbackActionResult(req.body), invalid: true };
      }

      // Validate that party/enemies are actual arrays — AI may return null, a string, or omit them
      const cs = actionResult.combatStats as Record<string, unknown>;
      if (!Array.isArray(cs.party)) cs.party = combatStats.party;
      if (!Array.isArray(cs.enemies)) cs.enemies = combatStats.enemies;

      // Sanitize playerActions — AI may return attacks/items as strings or omit them
      if (actionResult.playerActions && typeof actionResult.playerActions === "object") {
        const pa = actionResult.playerActions as Record<string, unknown>;
        if (!Array.isArray(pa.attacks)) pa.attacks = playerActions?.attacks ?? [];
        if (!Array.isArray(pa.items)) pa.items = playerActions?.items ?? [];
      }

      // Ensure enemyActions / partyActions are arrays
      if (!Array.isArray(actionResult.enemyActions)) actionResult.enemyActions = [];
      if (!Array.isArray(actionResult.partyActions)) actionResult.partyActions = [];

      // Ensure narrative is a string
      if (typeof actionResult.narrative !== "string") actionResult.narrative = "";

      return { result: actionResult };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return reply.status(500).send({ error: `Encounter action failed: ${message}` });
    }
  });

  // ───────────────────────── SUMMARY ─────────────────────────
  app.post<{ Body: EncounterSummaryRequest }>("/summary", async (req, reply) => {
    const { chatId, connectionId, encounterLog, result: combatResult, settings } = req.body;

    const validResults = ["victory", "defeat", "fled", "interrupted"];
    if (!chatId || !encounterLog?.length || !combatResult || !settings) {
      return reply.status(400).send({ error: "Missing required fields: chatId, encounterLog, result, settings" });
    }
    if (!validResults.includes(combatResult)) {
      return reply.status(400).send({ error: `Invalid result. Must be one of: ${validResults.join(", ")}` });
    }

    try {
      const chat = await chats.getById(chatId);
      if (!chat) return reply.status(404).send({ error: "Chat not found" });

      const { conn, baseUrl } = await resolveConnection(connections, connectionId, chat.connectionId);
      const provider = createLLMProvider(
        conn.provider,
        baseUrl,
        conn.apiKey,
        conn.maxContext,
        conn.openrouterProvider,
        conn.maxTokensOverride,
      );

      const characterIds: string[] = JSON.parse(chat.characterIds as string);
      const characterCtx = await buildCharacterContext(chars, characterIds);
      const { personaName, personaCtx } = await buildPersonaContext(chars, chat.personaId ?? null);

      const prompt = buildSummaryPrompt(
        personaName,
        personaCtx,
        characterCtx,
        encounterLog,
        combatResult,
        settings.summaryNarrative,
      );

      const result = await provider.chatComplete(prompt, {
        model: conn.model,
        temperature: 0.9,
        maxTokens: 8192,
      });

      if (!result.content) {
        return reply.status(502).send({ error: "No response from AI for summary" });
      }

      const summary = result.content.replace(/\[FIGHT CONCLUDED\]\s*/i, "").trim();

      // Save the summary as a narrator message (not attributed to a specific character)
      const msg = await chats.createMessage({
        chatId,
        role: "assistant",
        characterId: null,
        content: summary,
      });

      await chats.patchMetadata(chatId, { encounterActive: false }, { touchUpdatedAt: false });

      return { summary, messageId: msg?.id ?? "" };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return reply.status(500).send({ error: `Encounter summary failed: ${message}` });
    }
  });

  // ───────────────────── HOSHITO INIT ───────────────────────

  app.post<{ Body: HoshitoEncounterInitRequest }>("/hoshito/init", async (req, reply) => {
    const { chatId, connectionId, spellbookId, debugMode } = req.body;
    const debugLog = (message: string, ...args: unknown[]) => {
      logDebugOverride(debugMode === true, message, ...args);
    };

    if (!chatId) {
      return reply.status(400).send({ error: "Missing required field: chatId" });
    }

    try {
      const chat = await chats.getById(chatId);
      if (!chat) return reply.status(404).send({ error: "Chat not found" });

      const { conn, baseUrl } = await resolveConnection(connections, connectionId, chat.connectionId);
      const provider = createLLMProvider(
        conn.provider, baseUrl, conn.apiKey,
        conn.maxContext, conn.openrouterProvider, conn.maxTokensOverride,
      );

      const characterIds: string[] = JSON.parse(chat.characterIds as string);
      const characterCtx = await buildCharacterContext(chars, characterIds);
      const { personaName, personaCtx } = await buildPersonaContext(chars, chat.personaId ?? null);
      let chatMeta: Record<string, unknown> | null = null;
      if (typeof chat.metadata === "string") {
        try { chatMeta = JSON.parse(chat.metadata) as Record<string, unknown>; }
        catch { chatMeta = null; }
      } else {
        chatMeta = (chat.metadata as Record<string, unknown> | null) ?? null;
      }
      const gameStateCtx = await buildGameStateContext(gsStorage, chatId, personaName, chatMeta);
      const spellbookCtx = await loadSpellbookContext(spellbookId ?? null);

      const chatMessages = await chats.listMessages(chatId);
      const recentMsgs: ChatMessage[] = chatMessages.slice(-10).map((m: any) => ({
        role: (m.role === "narrator" ? "system" : m.role) as "user" | "assistant" | "system",
        content: m.content as string,
      }));

      const prompt = buildHoshitoInitPrompt(personaName, personaCtx, characterCtx, recentMsgs, gameStateCtx, spellbookCtx);
      debugLog("[debug/hoshito:init] prompt:\n%s", JSON.stringify(prompt, null, 2));

      const result = await provider.chatComplete(prompt, {
        model: conn.model,
        temperature: 0.8,
        maxTokens: COMBAT_BLUEPRINT_OUTPUT_TOKENS,
      });
      debugLog("[debug/hoshito:init] raw:\n%s", result.content ?? "");

      if (!result.content) return reply.status(502).send({ error: "No response from AI" });

      let combatState: HoshitoCombatState;
      try {
        combatState = parseJSON(result.content) as HoshitoCombatState;
      } catch {
        return reply.status(502).send({ error: "AI returned invalid JSON" });
      }

      if (!combatState?.party?.length || !combatState?.enemies?.length) {
        return reply.status(502).send({ error: "Invalid Hoshito combat state returned by AI" });
      }

      await chats.patchMetadata(chatId, { encounterActive: true }, { touchUpdatedAt: false });
      return { combatState };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.warn(err, "[hoshito:init] failed");
      return reply.status(500).send({ error: `Hoshito init failed: ${message}` });
    }
  });

  // ───────────────────── HOSHITO ACTION ─────────────────────

  app.post<{ Body: HoshitoEncounterActionRequest }>("/hoshito/action", async (req, reply) => {
    const { chatId, connectionId, action, combatState, spellbookId } = req.body;

    if (!chatId || !action || !combatState) {
      return reply.status(400).send({ error: "Missing required fields: chatId, action, combatState" });
    }

    try {
      const chat = await chats.getById(chatId);
      if (!chat) return reply.status(404).send({ error: "Chat not found" });

      const { conn, baseUrl } = await resolveConnection(connections, connectionId, chat.connectionId);
      const provider = createLLMProvider(
        conn.provider, baseUrl, conn.apiKey,
        conn.maxContext, conn.openrouterProvider, conn.maxTokensOverride,
      );

      const { personaName, personaCtx } = await buildPersonaContext(chars, chat.personaId ?? null);
      const spellbookCtx = await loadSpellbookContext(spellbookId ?? null);

      const prompt = buildHoshitoActionPrompt(personaName, personaCtx, action, combatState, spellbookCtx);

      const result = await provider.chatComplete(prompt, {
        model: conn.model,
        temperature: 0.85,
        maxTokens: 4096,
      });

      if (!result.content) return reply.status(502).send({ error: "No response from AI" });

      let response: HoshitoEncounterActionResponse;
      try {
        response = parseJSON(result.content) as HoshitoEncounterActionResponse;
      } catch {
        return reply.status(502).send({ error: "AI returned invalid JSON" });
      }

      if (!response?.updatedState || !response?.narrative) {
        return reply.status(502).send({ error: "Invalid action response from AI" });
      }

      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.warn(err, "[hoshito:action] failed");
      return reply.status(500).send({ error: `Hoshito action failed: ${message}` });
    }
  });
}
