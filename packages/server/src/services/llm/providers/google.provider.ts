// ──────────────────────────────────────────────
// LLM Provider — Google Gemini
// ──────────────────────────────────────────────
import { createHash, createSign } from "crypto";
import {
  BaseLLMProvider,
  llmFetch,
  sanitizeApiError,
  type ChatMessage,
  type ChatOptions,
  type LLMUsage,
} from "../base-provider.js";
import { decodePossiblyCompressedBody } from "../../../utils/security.js";

/** A single Gemini response part (text, thought summary, or signature-only). */
interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
}

type GoogleProviderKind = "google" | "google_vertex";

interface GoogleServiceAccountKey {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
}

const GOOGLE_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const serviceAccountTokenCache = new Map<string, { accessToken: string; expiresAtMs: number }>();
const LINKAPI_CONSOLE_HOSTS = new Set(["linkapi.ai", "www.linkapi.ai", "home.linkapi.ai"]);

function normalizeGoogleBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    if (LINKAPI_CONSOLE_HOSTS.has(url.hostname.toLowerCase())) {
      url.hostname = "api.linkapi.ai";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function parseServiceAccountKey(value: string): GoogleServiceAccountKey | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as GoogleServiceAccountKey;
    return parsed?.client_email && parsed?.private_key ? parsed : null;
  } catch {
    return null;
  }
}

function looksLikeBearerToken(value: string): boolean {
  return value.startsWith("ya29.") || /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

async function fetchServiceAccountAccessToken(serviceAccount: GoogleServiceAccountKey): Promise<string> {
  const clientEmail = serviceAccount.client_email!;
  const privateKey = serviceAccount.private_key!.replace(/\\n/g, "\n");
  const tokenUri = serviceAccount.token_uri || "https://oauth2.googleapis.com/token";
  const cacheKey = createHash("sha256").update(`${clientEmail}:${privateKey}:${tokenUri}`).digest("hex");
  const cached = serviceAccountTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - Date.now() > 60_000) return cached.accessToken;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const claimSet = base64UrlJson({
    iss: clientEmail,
    scope: GOOGLE_CLOUD_PLATFORM_SCOPE,
    aud: tokenUri,
    exp: nowSeconds + 3600,
    iat: nowSeconds,
  });
  const unsignedJwt = `${header}.${claimSet}`;
  const signature = createSign("RSA-SHA256").update(unsignedJwt).sign(privateKey, "base64url");
  const assertion = `${unsignedJwt}.${signature}`;

  const response = await llmFetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    bufferResponse: true,
  });

  if (!response.ok) {
    throw new Error(
      `Google service account auth failed ${response.status}: ${sanitizeApiError(await response.text())}`,
    );
  }

  const json = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error("Google service account auth failed: missing access_token");
  }

  const expiresInMs = Math.max(60, json.expires_in ?? 3600) * 1000;
  serviceAccountTokenCache.set(cacheKey, {
    accessToken: json.access_token,
    expiresAtMs: Date.now() + expiresInMs,
  });
  return json.access_token;
}

export async function googleAuthHeadersForVertex(apiKey: string): Promise<Record<string, string>> {
  const credential = apiKey.trim();
  if (!credential) return {};

  const serviceAccount = parseServiceAccountKey(credential);
  if (serviceAccount) {
    return { Authorization: `Bearer ${await fetchServiceAccountAccessToken(serviceAccount)}` };
  }

  if (looksLikeBearerToken(credential)) {
    return { Authorization: `Bearer ${credential}` };
  }

  return { "x-goog-api-key": credential };
}

export function buildGoogleVertexModelUrl(
  baseUrl: string,
  model: string,
  endpoint: "generateContent" | "streamGenerateContent" | "models",
): string {
  const base = baseUrl
    .replace(/\/+$/, "")
    .replace(/\/publishers\/google\/models(?:\/[^/:]+(?::(?:generateContent|streamGenerateContent))?)?$/i, "");
  if (endpoint === "models") {
    return `${base}/publishers/google/models`;
  }
  return `${base}/publishers/google/models/${model}:${endpoint}`;
}

/**
 * Handles Google Gemini API (generateContent / streamGenerateContent).
 */
export class GoogleProvider extends BaseLLMProvider {
  constructor(
    baseUrl: string,
    apiKey: string,
    defaultMaxContext?: number,
    defaultOpenrouterProvider?: string | null,
    maxTokensOverride?: number | null,
    private readonly providerKind: GoogleProviderKind = "google",
  ) {
    super(baseUrl, apiKey, defaultMaxContext, defaultOpenrouterProvider, maxTokensOverride);
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<string, LLMUsage | void, unknown> {
    const configuredMaxTokens = options.maxTokens ?? 4096;
    const contextFit = this.fitMessagesToContext(messages, { ...options, maxTokens: configuredMaxTokens });
    messages = contextFit.messages;
    this.logContextTrim(contextFit, options.model || "gemini-2.0-flash");
    const maxTokens = contextFit.maxTokens ?? configuredMaxTokens;

    const model = options.model || "gemini-2.0-flash";

    // Gemini 3.x models use thinkingLevel; Gemini 2.5 uses thinkingBudget
    const isGemini3 = /gemini-3/i.test(model);

    // Only models that actually support thinking should get thinkingConfig:
    // Gemini 3.x, 2.5-flash/pro, and 2.0-flash-thinking.
    const supportsThinking = isGemini3 || /gemini-2\.5|gemini-2\.0-flash-thinking/i.test(model);

    let thinkingConfig: Record<string, unknown> | undefined;
    if (supportsThinking && (options.enableThinking || options.reasoningEffort)) {
      if (isGemini3) {
        const levelMap = { low: "low", medium: "medium", high: "high", xhigh: "high" } as const;
        thinkingConfig = {
          thinkingLevel: options.reasoningEffort ? levelMap[options.reasoningEffort] : "high",
          includeThoughts: true,
        };
      } else {
        const budgetMap = { low: 1024, medium: 8192, high: 24576, xhigh: 24576 } as const;
        thinkingConfig = {
          thinkingBudget: options.reasoningEffort ? budgetMap[options.reasoningEffort] : 8192,
          includeThoughts: true,
        };
      }
    }

    // Ensure the base URL includes the /v1beta path segment required by the Gemini API.
    // Proxies like api.linkapi.ai need this appended (SillyTavern does it automatically).
    let base = normalizeGoogleBaseUrl(this.baseUrl);
    if (this.providerKind === "google" && !/\/v\d/.test(base)) base += "/v1beta";

    // When thinking is enabled, force non-streaming (generateContent) because
    // proxies like linkapi.ai strip thought parts from SSE streams but return
    // them in non-streaming responses. Text is still yielded so SSE works.
    const useStreaming = options.stream && !thinkingConfig;
    const endpoint = useStreaming ? "streamGenerateContent" : "generateContent";
    const url =
      this.providerKind === "google_vertex"
        ? `${buildGoogleVertexModelUrl(base, model, endpoint)}${useStreaming ? "?alt=sse" : ""}`
        : `${base}/models/${model}:${endpoint}${useStreaming ? "?alt=sse" : ""}`;

    // Convert to Gemini format — filter out empty-content messages
    const systemMessages = messages.filter((m) => m.role === "system" && m.content?.trim());
    const chatMessages = messages.filter((m) => m.role !== "system" && m.content?.trim());

    const contents = chatMessages.map((m) => {
      // If this model message has stored Gemini parts (with thought signatures),
      // use them directly to preserve reasoning state across turns.
      if (m.role === "assistant" && m.providerMetadata?.geminiParts) {
        const storedParts = m.providerMetadata.geminiParts as GeminiPart[];
        return { role: "model" as const, parts: storedParts };
      }

      const parts: Array<Record<string, unknown>> = [];
      if (m.images?.length) {
        for (const img of m.images) {
          const match = img.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
          }
        }
      }
      parts.push({ text: m.content });
      return {
        role: m.role === "assistant" ? ("model" as const) : ("user" as const),
        parts,
      };
    });

    // Gemini requires at least one entry in contents — if all non-system messages
    // were empty (e.g. preset with only comments), fall back to a minimal user turn
    if (contents.length === 0) {
      contents.push({ role: "user", parts: [{ text: "Continue." }] });
    }

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? 1,
        maxOutputTokens: maxTokens,
        topP: options.topP ?? 1,
        ...(options.topK ? { topK: options.topK } : {}),
        ...(options.frequencyPenalty ? { frequencyPenalty: options.frequencyPenalty } : {}),
        ...(options.presencePenalty ? { presencePenalty: options.presencePenalty } : {}),
        ...(thinkingConfig ? { thinkingConfig } : {}),
      },
    };

    if (systemMessages.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemMessages.map((m) => m.content).join("\n\n") }],
      };
    }

    this.applyCustomParameters(body, options);

    const authHeaders =
      this.providerKind === "google_vertex"
        ? await googleAuthHeadersForVertex(this.apiKey)
        : { "x-goog-api-key": this.apiKey };

    const response = await llmFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    async function readDecodedText() {
      return decodePossiblyCompressedBody(Buffer.from(await response.arrayBuffer())).toString("utf8");
    }

    if (!response.ok) {
      const errorText = await readDecodedText();
      const label = this.providerKind === "google_vertex" ? "Vertex AI Gemini API" : "Gemini API";
      throw new Error(`${label} error ${response.status}: ${sanitizeApiError(errorText)}`);
    }

    // ── Non-streaming path (also used when thinking is enabled) ──
    if (!useStreaming) {
      const json = JSON.parse(await readDecodedText()) as {
        candidates?: Array<{
          content: { parts: GeminiPart[] };
        }>;
        usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
      };
      const parts = json.candidates?.[0]?.content?.parts ?? [];

      // Report full parts (with thought signatures) for storage
      if (options.onResponseParts) options.onResponseParts(parts);

      for (const part of parts) {
        if (part.thought && part.text && options.onThinking) {
          options.onThinking(part.text);
        } else if (part.text && !part.thought) {
          yield part.text;
        }
      }
      if (json.usageMetadata) {
        return {
          promptTokens: json.usageMetadata.promptTokenCount,
          completionTokens: json.usageMetadata.candidatesTokenCount,
          totalTokens: json.usageMetadata.totalTokenCount,
        };
      }
      return;
    }

    // ── SSE streaming path (no thinking) ──
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const onAbort = () => reader.cancel().catch(() => {});
    if (options.signal) {
      if (options.signal.aborted) {
        await reader.cancel().catch(() => {});
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let streamUsage: LLMUsage | undefined;

    // Accumulators for reconstructing response parts
    let thoughtText = "";
    let responseText = "";
    let lastSignature: string | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);

          try {
            const parsed = JSON.parse(data);
            if (parsed.usageMetadata) {
              streamUsage = {
                promptTokens: parsed.usageMetadata.promptTokenCount,
                completionTokens: parsed.usageMetadata.candidatesTokenCount,
                totalTokens: parsed.usageMetadata.totalTokenCount,
              };
            }
            const parts: GeminiPart[] = parsed.candidates?.[0]?.content?.parts ?? [];
            for (const part of parts) {
              // Capture thought signature from any part
              if (part.thoughtSignature) lastSignature = part.thoughtSignature;

              if (part.thought && part.text) {
                // Thought summary part
                thoughtText += part.text;
                if (options.onThinking) options.onThinking(part.text);
              } else if (part.text && !part.thought) {
                // Regular text part
                responseText += part.text;
                yield part.text;
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
      }
    } finally {
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
    }

    // Reconstruct the canonical parts array for storage (thought signatures + summaries)
    if (options.onResponseParts) {
      const responseParts: GeminiPart[] = [];
      if (thoughtText) responseParts.push({ text: thoughtText, thought: true });
      const textPart: GeminiPart = { text: responseText };
      if (lastSignature) textPart.thoughtSignature = lastSignature;
      responseParts.push(textPart);
      options.onResponseParts(responseParts);
    }

    if (streamUsage) return streamUsage;
  }
}
