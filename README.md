# WorkerKing

A personal, always-on **Jarvis-style AI assistant for Windows** — a small animated companion that
floats in the corner of your desktop (Clippy, but for all of Windows) plus an expandable chat window.
It talks with your voice, thinks with **Claude Code**, and grows as your Claude skills/workflows grow.

- **Voice** — OpenAI GPT Realtime by default, behind a swappable provider interface (a free/local
  Whisper + Kokoro pipeline, optionally with Claude itself as the voice brain, drops in later).
- **Brain** — Claude Code via the TypeScript Agent SDK, riding your Claude Pro/Max subscription
  (no API key). The thin voice layer delegates real work to Claude and narrates progress.
- **Knows what it can do** — discovers your skills, commands, agents, and MCP servers and routes to
  them, refreshing live as you add more.
- **Configurable** — name, personality, system prompt, voice, and avatar via config + importable
  SillyTavern-compatible character cards.

See the full design and phased plan in the planning notes.

## Architecture (three processes, one localhost WebSocket bus)

| Process | Runtime | Role |
|---|---|---|
| Electron **main** | Node (Electron) | windows, tray, global hotkey, secrets, spawns/supervises the daemon (native or WSL) |
| Renderer: **overlay** | Chromium | avatar state machine + voice (mic/WebRTC) |
| Renderer: **chat** | Chromium | text chat, transcript, tasks, settings |
| Core **daemon** | plain Node (zero Electron imports) | Claude Agent SDK, supervisor, tasks, capability manifest, config, memory, **WS server** |

Native-Windows vs WSL is a deployment detail: the daemon runs wherever your Claude Code lives and the
UI reaches it over `localhost` either way.

## Monorepo layout

```
packages/
  shared/          WS protocol + zod schemas + domain types (the contract every process imports)
  core/            the daemon (WS server, supervisor, brain, config)
  voice-providers/ the swappable VoiceProvider interface (+ concrete providers, later phases)
  app/             the Electron shell (main, preload, overlay + chat renderers)
```

## Status

**Phase 0 — walking skeleton** (three processes + typed WS bus + transparent overlay + streaming chat
echo, no AI yet). `shared` and `core` are built, typechecked, and covered by passing tests; the
Electron `app` is scaffolded (launch it on Windows).

## Develop

Requires Node ≥ 20 and pnpm 10.

```bash
pnpm install
pnpm build              # build all packages
pnpm typecheck          # typecheck all packages
pnpm test:headless      # run shared + core + voice-providers tests (no GUI needed)
```

Run the daemon standalone (headless, any OS):

```bash
pnpm --filter @workerking/core run build
pnpm --filter @workerking/core run start   # prints WORKERKING_READY {port,token,...}
```

Run the full app (**Windows** — the overlay/tray/hotkey need a Windows desktop):

```bash
pnpm --filter @workerking/core run build   # the app spawns the built daemon
pnpm --filter @workerking/app run dev
```

## License

MIT
