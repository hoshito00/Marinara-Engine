// ──────────────────────────────────────────────
// Hoshito Merit Generation — AI-assisted Merit suggestions for the
// Character Editor's "Generate with AI" button.
//
// Chat-independent: takes character fields directly from the request body
// rather than reading a persisted chat/character row, since Character
// Editor edits templates that may not be attached to any chat.
// ──────────────────────────────────────────────
import { LOCAL_SIDECAR_CONNECTION_ID } from "@marinara-engine/shared";
import type { HoshitoDomain, HoshitoMerit } from "@marinara-engine/shared";
import type { createConnectionsStorage } from "../storage/connections.storage.js";
import type { BaseLLMProvider, ChatMessage } from "../llm/base-provider.js";
import { getLocalSidecarProvider, LOCAL_SIDECAR_MODEL } from "../llm/local-sidecar.js";
import { createLLMProvider } from "../llm/provider-registry.js";
import { resolveBaseUrl } from "../../routes/generate/generate-route-utils.js";
import { HOSHITO_MERIT_RULES_BLOCK } from "../../routes/encounter.routes.js";

type ConnectionsStorage = ReturnType<typeof createConnectionsStorage>;

export type ResolvedMeritGenerationConnection =
  | { ok: true; provider: BaseLLMProvider; model: string; connectionId: string }
  | { ok: false; error: string };

/**
 * Resolve a text-generation connection for Merit generation. This isn't
 * chat-scoped, so unlike resolveChatSummaryConnection there's no
 * chat.connectionId / summaryConnectionId to fall back through — only the
 * agent-default connection. Mirrors that resolver's LOCAL_SIDECAR
 * special-case and createLLMProvider(...) construction.
 */
export async function resolveMeritGenerationConnection(
  connections: ConnectionsStorage,
): Promise<ResolvedMeritGenerationConnection> {
  const defaultAgentConnection = await connections.getDefaultForAgents();
  if (!defaultAgentConnection) {
    return { ok: false, error: "No default agent connection configured. Set one in Settings → Connections." };
  }

  if (defaultAgentConnection.id === LOCAL_SIDECAR_CONNECTION_ID) {
    return {
      ok: true,
      provider: getLocalSidecarProvider(),
      model: LOCAL_SIDECAR_MODEL,
      connectionId: LOCAL_SIDECAR_CONNECTION_ID,
    };
  }

  const baseUrl = resolveBaseUrl(defaultAgentConnection);
  if (!baseUrl) {
    return { ok: false, error: `Connection ${defaultAgentConnection.id} has no base URL configured.` };
  }

  return {
    ok: true,
    provider: createLLMProvider(
      defaultAgentConnection.provider,
      baseUrl,
      defaultAgentConnection.apiKey,
      defaultAgentConnection.maxContext,
      defaultAgentConnection.openrouterProvider,
      defaultAgentConnection.maxTokensOverride,
    ),
    model: defaultAgentConnection.model,
    connectionId: defaultAgentConnection.id,
  };
}

export interface MeritGenerationInput {
  characterName: string;
  description: string;
  personality: string;
  scenario: string;
  backstory: string;
  /** Existing Hoshito Domains/Attributes, so sparkGrantAttribute suggestions name real attributes. */
  domains: HoshitoDomain[];
  /** Merits the character already has, so the model doesn't repeat them. */
  existingMerits: HoshitoMerit[];
}

export function collectAttributeNames(domains: HoshitoDomain[]): string[] {
  return Array.from(new Set(domains.flatMap((d) => d.attributes.map((a) => a.name)).filter(Boolean)));
}

export function buildMeritGenerationPrompt(input: MeritGenerationInput): ChatMessage[] {
  const attributeNames = collectAttributeNames(input.domains);

  const system = `You are a game design assistant generating Hoshito TTRPG Merits for a character sheet.

${HOSHITO_MERIT_RULES_BLOCK}

Respond with ONLY a JSON array — the top-level response must start with "[" and end with "]". No prose, no markdown fences, no wrapping object like {"merits": [...]}. Just the bare array, containing 3-5 Merit objects shaped exactly as:
{ "category": "feat" | "artifact" | "ability" | "augment" | "contact", "name": string, "description": string, "sparkGrantAttribute"?: string }

Example of the exact response shape (values are illustrative only, do not reuse them):
[
  { "category": "feat", "name": "Blade-Marked Reflexes", "description": "Years of duel training sharpened her reactions to a hair-trigger.", "sparkGrantAttribute": "AGI" },
  { "category": "contact", "name": "Old Instructor", "description": "Retired swordmaster who still answers her letters." }
]

Rules:
- Ground every Merit in the character's description, personality, scenario, and backstory below — don't invent unrelated content.
- "sparkGrantAttribute" is only valid for feat/artifact/augment categories, and must exactly match one of this character's existing Attribute names: ${
    attributeNames.length > 0 ? attributeNames.join(", ") : "(none defined — omit sparkGrantAttribute)"
  }.
- Do not include "sparkGrantAttribute" for "ability" or "contact" categories.
- Do not duplicate any Merit the character already has.
- Vary the categories — don't generate five of the same type unless the character concept clearly calls for it.`;

  const existingMeritsSummary =
    input.existingMerits.length > 0
      ? input.existingMerits.map((m) => `- [${m.category}] ${m.name}: ${m.description}`).join("\n")
      : "(none yet)";

  const user = `Character: ${input.characterName || "(unnamed)"}

Description: ${input.description || "(none provided)"}

Personality: ${input.personality || "(none provided)"}

Scenario: ${input.scenario || "(none provided)"}

Backstory: ${input.backstory || "(none provided)"}

Existing Merits (do not duplicate):
${existingMeritsSummary}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

const VALID_MERIT_CATEGORIES = new Set(["feat", "artifact", "ability", "augment", "contact"]);
const SPARK_ELIGIBLE_CATEGORIES = new Set(["feat", "artifact", "augment"]);
const MAX_GENERATED_MERITS = 8;

/**
 * Parse the model's JSON-array response into validated HoshitoMerit objects.
 * Silently drops malformed entries rather than failing the whole batch —
 * a partial, valid set of Merits is more useful than an error.
 */
export function parseMeritGenerationResponse(raw: string, validAttributeNames: string[]): HoshitoMerit[] {
  const cleaned = raw
    .trim()
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "");

  const candidateArray = extractMeritArray(cleaned);
  if (!candidateArray) return [];

  const validAttrLookup = new Set(validAttributeNames.map((name) => name.toUpperCase()));
  const merits: HoshitoMerit[] = [];

  for (const entry of candidateArray) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const category = typeof e.category === "string" ? e.category.toLowerCase().trim() : "";
    const name = typeof e.name === "string" ? e.name.trim() : "";
    const description = typeof e.description === "string" ? e.description.trim() : "";
    if (!VALID_MERIT_CATEGORIES.has(category) || !name || !description) continue;

    const merit: HoshitoMerit = { category: category as HoshitoMerit["category"], name, description };

    if (SPARK_ELIGIBLE_CATEGORIES.has(category) && typeof e.sparkGrantAttribute === "string") {
      const candidate = e.sparkGrantAttribute.trim();
      if (candidate && (validAttrLookup.size === 0 || validAttrLookup.has(candidate.toUpperCase()))) {
        merit.sparkGrantAttribute = candidate;
      }
    }

    merits.push(merit);
    if (merits.length >= MAX_GENERATED_MERITS) break;
  }

  return merits;
}

/**
 * Models don't reliably return a bare JSON array even when told to — many wrap it
 * as { "merits": [...] }, or return a single Merit object instead of an array of
 * one. Try, in order: a bare array; an object with a merits/items/result array
 * field; a single object that looks like one Merit (wrapped as a 1-element array).
 */
function extractMeritArray(cleaned: string): unknown[] | null {
  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    try {
      const parsed = JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to object-shaped attempts below
    }
  }

  const objStart = cleaned.indexOf("{");
  const objEnd = cleaned.lastIndexOf("}");
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    try {
      const parsedObj = JSON.parse(cleaned.slice(objStart, objEnd + 1));
      if (parsedObj && typeof parsedObj === "object") {
        for (const key of ["merits", "items", "result", "data"]) {
          const value = (parsedObj as Record<string, unknown>)[key];
          if (Array.isArray(value)) return value;
        }
        // Looks like a single Merit returned bare, not in an array.
        if (typeof (parsedObj as Record<string, unknown>).category === "string") {
          return [parsedObj];
        }
      }
    } catch {
      // give up below
    }
  }

  // Last resort: the response was likely truncated mid-array (finishReason=length)
  // and neither whole-array nor whole-object parsing succeeded. Salvage whatever
  // complete top-level {...} objects appear before the cutoff, in order, rather
  // than discarding a partially-good batch.
  if (arrayStart !== -1) {
    const salvaged = salvageBalancedObjects(cleaned.slice(arrayStart));
    if (salvaged.length > 0) return salvaged;
  }

  return null;
}

/** Scan for balanced top-level {...} objects and parse each independently, skipping any that fail (e.g. a trailing truncated object). */
function salvageBalancedObjects(text: string): unknown[] {
  const results: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          results.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // skip malformed/truncated object, keep scanning
        }
        start = -1;
      }
    }
  }

  return results;
}
