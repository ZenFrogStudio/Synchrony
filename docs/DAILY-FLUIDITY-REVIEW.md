# Daily Chronos fluidity review

You are carrying this out unattended. Everything that needed deciding has been
decided below — follow it as written, produce the report, and do not stop to ask
questions. This review **changes no code**. Every file it writes lands inside
`.chronos`, which carries a `.gitignore` of `*` written by `ensureRoot`
(`src/roots.ts:83`), so the run leaves the git working tree exactly as it found
it: nothing to commit, nothing to clean up in the morning.

## Why this exists

The mission of Chronos is to provide the most fluid user experience for
scheduling and managing coding agent tasks in VS Code. That is a claim about
friction, and friction is invisible from the inside — the person who built a
journey stops counting its steps after the tenth time through it. This review
walks the journeys daily with fresh eyes and reports where they cost more than
they should.

"Fluid" needs an operational meaning or the report degenerates into taste:

> Fluidity is the count of actions, waits and dead ends between having an idea
> and having a finished run. A finding is a place where that count is higher than
> it needs to be, or where the user cannot tell what state their work is in.

This is the third standing review in the same family. Security is weekly and
adversarial; the retired codebase audit covered performance and correctness; this
one is daily and is about friction. It writes **recommendations only** — one
dated report and at most three inbox tasks. It writes no fix plans, because at a
daily cadence that would fill the plan library faster than anyone could read it.

## Hard rules

These bound what a recurring unattended agent may do to this repo. They are not
advisory.

1. **Do not modify the codebase.** Nothing in `src/`, `media/`, `test/`, `docs/`,
   `package.json`, `README.md`, `CHANGELOG.md`, `esbuild.js` or any config. Do
   not bump the version and do not add a changelog entry — nothing shipped
   changed.
2. **Do not touch git beyond reading.** `log`, `diff`, `show`, `status` are fine.
   No `add`, `commit`, `push`, `checkout`, `stash`, `branch`.
3. **Write to exactly two places, both under `.chronos`:**
   - `.chronos/audits/` — one dated report, this run.
   - `.chronos/tasks/` — at most three new `.md` files.

   Nothing else. In particular never write `.chronos/plans/`,
   `.chronos/state.json`, `.chronos/archive` or `.chronos/.pending`. Writing
   `state.json` is how this plan would put its own conclusions on the schedule,
   and not doing it is the point: a person decides what runs.
4. **Never delete or edit an existing file** anywhere — including existing tasks
   and previous reports.
5. **Do not install anything.** No `npm install`, no `npx`, no network access.
6. `npm run typecheck` and `npm test` are permitted and useful — `typecheck` is
   `--noEmit` and the test build writes only to git-ignored `dist-test/`. Run
   them for signal, not to fix anything.
7. **If a shell command is refused by permission gating, carry on.** The
   substance comes from reading files; `git log` and the test run are
   accelerants, not requirements. A denied command degrades the report, it does
   not end the run. Say in the report which ones were unavailable.

## Step 1 — establish what changed since yesterday

This is the step that makes a daily cadence affordable. Read the **newest** file
in `.chronos/audits/` in full before looking at any source. All three naming
families count: `*-codebase-audit.md`, `*-security-review.md` and
`*-fluidity-review.md`. Note its date. Then:

```bash
git log --oneline --since=<date of that report>
git diff --stat <ref-around-that-date>..HEAD
git status --short
```

New and changed files get the closest reading. This does **not** limit scope — a
finding in code untouched for a month is still a finding. Files modified in the
working tree are the user's live edits: review them, and say in the report that
they were uncommitted at the time of reading, because they may look different by
the time the report is read.

**If there are no new commits and no uncommitted changes since the last fluidity
review**, skip the full route. Re-verify the still-open backlog, write the short
report described under "A quiet day is a success", create no tasks, and stop.
Most days will be this day, and that is the design working, not failing.

A first run with no previous report is normal: `mkdir -p .chronos/audits`, treat
every finding as new, and walk the full route.

## Step 2 — walk the fixed fluidity route

Walk these in order, every run. A fixed route is what makes two reports
comparable; wandering produces a different-looking report every day from an
unchanged codebase. The line numbers below are anchors from the day this plan was
written and will drift — **find the construct, not the line.**

- **The spine: `capture → generate → schedule → run`.** `src/tasks.ts` — the
  inbox, `TaskView`, `generatePlan` (`src/tasks.ts:380`), `runTask`
  (`src/tasks.ts:316`); `src/manager.ts` — the plan library and the detail pane;
  `src/adopt.ts` — a generated plan landing in the library. Walk it end to end as
  a user would and count the actions at each hop. Every extra click, tab switch
  or confirmation between the idea and the scheduled run is the primary subject
  of this review.
- **Dead ends and unrecoverable states.** A planning session whose terminal died
  leaving a row amber forever; a task whose **Run** finished but did not clear; a
  plan scheduled with no working directory; a missed occurrence waiting on a
  decision the user never sees. `awaitingPlan` (`src/tasks.ts:113`) and `running`
  (`src/tasks.ts:121`) are in-memory only by design — check the documented
  recovery still exists and is visible in the UI, not just in the code.
- **State legibility.** Can the user tell, from the manager alone and without
  opening anything, what is running, what is next, what failed, what was retried,
  what was missed, and what succeeded while doing less than asked (`⚠ N denied`)?
  `src/status.ts`, `src/activity.ts`, `src/outcome.ts`, `media/manager.js`,
  `media/tasks.js`. Anything that fails silently is a fluidity finding.
- **Time to first value.** What a new user sees before anything works: the setup
  banner (`#setup`, `media/manager.html:16`), the seeded Hello Chronos plan
  (`seedLibrary`, `src/library.ts:193`), and the empty states in both webviews.
  Is the first successful run reachable without reading the README?
- **The schedule editor.** `repeatOf` (`media/manager.js:265`), `scheduleSection`
  (`media/manager.js:883`) and the repeat/day/time handlers
  (`media/manager.js:1822`). Setting a time is the single most repeated
  interaction in the product. Count the actions to express "every weekday at
  09:00" and "the 15th monthly", and check what the UI does with a rule it cannot
  draw.
- **Keyboard and focus.** The `data-focus-key` system (`media/manager.js:407`),
  the task field and row handlers in `media/tasks.js`, Enter and Escape
  behaviour, focus restoration after a re-render, and tab order through the
  detail pane. A documented key table is enforced by `test/source-guards.test.ts`
  — check the UI still matches it.
- **Latency the user actually feels.** Not throughput. The 30-second tick
  (`src/scheduler.ts:82`), full-state posts and whole-view rebuilds on every store
  change, and the synchronous `readdirSync`/`statSync` per file in `listPlans`
  (`src/library.ts:211`). Report these only where they show up as a visible
  stall, a flicker, or lost focus — the general performance case belongs to the
  audit plan, not here.
- **Reading what a run did.** `src/transcript.ts`, `src/results.ts`, the Runs
  section and the **result** and **raw log** buttons. A scheduled run is read
  after the fact, so the distance from "a run finished overnight" to "I know what
  it did" is core to the mission.
- **Answering from elsewhere.** `src/questions.ts`, `src/mcp-tools.ts`,
  `src/remote.ts`. Press **Generate plan** and walk away is a headline promise —
  check the round trip has no step that silently requires the user back at the
  terminal.
- **Promise versus behaviour.** Read `README.md` against the code. Where the
  README describes something the code no longer does, say so. This is the
  cheapest class of real finding and the most common in a fast-moving repo.
- **New features, not only repairs.** The mission asks for improvements *or new
  features*. Reserve attention each run for the absent thing: a step the user has
  to do outside Chronos, a journey with no affordance at all. A proposed feature
  is held to the same bar as a defect — it must name the journey it shortens and
  by how many actions.

## Step 3 — qualify every recommendation

The failure mode of a daily review is a plausible-sounding list nobody acts on,
and a daily cadence reaches that failure four times faster than a weekly one. A
recommendation earns its place only if all of these hold:

- **It names a journey and a step in it.** "Scheduling a generated plan, at the
  point the manager opens" — not "the UI could be smoother".
- **It has an address.** `file:line`, with the construct named. Unanchored
  findings are dropped, not softened.
- **The cost is counted.** Actions, keystrokes, tab switches or seconds today
  versus after the change. A number the user can disagree with is worth more than
  an adjective.
- **It is reachable in the shipped UI.** Something only an agent or a hand-edited
  `state.json` can reach is not a fluidity finding.
- **It was verified in the current code, this run.** Never carried forward from a
  previous report on trust. Anything now fixed moves to "Fixed since last
  review", which is how the user sees this paying off.
- **It is not already the documented intended design.** This codebase argues its
  reasoning in comments — the inbox being a webview rather than a tree
  (`src/tasks.ts:38`), the directory *being* the database (`src/library.ts:4`),
  local wall-clock recurrence (`src/types.ts:27`), no "run now" tool over MCP.
  Read the comment before calling a decision a defect. Disagreeing is allowed;
  not noticing is not.
- **Its impact is argued in the same sentence.** High / Medium / Low, where
  **High** means it blocks or silently loses a journey the user takes every day.

At most **six** findings in the Findings section, most impactful first.

## Step 4 — pick today's three

Every report closes on exactly the thing the mission asked for: **the three
highest-value improvements open right now**, ranked. They are drawn from the new
findings *and* from the still-open backlog of previous reports, re-verified this
run — so a slow day still produces three real recommendations rather than three
invented ones. Fewer than three is correct only when fewer than three are open
across the whole backlog.

## Step 5 — write the report

Write to `.chronos/audits/<YYYY-MM-DD>-fluidity-review.md`, using the **local**
date, matching the naming of `.chronos/results`. If that name is taken — the user
pressed **Run now** on a day the schedule also fired — append `-2`, `-3` and so
on rather than overwriting.

Use exactly this structure:

```markdown
# Chronos fluidity review — <YYYY-MM-DD>

Version <package.json version> · commit <short sha> · <N> commits since <previous review date>
Checks run: typecheck <pass/fail/unavailable>, tests <pass/fail/unavailable>

## Today's three

1. <Title> — <High|Medium|Low> · <journey> · <new today | open since YYYY-MM-DD>
2. ...
3. ...

## Summary

<Three or four sentences: where the product is losing the user today, the single
most valuable thing to do, and whether anything got worse since yesterday.>

## Fixed since last review

- <finding from a previous report, verified fixed, with the commit or file that fixed it>

## Findings

### 1. <Title> — <High|Medium|Low> · <Journey>

**Where:** `src/file.ts:120`
**The friction:** <the step, and what it costs today — counted>
**Why it matters:** <consequence, in one sentence>
**Suggested change:** <the smallest change that resolves it — a direction, not code>

### 2. ...

## Still open, not re-listed

- <re-verified findings from previous reports, one line each, with the date they
  first appeared>

## Captured as tasks

- <exact text of each task file written this run, or "none">

## Not examined

- <anything skipped, and why — a denied command, a subsystem out of scope>
```

Match the prose voice of `README.md` and the existing plan files: plain English,
say why, no filler. Keep it scannable — the user reads this over coffee, not in a
review meeting.

## Step 6 — capture the top three as inbox tasks

Only findings **new this run** become tasks; a backlog item already in the inbox
is already captured. Fewer than three is correct when fewer than three deserve
it. Zero is a valid day.

The task inbox is a folder of `.md` files with no index. The sidebar renders each
file's first non-empty line as its row (`taskLabel`, `src/library.ts:152`), and
Chronos derives file names with `toPlanFileName` (`src/library.ts:41`). Match
that convention exactly or the row looks wrong:

- **Content:** one line of plain text, no heading, no bullet, ending in a
  newline, written as an instruction the way the user writes tasks: *"Restore
  focus to the renamed plan's row after the library re-renders
  (media/manager.js:407)."* Include the `file:line` — that is what makes the task
  useful when it becomes a plan later.
- **File name:** that line, lowercased, every run of non-alphanumeric characters
  replaced by a single hyphen, leading and trailing hyphens stripped, cut to 60
  characters, plus `.md`.
- **Collisions:** if the name is taken, append `-2`, `-3` … Never overwrite.

Nothing else in `.chronos/tasks/` is touched. Existing tasks are the user's.

## De-duplication — the rule the whole thing depends on

At a daily cadence this is not a nicety; without it the inbox is unusable inside
a week. Before writing anything, read:

- **every** existing file in `.chronos/tasks/`, and
- the "Captured as tasks" and "Fix plans written" sections of **every** report in
  `.chronos/audits/`, across all three naming families.

If a finding was already captured — even under different wording, even by the
security or audit plan — it does not become a task again. It may still appear in
"Today's three" and in "Still open, not re-listed", which is how a long-standing
item stays visible without multiplying.

## A quiet day is a success

Most days nothing new will cross the bar. Write the short report anyway: the
route was walked or skipped and why, what was re-verified, today's three from the
standing backlog, and that nothing new was found. Create no tasks. Do not pad the
list to look productive — the value of a daily plan depends entirely on the user
trusting that a finding in it is real.

## Out of scope

- `node_modules/`, `dist/`, `dist-test/`, the committed `.vsix` files.
- The historical `docs/*-PLAN.md` design documents.
- Anything in `.chronos/results`, `.chronos/logs` or `.chronos/archive` — run
  output, not code.
- **Security, which belongs to the weekly security review.**
- General performance and correctness that the user does not feel as friction,
  which belong to the audit plan.
- Marketplace publishing and the release process.
