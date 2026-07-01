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

Respond with ONLY a JSON array (no prose, no markdown fences) of 3-5 Merit objects, each shaped exactly as:
{ "category": "feat" | "artifact" | "ability" | "augment" | "contact", "name": string, "description": string, "sparkGrantAttribute"?: string }

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
  const first = cleaned.indexOf("[");
  const last = cleaned.lastIndexOf("]");
  if (first === -1 || last === -1 || last < first) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(first, last + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const validAttrLookup = new Set(validAttributeNames.map((name) => name.toUpperCase()));
  const merits: HoshitoMerit[] = [];

  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const category = typeof e.category === "string" ? e.category : "";
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
