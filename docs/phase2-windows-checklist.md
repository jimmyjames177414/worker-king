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
