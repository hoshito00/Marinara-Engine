// ──────────────────────────────────────────────
// Professor Mari Pi workspace runtime
// ──────────────────────────────────────────────
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message as PiMessage,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ChatMessage, LLMToolDefinition, LLMUsage } from "../llm/base-provider.js";
import { createLLMProvider } from "../llm/provider-registry.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { resolveBaseUrl, mergeCustomParameters, normalizeServiceTier } from "../../routes/generate/generate-route-utils.js";
import { getFileStorageDir, getMonorepoRoot, getPort, getServerProtocol } from "../../config/runtime-config.js";
import { apiConnections } from "../../db/schema/index.js";
import { decryptApiKey } from "../../utils/crypto.js";
import { DATA_DIR } from "../../utils/data-dir.js";
import { logger } from "../../lib/logger.js";
import { PROFESSOR_MARI_ID } from "@marinara-engine/shared";
import type {
  MariWorkspaceConnectionSummary,
  MariWorkspacePromptEvent,
  MariWorkspaceStatus,
  MariWorkspaceToolName,
} from "@marinara-engine/shared";
import { getMariDbService } from "../mari-db/mari-db.service.js";

type ConnectionWithKey = typeof apiConnections.$inferSelect & { apiKey: string };
type PromptEventSink = (event: MariWorkspacePromptEvent) => void;

const WORKSPACE_TOOLS: MariWorkspaceToolName[] = ["read", "grep", "find", "ls", "edit", "write", "bash"];
const MARINARA_PROVIDER = "marinara";
const MARINARA_MODEL = "current-connection";
const MARINARA_API = "marinara-chat";
const RUNTIME_API_KEY = "local-marinara-runtime";
const SESSION_ID = "professor-mari-workspace";

const MARI_SYSTEM_PROMPT = `You are Professor Mari, Marinara Engine's Home-screen local workspace helper.

You are running inside the user's local Marinara Engine server with read, grep, find, ls, edit, write, and bash tools. This is not a sandbox. Be careful, explain risky actions, and ask before actions that could change files, app data, or server state.

Workspace scope:
- Help with Marinara Engine usage, setup, source files, extensions, themes, scripts, docs, and local user data.
- Use normal file tools for source files, extension/theme files, scripts, and docs.
- Tool calls already run from the Marinara Engine workspace root. Run commands directly, for example \`pnpm check\` or \`mari db status\`; do not prefix commands with \`cd <workspace>\` unless the user asks you to operate somewhere else.
- Do not rely on hidden project instructions or skills. If you need repository facts, inspect the files directly.

Data access:
- Prefer \`mari db\` for anything under DATA_DIR/storage.
- Run dry-runs before persistent data edits.
- Use \`--apply\` only after the user explicitly asks to apply the shown change.
- Browser approval is required for \`--apply\`; do not treat model text as approval.
- Do not use \`write\` or \`edit\` directly on storage table files.
- For multi-line or large JSON, write it to /tmp as a JSON file and pass \`--json-file /tmp/name.json\`. Do not inline large JSON through shell substitution.
- For new rows use \`mari db insert\`; \`patch\` and \`replace\` require an existing row.

Useful commands:
\`\`\`sh
mari db status
mari db tables
mari db schema characters
mari db counts
mari db list characters --limit 20 --parsed
mari db get characters <id> --parsed
mari db search all "query" --limit 20
mari db select lorebooks --where 'row.name.includes("Luna")'
mari db validate
\`\`\`

Mutations:
\`\`\`sh
mari db patch characters <id> --json '{"data":{"description":"New description"}}'
mari db patch characters <id> --json '{"data":{"description":"New description"}}' --apply
mari db insert characters --json-file /tmp/new-character.json
mari db insert characters --json-file /tmp/new-character.json --apply
\`\`\`

For bulk work, write a temporary transform script and run:
\`\`\`sh
mari db transform characters /tmp/fix.mjs --dry-run
mari db transform characters /tmp/fix.mjs --apply --reason "Explain the change"
\`\`\`

After approved changes, summarize affected tables/rows, validation status, and journal path. When a task is risky, summarize the claim, affected entrypoints, and any proof gaps before saying done.`;

function bool(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringifyEventPayload(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getLastAssistantMessage(session: AgentSession, startIndex = 0): Record<string, unknown> | null {
  const messages = session.messages.slice(startIndex);
  for (const message of [...messages].reverse()) {
    if (isRecord(message) && message.role === "assistant") return message;
  }
  return null;
}

function extractAssistantText(message: Record<string, unknown> | null): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
}

function extractAssistantThinking(message: Record<string, unknown> | null): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .map((block) =>
      isRecord(block) && block.type === "thinking" && typeof block.thinking === "string" ? block.thinking : "",
    )
    .join("");
}

function extractAssistantError(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return null;
  return typeof message.errorMessage === "string" && message.errorMessage.trim()
    ? message.errorMessage
    : `Professor Mari workspace ${message.stopReason}.`;
}

function flattenContent(content: PiMessage["content"]): { text: string; images?: string[] } {
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: "" };
  const text: string[] = [];
  const images: string[] = [];
  for (const item of content) {
    if (item.type === "text") text.push((item as TextContent).text);
    if (item.type === "image") {
      const image = item as ImageContent;
      images.push(`data:${image.mimeType};base64,${image.data}`);
    }
  }
  return { text: text.join("\n"), images: images.length > 0 ? images : undefined };
}

function convertMessages(context: Context): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (context.systemPrompt?.trim()) {
    messages.push({ role: "system", content: context.systemPrompt, contextKind: "prompt" });
  }
  for (const message of context.messages) {
    if (message.role === "user") {
      const content = flattenContent(message.content);
      messages.push({ role: "user", content: content.text || " ", images: content.images, contextKind: "history" });
    } else if (message.role === "toolResult") {
      const content = flattenContent(message.content);
      messages.push({
        role: "tool",
        content: content.text || " ",
        tool_call_id: message.toolCallId,
        contextKind: "history",
      });
    } else if (message.role === "assistant") {
      const text: string[] = [];
      const toolCalls = [] as ChatMessage["tool_calls"];
      for (const block of message.content) {
        if (block.type === "text") text.push(block.text);
        if (block.type === "thinking") continue;
        if (block.type === "toolCall") {
          const call = block as ToolCall;
          toolCalls?.push({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
          });
        }
      }
      messages.push({
        role: "assistant",
        content: text.join("\n"),
        ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        contextKind: "history",
      });
    }
  }
  return messages;
}

function convertTools(context: Context): LLMToolDefinition[] | undefined {
  if (!context.tools?.length) return undefined;
  return context.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>,
    },
  }));
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function mapUsage(usage: LLMUsage | undefined): AssistantMessage["usage"] {
  if (!usage) return emptyUsage();
  return {
    input: usage.promptTokens,
    output: usage.completionTokens,
    cacheRead: usage.cachedPromptTokens ?? 0,
    cacheWrite: usage.cacheWritePromptTokens ?? 0,
    totalTokens: usage.totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createPiModel(connection: ConnectionWithKey): Model<string> {
  const maxContext = Number.isFinite(connection.maxContext) && connection.maxContext > 0 ? connection.maxContext : 128000;
  const maxTokens = connection.maxTokensOverride && connection.maxTokensOverride > 0 ? connection.maxTokensOverride : 8192;
  return {
    id: MARINARA_MODEL,
    name: `${connection.name || "Marinara Connection"} / ${connection.model || "model"}`,
    api: MARINARA_API,
    provider: MARINARA_PROVIDER,
    baseUrl: "marinara://current-connection",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: maxContext,
    maxTokens,
  };
}

function connectionSummary(connection: ConnectionWithKey | null): MariWorkspaceConnectionSummary | null {
  if (!connection) return null;
  return {
    id: connection.id,
    name: connection.name,
    provider: connection.provider,
    model: connection.model,
  };
}

export class ProfessorMariWorkspaceService {
  private enabled = true;
  private session: AgentSession | null = null;
  private sessionConnectionId: string | null = null;
  private workspaceRoot = getMonorepoRoot();
  private lastError: string | null = null;

  constructor(private readonly app: FastifyInstance) {}

  setEnabled(enabled: boolean, workspaceRoot?: string | null) {
    this.enabled = enabled;
    if (workspaceRoot?.trim()) this.workspaceRoot = resolve(workspaceRoot);
    if (!enabled) void this.disposeSession();
  }

  async status(connectionId?: string | null): Promise<MariWorkspaceStatus> {
    const connection = await this.resolveConnection(connectionId).catch((err) => {
      this.lastError = err instanceof Error ? err.message : String(err);
      return null;
    });
    return {
      enabled: this.enabled,
      piAvailable: true,
      workspace: this.workspaceRoot,
      dataDir: DATA_DIR,
      tools: WORKSPACE_TOOLS,
      dbAccess: "server-managed",
      connection: connectionSummary(connection),
      active: Boolean(this.session?.isStreaming),
      pendingApprovals: getMariDbService(this.app.db).getPendingApprovals(),
      history: await getMariDbService(this.app.db).getHistory(),
      error: this.lastError,
    };
  }

  async abort() {
    await this.session?.abort();
  }

  async reset() {
    await this.session?.abort().catch((err) => logger.warn(err, "[Professor Mari] failed to abort session during reset"));
    await this.disposeSession();
    this.lastError = null;
  }

  async prompt(args: { chatId: string; text: string; connectionId?: string | null; onEvent: PromptEventSink }) {
    const chatStorage = createChatsStorage(this.app.db);
    await chatStorage.createMessage({ chatId: args.chatId, role: "user", characterId: null, content: args.text });

    const connection = await this.resolveConnection(args.connectionId);
    if (!connection) throw new Error("Set up a language connection before using Professor Mari workspace mode.");
    const session = await this.ensureSession(connection);

    let assistantText = "";
    let thinkingText = "";
    const messageCountBeforePrompt = session.messages.length;
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      const raw = event as unknown as Record<string, any>;
      if (event.type === "message_update") {
        const update = raw.assistantMessageEvent;
        if (update?.type === "text_delta" && typeof update.delta === "string") {
          assistantText += update.delta;
          args.onEvent({ type: "token", data: update.delta });
        }
        if (update?.type === "thinking_delta" && typeof update.delta === "string") {
          thinkingText += update.delta;
          args.onEvent({ type: "thinking", data: update.delta });
        }
      } else if (event.type === "tool_execution_start") {
        args.onEvent({
          type: "tool_start",
          data: { id: raw.toolCallId, name: raw.toolName ?? "tool", input: raw.args ?? raw.input },
        });
      } else if (event.type === "tool_execution_update") {
        args.onEvent({
          type: "tool_update",
          data: {
            id: raw.toolCallId,
            name: raw.toolName,
            output: stringifyEventPayload(raw.partialResult ?? raw.output ?? raw.delta),
          },
        });
      } else if (event.type === "tool_execution_end") {
        args.onEvent({
          type: "tool_end",
          data: {
            id: raw.toolCallId,
            name: raw.toolName,
            isError: raw.isError,
            output: stringifyEventPayload(raw.result ?? raw.output),
          },
        });
      }
    });

    try {
      await session.prompt(args.text, { source: "rpc" });
      const lastAssistant = getLastAssistantMessage(session, messageCountBeforePrompt);
      const finalText = extractAssistantText(lastAssistant) || session.getLastAssistantText() || "";
      const finalThinking = extractAssistantThinking(lastAssistant);
      const finalError = extractAssistantError(lastAssistant);

      if (finalText && finalText !== assistantText) {
        const missingText = finalText.startsWith(assistantText) ? finalText.slice(assistantText.length) : assistantText ? "" : finalText;
        if (missingText) {
          assistantText += missingText;
          args.onEvent({ type: "token", data: missingText });
        }
      }
      if (finalThinking && finalThinking !== thinkingText) {
        const missingThinking = finalThinking.startsWith(thinkingText)
          ? finalThinking.slice(thinkingText.length)
          : thinkingText
            ? ""
            : finalThinking;
        if (missingThinking) {
          thinkingText += missingThinking;
          args.onEvent({ type: "thinking", data: missingThinking });
        }
      }

      const persistedText = finalText.trim() ? finalText : assistantText;
      if (finalError && !persistedText.trim()) throw new Error(finalError);

      if (persistedText.trim()) {
        const message = await chatStorage.createMessage({
          chatId: args.chatId,
          role: "assistant",
          characterId: PROFESSOR_MARI_ID,
          content: persistedText,
        });
        if (message && thinkingText.trim()) {
          await chatStorage.updateMessageExtra(message.id, { thinking: thinkingText });
          await chatStorage.updateSwipeExtra(message.id, 0, { thinking: thinkingText });
        }
      }
      args.onEvent({ type: "metadata", data: { connection: connectionSummary(connection) ?? undefined } });
    } finally {
      unsubscribe();
    }
  }

  private async disposeSession() {
    this.session?.dispose();
    this.session = null;
    this.sessionConnectionId = null;
  }

  private async ensureSession(connection: ConnectionWithKey): Promise<AgentSession> {
    if (this.session && this.sessionConnectionId === connection.id) return this.session;
    await this.disposeSession();
    await this.ensureMariCliShim();

    process.env.MARINARA_PI_API_KEY = RUNTIME_API_KEY;
    process.env.MARI_WORKSPACE_SESSION_ID = SESSION_ID;
    process.env.MARI_SERVER_URL = `${getServerProtocol()}://127.0.0.1:${getPort()}`;
    process.env.DATA_DIR = DATA_DIR;

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    } as any);
    const authStorage = AuthStorage.create(join(DATA_DIR, ".mari-workspace", "pi-auth.json"));
    authStorage.setRuntimeApiKey(MARINARA_PROVIDER, RUNTIME_API_KEY);
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const model = createPiModel(connection);
    const loader = new DefaultResourceLoader({
      cwd: this.workspaceRoot,
      agentDir: join(DATA_DIR, ".mari-workspace", "pi-agent"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride: () => MARI_SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      extensionFactories: [
        (pi: any) => {
          pi.registerProvider(MARINARA_PROVIDER, {
            name: "Marinara current connection",
            baseUrl: "marinara://current-connection",
            apiKey: "$MARINARA_PI_API_KEY",
            api: MARINARA_API,
            models: [model],
            streamSimple: (_model: Model<string>, context: Context, options?: SimpleStreamOptions) =>
              this.streamMarinara(connection.id, context, options),
          });
          pi.on("tool_call", async (event: any, ctx: any) => this.guardStorageToolCall(event, ctx));
        },
      ],
    });
    await loader.reload();

    const result = await createAgentSession({
      cwd: this.workspaceRoot,
      agentDir: join(DATA_DIR, ".mari-workspace", "pi-agent"),
      model,
      thinkingLevel: "off",
      tools: WORKSPACE_TOOLS,
      authStorage,
      modelRegistry,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(this.workspaceRoot),
      settingsManager,
    });
    this.session = result.session;
    this.sessionConnectionId = connection.id;
    this.lastError = result.modelFallbackMessage ?? null;
    return result.session;
  }

  private streamMarinara(connectionId: string, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const connection = await this.resolveConnection(connectionId);
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: MARINARA_API,
        provider: MARINARA_PROVIDER,
        model: MARINARA_MODEL,
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        if (!connection) throw new Error("No Marinara language connection available.");
        stream.push({ type: "start", partial: output });
        const provider = createLLMProvider(
          connection.provider,
          resolveBaseUrl(connection),
          connection.apiKey,
          connection.maxContext,
          connection.openrouterProvider,
          connection.maxTokensOverride,
          bool(connection.claudeFastMode),
        );
        const defaultParameters = parseJsonObject(connection.defaultParameters);
        let contentIndex: number | null = null;
        let sawTextDelta = false;
        const ensureText = () => {
          if (contentIndex !== null) return contentIndex;
          output.content.push({ type: "text", text: "" });
          contentIndex = output.content.length - 1;
          stream.push({ type: "text_start", contentIndex, partial: output });
          return contentIndex;
        };
        const result = await provider.chatComplete(convertMessages(context), {
          model: connection.model,
          temperature: typeof defaultParameters?.temperature === "number" ? defaultParameters.temperature : 0.2,
          maxTokens: connection.maxTokensOverride ?? options?.maxTokens ?? 8192,
          maxContext: connection.maxContext,
          stream: true,
          tools: convertTools(context),
          enableCaching: bool(connection.enableCaching),
          cachingAtDepth: connection.cachingAtDepth ?? 5,
          enableThinking: options?.reasoning !== undefined,
          reasoningEffort:
            options?.reasoning === "xhigh" ? "xhigh" : options?.reasoning === "minimal" ? "low" : options?.reasoning,
          serviceTier: normalizeServiceTier(defaultParameters?.serviceTier),
          openrouterProvider: connection.openrouterProvider,
          customParameters: mergeCustomParameters(defaultParameters, null),
          signal: options?.signal,
          onThinking: (delta) => {
            let thinkingIndex = output.content.findIndex((block) => block.type === "thinking");
            if (thinkingIndex < 0) {
              output.content.push({ type: "thinking", thinking: "" });
              thinkingIndex = output.content.length - 1;
              stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
            }
            const block = output.content[thinkingIndex];
            if (block?.type === "thinking") block.thinking += delta;
            stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta, partial: output });
          },
          onToken: (delta) => {
            const index = ensureText();
            const block = output.content[index];
            if (block?.type === "text") block.text += delta;
            sawTextDelta = true;
            stream.push({ type: "text_delta", contentIndex: index, delta, partial: output });
          },
        });

        if (result.content && !sawTextDelta) {
          const index = ensureText();
          const block = output.content[index];
          if (block?.type === "text") block.text += result.content;
          stream.push({ type: "text_delta", contentIndex: index, delta: result.content, partial: output });
        }
        if (contentIndex !== null) {
          const block = output.content[contentIndex];
          stream.push({ type: "text_end", contentIndex, content: block?.type === "text" ? block.text : "", partial: output });
        }

        if (result.toolCalls.length > 0) {
          output.stopReason = "toolUse";
          for (const toolCall of result.toolCalls) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
            } catch {
              args = { raw: toolCall.function.arguments };
            }
            const block: ToolCall = { type: "toolCall", id: toolCall.id, name: toolCall.function.name, arguments: args };
            output.content.push(block);
            const index = output.content.length - 1;
            stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
            stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(args), partial: output });
            stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
          }
        }

        output.usage = mapUsage(result.usage);
        stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
        stream.end();
      } catch (err) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    })();
    return stream;
  }

  private guardStorageToolCall(event: any, ctx: any) {
    const storageRoot = resolve(getFileStorageDir());
    const storageRootLower = storageRoot.toLowerCase();
    const toolName = String(event.toolName ?? "");
    if (toolName === "write" || toolName === "edit") {
      const inputPath = typeof event.input?.path === "string" ? event.input.path : "";
      const absolute = resolve(ctx.cwd ?? this.workspaceRoot, inputPath);
      if (absolute.toLowerCase().startsWith(storageRootLower)) {
        return {
          block: true,
          reason: `DATA_DIR/storage is managed by Marinara. Use mari db for table edits instead of ${toolName}.`,
        };
      }
    }
    if (toolName === "bash") {
      const command = String(event.input?.command ?? "");
      if (!command.includes("mari db") && !command.includes("mari storage tx") && command.includes(storageRoot)) {
        const looksMutating = /\b(rm|mv|cp|truncate|tee|sed\s+-i|perl\s+-i|python|node|bash|sh)\b/.test(command);
        if (looksMutating) {
          return {
            block: true,
            reason: "Shell command appears to mutate DATA_DIR/storage. Use mari db --apply so the browser user can approve the change.",
          };
        }
      }
    }
    return undefined;
  }

  private async resolveConnection(connectionId?: string | null): Promise<ConnectionWithKey | null> {
    const rows = (await this.app.db.select().from(apiConnections)) as Array<typeof apiConnections.$inferSelect>;
    const languageRows = rows.filter((row) => row.provider !== "image_generation");
    const selected = connectionId ? languageRows.find((row) => row.id === connectionId) : null;
    const fallback =
      selected ?? languageRows.find((row) => bool(row.defaultForAgents)) ?? languageRows.find((row) => bool(row.isDefault)) ?? languageRows[0] ?? null;
    if (!fallback) return null;
    return { ...fallback, apiKey: decryptApiKey(fallback.apiKeyEncrypted) };
  }

  private async ensureMariCliShim() {
    const binDir = join(DATA_DIR, ".mari-workspace", "bin");
    await mkdir(binDir, { recursive: true });
    const cliPath = join(binDir, process.platform === "win32" ? "mari.cmd" : "mari");
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const distCli = join(packageRoot, "dist", "bin", "mari.js");
    const sourceCli = join(packageRoot, "src", "bin", "mari.ts");
    const script =
      process.platform === "win32"
        ? `@echo off\r\nnode "${distCli}" %*\r\n`
        : `#!/usr/bin/env sh\nif [ -f ${JSON.stringify(distCli)} ]; then\n  exec node ${JSON.stringify(distCli)} "$@"\nfi\nexec pnpm exec tsx ${JSON.stringify(sourceCli)} "$@"\n`;
    await writeFile(cliPath, script, { mode: 0o755 });
    const currentPath = process.env.PATH ?? "";
    if (!currentPath.split(process.platform === "win32" ? ";" : ":").includes(binDir)) {
      process.env.PATH = `${binDir}${process.platform === "win32" ? ";" : ":"}${currentPath}`;
    }
    if (!existsSync(cliPath)) logger.warn("[Professor Mari] failed to create mari CLI shim at %s", cliPath);
  }
}

let singleton: ProfessorMariWorkspaceService | null = null;
export function getProfessorMariWorkspaceService(app: FastifyInstance) {
  if (!singleton) singleton = new ProfessorMariWorkspaceService(app);
  return singleton;
}
