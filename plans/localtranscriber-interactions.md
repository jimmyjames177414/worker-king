# LocalTranscriber ↔ WorkerKing — Interaction Guide

WorkerKing registers LocalTranscriber's MCP stdio server alongside its own in-process tools.
Claude can then call LocalTranscriber's tools during any conversation — voice or text.
LocalTranscriber's own OpenAI Realtime voice session becomes optional; WorkerKing is the voice layer.

**To enable:** Set `localTranscriberEnabled: true` in WorkerKing settings. Build LocalTranscriber's MCP project first:
```bash
dotnet build C:/_repos/LocalTranscriber/src/LocalTranscriber.Mcp
```
Then toggle the setting — the daemon registers the MCP server on next start.

**MCP tools available:** `tail_transcript`, `read_current_transcript`, `start_transcription`,
`stop_transcription`, `list_sessions`, `list_known_speakers`, `export_minutes` (and others from the MCP server).

---

## Live meeting queries

### What's happening right now
- *"What are they discussing right now?"*
- *"What did she just say?"*
- *"Give me the last 2 minutes of the meeting."*
- *"What's the current topic?"*
- *"Catch me up — I just joined."*
- *"Read me the last few lines of the transcript."*

### Specific speaker or topic
- *"What did Sarah say about the deployment?"*
- *"Has anyone mentioned the API changes?"*
- *"What did Krishna say earlier?"*
- *"When did they start talking about the deadline?"*
- *"Was there any mention of the BTT project?"*

### Participants
- *"Who's speaking in this meeting?"*
- *"Who's been talking the most?"*
- *"Is [name] on this call?"*
- *"List the known speakers."*

---

## Action items & decisions

- *"What action items have come up so far?"*
- *"What decisions were made in this meeting?"*
- *"List the commitments from this call."*
- *"Who's responsible for what, based on what was said?"*
- *"What did we agree to follow up on?"*
- *"Were there any blockers mentioned?"*
- *"What open questions are still unresolved?"*

---

## Meeting control

- *"Start transcribing."*
- *"Stop transcription."*
- *"Are you transcribing right now?"*
- *"Pause the transcript."*
- *"Resume transcription."*

---

## Session management

- *"List my transcription sessions from this week."*
- *"Load the transcript from Monday's standup."*
- *"Show me the sessions for the BTT project."*
- *"What was discussed in yesterday's recording?"*
- *"Find the session where we talked about the DNS change."*

---

## Post-meeting processing

- *"Summarize this meeting."*
- *"Write up the key decisions from this call."*
- *"Draft action items with owners based on what was said."*
- *"Export the minutes from this session."*
- *"Write a follow-up email summary."*
- *"What should I add to my sprint notes from this meeting?"*
- *"Did anything come up that I need to log as a work item?"*

---

## Combined scenarios (LocalTranscriber + Sprint)

Queries that synthesize meeting transcript + sprint state in one shot:

- *"We just agreed to push the BTT deployment to next week — note that on the sprint story."* → Claude reads transcript for context, writes a note to sprint via `POST /api/note`
- *"Is the thing we're talking about right now on my sprint?"* → Claude cross-references live transcript with sprint items
- *"After this meeting, what should I tackle first?"* → Claude synthesizes meeting outcomes with current sprint focus list
- *"They mentioned a new requirement — should I create a work item?"* → Claude assesses against sprint capacity and incoming queue
- *"What was decided about the deployment story?"* → Claude reads both transcript and sprint story notes
- *"Who said they'd own the API fix? Add them as a note on the story."* → Claude reads transcript attribution, writes the sprint note
- *"Recap the meeting and tell me what's changed on my sprint as a result."* → full synthesis pass

---

## How WorkerKing replaces LocalTranscriber's Realtime session

When WorkerKing is running and `localTranscriberEnabled: true`:

| Before | After |
|--------|-------|
| You speak to LocalTranscriber's WPF UI | You speak to WorkerKing's voice overlay |
| LocalTranscriber's hand-rolled OpenAI Realtime WS session answers | Claude calls LocalTranscriber MCP tools and answers |
| Two separate voice pipelines | One voice pipeline (WorkerKing), one transcription engine (LocalTranscriber) |

LocalTranscriber keeps doing what it does best: offline Whisper STT, speaker diarization, session management, and the MCP stdio server. The ~600-line `RealtimeVoiceSession.cs` becomes optional/unused — you can disable it from LocalTranscriber's settings.

The prompt to apply to the LocalTranscriber codebase to remove its Realtime logic was provided in a prior session. Apply it when ready.

---

## Near future

- **Ambient meeting context in persona**: When a transcription session is active, WorkerKing's daemon injects the last N lines of transcript into Claude's system prompt so Claude is always aware of meeting context without a tool call. Pattern: add a `TranscriberContext` class following the `EnvironmentContext` / `SprintContext` pattern and wire into `PersonaContext`.
- **Automatic action-item detection**: WorkerKing watches for phrases like "I'll take that" or "can you own this" in the live transcript and surfaces them as proactive notifications via `proactive.notify`.
- **Sprint-triggered transcription**: *"Start recording the sprint review"* — voice command starts LocalTranscriber via MCP.
- **Meeting summary → sprint incoming queue**: After a meeting with commitments, Claude automatically populates `state/incoming.json` with any new work items implied by what was discussed.
