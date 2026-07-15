# Implement 5 Features/Improvements — WorkerKing

## Context

You asked for a list of things to work on, then chose to **implement all 5**, with #4 (memory)
architected deliberately. I ran three parallel explorations across `core`, `app`/`voice-providers`,
and tooling. The repo is well-architected and further along than its "Phase N" comments suggest — the
gaps are at the edges: UI features the README advertises but never wired, two real reliability bugs,
and missing DX/infra.

For #4 you chose **file-vault + recall tools, semantic-ready**: keep the existing portable JSON +
Markdown "vault" as the source of truth (it's already Obsidian-browsable), expose `recall`/
`list_memories` SDK tools, and put retrieval behind a small pluggable interface so a local embeddings
index can slot in later without touching the store — matching the codebase's stated "portable,
auditable, not a database" design goal.

**Sequencing note:** #2, #3, #4 are fully verifiable headless and should land first. #1 and #5 involve
the Electron renderer / voice / wake-word paths — implementable now, but full end-to-end confirmation
needs a Windows desktop with a mic. Each item is an independent commit on
`claude/feature-ideas-improvements-g1pog8`.

---

## 4. On-demand memory recall for Claude (chosen architecture)

**Current state:** `MemoryStore` (`packages/core/src/memory/MemoryStore.ts`) already has a `recall(query)`
method (substring, line 94) and a `.md` mirror, but Claude has only the `remember` *write* tool
(`packages/core/src/claude/tools.ts:124`). It can't query memory mid-conversation — it sees only the
budget-capped persona summary injected at boot.

**Plan:**
- **Add a pluggable retrieval seam.** Introduce a small `MemoryIndex` interface (e.g.
  `search(query, opts): MemoryEntry[]`) in `packages/core/src/memory/`. Ship a `KeywordMemoryIndex`
  implementation that wraps/extends the existing `recall()` — add scope filtering and simple keyword
  ranking (term-frequency over key+value, live entries first). Keep `MemoryStore` as source of truth;
  the index reads from `store.all()`. This is the seam a future `SemanticMemoryIndex` (transformers.js
  embeddings, derived sidecar file) drops into with no store changes.
- **Add two SDK tools** in `claude/tools.ts`, mirroring the existing audited, feature-flagged pattern
  (`buildMemoryTool`): `recall` (query + optional `scope`, returns ranked matches) and `list_memories`
  (optional `scope` filter, returns all live entries). Gate both behind `memoryEnabled`, audit every
  call, and add their names to `WORKERKING_TOOL_ALLOWLIST` (`tools.ts:217`) and the
  `createWorkerKingToolServer` tool list (`tools.ts:202`).
- **Tests:** extend `packages/core/src/claude/tools.test.ts` and `memory/MemoryStore.test.ts` — ranking
  order, scope filter, disabled-flag behavior, empty store.

**Files:** `packages/core/src/memory/MemoryStore.ts`, new `memory/MemoryIndex.ts`,
`packages/core/src/claude/tools.ts`, tests. **Effort:** Small. Fully headless-testable.

---

## 2. Fix the DaemonSupervisor infinite-restart loop

**Bug:** `DaemonSupervisor` restarts the daemon on *every* exit with no backoff, no max-retry cap, no
crash-loop detection (`packages/app/src/main/DaemonSupervisor.ts:106-110`, `main/index.ts:124-128`) —
a daemon that crashes on startup hot-spawns processes forever. The comment says "attempt one restart";
the code loops.

**Plan:** Add exponential backoff between restarts, a crash-loop guard (e.g. ≥N exits within a rolling
window → stop and surface a fatal state to the UI), and reset the counter after a clean uptime
threshold. Surface "daemon failed to stay up" to the renderer instead of silently thrashing. Add
`DaemonSupervisor.test.ts` (currently zero tests) with a fake spawn to assert backoff timing and the
give-up path.

**Files:** `packages/app/src/main/DaemonSupervisor.ts`, `main/index.ts`, new test. **Effort:** Small–Medium.

---

## 3. GitHub Actions CI + ESLint/Prettier

**Gap:** No `.github/` dir, no CI. The verification gate exists only as the local `/verify` skill. No
lint/format tooling anywhere — yet `/simplify` claims it "re-lints after"
(`.claude/skills/simplify/SKILL.md:3`). A remote now exists (commits reference merged PRs).

**Plan:**
- `.github/workflows/ci.yml`: pnpm 10 + Node 20, `pnpm install --frozen-lockfile`, then
  `pnpm build → pnpm typecheck → pnpm test:headless` on push/PR. Cache pnpm store.
- Add ESLint (typescript-eslint) + Prettier configs and a root `lint` script; add a lint step to CI.
  Keep the initial ruleset lean to avoid a huge first-pass churn. This backs the `/simplify` skill.
- Optional: wire `@vitest/coverage-v8` + a `coverage` script.

**Files:** new `.github/workflows/ci.yml`, root ESLint/Prettier config, `package.json` scripts.
**Effort:** Small–Medium. Protects everything else going forward.

---

## 1. Chat window: task list + persistent transcript + markdown

**Gap:** README/`ChatWindow.ts:6-8` promise a task list + transcript, but the chat renderer only does
ephemeral plain-text streaming bubbles. `task.*` events are consumed only in the overlay's VoiceHost;
nothing restores history on reopen; messages use `textContent` so code blocks render raw
(`chat/main.ts:77,84`).

**Plan:**
- Subscribe to `task.created/progress/done/error` in `chat/main.ts`; render a live task-list panel in
  `chat/index.html`.
- Render assistant messages as Markdown (code blocks, lists). Prefer a tiny, self-contained renderer
  to avoid heavy deps; sanitize output.
- Persist/restore transcript across window reopen (the chat window hides, not destroys). Keep recent
  transcript in the daemon or a small renderer-side store and replay on connect.

**Files:** `packages/app/src/renderer/chat/main.ts`, `chat/index.html`; task kinds already in
`packages/shared/src/protocol.ts`. **Effort:** Medium. Highest visible payoff. Full confirmation needs
the Electron app (Windows).

---

## 5. Voice-provider switch in Settings + wake-word wiring

**Gap:** (a) `voiceProvider` (gpt-realtime vs local-cascade) is consumed by VoiceHost but has no
control in the settings panel (`renderer/chat/Settings.ts`) — can't switch to local voice from the UI.
(b) Wake word is fully built except the model: `NullWakeWordDetector.process()` always returns `false`
(`overlay/WakeWord.ts:26-33`); the mic/framing pipeline is real.

**Plan:**
- Add a voice-provider dropdown (and, if straightforward, mic/output device pickers) to `Settings.ts`,
  writing the existing `voiceProvider` config key.
- Replace `NullWakeWordDetector` with a real detector (openWakeWord or similar) behind the existing
  interface, gated by the `wakeWord` flag.

**Files:** `packages/app/src/renderer/chat/Settings.ts`, `packages/app/src/renderer/overlay/WakeWord.ts`.
**Effort:** Provider-switch = Small (UI-only, headless-buildable). Wake-word model = Medium; needs a
Windows+mic machine to verify end-to-end.

---

## Verification

Everything lands behind the standard gate — `pnpm build && pnpm typecheck && pnpm test:headless` (the
`/verify` skill) — plus the new `pnpm lint` from #3.

- **Fully headless-verifiable:** #4 (memory tools/ranking), #2 (supervisor backoff via fake spawn), #3
  (CI runs the gate itself).
- **Needs Windows + Electron for full confirmation:** #1 (chat UI), #5 (voice switch renders headless;
  wake-word capture needs a mic). These get unit/build coverage now; end-to-end is a Windows manual pass
  (see `docs/phase2-windows-checklist.md` pattern).

Each item is committed separately on `claude/feature-ideas-improvements-g1pog8` and pushed with
`git push -u origin`.
