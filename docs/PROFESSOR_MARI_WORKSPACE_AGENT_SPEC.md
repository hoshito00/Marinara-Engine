# Professor Mari Workspace Agent and `mari db` CLI Spec

Status: Draft proposal  
Audience: Marinara maintainers and implementation agents  
Related docs: [Professor Mari](PROFESSOR_MARI.md), [File Storage Migration](FILE_STORAGE_MIGRATION.md), [Architecture Map](ARCHITECTURE_MAP.md)

## Summary

Professor Mari should become one unified local workspace agent, not separate “safe” and “developer” assistants. The same Mari conversation can explain the app, edit characters, bulk-modify user data, create extensions, inspect source files, and run shell commands.

The proposed architecture embeds a Pi-powered Mari runtime with normal file/shell tools and adds a shell-native `mari db` CLI. The CLI is not a restrictive replacement for raw access. It is a Marinara-aware database lens that makes the current JSON table store searchable, scriptable, editable, and validatable from bash.

Mari keeps full freedom to use `bash`, `read`, `edit`, and `write`. For Marinara storage, her skill should strongly prefer `mari db` because it understands table schemas, nested JSON fields, live server state, IDs, timestamps, snapshots, cascades, and validation.

## Goals

- Provide **one single Professor Mari agent** with one transcript and one runtime.
- Allow Mari to use full local tools, including shell/file access when the user enables the feature.
- Let Mari perform complex bash-driven bulk operations across characters, lorebooks, chats, presets, settings, and future tables.
- Avoid one custom app tool per feature. `mari db` must be generic enough to operate on every file-backed table.
- Avoid whole-library copies as a required workflow. Operations should stream, patch, or journal touched rows/tables only.
- Make the JSON storage approachable for weaker models by exposing parsed, schema-aware, scriptable views.
- Preserve app invariants where practical: valid JSON, unique IDs, referential integrity, timestamps, character card snapshots, cascades, and cache invalidation.
- Keep a server-coordinated emergency path for raw file repair and normal file tools for extension/source editing.

## Non-Goals

- Do not split Mari into two separate assistants.
- Do not require users to export/import their full library for normal edits.
- Do not make `mari db` the only thing Mari can use. Bash remains available.
- Do not require manually mapping every command for every Marinara entity before the system is useful.
- Do not make direct edits to `DATA_DIR/storage/tables/*.json` the normal live-server write path.
- Do not support a separate offline `mari db` path for the UI workspace agent; if the server is unavailable, the agent is unavailable too.

## Current Storage Facts

Marinara v1.5.7+ uses file-native JSON table snapshots under:

```text
DATA_DIR/storage/
  manifest.json
  tables/
    characters.json
    character_card_versions.json
    personas.json
    lorebooks.json
    lorebook_entries.json
    chats.json
    messages.json
    ...
```

The live server loads those tables into an in-memory file-native DB and autosaves dirty tables back to JSON. Some rows contain nested JSON encoded as strings, such as:

- `characters.data` — full CharacterData V2 JSON string.
- `chats.characterIds` — JSON string array.
- `chats.metadata` — JSON string object.
- `messages.extra` — JSON string object.
- many lorebook entry filter fields — JSON string arrays/objects.

Directly editing table files while the server is running can be overwritten or ignored unless the live store is flushed, locked, validated, and reloaded. Because Professor Mari runs from the UI, `mari db` should be server-bound and use a managed endpoint for all normal reads and writes.

## High-Level Architecture

```text
Client UI
  Professor Mari workspace chat/panel
        │
        ▼
Server Mari runtime
  Pi SDK AgentSession
  - full shell/file tools after workspace mode is enabled
  - Marinara skill loaded
  - Marinara LLM adapter using existing app connections
  - cwd = selected workspace/root
        │
        ├── raw Pi tools
        │     read / grep / find / ls / edit / write / bash
        │
        └── shell command
              mari db ...
                    │
                    └── local privileged server API/socket
                          │
                          ▼
                    live file-native DB / storage services
```

Mari is still free to run arbitrary commands. The `mari db` CLI is a safer, better default for data operations.

## Runtime Model

### One Agent Session

The app creates one Pi `AgentSession` for Professor Mari. The session should be configured with:

- selected workspace `cwd`
- file tools: `read`, `grep`, `find`, `ls`, `edit`, `write`
- shell tool: `bash` enabled as part of workspace mode; no separate shell toggle
- a Marinara skill or prompt package
- a Marinara-owned LLM adapter backed by existing app connections
- `mari` CLI available in `PATH` or via a stable command wrapper

Conceptual SDK configuration:

```ts
const { session } = await createAgentSession({
  cwd: marinaraWorkspaceRoot,
  model: marinaraConnectionModel,
  tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
  sessionManager: SessionManager.inMemory(marinaraWorkspaceRoot),
  // Auth/model registry should be in-memory or adapter-backed; users should not
  // configure separate Pi provider credentials for Professor Mari.
});
```

### LLM and Connection Integration

Professor Mari's workspace runtime must use Marinara Engine's existing LLM configuration path. Pi provides the agent loop, transcript mechanics, and tools; Marinara provides provider selection, API credentials, base URLs, model IDs, and request execution.

Current code already has the needed pieces:

- `packages/client/src/components/chat/HomeProfessorMariChat.tsx` selects a language connection for Professor Mari and calls generation with that `connectionId`.
- `packages/server/src/services/storage/connections.storage.ts` stores connections and decrypts API keys through `getWithKey`.
- `packages/server/src/routes/generate/generate-route-utils.ts` resolves provider default base URLs through `resolveBaseUrl`.
- `packages/server/src/services/llm/provider-registry.ts` creates providers through `createLLMProvider`.
- `packages/server/src/services/llm/base-provider.ts` defines the shared `BaseLLMProvider` interface (`chat`, `chatComplete`, streaming, tools, abort signals, usage).

Implementation requirements:

- Do not require `/login` or separate Pi provider credentials for Professor Mari.
- Do not make users duplicate API keys into Pi settings, Pi auth storage, or Pi model registries.
- The browser sends chat/control messages to Marinara only. Provider credentials stay server-side.
- The server resolves Professor Mari's active language connection using existing `api_connections` rows.
- The default connection resolution should preserve the current Home Professor Mari behavior: explicit Professor Mari/workspace connection selection first, then the app default language connection, then the first available language connection. `image_generation` connections are excluded.
- The resolved connection is loaded with `connections.getWithKey`, then passed through `resolveBaseUrl` and `createLLMProvider`.
- Connection settings such as provider, model, base URL, encrypted API key, max context, max token override, provider routing, caching flags, custom request parameters, and provider-specific sentinels must behave the same as normal Marinara generation.
- If the user switches the Professor Mari connection, the runtime should update or recreate the adapter/model without requiring separate Pi configuration.
- UI should display the real Marinara connection name/provider/model being used, not a generic Pi model label.

Recommended adapter shape:

```text
Pi AgentSession
  synthetic model: marinara/current-connection
        │
        ▼
Marinara Pi model/provider adapter
  - maps Pi messages/tool schemas to Marinara ChatMessage/ChatOptions
  - streams text/thinking/tool-call events back to Pi
  - forwards AbortSignal from Pi stop button to provider call
  - reports usage/cost metadata when available
        │
        ▼
Existing Marinara provider stack
  createConnectionsStorage(db).getWithKey(connectionId)
  resolveBaseUrl(connection)
  createLLMProvider(provider, baseUrl, apiKey, ...)
  BaseLLMProvider.chat / chatComplete
```

The adapter should reuse provider-level logic, not the full `/api/generate` route. `/api/generate` includes chat-mode prompt assembly, roleplay/game behavior, and persistence side effects that are not appropriate for Pi's workspace-agent loop. Shared connection/provider helpers should be factored out where necessary so Professor Mari and `/api/generate` use the same LLM transport implementation without duplicating provider code.

Provider/tool requirements:

- Support streaming text deltas so the UI can show Mari working.
- Support provider-native thinking/reasoning deltas when Marinara's provider exposes them and the selected connection/model enables them.
- Support tool/function calling because Pi's agent loop depends on model-requested tool calls.
- Pass abort signals through to the provider request.
- Respect Marinara's provider URL safety policy for LLM calls.
- Redact API keys, auth headers, cookies, and provider tokens from logs.
- Record provider/model/usage metadata in the visible Professor Mari transcript or command log where practical.

Transcript ownership:

- The user-visible transcript should remain in Marinara's chat/message UI so Professor Mari feels native to the app.
- Pi session state may be in-memory or mirrored, but it must not become a separate user-facing conversation history that diverges from Marinara's Professor Mari chat.
- Tool calls, approvals, command summaries, and mutation journals should be surfaced in the same Professor Mari workspace UI around that transcript.

### Marinara Skill

A Pi skill should teach Mari:

- Marinara storage layout.
- How to locate `DATA_DIR`.
- When to prefer `mari db` over raw table edits.
- How to inspect, transform, validate, and apply changes.
- How to create/edit extensions, themes, scripts, and project files.
- How to avoid database mutations without dry-run/diff and explicit user approval first.

The skill is guidance, not a sandbox. The agent still has full tool access for normal workspace files. However, database/storage mutation approval is an application invariant: writes to `DATA_DIR/storage` should be routed through `mari db` or `mari storage tx`, not raw file tools.

## `mari db` CLI Design

`mari db` should be a generic, shell-native control surface over Marinara data.

Design principles:

1. **Generic first**: every file-backed table can be listed, inspected, selected, inserted, updated, deleted, transformed, and validated.
2. **Entity lenses second**: convenience commands for characters/lorebooks/chats/personas can be added without blocking generic coverage.
3. **Scriptable**: Mari can write arbitrary JS/bash transforms and run them through the CLI.
4. **Streaming output**: use JSONL and limits for large libraries.
5. **Dry-run by default for all mutation operations**.
6. **Approval required for DB changes**: any insert, patch, replace, delete, transform, storage transaction, or other persistent database mutation must receive explicit browser-side user approval before the server applies it.
7. **Server-bound**: all normal reads and writes go through the running server; `mari db` is not an offline table editor.
8. **No mandatory full copies**: operation journals and touched-row snapshots are acceptable; whole-library duplication is not required.

## Command Surface

### Discovery

```sh
mari db status
mari db tables
mari db schema <table> [--json]
mari db counts
mari db data-dir
mari db now
mari db new-id
```

Examples:

```sh
mari db tables
mari db schema characters --json
mari db counts
```

### Read and Search

```sh
mari db list <table> [--limit N] [--offset N] [--jsonl]
mari db get <table> <id> [--raw | --parsed]
mari db select <table> --where <expr> [--jsonl]
mari db search <table|all> <query> [--limit N] [--jsonl]
mari db jq <table> <jq-filter> [--raw | --parsed]
```

`--raw` returns rows as stored in table snapshots.  
`--parsed` decodes known JSON-string columns into objects/arrays.

Examples:

```sh
mari db search characters "vampire librarian"
mari db get characters char_abc123 --parsed
mari db select lorebooks --where 'row.name.includes("Luna")' --jsonl
mari db jq characters '.[] | select(.data.name == "Luna") | .data.description' --parsed
```

### Insert, Patch, Replace, Delete

```sh
mari db insert <table> (--json '<row-json>' | --json-file <path>) [--apply]
mari db patch <table> <id> (--json '<partial-row-json>' | --json-file <path>) [--apply]
mari db replace <table> <id> (--json '<full-row-json>' | --json-file <path>) [--apply]
mari db delete <table> <id> [--cascade] [--apply]
mari db delete <table> --where <expr> [--cascade] [--apply]
```

Without `--apply`, these commands produce a dry-run summary and diff. With `--apply`, the CLI signals intent to mutate data, but the server must still request browser-side user approval before committing the change.

Examples:

```sh
mari db patch characters char_abc123 --json '{"data":{"description":"New description"}}'
mari db patch characters char_abc123 --json '{"data":{"description":"New description"}}' --apply
mari db insert characters --json-file /tmp/new-character.json
mari db insert characters --json-file /tmp/new-character.json --apply

mari db delete lorebooks --where 'row.name.startsWith("Old Test")' --cascade
mari db delete lorebooks --where 'row.name.startsWith("Old Test")' --cascade --apply
```

### Bulk Transform

```sh
mari db transform <table|all> <script.mjs> [--dry-run] [--apply] [--reason <text>]
```

Transform scripts should receive parsed rows by default and return an operation.

Example script:

```js
// /tmp/replace-phrase.mjs
export default function transform(row, ctx) {
  if (ctx.table !== "characters") return null;
  const card = row.data;
  if (!card?.description?.includes("old phrase")) return null;

  card.description = card.description.replaceAll("old phrase", "new phrase");
  return { ...row, data: card };
}
```

Run it:

```sh
mari db transform characters /tmp/replace-phrase.mjs --dry-run
mari db transform characters /tmp/replace-phrase.mjs --apply --reason "Bulk phrase cleanup"
# Server prompts the UI for approval before applying.
```

Supported transform returns:

```ts
type TransformResult =
  | null                         // no change
  | false                        // no change
  | ParsedRow                    // replace row
  | { update: Partial<ParsedRow> } // merge patch
  | { delete: true }             // delete row
  | { insert: ParsedRow | ParsedRow[] };
```

Transform context:

```ts
type TransformContext = {
  table: string;
  now: string;
  newId(): string;
  raw(row: ParsedRow): RawRow;
  parse(row: RawRow): ParsedRow;
  find(table: string, predicate: (row: ParsedRow) => boolean): ParsedRow[];
};
```

### Entity Lenses

Optional helper commands can make common workflows easier without limiting raw control.

```sh
mari db character get <name-or-id>
mari db character patch <name-or-id> --json '<partial-card-json>' [--apply]
mari db lorebook create --name <name> [--for-character <name-or-id>] [--entries <json-file>] [--apply]
mari db chat grep <query> [--chat <name-or-id>]
mari db persona get <name-or-id>
```

These should be wrappers over generic table operations.

## Server-Managed Database Access

Because Professor Mari is launched from the running UI, `mari db` should be server-bound rather than an offline repair CLI. The CLI should talk to a local privileged API/socket inside the same Node process. If it cannot reach that endpoint, it should fail closed with a clear message to start or reopen Marinara instead of writing directly to `DATA_DIR/storage`.

Benefits:

- reads current in-memory state
- avoids lost writes from autosave races
- can create character version snapshots
- can reuse existing storage services
- can enforce cascades/defaults
- can flush after successful operations
- can emit cache invalidation events to connected clients

### CLI Endpoint Authentication

`mari db` should reuse Marinara's existing privileged access model instead of minting a separate workspace token. The server-side Mari runtime launches the CLI locally, and the browser only sends chat/control messages to the server.

Implementation requirements:

- Protect `mari db` endpoints with the existing privileged gate (`requirePrivilegedAccess`).
- Use `ADMIN_SECRET` / `X-Admin-Secret` when an admin secret is configured or required.
- Keep the endpoint loopback-only by default unless the maintainer explicitly allows remote privileged access.
- If `ADMIN_SECRET` is not configured and loopback privileged access is allowed by current runtime config, local CLI calls may use that existing loopback trust path.
- Do not expose `ADMIN_SECRET` to the browser. The server may inject it into the server-owned Mari/CLI process environment or call an in-process command wrapper.
- Authentication only proves that the request came from the trusted local/server-side runtime. It does not approve mutations; DB/storage changes still require browser approval.

Server-managed write flow:

1. CLI sends operation to local privileged endpoint/socket.
2. Server acquires storage write lock.
3. Server evaluates operation against current in-memory tables.
4. Server builds diff, blocking validation result, and Mari-only optional notices.
5. If dry-run, returns the diff and notices to Mari.
6. If blocking validation fails, returns the failure to Mari and does not show a user approval prompt.
7. If apply was requested and blocking validation passed, server creates a pending approval request containing the command, operation summary, diff, blocking validation status, affected tables/rows, cascades, journal preview, and an operation hash.
8. UI displays the pending approval to the user and offers Approve/Reject.
9. If rejected or timed out, server returns a cancelled result and performs no mutation.
10. If approved, server verifies that the approved operation hash still matches current state. If state changed, the operation is cancelled and Mari must rerun the dry-run.
11. Server writes through storage/file-native DB.
12. Server creates domain snapshots where appropriate.
13. Server validates affected tables/relations; any blocking failure rolls back the operation.
14. Server writes the operation journal.
15. Server flushes dirty tables.
16. Server emits frontend invalidation/event notifications.

### Mutation Approval Contract

Read-only commands (`status`, `tables`, `schema`, `counts`, `list`, `get`, `select`, `search`, `jq`, `validate`) do not need approval. Any persistent DB/storage mutation does, including:

- `insert`, `patch`, `replace`, `delete`
- `transform --apply`
- entity-lens writes such as `character patch` or `lorebook create`
- revert-from-journal writes
- raw storage transactions through `mari storage tx`
- any future command that changes table rows, storage manifests, snapshots, journals, or DB-owned media references

Implementation requirements:

- `--apply` means “request approval and apply if approved,” not “commit immediately.”
- The server owns the pending-approval registry; the CLI waits for approval, rejection, timeout, or abort.
- Each approval is one-time-use and bound to the session id, command text, normalized operation payload, operation hash, and affected row/table set.
- Approval must happen in the browser UI, not in model text.
- If the user closes the UI, aborts the Pi session, or the approval times out, the operation is rejected.
- The server should reject mutation endpoints that do not carry a valid pending approval token/result.
- The UI should preserve an audit record of approved/rejected mutations alongside command logs and expose approved mutation journals in a visible change history.

### Raw Storage Transaction Mode

For advanced repair, Mari may still need raw shell edits over table files. This is not an offline mode; it is a server-coordinated escape hatch that flushes, locks, validates, and hot-reloads storage while the UI/server is running. Because it can mutate storage outside normal table operations, it also requires explicit browser-side user approval before the wrapped command starts.

Raw storage transactions are allowed only for storage scopes that the server can hot-reload safely. If a proposed or detected change cannot be hot-reloaded into the running in-memory store, the command must be rejected or rolled back; Mari should not be allowed to make that change through raw storage editing.

Provide a wrapper:

```sh
mari storage tx -- <command...>
```

Transaction flow:

1. Build an approval request from the wrapped command and declared storage scope.
2. Verify the declared scope is hot-reloadable before approval is shown.
3. Wait for browser approval.
4. If approved, flush live storage.
5. Acquire storage lock.
6. Snapshot the declared touched files/tables for rollback.
7. Run the user command with `DATA_DIR` exported.
8. Detect changed storage files.
9. If any changed file is outside the declared scope or cannot be hot-reloaded safely, restore the snapshots, validate, release the lock, and return a rejected result.
10. Validate changed tables; blocking failures restore the snapshots and reject the result, while optional notices are returned to Mari only.
11. Hot-reload changed tables/files into the running in-memory store.
12. Emit cache invalidation events to connected clients.
13. Journal changed files/tables.
14. Release lock.

### Storage Write Guard

Because workspace mode includes `bash`, the implementation must guard DB-owned paths. The intent is not to restrict normal shell work; it is to preserve the approval invariant for user data.

Required behavior:

- `read`, `grep`, `find`, `ls`, and dry-run `bash` inspection may read `DATA_DIR/storage`.
- Raw `edit`/`write` calls targeting `DATA_DIR/storage`, table snapshots, manifests, journals, or DB-owned table files should be blocked and redirected to `mari db` or `mari storage tx`.
- Shell commands that intend to mutate `DATA_DIR/storage` should use `mari storage tx -- <command...>` so the transaction is approved, locked, validated, hot-reloaded, and journaled.
- The UI should warn when a shell command references storage paths outside `mari db`/`mari storage tx`.
- If an unapproved external process changes storage files while the server is running, validation should detect the drift and require explicit repair/hot-reload approval rather than silently accepting it.
- If hot reload is not available for a storage path, Mari must use managed `mari db`/server APIs instead of raw storage edits.

This is still not a general-purpose OS sandbox. It is an application-level guardrail for Marinara-owned DB/storage paths.

Example:

```sh
mari storage tx -- node ./scripts/custom-storage-repair.mjs
```

## Validation

`mari db validate` should be available whenever the workspace agent/server is running.

```sh
mari db validate [--table <table>] [--strict] [--json]
```

Validation should check required invariants and optional consistency notices.

Required invariant failures are blocking errors. They must prevent `--apply`, raw transaction commit, hot reload, and journaled mutation success. Blocking checks include:

- table files parse as JSON arrays
- manifest exists and table counts match when relevant to the touched scope
- primary keys are present and unique
- required columns exist
- known JSON-string columns parse
- known enum fields use valid values
- references are not dangling where cascades imply ownership
- character cards parse as CharacterData
- lorebook entry arrays/objects parse when required by schema
- chat `characterIds` and `metadata` parse
- message swipe indexes are coherent per message where required for correct rendering

Optional issues are non-blocking notices. They should be returned to Mari/tool output for reasoning and cleanup suggestions, not shown in the user approval prompt by default. Optional notices include:

- missing gallery/asset/media files for optional paths
- missing optional avatar/sprite/image paths when the app has a safe autogenerated or default fallback
- unknown legacy metadata fields
- missing optional associations that the app can ignore safely
- stale disabled-folder references when rows still render safely
- cleanup opportunities that do not affect load/save correctness

Validation output should distinguish:

- `error` — blocking invariant failure; unsafe to apply
- `notice` — optional issue for Mari; operation may proceed
- `info` — non-actionable context or cleanup opportunity

User-facing approval prompts should show only blocking validation status (`passed` or `blocked`). Optional notices remain in the CLI/tool output and detailed logs for Mari.

## Snapshots, Journals, and No-Copy Rule

The system should not require copying the whole library before every operation. Instead:

- For character card updates, create normal `character_card_versions` snapshots.
- For generic row changes, write an operation journal containing touched rows before/after.
- For deletes, journal deleted rows and cascaded children.
- For large bulk operations, stream the journal as JSONL.
- Journals must be user-visible in the UI as Professor Mari's database change history.
- Whole-table backup can be an explicit user option, not the default.

Suggested journal location:

```text
DATA_DIR/storage/journal/
  2026-06-09T12-34-56_mari-db_<operation-id>.jsonl
```

Each journal entry:

```json
{
  "operationId": "...",
  "table": "characters",
  "id": "char_abc123",
  "action": "update",
  "before": { "...": "..." },
  "after": { "...": "..." },
  "reason": "Bulk phrase cleanup",
  "createdAt": "..."
}
```

The UI should list approved and rejected mutation attempts with:

- timestamp
- command
- approval status
- reason/comment when available
- affected tables and row counts
- validation result
- journal path or operation id
- expandable before/after diff for affected rows, with sensible limits for large operations

## Security and Trust Boundary

Even though Marinara is a local Node app, a shell-capable browser-triggered agent is highly privileged.

Required safeguards:

- Workspace agent must be explicitly enabled by the user.
- Enabling workspace mode must clearly state that shell command access is included; no separate `bash` toggle is required.
- UI must display current workspace path and enabled tools.
- Shell access should be visibly marked as enabled.
- Any persistent DB/storage mutation initiated by Mari must show a browser approval prompt before commit.
- Approval prompts should show the command, affected tables/rows, diff summary, blocking validation status, operation hash, and whether snapshots/journals will be created. Optional validation notices should go to Mari/tool output, not the user prompt.
- The workspace runtime must guard `DATA_DIR/storage` writes so raw file/shell tools cannot silently bypass DB mutation approval.
- Privileged routes/sockets must use the existing `requirePrivilegedAccess` / `ADMIN_SECRET` model and must not be exposed to unauthenticated LAN clients.
- If remote access is enabled, workspace agent access should follow the existing Basic Auth/admin-secret privileged-access model or be disabled by default.
- The UI needs an emergency stop button wired to Pi session abort.
- Logs should record shell commands and `mari db` operations.

This is not a sandbox. The product copy should say so clearly.

## User Presentation

Present this as one capable local assistant:

> Professor Mari can operate directly on your local Marinara workspace. She uses your existing Marinara language connections, shell and file tools, creates extensions, inspects source files, and uses `mari db` to search and edit your live app data without copying your whole library.

The UI should show a persistent status strip:

```text
Professor Mari Workspace
Workspace: /path/to/Marinara-Engine
Data: /path/to/data
Tools: read, grep, find, ls, edit, write, bash
LLM: My Claude Connection / claude-sonnet-4-5
DB access: server-managed mode
```

When Mari performs read-only or dry-run storage operations, show concise summaries:

```text
mari db transform characters /tmp/fix.mjs --dry-run
Matched: 17 rows
Would update: 12 rows
Would delete: 0 rows
Validation: passed
```

When a mutation is requested, show an approval prompt before committing it:

```text
Professor Mari wants to apply a database change
Command: mari db transform characters /tmp/fix.mjs --apply
Affected: 12 character rows
Validation: passed
Journal: will be created

[Reject] [Approve]
```

If she uses raw `edit`/`bash` against storage files directly, show a stronger warning:

```text
Raw storage file edit detected. This bypasses managed snapshots and live reload unless wrapped in mari storage tx.
```

## Example Workflows

### Bulk Replace Across Character Cards

```sh
cat > /tmp/replace-title.mjs <<'JS'
export default function transform(row) {
  const card = row.data;
  let changed = false;
  for (const field of ["description", "personality", "scenario", "first_mes"]) {
    if (typeof card[field] === "string" && card[field].includes("Old Kingdom")) {
      card[field] = card[field].replaceAll("Old Kingdom", "Ebon Crown");
      changed = true;
    }
  }
  return changed ? { ...row, data: card } : null;
}
JS

mari db transform characters /tmp/replace-title.mjs --dry-run
mari db transform characters /tmp/replace-title.mjs --apply --reason "Rename setting across character cards"
```

### Delete Generated Test Lorebooks

```sh
mari db delete lorebooks --where 'row.name.startsWith("Test Lorebook")' --cascade --dry-run
mari db delete lorebooks --where 'row.name.startsWith("Test Lorebook")' --cascade --apply
mari db validate --table lorebooks
```

### Create a Character Lorebook with Entries

High-level wrapper:

```sh
mari db lorebook create \
  --name "Luna Lore" \
  --for-character "Luna" \
  --entries ./luna-lore-entries.json \
  --apply
```

Generic equivalent:

```sh
char_id=$(mari db search characters "Luna" --jsonl | head -n1 | jq -r '.id')
book_id=$(mari db new-id)
now=$(mari db now)

mari db insert lorebooks --json "{
  \"id\": \"$book_id\",
  \"name\": \"Luna Lore\",
  \"description\": \"Character lorebook for Luna\",
  \"category\": \"character\",
  \"enabled\": \"true\",
  \"createdAt\": \"$now\",
  \"updatedAt\": \"$now\"
}" --apply

mari db insert lorebook_character_links --json "{
  \"id\": \"$(mari db new-id)\",
  \"lorebookId\": \"$book_id\",
  \"characterId\": \"$char_id\",
  \"createdAt\": \"$now\"
}" --apply
```

### Extension Development

For extension/source work, Mari can use normal file tools:

```sh
find . -maxdepth 3 -type d -name extensions
mkdir -p .pi/extensions/my-extension
cat > .pi/extensions/my-extension/index.ts <<'TS'
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello-marinara", {
    description: "Test command",
    handler: async (_args, ctx) => ctx.ui.notify("Hello from Marinara", "info"),
  });
}
TS
```

`mari db` is not involved unless the extension also needs to inspect or modify user data.

## MVP Scope

1. Add a Pi-powered Professor Mari workspace runtime behind an explicit setting.
2. Add a Marinara LLM adapter so Pi uses existing Marinara language connections/provider code instead of separate Pi auth or model config.
3. Add a Marinara skill for Pi with storage and extension guidance.
4. Ship `mari db` with:
   - `status`, `tables`, `schema`, `counts`, `data-dir`, `now`, `new-id`
   - `list`, `get`, `search`, `select`
   - `insert`, `patch`, `replace`, `delete`
   - `transform`
   - `validate`
5. Make `mari db` work through the server-managed privileged endpoint/socket using existing `ADMIN_SECRET`/privileged-access authentication.
6. Add dry-run/diff output for writes.
7. Add browser-side approval gating for every DB/storage mutation before commit.
8. Add touched-row operation journals.
9. Add a visible UI change history for approved/rejected mutation attempts and approved operation journals.
10. Add UI display for workspace path, selected LLM connection/model, tool set, command activity, pending approvals, and stop button.

## Later Phases

- Entity lens wrappers for common workflows.
- `mari storage tx` for raw table repair after safe hot-reload support exists.
- UI diff viewer for `mari db` dry-runs.
- Revert-from-journal command and one-click UI undo.
- Fine-grained relation validators.
- Optional future storage layout with domain-native entity files, such as `characters/<id>/card.json` and `chats/<id>/messages.jsonl`.

## Core Design Decision

Professor Mari remains one agent with full local power. The system does not restrict her to prebuilt app tools. Instead, Marinara gives her a well-documented, shell-native database control surface so she can use bash creatively while preserving the live app’s storage invariants whenever possible.
