# Sprint ↔ WorkerKing — Interaction Guide

WorkerKing connects to the Sprint standup dashboard (`http://127.0.0.1:5757`) running locally.

**Two integration channels:**
- **Pull** — Claude reads Sprint state on demand via `get_standup_state` tool
- **Push** — Sprint sends spoken alerts to WorkerKing's avatar when important things happen

**Prerequisite:** Run the topology spike before wiring any push integration:
```bash
# From WSL2, with WorkerKing daemon running Windows-native:
node -e "require('./bin/notify.js').notify({title:'test',body:'ping',level:'info'}).then(console.log)"
# Expect: { sent: true }
```
If this fails with a connect error, resolve networking first (Windows 11 mirrored networking, or run daemon in WSL).

---

## Channel 1: You ask → Claude reads Sprint

Works today. Claude calls `get_standup_state` (fetches `/api/state`) and answers.

### Sprint status & capacity
- *"What's on my plate today?"*
- *"How are we looking for the sprint?"*
- *"When does this sprint end?"*
- *"Am I overcommitted this sprint?"*
- *"How many hours do I have committed versus capacity?"*
- *"What's my unestimated work?"*
- *"How many days left in the sprint?"*

### Work items
- *"What are my open tasks?"*
- *"What's the status on the BTT go-live story?"*
- *"Which of my tasks are still In Progress?"*
- *"What tasks haven't I started yet?"*
- *"What's due soonest?"*
- *"Show me everything assigned to me."*

### PRs
- *"Do I have any PRs waiting for review?"*
- *"What's the approval status on my BTT PR?"*
- *"Who still needs to approve PR 278457?"*
- *"Do I have any draft PRs I should finalize?"*
- *"How many active PRs do I have open?"*

### Changes & overnight diff
- *"What changed overnight in my work items?"*
- *"Were any new tasks assigned to me?"*
- *"Did anything close since yesterday?"*
- *"What got reassigned?"*
- *"Any new items since my last check?"*

### Focus & priorities
- *"What should I work on first?"*
- *"Which focus item is most urgent?"*
- *"What's the why behind my top focus item?"*
- *"Walk me through my focus list."*
- *"Is my focus list still accurate given what changed?"*

---

## Channel 2: You command → Claude delegates work to the Sprint repo (B1)

*Requires the `settingSources` bridge first: a Sprint skill in `.claude/skills/` OR a persona append carrying the CLAUDE.md standup triggers.*

These trigger `delegate_to_worker({ folder: 'sprint', task: '...' })` — Claude runs inside the sprint repo with full CLAUDE.md context, doing real curation work.

### Morning standup
- *"Do my morning standup."*
- *"What's my standup script for today?"*
- *"Give me my daily briefing."*
- *"Prep me for standup in 5 minutes."*
- *"Run the morning routine."*

### Focus curation
- *"Curate my focus list based on what's urgent."*
- *"Reorder my focus — the BTT deployment is more critical than it looks."*
- *"Add a note to task 2491892 that I'm blocked on the DNS change."*
- *"Mark focus item t2 as waiting."*
- *"Update my focus to reflect the sprint review is tomorrow."*

### Notes & processing
- *"Note that the BTT timeline slipped to next week."*
- *"Process my notes from this morning."*
- *"I've captured notes in the dashboard — process them now."*
- *"Write up the context behind why this task is waiting."*

### Hours & estimates
- *"Apply the suggested hours to my tasks."*
- *"What's the suggested estimate for the deployment task?"*
- *"How much work do I realistically have left this sprint?"*
- *"Which tasks are unestimated?"*

### Weekly & review
- *"Give me a week in review."*
- *"What did I close this week?"*
- *"Prep the evening wrap summary."*
- *"What's my velocity been this sprint?"*

---

## Channel 3: Sprint speaks to you (unprompted alerts)

*Requires A1 (notify.js wiring in fetch.js) + topology spike to pass.*
These fire automatically when Sprint detects important changes.

### Morning fetch — daily briefing (A2 voice digest)
WorkerKing speaks a speech-optimized summary when the morning cron fetch completes:
- *"Morning. Two new tasks assigned overnight. One PR needs your review. Sprint closes Friday and you're 15 hours over capacity."*
- *"Quiet morning. No changes overnight. Sprint's on track."*
- *"Good morning. Three things: a new deployment task was assigned, the BTT PR needs one more approval, and your sprint estimate is still over capacity by 30 hours."*

### New item assigned mid-day
- *"New task assigned: Deploy Spa Source, linked to the Sprint 2 stories."*
- *"You've got a new task: [title]."*

### PR review needed
- *"PR 278457 — BTT frontend — needs your review. Two of five approvals so far."*
- *"You're listed as a reviewer on [PR title]. It's been waiting 2 days."*

### Stale data warning
- *"Sprint data hasn't refreshed in 22 hours. You may want to run a manual refresh."*

### Guard trip warning (silent toast only — no speech)
- Dashboard toast: "Sprint data guard tripped — snapshot not updated. Item count dropped unexpectedly. Check the fetch log."

---

## Channel 4: Reminders from Sprint context (D5)

You ask Claude to set reminders tied to Sprint deadlines. Claude calls `mcp__workerking__set_reminder`:

- *"Remind me about the BTT DNS deadline on Friday morning."*
- *"Set a reminder for the sprint review tomorrow at 9 AM."*
- *"When does this sprint close? Remind me the day before."*
- *"I need to submit timesheets by Friday — remind me Thursday afternoon."*
- *"Remind me to follow up on the deployment story if I haven't closed it by Wednesday."*

---

## Combined scenarios

Queries that synthesize Sprint + other context in one shot:

- *"We just agreed to push the BTT deployment to next week — note that on the story."* → Claude writes a sprint note via `POST /api/note`
- *"Is the thing we're discussing right now on my sprint?"* → Claude cross-references live meeting transcript with sprint items
- *"After this meeting, what should I tackle first?"* → Claude synthesizes meeting outcomes with current focus list
- *"My standup is in 10 minutes — prep me."* → Claude reads sprint state + overnight diff + focus list, produces a spoken summary
- *"Did anything get assigned to me while I was in that meeting?"* → Claude checks diff against meeting duration

---

## Near future

- **A2 — Voice digest quality**: Speech-optimized `state/script.json` built by fetch.js so IDs and URLs are never read aloud as digit soup.
- **SSE subscription in WorkerKing daemon**: Daemon watches Sprint's `/events` stream and auto-speaks diffs without Sprint needing to call back into WorkerKing. Topologically cleaner (Windows → WSL2, same direction as `get_standup_state`).
- **Compact sprint summary in persona**: 150-token sprint block injected into every Claude turn so Claude is always sprint-aware without a tool call.
- **Avatar mood from sprint health** (D2): Orb turns amber on guard trip or auth failure; calm on zero-diff day. Waiting on avatar upgrade.
- **Screen-aware sprint** (D3): *"What task is this PR for?"* when looking at the PR in the browser. Privacy-gated; high effort.
- **Wake-word standup** (D4): *"Hey WorkerKing, what's on my plate"* — trivial once B1 is proven.
