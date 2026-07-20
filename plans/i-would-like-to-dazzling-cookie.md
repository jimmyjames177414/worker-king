# Architecture Assessment: Unified Voice Hub + Integration Plan

**Date:** 2026-07-20  
**Scope:** Should we rebuild WorkerKing from scratch? How do we make it the voice hub + context consumer for LocalTranscriber and Sprint?

---

## Verdict: Do NOT rebuild. Evolve.

This is the honest answer after examining all three codebases and the current state-of-the-art stack (Pipecat, LiveKit Agents, Tauri v2, OpenAI Realtime 2.1, Live2D Cubism).

WorkerKing's foundations are **better than most production voice pipelines** I've reviewed. A rebuild would spend months recreating things that already work well — session recycling, crash recovery, ephemeral key security, typed WS bus, Claude SDK bridge — and end up at roughly the same place. The gaps are real but targeted, not structural.

---

## Honest Assessment by Layer

### GPT Realtime Provider — Ship-quality

The `GptRealtimeProvider` (`packages/voice-providers/src/GptRealtimeProvider.ts`) is production-grade:

- Session recycling on a 25-min timer, deferred to turn boundaries, with rolling-transcript reseed  
- Auto-recovery on WebRTC drop: one backoff attempt, fresh ephemeral key, reseeded context  
- Out-of-band speech injection via `transport.requestResponse({conversation:'none',...})` — already wired, already gating on turn boundaries  
- Epoch guards everywhere so stale async callbacks can't flip state after cutover  
- 25 unit tests covering all of the above with injected fakes  

**One open item**: `setMicEnabled(false)` calls `session.mute(true)` but leaves the OS mic indicator lit. Acceptable for personal use; document it.

The current OpenAI model config is `gpt-realtime-mini` (`domain.ts` DEFAULT_CONFIG). The production line is now `gpt-realtime-2.1` / `gpt-realtime-2.1-mini`. Audio token pricing: ~$10 input / $20 output per 1M tokens for the mini. At personal-use volumes this is trivial.

### Claude SDK Bridge — The most polished subsystem

`ClaudeBackend.ts` uses `@anthropic-ai/claude-agent-sdk` — not a CLI shell-out. Key facts:
- Inherits your Claude Pro/Max subscription (personal use = fine; ToS only restricts third-party *distribution*)
- `settingSources: []` so hostile repo `.claude/settings.json` can't auto-allow tools  
- Tool gating: `readonly` mode is an allowlist (fail-closed on unknown tools), `gated` mode requires chat-window confirmation  
- Prompt-injection fencing on all external data (`untrusted()`)  
- Streaming, session resume, cost accounting — all real  

**Nothing to change here.**

### WS Bus — Solid

~40 message kinds, all zod-typed. `WsEnvelope` carries `{v, id, kind, ts, payload, replyTo}`. The envelope format matters for the Sprint integration (see below).

### Avatar — Confirmed placeholder, deferred by your choice

The CSS orb is 42 lines and intentionally isolated behind `AvatarController.ts`. The swap seam is clean. Deferring is the right call — wire the integrations first.

### Electron Shell — Right choice for this use case

The online research confirmed: Electron is the pragmatic pick when you need WebRTC "just works," Node in-process (for the Claude SDK), `setIgnoreMouseEvents(true, {forward:true})` for per-region click-through, `globalShortcut`, and `Tray`. Tauri v2 only wins if idle memory is a hard KPI and you're willing to invest in Rust + a cursor-polling click-through workaround + a Node sidecar. For personal use: stay on Electron.

---

## What "Replace Their Realtime Implementations" Actually Means

### For LocalTranscriber

LocalTranscriber's hand-rolled OpenAI Realtime WebSocket session (`RealtimeVoiceSession.cs`, ~600 lines of manual RFC6455 framing) becomes **optional/unused**. Instead:

- WorkerKing registers **LocalTranscriber's existing MCP stdio server** as a capability  
- Claude can call `tail_transcript`, `read_current_transcript`, `list_sessions`, `start_transcription`, `stop_transcription`, `list_known_speakers`, etc.  
- Voice interaction with meeting content = ask WorkerKing, Claude reads the live transcript via MCP  
- **Zero changes to LocalTranscriber's codebase required**

### For Sprint

Sprint's "realtime" is SSE (browser updates from `state/state.json`). It has no voice layer. "Replacing" it means:

1. **WorkerKing → Sprint**: spoken notifications when standup is due, data is stale, etc. (restore the reverted `notify.js` integration — but fix the schema mismatch first)
2. **Sprint → WorkerKing**: standup/sprint state flows into Claude's context so Claude always knows your current work

---

## Interaction Guides

Full example utterances and interaction patterns for each integration:
- **[Sprint ↔ WorkerKing](sprint-interactions.md)** — voice queries, delegation commands, spoken alerts, reminder setting, combined scenarios
- **[LocalTranscriber ↔ WorkerKing](localtranscriber-interactions.md)** — live meeting queries, action items, session management, post-meeting processing, combined scenarios

---

## Sprint Integration — Revised Plan (post dual-assessment)

> **Source:** Two independent assessments compared: WorkerKing-side (my take) and Sprint-side
> (`sprint/sprints-worker-king-intergration-assessment.md`). This section supersedes the original
> "4 Integration Pieces" for the Sprint ↔ WorkerKing work. The LocalTranscriber section below is unchanged.

### Six Hard Truths (Sprint's assessment caught these; they gate everything)

1. **Topology spike first.** Sprint runs in WSL2; the WorkerKing daemon runs Windows-native.
   WSL2 NAT means `127.0.0.1` in WSL2 does NOT reach the Windows loopback by default.
   Before wiring a single call site: run the topology spike (see Step 0 below). If it fails,
   the entire notify.js push direction is blocked until you enable mirrored networking or run the daemon in WSL.

2. **`settingSources: []` breaks "Claude knows my standup."** WorkerKing's SDK brain runs with
   `settingSources: []` for security. This means Sprint's `CLAUDE.md` never loads when Claude delegates
   to the sprint folder. The "do my standup by voice" use case needs an explicit bridge: a Sprint skill in
   `.claude/skills/` that the capability manifest routes to, OR a daemon persona-append carrying the relevant
   `CLAUDE.md` triggers when `claudeCwd` is the sprint repo. Verify this works end-to-end before calling B1 done.

3. **WorkerKing must never write Sprint state directly.** All Sprint state mutations must go through
   Claude (the sanctioned curator) or `POST /api/note`. No WorkerKing tool may write `state.json` directly.

4. **Zero runtime dependencies.** `notify.js` already honors this. Do not pull in
   `@modelcontextprotocol/sdk` for a Sprint MCP shim — hand-roll it (~150 lines stdio JSON-RPC) if needed.

5. **Don't duplicate curation logic.** WorkerKing delegates and narrates; Sprint/Claude curates.
   Never re-implement `focus[]` ordering or diff narration logic in WorkerKing.

6. **Fix the feature flag gate bug first.** `notify.js` currently gates on `config.workerKing.enabled`
   (raw config), violating Sprint's recipe. The fuse `featureEnabled(cfg,'workerKing')` must be the only
   authority. The `config.workerKing` block is sub-config (handshake path, timeout) only.

---

### Ordered Work (combined best-of-both assessment)

**Step 0 — Topology spike (go/no-go; do nothing else until this passes)**

From WSL2, with WorkerKing daemon running Windows-native:
```bash
node -e "require('./bin/notify.js').notify({title:'test',body:'ping',level:'info'}).then(console.log)"
```
Expect `{sent:true}` and the overlay speaks it. If connect fails → topology problem. Resolution options:
- Enable Windows 11 mirrored networking (cleanest), or
- Run the daemon in WSL (`claudeHost: 'wsl'` in WorkerKing config, handshake file at a WSL path)

---

**A1 — Finish the push channel (Sprint → WorkerKing spoken alerts)**
*Effort: S (80% already built). Do after Step 0 passes.*

Files touched (Sprint side only, no WorkerKing changes):
- `config.example.json`: Add `workerKing` sub-config block under top-level keys; document the fuse flag.
- `bin/notify.js`: Change gate to `featureEnabled(cfg,'workerKing')` as the switch; `config.workerKing` is sub-config only.
- `bin/fetch.js` near line 692: After the success toast, best-effort call `notify()` gated on `featureEnabled`. Three call sites:
  1. Diff has new items assigned to you
  2. `prs.reviewing` is non-empty (PR review needed)
  3. `guardTripped` is true (snapshot not updated — warn, don't speak)
- `test/`: Add offline unit cases for `notify.js`: handshake missing, fuse off, text-frame length paths.

---

**A2 — TTS-shaped voice digest (before wiring any spoken output)**
*Effort: M. Build this before A1 goes live or the audio output will be raw JSON.*

Add a STAGES step to `fetch.js` behind `features.standupScript` that builds `state/script.json`:
- Speech-optimized narration derived from `focus[]` + diff summary
- No ADO IDs read aloud as digit soup, no URLs, no raw JSON
- Order: focus items by priority → what changed (new/closed/state) → what's due → PR status
- `notify.js` in A1 sends this script text, not the raw diff

---

**Tier 2 — SSE subscription in WorkerKing daemon (architectural improvement)**
*Effort: M. Inverts the coupling; WorkerKing watches Sprint rather than Sprint calling back.*
*(WorkerKing-side insight; Sprint's assessment didn't cover this.)*

WorkerKing's daemon subscribes to `GET http://127.0.0.1:5757/events` (Sprint's SSE stream).
- Topologically clean: this goes Windows → WSL2 at port 5757 (same direction as `get_standup_state`, already working).
- On `diff` event with non-empty `new[]` or `reviewing[]`: daemon auto-broadcasts `proactive.notify`.
- Sprint needs no knowledge of WorkerKing; stays a passive data source.
- `notify.js` remains useful for on-demand pings from the dashboard Speak button — not the primary automated alert path.
- Implementation: `EventSource`-compatible SSE client in the daemon, reconnect with exponential backoff, no-op when Sprint is down. Zero new npm deps (hand-rolled or use `eventsource` which is a Node built-in path in recent Node).

---

**D5 — Focus deadlines → WorkerKing reminders**
*Effort: S-M. Reuses A1's channel; high delight.*

When Sprint's `focus[]` items carry hard external deadline text (e.g. "due Friday"), Claude (delegated via voice) calls `mcp__workerking__set_reminder` with the appropriate fire time. The reminder fires as a spoken alert that morning. No new Sprint code — this is a Claude behavior wired through the existing tool.

---

**Compact ambient context block in WorkerKing daemon**
*Effort: S. Makes Claude sprint-aware on every turn without a tool call.*
*(WorkerKing-side insight.)*

Add a `SprintContext` class following the `EnvironmentContext` / `VaultContext` pattern:
- On daemon startup, attempt `GET http://127.0.0.1:5757/api/state` (5s timeout, silent on failure)
- Cache for 10 minutes; refresh in background on stale
- `sprintBlock()` returns ~150 tokens: sprint name, days remaining, focus count, open PR count, last fetch age
- Wire into `PersonaContext` in `packages/core/src/main.ts:118` and `buildAmbientContext` at line 138
- Sprint never goes in the full system prompt; only this compact summary does

---

**C2 — Richer `/api/state` payload**
*Effort: S. Cheap; helps both `get_standup_state` tool and the SSE subscriber.*

Widen `buildStateResponse` in `bin/server.js:374` to include `focus[].why`, pending notes count, `suggestedHours`, and (once A2 lands) the script text. No new protocol; zero-dependency-friendly.

---

**B1 — "Do my standup" by voice (delegate to Claude)**
*Effort: M. Marquee feature. Gated on Truth #2 bridge.*

Build one of:
- A `standup` skill in Sprint's `.claude/skills/` that the capability manifest routes to, OR
- A daemon persona-append that injects Sprint's morning/wrap/weekly CLAUDE.md triggers when `claudeCwd` is the sprint repo.

Then verify: SDK brain actually runs `fetch.js` + curates focus (not just chats about it). Verify `folder: 'sprint'` resolves to `\\wsl.localhost\Ubuntu-22.04\home\jamesamiller\repos\sprint` via `EnvironmentContext.resolveRepoPath`.

---

**C1 — Sprint-as-MCP stdio shim (low priority, useful outside WorkerKing)**
*Effort: M-L. Architecturally nice; register in `~/.claude` MCP config for all Claude sessions.*

Hand-rolled stdio JSON-RPC (~150 lines, zero deps) at `bin/mcp.js` proxying Sprint's HTTP API:
`get_standup_state`, `get_focus`, `get_diff`, `refresh`, `add_note`. Register in WorkerKing via `buildMcpServers` (same pattern as LocalTranscriber).
Not first. Interactive Claude in the sprint repo already reads `state.json` directly.

---

**Skip: C3 (shared memory/vault cross-pollination)** — speculative, high entropy, low ROI.
**Defer: D2/D3/D4 (avatar mood, screen-aware, wake-word)** — demo tier; wait for A1/B1 to prove out.

---

## Concrete Work: 4 Integration Pieces

### 1. LocalTranscriber MCP → WorkerKing capability config

**Effort: 30 minutes. Zero code changes.**

LocalTranscriber already ships an MCP stdio server. Register it in WorkerKing's config:

```json
// In WorkerKing's config (however mcpServers are configured in ClaudeBackend)
{
  "mcpServers": {
    "local-transcriber": {
      "command": "dotnet",
      "args": ["run", "--project", "C:\\_repos\\LocalTranscriber\\src\\LocalTranscriber.Mcp"],
      "cwd": "C:\\_repos\\LocalTranscriber"
    }
  }
}
```

Check `packages/core/src/claude/ClaudeBackend.ts` `buildOptions` — `mcpServers` is already wired. Verify against `CapabilityManifest.ts` for how WorkerKing discovers external MCP servers.

**Result**: Claude in WorkerKing can call `tail_transcript` and answer "what did they just decide?" from the live meeting transcript, without LocalTranscriber running its own voice session.

---

### 2. Fix Sprint → WorkerKing notification (schema mismatch)

**Effort: ~1 hour. Fix is in Sprint's reverted notify.js.**

The reverted `notify.js` (commit `8a6ccc6` in Sprint) sends a **wrong payload**:

```json
// What Sprint sent (wrong):
{ "type": "proactive.notify", "token": "<token>", "payload": { "title": "...", "body": "...", "kind": "info" } }
```

WorkerKing's actual `proactiveNotifyPayload` schema (protocol.ts:120-127):
```typescript
{ text: string, level: 'info'|'warn'|'success', speak: boolean, source?: string }
```

And the envelope format is `{v, id, kind, ts, payload}` — not `{type, token, payload}`. The token goes in the HTTP Upgrade headers or initial `hello` handshake, not in the message body.

**Action items:**
1. Cherry-pick Sprint commit `8a6ccc6` back to Sprint's main
2. Fix `notify.js` payload: `{title, body, kind}` → `{text: title+body, level: kind, speak: true, source: 'sprint'}`
3. Fix envelope: `{type, token, payload}` → `{v: 1, id: <uuid>, kind: 'proactive.notify', ts: Date.now(), payload: {...}}`  
4. Verify auth: check WorkerKing's `packages/core/src/ws/server.ts` to see how the token is validated on connect (likely in the `hello` message, not per-message). Match that.
5. Set `features.workerKing: true` in Sprint's config.json

**Result**: Sprint's "standup in 10 minutes" and data-stale warnings are spoken aloud by WorkerKing's avatar.

---

### 3. Sprint state → Claude ambient context

**Effort: ~2 hours. New tool in WorkerKing's tools.ts.**

Sprint exposes `GET http://127.0.0.1:5757/api/state` and `/api/diff`. Add a WorkerKing in-process tool:

```typescript
// packages/core/src/claude/tools.ts — add to createSdkMcpServer
{
  name: 'get_standup_state',
  description: 'Get the current sprint/standup state from the Sprint dashboard',
  inputSchema: z.object({}),
  handler: async () => {
    const res = await fetch('http://127.0.0.1:5757/api/state');
    if (!res.ok) return untrusted('Sprint dashboard is not running');
    return untrusted(await res.text());
  }
}
```

Wrap the response in `untrusted()` (already the pattern for external data in tools.ts). Claude can then call this tool when the user asks sprint-related questions.

Optionally: inject Sprint state into the persona append at session start (check if port 5757 is reachable; if so, include the current sprint summary in Claude's system prompt via `assemblePersona.ts`).

---

### 4. LocalTranscriber live transcript → Claude ambient context

**Effort: ~1 hour. Piggybacks on integration #1.**

Once LocalTranscriber's MCP is registered (integration #1), Claude already has `tail_transcript` available on demand. The only additional wiring needed for ambient context:

Option A (recommended): When a voice session starts, `VoiceHost.ts` fires `voice.session_start` → daemon can call `tail_transcript` via MCP and include the last 20 lines in the voice session's `systemPrompt` append. This gives the GPT Realtime model grounding in what's being discussed in the current meeting.

Option B: No extra wiring — users just ask "what did they just say?" and Claude calls `tail_transcript` reactively. Lower friction to ship, same result.

Start with Option B. Add Option A when it proves useful.

---

## What Not to Do

- **Don't add a Python/Pipecat layer.** WorkerKing's GPT Realtime path is already production-quality. Adding Pipecat would be a new runtime dependency for functionality you already have.
- **Don't modify LocalTranscriber's C# code.** Its MCP server is the integration surface. Use it.
- **Don't rebuild for Tauri.** The click-through overlay ergonomics are actually *better* in Electron for interactive elements. The memory cost is irrelevant for personal use.
- **Don't implement Live2D yet.** Keep the orb. Do the integrations first.

---

## Verification

After each integration:

1. **LocalTranscriber MCP**: Start LocalTranscriber (WPF or CLI), start a fake transcription session (`localtranscriber start-fake`), then ask WorkerKing "what's being discussed?" — Claude should call `tail_transcript` and reply with meeting content.

2. **Sprint notifications**: With WorkerKing's daemon running, trigger a notification from Sprint's server (`POST /api/say` with body `{text: "test"}`) and confirm WorkerKing speaks it aloud.

3. **Sprint state tool**: Ask WorkerKing "what's in my sprint?" — Claude should call `get_standup_state` and describe the current ADO work items.

4. **End-to-end**: Run all three apps, start a fake LocalTranscriber meeting session, ask WorkerKing a question that requires both meeting context and sprint state — confirm Claude synthesizes both.

Run `pnpm build && pnpm typecheck && pnpm test:headless` after any WorkerKing changes.

---

## Deferred / Not Blocking

- **Avatar**: CSS orb stays. Swap seam in `AvatarController.ts` is clean when ready.
- **Local cascade hardware verification**: Whisper STT + Kokoro TTS + echo cancellation — unverified on real mic/speaker. Not blocking; GPT Realtime is the primary path.
- **Wake word real-world threshold tuning**: Models present, pipeline wired, but `threshold: 0.6` on a real mic is unverified.
- **zod v3/v4 split in voice-providers**: Harmless today, note only.
