# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Meowtrack is a local, single-machine issue tracker for the Meownopoly project. It ships **two front doors over a per-machine registry DB plus one tracking database per repo**: an MCP server (stdio) for use from Claude Code, and an HTTP dashboard (vanilla-JS SPA) for manual use. File/folder references on issues are anchored to **cloned git repos** and validated against them. The codebase, README, and comments are in **French** — match that when editing.

## Commands

```bash
npm install                       # deps: @modelcontextprotocol/sdk, better-sqlite3, dotenv, zod
npm run dashboard                 # = node server.js  → http://127.0.0.1:7702 (localhost only)
npm run mcp                       # = node mcp.js      (stdio MCP server, normally launched by the host)
node test/parse_ai_turn.test.mjs  # regression test for parseAiTurn (AI action parsing)
node test/ghost_payload.test.mjs   # regression test for ghostPayloadFromAction
./deploy.sh                       # SCP + npm install + systemctl restart (reads gitignored .deployEnv)
./install-service.sh              # one-shot: create+enable the systemd unit (run on the server)
```

The MCP server and dashboard share the DB and run **simultaneously** (SQLite WAL → concurrent reads). Restart Claude Code after `npm install` so it reloads `mcp.js` (registered in the repo-root `.mcp.json`).

## Architecture

**One data layer, two transports.** The data layer is `better-sqlite3` (synchronous), split into focused modules under `db/` behind a **barrel `db.js`** that re-exports the public API (so importers — `server.js`, `repos.js`, tests — are unchanged): `db/connection.js` (registry connection + lazy per-repo `tracker.db` pool + the ambient `db` proxy + `withRepo` + schema), `db/registry.js` (repos registry CRUD + `app_settings` + `resolveRepoId`), `db/migrations.js` (bootstrap + one-shot migrations, run via `initDb()` from the barrel), `db/issues.js`, `db/nodes.js` (tree + AI action application), `db/messages.js` (chats), plus leaf `db/constants.js` / `db/helpers.js`. It holds **a central registry connection** (`meowtrack.db` — only the `repos` registry + `app_settings`, per-machine) and **a lazy pool of per-repo `tracker.db` connections** (issues/refs/comments/nodes/messages, one SQLite file per repo under `.trackers/<slug>/`). Tracking queries go through an ambient `db` proxy routed by `withRepo(repoId, …)` — set once at each public entrypoint, so the query bodies stay repo-agnostic; `null` → default repo. An existing single-file DB is split into per-repo trackers on first boot (`splitLegacyToTrackers`, data-preserving). Both `mcp.js` (MCP tools) and the HTTP server are thin transport adapters that call into the data layer — put data logic under `db/`, not in the transports.

**The HTTP server is split too.** `server.js` is now a thin entry point (env, token gate, static, MCP dispatch, the route chain, bootstrap). Cohesive subsystems are extracted: `http-util.js` (`send`/`readBody`/static/`repoOf`), `sse.js` (real-time broadcaster), `github.js` (GitHub device-flow client), `mcp-endpoint.js`, the AI pipeline under `ai/` (`parse.js` fail-closed parsing, `prompts.js`, `claude.js` CLI, `turns.js` chat handlers + AI concurrency), `config.js` (config + AI sandbox policy), and one route module per domain under `routes/` (`repos`, `git`, `github`, `issues`, `nodes`). Each route module exports `handle(ctx)` returning `true` if it handled the request. `server.js` re-exports `parseAiTurn`/`ghostPayloadFromAction` (from `ai/parse.js`) for the tests.

**Optional git-versioned tracking (`MEOWTRACK_TRACKING_GIT=1`, off by default).** Each repo's `tracker.db` can be versioned in an **orphan `tracking` branch** checked out in a dedicated worktree (`.trackers/<slug>/`) — no shared history with code, code branches never touched (Option B). A periodic committer (in `repos.js`) checkpoints the WAL and commits changes; a final commit runs on exit; push is opt-in (`MEOWTRACK_TRACKING_PUSH=1`). On boot, the worktree restores `tracker.db` from the branch (cross-machine sync). All best-effort: git failures never break the app, and fall back to a plain `.trackers/<slug>/` dir.

**Two domains live in the same DB:**
- **Issues** (`BUG-1`, `FEAT-2`…): bug/feature/task/chore tracker with file/folder *references*, comments, tags, captured branch/commit. Exposed via MCP tools (`meowtrack_create/list/get/update/...`) and `/api/issues`.
- **Nodes** ("Vibes", `NODE-1`…): a recursive tree of goals/milestones with per-node AI chat. One node type at any depth; progress is the recursive average of children. Exposed via `/api/nodes/*` and `meowtrack_node_*` tools.

**Multi-repo is pervasive.** A `repos` registry table scopes **every issue and node** to a repo; refs are numbered **per repo** (`(repo_id, ref)` unique, one counter each). Almost every MCP tool and HTTP route takes `repo` / `?repo=` (slug or id); omitted → the `is_default` repo (or `MEOWTRACK_DEFAULT_REPO` on the MCP side). An old single-repo DB is auto-migrated on startup (`migrateLegacyMultiRepo` in `db/migrations.js`) — preserve that path when touching the schema.

**Git access is read-only and layered:**
- `repo.js` = low-level git primitives (`git ls-files`/`ls-tree`/`rev-parse`, clone, pull). It **never writes** to a repo. Path validation normalizes to repo-relative and rejects anything outside the resolved git root (anti path-traversal) — this guard backs the `@`-mention autocomplete and reference `existed` flags.
- `repos.js` = per-repo clone resolution (clone under `meowtrack/.repos/<slug>/` or use a `local_path`), memoized path index per `(repo, branch)`, and `ensureAllRepos()` (clone-or-pull every repo on startup). Branch trees are read via `git ls-tree <branch>` — **no checkout needed**, all known branches served from one clone.

**Node hierarchy uses a materialized `path`** (`/1/4/9/`), so subtree / ancestors / scope checks are plain SQL (no recursive CTEs). Concurrency is optimistic: `nodes.version` is a monotonic integer bumped on the node **and all its ancestors** on every mutation; PATCH with a stale `expectedVersion` → `409`. `node_messages.id` is the total chat order.

**Prerequisite links (`node_links`, additive — a node can serve several parents).** Besides the single-parent tree, nodes carry **out-of-hierarchy "requires" edges** (`from_id` depends on `to_id`, `kind='requires'`): the shared *network brick* lives once and both *chat* and *multiplayer* point at it. These are **purely relational** — they do **not** touch `path`/`depth`/`progress` (no double-counting); they only drive a **"blocked" signal** (a node is blocked while any prerequisite isn't `done`). Both ends are same-repo by construction (one tracker DB per repo); guarded against self-link, **cycles**, and a per-node cap; `UNIQUE(from_id,to_id,kind)` makes adds idempotent; `ON DELETE CASCADE` purges links with the node. Data layer in `db/nodes.js` (`addNodeLink`/`removeNodeLink`/`listNodeLinks`/`listForestLinks`); routes are the collection `GET/POST/DELETE /api/nodes/links` (placed **before** the `/:ref` regex); mutations broadcast `links:changed`. The AI action catalog is **unchanged** — links are a manual feature only.

**Real-time sync (`sse.js`):** Server-Sent Events, zero deps. Rooms `node:<id>` (chat + stream + node state) and `forest:<repoId>` (whole tree for graph/grid; repos never hear each other's events). Deep changes ring `subtree:dirty` up the ancestor chain so the detail view re-fetches (self-correcting). Stream auth via `?token=`.

### AI integration (`ai/`) — security-critical

Two features shell out to the `claude` CLI via `spawn`/`execFile` (**never a shell**), gated by `MEOWTRACK_CLAUDE_BIN`. The pipeline lives under `ai/`: `parse.js` (parsing), `prompts.js` (prompt building), `claude.js` (CLI spawn/stream), `turns.js` (chat orchestration + handlers); the sandbox policy is in `config.js`.

- **Per-node chat** streams `claude -p --output-format stream-json`, parsed live. `parseAiTurn` (`ai/parse.js`) separates conversational text from a **closed catalog** of structured actions (`set_node_fields`, `add_node`, `update_node`, `delete_node`, `move_node`, `reorder_children`). It is **fail-closed**: on any doubt, zero actions and show text verbatim — never guess a mutation. The test exists to lock this in. Every action is checked `isInSubtree(scopeNode, target)` (strict scope via the materialized path), capped at 20/turn; destructive actions require human confirmation (`/chat/confirm`); a chat can never delete its own scope root.
- **"Améliorer (IA)"** on issues (`improveDescriptionWithClaude`, `ai/claude.js`) rewrites description text with **no tools at all**.

Chat read access to source (`MEOWTRACK_AI_REPO_ACCESS=1`, default) is sandboxed: `--allowedTools Read Glob Grep`, everything else denied (deny wins), env stripped of the token, and `--settings` denies `.env`/keys/`*.db`/`.git`. Preserve these constraints when modifying AI code paths.

### Front-end

`dashboard/` is a static vanilla-JS SPA served by the HTTP server. **No build step, no framework** — native ES modules loaded via `<script type="module" src="dashboard.js">`. `dashboard.js` is a tiny entry that loads the modules and registers the `DOMContentLoaded` initialisers; the code is split by the three UI blocks: `core.js` (shared `$`/`esc`/`api`/token/repo helpers), `issues.js` (Suivi + the shared `@`-mention autocomplete), `vibes.js` (Vibes nodes/graph/chat + `toast`/context-menu), `repo.js` (git manager). Cross-block sharing is via explicit `import`/`export`; the few circular edges (issues↔vibes↔repo) are safe (used only inside function bodies). `serveStatic` (`http-util.js`) serves any single-segment `*.js`/`*.css` under `dashboard/` (anti-traversal). The graph view is hand-rolled SVG built via DOM API (anti-XSS — no `innerHTML` of user data). All DB writes go through the HTTP API; the front reconciles node state by `version`.

## Configuration & conventions

- Config via `dotenv` (`.env`, see `.env.example`). Key vars: `MEOWTRACK_HOST` (`127.0.0.1`; `0.0.0.0` to expose), `MEOWTRACK_PORT` (`7702`), `MEOWTRACK_TOKEN` (when set, `/api/*` requires `Authorization: Bearer` — **mandatory in deployment**), `MEOWTRACK_DB`, `MEOWTRACK_REPO_URL`/`MEOWTRACK_REPO` (default-repo bootstrap only).
- `MEOWTRACK_NO_LISTEN=1` imports `server.js` (handlers, `parseAiTurn`) **without** starting the HTTP listener — used by the test.
- The registry DB (`meowtrack.db*`) and the per-repo trackers (`.trackers/`) are **gitignored and per-machine**; `node_modules/`, `.env`, `.deployEnv`, and the DBs are never copied by `deploy.sh` (prod data/config preserved). When `MEOWTRACK_TRACKING_GIT=1`, each `.trackers/<slug>/` is a git worktree whose `tracker.db` is versioned in that repo's own `tracking` branch (not in the meowtrack code repo).
- The README documents the full data model, every endpoint, and the deploy flow in detail — consult it before changing schema, routes, or deployment.
