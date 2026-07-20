# WorkerKing — AI Desktop Assistant for Windows

> **A Jarvis-style, always-on AI companion that floats on your Windows desktop, listens to your voice, and delegates real work to Claude Code — all without leaving your workflow.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![pnpm 10](https://img.shields.io/badge/pnpm-10-orange)](https://pnpm.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org)
[![Electron](https://img.shields.io/badge/Electron-desktop-47848f)](https://www.electronjs.org)

---

## What Is WorkerKing?

WorkerKing is an open-source **Windows desktop AI assistant** built with Electron, TypeScript, and the Claude Agent SDK. It combines a floating animated avatar (think Clippy — but AI-powered and actually useful) with a full voice interface and an expandable chat window, all connected to a powerful Claude Code brain running in the background.

You talk to it (or type), and it routes real work — file editing, running commands, answering questions — to Claude Code, then narrates the results back to you in a natural voice. No alt-tabbing, no browser, no context switching.

**Key search terms this project covers:**
Windows AI assistant · Electron desktop AI · Claude Code integration · GPT Realtime voice assistant · always-on AI overlay · voice-controlled desktop app · personal AI agent · Windows AI companion · Jarvis for Windows · Claude Pro/Max desktop client · OpenAI Realtime API Electron · voice-to-code assistant · TypeScript AI monorepo

---

## Features

| Feature                       | Detail                                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Floating avatar overlay**   | Transparent, click-through overlay window with animated state machine (idle / listening / thinking / talking / alert). Lives in the corner of your desktop without stealing focus. |
| **Voice I/O — GPT Realtime**  | Full-duplex WebRTC voice powered by OpenAI GPT Realtime (gpt-realtime-mini or gpt-4o-realtime). Ephemeral keys minted by Electron main so your API key never touches the renderer. |
| **Voice I/O — local cascade** | Offline-capable fallback pipeline: Whisper STT → Claude text brain → Kokoro TTS. No OpenAI required.                                                                               |
| **Claude Code brain**         | Rides your existing Claude Pro/Max subscription via the TypeScript Agent SDK — no extra API spend. The voice model delegates real tasks and narrates progress as they stream in.   |
| **Capability discovery**      | Detects your Claude skills, slash commands, agents, and MCP servers and builds a live capability manifest, refreshed as you add more.                                              |
| **Push-to-talk hotkey**       | Global shortcut (default `Ctrl+Shift+Space`) toggles the voice session from anywhere on Windows. Configurable from settings.                                                       |
| **Explain selection hotkey**  | Select text in any app, press `Ctrl+Shift+E`, and WorkerKing explains it in a toast + speaks the answer.                                                                           |
| **Wake-word support**         | Opt-in wake-word detection ("Hey WorkerKing") so you never need to use the hotkey.                                                                                                 |
| **Expandable chat window**    | Full transcript, task list, and settings panel accessible from the system tray.                                                                                                    |
| **Live captions**             | Real-time speech-to-text captions bubble above the avatar as you speak and as the assistant replies.                                                                               |
| **Encrypted secrets**         | API keys stored via Electron `safeStorage` (Windows DPAPI). Never written to disk in plaintext.                                                                                    |
| **Character cards**           | SillyTavern-compatible character card import for custom personas.                                                                                                                  |
| **Proactive notices**         | Reminders, watch heads-ups, and `notify` tool calls surface as Windows toast notifications and spoken announcements.                                                               |
| **WSL + Windows hybrid**      | The daemon runs wherever Claude Code lives — native Windows or WSL2. The UI always connects over `localhost`.                                                                      |

---

## Architecture — Three Processes, One WebSocket Bus

WorkerKing separates concerns cleanly across three OS processes that communicate over a single `localhost` WebSocket server:

```
┌──────────────────────────────────────────────────────────────┐
│                    Electron main process                     │
│  BrowserWindow management · tray · global hotkeys           │
│  DPAPI secrets · daemon supervisor · screen capture         │
└───────────┬──────────────────────────────────────┬──────────┘
            │  spawn + stdout handshake             │ IPC
            ▼                                       ▼
┌───────────────────────┐           ┌───────────────────────────┐
│   Core daemon (Node)  │◄──── WS ──► Renderer: overlay         │
│                       │           │  Avatar · voice (WebRTC)  │
│  Claude Agent SDK     │◄──── WS ──► Renderer: chat            │
│  WS server            │           │  Transcript · settings    │
│  Supervisor + tasks   │           └───────────────────────────┘
│  Config · memory      │
│  Capability manifest  │
└───────────────────────┘
```

| Process               | Runtime                            | Responsibility                                                                    |
| --------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| Electron **main**     | Node (Electron)                    | Windows, tray, global hotkeys, DPAPI secrets, daemon lifecycle, screen capture    |
| Renderer: **overlay** | Chromium                           | Animated avatar state machine, mic/WebRTC voice session, captions, wake-word      |
| Renderer: **chat**    | Chromium                           | Text chat, task list, transcript, settings UI                                     |
| Core **daemon**       | Plain Node (zero Electron imports) | Claude Agent SDK, WS server, task supervisor, capability manifest, config, memory |

The daemon is fully headless and can run on any OS — only the Electron shell needs a Windows desktop.

---

## Monorepo Layout

```
packages/
  shared/          WS protocol + Zod schemas + domain types (the contract every process imports)
  core/            The daemon — WS server, brain, task supervisor, config, memory
  voice-providers/ Swappable VoiceProvider interface + GPT Realtime + local cascade providers
  app/             Electron shell — main, preloads, overlay renderer, chat renderer
```

All packages are TypeScript with strict mode. The `shared` package is the single source of truth for all message types; change the protocol there first and let the typechecker surface the fallout everywhere else.

---

## Getting Started

### Prerequisites

- Windows 10/11 (for the desktop overlay + tray + global hotkeys)
- Node.js ≥ 20 ([nvm-windows](https://github.com/coreybutler/nvm-windows) recommended)
- pnpm 10: `npm install -g pnpm@10.33.0`
- A Claude Pro or Max subscription (the daemon uses Claude Code via the Agent SDK)
- An OpenAI API key (for GPT Realtime voice — optional if you use the local cascade provider)

### Install & Build

```bash
git clone https://github.com/jimmyjames177414/worker-king.git
cd worker-king
pnpm install
pnpm build          # builds shared → core → voice-providers → app in dependency order
pnpm typecheck      # strict TypeScript across all packages
pnpm test:headless  # unit tests for shared, core, voice-providers (no GUI required)
```

### Run the Daemon Headless (any OS)

```bash
pnpm daemon
# → prints WORKERKING_READY {"port":…,"token":"…","host":"windows"}
```

### Run the Full Desktop App (Windows)

```bash
# Build the daemon first — the Electron shell spawns the built output, not ts-node
pnpm --filter @workerking/core run build
pnpm app
```

### Debug in VS Code (F5)

Two launch profiles are included:

- **Debug Daemon (core)** — plain Node with TypeScript source maps, breakpoints work end-to-end.
- **Debug App (Electron main + daemon)** — full Electron dev mode with HMR renderer and the daemon supervised by the shell.

Both profiles write logs to `tail-logs/` for easy inspection.

### Log Runners (for inspecting a live session)

WorkerKing logs only to the console by default. The included PowerShell scripts let Claude (or you) read a running session:

```powershell
# Start with captured logs
scripts/run-with-logs.ps1 -Target daemon   # or app

# Tail live (always time-bounded, never blocks)
scripts/tail-logs.ps1 -Follow -Timeout 5

# Snapshot errors only
scripts/tail-logs.ps1 -Errors

# Stop everything
scripts/stop-logs.ps1
```

---

## Configuration

WorkerKing is configured via `electron-store` (persisted to `%APPDATA%/workerking/config.json`). Secrets (API keys) are stored separately via Windows DPAPI (`safeStorage`).

| Key                | Default               | Description                                          |
| ------------------ | --------------------- | ---------------------------------------------------- |
| `assistantName`    | `WorkerKing`          | Companion name used in prompts and notifications     |
| `personality`      | _(see source)_        | Personality injected into the system prompt          |
| `voiceProvider`    | `gpt-realtime`        | `gpt-realtime` or `local-cascade`                    |
| `openaiModel`      | `gpt-realtime-mini`   | OpenAI Realtime model to use                         |
| `hotkey`           | `Control+Shift+Space` | Global push-to-talk shortcut                         |
| `explainHotkey`    | `Control+Shift+E`     | Explain-selection shortcut                           |
| `claudeHost`       | `auto`                | Where Claude Code lives: `auto`, `windows`, or `wsl` |
| `wakeWordEnabled`  | `false`               | Enable always-listening wake-word detection          |
| `screenAwareness`  | `false`               | Allow the daemon to capture screenshots for context  |
| `memoryEnabled`    | `true`                | Persist conversation memory across sessions          |
| `remindersEnabled` | `true`                | Allow the assistant to set and fire reminders        |
| `proactiveEnabled` | `false`               | Allow unprompted proactive check-ins                 |

---

## Voice Providers

WorkerKing ships with two swappable voice backends behind a clean `VoiceProvider` interface:

### GPT Realtime (default)

Full-duplex WebRTC voice via OpenAI's Realtime API. Ultra-low latency, natural conversation flow. Requires an OpenAI API key (stored encrypted via DPAPI; never touches the renderer process).

### Local Cascade (offline-capable)

`Whisper STT → Claude text brain → Kokoro TTS`. Runs entirely on your machine — no cloud voice API needed. Useful for air-gapped environments or when you want full privacy.

Adding a new provider means implementing the `VoiceProvider` interface in `packages/voice-providers/` — that's it.

---

## Technology Stack

| Layer              | Technology                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Desktop shell      | [Electron](https://www.electronjs.org)                                                                                     |
| Build tooling      | [electron-vite](https://electron-vite.org), [Vite](https://vitejs.dev)                                                     |
| Language           | TypeScript (strict, Node ≥ 20)                                                                                             |
| Package manager    | [pnpm](https://pnpm.io) 10 (workspace monorepo)                                                                            |
| AI brain           | [Claude Code](https://claude.ai/code) via [@anthropic-ai/agent-sdk](https://www.npmjs.com/package/@anthropic-ai/agent-sdk) |
| Voice (cloud)      | [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime) (`@openai/agents-realtime`)                        |
| WS protocol        | [ws](https://github.com/websockets/ws) + [Zod](https://zod.dev) schemas                                                    |
| Secrets            | Electron `safeStorage` (Windows DPAPI)                                                                                     |
| Config persistence | [electron-store](https://github.com/sindresorhus/electron-store)                                                           |
| Tests              | [Vitest](https://vitest.dev)                                                                                               |

---

## Roadmap

- [x] Phase 0 — Walking skeleton: three processes, typed WS bus, transparent overlay, streaming chat
- [x] Phase 1 — Voice integration: GPT Realtime WebRTC, push-to-talk, avatar states, live captions
- [x] Phase 2 — Proactive mode, reminders, explain-selection hotkey, audio-reactive avatar
- [ ] Phase 3 — Full tool delegation: Claude Code completes tasks, voice narrates progress turn-by-turn
- [ ] Phase 4 — Local cascade voice provider (Whisper + Kokoro, no cloud dependency)
- [ ] Phase 5 — Capability manifest: live discovery of skills, agents, and MCP servers
- [ ] Phase 6 — Character card import, custom avatars, settings UI
- [ ] Phase 7 — Wake-word detection, screen awareness, scheduled reminders

---

## Contributing

Pull requests are welcome. Please keep the daemon (`core`) free of Electron imports, keep `shared` as the single source of protocol truth, and run `pnpm typecheck && pnpm test:headless` before opening a PR.

---

## Credits

Created and maintained by **[jimmyjames177414](https://github.com/jimmyjames177414)** — contact: [jimmyjames177414@gmail.com](mailto:jimmyjames177414@gmail.com)

Built on the shoulders of:

- [Anthropic Claude](https://www.anthropic.com) — the AI brain
- [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime) — the voice layer
- [Electron](https://www.electronjs.org) — the desktop shell
- [electron-vite](https://electron-vite.org) — the build system

---

## License

MIT © [jimmyjames177414](https://github.com/jimmyjames177414)
