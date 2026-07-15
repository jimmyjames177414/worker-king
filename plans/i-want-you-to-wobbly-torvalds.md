# WorkerKing — Refactoring Health Assessment (lessons from like-minded repos)

> Round 1 (below) draws on `5uck1ess/cicero`. **Round 2** (appended at the end) widens the survey to
> `metaspartan/cybara`, `voltagent/voltagent`, and LiveKit/Pipecat voice-pipeline practice, turning
> their lessons into 15 verified, prioritized improvements (N1–N15).

## Context

**Why this exists.** The request: study a nearby project and see whether WorkerKing needs a
"healthy refactoring." The linked page (`github.com/topics/bun?l=typescript&o=desc&s=updated`) is a
*topic feed*, not a person — there's no `cicero` on it. The repo actually meant is
[`5uck1ess/cicero`](https://github.com/5uck1ess/cicero): a self-hosted **voice interface for coding
agents** (voice → STT → switchboard → pluggable brain (Claude Code / ACP) → streamed TTS, with async
delegation and spoken confirmation gates). It is a startlingly close domain sibling to WorkerKing,
which makes its retrospective docs (`lessons-learned.md`, `performance-portability-evaluation.md`)
directly transferable.

**Scope decision (confirmed with user):** *assessment only.* No runtime change — WorkerKing stays
Node/Electron/pnpm (Bun is not on the table; Electron embeds Node anyway). This document is a health
check plus a prioritized, opt-in cleanup roadmap. The user reviews it, then decides what to execute.

**Outcome.** A verdict (WorkerKing is healthy — no rewrite) and a staged list of low-risk cleanups,
each cross-referenced to a lesson cicero paid for the hard way, with concrete file paths and existing
utilities to reuse.

---

## What cicero teaches (distilled)

From `docs/lessons-learned.md` and `docs/performance-portability-evaluation.md`:

1. **One source of truth for *behavior*, not just code.** Three copies of filler-stripping diverged
   and caused bugs; the fix was a single `stripFillers()`. "DRY is about one source of truth for
   behavior."
2. **Component-based architecture is what saved them.** The original split (daemon/router/executor/
   brain/speaker/terminal/listener) "remained stable throughout and enabled feature addition without
   restructuring." Clean seams > clever code.
3. **TDD for the scary refactors.** The big invert-the-stack refactor was test-first, enabling
   confident deletion of 200+ lines.
4. **Add network deadlines everywhere.** Fetches without abort signals let "an unreachable remote
   model or wedged local server stall operations indefinitely" (a P0).
5. **Don't let managed subprocesses block on unread stderr** — it delays startup detection (a P1).
6. **Honor configured providers; never hardcode `localhost`.** The worst P0 was conversational mode
   ignoring the configured backend — a config-drift bug.
7. **Sanitize model output before speech** — reasoning blocks (`<think>…`) leaked into TTS as long
   nonsensical audio.
8. **Add capability-aware diagnostics** (`cicero doctor`: OS/arch/GPU + recommended profile) and
   **end-to-end latency telemetry** (target < 1s speech-end → playback).
9. **Type errors tolerated at runtime are debt.** Bun ran despite 9 TS errors; the recommendation
   was "add typecheck + test to CI before packaged builds."

---

## Verdict: WorkerKing is healthy — no rewrite

The bones are *better* than the reference. WorkerKing already does, by design, several things
cicero's evaluation had to file as bugs:

| cicero lesson / P0-P1 | WorkerKing status |
|---|---|
| Add typecheck+test to CI (#9) | **Already there** — `ci.yml` runs build → typecheck → lint → `test:headless` on every PR |
| Unify providers behind an interface (#6) | **Already there** — `Brain` interface (`ClaudeBackend`/`EchoBrain`/`DeferredBrain`) + `VoiceProvider` interface |
| Bounded subprocess probe (#4) | **Already there** — `probeClaude` is `withTimeout`-wrapped (`createClaudeBackend.ts:29`) |
| Don't block on unread stderr (#5) | **Already there** — `DaemonSupervisor` drains `child.stderr` (`DaemonSupervisor.ts:147`) |
| Component-based seams (#2) | **Stronger** — 3 processes + a `shared` zod/WS contract; core is a headless, Electron-free Node daemon |
| Test coverage (#3) | **Good in core** — 18 core test files incl. integration (`daemon.test.ts`), injected clocks/spawn |

So the framing is *not* "rescue a mess." It's "a healthy codebase with a handful of the exact
DRY/structure smells cicero warned about — fix them cheaply while borrowing their lessons."

---

## The refactoring roadmap (staged, opt-in)

Ordered by value-to-risk. Stage 1 is the high-leverage, low-risk core; Stages 2–3 are optional.

### Stage 1 — Single source of truth (cicero lesson #1) — *recommended first*

These are pure DRY consolidations, each with tests already nearby to guard the change (TDD-friendly,
lesson #3).

- **1a. Config schema is triplicated → put it in `shared`.** Today the config field-set is
  hand-maintained in three places: `WorkerKingConfig` + `DEFAULT_CONFIG` in
  `packages/core/src/config/ConfigStore.ts`, and an independent `AppConfig` + electron-store
  `defaults` + `CONFIG_KEYS` in `packages/app/src/main/index.ts`. Everything else in the domain is a
  zod schema (`packages/shared/src/domain.ts`) — config is the exception. **Fix:** add a
  `WorkerKingConfigSchema` (zod) + inferred type + `DEFAULT_CONFIG` to `shared`; have both
  `ConfigStore` and the app import it. This is the direct analogue of cicero's provider-config-bypass
  P0 (#6) — one schema removes the drift risk.
- **1b. `ClaudeBackend.respond()` and `run()` duplicate the SDK stream loop.** Near-identical
  `for await … switch(msg.type)` over `stream_event`/`result` in
  `packages/core/src/claude/ClaudeBackend.ts`. **Fix:** extract one private async-iterator helper
  (e.g. `consumeQuery`) that both call; keep the existing `extractTextDelta`/`extractToolUses`
  helpers.
- **1c. `claude/tools.ts` (310 lines) repeats tool boilerplate.** Every `buildXTool` re-implements
  the `enabled()` gate + `audit?.()` + `{ content:[{type:'text',text}] }`/`isError` wrapper, and
  `memoryEnabled` gating is copy-pasted across `remember`/`recall`/`list_memories`. **Fix:** a small
  `defineTool({ name, enabled, run })` factory that centralizes the gate/audit/response envelope.
- **1d. `defaultWatches()` composed in two places** — `main.ts` `resolveBrain` and
  `Supervisor.allWatches()` both compute `[...defaultWatches(), ...store.list()]`. Collapse to one
  helper.

### Stage 2 — Decompose the two god files for testability (cicero lesson #2)

Both are untested module-level wiring with mutable module-scope singletons.

- **2a. `packages/core/src/main.ts` (337 lines)** — boot wiring + brain resolution + persona assembly
  + five top-level mutable singletons (`memory`, `interactionLog`, `conversations`, `watchStore`,
  `reminderStore`). **Fix:** extract a `createDaemon(deps)` composition function that takes injected
  stores and returns the wired server; `main.ts` becomes a thin entrypoint. Mirrors the existing
  dependency-injection style already used in `DaemonSupervisor`/`ClaudeBackend` (both take injected
  `spawnFn`/`queryFn`), so this is consistent with the codebase, not a new pattern.
- **2b. `packages/app/src/main/index.ts` (318 lines)** — config store + IPC + two hotkeys +
  explain-selection + supervision wiring + screen-capture + power-resume, all at module scope.
  **Fix:** split into `registerIpc()`, `registerHotkeys()`, `wireDaemon()` modules called from a slim
  `index.ts`. Lower priority than 2a (it's Electron-side, harder to unit-test headless).

### Stage 3 — Close the small gaps cicero surfaced (optional, targeted)

- **3a. Align zod versions.** `voice-providers` pins `zod@^4.4.3`; `shared`/`core`/`app` pin
  `zod@^3.24.1`. Two majors across a type boundary is a latent hazard — unify on one (v3 is the
  workspace majority; do this alongside 1a since the shared schema will cross that boundary).
- **3b. Verify/centralize TTS output sanitization (cicero #7).** Confirm there's one seam that
  flattens markdown/reasoning before speech (cicero's `<think>` leak). `renderVoiceSummary`
  (`CapabilityManifest.ts`) and `Captions.ts` exist; ensure spoken text passes through a single
  `sanitizeForSpeech()` rather than ad hoc per call site.
- **3c. `workerking doctor` diagnostics (cicero #8).** WorkerKing has the `WORKERKING_READY`
  handshake + handshake file but no health/diagnostics surface. A small command that reports
  Claude-probe status, WS port/token, WSL-vs-native mode, and capability-manifest state would mirror
  `cicero doctor` and cut setup friction. Reuse `probeClaude` and `WslDetector`.
- **3d. Latency telemetry (cicero #8).** Add lightweight timestamps across the voice turn
  (speech-end → brain first token → first spoken sentence) behind the existing `logger.ts`. Cheap,
  and the only way to know if the pipeline meets a < 1s target.
- **3e. Packaging correctness.** `packages/app/package.json`'s `package` script calls
  `electron-builder --win` but there is **no** electron-builder config and nothing declares that the
  spawned `@workerking/core` `dist/` (resolved at runtime via `require.resolve`) is bundled. Add an
  `electron-builder.yml` with `extraResources`/`files` for the daemon; optionally a packaging smoke in
  CI. (This is the WorkerKing version of cicero's "type errors survive to packaged builds" gap.)
- **3f. Optional structural tidies:** split `domain.ts` by noun (tasks / capabilities / character
  cards / avatar), and give `config.get` a dedicated `*_result` kind instead of overloading
  `config.changed` (a request/response pair the Supervisor's own comment flags).

### Explicitly *not* recommended

No Bun migration, no build-system swap (Turborepo/nx), no rewrite. TS project references/composite to
kill the "build core before app" footgun is *tempting* but is a build-graph change with its own risk —
park it unless the manual build ordering becomes a recurring pain.

---

## Critical files

- Config triplication: `packages/core/src/config/ConfigStore.ts`, `packages/app/src/main/index.ts`,
  target `packages/shared/src/domain.ts`
- Stream-loop dup: `packages/core/src/claude/ClaudeBackend.ts`
- Tool boilerplate: `packages/core/src/claude/tools.ts`
- God files: `packages/core/src/main.ts`, `packages/app/src/main/index.ts`
- Watches dup: `packages/core/src/main.ts`, `packages/core/src/supervisor/Supervisor.ts`
- zod skew: `packages/voice-providers/package.json`
- Packaging: `packages/app/package.json` (+ new `electron-builder.yml`)

## Verification

Whatever subset is executed, the gate is the same and already wired:

1. `pnpm build` — must stay clean (libraries build with `tsc`; app via electron-vite).
2. `pnpm typecheck` — must stay green across all four packages (the contract; cicero's #9 lesson —
   never let TS errors ride).
3. `pnpm test:headless` — shared + core + voice-providers + app. Add/extend tests *first* for any
   Stage 1 consolidation (TDD, cicero #3): a config-schema round-trip test, a `consumeQuery` iterator
   test, a `defineTool` gate/audit test.
4. `pnpm lint` — flat ESLint config.
5. For Stage 2/3c, add a `createDaemon(deps)` / `workerking doctor` test and run the daemon
   standalone (`pnpm daemon`) to confirm it still prints `WORKERKING_READY`.
6. For 3e, run `pnpm --filter @workerking/app run package` and confirm the daemon `dist/` lands in the
   packaged output.

The `/verify` skill runs build → typecheck → headless tests in order and stops on first failure — use
it as the one-command gate after each stage.

---

# Round 2 — Lessons from like-minded repos → new improvements

## Context

Round 1 mined a single sibling (`5uck1ess/cicero`) and found WorkerKing structurally healthy. This
round widens the net to other self-hosted AI-agent runtimes, voice pipelines, and TS agent frameworks
to harvest lessons that turn into *behavioral / robustness* improvements — beyond the Round 1 DRY
cleanups. Each item below was verified against the actual WorkerKing code (file:line) so these are
real gaps, not style opinions.

### Reference repos surveyed

- **[`metaspartan/cybara`](https://github.com/metaspartan/cybara)** — Bun self-hosted agent runtime.
  Lessons: *tool **policy** is separate from tool **availability*** ("effective policy-filtered subset,
  not the full catalog every turn" — anti prompt-injection/scope-creep); provider **router + plan/quota
  monitoring** against rolling windows/budgets; multi-modal memory (vector + markdown + logs);
  path-sandbox / SSRF protection; session **context compaction**; checkpoints + rollback.
- **[`voltagent/voltagent`](https://github.com/voltagent/voltagent)** — TS agent framework. Lessons:
  **guardrails as runtime validators** in the exec loop (validate input *and* output); **tracing as
  first-class infrastructure** (spans/durations, not bolt-on logs); **evals embedded in the dev loop**;
  Zod-typed tools with **lifecycle hooks + cancellation**; workflow **suspend/resume** for HITL.
- **LiveKit Agents / Pipecat** (voice-pipeline art) — Lessons: streaming turns total latency from
  `sum(VAD,STT,LLM,TTS)` into `max(...)`; **barge-in = detect → stop TTS → flush queue → cancel
  generation → restart STT**; **model-based turn detection** beats silence thresholds; conversational
  turn-taking breaks above ~1–2s latency (so you must measure it).
- **cicero `security.md` / `duplex.md`** — Lessons: **"config is code execution, by design — never
  load a config you didn't write"**; **fail-closed confirmation gates** for destructive tools, one
  approval = one call, "treat the voice port as an unauthenticated houseguest"; byte-caps on all
  inbound data; barge-in needs explicit generation cancellation, not just TTS stop.

## Verdict (round 2)

The *architecture* is still sound, but the **real-time voice path, the tool-security posture, and
runtime observability are the three areas where WorkerKing lags the more mature siblings** — and each
gap was confirmed in code. These are additive features/hardening, not refactors.

## New improvements — prioritized

### P0 — highest value (correctness + safety), do first

- **N1 · Gate the Claude Code toolset (security).** Today `permissionMode`, `canUseTool`, and
  `disallowedTools` are declared but **never set** (`packages/core/src/claude/ClaudeBackend.ts:40,72`;
  `main.ts` `claudeOpts` omits them). The static `WORKERKING_TOOL_ALLOWLIST`
  (`tools.ts:302-310`) only covers the 7 in-house `mcp__workerking__*` tools; the SDK's Bash/Write/Edit
  ride the `claude_code` preset **ungated and un-sandboxed**. Since voice is an unauthenticated
  interface, add a `canUseTool` confirmation gate — **fail-closed, one-approval-per-call** for
  destructive tools (cicero `confirm_tools`; cybara policy-filtered subset). Wire an explicit
  `permissionMode` and set it from config. *Files:* `ClaudeBackend.ts` `buildOptions()`,
  `main.ts` `claudeOpts`, plus a new confirmation message kind in `shared/protocol.ts`.
- **N2 · Fix the barge-in stale-reply race (correctness).** On barge-in the local cascade stops TTS
  but **never cancels brain generation**, and when the stale reply resolves it is spoken
  unconditionally (`packages/app/src/renderer/overlay/VoiceHost.ts:159`;
  `LocalCascadeProvider.ts:60-66`). Add a **per-turn epoch/`turnId`**: stamp each turn, drop any
  `chat.assistant_*` whose turn is no longer current, and cancel the in-flight daemon turn on barge-in
  (the daemon already has abort plumbing via `TaskManager`/`ClaudeBackend.run`’s `AbortController`).
  (LiveKit barge-in; cicero duplex.)
- **N3 · Sentence-stream the voice path (latency).** Voice waits for `chat.assistant_done` then
  synthesizes the whole response — latency ≈ **sum** of stages (`VoiceHost.ts:163-177` →
  `LocalCascadeProvider.speak(text)`). The daemon **already emits `chat.assistant_delta`**
  (`Supervisor.ts:140-143`), consumed only by the chat window. Consume those deltas in `VoiceHost`,
  chunk on sentence boundaries, and feed TTS incrementally so speech starts on the first sentence
  (latency ≈ **max**). Biggest perceived-speed win; reuses infra that already exists.

### P1 — high value

- **N4 · `sanitizeForSpeech()` seam (correctness + a guardrail hook).** Brain text goes to TTS raw —
  markdown, code fences, `**bold**`, and any reasoning are voiced literally (`LocalCascadeProvider.ts:99-108`;
  no sanitizer exists). Add one shared sanitizer on the speech path; make it the natural home for a
  **VoltAgent-style output guardrail** (strip/deny before speaking or acting). Directly fixes cicero's
  `<think>`-leaked-into-TTS lesson.
- **N5 · Frame untrusted content (prompt-injection).** Screen titles, screenshots, and remembered
  facts flow into a Bash/Write/Edit-capable agent with **no provenance framing** (`tools.ts:79-116`;
  memory injected into the system prompt via `computePersonaAppend`, `main.ts:92-97`). Wrap
  screen/window/memory content in explicit "untrusted external data" delimiters/spotlighting, tag
  provenance, and consider dropping to a **read-only tool policy** (composes with N1) while acting on
  screen-derived input. (cicero untrusted-input; cybara.)
- **N6 · Rate-limit / usage-cap awareness (robustness).** `normalizeError`
  (`ClaudeBackend.ts:190-205`) only classifies **auth** errors; a 429, a Pro/Max 5-hour cap, or a
  `Retry-After` becomes an anonymous generic `Error` — no backoff, no user-facing "you're rate-limited,
  try later." Add a `ClaudeRateLimitError` class + detection + surfaced message (and optional backoff).
  (cybara provider-plan monitoring.)
- **N7 · Voice-turn latency telemetry (observability).** No instrumentation exists across the turn.
  Capture timestamps at utterance-end → STT-done → brain-first-token → first-audio-out behind the
  existing `logger.ts` (it already supports `WORKERKING_LOG_JSON`). This is the concrete form of Round
  1's item 3d; without it you can't tell if you meet the <1–2s turn-taking budget. (LiveKit/Pipecat.)

### P2 — worthwhile

- **N8 · Trace correlation id (observability).** The WS envelope already mints a per-message
  `randomUUID` (`ids.ts:10-13`) but it **never reaches the logger** — logs carry only static scopes.
  Thread a per-turn/per-task correlation id through `logger.child` scopes across Supervisor →
  ClaudeBackend → TaskManager so a turn is traceable end-to-end. (VoltAgent tracing-as-infrastructure.)
- **N9 · Capture SDK usage (observability).** The SDK `result` message carries `usage`/cost fields
  that are currently ignored (`ClaudeBackend.ts:103-114`) — record them per turn to enable budget
  awareness and to feed N6. (cybara plan monitoring.)
- **N10 · Behavior eval harness (quality).** All tests are deterministic unit tests over pure
  functions and faked SDK plumbing (`routing.test.ts`, `personaSelect.test.ts`, `ClaudeBackend.test.ts`)
  — no test exercises actual response quality. Add a small golden-transcript / LLM-as-judge eval
  (opt-in `pnpm eval`, not in the headless gate) for routing, persona assembly, and speech
  sanitization. Voice output is fuzzy — cicero's #1 process lesson was "test voice patterns early."
  (VoltAgent evals-in-loop.)
- **N11 · Electron + config hardening.** Set `sandbox: true` on the windows where the preload allows
  it (`OverlayWindow.ts:35`, `ChatWindow.ts:20` are `false`), add `setWindowOpenHandler` +
  `will-navigate` deny handlers (currently absent — only CSP guards navigation), and treat config as a
  trust boundary: the Round-1 zod config schema (1a) should **validate on load** and reject
  executable-ish fields, per cicero's "config is code execution." Also add byte-caps on WS payloads.

### P3 — optional / larger

- **N12 · Durable, resumable tasks.** `TaskManager` is in-memory and evicts tasks on completion
  (`TaskManager.ts:153`) — no persistence, suspend/resume, or HITL pause. Persist task state and add
  suspend/resume + an approval gate to survive daemon restarts. (cybara checkpoints/rollback;
  VoltAgent suspend/resume.) Bigger change — defer unless delegated tasks need to outlive restarts.
- **N13 · Semantic turn detection** (model-based endpointing vs Silero-VAD-only) and
  **N14 · conversation summarization** on truncation (`ConversationStore.append` drops oldest messages
  with no summary, `ConversationStore.ts:108-110`) and **N15 · screenshot redaction / per-capture
  consent** (currently a coarse `screenAwareness` flag, no per-shot gate or PII scrub). All nice-to-have.

### Recommended sequence

**N1 → N2 → N3** first (one safety, two voice-UX), then **N4/N6/N7**. N1 and N5 compose (both touch
tool policy); N4 and N3 touch the same `VoiceHost`/`LocalCascadeProvider` speak path, so do them
together. N7/N8/N9 are the observability cluster; land N7 with N3 so you can measure the latency win.

## Round-2 critical files

- Tool gating / policy: `packages/core/src/claude/ClaudeBackend.ts` (`buildOptions`),
  `packages/core/src/main.ts` (`claudeOpts`), `packages/core/src/claude/tools.ts`,
  `packages/shared/src/protocol.ts` (new confirmation kind)
- Voice barge-in / streaming / sanitize: `packages/app/src/renderer/overlay/VoiceHost.ts`,
  `packages/voice-providers/src/LocalCascadeProvider.ts`, `packages/core/src/supervisor/Supervisor.ts`
- Robustness / observability: `packages/core/src/claude/ClaudeBackend.ts` (`normalizeError`, usage),
  `packages/core/src/util/logger.ts`, `packages/core/src/util/ids.ts`
- Hardening: `packages/app/src/main/windows/OverlayWindow.ts`, `.../windows/ChatWindow.ts`,
  `packages/core/src/config/ConfigStore.ts` (validate-on-load)

## Round-2 verification

Same gate as Round 1 (`/verify`: build → typecheck → `test:headless`), plus per-item:

- **N1/N5:** unit-test the `canUseTool` gate (destructive call denied without approval; approval =
  exactly one call) and that screen-derived turns get the read-only policy. Manual: speak a
  file-deleting request and confirm it fail-closes.
- **N2/N3/N4:** extend `VoiceHost`/`LocalCascadeProvider` tests — stale-turn reply is dropped after a
  new turn starts; deltas are chunked to TTS on sentence boundaries; markdown/code is stripped before
  `tts.speak`. Run `pnpm daemon` + overlay to hear first-sentence-early-out.
- **N6:** feed a faked 429 SDK result through `normalizeError` and assert `ClaudeRateLimitError`.
- **N7/N8/N9:** with `WORKERKING_LOG_JSON=1`, assert one structured line per turn carrying the
  correlation id and the stage timestamps/usage.
- **N10:** `pnpm eval` runs the golden/LLM-judge suite green (kept out of the CI headless gate).

---

# Implementation status (applied this session)

Landed on `claude/app-refactoring-assessment-s2x2ph`, each committed separately, with the full gate
(build → typecheck → `test:headless` → lint) green after every group.

**Done**
- **1a** config → one `workerKingConfigSchema`/`DEFAULT_CONFIG`/`CONFIG_KEYS` in `shared`, consumed by
  core `ConfigStore` and the app; validate-on-load. Fixed the `claudeCwd`/personality drift.
- **1b** shared `ClaudeBackend.consume()` iterator behind `respond()`/`run()`.
- **1c** shared `textResult`/`errorResult`/`memoryOn`/`resolveMemoryIndex` tool helpers.
- **1d** single `composeWatches(store)`.
- **N1** `toolPolicy` (`auto`/`readonly`/`gated`, default gated) + `canUseTool` in ClaudeBackend +
  `WsToolConfirmer` round-trip + `tool.confirm_request/response` protocol + chat-window prompt;
  background brains forced read-only.
- **N4** `sanitizeForSpeech` applied at both providers' speak seam.
- **N2/N3/N7** per-turn epoch + `onSpeechStart` barge-in, `SentenceChunker` streamed TTS, turn-latency log.
- **N5** `<untrusted-external-data>` framing on screen/window/memory tool output.
- **N6** `ClaudeRateLimitError` classification (+ retry-after).
- **N8/N9** correlated per-turn `chat.start/done/error` logs with latency + SDK usage capture.
- **N11** `setWindowOpenHandler`/`will-navigate` deny on both windows; 16 MiB WS payload cap;
  config validate-on-load (via 1a).

**Deferred (bigger / need UI or a runner):** Stage 2 god-file decomposition (2a/2b), N10 eval harness,
N12 durable/resumable tasks, N13 semantic turn detection, N14 conversation summarization, N15
screenshot redaction, and a Settings control to switch `toolPermissionMode` from the app UI.

---

# Next up (approved): 2a decomposition, then N10 eval harness

## Context

The one item everything else in `core` hangs off — `packages/core/src/main.ts` — still declares five
**module-scope mutable singletons** (`memory`, `interactionLog`, `conversations`, `watchStore`,
`reminderStore`, plus `log`) that are constructed *at import time*. That means importing `main.ts` in a
test touches `~/.claude/workerking` on disk, the stores can't be swapped for fakes, and `startDaemon`
is hard to exercise in isolation. This is the last structural smell from Round 1 (Stage 2a). N1 stays
at `gated` (the recommended, safe default) — no change there.

Goal: make the daemon's dependencies **injected**, not global, mirroring the DI already used by
`DaemonSupervisor`/`ClaudeBackend` (both take injected `spawnFn`/`queryFn`). Then add an opt-in eval
harness (N10) so the fuzzy pieces have regression coverage that lives outside the CI gate.

## Phase 1 — 2a: inject the daemon's stores (low risk, headless-testable)

- **Introduce `DaemonDeps`** in `main.ts`: `{ memory, interactionLog, conversations, watchStore,
  reminderStore, log }`, plus a `createDaemonDeps()` factory that builds the real file-backed stores
  (the code currently at `main.ts:34-38`). Nothing is constructed at module scope anymore, so importing
  `main.ts` has no filesystem side effects.
- **Thread deps through the wiring**, replacing every closure over the old globals:
  - `computePersonaAppend(config)` → `computePersonaAppend(config, memory)` (`main.ts:81,96`). Update
    its three call sites in `packages/core/src/persona/personaSelect.test.ts` to pass a `MemoryStore`
    (this also makes that test deterministic instead of reading the real home dir).
  - `resolveBrain(...)` gains a `deps` parameter and uses `deps.memory` / `deps.interactionLog` /
    `deps.watchStore` / `deps.reminderStore` (the distiller at `main.ts:~205` and proactive wiring).
  - `startDaemon` builds `deps` (from a new optional `opts.deps` merged over `createDaemonDeps()`) and
    passes them into `resolveBrain` and the `Supervisor` constructor (already takes
    `interactionLog`, `conversations`, and the `log` added for N8).
- **Add `deps?: Partial<DaemonDeps>` to `StartDaemonOptions`** so tests inject in-memory / temp-dir
  stores. The public boot path (`isDirectRun`) is unchanged — it just calls `startDaemon()`.
- **Reuse, don't rebuild:** the stores already accept a `dir`/persistence option (e.g. `ConfigStore`,
  `MemoryStore`); tests point them at a `mkdtemp` dir. No store internals change.

Deliberately *not* splitting `main.ts` into multiple files in this phase — the mutable-global removal is
the substance and is low-risk; a cosmetic file split can follow if it still reads long.

## Phase 2 — N10: opt-in eval harness (new capability, outside CI)

- **New `packages/core/src/eval/` runner** invoked by a root `pnpm eval` script (added to
  `package.json`, **not** part of `test:headless`, so CI stays fast and deterministic).
- **Golden cases** for the deterministic, fuzzy-prone pieces — reusing existing pure functions:
  - routing: `routeRequest`/`scoreCapability` (`packages/shared/src/routing.ts`) over a table of
    `query → expected capability`.
  - persona assembly: `assemblePersonaFromCard`/`computePersonaAppend` on a sample card+config.
  - speech: `sanitizeForSpeech` / `SentenceChunker` (`packages/shared/src/speech.ts`) over tricky
    markdown/streaming inputs.
- **Optional LLM-judge tier**, gated behind `WORKERKING_EVAL_LLM=1` and a reachable Claude (reusing
  `probeClaude` + `createClaudeBackend`): runs a handful of prompts and scores the replies with an
  LLM-as-judge prompt. Skips cleanly (logs "skipped") when Claude is unavailable, so the harness is
  always runnable. Report a pass/fail summary and non-zero exit on regressions.

## Critical files

- Decomposition: `packages/core/src/main.ts` (deps interface + factory + threading),
  `packages/core/src/persona/personaSelect.test.ts` (call-site + new deterministic assertions).
- Reuse: `ConfigStore`/`MemoryStore`/`ConversationStore`/`WatchStore`/`ReminderStore` (existing
  `dir`/persist options), `Supervisor` ctor, `probeClaude`/`createClaudeBackend`.
- Eval: new `packages/core/src/eval/*` + a root `eval` script in `package.json`; goldens over
  `shared/routing.ts` and `shared/speech.ts`.

## Verification

- **2a:** `pnpm --filter @workerking/core test` — existing `daemon.test.ts` (end-to-end over
  `startDaemon`) must stay green, proving the wiring is unchanged. Add a test that calls
  `startDaemon({ brainMode: 'echo', deps: { memory: <temp-dir MemoryStore>, … } })` and asserts a
  remembered fact injected into the temp store surfaces in `computePersonaAppend`. Confirm importing
  `main.ts` no longer writes to `~/.claude` (point deps at a temp dir in the test). Then the full gate:
  `pnpm build && pnpm typecheck && pnpm test:headless && pnpm lint`.
- **N10:** `pnpm eval` exits 0 on the goldens and non-zero when a golden is deliberately broken;
  `WORKERKING_EVAL_LLM=1 pnpm eval` runs the judge tier locally (and skips gracefully without Claude).
  `pnpm test:headless` is unaffected (eval is separate).
