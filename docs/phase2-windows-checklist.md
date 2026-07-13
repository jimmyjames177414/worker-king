# Phase 2 — Windows verification checklist

The voice slices can't be exercised in the headless dev container (no mic, audio,
or WebRTC), so their **logic** is unit-tested and the **live behavior** is verified
here on Windows. Screen awareness (Track S) is already verified end-to-end in-container.

## Setup (once)

1. On Windows: `pnpm install && pnpm build`.
2. Put your OpenAI API key in the OS keychain via the app (Settings, once the
   settings UI lands in Phase 4) — or temporarily via `safeStorage` under the
   `openai` secret. Voice needs it to mint ephemeral keys.
3. Ensure Claude Code is logged in (`claude` → `/login`) for the chat brain.
4. Launch: `pnpm --filter @workerking/app dev`.

## 2.0 — Voice foundation
- [ ] Press the global hotkey (default `Ctrl+Shift+Space`). The avatar goes to
      **listening**; speak; you hear a spoken reply and the avatar shows **talking**.
- [ ] Press the hotkey again to end the session (avatar returns to **idle**).
- [ ] The real OpenAI key never appears in the renderer (only `ek_...` ephemeral
      secrets cross to the overlay).

## 2.1 — Live captions
- [ ] While talking, a caption bubble appears above the avatar with what you said
      (blue) and what it replied (dark), then fades.

## 2.2 — Audio-reactive avatar + barge-in
- [ ] The avatar **pulses/scales with the voice** while it speaks (mouth effect).
- [ ] Talking over it **cuts it off** mid-sentence (barge-in) and it starts
      listening again.

## 2.3 — Wake word (opt-in)
- [ ] With `wakeWordEnabled` off (default), nothing listens until you press the hotkey.
- [ ] Turn `wakeWordEnabled` on: the mic opens (browser mic permission granted once).
- [ ] **Remaining step (needs a model):** the default detector is a no-op. Drop in an
      openWakeWord ONNX model + melspectrogram front-end in
      `packages/app/src/renderer/overlay/WakeWord.ts` (replace `NullWakeWordDetector`),
      then verify that saying "Hey WorkerKing" starts a session.

## Track S — Screen awareness (already verified in-container; confirm on Windows)
- [ ] With `screenAwareness` on, ask (chat or voice) "what's on my screen?" — Claude
      calls `capture_screen`, and the real screenshot/window title comes back from
      Electron main (`desktopCapturer`).
- [ ] With `screenAwareness` off, Claude reports the feature is disabled.

## Phase 4 — settings, cards, capability discovery

### Settings window (⚙ in the chat header)
- [ ] Enter your OpenAI API key → shows "✓ saved"; voice now works (key never
      appears in the renderer, only ephemeral `ek_...`).
- [ ] Change assistant name / personality / model / hotkey / toggles → persists and
      takes effect live (next chat/voice reply reflects the new persona; new hotkey binds).
- [ ] `screenAwareness` / `wakeWordEnabled` toggles reach the daemon/overlay.

### Character cards
- [ ] Import a SillyTavern `chara_card_v2` JSON → name + personality change; the next
      reply speaks in that persona. (Verified in-container via golden tests; confirm the
      file picker + live reload on Windows.)

### Capability discovery (verified in-container; confirm on Windows)
- [ ] Add a new `SKILL.md` under `~/.claude/skills/...` → within a moment the daemon
      re-broadcasts the manifest and the voice model can route to it (no restart).

## Phase 7 — proactive & productivity (daemon side verified in-container; confirm on Windows)

Reminders, the notify tool, and proactive watches are verified end-to-end against real Claude
(Claude set a 1s reminder → it fired → proactive.notify; a watch produced a heads-up / stayed
quiet on NONE). On Windows, confirm the surfaced experience:
- [ ] "Remind me in 2 minutes to stretch" → 2 min later you get a Windows toast + (if voice is on)
      it speaks the reminder. Survives an app restart.
- [ ] Ask it to do something long → it can proactively `notify` you when done (toast + caption).
- [ ] Turn on "Proactive heads-ups" in Settings (uses Claude quota on a timer) → it checks your
      calendar every few minutes and speaks up before events.
- [ ] Select text anywhere, press the "Explain selection" hotkey (default Ctrl+Shift+E) → WorkerKing
      explains/acts on it (toast + spoken).

## Phase 5 — WSL bridge + free/local voice (orchestration verified; confirm on Windows)

### WSL bridge
- [ ] Set Claude host to WSL (or `auto` with Claude only in WSL) → the daemon spawns via
      `wsl.exe` and the UI reaches it over `localhost`. Native and WSL behave identically.
- [ ] Sleep the machine and resume → the overlay/chat reconnect automatically (powerMonitor
      → `wk:reconnect`). Tip: add `[wsl2] networkingMode=mirrored` to `.wslconfig` for robustness.

### Free/local voice (offline, ~$0/min — the cascade orchestration is verified in-container)
The provider (LocalCascadeProvider) + Claude-as-voice-brain loop is verified here with fake engines
(transcript "two plus two" → Claude → TTS "4"). The real audio engines are an opt-in install:
- [ ] Install the offline engines: `pnpm --filter @workerking/app add @ricky0123/vad-web @huggingface/transformers kokoro-js`.
- [ ] Set voice provider to "local-cascade" in Settings → talk fully offline: Silero VAD + Whisper
      STT + Kokoro TTS, with Claude doing the thinking (and still delegating heavy tasks).

## Phase 6 — memory & learning (verified in-container; confirm on Windows)

Both memory flows are verified end-to-end against real Claude in the container
(remember→recall across sessions; nightly consolidate distilled "switched to Cursor").
On Windows, confirm:
- [ ] Tell it a preference ("remember I use Cursor") → it calls `remember`; in a later
      session it recalls it unprompted. Check `~/.claude/workerking/memories.md` (hand-editable).
- [ ] Toggle "Remember things about me" off in Settings → `remember` refuses.
- [ ] Over real use, watch for self-authored skills appearing under `~/.claude/skills/`
      (the persona nudges Claude to save repeated multi-step tasks).

## Phase 3 — voice delegation (daemon side verified in-container; confirm spoken)

The full delegate → progress → done path is verified end-to-end against real Claude in
the container (delegate_to_worker → task_id → task.progress → task.done "51"). On Windows,
confirm the *spoken* experience:
- [ ] Say "rename my screenshots by date" (or any real task) → WorkerKing says a filler
      ("On it"), you can keep talking, and it speaks progress then the final result.
- [ ] Ask "how's that going?" mid-task → it answers from check_task_status.
- [ ] Say "stop that" → cancel_task aborts the run.
- [ ] Talking over a spoken result interrupts it (barge-in), and progress updates don't
      trample your speech (turn-gated injection).
