# LAZY SQL engine

Local (stdio) MCP server + local HTTP API for running SQL against one or more databases, with a **review dialog** in front of every data-changing statement and a companion desktop app for configuration, logs and workspace MCP toggles.

Normally you never start this by hand: MCP clients spawn it over stdio, and the desktop app spawns it in daemon mode (`--serve`). Run it manually for development:

```powershell
npm install --workspaces=false
node src/index.js --serve            # daemon: local API only (no stdio)
node src/index.js                    # stdio MCP server (for ad-hoc testing)
npm run bundle                       # esbuild → dist/lazy-sql-engine.mjs (single file)
npm test                             # unit + smoke (spawns real server, seeds SQLite)
```

CLI flags: `--serve` (daemon mode), `--port <n>`, `--parent-pid <pid>` (self-terminate when the parent dies), `--label <text>` (shown in the app's live sessions).

## Tools

| Tool | What it does |
| --- | --- |
| `execute_sql` | Read-only statements run immediately; writes open the review surface and wait for approval. Two-phase resume with `reviewId`. |
| `get_db_objects` | List/describe database objects (columns, keys, indexes, definitions). |
| `open_db_config` | Request the connection manager in the desktop app (browser fallback). |

## Modules

| File | Responsibility |
| --- | --- |
| `src/index.js` | MCP stdio server + `--serve` daemon entry, tool handlers, review lifecycle |
| `src/executor.js` | pg / mysql2 / mssql / node:sqlite pools, RPC-style result sets, connection tests |
| `src/classify.js` | SQL tokenizer: statement splitting, read/write classification, quote-aware rewrites |
| `src/reviews.js` | Two-phase review sessions (create → decide → running → done/error), timeout-safe |
| `src/server.js` | Express API: connections, settings, logs, reviews, schema, instances, workspaces, transfer |
| `src/instances.js` | Session registry + heartbeat in `~/.lazy-sql/instances` (app discovery) |
| `src/workspaces.js` | Reads/writes MCP registrations for OpenCode / Claude Code / Kiro / Cursor (JSONC-safe) |
| `src/transfer.js` | Import/export config (skip/overwrite/rename, passwords opt-in) |
| `src/schema.js` | Table+column map for editor autocomplete |
| `src/exec-logs.js` | JSONL execution log with per-date queries and caps |
| `src/openBrowser.js` | Review-dialog spawning (desktop app in `--review` mode), app auto-detection, browser fallback |

## Environment

See the root README for the full table. Key ones: `LAZY_SQL_DATA_DIR` (default `~/.lazy-sql`), `LAZY_SQL_PORT` (4788), `LAZY_SQL_TOKEN`, `LAZY_SQL_ALLOWED_CONNECTIONS`, `LAZY_SQL_FORCE_READ_ONLY`, `LAZY_SQL_REVIEW_TIMEOUT_MS`, `LAZY_SQL_MAX_RESPONSE_CHARS`, `LAZY_SQL_NO_OPEN`. The pre-rename `SQL_CREW_*` names still work as a fallback.

## Fallback browser UI

When the desktop app is not installed (or opening windows is disabled for tests), reviews fall back to pages served by the engine itself (`/config`, `/history`, `/review/:id`) — a compact built-in UI so the approval flow keeps working without the app.
