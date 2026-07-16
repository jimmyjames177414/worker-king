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
pnpm build && pnpm typecheck && pnpm lint && pnpm test:headless
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
   + voice + scripts + CI. Every finding was verified against the actual code
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

These were found and confirmed during review but intentionally NOT fixed in
`ef1571e` (none corrupts data or breaks a security boundary). Pick them up in
roughly this order. **Read the file and confirm the issue still exists before
changing anything** — line numbers may have drifted.

1. **Routing scorer is noisy/gameable** — `packages/shared/src/routing.ts:49`.
   The bidirectional-substring rule `h.includes(q) || q.includes(h)` matches
   2-char tokens (`"go"` ⊂ `"google"`), and description/hint token scores have
   no cap, so a keyword-stuffed capability description can outrank an exact
   name match. Fix: require substring candidates to be length ≥ 3 both ways, and
   cap the description/hint-derived contribution per entry (e.g. at 4). Update
   `packages/shared/src/routing.test.ts`. (NOTE: this was assigned to a fix agent
   that hit a session limit before doing it — `routing.ts` is unchanged from the
   reviewed baseline.)

2. **Concurrent chat messages fork the SDK session** —
   `packages/core/src/supervisor/Supervisor.ts` `handleChat`. Two rapid
   `chat.user_message`s both start before the other's `resume` id is set, so the
   thread forks and last-writer-wins on `sessionId`. Fix: serialize chat turns
   (a per-supervisor promise chain so `handleChat` bodies run one at a time).
   Keep the streaming behavior; just gate concurrency.

3. **Realtime tool schemas are discarded** —
   `packages/voice-providers/src/createRealtimeSessionFactory.ts:18`
   (`parameters: z.object({}).passthrough()`). The JSON Schemas from
   `VoiceHost.supervisorTools()` never reach the model, so the voice model can
   call `delegate_to_worker` with no `task`. Fix: pass the real per-tool
   parameter schema through the factory to the realtime session.

4. **`WsToolConfirmer` has no tests** —
   `packages/core/src/claude/WsToolConfirmer.ts` (no `.test.ts` beside it). The
   security-critical behaviors (timeout → deny, no client → deny, malformed
   reply → deny) are implemented but unasserted. Add a test with a fake
   `WsServer` seam. Related: its "fall back to the overlay" path targets a
   renderer with no `tool.confirm_request` handler — either remove the fallback
   or add a handler in `packages/app/src/renderer/overlay`.

5. **CI hygiene** — `.github/workflows/ci.yml`. `format:check` (Prettier) is
   never run, and eslint downgrades `no-unused-vars`/`no-explicit-any` to `warn`
   with no `--max-warnings 0`, so drift/warnings never fail CI. Decide whether to
   gate them (add `pnpm format:check` step and/or `--max-warnings 0`).

6. **`run-with-logs.ps1` arg injection (dev-only footgun)** —
   `scripts/run-with-logs.ps1:52,55`. `$ExtraArgs` is interpolated raw into a
   `cmd /c` string, so `&`/`|`/`>` in args are interpreted by cmd. Local dev
   script run by the repo owner, so low priority; fix by passing args as an
   array to `Start-Process` instead of string interpolation. Also
   `tail-logs/<target>.pid` is overwritten if the script runs twice for the same
   target (orphans the first tree).

7. **Streaming-bubble map leak** —
   `packages/app/src/renderer/chat/main.ts:224` (`bubbles` map). If
   `chat.assistant_done` never arrives (daemon dies mid-stream), the entry lives
   forever and the half-streamed bubble is never finalized. Low impact; consider
   a timeout/cleanup on disconnect.

8. **GPT-Realtime provider debt (acknowledged stubs, not accidents)** —
   `packages/voice-providers/src/GptRealtimeProvider.ts:111-119` injects every
   `task.progress` as a full user message (token spend / mid-turn chatter) and
   drops `speakNow`; the code comments already flag these as Phase-2. Only touch
   if you're doing the Phase-2 voice work.

9. **zod v3/v4 split** — `packages/voice-providers/package.json` pins
   `zod: ^4.x` (forced by `@openai/agents-realtime`) while the other packages use
   `^3.x`. Harmless today because no shared zod schema crosses into
   voice-providers; will bite the first time one does. Note only.

10. **`claudeCwd` has no validation** — the WS `config.set` value is
    `z.unknown()`, so a non-string/nonexistent dir reaches the SDK `cwd` and each
    message fails with a spawn error. Now much lower risk since `settingSources: []`
    closed the hostile-settings vector, but consider validating it's an existing
    directory in `Supervisor.handleConfigSet` or `ConfigStore.set`.

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
