# Voice layer: richer capability list + configurable ambient context

## Context

The OpenAI Realtime voice model is deliberately a "thin voice layer" over the Claude brain, but
today it's *too* thin in two avoidable ways:

1. **The capability list is name-only.** `renderVoiceSummary` collapses the manifest into three
   comma-joined name lists, even though each `CapabilityManifestEntry` already carries a real
   `description`, and the SDK hands over `argumentHint` for commands (currently dropped in
   `mapToEntries`). The voice model has to route work to skills/agents/tools it only knows by name —
   the single biggest hit to routing accuracy.

2. **It gets no ambient context at all.** The voice system prompt is a hardcoded string in
   `overlay/main.ts` + the capability summary. The rich context the daemon already assembles for
   Claude (persona/character-card, environment/repo-roots, sprint, memory) never reaches the voice
   layer — so it can't address the user by name, resolve "work on amethyst" to a folder, or answer
   trivial orientation questions without a full delegation round-trip. The user's custom personality
   doesn't even change how the voice behaves.

**Goal:** (1) give the voice model a richer, still-budget-capped capability list, and (2) let the
daemon feed it a **configurable level** of ambient context — off by default beyond a sensible
baseline — assembled once as a single source of truth and kept fresh via a live hot-patch. The level
is a **user setting** (default = "standard"/Tier 1) so cost/latency/staleness tradeoffs are opt-in.

Key constraint (verified): the Realtime session's instructions are fixed at session start, but the
installed SDK (`@openai/agents-realtime@0.13.2`) supports live updates —
`transport.updateSessionConfig({ instructions })` is documented as "update the model instructions",
and `RealtimeSessionConfig` includes `instructions: string`. So a running session can be hot-patched
without a teardown.

---

## Feature 1 — Richer voice capability list

- **Schema** (`packages/shared/src/domain.ts`, `capabilityManifestEntrySchema` ~L114-126): add
  `argumentHint: z.string().optional()`.
- **Populate it** in `mapToEntries` (`packages/core/src/capability/CapabilityManifest.ts` ~L40-79):
  the command branch reads `c.argumentHint` (already in the SDK handle type) but never writes it —
  set it on the command entry.
- **Rewrite `renderVoiceSummary`** (~L85-117): emit one line per entry —
  `- <name> — <description>`, and `- <name> <argumentHint> — <description>` for commands. Replace the
  per-group `VOICE_SUMMARY_MAX_ITEMS` slice with a shared **char budget** (~1500) so descriptions
  stay frugal; keep the `(+N more)` truncation marker and the empty-manifest sentinel.
- **Tests** (`CapabilityManifest.test.ts`): update expectations — name+description lines, `<args>`
  rendering, and `argumentHint` mapped through `mapToEntries`.

## Feature 2 — Configurable, daemon-assembled, hot-patchable voice context

### 2a. Config + Settings
- Add `voiceContextLevel: z.enum(['thin','standard','rich','maximal']).optional()` to
  `workerKingConfigSchema` and `DEFAULT_CONFIG: 'standard'` (`packages/shared/src/domain.ts`).
- Surface as a `data-cfg="voiceContextLevel"` **select** in `packages/app/src/renderer/chat/Settings.ts`
  (mirror the existing `themeOpts`/`permOpts` dropdown pattern; the generic `wire()` needs no change).
  Label the options plainly:
  - **thin** — capability list only.
  - **standard** (default) — + persona + compact orientation (name, date/time, active project, repo names).
  - **rich** — + sprint & remembered facts.
  - **maximal** — + full environment listing.
  Screen content is never included at any level.

### 2b. Daemon assembler — single source of truth
New `packages/core/src/voice/VoiceContext.ts` exporting `computeVoiceContext(level, ctx): string`. It
owns the **behavioral base** (moved out of the overlay's hardcoded string at
`packages/app/src/renderer/overlay/main.ts:99-111` — "thin voice layer, say a filler then
delegate…"), appends the Feature-1 capability summary, then layers level-gated context by reusing
existing producers:
- `standard`: character-card `voiceSystemPrompt` (`packages/core/src/persona/CharacterCard.ts` ~L54-60,
  falling back to `assemblePersonaAppend`) + a **new compact `EnvironmentContext.voiceOrientation()`**
  accessor (userName, current date/time, active project basename, and **all repo names** across the
  configured roots so "work on X" resolves without a round-trip — names only, no OS/rules paragraph).
- `rich`: standard + `SprintContext.sprintBlock()` + `MemoryStore.summary()` (fenced with `untrusted()`
  from `main.ts`).
- `maximal`: rich + full `EnvironmentContext.environmentBlock()` (adds the OS line, per-root grouping,
  the resolve/delegate rules paragraph, and env notes).
- Always cap the whole thing at a `MAX_VOICE_PROMPT_CHARS` budget.

### 2c. Wiring + rebroadcast (`packages/core/src/main.ts`)
Add a `recomputeVoiceContext()` closure (near `startCapabilities()` ~L337-380) that builds the prompt
via `computeVoiceContext` and `server.broadcast('voice.context', { systemPrompt })`. Call it from: the
`CapabilityManager` broadcast callback, a `config.onChange` filtered to voice-relevant keys
(`voiceContextLevel`, `assistantName`, `personality`, `characterCard`, `userName`, `claudeCwd`,
`repoRoots`, `envNotes`), `server.onClientConnected` replay, and an optional low-frequency interval
(~5 min) so sprint/memory drift is picked up on the next session.

### 2d. Protocol
New `voice.context { systemPrompt: string }` kind in `packages/shared/src/protocol.ts` (its own kind —
different cadence and producers than `capability.updated`, and keeps the chat command palette
untouched). Level/persona changes are applied by **swapping instructions in place** — the live
conversation is preserved, not reset. (`voice.recycle` stays reserved for the existing session-limit /
provider-change paths, not persona/level changes.)

### 2e. Provider hot-patch + overlay wiring
- Add `updateInstructions(systemPrompt: string): void` to the `VoiceProvider` interface
  (`packages/voice-providers/src/VoiceProvider.ts`); implement in
  `packages/voice-providers/src/GptRealtimeProvider.ts` via `transport.updateSessionConfig({ instructions })`,
  and update the captured `startOpts.systemPrompt` so any later `recycleSession()`/recovery reseeds with
  the fresh prompt. `updateInstructions` swaps the prompt **without resetting the conversation**; only
  fall back to `recycleSession()` if `updateSessionConfig` is genuinely unavailable at runtime.
- Overlay (`overlay/main.ts` + `VoiceHost.ts`): store the latest `voice.context.systemPrompt`; have
  `getPersona()` return it (with a **minimal hardcoded fallback** for the pre-first-broadcast window,
  so a session started before the daemon replies still works). On a new `voice.context` while a session
  is **live**, call `provider.updateInstructions(...)`; when idle, do nothing (the next `start()` picks
  it up via `getPersona()`).

---

## Files to change

| File | Change |
| --- | --- |
| `packages/shared/src/domain.ts` | `argumentHint` on entry schema; `voiceContextLevel` config + default |
| `packages/shared/src/protocol.ts` | register `voice.context { systemPrompt }` |
| `packages/core/src/capability/CapabilityManifest.ts` | map `argumentHint`; rewrite `renderVoiceSummary` (name + description + arg hint, char-budgeted) |
| `packages/core/src/voice/VoiceContext.ts` | **new** — `computeVoiceContext(level, ctx)` + behavioral base |
| `packages/core/src/environment/EnvironmentContext.ts` | **new** compact `voiceOrientation()` accessor |
| `packages/core/src/main.ts` | `recomputeVoiceContext()` + broadcast wiring (capability/config/connect/interval) |
| `packages/voice-providers/src/VoiceProvider.ts` | `updateInstructions` on the interface |
| `packages/voice-providers/src/GptRealtimeProvider.ts` | implement `updateInstructions` via `transport.updateSessionConfig`; reseed `startOpts` |
| `packages/app/src/renderer/overlay/main.ts` | consume `voice.context`; drop the hardcoded base (keep minimal fallback) |
| `packages/app/src/renderer/overlay/VoiceHost.ts` | `getPersona()` returns latest prompt; hot-patch a live session |
| `packages/app/src/renderer/chat/Settings.ts` | `voiceContextLevel` select |

## Verification

1. `/verify` gate: `pnpm build`, `pnpm typecheck`, `pnpm test:headless` (stop on first failure).
2. **Tests:**
   - `CapabilityManifest.test.ts` — `argumentHint` mapped; `renderVoiceSummary` emits
     name+description (+`<args>`) lines and respects the char budget.
   - New `VoiceContext.test.ts` — each level includes exactly the expected blocks (e.g. `thin` has no
     persona/sprint; `standard` has orientation but no sprint/memory; `rich` adds both; `maximal` adds
     the environment listing); screen content never present; budget cap enforced; memory/env fenced.
   - New `GptRealtimeProvider` test — `updateInstructions` calls `transport.updateSessionConfig` with the
     new instructions when a session is live and is a no-op when idle (fake transport).
   - Protocol round-trip for `voice.context`.
3. **Manual / e2e (Windows, `pnpm app` after building core):** open a voice session; confirm the model
   knows your name and can route by capability description; change `voiceContextLevel` in Settings and
   confirm a **live** session's behavior updates without restart (the key `updateSessionConfig` check);
   confirm `thin` strips ambient context. Use `scripts/tail-logs.ps1 -Follow` for daemon-side tracing.

## Risks / edge cases
- **`updateSessionConfig` live-apply** — types confirm support in `@openai/agents-realtime@0.13.2`; the
  `recycleSession()` fallback and the Windows e2e step de-risk a runtime surprise.
- **EchoBrain / no Claude** — `startCapabilities()` (and thus `voice.context`) only runs under the real
  brain; the overlay's minimal fallback covers boot/echo, which is acceptable since delegation is
  meaningless without the brain.
- **Untrusted content** — memory/environment blocks are fenced with `untrusted()` before entering the
  voice prompt, same as the Claude path.
- **Budget/cost** — the whole voice prompt is capped; `rich`/`maximal` are opt-in, so the default stays
  cheap and low-latency.
- **Scratch file** — delete the agent scratch plan `plans/i-would-like-to-sparkling-cray-agent-*.md`
  before committing; don't commit it.
