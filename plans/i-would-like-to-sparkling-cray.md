# Live Execution Visibility

## Context

Today you can't watch what WorkerKing is actually doing while it works. The daemon already
streams the assistant's **text** live (`chat.assistant_delta` → the chat bubble types out), but the
*execution* — which files it reads/edits, which commands it runs, what it's reasoning about — is
either dropped or heavily lossy:

- In `ClaudeBackend.consume()` (`packages/core/src/claude/ClaudeBackend.ts`) the SDK loop surfaces
  tool calls as **names only** (`extractToolUses` → `onToolUse(name)`); tool **inputs** (the file
  path, the bash command), tool **results**, and **thinking** blocks are never read.
- For delegated background "worker" tasks, even those names get collapsed by `ProgressMapper`
  (`packages/core/src/tasks/ProgressMapper.ts`) into a single throttled spoken phrase ("running a
  command…") — great for voice, useless as a live feed.
- The floating avatar has an `avatar.state` channel wired end-to-end in the protocol + overlay
  listener, but **no daemon emitter**, so it never reflects "the agent is working."

**Goal:** a live, tool-by-tool execution feed — covering both direct chat turns and background
worker tasks — shown in a dedicated **Activity** panel in the chat window, with the avatar flipping
to a "thinking/working" state while a run is in flight. Detail level (including whether to show the
model's thinking) is configurable in Settings.

This is purely additive: the throttled voice `task.progress` path and `chat.assistant_delta` text
streaming stay exactly as they are. The new activity stream runs in parallel.

---

## Design overview

One new **unthrottled** WS kind — `activity.step` — carries a small discriminated-union step,
correlated to either a `taskId` (worker task → broadcast) or a `messageId` (chat turn → sent to the
requesting client, mirroring `chat.assistant_delta`). `ClaudeBackend.consume()` gains **optional**
richer handlers layered on top of the existing ones. All input/result/thinking text is truncated by
pure helpers in `packages/shared` before it ever hits the bus (16 MB `maxPayload` never at risk).
The chat renderer grows a hand-rolled `ActivityFeed` (same style as the existing `TaskList`) mounted
in a new `#activity-panel` slide-over. The daemon also emits `avatar.state` around active runs.

---

## Part A — Shared contract (`packages/shared`)

### A1. New pure helper `packages/shared/src/activity.ts`
`shared` can't import `core`, and both the daemon (producing) and renderer (constants) need this.

- Constants: `ACTIVITY_MAX_SUMMARY = 200`, `ACTIVITY_MAX_PREVIEW = 200`, `ACTIVITY_MAX_THINKING = 600`.
- `activityLabel(name): string` — display label distinct from the voice register: `Bash`→`"Bash"`,
  `Read`→`"Read"`, `mcp__srv__tool`→`"srv/tool"`, else the raw name. (Leave `friendlyTool` in
  `ProgressMapper.ts` untouched — voice and the feed intentionally read differently.)
- `summarizeToolInput(name, input): string` — pull the salient field, hard-truncate to `MAX_SUMMARY`:
  `Bash`→`command`; `Read`/`Write`/`Edit`→`file_path`; `Glob`/`Grep`→`pattern` (+`path`);
  `WebFetch`→`url`; `WebSearch`→`query`; `Task`→`description`; MCP/unknown→compact `JSON.stringify`.
- `previewToolResult(content, isError): { ok, preview }` — normalize the SDK `tool_result.content`
  (string, or array of `{type:'text'|'image', text?}` blocks): join text, replace non-text with
  `[image]`/`[binary]`, truncate to `MAX_PREVIEW`. `ok = !isError`.
- Re-export all from `packages/shared/src/index.ts`.

### A2. New schema in `packages/shared/src/domain.ts`
```ts
export const activityStepKindSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tool_use'), toolId: z.string(), tool: z.string(),
             label: z.string(), summary: z.string() }),
  z.object({ kind: z.literal('tool_result'), toolId: z.string(),
             ok: z.boolean(), preview: z.string() }),
  z.object({ kind: z.literal('thinking'), text: z.string() }),
]);
export const activityStepSchema = z.object({
  ts: z.number(),
  seq: z.number(),                  // monotonic per-stream ordering
  taskId: z.string().optional(),    // set for worker tasks
  messageId: z.string().optional(), // set for chat turns
  step: activityStepKindSchema,
});
export type ActivityStep = z.infer<typeof activityStepSchema>;
```
`toolId` is the SDK `tool_use` block `.id` — it pairs a later `tool_result` back to its `tool_use`
row. `seq` gives stable ordering because tool_use (assistant msg) and tool_result (a subsequent user
msg) arrive in different SDK messages.

### A3. Protocol registration `packages/shared/src/protocol.ts`
Add `'activity.step': activityStepSchema` to `payloadSchemas`. `WsMessageKind` / `PayloadOf` /
validation all update automatically.

### A4. Config keys `packages/shared/src/domain.ts` (`workerKingConfigSchema` + `DEFAULT_CONFIG`)
Two booleans, so the feature is configurable in Settings per your ask:
- `activityStreamEnabled: z.boolean().optional()` — master switch, **default `true`**.
- `activityShowThinking: z.boolean().optional()` — stream the model's reasoning, **default `true`**.

Tool-use + tool-result rows are always on when the stream is enabled (they're small and truncated);
only thinking is separately gateable since it's the verbose part.

---

## Part B — Capture richer events (`packages/core/src/claude/ClaudeBackend.ts`)

### B1. Extend the `consume()` handlers (all new fields optional → backward compatible)
```ts
onToolUse?: (name: string) => void;                                   // UNCHANGED — voice
onToolInput?: (u: { id: string; name: string; input: unknown }) => void;
onToolResult?: (r: { toolId: string; isError: boolean; content: unknown }) => void;
onThinking?: (text: string) => void;
```
Inside the `for await` switch:
- `case 'assistant'`: keep the existing `onToolUse(name)` loop. **Additionally**, when the message
  is top-level (`parent_tool_use_id == null`): if `onToolInput`, iterate `extractToolUseBlocks(msg)`
  → `onToolInput`; if `onThinking`, iterate `extractThinking(msg)` → `onThinking`.
- **New `case 'user'`** (today falls through to `default`): when top-level and `onToolResult` set,
  iterate `extractToolResults(msg)` → `onToolResult`.
- `case 'stream_event'`: unchanged. (v1 emits **complete** thinking blocks from the assistant
  message, not `thinking_delta` — lower churn, keeps thinking opt-in cheap.)

### B2. New extractor helpers (bottom of file, each unit-tested)
- Keep `extractToolUses(msg): string[]` **unchanged** (voice + existing test depend on it).
- `extractToolUseBlocks(msg): {id,name,input}[]` — assistant content `type==='tool_use'`.
- `extractToolResults(msg): {toolId,isError,content}[]` — user content `type==='tool_result'`
  (`tool_use_id`, `is_error`, `content`).
- `extractThinking(msg): string[]` — assistant content `type==='thinking'` → `.thinking`.

### B3. Entry points
- `respond(text, onDelta, activity?)` — optional 3rd param `{ onToolInput?, onToolResult?,
  onThinking? }`, forwarded into `consume`. Update the `Brain.respond` signature in
  `packages/core/src/brain/Brain.ts`, and have `DeferredBrain.respond` forward it and
  `EchoBrain.respond` accept-and-ignore it (keeps all `Brain` implementers compiling).
- `run(...)` — its `events` object gains the same optional members, forwarded into `consume`.

Gate every new emission on `parent_tool_use_id == null` so nested **sub-agent** tool calls don't
flood the feed (the top-level `Task` tool_use itself still shows).

---

## Part C — Emit from both paths + avatar (`TaskManager.ts`, `Supervisor.ts`)

### C1. Task path
- `TaskRunEvents` (`TaskManager.ts`): add optional `onToolInput?`, `onToolResult?`, `onThinking?`.
- `TaskEmitter`: add `activity(taskId: string, step: ActivityStep): void`.
- In `TaskManager.run()`, keep the existing voice wiring (`onDelta→heartbeat`, `onToolUse→
  mapper.tool`) and **add** a per-task monotonic `seq`, wiring the three new callbacks to build an
  `ActivityStep` (with `taskId`) via the `activity.ts` helpers and call `emit.activity(...)`.
- In `Supervisor` (the `TaskManager` `emit` wiring block, ~L54-70): add
  `activity: (_taskId, step) => server.broadcast('activity.step', step)`.

### C2. Chat path — `Supervisor.runChatTurn`
- Read config once: `const stream = this.config.get('activityStreamEnabled') !== false;` and
  `const think = this.config.get('activityShowThinking') !== false;`
- If `stream`, keep a per-turn `seq` and pass `respond`'s 3rd arg; each callback builds an
  `ActivityStep` (with the turn's `messageId`, no `taskId`) and `client.send('activity.step', step)`
  — to the single requesting client, like `chat.assistant_delta`. Only pass `onThinking` when
  `think`. When `!stream`, pass nothing (zero overhead). Wire the **task** path's `onThinking`
  through the same config gate.

### C3. Avatar "working" state (the unused `avatar.state` hook)
- Add a small busy ref-count in the Supervisor spanning active chat turns **and** running tasks.
  On `0→>0` broadcast `avatar.state {state:'thinking'}`; on `>0→0` broadcast
  `avatar.state {state:'idle'}` (`avatarStateSchema` = idle|listening|thinking|talking|alert).
- Increment/decrement in `runChatTurn` (around `brain.respond`) and in the `TaskManager` created/
  terminal emitters. Use `try/finally` so an error still releases the count.

---

## Part D — Renderer (`packages/app/src/renderer/chat/` + overlay)

### D1. `ActivityFeed` class (new module, styled like `TaskList`)
- Global timeline grouped by correlation id (`taskId ?? messageId`): each group is a
  `<details open>` section "Chat turn" / task title, with rows beneath.
- `private rows = new Map<string, HTMLElement>()` keyed by `toolId` for tool_use/tool_result
  pairing; thinking rows keyed by `seq`.
- `apply(step)`:
  - `tool_use` → row: `label` + monospace `summary` (both via `textContent` — **no HTML
    injection**), marked pending.
  - `tool_result` → find row by `toolId`, append a preview span, toggle `--ok`/`--error` by `ok`;
    tolerate an orphan result (create standalone) for out-of-order safety.
  - `thinking` → muted `--think` row (`textContent`).
- Order rows within a group by `seq`.

### D2. Dedicated Activity panel
- Clone the `#tasks-panel` slide-over in `packages/app/src/renderer/chat/index.html`: a new
  `#activity-panel` + an `activity-toggle` button with a live count badge (active groups). Add CSS
  rules (`.activity`, `.activity__row`, `--ok/--error/--think`, monospace summary) alongside the
  existing inlined `#tasks-panel` block. Register it in `wirePanels` (`main.ts`).
- In `main.ts`, add one `client.on('activity.step', step => feed.apply(step))` handler; the feed
  self-groups by `taskId ?? messageId`. Finalize a chat group's header to "done" on
  `chat.assistant_done`; finalize a task group on `task.done/error/cancelled`. Extend the existing
  15 s stale-bubble sweep to also settle an orphaned live group if the daemon dies mid-run.

### D3. Settings toggles (`packages/app/src/renderer/chat/Settings.ts`)
Add two checkboxes ("Show live activity feed", "Include the model's thinking") in the same
`checked(k)` + `wire()` pattern already used for `screenAwareness`/`memoryEnabled`, writing
`activityStreamEnabled` / `activityShowThinking` through the existing bridge → main → daemon path.

### D4. Overlay avatar guard (`packages/app/src/renderer/overlay/main.ts`)
The overlay already listens to `avatar.state`. Add a guard so a background run's `avatar.state`
doesn't stomp a live voice session: track whether `voice.state` is currently non-idle and, while it
is, ignore incoming `avatar.state`. When no voice session owns the avatar, the daemon's
`thinking`/`idle` drives the floating companion — so you can see it "working" during silent
background tasks.

---

## Files to change

| File | Change |
| --- | --- |
| `packages/shared/src/activity.ts` | **new** — label + input-summary + result-preview helpers, truncation constants |
| `packages/shared/src/domain.ts` | `activityStep*` schemas; `activityStreamEnabled` + `activityShowThinking` config (schema + `DEFAULT_CONFIG`) |
| `packages/shared/src/protocol.ts` | register `'activity.step'` |
| `packages/shared/src/index.ts` | re-export `activity.ts` |
| `packages/core/src/claude/ClaudeBackend.ts` | new optional handlers in `consume`; `case 'user'`; new extractors; `respond`/`run` params |
| `packages/core/src/brain/Brain.ts` | `respond` signature (+ `DeferredBrain`/`EchoBrain`) |
| `packages/core/src/tasks/TaskManager.ts` | `TaskRunEvents` + `TaskEmitter.activity`; per-task `seq`; wire new callbacks |
| `packages/core/src/supervisor/Supervisor.ts` | broadcast `activity.step` (tasks) + `client.send` (chat, config-gated); busy ref-count → `avatar.state` |
| `packages/app/src/renderer/chat/ActivityFeed.ts` | **new** — hand-rolled feed |
| `packages/app/src/renderer/chat/main.ts` | `activity.step` handler; mount panel; wire toggle |
| `packages/app/src/renderer/chat/index.html` | `#activity-panel` slide-over + CSS |
| `packages/app/src/renderer/chat/Settings.ts` | two toggles |
| `packages/app/src/renderer/overlay/main.ts` | voice-vs-agent `avatar.state` guard |

---

## Verification

1. Run the **/verify** gate (build → typecheck → headless tests, stop on first failure):
   `pnpm build`, `pnpm typecheck`, `pnpm test:headless`.
2. **New/updated tests:**
   - `packages/shared` — unit-test `summarizeToolInput` (Bash/Read/Grep/MCP/oversized cap),
     `previewToolResult` (string vs block array, image→`[image]`, error flag), truncation limits.
   - `ClaudeBackend.test.ts` — test `extractToolUseBlocks`/`extractToolResults`/`extractThinking`;
     assert the new callbacks fire with a correlated `toolId`, and that a message carrying
     `parent_tool_use_id` is **skipped**. Confirm existing `extractTextDelta`/`respond`/session
     tests stay green (signatures preserved).
   - `TaskManager.test.ts` — assert `emit.activity` fires a `tool_use` then a matching `tool_result`
     with increasing `seq`; existing `onToolUse` tests unaffected (new members optional).
   - Protocol round-trip — `parseEnvelope` a sample `activity.step` for each union arm.
3. **End-to-end (Windows, `pnpm app` after `pnpm --filter @workerking/core run build`):** open the
   chat window, ask for something that reads/edits files or runs a command, open the Activity panel,
   confirm tool rows stream in with targets + ok/error previews and (with the toggle on) thinking;
   confirm the avatar shows "thinking" during a silent delegated task and returns to idle when done.
   Toggle both Settings switches and confirm the feed / thinking rows respond live. Use
   `scripts/tail-logs.ps1 -Follow -Timeout 5` for daemon-side confirmation.

## Edge cases

- **Sub-agent filtering** at the message level (`parent_tool_use_id`) for assistant + user +
  stream_event, so nested `Task` tool calls don't flood the feed.
- **Pairing** purely by `toolId`; a cancelled tool_use stays "pending" (fine); renderer tolerates
  orphan results.
- **Ordering** via `seq`, never arrival order (tool_use and tool_result are separate SDK messages).
- **Payload size** — every field pre-truncated; images/binary summarized, never dumped.
- **Transport asymmetry** — chat uses `client.send` (one client); tasks use `broadcast`.
- **Voice integrity** — `onToolUse(name)` + `ProgressMapper` remain the sole source of
  `task.progress`; `activity.step` is strictly additive.
- **Avatar** — voice session takes precedence over the agent-busy `avatar.state` (D4 guard).
