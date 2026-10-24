# The Owner Model: how Mercury grows with its owner

*Evaluation and design, 24 October 2026. Companion to ADR-026 in DECISIONS.md.*

## 1. What we promise and what we do

The persona file shipped with every install says "I remember preferences and adapt over time" and
"I evolve with every conversation". Today neither is true. Mercury stores facts; it does not form a
picture of the person, test it, or change how it works because of it.

### Measured on the owner's own machine (867 memories, 20 April to 24 October)

| What we found | Number | Why it matters |
|---|---|---|
| Rows labelled `preference` | 456 of 867 | Half the store is "preferences" |
| …of which are **Mercury's own replies** stored as the owner's preferences ("I appreciate the detailed instructions, but I need to clarify my actual capabilities: I'm Claude…", WhatsApp "For the chat:" blocks, "Open Slack on your computer") | 185 | The extractor cannot tell who said what |
| Rows produced by the non-JSON fallback (prose split into lines, saved as `preference`, confidence 0.75) | 420 | Junk is saved with the same confidence as truth |
| Rows whose evidence was ever seen twice | 2 | Nothing is ever confirmed |
| Rows superseded or dismissed by a contradiction | 0 | Nothing is ever retired |
| Near-duplicate rows | 57 | Nothing is merged |
| Average confidence (flat, never updated) | 0.83 | Confidence is a label, not a belief |
| Soul files changed since install day | 0 | Nothing writes what it learns back |
| Created in the last 7 days | 601 | Volume without understanding |

### Root causes (from the code audit; file:line on branch `fix/chat-quality-permissions`)

1. **Extraction sees one exchange, no history, no existing beliefs** (`src/core/agent.ts:4414-4551`). It can only append. It cannot say "already known", "stronger now", "the opposite of what I thought" or "the owner just corrected me".
2. **Assistant text is in the extraction input** and the fallback saves any line as a preference (`agent.ts:4499-4514`). That is where the 185 self-descriptions come from.
3. **Merging is effectively off** (`src/memory/user-memory.ts:297-307`): a `LIKE` over any shared word, first row only, overlap ≥ 0.74. Evidence counts stay at 1, so `promoteToDurable` never fires.
4. **Conflict handling deletes at random** (`user-memory.ts:506-543`, `second-brain-db.ts:375-393`): any same-type row sharing one word plus a substring "not" (matches "note", "another") is dismissed and hard-deleted on the next heartbeat. No similarity check, no audit trail, no question to the owner.
5. **The consolidated profile never reaches the chat model.** Only ≤ 5 keyword-matched lines go into each turn, ranked 0.3 confidence / 0.25 importance / 0.1 relevance (`user-memory.ts:557-575`). The profile summary is used only for voice calls and `/memory`.
6. **No trait layer.** "Reflections" are string templates gluing two summaries together (`user-memory.ts:1049-1107`). Sessions, tool traces, the work ledger, permission answers, model switches and timestamps are never mined.
7. **Silent.** Learning never tells the owner anything; there is no confirm, correct or forget from chat.
8. **Decay is mis-keyed**: using a memory doesn't refresh `last_seen_at`, so useful memories fade and junk survives.

## 2. What the best systems do (research, October 2026)

- **Hermes Agent** (Nous): a `USER.md` the agent edits itself (1,375-char cap, so it must consolidate), a `MEMORY.md` for lessons, periodic "nudges" that make the agent decide whether the session taught it anything, skills written after non-trivial workflows or **after a user correction**, staged writes the owner can approve or reject (`/memory pending|approve|reject`), and a one-line notice in the next reply when something was saved. It stores text, not beliefs: no confidence, no contradiction handling beyond "patch the file".
- **Honcho** (Plastic Labs, used by Hermes for user modelling): a representation built from premises and three kinds of conclusions — *deductive* (certain from what was said), *inductive* (patterns across many messages: "often mentions deadlines, rarely hobbies → time-constrained"), *abductive* (simplest explanation of behaviour). New messages refine conclusions; conflicts are reconciled rather than piled up. Queried in natural language.
- **Letta / MemGPT**: a second, idle-time agent rewrites the main agent's core memory ("sleep-time compute"). Memory edits are explicit tool calls.
- **Generative agents** (Stanford): periodic *reflection* that synthesises many memories into higher-level insights; retrieval scores relevance × recency × importance.
- **Bitemporal stores** (Zep, TOKI 2026): every fact carries a validity window; contradictions set `valid_to` instead of deleting.
- **Forgetting** (FadeMem, Ebbinghaus-style decay, 2026): confidence decays unless reinforced; reinforcement comes from re-observation *and* from acting on a belief without being corrected.
- **Preference learning through interaction** (MultiSessionCollab, 2026): after each session the agent reflects on the conversation against its existing notes and outputs *refined, merged or split* preferences with the condition under which each applies. Gains were steepest in the first five sessions. Failure mode: rewriting notes forgets useful detail.
- **Validity of personality inference**: inferring Big Five traits from text correlates only r ≈ 0.3 with the real thing, and a model's own confidence does not track its accuracy. We do not do this. We model *working traits* that change Mercury's behaviour, as distributions with evidence, and we let the owner see and correct them.

## 3. Design

### 3.1 Beliefs, not facts

A memory becomes a **belief**: a claim about the owner that Mercury holds with a degree of confidence, backed by evidence, valid for a time, in a context.

```
belief
  id, owner_key
  kind         fact | preference | trait | situation | relationship | goal | project
  dimension    (traits only) e.g. brevity, autonomy, detail, formality, decision-style,
               risk:<domain>, expertise:<domain>, rhythm, values
  statement    "Prefers one command over many manual steps"
  level        (traits only) the inferred level on that dimension, e.g. autonomy = high
  context      where it applies: channel, project/cwd, domain, time-of-day, or "*"
  support      count of supporting evidence     }  confidence = Beta(support+1, against+1),
  against      count of contradicting evidence  }  decayed by time since last support
  timescale    stable | situational (hours) | episodic
  status       candidate | held | confirmed (owner said so) | contested | retired
  valid_from, valid_to, superseded_by          (bitemporal: nothing is deleted)
  last_supported_at, last_used_at
  owner_stated 0/1                              (what the owner said beats what we inferred)

evidence
  id, belief_id, kind (said | corrected | approved | denied | reacted | observed | acted-on-ok)
  session_id, turn_ref, excerpt (≤ 200 chars), weight, at
```

Rules:
- A belief starts as a **candidate** (support = 1). It becomes **held** at support ≥ 2 from different sessions, or immediately when **owner-stated**.
- **Acting on a held belief without correction** adds weak support (weight 0.25). A correction adds strong against-evidence (weight 2) and, if it names the right answer, creates the replacement belief as owner-stated.
- Two beliefs that contradict in the same context are **contested**. Contested beliefs are not used; Mercury asks the owner once, at a natural moment, and the answer settles it.
- Confidence decays (half-life 60 days for stable traits, 7 days for situations) unless re-supported. Below 0.35 a belief is **retired** (kept, hidden, recoverable).
- The owner can **confirm**, **correct**, **forget** any belief from chat or the dashboard. Forgetting is permanent and leaves no trace in prompts.

### 3.2 What we learn: the working-trait dimensions

Chosen because each one changes what Mercury should do next, and each has observable evidence.

| Dimension | Levels | Evidence | Changes |
|---|---|---|---|
| **brevity** | terse · balanced · thorough | reply length the owner asks for ("shorter", "more detail"), message length, "tl;dr" requests | reply length, summaries first or not |
| **autonomy** | ask-first · ask-when-risky · just-do-it | permission answers (Allow All, "always"), "just do it", "why did you ask" | how often Mercury asks, what it does unprompted |
| **detail / expertise** per domain | novice · competent · expert | vocabulary, corrections of Mercury's explanations, which questions they skip | how much to explain, which assumptions to make |
| **decision style** | options · recommendation · decide-for-me | "give me options" vs "what should I do" vs "pick one" | present choices or a verdict |
| **formality** | casual · neutral · formal | how they write, emoji, greetings | tone |
| **risk** per domain (money, deletion, sending, publishing) | cautious · normal · bold | approvals and denials by action type, "don't ever publish without asking" | what needs confirmation |
| **rhythm** | active hours, quiet hours, typical session length | timestamps across channels | when to send proactive messages; what "later" means |
| **values** | stated principles ("open source", "own my files", "ship fast") | explicit statements, repeated choices | how options are framed |
| **feedback style** | how they correct (blunt / explain / silent redo) | correction patterns | how Mercury confirms it understood a correction |
| **situation** (situational, hours) | under time pressure, frustrated, exploring | short messages, repeated requests, "ugh", late night | tone and pace *for now*; never stored as a trait |

What we deliberately do **not** infer: personality types, health, religion, politics, sexuality,
or anything about a third person beyond what the owner said about them. If the owner states one of
these, it is stored as a stated fact, used only when relevant, and never generalised.

### 3.3 Where the evidence comes from

Every turn already leaves these behind; today none of them are read:

- the owner's words (only the owner's; assistant text is never a source for owner beliefs)
- corrections: "no, I meant", "that's not what I asked", redoing the same request, rejecting output
- approvals and denials by action type; "always"; permission-mode changes
- reactions after Mercury acts on a belief (no complaint = weak support)
- model switches, mode switches, `/permissions`, `/memory forget`
- timestamps, channel, session length, project/cwd
- the work ledger: what was asked, what finished, what failed

### 3.4 Two learning loops

**Per turn (fast, cheap):** the existing extraction, rebuilt. Input: the owner's message, the
reply, the last few turns, the *relevant existing beliefs*, and the turn's signals. Output: a list of
belief operations — `support`, `contradict`, `create`, `owner_stated`, `correction` — or `[]`. Never
prose. Assistant text is labelled as such and may only produce "what Mercury did" episodes.

**Reflection (slow, periodic — the "sleep-time" pass):** on the heartbeat (60 min) when ≥ 1 session
closed, and at shutdown. Reads the sessions since the last pass plus the signals above, and the
current trait distributions. Produces: trait-level updates with evidence, merges of near-duplicate
beliefs, contested pairs, and a regenerated **owner brief**. This is where patterns across sessions
appear ("you have asked for a shorter version 6 times across 4 sessions").

### 3.5 How the model sees the owner

Two prompt pieces, both regenerated by reflection (not per turn, so the prompt cache holds):

1. **About {owner}** (≤ 400 tokens): stated facts and held beliefs, with soft hedges on candidates
   ("seems to", "so far").
2. **How to work with {owner}** (≤ 250 tokens): the traits translated into instructions —
   "Keep replies short; lead with the result. Don't ask before reversible actions in their own
   repos; always ask before publishing. Give a recommendation, not a menu. They're an expert in
   TypeScript and DevOps; a beginner in video production — explain those."

Plus, per turn, up to 5 beliefs relevant to the message: held/confirmed first, then candidates labelled
"unverified, seen once" to fill the slots (otherwise nothing learned in the current session, and nothing
migrated, reaches the model until a second session supports it). Only the sure ones earn
"acted-on-ok" credit. A message that asks what Mercury knows about the owner gets the twelve strongest
beliefs instead of an FTS match. Stopwords and channel scaffolding are stripped from the query.

An `owner.md` in `~/.mercury/soul/` holds the same text so the owner can read and edit it, like
Hermes' `USER.md` but generated from beliefs and annotated with confidence.

### 3.6 Telling the owner

- When a turn produces a belief that **changes Mercury's behaviour** (a trait moves, a correction is
  learned, a contested belief appears), the reply ends with one short line:
  `☿ Noted: you'd rather I just run things in this repo without asking. Say "forget that" to undo.`
  At most one such line per reply; never for trivia.
- Contested beliefs are asked about once, at the end of a reply, never mid-task.
- `/memory` grows: **what I learned recently**, **what I believe about you** (traits with
  confidence), `confirm`, `correct`, `forget`, `pause`. The dashboard gets the same views and a
  review queue.
- `/memory` also shows the honest numbers: how many beliefs are held, candidate, contested, retired.

### 3.7 Hygiene and migration

- Existing rows: assistant-voice and fallback junk are **quarantined** (`dismissed = 1`,
  `provenance = migration:junk`), not deleted; the dashboard shows them under "Quarantined" for
  review. Real memories become `held` beliefs with support = evidence_count.
- The non-JSON fallback is removed. Extraction returns `[]` when there is nothing.
- Merge uses FTS candidates plus an LLM judge ("same claim?"), not a LIKE on one word.
- Decay keys on `last_supported_at`; use refreshes it weakly.
- The soul migration that overwrites edited files is removed.

### 3.8 Which model learns

`memory.learning.provider` (or `LEARNING_PROVIDER`) names the provider for extraction and reflection;
unset or unusable → the chat default. Both loops are strict-JSON tasks: on the free tier the extractor
returned `[]` or invalid JSON most of the time, so an owner on a free default learned almost nothing.
A Haiku-class model is enough and keeps the chat model choice untouched.

Measured on Haiku 4.5 (October 2026), four turn types × 2 runs: before the fixes below, 0 of 6 model
calls produced an operation; after, every substantive turn did (brevity=terse, autonomy=just-do-it
scoped to the project, the goal behind a crash report), and acknowledgements cost no call.
Two leaks: the trivial-message gate matched any message *starting* with "no"/"ok" (corrections!), and
a missing `excerpt` field — which the model omits now and then — discarded the whole operation. The
gate now applies only to short messages; a missing excerpt falls back to the owner's message.

### 3.9 One source, and what an existing owner sees

- `UserMemoryStore` is a facade over `BeliefStore`. Every reader and writer the old API had
  (`getRecent`, `search`, `getByType`, `retrieveRelevant`, `remember`, `updateMemory`,
  `softDeleteMemory`, `getShareable*`, `clear`, `getSummary`) maps onto beliefs, so `/memory`, the
  dashboard, the `save_memory` / `search_memory` tools, the bots and cloud sync all see one store.
  `consolidate()` is a no-op kept for callers; `prune()` is the decay pass. The `memories` table is a
  read-only archive: the quarantine queue and the persons graph still read it, nothing writes it.
- **Identity is config.** `identity.owner` in `mercury.yaml` is the one place the owner's name is
  set; the extractor and reflection prompts and both validators refuse beliefs that only state who
  the owner is or how to reach them (`looksLikeIdentity`).
- **Upgrade path.** On the first boot with a pre-Owner-Model database that has rows, the store
  copies it to `second-brain.pre-owner-model.db` before migrating (once; never overwritten). The
  migration is idempotent (`belief_meta legacy_migrated`), wrapped in try/catch so a failure boots
  Mercury with an empty belief store instead of crashing, and marks `reflection_force` so the
  migrated candidates are judged against real sessions two minutes after boot. "☿ Noted" lines are
  rate-limited to one per channel every three minutes so the backlog never floods a chat.
  Restoring a quarantined row creates a confirmed belief the owner vouched for (new id).
- Not yet moved: the persons graph (`memory_persons` keys into `memories`); it keeps reading the
  archive until relationship beliefs feed it.

### 3.10 Validation

- Unit tests on the belief store: support/against maths, decay, contest, supersession, forget.
- Scripted-provider eval scenarios (`src/eval`): "owner corrects brevity twice → next reply is
  short"; "owner says always ask before publishing → publishing asks even in Allow All";
  "contradiction in a different context stays separate"; "assistant text never becomes a belief";
  "junk is quarantined on migration".
- A dry run against the owner's real sessions on this machine, reporting what the engine would
  have learned, before it is switched on.

## 4. Phasing

1. **Hygiene** (fix extraction, merge, conflict, decay, migration, profile into prompt) — makes
   today's memory honest.
2. **Engine** (beliefs + evidence tables, signals, reflection pass, trait dimensions, owner brief
   and "how to work with" sections, learned-moment lines, `/memory` and dashboard).
3. **Validation loop** (act-and-observe support, contested questions, `owner.md`, eval scenarios).
