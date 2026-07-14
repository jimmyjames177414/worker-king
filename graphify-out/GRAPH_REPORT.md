# Graph Report - C:\_repos\worker-king  (2026-07-14)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 829 nodes · 1337 edges · 40 communities (34 shown, 6 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 12 edges (avg confidence: 0.73)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `776ac76a`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- index.ts
- main.ts
- package.json
- TaskManager.test.ts
- package.json
- protocol.ts
- MemoryStore
- WsClient
- main.ts
- tools.ts
- package.json
- CapabilityManifest.ts
- ClaudeBackend
- domain.ts
- package.json
- package.json
- GptRealtimeProvider
- ReminderStore
- LocalCascadeProvider.test.ts
- compilerOptions
- compilerOptions
- WsServer
- resolveBrain
- tsconfig.json
- LocalCascadeProvider.ts
- tsconfig.json
- ConfigStore
- tsconfig.json
- LocalCascadeProvider
- Supervisor
- protocol.test.ts
- GptRealtimeProvider.ts
- FakeSession
- chat.ts
- MockClient
- VoiceProvider
- VoiceTurnDelegate
- index.ts
- TtsEngine

## God Nodes (most connected - your core abstractions)
1. `resolveBrain()` - 21 edges
2. `WsServer` - 21 edges
3. `MemoryStore` - 18 edges
4. `compilerOptions` - 18 edges
5. `WsClient` - 16 edges
6. `LocalCascadeProvider` - 15 edges
7. `ConfigStore` - 14 edges
8. `GptRealtimeProvider` - 14 edges
9. `ReminderStore` - 13 edges
10. `boot()` - 12 edges

## Surprising Connections (you probably didn't know these)
- `resolveBrain()` --indirect_call--> `realCapabilityQueryFn()`  [INFERRED]
  packages/core/src/main.ts → packages/core/src/capability/realCapabilityQuery.ts
- `main()` --calls--> `connectToDaemon()`  [EXTRACTED]
  packages/app/src/renderer/overlay/main.ts → packages/app/src/renderer/shared/wsClient.ts
- `Brain` --inherits--> `TaskRunner`  [EXTRACTED]
  packages/core/src/brain/Brain.ts → packages/core/src/tasks/TaskManager.ts
- `ClaudeBackend` --implements--> `Brain`  [EXTRACTED]
  packages/core/src/claude/ClaudeBackend.ts → packages/core/src/brain/Brain.ts
- `StartDaemonOptions` --references--> `Brain`  [EXTRACTED]
  packages/core/src/main.ts → packages/core/src/brain/Brain.ts

## Import Cycles
- None detected.

## Communities (40 total, 6 thin omitted)

### Community 0 - "index.ts"
Cohesion: 0.05
Nodes (40): registerClickThrough(), ctx, DaemonClient, DaemonConnection, DaemonSupervisor, DaemonSupervisorOptions, require, toWslPath() (+32 more)

### Community 1 - "main.ts"
Cohesion: 0.07
Nodes (12): AvatarController, STATES, Captions, main(), onReconnect(), onSpeak(), setClickThrough(), VoiceBridge (+4 more)

### Community 2 - "package.json"
Cohesion: 0.05
Nodes (43): @anthropic-ai/claude-agent-sdk, chokidar, croner, handlebars, dependencies, @anthropic-ai/claude-agent-sdk, chokidar, croner (+35 more)

### Community 3 - "TaskManager.test.ts"
Cohesion: 0.08
Nodes (13): DeferredBrain, friendlyTool(), ProgressMapper, RunningTask, TaskEmitter, TaskManager, TaskManagerDeps, TaskRunEvents (+5 more)

### Community 4 - "package.json"
Cohesion: 0.05
Nodes (38): electron, electron-store, electron-vite, dependencies, electron-store, @workerking/shared, @workerking/voice-providers, ws (+30 more)

### Community 5 - "protocol.ts"
Cohesion: 0.05
Nodes (37): avatarStatePayload, capabilityUpdatedPayload, chatAssistantDeltaPayload, chatAssistantDonePayload, chatUserMessagePayload, configChangedPayload, configGetPayload, configSetPayload (+29 more)

### Community 6 - "MemoryStore"
Cohesion: 0.09
Nodes (15): InteractionEntry, InteractionLog, InteractionLogOptions, MemoryEntry, MemoryScope, MemoryStore, MemoryStoreOptions, consolidate() (+7 more)

### Community 7 - "WsClient"
Cohesion: 0.10
Nodes (11): appendBubble(), Els, main(), escapeHtml(), Settings, SettingsBridge, browserCtx, connectToDaemon() (+3 more)

### Community 8 - "main.ts"
Cohesion: 0.13
Nodes (17): Brain, EchoBrain, realCapabilityQueryFn(), ctx, Disposable, interactionLog, memory, reminderStore (+9 more)

### Community 9 - "tools.ts"
Cohesion: 0.15
Nodes (12): buildMemoryTool(), buildNotifyTool(), buildReminderTool(), buildScreenTools(), createWorkerKingToolServer(), screenDisabledResult(), WORKERKING_TOOL_ALLOWLIST, WorkerKingToolDeps (+4 more)

### Community 10 - "package.json"
Cohesion: 0.08
Nodes (24): @openai/agents-realtime, default, dependencies, @openai/agents-realtime, @workerking/shared, zod, devDependencies, typescript (+16 more)

### Community 11 - "CapabilityManifest.ts"
Cohesion: 0.16
Nodes (11): CapabilityManager, CapabilityManagerOptions, defaultWatchDirs(), buildCapabilityManifest(), BuildManifestDeps, CapabilityQueryFn, CapabilityQueryHandle, mapMcpStatus() (+3 more)

### Community 12 - "ClaudeBackend"
Cohesion: 0.14
Nodes (10): ClaudeAuthError, ClaudeBackend, ClaudeBackendOptions, ClaudeQueryFn, extractTextDelta(), extractToolUses(), ClaudeHealth, createClaudeBackend() (+2 more)

### Community 13 - "domain.ts"
Cohesion: 0.09
Nodes (22): AssembledPersona, assembledPersonaSchema, AvatarState, avatarStateSchema, CapabilityKind, capabilityKindSchema, CapabilityManifest, CapabilityManifestEntry (+14 more)

### Community 14 - "package.json"
Cohesion: 0.09
Nodes (21): description, devDependencies, typescript, vitest, engines, node, typescript, vitest (+13 more)

### Community 15 - "package.json"
Cohesion: 0.10
Nodes (20): default, dependencies, zod, devDependencies, typescript, vitest, exports, typescript (+12 more)

### Community 16 - "GptRealtimeProvider"
Cohesion: 0.15
Nodes (6): createRealtimeSessionFactory(), GptRealtimeProvider, GptRealtimeProviderOptions, RealtimeSessionLike, SessionFactory, VoiceStartOptions

### Community 17 - "ReminderStore"
Cohesion: 0.18
Nodes (5): ReminderScheduler, SchedulerDeps, Reminder, ReminderStore, ReminderStoreOptions

### Community 18 - "LocalCascadeProvider.test.ts"
Cohesion: 0.22
Nodes (3): SttEngine, FakeStt, FakeVad

### Community 19 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, declaration, declarationMap, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution (+11 more)

### Community 20 - "compilerOptions"
Cohesion: 0.11
Nodes (18): compilerOptions, lib, noEmit, outDir, rootDir, types, exclude, extends (+10 more)

### Community 21 - "WsServer"
Cohesion: 0.18
Nodes (4): stripDataUrl(), ctx, WsScreenContextProvider, WsServer

### Community 22 - "resolveBrain"
Cohesion: 0.20
Nodes (8): ProactiveNotice, resolveBrain(), defaultWatches(), ProactiveManager, ProactiveManagerDeps, runWatch(), watch, Watch

### Community 23 - "tsconfig.json"
Cohesion: 0.13
Nodes (14): compilerOptions, lib, outDir, rootDir, types, exclude, extends, include (+6 more)

### Community 24 - "LocalCascadeProvider.ts"
Cohesion: 0.18
Nodes (6): LocalCascadeOptions, VadEngine, BrowserVadEngine, createLocalCascadeProvider(), optionalImport(), WhisperSttEngine

### Community 25 - "tsconfig.json"
Cohesion: 0.14
Nodes (13): compilerOptions, lib, outDir, rootDir, exclude, extends, include, dist (+5 more)

### Community 26 - "ConfigStore"
Cohesion: 0.23
Nodes (6): ConfigChangeListener, ConfigStore, DEFAULT_CONFIG, WorkerKingConfig, computePersonaAppend(), assemblePersonaAppend()

### Community 27 - "tsconfig.json"
Cohesion: 0.18
Nodes (10): compilerOptions, outDir, rootDir, exclude, extends, include, dist, src/**/*.ts (+2 more)

### Community 29 - "Supervisor"
Cohesion: 0.36
Nodes (3): Supervisor, ctx, WsClient

### Community 30 - "protocol.test.ts"
Cohesion: 0.22
Nodes (8): EnvelopeContext, isKind(), makeEnvelope(), parseEnvelope(), PROTOCOL_VERSION, ProtocolError, serializeEnvelope(), ctx

### Community 31 - "GptRealtimeProvider.ts"
Cohesion: 0.38
Nodes (5): computePcm16Rms(), extractTranscript(), SessionFactoryConfig, VoiceProviderState, VoiceToolSpec

### Community 33 - "chat.ts"
Cohesion: 0.33
Nodes (5): api, WorkerKingChatApi, api, WorkerKingConnection, WorkerKingOverlayApi

### Community 39 - "TtsEngine"
Cohesion: 0.22
Nodes (3): FakeTts, TtsEngine, KokoroTtsEngine

## Knowledge Gaps
- **242 isolated node(s):** `name`, `version`, `private`, `description`, `license` (+237 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createRealtimeSessionFactory()` connect `GptRealtimeProvider` to `LocalCascadeProvider.ts`, `main.ts`?**
  _High betweenness centrality (0.112) - this node is a cross-community bridge._
- **Why does `MemoryStore` connect `MemoryStore` to `main.ts`, `tools.ts`, `main.ts`?**
  _High betweenness centrality (0.080) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _242 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05328218243819267 - nodes in this community are weakly interconnected._
- **Should `main.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06845513413506013 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.0463768115942029 - nodes in this community are weakly interconnected._
- **Should `TaskManager.test.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07862679955703211 - nodes in this community are weakly interconnected._