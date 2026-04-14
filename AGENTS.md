# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Codex App Server (Important)

T3 Code is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Pedro Fork Context

This fork is being used as a Codex-compatible client, not just as a generic T3 install.

### Goal

The practical requirement for this fork is:

- local desktop use through Codex and/or T3
- remote browser access from a phone over WireGuard
- continuity of the same Codex threads/sessions across clients

The important constraint is that the phone/browser experience must follow the same Codex conversation base used on the laptop. This is why the fork contains a Codex desktop session sync layer instead of relying only on native T3 thread creation.

### Why the Codex Desktop Sync Layer Exists

Upstream T3 can spawn and resume Codex sessions, but it does not import existing desktop Codex threads from `~/.codex` into T3's read model. That gap matters for this setup because the user actively works in the Codex desktop app and then expects to continue those same threads remotely in T3.

The sync layer in `apps/server/src/codexDesktopSessionSync.ts` exists to:

- read Codex desktop session metadata from `~/.codex/session_index.jsonl`
- read Codex session rollout files from `~/.codex/sessions/**`
- project those threads/messages/activities into T3 persistence
- keep imported threads refreshed as Codex changes them externally
- append T3-driven updates back into the Codex session index so Codex can pick them back up later

This is the key fork-specific behavior. Do not remove or bypass it unless upstream grows a real equivalent that preserves the same workflow.

### Why the Desktop App Is the Runtime of Choice

This setup intentionally uses the T3 desktop app as the single always-on backend instead of running a separate standalone T3 server in parallel.

Reason:

- running both the desktop app and a separate standalone T3 backend against the same `T3CODE_HOME` caused state contention and SQLite/import issues
- the desktop app can already expose the backend over the network
- one backend process is simpler and more stable than two competing writers

Operational model:

- the desktop app is the single T3 backend
- remote access should be served from the desktop app
- do not reintroduce a second standalone T3 service against the same base directory unless the architecture changes deliberately

### Local Machine Assumptions

The repo code assumes the following local setup on Pedro's machine:

- T3 app state lives in `~/.t3-codex`
- Codex state lives in `~/.codex`
- desktop app remote exposure is enabled via `desktop-settings.json`
- a user `launchd` agent starts `T3 Code (Alpha)` at login with `T3CODE_HOME=~/.t3-codex`

Those machine-specific launchd/settings files are intentionally local-only and should not be committed as product code. Keep repo changes focused on sync/runtime behavior, not one user's workstation bootstrap.

### Sidebar Bug Context

The desktop sidebar bug fixed in this fork was not a missing snapshot problem. The top-level sidebar already had the correct grouped thread data, but individual project rows were re-querying per-project thread buckets and rendering `No threads yet` incorrectly.

The fix was to render each project row from the parent sidebar's canonical grouped thread map instead of doing a second independent lookup. If a similar regression reappears, inspect the row-level data source before touching the sync importer.

### Change Strategy

When updating this fork against upstream:

- keep Codex-specific behavior isolated
- prefer narrow adapters over broad rewrites
- avoid machine-local config in git
- test both the sync path and the desktop sidebar path after merges

If upstream eventually ships first-class support for importing and tracking desktop Codex threads, reassess whether the custom sync layer can be reduced or removed.
