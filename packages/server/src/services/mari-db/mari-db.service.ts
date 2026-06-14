// ──────────────────────────────────────────────
// Professor Mari DB service
// ──────────────────────────────────────────────
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { DB } from "../../db/connection.js";
import { flushDB } from "../../db/connection.js";
import { FILE_BACKED_TABLES } from "../../db/file-backed-store.js";
import * as schema from "../../db/schema/index.js";
import { getFileStorageDir } from "../../config/runtime-config.js";
import { logger } from "../../lib/logger.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { newId, now } from "../../utils/id-generator.js";
import type {
  MariDbCommandResult,
  MariDbDiffSummary,
  MariDbHistoryEntry,
  MariDbPendingApproval,
  MariDbRowChange,
  MariDbValidationIssue,
  MariDbValidationResult,
} from "@marinara-engine/shared";

type Row = Record<string, unknown>;
type Table = Record<string | symbol, unknown>;
type Column = {
  name: string;
  table: Table;
  primary?: boolean;
  hasDefault?: boolean;
  default?: unknown;
  notNull?: boolean;
};
type ColumnMeta = {
  key: string;
  dbName: string;
  column: Column;
  primary: boolean;
  notNull: boolean;
};
type TableMeta = {
  name: string;
  table: Table;
  columns: ColumnMeta[];
  byKey: Map<string, ColumnMeta>;
  primaryKey: string | null;
};
type PlanChange = MariDbRowChange & {
  beforeRaw?: Row | null;
  afterRaw?: Row | null;
  apply: boolean;
  cascadeOf?: string;
};
type Plan = {
  changes: PlanChange[];
  validation: MariDbValidationResult;
  summary: MariDbDiffSummary;
  operationHash: string;
  reason: string | null;
  request: ParsedMutationRequest;
};
type ParsedMutationRequest = {
  kind: "insert" | "patch" | "replace" | "delete" | "transform" | "theme-create" | "theme-update" | "theme-set-active";
  table: string | "all";
  id?: string;
  where?: string;
  row?: Row;
  patch?: Row;
  scriptPath?: string;
  name?: string;
  css?: string;
  installedAt?: string;
  activate?: boolean;
  cwd?: string;
  apply: boolean;
  cascade: boolean;
  reason: string | null;
};
type ApprovalDecision = "approved" | "rejected" | "cancelled" | "timed_out";
type PendingRecord = MariDbPendingApproval & {
  plan: Plan;
  command: string;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
};

type MariCliEnvelope = {
  argv?: string[];
  command?: string;
  cwd?: string;
  sessionId?: string;
};

const PREVIEW_LIMIT = 50;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 50;
const FILE_BACKED_TABLE_SET = new Set<string>(FILE_BACKED_TABLES);
const THEME_TABLE = "custom_themes";
const THEME_ACTIVE_TRUE = "true";
const THEME_ACTIVE_FALSE = "false";
const BOOLEAN_FLAGS = new Set(["active", "activate", "apply", "cascade", "dry-run", "jsonl", "parsed", "raw", "strict"]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CASCADES: Array<{ parent: string; child: string; parentKey: string; childKey: string }> = [
  { parent: "chats", child: "messages", parentKey: "id", childKey: "chatId" },
  { parent: "chats", child: "agent_runs", parentKey: "id", childKey: "chatId" },
  { parent: "chats", child: "agent_memory", parentKey: "id", childKey: "chatId" },
  { parent: "chats", child: "chat_images", parentKey: "id", childKey: "chatId" },
  { parent: "chats", child: "memory_chunks", parentKey: "id", childKey: "chatId" },
  { parent: "chats", child: "game_state_snapshots", parentKey: "id", childKey: "chatId" },
  { parent: "chats", child: "game_checkpoints", parentKey: "id", childKey: "chatId" },
  { parent: "messages", child: "message_swipes", parentKey: "id", childKey: "messageId" },
  { parent: "characters", child: "character_card_versions", parentKey: "id", childKey: "characterId" },
  { parent: "characters", child: "character_images", parentKey: "id", childKey: "characterId" },
  { parent: "lorebooks", child: "lorebook_character_links", parentKey: "id", childKey: "lorebookId" },
  { parent: "lorebooks", child: "lorebook_persona_links", parentKey: "id", childKey: "lorebookId" },
  { parent: "lorebooks", child: "lorebook_folders", parentKey: "id", childKey: "lorebookId" },
  { parent: "lorebooks", child: "lorebook_entries", parentKey: "id", childKey: "lorebookId" },
  { parent: "prompt_presets", child: "prompt_groups", parentKey: "id", childKey: "presetId" },
  { parent: "prompt_presets", child: "prompt_sections", parentKey: "id", childKey: "presetId" },
  { parent: "prompt_presets", child: "choice_blocks", parentKey: "id", childKey: "presetId" },
  { parent: "agent_configs", child: "agent_runs", parentKey: "id", childKey: "agentConfigId" },
  { parent: "agent_configs", child: "agent_memory", parentKey: "id", childKey: "agentConfigId" },
];

const JSON_COLUMNS: Record<string, readonly string[]> = {
  characters: ["data"],
  character_card_versions: ["data"],
  personas: ["avatarCrop", "trackerCardColors", "personaStats", "altDescriptions", "tags", "savedStatusOptions"],
  character_groups: ["characterIds"],
  persona_groups: ["personaIds"],
  chats: ["characterIds", "metadata"],
  messages: ["extra"],
  message_swipes: ["extra"],
  memory_chunks: ["embedding"],
  lorebooks: ["scope", "tags"],
  lorebook_entries: [
    "keys",
    "secondaryKeys",
    "characterFilterIds",
    "characterTagFilters",
    "generationTriggerFilters",
    "additionalMatchingSources",
    "relationships",
    "dynamicState",
    "activationConditions",
    "schedule",
    "embedding",
  ],
  prompt_presets: ["tags"],
  prompt_sections: ["enabledModes"],
  choice_blocks: ["choices"],
  chat_presets: ["parameters", "tags"],
  api_connections: ["defaultParameters"],
  agent_configs: ["settings", "toolIds", "triggerKeywords", "triggerCharacterIds", "triggerLorebookIds"],
  agent_runs: ["input", "output", "metadata"],
  agent_memory: ["memory"],
  custom_tools: ["schema", "metadata"],
  game_state_snapshots: [
    "presentCharacters",
    "playerStats",
    "partyState",
    "npcState",
    "relationships",
    "quests",
    "worldState",
    "flags",
    "metadata",
  ],
  game_checkpoints: ["snapshot", "metadata"],
  regex_scripts: ["rules", "tags"],
  chat_images: ["metadata"],
  character_images: ["metadata"],
  assets: ["metadata"],
  custom_themes: ["metadata"],
  installed_extensions: ["manifest", "settings"],
};

function symbolValue<T>(target: object, symbolName: string): T | undefined {
  const symbol = Object.getOwnPropertySymbols(target).find((entry) => String(entry) === symbolName);
  return symbol ? (target as Record<symbol, T>)[symbol] : undefined;
}

function isTable(value: unknown): value is Table {
  return Boolean(value && typeof value === "object" && symbolValue(value as object, "Symbol(drizzle:IsDrizzleTable)"));
}

function tableNameOf(table: Table): string {
  const name = symbolValue<string>(table, "Symbol(drizzle:Name)");
  if (!name) throw new Error("Unknown table object");
  return name;
}

function buildTableMetas() {
  const metas = new Map<string, TableMeta>();
  for (const candidate of Object.values(schema)) {
    if (!isTable(candidate)) continue;
    const table = candidate as Table;
    const name = tableNameOf(table);
    if (!FILE_BACKED_TABLE_SET.has(name)) continue;
    const columnsObject = symbolValue<Record<string, Column>>(table, "Symbol(drizzle:Columns)") ?? {};
    const columns = Object.entries(columnsObject).map(([key, column]) => ({
      key,
      dbName: column.name,
      column,
      primary: column.primary === true,
      notNull: column.notNull === true,
    }));
    metas.set(name, {
      name,
      table,
      columns,
      byKey: new Map(columns.map((column) => [column.key, column])),
      primaryKey: columns.find((column) => column.primary)?.key ?? null,
    });
  }
  return metas;
}

const TABLE_METAS = buildTableMetas();

function isRecord(value: unknown): value is Row {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortForHash(value));
}

function sortForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForHash);
  if (!isRecord(value)) return value;
  const out: Row = {};
  for (const key of Object.keys(value).sort()) out[key] = sortForHash(value[key]);
  return out;
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && trimmed !== "null") return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function jsonColumnSet(table: string) {
  return new Set(JSON_COLUMNS[table] ?? []);
}

function parseRow(table: string, row: Row): Row {
  const jsonCols = jsonColumnSet(table);
  const out: Row = { ...row };
  for (const key of jsonCols) {
    if (Object.prototype.hasOwnProperty.call(out, key)) out[key] = parseJsonMaybe(out[key]);
  }
  return out;
}

function serializeRow(table: string, row: Row): Row {
  const jsonCols = jsonColumnSet(table);
  const out: Row = { ...row };
  for (const key of jsonCols) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) continue;
    const value = out[key];
    if (value === undefined) continue;
    if (value === null) {
      out[key] = null;
    } else if (typeof value !== "string") {
      out[key] = JSON.stringify(value);
    }
  }
  return out;
}

function parseThemeRow(row: Row): Row {
  return { ...parseRow(THEME_TABLE, row), isActive: row.isActive === THEME_ACTIVE_TRUE };
}

function summarizeThemeRow(row: Row): Row {
  const parsed = parseThemeRow(row);
  const css = typeof row.css === "string" ? row.css : "";
  return {
    id: parsed.id,
    name: parsed.name,
    isActive: parsed.isActive,
    cssLength: css.length,
    installedAt: parsed.installedAt,
    updatedAt: parsed.updatedAt,
  };
}

function knownColumnPatch(meta: TableMeta, row: Row): Row {
  const out: Row = {};
  for (const column of meta.columns) {
    if (Object.prototype.hasOwnProperty.call(row, column.key)) out[column.key] = row[column.key];
  }
  return out;
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch) || Array.isArray(base) || Array.isArray(patch)) return clone(patch);
  const out: Row = { ...clone(base) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete out[key];
      continue;
    }
    out[key] = isRecord(out[key]) && isRecord(value) ? deepMerge(out[key], value) : clone(value);
  }
  return out;
}

function getMeta(table: string): TableMeta {
  const meta = TABLE_METAS.get(table);
  if (!meta) throw new Error(`Unknown file-backed table: ${table}`);
  return meta;
}

function getPrimary(meta: TableMeta): string {
  if (!meta.primaryKey) throw new Error(`Table ${meta.name} does not expose a primary key`);
  return meta.primaryKey;
}

function rowId(meta: TableMeta, row: Row): string {
  const key = getPrimary(meta);
  const value = row[key];
  return value == null ? "" : String(value);
}

function normalizeLimit(value: unknown, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function makeEmptyValidation(): MariDbValidationResult {
  return { status: "passed", errors: [], notices: [], infos: [] };
}

function validationFromIssues(issues: MariDbValidationIssue[]): MariDbValidationResult {
  const errors = issues.filter((issue) => issue.level === "error");
  const notices = issues.filter((issue) => issue.level === "notice");
  const infos = issues.filter((issue) => issue.level === "info");
  return { status: errors.length > 0 ? "blocked" : "passed", errors, notices, infos };
}

function summaryForChanges(changes: PlanChange[]): MariDbDiffSummary {
  const preview = changes.slice(0, PREVIEW_LIMIT).map(({ table, id, action, before, after }) => ({
    table,
    id,
    action,
    before: before ?? null,
    after: after ?? null,
  }));
  const affectedTables: Record<string, number> = {};
  for (const change of changes) affectedTables[change.table] = (affectedTables[change.table] ?? 0) + 1;
  return {
    matchedRows: changes.length,
    affectedRows: changes.length,
    insertedRows: changes.filter((change) => change.action === "insert").length,
    updatedRows: changes.filter((change) => change.action === "update").length,
    replacedRows: changes.filter((change) => change.action === "replace").length,
    deletedRows: changes.filter((change) => change.action === "delete").length,
    affectedTables,
    preview,
    truncated: changes.length > PREVIEW_LIMIT,
  };
}

function formatCommand(argv: string[] | undefined, fallback: string | undefined) {
  if (fallback?.trim()) return fallback.trim();
  return ["mari", ...(argv ?? [])]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ")
    .trim();
}

function parseArgs(args: string[]) {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eqIndex = arg.indexOf("=");
    if (eqIndex > 2) {
      flags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--") && !BOOLEAN_FLAGS.has(name)) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { positionals, flags };
}

function flagString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function hasFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.has(name) && flags.get(name) !== false;
}

async function parseJsonInput(flags: Map<string, string | boolean>, cwd?: string) {
  const raw = flagString(flags, "json");
  const file = flagString(flags, "json-file") ?? flagString(flags, "file");
  if (raw && file) throw new Error("Use only one of --json or --json-file");
  if (!raw && !file) throw new Error("Missing --json '<json>' or --json-file <path>");
  const jsonText = file ? await readFile(resolve(cwd ? resolve(cwd) : process.cwd(), file), "utf8") : raw!;
  const parsed = JSON.parse(jsonText) as unknown;
  if (!isRecord(parsed)) throw new Error("JSON input must be a JSON object");
  return parsed;
}

async function parseCssInput(flags: Map<string, string | boolean>, cwd?: string): Promise<string> {
  const raw = flagString(flags, "css");
  const file = flagString(flags, "css-file") ?? flagString(flags, "file");
  if (raw !== undefined && file) throw new Error("Use only one of --css or --css-file");
  if (raw === undefined && !file) throw new Error("Missing --css '<css>' or --css-file <path>");
  return file ? readFile(resolve(cwd ? resolve(cwd) : process.cwd(), file), "utf8") : raw!;
}

function createWherePredicate(expr: string | undefined): (row: Row) => boolean {
  if (!expr) return () => true;
  const fn = new Function("row", `return Boolean(${expr});`) as (row: Row) => boolean;
  return (row: Row) => {
    try {
      return Boolean(fn(row));
    } catch {
      return false;
    }
  };
}

async function importTransform(path: string): Promise<(row: Row, ctx: TransformContext) => unknown> {
  const url = pathToFileURL(path).href + `?mariDb=${Date.now()}`;
  const mod = (await import(url)) as { default?: unknown; transform?: unknown };
  const fn = mod.default ?? mod.transform;
  if (typeof fn !== "function") throw new Error(`Transform ${path} must export a default function`);
  return fn as (row: Row, ctx: TransformContext) => unknown;
}

type TransformContext = {
  table: string;
  now: string;
  newId: () => string;
  raw: (row: Row) => Row;
  parse: (row: Row) => Row;
  find: (table: string, predicate: (row: Row) => boolean) => Row[];
};

export class MariDbService {
  private pending = new Map<string, PendingRecord>();
  private history: MariDbHistoryEntry[] = [];
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: DB) {}

  async executeCli(envelope: MariCliEnvelope): Promise<MariDbCommandResult> {
    const argv = envelope.argv ?? [];
    const command = formatCommand(argv, envelope.command);
    const sessionId = envelope.sessionId || "mari-cli";
    try {
      if (argv[0] === "theme" || argv[0] === "themes") {
        return await this.executeThemeCommand(argv.slice(1), { command, sessionId, cwd: envelope.cwd });
      }
      if (argv[0] !== "db") {
        if (argv[0] === "storage") {
          return {
            ok: false,
            mode: "read",
            command,
            error: "mari storage tx is reserved for a later hot-reload repair phase; use mari db for managed data edits.",
          };
        }
        return { ok: false, mode: "read", command, error: this.helpText() };
      }
      return await this.executeDbCommand(argv.slice(1), { command, sessionId, cwd: envelope.cwd });
    } catch (err) {
      logger.warn(err, "[mari-db] command failed");
      return { ok: false, mode: "read", command, error: err instanceof Error ? err.message : String(err) };
    }
  }

  getPendingApprovals(): MariDbPendingApproval[] {
    return Array.from(this.pending.values()).map((record) => this.pendingView(record));
  }

  async getHistory(): Promise<MariDbHistoryEntry[]> {
    if (this.history.length > 0) return this.history.slice(-HISTORY_LIMIT).reverse();
    const path = this.historyPath();
    if (!existsSync(path)) return [];
    try {
      const content = await readFile(path, "utf8");
      const rows = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-HISTORY_LIMIT)
        .map((line) => JSON.parse(line) as MariDbHistoryEntry)
        .reverse();
      return rows;
    } catch (err) {
      logger.warn(err, "[mari-db] failed to read history");
      return [];
    }
  }

  async approveAndWait(id: string, timeoutMs = 15_000): Promise<{ approval: MariDbPendingApproval; history: MariDbHistoryEntry | null; completed: boolean } | null> {
    const record = this.pending.get(id);
    if (!record) return null;
    const approval = this.pendingView(record);
    const ok = this.approve(id);
    if (!ok) return null;

    const deadline = Date.now() + timeoutMs;
    let history = this.findApprovalCompletion(approval);
    while (!history && Date.now() < deadline) {
      await sleep(100);
      history = this.findApprovalCompletion(approval);
    }

    return { approval, history, completed: !!history };
  }

  approve(id: string): boolean {
    const record = this.pending.get(id);
    if (!record) return false;
    clearTimeout(record.timer);
    this.pending.delete(id);
    record.resolve("approved");
    return true;
  }

  reject(id: string): boolean {
    const record = this.pending.get(id);
    if (!record) return false;
    clearTimeout(record.timer);
    this.pending.delete(id);
    record.resolve("rejected");
    return true;
  }

  async validate(table?: string | null): Promise<MariDbValidationResult> {
    const tables = table ? [table] : [...FILE_BACKED_TABLES];
    const issues: MariDbValidationIssue[] = [];
    const rowCache = new Map<string, Row[]>();

    for (const tableName of tables) {
      const meta = getMeta(tableName);
      const rows = await this.rawRows(tableName);
      rowCache.set(tableName, rows);
      const pk = meta.primaryKey;
      if (!pk) {
        issues.push({ level: "error", table: tableName, message: "Table has no primary key metadata" });
        continue;
      }
      const ids = new Set<string>();
      for (const row of rows) {
        const id = row[pk];
        if (typeof id !== "string" || id.trim().length === 0) {
          issues.push({ level: "error", table: tableName, id: id == null ? null : String(id), message: `Missing primary key ${pk}` });
        } else if (ids.has(id)) {
          issues.push({ level: "error", table: tableName, id, message: `Duplicate primary key ${pk}=${id}` });
        } else {
          ids.add(id);
        }
        for (const column of meta.columns) {
          if (column.notNull && (row[column.key] === null || row[column.key] === undefined)) {
            issues.push({ level: "error", table: tableName, id: id == null ? null : String(id), message: `Missing required column ${column.key}` });
          }
        }
        for (const key of JSON_COLUMNS[tableName] ?? []) {
          if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
          const value = row[key];
          if (value === null || value === undefined || value === "") continue;
          if (typeof value !== "string") continue;
          try {
            JSON.parse(value);
          } catch {
            issues.push({ level: "error", table: tableName, id: id == null ? null : String(id), message: `Column ${key} is not valid JSON` });
          }
        }
        if (tableName === "characters" && typeof row.data === "string") {
          try {
            const card = JSON.parse(row.data) as { name?: unknown };
            if (!isRecord(card) || typeof card.name !== "string") {
              issues.push({ level: "error", table: tableName, id: String(id), message: "Character data does not look like a CharacterData card" });
            }
          } catch {
            // JSON-column check already reports this.
          }
        }
      }
    }

    const getRows = async (tableName: string) => {
      const cached = rowCache.get(tableName);
      if (cached) return cached;
      const rows = await this.rawRows(tableName);
      rowCache.set(tableName, rows);
      return rows;
    };

    for (const cascade of CASCADES) {
      if (table && table !== cascade.child && table !== cascade.parent) continue;
      const parents = new Set((await getRows(cascade.parent)).map((row) => row[cascade.parentKey]).filter((id) => typeof id === "string"));
      for (const child of await getRows(cascade.child)) {
        const ref = child[cascade.childKey];
        if (typeof ref === "string" && ref && !parents.has(ref)) {
          issues.push({
            level: "error",
            table: cascade.child,
            id: String(child[getMeta(cascade.child).primaryKey ?? "id"] ?? ""),
            message: `Dangling reference ${cascade.childKey}=${ref} -> ${cascade.parent}.${cascade.parentKey}`,
          });
        }
      }
    }

    return validationFromIssues(issues);
  }

  private async executeThemeCommand(args: string[], context: { command: string; sessionId: string; cwd?: string }): Promise<MariDbCommandResult> {
    const sub = args[0];
    const rest = args.slice(1);
    const parsed = parseArgs(rest);
    const flags = parsed.flags;

    switch (sub) {
      case "list": {
        const activeOnly = hasFlag(flags, "active");
        const limit = normalizeLimit(flagString(flags, "limit"), 50, 1000);
        const rows = (await this.rawRows(THEME_TABLE))
          .filter((row) => !activeOnly || row.isActive === THEME_ACTIVE_TRUE)
          .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
        return { ok: true, mode: "read", command: context.command, output: rows.slice(0, limit).map(summarizeThemeRow) };
      }
      case "active": {
        const row = (await this.rawRows(THEME_TABLE)).find((candidate) => candidate.isActive === THEME_ACTIVE_TRUE) ?? null;
        return { ok: true, mode: "read", command: context.command, output: row ? parseThemeRow(row) : null };
      }
      case "get": {
        const id = parsed.positionals[0];
        if (!id) throw new Error("Usage: mari themes get <id>");
        const row = await this.getRawById(getMeta(THEME_TABLE), id);
        return { ok: Boolean(row), mode: "read", command: context.command, output: row ? parseThemeRow(row) : null };
      }
      case "create": {
        const name = flagString(flags, "name")?.trim();
        if (!name) throw new Error("Usage: mari themes create --name <name> (--css <css> | --css-file <path>) [--activate] [--apply]");
        const css = await parseCssInput(flags, context.cwd);
        const request: ParsedMutationRequest = {
          kind: "theme-create",
          table: THEME_TABLE,
          id: flagString(flags, "id") ?? newId(),
          name,
          css,
          installedAt: flagString(flags, "installed-at") ?? now(),
          activate: hasFlag(flags, "activate") || hasFlag(flags, "active"),
          apply: hasFlag(flags, "apply"),
          cascade: false,
          reason: flagString(flags, "reason") ?? null,
          cwd: context.cwd,
        };
        return this.executeMutation(request, context.command, context.sessionId);
      }
      case "update": {
        const id = parsed.positionals[0];
        if (!id) throw new Error("Usage: mari themes update <id> [--name <name>] [--css <css> | --css-file <path>] [--apply]");
        const hasCssInput = flags.has("css") || flags.has("css-file") || flags.has("file");
        const name = flagString(flags, "name")?.trim();
        const css = hasCssInput ? await parseCssInput(flags, context.cwd) : undefined;
        if (name === undefined && css === undefined) throw new Error("Theme update needs --name, --css, or --css-file");
        const request: ParsedMutationRequest = {
          kind: "theme-update",
          table: THEME_TABLE,
          id,
          name,
          css,
          apply: hasFlag(flags, "apply"),
          cascade: false,
          reason: flagString(flags, "reason") ?? null,
          cwd: context.cwd,
        };
        return this.executeMutation(request, context.command, context.sessionId);
      }
      case "set-active": {
        const rawId = parsed.positionals[0];
        if (!rawId) throw new Error("Usage: mari themes set-active <id|none> [--apply]");
        const id = ["default", "none", "null", "off"].includes(rawId.toLowerCase()) ? undefined : rawId;
        const request: ParsedMutationRequest = {
          kind: "theme-set-active",
          table: THEME_TABLE,
          id,
          apply: hasFlag(flags, "apply"),
          cascade: false,
          reason: flagString(flags, "reason") ?? null,
          cwd: context.cwd,
        };
        return this.executeMutation(request, context.command, context.sessionId);
      }
      case "help":
        return { ok: true, mode: "read", command: context.command, output: this.themeHelpText() };
      default:
        return { ok: false, mode: "read", command: context.command, error: this.themeHelpText() };
    }
  }

  private async executeDbCommand(args: string[], context: { command: string; sessionId: string; cwd?: string }): Promise<MariDbCommandResult> {
    const sub = args[0];
    const rest = args.slice(1);
    const parsed = parseArgs(rest);
    switch (sub) {
      case "status":
        return { ok: true, mode: "read", command: context.command, output: { status: "ok", dataDir: getFileStorageDir(), tables: FILE_BACKED_TABLES.length } };
      case "tables":
        return { ok: true, mode: "read", command: context.command, output: [...FILE_BACKED_TABLES] };
      case "schema": {
        const table = parsed.positionals[0];
        if (!table) throw new Error("Usage: mari db schema <table>");
        const meta = getMeta(table);
        return {
          ok: true,
          mode: "read",
          command: context.command,
          output: {
            table,
            primaryKey: meta.primaryKey,
            columns: meta.columns.map((column) => ({
              key: column.key,
              dbName: column.dbName,
              primary: column.primary,
              notNull: column.notNull,
              jsonEncoded: jsonColumnSet(table).has(column.key),
            })),
          },
        };
      }
      case "counts": {
        const counts: Record<string, number> = {};
        for (const table of FILE_BACKED_TABLES) counts[table] = (await this.rawRows(table)).length;
        return { ok: true, mode: "read", command: context.command, output: counts };
      }
      case "data-dir":
        return { ok: true, mode: "read", command: context.command, output: getFileStorageDir() };
      case "now":
        return { ok: true, mode: "read", command: context.command, output: now() };
      case "new-id":
        return { ok: true, mode: "read", command: context.command, output: newId() };
      case "list":
        return this.listRows(parsed.positionals[0], context.command, parsed.flags);
      case "get":
        return this.getRow(parsed.positionals[0], parsed.positionals[1], context.command, parsed.flags);
      case "select":
        return this.selectRows(parsed.positionals[0], context.command, parsed.flags);
      case "search":
        return this.searchRows(parsed.positionals[0], parsed.positionals[1], context.command, parsed.flags);
      case "validate": {
        const result = await this.validate(flagString(parsed.flags, "table") ?? null);
        return { ok: result.status === "passed", mode: "read", command: context.command, validation: result, output: result };
      }
      case "insert":
      case "patch":
      case "replace":
      case "delete":
      case "transform": {
        const request = await this.parseMutation(sub, parsed.positionals, parsed.flags, context.cwd);
        return this.executeMutation(request, context.command, context.sessionId);
      }
      default:
        return { ok: false, mode: "read", command: context.command, error: this.helpText() };
    }
  }

  private async listRows(table: string | undefined, command: string, flags: Map<string, string | boolean>): Promise<MariDbCommandResult> {
    if (!table) throw new Error("Usage: mari db list <table>");
    const rows = (await this.rawRows(table)).map((row) => (hasFlag(flags, "parsed") ? parseRow(table, row) : row));
    const limit = normalizeLimit(flagString(flags, "limit"), 50, 1000);
    const offset = normalizeLimit(flagString(flags, "offset"), 0, Number.MAX_SAFE_INTEGER);
    return { ok: true, mode: "read", command, output: rows.slice(offset, offset + limit) };
  }

  private async getRow(table: string | undefined, id: string | undefined, command: string, flags: Map<string, string | boolean>): Promise<MariDbCommandResult> {
    if (!table || !id) throw new Error("Usage: mari db get <table> <id>");
    const meta = getMeta(table);
    const row = await this.getRawById(meta, id);
    return { ok: Boolean(row), mode: "read", command, output: row && hasFlag(flags, "parsed") ? parseRow(table, row) : row };
  }

  private async selectRows(table: string | undefined, command: string, flags: Map<string, string | boolean>): Promise<MariDbCommandResult> {
    if (!table) throw new Error("Usage: mari db select <table> --where <expr>");
    const predicate = createWherePredicate(flagString(flags, "where"));
    const rows = (await this.rawRows(table)).map((row) => parseRow(table, row)).filter(predicate);
    const limit = normalizeLimit(flagString(flags, "limit"), 100, 5000);
    return { ok: true, mode: "read", command, output: rows.slice(0, limit) };
  }

  private async searchRows(tableArg: string | undefined, query: string | undefined, command: string, flags: Map<string, string | boolean>): Promise<MariDbCommandResult> {
    if (!tableArg || !query) throw new Error("Usage: mari db search <table|all> <query>");
    const needle = query.toLowerCase();
    const tables = tableArg === "all" ? [...FILE_BACKED_TABLES] : [tableArg];
    const results: Array<{ table: string; row: Row }> = [];
    const limit = normalizeLimit(flagString(flags, "limit"), 50, 1000);
    for (const table of tables) {
      getMeta(table);
      for (const raw of await this.rawRows(table)) {
        const row = parseRow(table, raw);
        if (JSON.stringify(row).toLowerCase().includes(needle)) results.push({ table, row });
        if (results.length >= limit) return { ok: true, mode: "read", command, output: results };
      }
    }
    return { ok: true, mode: "read", command, output: results };
  }

  private async parseMutation(kind: ParsedMutationRequest["kind"], positionals: string[], flags: Map<string, string | boolean>, cwd?: string): Promise<ParsedMutationRequest> {
    const apply = hasFlag(flags, "apply");
    const cascade = hasFlag(flags, "cascade");
    const reason = flagString(flags, "reason") ?? null;
    if (kind === "insert") {
      const table = positionals[0];
      if (!table) throw new Error("Usage: mari db insert <table> (--json '<row-json>' | --json-file <path>) [--apply]");
      return { kind, table, row: await parseJsonInput(flags, cwd), apply, cascade, reason, cwd };
    }
    if (kind === "patch") {
      const [table, id] = positionals;
      if (!table || !id) throw new Error("Usage: mari db patch <table> <id> (--json '<partial-row-json>' | --json-file <path>) [--apply]");
      return { kind, table, id, patch: await parseJsonInput(flags, cwd), apply, cascade, reason, cwd };
    }
    if (kind === "replace") {
      const [table, id] = positionals;
      if (!table || !id) throw new Error("Usage: mari db replace <table> <id> (--json '<full-row-json>' | --json-file <path>) [--apply]");
      return { kind, table, id, row: await parseJsonInput(flags, cwd), apply, cascade, reason, cwd };
    }
    if (kind === "delete") {
      const table = positionals[0];
      if (!table) throw new Error("Usage: mari db delete <table> <id>|--where <expr> [--cascade] [--apply]");
      return { kind, table, id: positionals[1], where: flagString(flags, "where"), apply, cascade, reason, cwd };
    }
    const [table, scriptPath] = positionals;
    if (!table || !scriptPath) throw new Error("Usage: mari db transform <table|all> <script.mjs> [--dry-run] [--apply]");
    return { kind, table, scriptPath, apply, cascade: true, reason, cwd };
  }

  private async executeMutation(request: ParsedMutationRequest, command: string, sessionId: string): Promise<MariDbCommandResult> {
    const planTimestamp = now();
    const plan = await this.planMutation(request, command, planTimestamp);
    if (plan.validation.status === "blocked") {
      await this.recordHistory({ plan, command, sessionId, status: "blocked", journalPath: null });
      return { ok: false, mode: request.apply ? "apply" : "dry-run", command, summary: plan.summary, validation: plan.validation, error: "Blocking validation failed" };
    }

    if (!request.apply) {
      await this.recordHistory({ plan, command, sessionId, status: "dry-run", journalPath: null });
      return {
        ok: true,
        mode: "dry-run",
        command,
        summary: plan.summary,
        validation: plan.validation,
        approval: { status: "not_required", operationHash: plan.operationHash },
      };
    }

    const decision = await this.requestApproval(plan, command, sessionId);
    if (decision !== "approved") {
      await this.recordHistory({ plan, command, sessionId, status: decision, journalPath: null });
      return {
        ok: false,
        mode: "apply",
        command,
        summary: plan.summary,
        validation: plan.validation,
        approval: { status: decision, operationHash: plan.operationHash },
        error: `Mutation ${decision}`,
      };
    }

    const current = await this.planMutation(request, command, planTimestamp);
    if (current.operationHash !== plan.operationHash) {
      await this.recordHistory({ plan: current, command, sessionId, status: "state_changed", journalPath: null });
      return {
        ok: false,
        mode: "apply",
        command,
        summary: current.summary,
        validation: current.validation,
        approval: { status: "state_changed", operationHash: current.operationHash },
        error: "Database state changed before approval was applied; rerun the dry-run.",
      };
    }

    try {
      const journalPath = await this.applyPlan(current);
      await this.recordHistory({ plan: current, command, sessionId, status: "approved", journalPath });
      return {
        ok: true,
        mode: "apply",
        command,
        summary: current.summary,
        validation: current.validation,
        approval: { status: "approved", operationHash: current.operationHash },
        journalPath,
      };
    } catch (err) {
      logger.error(err, "[mari-db] apply failed");
      await this.recordHistory({ plan: current, command, sessionId, status: "failed", journalPath: null });
      return {
        ok: false,
        mode: "apply",
        command,
        summary: current.summary,
        validation: current.validation,
        approval: { status: "approved", operationHash: current.operationHash },
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async planMutation(request: ParsedMutationRequest, command: string, timestamp: string = now()): Promise<Plan> {
    const issues: MariDbValidationIssue[] = [];
    let changes: PlanChange[] = [];
    if (request.kind === "insert") changes = await this.planInsert(request, timestamp);
    else if (request.kind === "patch") changes = await this.planPatch(request, timestamp);
    else if (request.kind === "replace") changes = await this.planReplace(request, timestamp);
    else if (request.kind === "delete") changes = await this.planDelete(request, issues);
    else if (request.kind === "theme-create") changes = await this.planThemeCreate(request, timestamp, issues);
    else if (request.kind === "theme-update") changes = await this.planThemeUpdate(request, timestamp, issues);
    else if (request.kind === "theme-set-active") changes = await this.planThemeSetActive(request, timestamp, issues);
    else changes = await this.planTransform(request, timestamp);

    const touchedTables = [...new Set(changes.map((change) => change.table))];
    const validation = await this.validateTouchedRows(changes, touchedTables, issues);
    const summary = summaryForChanges(changes);
    const operationHash = hash({ command, request, changes: changes.map((change) => ({ table: change.table, id: change.id, action: change.action, beforeRaw: change.beforeRaw ?? null, afterRaw: change.afterRaw ?? null })) });
    return { changes, validation, summary, operationHash, reason: request.reason, request };
  }

  private async planInsert(request: ParsedMutationRequest, timestamp: string): Promise<PlanChange[]> {
    const meta = getMeta(String(request.table));
    const pk = getPrimary(meta);
    const parsed = { ...(request.row ?? {}) };
    if (parsed[pk] == null || parsed[pk] === "") parsed[pk] = newId();
    this.fillTimestamps(meta, parsed, true, timestamp);
    const afterRaw = serializeRow(meta.name, parsed);
    return [{ table: meta.name, id: String(afterRaw[pk]), action: "insert", before: null, after: parseRow(meta.name, afterRaw), beforeRaw: null, afterRaw, apply: true }];
  }

  private async planPatch(request: ParsedMutationRequest, timestamp: string): Promise<PlanChange[]> {
    const meta = getMeta(String(request.table));
    const existing = await this.requireRawById(meta, String(request.id));
    const parsed = parseRow(meta.name, existing);
    const next = deepMerge(parsed, request.patch ?? {}) as Row;
    next[getPrimary(meta)] = existing[getPrimary(meta)];
    this.fillTimestamps(meta, next, false, timestamp);
    const afterRaw = serializeRow(meta.name, next);
    return [{ table: meta.name, id: rowId(meta, existing), action: "update", before: parsed, after: parseRow(meta.name, afterRaw), beforeRaw: existing, afterRaw, apply: true }];
  }

  private async planReplace(request: ParsedMutationRequest, timestamp: string): Promise<PlanChange[]> {
    const meta = getMeta(String(request.table));
    const existing = await this.requireRawById(meta, String(request.id));
    const next = { ...(request.row ?? {}) };
    next[getPrimary(meta)] = existing[getPrimary(meta)];
    this.fillTimestamps(meta, next, false, timestamp);
    const afterRaw = serializeRow(meta.name, next);
    return [{ table: meta.name, id: rowId(meta, existing), action: "replace", before: parseRow(meta.name, existing), after: parseRow(meta.name, afterRaw), beforeRaw: existing, afterRaw, apply: true }];
  }

  private async planDelete(request: ParsedMutationRequest, issues: MariDbValidationIssue[]): Promise<PlanChange[]> {
    const meta = getMeta(String(request.table));
    const rows = await this.rawRows(meta.name);
    const predicate = request.id ? (row: Row) => String(row[getPrimary(meta)]) === request.id : createWherePredicate(request.where);
    const selected = rows.filter((row) => predicate(parseRow(meta.name, row)));
    const changes: PlanChange[] = selected.map((row) => ({
      table: meta.name,
      id: rowId(meta, row),
      action: "delete",
      before: parseRow(meta.name, row),
      after: null,
      beforeRaw: row,
      afterRaw: null,
      apply: true,
    }));
    await this.addCascadeDeletes(changes, request.cascade);
    const cascaded = changes.filter((change) => change.cascadeOf);
    if (cascaded.length > 0 && !request.cascade) {
      issues.push({ level: "error", table: meta.name, message: `Delete would cascade to ${cascaded.length} child row(s). Re-run with --cascade to confirm.` });
    }
    return this.dedupeDeletes(changes);
  }

  private async planTransform(request: ParsedMutationRequest, timestamp: string): Promise<PlanChange[]> {
    const cwd = request.cwd ? resolve(request.cwd) : process.cwd();
    const scriptPath = resolve(cwd, String(request.scriptPath));
    const transform = await importTransform(scriptPath);
    const tables = request.table === "all" ? [...FILE_BACKED_TABLES] : [String(request.table)];
    const allParsed = new Map<string, Row[]>();
    const allRaw = new Map<string, Row[]>();
    for (const table of tables) {
      getMeta(table);
      const rawRows = await this.rawRows(table);
      allRaw.set(table, rawRows);
      allParsed.set(table, rawRows.map((row) => parseRow(table, row)));
    }
    const changes: PlanChange[] = [];
    for (const table of tables) {
      const meta = getMeta(table);
      const rawRows = allRaw.get(table) ?? [];
      const parsedRows = allParsed.get(table) ?? [];
      for (let index = 0; index < parsedRows.length; index++) {
        const row = clone(parsedRows[index]!);
        const raw = rawRows[index]!;
        const ctx: TransformContext = {
          table,
          now: timestamp,
          newId,
          raw: (parsedRow) => serializeRow(table, parsedRow),
          parse: (rawRow) => parseRow(table, rawRow),
          find: (findTable, predicate) => (allParsed.get(findTable) ?? []).filter(predicate).map(clone),
        };
        const result = await transform(row, ctx);
        if (result === null || result === false || result === undefined) continue;
        if (isRecord(result) && result.delete === true) {
          changes.push({ table, id: rowId(meta, raw), action: "delete", before: row, after: null, beforeRaw: raw, afterRaw: null, apply: true });
          continue;
        }
        if (isRecord(result) && Object.prototype.hasOwnProperty.call(result, "insert")) {
          const inserts = Array.isArray(result.insert) ? result.insert : [result.insert];
          for (const insert of inserts) {
            if (!isRecord(insert)) continue;
            const insertRow = { ...insert };
            const pk = getPrimary(meta);
            if (insertRow[pk] == null || insertRow[pk] === "") insertRow[pk] = newId();
            this.fillTimestamps(meta, insertRow, true, timestamp);
            const afterRaw = serializeRow(table, insertRow);
            changes.push({ table, id: String(afterRaw[pk]), action: "insert", before: null, after: parseRow(table, afterRaw), beforeRaw: null, afterRaw, apply: true });
          }
          continue;
        }
        const next = isRecord(result) && Object.prototype.hasOwnProperty.call(result, "update") ? (deepMerge(row, result.update) as Row) : (result as Row);
        if (!isRecord(next)) continue;
        next[getPrimary(meta)] = raw[getPrimary(meta)];
        this.fillTimestamps(meta, next, false, timestamp);
        const afterRaw = serializeRow(table, next);
        if (stableJson(afterRaw) !== stableJson(raw)) {
          changes.push({ table, id: rowId(meta, raw), action: "update", before: row, after: parseRow(table, afterRaw), beforeRaw: raw, afterRaw, apply: true });
        }
      }
    }
    await this.addCascadeDeletes(changes, true);
    return this.dedupeDeletes(changes);
  }

  private async planThemeCreate(request: ParsedMutationRequest, timestamp: string, issues: MariDbValidationIssue[]): Promise<PlanChange[]> {
    const meta = getMeta(THEME_TABLE);
    const pk = getPrimary(meta);
    const id = String(request.id ?? newId());
    const name = typeof request.name === "string" ? request.name.trim() : "";
    const css = typeof request.css === "string" ? request.css : "";
    const installedAt = request.installedAt ?? timestamp;
    const existingRows = await this.rawRows(THEME_TABLE);

    this.addThemeNameIssues(name, id, issues);
    if (existingRows.some((row) => row[pk] === id)) {
      issues.push({ level: "error", table: THEME_TABLE, id, message: `Theme id ${id} already exists` });
    }
    if (existingRows.some((row) => row.name === name && row.css === css)) {
      issues.push({ level: "notice", table: THEME_TABLE, id, message: "A theme with the same name and CSS already exists" });
    }

    const changes = request.activate ? this.planThemeActivationChanges(existingRows, id, timestamp) : [];
    const afterRaw = serializeRow(THEME_TABLE, {
      id,
      name,
      css,
      installedAt,
      createdAt: timestamp,
      updatedAt: timestamp,
      isActive: request.activate ? THEME_ACTIVE_TRUE : THEME_ACTIVE_FALSE,
    });
    changes.push({
      table: THEME_TABLE,
      id,
      action: "insert",
      before: null,
      after: parseThemeRow(afterRaw),
      beforeRaw: null,
      afterRaw,
      apply: true,
    });
    return changes;
  }

  private async planThemeUpdate(request: ParsedMutationRequest, timestamp: string, issues: MariDbValidationIssue[]): Promise<PlanChange[]> {
    const meta = getMeta(THEME_TABLE);
    const id = String(request.id ?? "");
    const existing = await this.requireRawById(meta, id);
    const next = parseRow(THEME_TABLE, existing);
    if (request.name !== undefined) {
      const name = request.name.trim();
      this.addThemeNameIssues(name, id, issues);
      next.name = name;
    }
    if (request.css !== undefined) next.css = request.css;
    this.fillTimestamps(meta, next, false, timestamp);
    const afterRaw = serializeRow(THEME_TABLE, next);
    if (stableJson(afterRaw) === stableJson(existing)) return [];
    return [
      {
        table: THEME_TABLE,
        id,
        action: "update",
        before: parseThemeRow(existing),
        after: parseThemeRow(afterRaw),
        beforeRaw: existing,
        afterRaw,
        apply: true,
      },
    ];
  }

  private async planThemeSetActive(request: ParsedMutationRequest, timestamp: string, issues: MariDbValidationIssue[]): Promise<PlanChange[]> {
    const targetId = request.id ? String(request.id) : null;
    const rows = await this.rawRows(THEME_TABLE);
    if (targetId && !rows.some((row) => row.id === targetId)) {
      issues.push({ level: "error", table: THEME_TABLE, id: targetId, message: "Theme not found" });
    }
    return this.planThemeActivationChanges(rows, targetId, timestamp);
  }

  private planThemeActivationChanges(rows: Row[], targetId: string | null, timestamp: string): PlanChange[] {
    const meta = getMeta(THEME_TABLE);
    return rows
      .map((row): PlanChange | null => {
        const id = rowId(meta, row);
        const nextActive = targetId && id === targetId ? THEME_ACTIVE_TRUE : THEME_ACTIVE_FALSE;
        if (row.isActive === nextActive) return null;
        const afterRaw = serializeRow(THEME_TABLE, { ...parseRow(THEME_TABLE, row), isActive: nextActive, updatedAt: timestamp });
        return {
          table: THEME_TABLE,
          id,
          action: "update",
          before: parseThemeRow(row),
          after: parseThemeRow(afterRaw),
          beforeRaw: row,
          afterRaw,
          apply: true,
        };
      })
      .filter((change): change is PlanChange => change !== null);
  }

  private addThemeNameIssues(name: string, id: string, issues: MariDbValidationIssue[]) {
    if (!name) issues.push({ level: "error", table: THEME_TABLE, id, message: "Theme name is required" });
    if (name.length > 200) issues.push({ level: "error", table: THEME_TABLE, id, message: "Theme name must be 200 characters or fewer" });
  }

  private fillTimestamps(meta: TableMeta, row: Row, isCreate: boolean, stamp: string) {
    if (isCreate && meta.byKey.has("createdAt") && !row.createdAt) row.createdAt = stamp;
    if (meta.byKey.has("updatedAt") && !row.updatedAt) row.updatedAt = stamp;
  }

  private async addCascadeDeletes(changes: PlanChange[], includeChildren: boolean) {
    if (!includeChildren && changes.length === 0) return;
    const queue = changes.filter((change) => change.action === "delete");
    const seen = new Set(queue.map((change) => `${change.table}:${change.id}`));
    for (let index = 0; index < queue.length; index++) {
      const parent = queue[index]!;
      for (const cascade of CASCADES.filter((entry) => entry.parent === parent.table)) {
        const childMeta = getMeta(cascade.child);
        const parentValue = parent.beforeRaw?.[cascade.parentKey];
        const childRows = (await this.rawRows(cascade.child)).filter((row) => row[cascade.childKey] === parentValue);
        for (const child of childRows) {
          const id = rowId(childMeta, child);
          const key = `${cascade.child}:${id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const childChange: PlanChange = {
            table: cascade.child,
            id,
            action: "delete",
            before: parseRow(cascade.child, child),
            after: null,
            beforeRaw: child,
            afterRaw: null,
            apply: false,
            cascadeOf: `${parent.table}:${parent.id}`,
          };
          changes.push(childChange);
          queue.push(childChange);
        }
      }
    }
  }

  private dedupeDeletes(changes: PlanChange[]): PlanChange[] {
    const out: PlanChange[] = [];
    const seenDeletes = new Set<string>();
    for (const change of changes) {
      if (change.action !== "delete") {
        out.push(change);
        continue;
      }
      const key = `${change.table}:${change.id}`;
      if (seenDeletes.has(key)) continue;
      seenDeletes.add(key);
      out.push(change);
    }
    return out;
  }

  private async validateTouchedRows(changes: PlanChange[], tables: string[], priorIssues: MariDbValidationIssue[]): Promise<MariDbValidationResult> {
    const issues = [...priorIssues];
    for (const change of changes) {
      if (change.action === "delete") continue;
      const meta = getMeta(change.table);
      const row = change.afterRaw ?? {};
      const pk = getPrimary(meta);
      if (typeof row[pk] !== "string" || String(row[pk]).trim().length === 0) {
        issues.push({ level: "error", table: change.table, id: change.id, message: `Missing primary key ${pk}` });
      }
      for (const column of meta.columns) {
        if (column.notNull && (row[column.key] === null || row[column.key] === undefined)) {
          issues.push({ level: "error", table: change.table, id: change.id, message: `Missing required column ${column.key}` });
        }
      }
      for (const key of JSON_COLUMNS[change.table] ?? []) {
        const value = row[key];
        if (value === null || value === undefined || value === "") continue;
        if (typeof value !== "string") continue;
        try {
          JSON.parse(value);
        } catch {
          issues.push({ level: "error", table: change.table, id: change.id, message: `Column ${key} is not valid JSON` });
        }
      }
    }
    const fullValidation = await this.validate();
    // Keep current unrelated optional notices visible to Mari, but only let touched-scope errors block.
    const touched = new Set(tables);
    const scopedExistingErrors = fullValidation.errors.filter((issue) => issue.table && touched.has(issue.table));
    return validationFromIssues([...issues, ...scopedExistingErrors, ...fullValidation.notices, ...fullValidation.infos]);
  }

  private async applyPlan(plan: Plan): Promise<string> {
    const operationId = newId();
    const journalPath = await this.writeJournal(operationId, plan);
    await this.db.transaction(async (tx) => {
      const characterStorage = createCharactersStorage(tx as unknown as DB);
      for (const change of plan.changes) {
        if (!change.apply) continue;
        const meta = getMeta(change.table);
        const pk = getPrimary(meta);
        if ((change.action === "update" || change.action === "replace") && change.table === "characters") {
          await characterStorage.createVersionSnapshot(change.id, {
            source: "professor-mari-workspace",
            reason: plan.reason ?? "Professor Mari database change",
          });
        }
        if (change.action === "insert") {
          await tx.insert(meta.table as any).values(knownColumnPatch(meta, change.afterRaw ?? {}));
        } else if (change.action === "update" || change.action === "replace") {
          await tx
            .update(meta.table as any)
            .set(knownColumnPatch(meta, change.afterRaw ?? {}))
            .where(eq(meta.byKey.get(pk)!.column as any, change.id));
        } else if (change.action === "delete") {
          await tx.delete(meta.table as any).where(eq(meta.byKey.get(pk)!.column as any, change.id));
        }
      }
    });
    const validation = await this.validate();
    if (validation.status === "blocked") {
      throw new Error(`Post-apply validation failed: ${validation.errors.map((issue) => issue.message).join("; ")}`);
    }
    await flushDB();
    return journalPath;
  }

  private async writeJournal(operationId: string, plan: Plan): Promise<string> {
    const dir = this.journalDir();
    await mkdir(dir, { recursive: true });
    const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}_mari-db_${operationId}.jsonl`;
    const path = join(dir, filename);
    const lines = plan.changes.map((change) =>
      JSON.stringify({
        operationId,
        table: change.table,
        id: change.id,
        action: change.action,
        before: change.before ?? null,
        after: change.after ?? null,
        reason: plan.reason ?? null,
        createdAt: now(),
      }),
    );
    await writeFile(path, lines.join("\n") + "\n", "utf8");
    return path;
  }

  private async requestApproval(plan: Plan, command: string, sessionId: string): Promise<ApprovalDecision> {
    const id = newId();
    const requestedAt = now();
    const expiresAt = new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString();
    return new Promise<ApprovalDecision>((resolveDecision) => {
      const timer = setTimeout(() => {
        const record = this.pending.get(id);
        if (!record) return;
        this.pending.delete(id);
        resolveDecision("timed_out");
      }, APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      const record: PendingRecord = {
        id,
        sessionId,
        command,
        reason: plan.reason,
        operationHash: plan.operationHash,
        requestedAt,
        expiresAt,
        affectedTables: plan.summary.affectedTables,
        affectedRows: plan.summary.affectedRows,
        validationStatus: plan.validation.status,
        diffPreview: plan.summary.preview,
        diffTruncated: plan.summary.truncated,
        plan,
        resolve: resolveDecision,
        timer,
      };
      this.pending.set(id, record);
    });
  }

  private pendingView(record: PendingRecord): MariDbPendingApproval {
    const { plan: _plan, resolve: _resolve, timer: _timer, ...view } = record;
    return view;
  }

  private findApprovalCompletion(approval: MariDbPendingApproval): MariDbHistoryEntry | null {
    return (
      [...this.history]
        .reverse()
        .find(
          (entry) =>
            entry.operationHash === approval.operationHash &&
            entry.sessionId === approval.sessionId &&
            entry.command === approval.command &&
            entry.status !== "dry-run",
        ) ?? null
    );
  }

  private async recordHistory(args: { plan: Plan; command: string; sessionId: string; status: MariDbHistoryEntry["status"]; journalPath: string | null }) {
    const entry: MariDbHistoryEntry = {
      id: newId(),
      sessionId: args.sessionId,
      command: args.command,
      reason: args.plan.reason,
      status: args.status,
      operationHash: args.plan.operationHash,
      affectedTables: args.plan.summary.affectedTables,
      affectedRows: args.plan.summary.affectedRows,
      validationStatus: args.plan.validation.status,
      journalPath: args.journalPath,
      createdAt: now(),
      completedAt: now(),
    };
    this.history.push(entry);
    this.history = this.history.slice(-HISTORY_LIMIT);
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.journalDir(), { recursive: true });
        await appendFile(this.historyPath(), JSON.stringify(entry) + "\n", "utf8");
      });
    await this.writeQueue.catch((err) => logger.warn(err, "[mari-db] failed to write history"));
  }

  private async rawRows(table: string): Promise<Row[]> {
    const meta = getMeta(table);
    const rows = (await this.db.select().from(meta.table as any)) as Row[];
    return rows.map((row) => ({ ...row }));
  }

  private async getRawById(meta: TableMeta, id: string): Promise<Row | null> {
    const pk = getPrimary(meta);
    const rows = (await this.db.select().from(meta.table as any).where(eq(meta.byKey.get(pk)!.column as any, id))) as Row[];
    return rows[0] ? { ...rows[0] } : null;
  }

  private async requireRawById(meta: TableMeta, id: string): Promise<Row> {
    const row = await this.getRawById(meta, id);
    if (!row) throw new Error(`No row found in ${meta.name} with ${getPrimary(meta)}=${id}`);
    return row;
  }

  private journalDir() {
    return join(getFileStorageDir(), "journal");
  }

  private historyPath() {
    return join(this.journalDir(), "mari-db-history.jsonl");
  }

  private themeHelpText() {
    return [
      "Usage: mari themes <command>",
      "Read: list [--active] [--limit <n>], active, get <id>",
      "Write: create --name <name> (--css <css> | --css-file <path>) [--activate] [--apply] [--reason <text>]",
      "Write: update <id> [--name <name>] [--css <css> | --css-file <path>] [--apply] [--reason <text>]",
      "Write: set-active <id|none> [--apply] [--reason <text>]",
      "Writes dry-run by default; --apply requests browser approval.",
    ].join("\n");
  }

  private helpText() {
    return [
      "Usage: mari db <command> or mari themes <command>",
      "Discovery: status, tables, schema <table>, counts, data-dir, now, new-id",
      "Read: list <table>, get <table> <id>, select <table> --where <expr>, search <table|all> <query>, validate [--table <table>]",
      "Write: insert|patch|replace|delete|transform ... (dry-run by default; --apply requests browser approval)",
      "Themes: mari themes list|active|get|create|update|set-active",
      `Known tables: ${FILE_BACKED_TABLES.slice(0, 8).join(", ")} ... (${FILE_BACKED_TABLES.length})`,
      `Journal directory: ${this.journalDir()} (${basename(getFileStorageDir())})`,
    ].join("\n");
  }
}

let singleton: MariDbService | null = null;
export function getMariDbService(db: DB) {
  if (!singleton) singleton = new MariDbService(db);
  return singleton;
}
