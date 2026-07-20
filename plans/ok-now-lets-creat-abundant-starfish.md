# Apply all 12 realtime-voice review findings + main-brain environment context

## Context

`REALTIME_VOICE_REVIEW.md` (repo root) reviewed the voice pipeline and concluded: keep the
architecture, apply 12 targeted fixes. This plan implements every one (Part A). The big four: wire
the never-called `recycleSession` (sessions die at OpenAI's ~30-min cap), auto-recover on session
drop, replace user-role `sendMessage` injection with out-of-band responses (cost + correctness),
and guard the local cascade against echo self-barge-in.

Part B adds the **main-brain environment context**: teach the daemon brain OS-level facts — repo
roots on Windows (`C:\_repos`) and WSL (`\\wsl.localhost\Ubuntu-22.04\home\jamesamiller\repos`),
what repos actually exist there, and how to resolve "open X" / "do this task in folder Y" —
plus per-task working directories so a delegated task can run in a different repo than the chat's
active project.

**Where it hooks in (verified):** `ClaudeBackend.buildOptions()` builds every query (chat AND
delegated tasks) from the same `personaProvider` + `cwdProvider` seams
(`packages/core/src/claude/ClaudeBackend.ts:104-133`); `computePersonaAppend()` /
`buildAmbientContext()` in `packages/core/src/main.ts:132-175` is the single prompt-assembly
point (persona → memory summary → ambient context). Config schema/defaults live in
`packages/shared/src/domain.ts` (`workerKingConfigSchema:220`, `DEFAULT_CONFIG:275`), flow
Settings UI → `config.set` → `ConfigStore.set` (with `isValidClaudeCwd`-style validation) →
`config.changed` broadcast. Tasks currently get **no cwd of their own** — `TaskManager.create`
passes only the prompt and `ClaudeBackend.run()` reuses the global `claudeCwd`
(`TaskManager.ts:66-94`, `ClaudeBackend.ts:228`). `settingSources: []` (ClaudeBackend.ts:123)
means repo CLAUDE.md files are deliberately NOT loaded, so environment knowledge must come
through the prompt seam.

**SDK reality check** (verified against installed `@openai/agents-realtime@0.13.2` .d.ts):
- No first-class close/expired session events → use a 25-min timer + `session.transport.on('connection_change')` (`'disconnected'`) for drop detection; raw server events reach `session.on('transport_event', e)` (string-match `e.type`).
- `sendMessage` is always user-role and triggers a response → OOB fix is `session.transport.requestResponse({ conversation: 'none', instructions })`. OOB responses don't enter history, so the rolling summary for recycle must log injected lines itself.
- User input transcription requires `audio.input.transcription` in session config (factory change) — today user transcripts via `history_added` may be a latent gap.
- Reusing a closed `RealtimeSession` isn't guaranteed → new instance per recycle/recovery (the existing `SessionFactory` pattern already supports this).
- No `packages/shared/src/protocol.ts` changes needed: `voice.transcript` already carries `final`; chat filters finals; captions overwrite.

Reuse throughout: the repo's epoch-guard pattern (`turnEpoch`/`startEpoch`/`speakSeq`/`enableEpoch`), `speakChain` promise-queue pattern, `SentenceChunker`, `sanitizeForSpeech`.

## Slices (one commit each, in order)

### 1. Foundation — extend `RealtimeSessionLike` + factory config
`packages/voice-providers/src/GptRealtimeProvider.ts`, `createRealtimeSessionFactory.ts`, `GptRealtimeProvider.test.ts`
- Add optional `transport?: RealtimeTransportLike` to `RealtimeSessionLike`; `RealtimeTransportLike` = `{ on(event, handler); requestResponse(payload); updateSessionConfig(cfg) }`. Provider degrades gracefully when absent (minimal fakes stay valid).
- Factory: pass `config: { audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe' } } } }` to `new RealtimeSession(...)` (verify exact key shape against .d.ts while implementing).
- Tests: `FakeTransport` (records `requestResponse` payloads, can emit events).

### 2. Finding #3 — OOB injection, turn-gated (GPT)
`GptRealtimeProvider.ts` + tests
- Track model-turn activity via `transport.on('turn_started'/'turn_done')` (fallback: `audio_start`/`audio_stopped`).
- `injectAssistantContext`: sanitize → push to an internal queue; drain one item per turn boundary via `transport.requestResponse({ conversation: 'none', instructions: 'Read this update verbatim…: "<text>"' })`. One-at-a-time drain prevents overlapping OOB audio.
- No transport → fall back to current `sendMessage`.
- Append injected text to the transcript log used by slice 3 (OOB bypasses history).

### 3. Finding #1 — wire `recycleSession` (timer + reseed + new instance)
`GptRealtimeProvider.ts` + tests
- `sessionMaxAgeMs` option (default 25 min). Refactor `start()` into private `openSession(instructions)` shared by start/recycle/recovery.
- `sessionEpoch` guard so stale old-session handlers can't flip state after cutover.
- Rolling summary: capped ring buffer (~40 lines) fed from `history_added` + slice-2 injections; `buildReseedInstructions()` = systemPrompt + "Conversation so far…".
- Recycle gated to turn boundaries (`pendingRecycle` → fire on `turn_done`); `stop()` clears timer/flags.
- Tests with `vi.useFakeTimers`: factory called twice after 25 min, reseeded instructions contain prior lines, deferral while turn active, stop cancels timer.

### 4. Finding #2 — auto-recovery on error/drop
`GptRealtimeProvider.ts`, `VoiceProvider.ts`, `VoiceHost.ts` + tests
- Detect: `connection_change === 'disconnected'` (while active, not intentionally closing) + session `error` → `handleDrop()`.
- One retry: state `'thinking'`, injectable backoff (~1200 ms), `openSession(buildReseedInstructions())`. Failure → close, state `'error'`, `delegate.onError(err, { fatal: true })`.
- Delegate change (backward-compatible): `onError(err, info?: { fatal?: boolean })`.
- `VoiceHost.onError` on fatal: caption `voice.transcript` "Voice connection lost — press the hotkey to restart." then `stop()` + `voice.state error`. (Spoken notice impossible — audio session is dead.)

### 5. Finding #10 — partial transcripts (GPT)
`GptRealtimeProvider.ts` + tests
- Assistant partials: `transport.on('audio_transcript_delta')` → accumulate per `itemId` → `onAssistantTranscript(acc, false)`; clear on final/`audio_interrupted`.
- User partials: `transport_event` with `e.type === 'conversation.item.input_audio_transcription.delta'` / `.completed` → `onUserTranscript(…, false/true)`.
- Dedupe: `history_added` skips user finals already emitted via `completed` (by item id).

### 6. Findings #11 + #4 — cascade STT serialization + half-duplex echo guard
`LocalCascadeProvider.ts`, `localEngines.ts` + tests
- #11: `sttChain` promise queue (mirror of `speakChain`) — in-order transcripts.
- #4 guard: new `bargeIn` options (`sustainedMs≈300`, `minUtteranceMs≈350`). `onSpeechStart` while `talking`: arm timer instead of instant `tts.stop()`; sustained speech → real barge-in; short blip that ends early (< minUtteranceMs of PCM) → drop as echo, TTS keeps playing. Behavior when not talking unchanged.
- #4 engine: `BrowserVadEngine` forwards `additionalAudioConstraints: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }` + optional VAD thresholds to `MicVAD.new` (vad-web not installed locally — per public docs; hardware-verify).

### 7. Finding #6 — pipeline Kokoro synthesis ahead of playback
`LocalCascadeProvider.ts`, `localEngines.ts`, `VoiceHost.ts` + both provider tests
- `TtsEngine` becomes `synthesize(text): Promise<TtsClip>` + `stop()`; `TtsClip = { play(): Promise<void> }`. Kokoro epoch guard covers both stages.
- Provider starts `synthesize` immediately, queues only `play` on an internal `playChain` → synthesis of N+1 overlaps playback of N.
- VoiceHost stops serializing (providers self-serialize now: cascade `playChain`, GPT one-OOB-per-turn from slice 2); keep the `turnEpoch` guard at call sites. **Must come after slice 2.** Biggest refactor; existing `speakSeq` state-flap test must keep passing.

### 8. Finding #8 — mic release on mute (cascade)
`LocalCascadeProvider.ts`, `localEngines.ts` + tests
- `setMicEnabled(false)` → `vad.stop()` (release mic); `(true)` → re-start VAD, `micEpoch`-guarded against rapid toggles. `BrowserVadEngine.stop()` prefers `mic.destroy?.()` over `pause()`.
- GPT path stays `session.mute(true)` — document the tradeoff.

### 9. Finding #7 — surface silent failures
`VoiceHost.ts`, new `VoiceHost.test.ts`
- `awaitChatReply` returns `{ text, timedOut }`; on timeout/speak-error: spoken notice + assistant caption + `voice.state error` + `console.error`.
- Replace both `.catch(() => {})` (VoiceHost.ts:131, 230) with logging catches.
- Enabler: narrow VoiceHost's dep from `WsClient` to a structural `VoiceBus` interface (`on`/`send`/`request`) so tests use a fake bus.

### 10. Findings #5 + #12 — wake word start-only/suspend + AudioWorklet
`overlay/main.ts`, `VoiceHost.ts`, `WakeWord.ts` + tests
- #5: add `VoiceHost.isActive()` + `startIfIdle()`; wake callback uses `startIfIdle`. `main.ts` policy: wake controller enabled iff `wakeWordEnabled && !voiceActive` (derived from `voice.state`) — fixes toggle-off, double mic, and TTS self-hearing. Extract pure `shouldWakeListen(enabled, voiceState)` helper for a table test.
- #12: AudioWorklet tap (inline processor via Blob URL, port posts copied Float32 blocks into the existing `FrameChunker`); `ScriptProcessorNode` kept as fallback when `ctx.audioWorklet` is undefined. `enableEpoch` already covers the extra await.

### 11. Finding #9 — cascade stage instrumentation + docs
`LocalCascadeProvider.ts`, `localEngines.ts`
- Log `[voice] stt latency: <ms> for <s>s audio` and `[voice] tts synth: <ms> for <chars> chars`; composes with the existing N7 turn line into a full stage breakdown.
- Document in `localEngines.ts` header: whisper-base CPU ≈ seconds is expected; upgrade path is the `SttEngine` seam (`whisperModel` option / faster-whisper sidecar) — decide after real numbers.

## Part B — Main-brain environment context

### 12. Environment config: repo roots + notes
`packages/shared/src/domain.ts`, `packages/core/src/config/ConfigStore.ts`, `packages/app/src/renderer/chat/Settings.ts`
- Schema: `repoRoots: z.array(z.string()).optional()` with default
  `['C:\\_repos', '\\\\wsl.localhost\\Ubuntu-22.04\\home\\jamesamiller\\repos']` in `DEFAULT_CONFIG`,
  plus `envNotes: z.string().optional()` (free-text user rules, e.g. "work repos live in X; prefer WSL for Y").
- `ConfigStore.set` validation for `repoRoots`: drop entries whose dir doesn't exist (warn), mirroring `isValidClaudeCwd` (ConfigStore.ts:40-48).
- Settings UI: textarea for repo roots (one per line) + notes field next to the existing "Project folder" input (`Settings.ts:101`, reuse the `data-cfg` binding → `bridge.setConfig` flow).

### 13. `EnvironmentContext` module + ambient injection
New `packages/core/src/environment/EnvironmentContext.ts` (+ test), `packages/core/src/main.ts`
- Scans each configured root (top-level dirs only, `fs.readdir` with `withFileTypes`), caches ~5 min, tolerates unreachable roots (UNC/WSL down → skip with a note, never throw).
- `buildEnvironmentBlock()` emits: OS + `claudeHost` mode, each root with its repo listing (capped, e.g. 40 names/root), `envNotes`, and resolution rules: *"When asked to open or work in a repo/folder by name, resolve it against these roots (exact then fuzzy match). To open a folder/app on Windows use `explorer.exe <path>` / `start`; WSL paths are reachable from Windows via the `\\wsl.localhost` UNC form."*
- Inject via `buildAmbientContext()` (main.ts:132-147) so it reaches chat **and** delegated tasks through the existing `personaProvider` seam — zero ClaudeBackend changes.
- Injectable fs/clock for headless tests (fake dirent lists, cache expiry).

### 14. Per-task working directory (`delegate_to_worker` folder targeting)
`packages/core/src/supervisor/Supervisor.ts`, `packages/core/src/supervisor/TaskManager.ts`, `packages/core/src/claude/ClaudeBackend.ts`, `packages/app/src/renderer/overlay/VoiceHost.ts` (+ tests)
- `resolveRepoPath(nameOrPath, roots)` helper in `EnvironmentContext`: absolute existing path → itself; else exact then case-insensitive prefix match of top-level dirs across roots; ambiguous/missing → error listing candidates. Unit-tested with fake fs.
- Thread `cwd` structurally: `TaskManager.create(prompt, { cwd? })` → `runner.run(prompt, events, signal, { cwd? })` → `ClaudeBackend.run` passes an override to `buildOptions` (one-shot override; does NOT touch `lastCwd`/session state — tasks are already `resume:false`, ClaudeBackend.ts:228).
- `delegate_to_worker` tool gains optional `folder` param (VoiceHost.ts:78-83 schema + description "repo name or absolute path"); `Supervisor.handleVoiceToolCall` (Supervisor.ts:125-130) resolves it via `resolveRepoPath` and passes cwd to `tasks.create`; resolution failure → tool error reply naming candidates (the voice model can ask the user).
- Chat path unchanged: `claudeCwd` remains the chat's project; the env block teaches the model it can delegate folder-scoped tasks.
- Risk noted: UNC cwd (`\\wsl.localhost\...`) for a Windows-spawned Claude process may misbehave in shell tools (cmd.exe rejects UNC cwd) — validate on hardware; if it does, resolution can map WSL-root hits to `claudeHost: 'wsl'` handling later.

## Part C — Global vault integration (context2 / claude-obsidian)

Context2 (`\\wsl.localhost\Ubuntu-22.04\home\jamesamiller\repos\Amethyst\.local\.context2`) is a
clone of **claude-obsidian**: an Obsidian wiki vault maintained by Claude Code — `wiki/index.md`
(structure), `wiki/hot.md` (hot cache: recent-session context, designed to be loaded at session
start), entities/concepts/sources pages, `.vault-meta/locks` (multi-writer advisory locks),
conventions in the vault's own CLAUDE.md/AGENTS.md. Goal: WorkerKing's brain knows the global
vault, consults it for knowledge questions, and can file new knowledge into it by its conventions.

Key constraint: `ClaudeBackend` runs with `settingSources: []` (ClaudeBackend.ts:123), so the
vault's `/wiki` skills are NOT auto-loaded — integration goes through the same prompt seam as
Parts A/B plus the brain's ordinary file tools (UNC read from Windows verified working).

### 15. Vault config + `VaultContext` ambient injection
`packages/shared/src/domain.ts`, new `packages/core/src/environment/VaultContext.ts` (+ test), `packages/core/src/main.ts`, `packages/app/src/renderer/chat/Settings.ts`
- Config: `vaultPath: z.string().optional()` (validated like `claudeCwd` — must exist; UNC ok), Settings field beside Project folder. Default unset; user points it at the context2 vault (or a new global one).
- `VaultContext`: reads `wiki/hot.md` (full, capped ~2000 chars) + `wiki/index.md` (headings/structure, capped), cached with mtime check; unreachable path (WSL down) → skip with note, never throw. Injectable fs for headless tests.
- Inject a "Global knowledge vault" block via `buildAmbientContext()` (main.ts:132-147): vault path, hot-cache excerpt, index outline, and usage rules: *"For knowledge/recall questions, consult the vault first — read relevant pages under `wiki/` and cite them. When you learn something durable, file it into the vault following the vault's own CLAUDE.md conventions (respect `.vault-meta/locks`). Prefer updating existing pages over creating duplicates."*
- Reaches chat AND delegated tasks through the existing `personaProvider` seam (same as Parts A/B). Untrusted-fence the vault excerpts the same way `main.ts:137-145` fences the conversation summary — vault content is data, not instructions.
- Optional follow-up (out of scope here, note only): register the vault as an allowed extra dir / add a `vault_search` supervisor tool with BM25 over pages if prompt-level proves too shallow.

## Verification

**Automated gate — run by the user (node/pnpm not on agent PATH), in order, stop on first failure:**
1. `pnpm build`
2. `pnpm typecheck`
3. `pnpm test:headless`

(= the repo's `/verify` skill.) New tests: FakeTransport (slices 1–5), fake-timer recycle/recovery, deferred FakeStt/FakeTts ordering (6–7), fake VoiceBus (9), `shouldWakeListen` table test (10).

**Manual Windows checks (hardware items):**
- #4: cascade on speakers, long reply → assistant doesn't cut itself off; real interruption (≥0.5 s speech) still barges in; devtools confirms `echoCancellation: true` on the VAD stream.
- #1/#2: set `sessionMaxAgeMs` low → seamless mid-conversation recycle with context; Wi-Fi blip → auto-reconnect; full network kill → "Voice connection lost…" caption + alert avatar, hotkey restarts.
- #3: chatty delegated task → progress spoken verbatim, no full model replies, no overlap with model turns.
- #5/#12: wake word during active session does nothing; wake detection still works via AudioWorklet tap (and via fallback).
- #8: cascade mute → OS mic indicator off; unmute works.
- #9/#10: read stage-latency lines from the log runner; captions stream incrementally on GPT path.
- Part B: "open worker-king" in chat → brain resolves + opens `C:\_repos\worker-king`; voice "run the tests in <wsl repo>" → task spawns with the resolved cwd (watch the UNC-cwd risk); unplug/rename a root → env block degrades gracefully, no crash.
- Part C: set `vaultPath` to the context2 vault → ask a question the vault answers (e.g. something in `wiki/hot.md`) → brain cites vault pages; tell it a durable fact → it files a page per vault conventions; shut down WSL → chat still works, vault block degrades to a note.
