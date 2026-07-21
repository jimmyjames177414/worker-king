# WorkerKing — Claude Code guide

WorkerKing is a Windows-native, Jarvis-style desktop assistant: a small animated companion that
floats on the desktop plus an expandable chat window. It talks with a swappable voice, thinks with
Claude Code (via the TypeScript Agent SDK, riding a Claude Pro/Max subscription), and discovers your
skills/commands/agents/MCP servers to route work to them.

TypeScript / Node ≥ 20 / Electron, **pnpm 10** monorepo (`pnpm@10.33.0`, see `packageManager`). Do
not use `npm` or `yarn`.

## Architecture — three processes, one localhost WebSocket bus

| Process               | Runtime                                | Role                                                                                    |
| --------------------- | -------------------------------------- | --------------------------------------------------------------------------------------- |
| Electron **main**     | Node (Electron)                        | windows, tray, global hotkey, secrets, spawns/supervises the daemon                     |
| Renderer: **overlay** | Chromium                               | avatar state machine + voice (mic/WebRTC)                                               |
| Renderer: **chat**    | Chromium                               | text chat, transcript, tasks, settings                                                  |
| Core **daemon**       | plain Node (**zero Electron imports**) | Claude Agent SDK, supervisor, tasks, capability manifest, config, memory, **WS server** |

The three UI processes reach the daemon over `localhost` WebSocket. Native-Windows vs WSL is only a
deployment detail — the daemon runs wherever Claude Code lives and the UI connects either way.

## Monorepo layout (`packages/*`)

```
packages/
  shared/          WS protocol + zod schemas + domain types — the contract every process imports
  core/            the daemon (WS server, supervisor, brain, config)   → @workerking/core
  voice-providers/ the swappable VoiceProvider interface (+ concrete providers)
  app/             the Electron shell (main, preload, overlay + chat renderers)  → @workerking/app
```

## Rules

- **The daemon (`core`) imports zero Electron.** It must stay a plain Node process runnable
  headless on any OS. Anything Electron-specific belongs in `app`.
- **`shared` is the contract.** The WS-bus protocol, zod schemas, and domain types live in `shared`;
  every other package imports them rather than redefining message shapes. Change the protocol there
  first, then let typecheck surface the fallout across packages.
- Keep changes typed end-to-end — `pnpm typecheck` must stay clean across all packages.

## Canonical commands

```bash
pnpm install            # install workspace deps
pnpm build              # build all packages (packages/*)
pnpm typecheck          # typecheck all packages
pnpm test:headless      # shared + core + voice-providers + app tests (no GUI)
pnpm daemon             # run the core daemon standalone (prints WORKERKING_READY)
pnpm app                # run the full Electron app (Windows desktop only)
```

Run a single package with a filter, e.g. `pnpm --filter @workerking/core run build`.

## Gotchas

- **Windows-only UI.** The overlay, tray, and global hotkey need a Windows desktop; `pnpm app` only
  runs meaningfully on Windows. The daemon and headless tests run anywhere.
- **The app spawns the _built_ daemon** — run `pnpm --filter @workerking/core run build` before
  `pnpm app`, or the shell launches stale/absent daemon output.
- **Readiness handshake.** The daemon prints a `WORKERKING_READY {port,token,...}` line on stdout
  once its WS server is listening; the Electron main waits for that before connecting. The runtime
  port+token are also written to the gitignored `.workerking-handshake.json`.

## Log runners for Claude

WorkerKing logs only to the console — nothing hits a file by default, so Claude can't see a running
session. The log-runner scripts fix that: launch a target with its output captured to a file, then
snapshot it. (Mirrors Amethyst's `runbook` + `tail-logs`, adapted to this pnpm/Node/Electron repo.)

- Start (backgrounded): `scripts/run-with-logs.ps1 -Target daemon|app` (extra args via `-ExtraArgs '...'`)
- Snapshot logs: `scripts/tail-logs.ps1 [-Target all|daemon|app] [-Lines N] [-Errors]`
- Bounded follow: `scripts/tail-logs.ps1 -Follow -Timeout 5` (always time-bounded; never blocks)
- Stop everything: `scripts/stop-logs.ps1` (tree-kill; leaves `.log` files for post-mortem)

Two log sources, both read by `tail-logs.ps1` (everything under `tail-logs/` is gitignored):

- `tail-logs/<target>.log` — merged stdout+stderr captured by the runner
- `tail-logs/app-logs/daemon.log` — the daemon's _own_ file log, written whenever
  `WORKERKING_LOG_FILE` is set (the runners, the VS Code tasks, and both F5 profiles all set it)

Equivalent VS Code tasks: **Run Daemon/App (Claude Logs)**, **Tail Logs**, **Tail Logs (errors)**,
**Stop Log Runners**.

**F5 debugging.** `launch.json` has two profiles — **Debug Daemon (core)** (plain Node, TS
breakpoints via source maps) and **Debug App (Electron main + daemon)**. Both run the `build: core`
preLaunchTask and set `WORKERKING_LOG_FILE`, so even while you debug, the daemon tees to
`tail-logs/app-logs/daemon.log` and Claude can `tail-logs.ps1 -Follow` alongside the debug session.

## Plan Mode

When ExitPlanMode is called (plan approved):

1. Save the plan to `plans/YYYY-MM-DD-word1-word2-word3.md` at the repo root — date is today, name is at most 3 kebab-cased words summarising the feature.
2. Ensure `plans/` is in `.gitignore` (already handled).
