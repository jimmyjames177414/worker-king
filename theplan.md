# theplan.md — Review / hardening handoff

Status document for the July 14–16 "review every recent commit and fix what's
wrong" effort. **Written for an agent with limited context: everything you need
is here. Always read a referenced file before editing it.**

## Project in one paragraph

WorkerKing is a Windows desktop assistant: an Electron shell (`packages/app`), a
plain-Node daemon (`packages/core`, **zero Electron imports** — this is a hard
rule), swappable voice providers (`packages/voice-providers`), and a shared
WS-protocol/contract package (`packages/shared`) that every other package
imports. It is a **pnpm 10 monorepo — never use npm or yarn**. The daemon talks
to the three UI processes over a localhost WebSocket bus; `shared` owns the
message schemas (zod) so change the protocol there first.

Every change must keep this gate green (this is also what CI runs):

```bash
pnpm build && pnpm typecheck && pnpm lint -- --max-warnings 0 && pnpm format:check && pnpm test:headless
```

Run a single package, e.g.: `pnpm --filter @workerking/core run test`.

## Current git state

- Branch: `claude/review-commits-fix-issues-e4txb8` (pushed to origin).
- `main`: fast-forwarded to `ef1571e` and pushed. Branch and main are identical.
- All fixes are in ONE commit: **`ef1571e`** — "fix: harden security,
  durability, and async lifecycles found in two-day review".
- Gate status at handoff: **fully green** — build, typecheck, lint, and 264
  headless tests pass.

## What happened so far (done — do NOT redo)

1. **Reviewed every commit from 2026-07-14/15** (diff range `ad99b66~1..HEAD`,
   ~40 commits, ~33k lines) with four parallel deep-review agents covering:
   (a) the Claude SDK brain + tool-gating security, (b) core daemon infra
   (tasks/WS/memory/watches/history), (c) the Electron app, (d) shared contract
   - voice + scripts + CI. Every finding was verified against the actual code
     before being accepted; false positives were dropped.
2. **Fixed all verified high/medium findings** in `ef1571e`.

### Fixes already landed in `ef1571e` — do NOT redo these

**Security (core):**

- `packages/core/src/claude/ClaudeBackend.ts` — `buildOptions` sets
  `settingSources: []` (SDK isolation). Filesystem `permissions.allow` rules in
  `~/.claude` or a project's `.claude/settings.json` (reachable via `claudeCwd`)
  used to auto-allow tools without ever calling `canUseTool`, bypassing the
  gate. Also: task runs pass `{ resume: false }` and `consume(..., { trackSession: false })`.
- `packages/core/src/claude/tools.ts` — `untrusted()` now neutralizes embedded
  `</untrusted-external-data>` tags in the body (was escapable), and is exported.
- `packages/core/src/main.ts` — `computePersonaAppend` fences the remembered-facts
  summary and the conversation summary with `untrusted()` (were injected raw
  into the system prompt).
- `packages/core/src/claude/toolPolicy.ts` — `readonly` mode is now an
  ALLOWLIST (`READONLY_SAFE_TOOLS` + `mcp__*`), so unknown tools fail closed;
  Bash confirm summaries show up to 1000 chars with a loud truncation marker.

**Correctness (core):**

- `packages/core/src/brain/Brain.ts` — `Brain` gained optional
  `resetSession()` / `getLastUsage()`; `DeferredBrain` delegates both (they were
  unreachable in production, so "New chat" never reset the model and usage
  tracking never fired).
- `packages/core/src/supervisor/Supervisor.ts` — `onMessage` wraps
  `dispatch(...).catch(...)` (an unhandled rejection from `watches.remove` could
  kill the daemon); `handleChat` threads the assistant reply to the conversation
  the USER turn went to (`appendTo(conversationId, ...)`); `history.new`/`load`
  call `brain.resetSession()`; error codes distinguish rate-limit/auth/generic.
- `packages/core/src/history/ConversationStore.ts` — added `appendTo(id, ...)`;
  `append` returns the conversation id; hydrate validates entries; random id
  suffix (was collision-prone); atomic writes.
- `packages/core/src/claude/ClaudeBackend.ts` — `run()` returns early on an
  already-aborted signal; `consume()` skips subagent stream deltas
  (`parent_tool_use_id`).
- `packages/core/src/claude/createClaudeBackend.ts` — `probeClaude` closes the
  warmed subprocess even when it resolves after the timeout (was orphaned).
- `packages/core/src/proactive/WatchStore.ts` — `isValidCron` actually parses
  with croner (was field-count only); loads are shape-validated; random id
  suffix; atomic writes.
- `packages/core/src/proactive/ProactiveManager.ts` — `schedule()` tolerates a
  bad watch per-entry (one throw no longer unschedules the rest); `tick` has an
  `inFlight` overlap guard.
- `packages/core/src/ws/server.ts` — pre-hello sockets get a 10s handshake
  timeout (were never reaped); `close()` force-terminates stragglers after a 2s
  grace (was able to hang shutdown on a dead peer).
- Atomic JSON writes everywhere: new helper
  `packages/core/src/util/atomicJson.ts` (`writeJsonAtomic`, tmp + rename), used
  by `WatchStore`, `ConversationStore`, `ConfigStore`, `TaskStore`,
  `ReminderStore`; `MemoryStore` does its own tmp+rename inline. A crash
  mid-write used to truncate and silently destroy the whole store.
- `packages/core/src/main.ts` — `resolveBrain` failure now logs and falls back
  to `EchoBrain` instead of leaving every chat awaiting a never-resolving
  `DeferredBrain`; `startDaemon` accepts an injected `config` so tests don't
  touch real `~/.claude`.
- `packages/core/src/daemon.test.ts` — points every store + config at a temp
  dir (was reading/writing the developer's real `~/.claude/workerking`).

**Config (shared + core):**

- `packages/shared/src/domain.ts` — `parseConfig` salvages PER KEY (one bad key
  used to wipe the whole config to defaults); new `validateConfigValue` rejects
  prototype-polluting keys (`__proto__`/`constructor`/`prototype`).
- `packages/core/src/config/ConfigStore.ts` — `set()` validates before
  persisting (was `z.unknown()` straight to disk); atomic writes.

**App (Electron):**

- `packages/app/src/main/DaemonClient.ts` + `index.ts` +
  `renderer/shared/wsClient.ts` — daemon crash-restart now RESTORES service: on
  the supervisor `restarted` event, main's client calls `updateConnection(conn)`
  and renderers get `wk:reconnect`, and `WsClient` re-fetches the connection via
  the preload before dialing (every restart mints a new port + token; everything
  used to keep dialing the dead endpoint forever). `WsClient` also gained the
  duplicate-socket / reconnect-race guards its main-process twin already had.
- `packages/app/src/main/HotkeyManager.ts` + `index.ts` +
  `renderer/chat/accelerator.ts` — hotkeys register FIRST and persist only on
  success; `register` throws (not just `false`) are caught with previous-binding
  restore; capture rejects invalid chords (bare keys, non-ASCII, `+`). A bad
  persisted accelerator used to crash the app on EVERY boot.
- `packages/app/src/renderer/chat/main.ts` + `preload/chat.ts` — tool-confirm
  prompts call `showWindow()` first (the chat window can be hidden in
  voice-first use, so the prompt was invisible and timed out to deny).
- `packages/app/src/main/windows/{ChatWindow,OverlayWindow}.ts` — `sandbox: true`.
- `packages/app/src/main/ipc.ts` — `wk:set-config` rejects prototype keys.

**Voice:**

- `packages/voice-providers/src/localEngines.ts` — `KokoroTtsEngine` has a
  barge-in epoch (stop() bumps it; speak() checks it after each await) so a
  sentence mid-synthesis can't start playing after the user barges in; tracks a
  Set of sources so stop() stops ALL of them.
- `packages/voice-providers/src/LocalCascadeProvider.ts` — `injectAssistantContext`
  guards `!this.running`, and a per-utterance `speakSeq` prevents a superseded
  late-resolving speak from clobbering state.
- `packages/app/src/renderer/overlay/VoiceHost.ts` — ALL spoken text (task
  progress/done/error, `speak()`) goes through one serialized `speakChain` via
  `enqueueSpeech` (no more overlapping audio); start/stop race fixed with
  `startEpoch` + `startPromise` (a double-toggle could leave the mic live while
  the UI showed idle); cascade assistant transcripts are NOT re-emitted to chat
  (were duplicating every reply).
- `packages/app/src/renderer/overlay/WakeWord.ts` — `enable`/`disable` race
  fixed with `enableEpoch` (a device switch mid-`getUserMedia` used to leak a
  live mic stream).
- `packages/shared/src/speech.ts` — `SentenceChunker` is now fence-aware (holds
  boundaries inside a ``` code fence so emitted chunks carry BALANCED fences and
  the sanitizer replaces them with "(code block)" instead of reading code
  aloud), and does not split after abbreviations (`e.g.`, `Dr.`, …) or
  ordered-list markers (`1.`).

**CI:** `.github/workflows/ci.yml` — added `permissions: contents: read`.

## What's LEFT (deferred — verified real, but lower severity)

Items 1–7 and 10 below were picked up and fixed in a follow-up pass (see
"Second pass" below for the commit-level detail). Items 8–9 remain intentionally
deferred.

8. **GPT-Realtime provider debt (acknowledged stubs, not accidents)** —
   `packages/voice-providers/src/GptRealtimeProvider.ts:111-119` injects every
   `task.progress` as a full user message (token spend / mid-turn chatter) and
   drops `speakNow`; the code comments already flag these as Phase-2. Only touch
   if you're doing the Phase-2 voice work.

9. **zod v3/v4 split** — `packages/voice-providers/package.json` pins
   `zod: ^4.x` (forced by `@openai/agents-realtime`) while the other packages use
   `^3.x`. Harmless today because no shared zod schema crosses into
   voice-providers; will bite the first time one does. Note only.

## Second pass — deferred items 1–7 + 10 fixed (this session)

Gate status after this pass: **green** — build, typecheck, lint (0 warnings),
format:check, and test:headless all pass. (One known pre-existing Windows-only
flaky test: `MemoryStore.test.ts` "summary is budget-capped" occasionally hits
an `EPERM` on `renameSync` under full-suite parallel load; passes reliably in
isolation/re-run and is unrelated to any change here.)

1. **Routing scorer** — `packages/shared/src/routing.ts` `scoreCapability` now
   requires partial-match substrings to be length ≥ 3 both ways, and caps the
   hint/description-derived contribution at 4 points so it can't outrank an
   exact name match (worth 4). Added tests to `routing.test.ts`.
2. **Concurrent chat messages** — `Supervisor` gained a `chatChain` promise
   chain; `handleChat` now enqueues `runChatTurn` onto it so turns run one at a
   time (a rejected turn doesn't wedge the chain — it's isolated via `.catch`).
   Added `packages/core/src/supervisor/Supervisor.test.ts` asserting
   `brain.respond` never runs concurrently for two rapid turns.
3. **Realtime tool schemas** — `createRealtimeSessionFactory.ts` now forwards
   each `VoiceToolSpec`'s real `properties`/`required` into the `tool()` JSON
   Schema (previously `z.object({}).passthrough()`), so the realtime model sees
   actual argument shapes.
4. **`WsToolConfirmer` tests** — added
   `packages/core/src/claude/WsToolConfirmer.test.ts` covering no-client-deny,
   timeout-deny, malformed-reply-deny, approve, and deny-explicit paths. Also
   removed the dead "fall back to the overlay" path (the overlay renderer has no
   `tool.confirm_request` handler, so it only ever timed out) — `confirm()` now
   only targets the chat client and denies immediately if none is connected.
5. **CI hygiene** — ran a repo-wide `pnpm format` (63 files were drifted from
   Prettier) and added `format:check` + `lint -- --max-warnings 0` to
   `.github/workflows/ci.yml`.
6. **`run-with-logs.ps1` arg injection** — `-ExtraArgs` is now `[string[]]`,
   rejected outright if any element contains a shell metacharacter (`&|<>^`),
   and each element is individually quoted before being interpolated into the
   `cmd /c` string. Also: a previous still-tracked runner for the same `-Target`
   is now tree-killed before starting a new one (previously the `.pid` file was
   silently overwritten, orphaning the old process tree).
7. **Streaming-bubble map leak** — `packages/app/src/renderer/chat/main.ts`'s
   `bubbles` map now tracks a `lastUpdate` timestamp per entry; a 15s sweep
   finalizes (and removes) any bubble stale for 60s+ so a daemon death
   mid-stream can't leak the entry/element forever.
8. **`claudeCwd` validation** — `ConfigStore.set` now rejects a `claudeCwd`
   that isn't an existing directory (empty/undefined still clears it). Added
   tests to `ConfigStore.test.ts`.

## How to work here (gotchas for the next agent)

- Keep `packages/core` free of Electron imports. Anything Electron goes in `app`.
- Change protocol/schemas in `packages/shared` first, then let typecheck surface
  the fallout in the other packages.
- The app spawns the BUILT daemon, so `pnpm --filter @workerking/core run build`
  before any manual `pnpm app` run. UI (overlay/tray/hotkey) only runs
  meaningfully on Windows; the daemon and all headless tests run anywhere.
- There is a verification skill: invoking `/verify` runs build → typecheck →
  tests in order and stops on first failure.
- Don't open a PR unless explicitly asked. When committing, use the branch
  `claude/review-commits-fix-issues-e4txb8`.
