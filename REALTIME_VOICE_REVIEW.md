# Realtime Voice Implementation — Technical Review

Reviewer stance: senior realtime-audio / conversational-AI engineering review. Every claim is
grounded in the code as read on branch `main` (2026-07-16). Where I'm inferring behavior of an
external SDK rather than reading it, I say so.

Scope reviewed: `packages/voice-providers/*` (GptRealtimeProvider, LocalCascadeProvider,
localEngines, createRealtimeSessionFactory), `packages/app/src/renderer/overlay/*` (VoiceHost,
WakeWord, main.ts), `packages/app/src/renderer/shared/wsClient.ts`,
`packages/app/src/main/RealtimeKeys.ts` + IPC wiring, `packages/shared/src/speech.ts`
(SentenceChunker, sanitizeForSpeech), and the daemon side of `voice.tool_call`
(`packages/core/src/supervisor/Supervisor.ts:118-146`).

---

## 1. TLDR

**Verdict: keep the architecture, apply targeted fixes. Do not rebuild.** The two-provider design
(WebRTC realtime vs. local cascade behind one `VoiceProvider` interface), the ephemeral-key
security model, and the async-race hygiene (epoch guards everywhere) are genuinely well done —
better than most production voice pipelines I review. The gaps are operational, not structural:
**session-lifetime handling is designed but never wired** (`recycleSession` has zero call sites),
there is **no recovery when the realtime session drops**, and the cascade path has a likely
**echo/self-barge-in** problem that only a real-hardware test will confirm.

---

## 2. What's already GOOD

These are worth calling out explicitly because they're the reason "rebuild" is the wrong answer:

- **Ephemeral key minting done right.** The real OpenAI key lives only in Electron main
  (safeStorage); the renderer gets a short-lived `ek_...` client secret via IPC
  (`RealtimeKeys.ts:17-46`, `preload/overlay.ts:24`). This is the textbook pattern for
  client-side WebRTC realtime, including handling both old and new response shapes
  (`RealtimeKeys.ts:41-44`) and a real unit-test suite (`RealtimeKeys.test.ts`). Confidence: High.
- **WebRTC as the GPT transport.** `createRealtimeSessionFactory.ts` uses
  `@openai/agents-realtime`'s default WebRTC transport in the renderer. Correct call: WebRTC gives
  you jitter buffering, echo cancellation, and mic capture for free; a hand-rolled WebSocket/PCM
  path would re-invent all of it worse. Confidence: High.
- **The provider seam is clean and testable.** `GptRealtimeProvider` carries no SDK imports; the
  concrete session is injected via `SessionFactory` (`GptRealtimeProvider.ts:29-45`), so the
  orchestration is unit-tested headless with fakes (`GptRealtimeProvider.test.ts`,
  `LocalCascadeProvider.test.ts`). Same for VAD/STT/TTS engines
  (`LocalCascadeProvider.ts:18-41`). This is the seam that makes every fix below incremental.
- **Consistent epoch-guard discipline.** Stale-async invalidation is handled the same way at every
  layer: `turnEpoch` for barge-in-stale replies (`VoiceHost.ts:29, 183, 227, 242`), `startEpoch`
  for stop-during-start (`VoiceHost.ts:106, 147, 195`), `speakSeq` against the TTS state-flap
  (`LocalCascadeProvider.ts:98, 118`), synthesis-epoch in `KokoroTtsEngine`
  (`localEngines.ts:82, 91-93`), `enableEpoch` in `WakeWordController` (`WakeWord.ts:105-121`).
  This is the hardest class of bug in voice UIs and it's handled deliberately. Confidence: High.
- **Sentence-streamed TTS in the cascade.** `SentenceChunker` (`speech.ts:63-108`) emits sentences
  as deltas stream, code-fence-aware and abbreviation-aware, so speech starts on the first sentence
  (`VoiceHost.ts:234-238`) — turning turn latency from sum(STT+LLM+TTS) toward max(...). This is
  the established cascade pattern, implemented correctly. Confidence: High.
- **Single serialized speak queue.** All speech (streamed sentences, task progress, proactive
  notices) funnels through one promise chain (`VoiceHost.ts:126-132`), so utterances can never
  overlap. Simple, correct.
- **WS-bus robustness.** `WsClient` reconnects with capped exponential backoff, re-fetches
  port+token on every retry (daemon restarts mint new ones), aborts stale-socket listeners, and
  buffers outbound messages until `welcome` (`wsClient.ts:127-167`). Solid.
- **Latency instrumentation exists.** End-of-speech → first-token → total is logged per turn
  (`VoiceHost.ts:255-260`). Most teams add this after the first latency complaint; it's already here.
- **Speech sanitation.** `sanitizeForSpeech` (`speech.ts:14-51`) strips markdown, code fences, and
  `<think>` blocks before TTS. Small thing, big perceived-quality win.

---

## 3. Findings

| # | Area | Issue | Severity | Recommendation | Confidence |
|---|------|-------|----------|----------------|------------|
| 1 | Robustness (GPT) | `recycleSession()` is declared (`VoiceProvider.ts:63`) and implemented (`GptRealtimeProvider.ts:130-136`) but **never called anywhere** (verified by repo-wide grep — only tests reference it). OpenAI Realtime sessions have a hard lifetime cap (~30 min today, subject to change); when it hits, the session dies mid-conversation with no handling beyond the generic error path. The implementation also discards conversation context on recycle (fresh `start()`, no reseed — the comment at :132 admits the rolling summary is "a later slice"). | **High** | Wire a recycle trigger: a conservative timer (e.g. 25 min) plus handling of the SDK's session-end/expiring events. Reseed with a rolling summary in the new session's instructions before cutting over. | High (grep + code) |
| 2 | Robustness (GPT) | No recovery when the realtime session errors or the WebRTC connection drops. `wireEvents` maps `error` → state `'error'` + `onError` (`GptRealtimeProvider.ts:92-96`); `VoiceHost` just logs and broadcasts the state (`VoiceHost.ts:186-189`). The WS bus self-heals; the voice session does not — the user must toggle off and on manually. Network blips (Wi-Fi roam, sleep/resume) kill voice silently. | **High** | On error/close while `active`, attempt one automatic restart (re-mint key, fresh session) with a short backoff; surface a caption/spoken notice if it fails. The `startEpoch` machinery already makes a safe restart path possible. | High |
| 3 | Latency/cost (GPT) | `injectAssistantContext` = `session.sendMessage(text)` (`GptRealtimeProvider.ts:111-119`). Task progress and results are injected as **user-role messages**, so the model generates a fresh response to each one: paraphrase drift, extra audio-out tokens billed per injection, and possible collision with an in-flight model turn (the comment at :113 acknowledges this is interim). A chatty long task = many injected turns = surprising realtime-API spend. | Medium | Move to out-of-band responses (`response.create` with instructions / the SDK's OOB mechanism), gated to turn boundaries — the standard pattern for speaking app-originated text in a realtime session. Phase 3 apparently plans this; treat it as a cost bug, not just polish. | High on mechanism; Medium on exact SDK API surface |
| 4 | Interruptibility (cascade) | Likely **echo self-barge-in**: Kokoro plays through the speakers (`localEngines.ts:94-108`) while Silero VAD listens on the mic (`localEngines.ts:42-47`). If AEC doesn't fully cancel the TTS output, `onSpeechStart` fires and the provider kills its own playback (`LocalCascadeProvider.ts:55-65`) — the assistant interrupts itself. Nothing in the code verifies `echoCancellation` constraints on the MicVAD stream or guards half-duplex. Comments say the real-engine path is untested on hardware (`localEngines.ts:20-22`). | **High** (if it reproduces) | On the Windows test pass: verify MicVAD's `getUserMedia` constraints include `echoCancellation: true`; add a guard while state is `'talking'` (e.g. require sustained speech energy/frames before treating it as barge-in, a standard half-duplex heuristic). | Medium — flagged from code reading, not a repro; hardware test will settle it |
| 5 | UX/correctness (wake word) | Wake word calls `voiceHost.toggle()` (`overlay/main.ts:112-115`): a detection while a session is **active stops the session**. The wake mic also stays open during the voice session (two live mic captures), and the detector can hear the assistant's own TTS. | Medium | Make wake-word start-only (`if (!active) start()`), and suspend the `WakeWordController` while a voice session is active. | High |
| 6 | Latency (cascade) | Sentence synthesis is not pipelined with playback. The speak chain awaits `tts.speak()`, which includes playback (`localEngines.ts:98-108`), so Kokoro synthesis of sentence N+1 starts only after sentence N finishes playing — every inter-sentence gap ≈ one synthesis time. | Medium | Prefetch: synthesize sentence N+1 while N plays (split `speak` into `synthesize()` + `play()`; keep the single play queue). Standard cascade optimization, fits the existing interfaces. | High |
| 7 | Robustness (cascade) | `awaitChatReply` resolves `''` on its 60 s timeout (`VoiceHost.ts:263-278`), and all speak-chain errors are swallowed (`.catch(() => {})`, `VoiceHost.ts:131, 230`). A brain that hangs or a TTS that throws produces silence with no user-visible or spoken error. | Medium | On timeout/error, speak a short failure notice ("Sorry, that didn't go through") and emit `voice.state` error; keep the chain-protection catch but log the error it swallows. | High |
| 8 | Privacy | `setMicEnabled(false)` never releases capture: GPT path calls `session.mute(true)` (`GptRealtimeProvider.ts:126-128`), cascade just sets a flag while VAD keeps the mic open (`LocalCascadeProvider.ts:127-129`). OS mic indicator stays lit while "muted". | Low–Medium | Acceptable short-term (fast unmute); document it, or stop tracks on mute for the cascade where re-acquisition is cheap. | High |
| 9 | Latency (cascade) | Whisper STT is whole-utterance, non-streaming, on CPU via onnxruntime-web (`localEngines.ts:59-67`). Expect noticeable seconds of dead air between end-of-speech and first audio on modest hardware; there's no measured number yet. | Low–Medium | Ship the existing latency log (N7) through the cascade path on real hardware first; if it's bad, `distil-whisper`/smaller model or the documented faster-whisper sidecar — the `SttEngine` seam makes this a drop-in. Don't build streaming STT yet. | Medium (no perf data — this is an expectation, not a measurement) |
| 10 | Transcript UX (GPT) | Only final transcripts are surfaced — `history_added` items (`GptRealtimeProvider.ts:76-82`), always `final: true`. The delegate interface supports partials (`VoiceProvider.ts:28-29`) but nothing emits them, so captions appear late and all-at-once. | Low | Subscribe to the SDK's delta/partial transcript events when polishing captions. Cosmetic; fine to defer. | High |
| 11 | Correctness (cascade) | Concurrent `onUtterance` calls aren't serialized (`LocalCascadeProvider.ts:70-82`): two quick utterances → two parallel `transcribe()` calls that can resolve out of order, delivering transcripts (and thus brain turns) out of order. `turnEpoch` makes the *newer* turn win, so damage is bounded, but the older reply may briefly speak. | Low | Chain utterance processing through a promise queue like `speakChain`, or drop a pending STT when a newer utterance completes. | High on the race; Medium on real-world frequency (VAD gaps make it rare) |
| 12 | Code quality (wake word) | `ScriptProcessorNode` is deprecated (`WakeWord.ts:128`, acknowledged in the comment at :126-127). | Low | Move to `AudioWorklet` when the real detector lands; not before. | High |

**Scalability & cost note:** this is a single-user desktop app — there is no server fan-out to
break under load. The real cost exposure is (a) realtime-session minutes on the GPT path, and
(b) finding #3, where every injected progress line buys a full model response including billed
audio output. Fixing #3 and wiring #1 (so sessions don't idle past their useful life) covers the
cost story. The local cascade is $0/min by design, paid for in latency (finding #9).

---

## 4. Prioritized action list

1. **Wire session-lifetime handling (finding #1).** Recycle on a timer + SDK session-end events,
   with a rolling-summary reseed. This is the one gap that guarantees a mid-conversation failure
   for any session that runs long enough. The method already exists; it just has no caller.
2. **Auto-recover the voice session on error/drop (finding #2).** One retry with backoff plus a
   user-visible notice. The epoch machinery makes this a small, safe change.
3. **Fix wake-word toggle + double mic (finding #5).** Small change (`toggle` → start-only, pause
   controller while active), prevents a genuinely confusing UX failure once a real detector lands.
4. **Hardware-verify cascade barge-in vs. echo (finding #4)** before shipping local voice; add the
   half-duplex guard if AEC isn't sufficient. Do this in the same Windows test pass the code
   comments already plan.
5. **Replace `sendMessage` injection with out-of-band responses (finding #3).** Cost + correctness,
   already on the Phase 3 roadmap — keep it there, don't let it slip.
6. **Pipeline Kokoro synthesis ahead of playback (finding #6)** — biggest cheap win for cascade
   fluidity.
7. **Surface silent failures (finding #7)** — spoken/visual error on chat-reply timeout and speak
   failures.
8. Batch the small stuff opportunistically: partial transcripts (#10), STT serialization (#11),
   mic release on mute (#8), AudioWorklet (#12).

---

## 5. Target architecture

Not applicable — no redesign recommended. The current shape (thin realtime voice model or local
cascade behind `VoiceProvider`, delegating substantive work to the daemon brain over the WS bus,
with the supervisor tool router at `Supervisor.ts:118-146`) is the established
"speech-layer + agent-brain" pattern done properly. Incremental fixes are sufficient because every
finding above lands behind an existing seam: the provider interface, the session factory, the
engine interfaces, or `VoiceHost`'s existing epoch/queue machinery.

## Explicit unknowns / where I'm guessing

- Exact `@openai/agents-realtime` event names and OOB-response API for findings #1–#3 — the
  mechanism is certain, the SDK surface needs checking against the installed version.
- Whether MicVAD's default constraints enable AEC (finding #4) — needs the hardware test.
- Cascade STT/TTS real-world latency (finding #9) — no measurements exist yet; the N7 latency log
  will produce them.
- OpenAI's current session cap duration — I cited ~30 min from general knowledge; verify against
  current docs when wiring #1.
