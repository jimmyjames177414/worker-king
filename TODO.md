# Review: Realtime Implementation — Plan (In Progress)

## Phase 1: Exploration

**Status:** Exploring realtime implementation scope to identify all components and potential gaps.

### Key Questions Being Answered

- What modules/files comprise the realtime system?
- What are the main responsibilities: real-time chat, UI updates, supervision events, voice handling?
- How does realtime data flow through the daemon → WebSocket protocol → UI renderers?
- What are the critical invariants and failure modes?
- Are there tests covering realtime scenarios?

### Exploration Targets

1. Realtime-related files (RealtimeKeys, RealtimeClient, RealtimeManager, etc.)
2. WebSocket protocol definitions in `shared` package
3. Supervisor and daemon integration with realtime
4. Voice provider realtime interactions
5. Test coverage for realtime paths

---

## Phase 2: Review Strategy

### Identified Components (From Exploration)

**Voice Provider System:**

- `VoiceProvider.ts` — interface contract
- `GptRealtimeProvider.ts` — OpenAI WebRTC provider (production, Phase 2)
- `LocalCascadeProvider.ts` — offline cascade provider (future, Phase 5)
- `createRealtimeSessionFactory.ts` — session builder (injectable, testable)

**Security & Keys:**

- `RealtimeKeys.ts` — ephemeral key minting (real key → `ek_...` short-lived keys)
- `preload/overlay.ts` — IPC security bridge to mintRealtimeKey

**Integration & Orchestration:**

- `VoiceHost.ts` — central WS orchestrator (250 lines, wires provider → WS bus → avatar UI)
- `Supervisor.ts` — voice tool call dispatcher
- `protocol.ts` — WS message schemas (387 lines, all voice.*message types)
- `domain.ts` — shared voice types

**UI & Rendering:**

- `overlay/main.ts` — avatar state machine, voice broadcast listeners
- `Captions.ts` — floating subtitle renderer
- `Settings.ts` — voice provider config UI

---

### Critical Review Areas

#### **1. Lifecycle & Resource Cleanup**

- **Session start/stop:** Does GptRealtimeProvider properly clean up WebRTC when stopped?
  - File: `GptRealtimeProvider.ts:start()/stop()`
  - Risk: Dangling WebRTC connections, memory leaks, stale event listeners
- **Turn epoch & barge-in:** When user interrupts, are stale replies properly cancelled?
  - File: `VoiceHost.ts` — barge-in logic
  - Risk: Overlapping speech, queued replies firing after stop
- **Hotkey subscription cleanup:** Does preload unsubscribe from push-to-talk hotkey?
  - File: `preload/overlay.ts`
  - Risk: Multiple subscriptions, memory leak, stale callbacks

#### **2. Error Handling & Fallback Paths**

- **Ephemeral key failure:** What happens if `mintRealtimeKey()` fails (network, quota, auth)?
  - File: `RealtimeKeys.ts`, `VoiceHost.ts:start()`
  - Risk: Silent failure, no user feedback, orphaned UI state
- **WebRTC negotiation timeout:** Does the provider handle hanging connections?
  - File: `GptRealtimeProvider.ts:start()` — is there a connection timeout?
  - Risk: User waits indefinitely, stale session consuming resources
- **OpenAI API errors:** Are 429 (rate limit), 500 (server), 401 (auth) handled distinctly?
  - File: `GptRealtimeProvider.ts`, `createRealtimeSessionFactory.ts`
  - Risk: User sees generic error, unclear if retry is safe or futile
- **Audio device unavailable:** Can renderer gracefully degrade if no mic?
  - File: `overlay/main.ts`, `VoiceHost.ts`
  - Risk: Exception in audio setup, UI crash

#### **3. State Synchronization & Race Conditions**

- **Concurrent starts/stops:** Can user rapidly toggle voice on/off?
  - Files: `VoiceHost.ts:toggle()`, `GptRealtimeProvider.ts:start()/stop()`
  - Risk: Promise race, double-start, state mismatch between provider and WS broadcasts
- **Tool call response ordering:** If voice sends multiple `voice.tool_call` requests, are responses correlated correctly?
  - Files: `VoiceHost.ts`, `Supervisor.ts`, `protocol.ts`
  - Risk: Response mismatch (task A's result routed to task B's handler)
- **Broadcast race on restart:** When recycling session, do old state broadcasts race with new ones?
  - File: `VoiceHost.ts:recycle()`, `voice.state` broadcast
  - Risk: Avatar flickers, UI flashes wrong state

#### **4. Dependency on Third-Party SDKs**

- **`@openai/agents-realtime` (v0.13.2):** Is the version pinned safely?
  - Risk: Major version bump changes session event shapes, breaks GptRealtimeProvider
- **SessionFactory injection:** If someone passes a broken factory, does the error propagate clearly?
  - File: `createRealtimeSessionFactory.ts`, `GptRealtimeProvider.ts:constructor()`
  - Risk: Factory error swallowed, provider silently fails

#### **5. Audio & PCM Processing**

- **Audio level computation:** Is RMS calculation correct for avatar mouth animation?
  - File: `GptRealtimeProvider.ts` — PCM16 to RMS
  - Risk: Avatar doesn't animate, or animates when silent (false positives)
- **Audio device selection:** When user switches audio device mid-session, does provider detect/switch?
  - File: `overlay/main.ts` — output device setup
  - Risk: User hears nothing, thinks session failed

#### **6. Ephemeral Key Security**

- **Key expiry:** Are expired keys handled gracefully? Does provider detect expiry and re-mint?
  - Files: `RealtimeKeys.ts`, `GptRealtimeProvider.ts`
  - Risk: Silent auth failure mid-conversation, session hangs
- **Key leakage:** Can ephemeral keys end up in logs, crash dumps, or analytics?
  - File: All VoiceHost, GptRealtimeProvider error handlers
  - Risk: Credentials exposed even though they're time-limited

#### **7. Supervisor Tool Integration**

- **Tool availability:** If supervisor changes tools (add/remove), does voice provider reflect changes?
  - File: `VoiceHost.ts` — supervisor tools built in start()
  - Risk: Stale tools list, user says "delegate to X" but X no longer exists
- **Tool argument validation:** Does WS protocol validate `voice.tool_call.args`?
  - File: `protocol.ts` — schema for voice.tool_call
  - Risk: Invalid args passed to TaskManager, crash or silent failure

#### **8. Cascade Provider Readiness (Phase 5)**

- **LocalCascadeProvider:** Is it fully integrated or still stub code?
  - File: `LocalCascadeProvider.ts`
  - Risk: If switched to, offline mode crashes with `onTool*` or `onState*` unimplemented
- **Engine loader:** Are optional imports (`vad-web`, `transformers`, `kokoro-js`) truly optional?
  - File: `localEngines.ts`
  - Risk: Missing engine at runtime, requires user to re-run installer

#### **9. Test Coverage Gaps**

- **Integration tests:** Do tests verify end-to-end voice flow (ephemeral key → WS → supervisor)?
  - Risk: Unit tests pass but integration fails (key expiry, WS message shape mismatch)
- **Edge cases:** Are there tests for:
  - Rapid start/stop?
  - Session timeout (no activity for N minutes)?
  - Network disconnection mid-sentence?
  - Tool call timeout (supervisor doesn't respond in time)?
- **Mocking & fakes:** `GptRealtimeProvider.test.ts` uses `FakeSession`, but does it mock all event types?
  - Risk: Real session has events test doesn't cover

---

### Review Focus Questions

1. **Graceful degradation:** If voice fails (API, network, permission), does the app stay responsive and offer clear user feedback?
2. **Cleanup:** When a voice session ends (user stop, timeout, error), are all resources released (WebRTC, event listeners, pending promises)?
3. **Replay safety:** If user clicks "try again" after an error, does a fresh start avoid reusing stale state?
4. **Cascade readiness:** Is LocalCascadeProvider fully implemented and tested, or does it need Phase 5 work?
5. **SDK coupling:** Is GptRealtimeProvider resilient to minor SDK version changes (0.13.x → 0.14.x)?

---

## Phase 3: Detailed Review Findings

### A. VoiceHost Lifecycle & Resource Management

**Agent Finding: Start/Stop Guard is Excellent**
- ✅ Uses `startEpoch` pattern to guard against concurrent start/stop
- ✅ Waits for in-flight start before stopping (line 287)
- ✅ Invalidates stale starts with epoch check (line 147, 195)

**Agent Finding: Turn Epoch Prevents Stale Replies (Barge-in)**
- ✅ When user interrupts, `turnEpoch` increments
- ✅ Pending sentences check `if (myTurn !== this.turnEpoch)` before speaking
- ✅ Robust per-turn invalidation prevents overlapping speech

**Agent Finding: Tool Call Correlation (Envelope-based)**
- ✅ Uses `ws.request()` with reply ID matching
- ✅ Multiple concurrent tool calls are properly correlated
- ⚠️ BUT: If daemon crashes/WS dies, request times out at 20s; tool result resolves as `{}`

**Critical Issue #1: `speakChain` NOT awaited on stop**
- 🔴 **Severity: MEDIUM**
- **Location:** VoiceHost.ts line 287, `stop()` method
- **Problem:** When voice session stops, pending speech in `speakChain` can still play after `stop()` returns
- **Code:**
  ```typescript
  async stop(): Promise<void> {
    this.startEpoch++;
    this.active = false;
    await this.startPromise?.catch(() => {});
    await this.provider?.stop();  // ← provider stopped
    // ✗ BUT speakChain NOT awaited here
    this.provider = undefined;
  }
  ```
- **Impact:** User stops voice, but a sentence queued in `speakChain` speaks 500ms later
- **Recommendation:** Add `await this.speakChain` before provider cleanup

**Critical Issue #2: No Timeout for Key Mint or Provider Start**
- 🔴 **Severity: MEDIUM**
- **Location:** GptRealtimeProvider.ts line 65 (`session.connect()`)
- **Problem:** If network drops during ephemeral key fetch or WebRTC negotiation, user hangs indefinitely
- **Code:**
  ```typescript
  const ephemeralKey = await this.opts.mintKey();  // ← no timeout
  await this.session.connect({ apiKey: ephemeralKey });  // ← no timeout
  ```
- **Impact:** User can't recover; must kill and restart app
- **Recommendation:** Wrap in `Promise.race([...], timeout(30000))` or configure SDK timeout

**Critical Issue #3: Provider Not Stopped in Error Path**
- 🟡 **Severity: LOW**
- **Location:** VoiceHost.ts lines 199-204, `doStart()` catch block
- **Problem:** If `provider.start()` throws after provider is partially initialized, it's not explicitly stopped
- **Code:**
  ```typescript
  } catch (err) {
    this.active = false;
    if (this.provider === provider) this.provider = undefined;  // Clears ref but...
    // ... 'provider' local var still has session reference
    // ... it's not explicitly await provider.stop()
  }
  ```
- **Impact:** Orphaned WebRTC session if startup fails mid-negotiation
- **Recommendation:** Add `await provider.stop();` before clearing reference

**Good: Event Listener Cleanup**
- ✅ Turn-specific listeners are unsubscribed in `finally` block (line 249)
- ✅ Global config/task listeners are intentional (not tied to session lifetime)

**Good: Error State Recovery**
- ✅ After error, `this.active` is reset to `false`, allowing user to retry

---

### B. Ephemeral Key Security

**Agent Finding: Real Key Protection is EXCELLENT**
- ✅ Stored as OS-encrypted ciphertext via Electron safeStorage (DPAPI on Windows)
- ✅ Only decrypted on-demand during IPC handler call (no caching)
- ✅ Renderer never sees real key — only ephemeral keys (`ek_...`)
- ✅ Preload exposes only `mintRealtimeKey()` callback, not raw API key
- ✅ Fallback to `OPENAI_API_KEY` env var is dev-only

**Agent Finding: Ephemeral Key Minting is Sound**
- ✅ Proper Bearer auth: `Authorization: Bearer ${apiKey}`
- ✅ Correctly extracts `value` or `client_secret.value` from OpenAI response
- ✅ Returns only `ek_...` to renderer (never exposes real key)
- ✅ Validates input (throws if API key missing)

**Critical Issue #4: NO Expiry Handling or Auto-Refresh**
- 🔴 **Severity: MEDIUM**
- **Location:** RealtimeKeys.ts line 37-43 (parses but ignores `expires_at`)
- **Problem:** Ephemeral keys expire (~1 hour), but code doesn't track or refresh them
  - `expires_at` from OpenAI is parsed but **discarded**
  - No timer to call `recycleSession()` before expiry
  - `recycleSession()` exists in GptRealtimeProvider but is **never called**
- **Impact:** User keeps voice active for >1 hour → key expires → session hangs with 401 error
- **Recommendation:**
  1. Parse `expires_at` from ephemeral key response
  2. Schedule `provider.recycleSession()` ~5 minutes before expiry
  3. Or: Call `recycleSession()` periodically (every 45 minutes)

**Critical Issue #5: NO Retry Logic for Transient Failures**
- 🔴 **Severity: MEDIUM**
- **Location:** RealtimeKeys.ts, mintEphemeralKey() function
- **Problem:** Network errors or rate limits (429) cause immediate failure with no retry
- **Impact:** 
  - User clicks voice once, network hiccup → "error" state
  - Rate limit (user/org has multiple WorkerKing sessions) → fails without retry
- **Recommendation:** Implement exponential backoff retry (max 3x) for transient errors (429, network)

**Good: Error Exposure is Safe**
- ✅ Only ephemeral keys reach error logs (not real keys)
- ✅ Ephemeral keys are short-lived (~1 min), limiting damage if exposed
- ✅ Error messages don't leak OpenAI's echoed auth headers

---

### C. State Synchronization & Concurrency

**Good: Concurrent Start/Stop Handling**
- ✅ `startEpoch` guard prevents double-start
- ✅ `stop()` waits for in-flight `start()` before tearing down

**Good: Tool Call Ordering**
- ✅ WS envelope-based request/response matching ensures proper correlation
- ✅ Multiple concurrent tool calls don't interfere

**Potential Issue: Session Recycle State**
- `turnEpoch` NOT reset during `recycleSession()`
- ✅ **This is actually safe** — old turn checks `if (myTurn !== this.turnEpoch)` still work
- New turn will increment epoch anyway

---

### D. Third-Party SDK Coupling

**Potential Issue: `@openai/agents-realtime` version pinning**
- Current: v0.13.2
- Risk: Major version bump could change session event shapes
- **Recommendation:** Monitor for updates; test 0.14.x when released

**Potential Issue: SessionFactory injection error handling**
- If factory callback throws, error propagates through `session.connect()` → caught at line 199
- ✅ **Actually fine** — factory errors are treated like other start errors

---

### E. Audio & PCM Processing

**Status: Not deeply analyzed (would require signal processing review)**
- PCM16 → RMS calculation at GptRealtimeProvider.ts (audio level for avatar mouth)
- Assumes: calculation is correct (typical PCM16 processing)
- **Recommendation:** Verify RMS calculation against OpenAI SDK docs

**Audio device selection:**
- Applied in overlay/main.ts when session starts
- **Assumption:** WebRTC session uses selected output device automatically
- **Risk:** Device switch mid-session may not take effect (depends on browser/SDK)

---

### F. Supervisor Tool Integration

**Status: Tool availability on voice start**
- Tools are built at start time: `delegate_to_worker`, `check_task_status`, `cancel_task`
- **Risk:** If supervisor changes tool signatures, voice model gets stale list
- **Mitigation:** Would require watching supervisor for changes (not currently done)
- **Recommendation:** Document that supervisor changes require voice session restart

**Tool argument validation:**
- Protocol defines `voice.tool_call` schema in protocol.ts
- **Assumption:** Supervisor validates args before execution
- **Recommendation:** Verify Supervisor.ts validates against tool schema

---

### G. LocalCascadeProvider (Phase 5) Status

**Status: PARTIALLY IMPLEMENTED**
- `LocalCascadeProvider.ts` exists (~130 lines)
- Implements `VoiceProvider` interface (start, stop, on, injectAssistantContext)
- Uses optional engines: `@ricky0123/vad-web`, `@huggingface/transformers`, `kokoro-js`

**Critical Issue #6: LocalCascadeProvider Incomplete for Production**
- 🟡 **Severity: MEDIUM** (if user enables it before Phase 5 complete)
- **Problem:** `injectAssistantContext()` not fully implemented for cascade (looks like stub)
- **Impact:** If user switches voice provider to "local-cascade" before Phase 5, speech injection fails
- **Recommendation:** Add feature flag to prevent enabling until ready, or complete implementation

**Good: Optional imports**
- ✅ Optional engines use dynamic imports, so they don't fail unless enabled

---

### H. Test Coverage

**Current tests (from exploration):**
- ✅ `GptRealtimeProvider.test.ts` — 9 test suites (connection, tools, PCM, errors, mute, recycle)
- ✅ `RealtimeKeys.test.ts` — 4 test suites (mint, auth, legacy shapes, errors)
- ✅ `daemon.test.ts` — 2 tests for voice tool delegation

**Coverage gaps identified:**
- ❌ **No integration test** for end-to-end voice flow (ephemeral key → session → tool delegation)
- ❌ **No test for key expiry** — if a test mints a key with `expires_at`, does recycle trigger correctly? (No recycle is called today)
- ❌ **No test for concurrent start/stop** — rapid toggle via UI
- ❌ **No test for network timeout** — what happens if key mint hangs for 30s?
- ❌ **No test for cascade provider** — if enabled, does it work end-to-end?
- ⚠️ **FakeSession in tests** may not mock all real SDK events (e.g., audio level updates, session state transitions)

---

## Phase 4: Consolidated Issues Summary

### Critical Issues (Must Fix)

| ID  | Issue | Severity | File | Impact |
|-----|-------|----------|------|--------|
| **#1** | `speakChain` not awaited on stop | MEDIUM | VoiceHost.ts:287 | Speech plays after session ends |
| **#2** | No timeout for key mint/provider start | MEDIUM | GptRealtimeProvider.ts:65 | Infinite hang on network failure |
| **#4** | No ephemeral key expiry handling | MEDIUM | RealtimeKeys.ts + GptRealtimeProvider | Long sessions (>1h) fail mid-conversation |
| **#5** | No retry logic for transient errors | MEDIUM | RealtimeKeys.ts | Single network hiccup → "error" state |
| **#6** | LocalCascadeProvider not production-ready | MEDIUM | LocalCascadeProvider.ts | Crashes if user enables before Phase 5 |

### Low-Priority Issues

| ID  | Issue | Severity | File | Impact |
|-----|-------|----------|------|--------|
| **#3** | Provider not stopped in error path | LOW | VoiceHost.ts:199-204 | Orphaned session on startup failure |

### Non-Issues (Verified Working)

- ✅ Real API key protection (safeStorage)
- ✅ Concurrent start/stop guarding (startEpoch)
- ✅ Tool call ordering (envelope-based)
- ✅ Barge-in / turn epoch
- ✅ Error state recovery
- ✅ Event listener cleanup

---

## Phase 5: Recommended Fixes (Priority Order)

### Priority 1: Await `speakChain` on Stop
**File:** `packages/app/src/renderer/overlay/VoiceHost.ts` line 287
```typescript
async stop(): Promise<void> {
  this.startEpoch++;
  this.active = false;
  await this.startPromise?.catch(() => {});
  await this.speakChain;  // ← Add this line
  await this.provider?.stop();
  this.provider = undefined;
  this.ws.send('voice.state', { state: 'idle' });
}
```

### Priority 2: Add Timeout to Provider Start & Key Mint
**File:** `packages/voice-providers/src/GptRealtimeProvider.ts` line 65
- Wrap `session.connect()` in timeout (30s recommended)
- Handle timeout error → emit 'error' event

### Priority 3: Implement Ephemeral Key Auto-Refresh
**Files:** `RealtimeKeys.ts`, `GptRealtimeProvider.ts`
1. Parse `expires_at` from mint response
2. Schedule `recycleSession()` ~5 min before expiry
3. Or: Call `recycleSession()` every 45 minutes as failsafe

### Priority 4: Add Retry Logic for Transient Errors
**File:** `packages/app/src/main/RealtimeKeys.ts` mintEphemeralKey()
- Retry on 429 (rate limit) and network errors
- Exponential backoff (1s, 2s, 4s)
- Max 3 attempts

### Priority 5: Complete LocalCascadeProvider or Feature-Gate It
**File:** `packages/voice-providers/src/LocalCascadeProvider.ts`
- Option A: Complete implementation for Phase 5
- Option B: Add feature flag to prevent enabling until ready

---

## Testing Recommendations

1. **Add integration test:** Ephemeral key mint → session connect → tool delegation
2. **Add timeout test:** Key mint with 35s timeout → should fail gracefully
3. **Add concurrent test:** Rapid toggle (start/stop/start/stop) → should not double-start
4. **Add key expiry test:** Mock expires_at, verify recycleSession() fires before expiry
5. **Add cascade provider test:** If cascade is enabled, verify end-to-end flow
6. **Add error recovery test:** After error, can user restart voice successfully?

---

## Verification Strategy (End-to-End)

1. **Manual test sequence:**
   - Start voice → speak → tool delegate → result → stop voice
   - Rapidly toggle voice on/off → should not crash or double-start
   - Disconnect network → start voice → should show "error" state, not hang
   - Interrupt voice mid-reply → should stop speaking, user can speak immediately

2. **Automated (add to `pnpm test:headless`):**
   - Unit tests for VoiceHost lifecycle, key minting, error paths
   - Integration test: fake daemon + fake OpenAI SDK → full voice flow

3. **Long-running test (manual or CI-only):**
   - Keep voice active for 61+ minutes → verify session doesn't die from key expiry

---

_Plan created: 2026-07-15 | Findings consolidated: 2026-07-16_
