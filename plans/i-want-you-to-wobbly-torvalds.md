# WorkerKing — Refactoring Health Assessment (lessons from `5uck1ess/cicero`)

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
