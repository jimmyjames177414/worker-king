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
method (substring, line 94) and a `.md` mirror, but Claude has only the `remember` _write_ tool
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

**Bug:** `DaemonSupervisor` restarts the daemon on _every_ exit with no backoff, no max-retry cap, no
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

---

# Batch 2 — 5 more features (same branch/PR)

## Context

Batch 1 (above) is implemented, pushed, and green. You asked for 5 more on the same PR and chose a
**balanced blend** of reliability and visible wins. These target the remaining real gaps I confirmed by
reading the code: config that doesn't survive a headless restart, WS sockets that leak when a peer goes
half-open, memory recall that's keyword-only, ad-hoc unstructured logging, and no audio-device choice.
Four are fully headless/CI-verifiable; device pickers build and unit-test headless but need a Windows+mic
for full end-to-end. Each is an independent commit; all land behind the standard gate
(`build → typecheck → lint → test:headless`), and CI (batch 1 #3) now enforces it.

---

## 6. Config persistence in core (durability — headless-testable)

**Gap:** `ConfigStore` (`packages/core/src/config/ConfigStore.ts:62`) is purely in-memory — a headless
daemon loses all config (incl. `userName`, imported `characterCard`) on restart. In the full app,
Electron re-pushes config, but standalone `pnpm daemon` runs start from defaults every time.

**Plan:** Add optional file backing, mirroring `MemoryStore`'s pattern (JSON under
`~/.claude/workerking/config.json`). Constructor takes `{ dir?, persist? }`; `load()` on boot merges the
file over defaults; `set()` writes best-effort (never throw). Keep it opt-in so tests and the
app-proxied path can disable persistence. Wire `main.ts` to construct the persistent store.

**Files:** `config/ConfigStore.ts`, `core/src/main.ts`, extend `config/*.test.ts` (set → reload →
value survives; corrupt file → defaults).

---

## 7. WS server heartbeat + dead-socket reaping (reliability — headless-testable)

**Gap:** `ws/server.ts` answers `ping` (`:136`) but never _initiates_ keepalive and has no
`isAlive`/`terminate()` sweep. A half-open socket (WSL localhost drop after sleep — the exact case the
client comments cite) leaves a stale entry in the `clients` map indefinitely.

**Plan:** On `registerClient`, mark `isAlive=true`; on `pong`, refresh it. A periodic interval pings all
clients and `terminate()`s any that didn't answer the previous round, deleting them from `clients`.
Make the interval/clock injectable so tests are deterministic; clear the timer on server close.

**Files:** `core/src/ws/server.ts`, `ws/server.test.ts` (a silent socket gets reaped; a ponging one
survives).

---

## 8. Semantic memory search (capability — builds on the batch-1 seam)

**Gap:** Recall is keyword-only (`KeywordMemoryIndex`, shipped in batch 1). The `MemoryIndex` seam was
built precisely so a semantic backend could drop in without touching the store.

**Plan:** Add `SemanticMemoryIndex implements MemoryIndex` using **optional** local embeddings —
`@huggingface/transformers` (all-MiniLM-style), dynamically imported exactly like `localEngines.ts`
(`voice-providers/src/localEngines.ts:24`) so it's not a build/runtime dep. Embed each live entry
(cached by key+ts), rank by cosine similarity. Add a `createMemoryIndex(store, config)` factory gated by
a new `semanticMemory` config flag that **falls back to `KeywordMemoryIndex`** when the flag is off or
the lib/model is absent — so CI and default runs use the keyword path. Point the `recall` tool
(`claude/tools.ts`) at the factory.

**Files:** `memory/MemoryIndex.ts` (+ factory), `claude/tools.ts`, new `semanticMemory` config key,
`memory/*.test.ts` (cosine ranking with an **injected fake embedder**; fallback when embedder absent).
**Note:** the real model download/quality is the one part needing a manual check; the fallback keeps it
safe by default.

---

## 9. Structured leveled logger (observability — headless-testable)

**Gap:** Logging is ad-hoc `process.stderr.write("[workerking] …")` (6 sites in `core/src/main.ts`) —
no levels, timestamps, or structure. `fileLog.ts` already tees stderr to a file, so a logger writing to
stderr is captured automatically.

**Plan:** Small `logger.ts` — `debug/info/warn/error`, ISO timestamp + level + scope prefix, level
threshold from `WORKERKING_LOG_LEVEL`, optional JSON lines via `WORKERKING_LOG_JSON`. Pure and
injectable sink for tests. Replace the ad-hoc writes in `main.ts` and adopt in a few hot modules
(supervisor/brain/proactive). Keeps flowing through `installFileLog` unchanged.

**Files:** new `core/src/util/logger.ts` + `logger.test.ts`, `core/src/main.ts` (+ light adoption).

---

## 10. Audio device pickers (feature — UI headless-buildable, full check needs mic)

**Gap:** No mic-input or audio-output device selection anywhere; `getUserMedia` requests the default
device (`overlay/WakeWord.ts:108`), and there's no output routing.

**Plan:** Add `inputDeviceId` / `outputDeviceId` config keys (to **both** `WorkerKingConfig`
(`config/ConfigStore.ts`) and the app's `AppConfig` + `CONFIG_KEYS` (`main/index.ts`) — config is
duplicated across those two). In `Settings.ts`, enumerate devices via
`navigator.mediaDevices.enumerateDevices()` and render input/output dropdowns (reuse the existing
`data-cfg` wiring). Consume `inputDeviceId` as a `getUserMedia({ audio: { deviceId } })` constraint in
`WakeWord.ts` (and the voice host where controllable); apply `outputDeviceId` via
`HTMLMediaElement.setSinkId` on TTS playback.

**Files:** `config/ConfigStore.ts`, `app/src/main/index.ts`, `renderer/chat/Settings.ts`,
`renderer/overlay/WakeWord.ts` (+ voice host). Dropdowns/build verify headless; device switching itself
needs a Windows desktop + mic.

---

## Batch 2 verification

Same gate as batch 1. Fully headless-verifiable: **#6, #7, #8 (fallback path), #9**. Needs Windows+mic
for full confirmation: **#10** (UI + config wiring still build/typecheck/lint clean and unit-test
headless). Each item is a separate commit on `claude/feature-ideas-improvements-g1pog8`.
