# Changelog

All notable changes to Chronos are documented here. Entries below predate the
rename from Chronus and are left as written.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

A visual redesign of the manager, which has been the extension's only UI since
the sidebar was removed. It was a flat stack of identically weighted sections, so
nothing answered *when does this run next?* at a glance and the run history — the
record of what the agent did overnight — sat below a 260px textarea, usually off
screen. That redesign changed nothing outside `media/`: no logic, no message
types, no storage.

Also in this release: registering Chronos with a coding agent becomes picking
your client from a list and pasting what it gives you, once. Eight clients, each
getting the config shape it actually wants, pointed at a path that survives the
next update.

Also in this release: test coverage for three of the 0.8.0-rc.3 audit fixes that
shipped without any, because they lived in modules that import `vscode` and
cannot load in the plain Node test runner. Closing the gaps meant moving the
logic out; one of the moves also narrowed a guard.

### Added

- **Chained plans: several plans in a row, each started by the one before it
  finishing.** Scheduling five plans for one evening meant opening each one and
  picking five times by hand, and guessing how long each would take. Guess short
  and they collide — and with `chronos.maxConcurrent` at its default of `1`, a
  collision is deferred or marked missed. There was no way to say "run these in
  order".

  **Chain**, beside Import in the library header, opens a builder in the detail
  pane: add plans, drag them into the order you want, give the first one a start
  day and time, and set the gap between them. The first plan is the only one with
  a time of its own; each of the rest is armed when the plan before it finishes,
  plus the gap. A chain is sequential by construction, so `maxConcurrent: 1`
  stops being a constraint rather than being worked around.

  The arming rule (`src/chain.ts`) is declarative — it reads the current
  schedule on every tick and works out what should be armed, rather than hanging
  off a "run finished" event. That is what makes a chain survive a closed window:
  if the plan before it finished while VS Code was shut, the next tick notices
  and carries on, instead of the rest of the chain waiting forever for an event
  that already happened. It also never arms into the past, because the trigger is
  a plan finishing rather than a time of day — a chain whose first plan completed
  overnight resumes when the window reopens instead of being declared missed.

  Chains are one-shot, and **Run now** on any plan in one re-runs everything
  behind it. A plan waiting its turn shows *After &lt;plan&gt; · +15m* in the
  library rather than a time it does not have, and **Unlink** on its row takes it
  back off the chain.

  What happens when a plan in a chain fails is a per-chain choice. Ticked —
  the default — the plans behind it are switched off and one notification names
  where it stopped; switching them off is also what makes that notification fire
  once rather than every thirty seconds. Unticked, the chain carries on to the
  next plan whatever the outcome. Retries happen first either way: the chain
  waits for a failed plan to run out of attempts before it decides — and for a
  temporary failure it never runs out, see the next entry.

  Deleting or archiving a plan mid-chain closes the gap rather than stranding
  what was behind it, and a chain leaves the library as a unit once every plan in
  it is done. `list_schedule` reports the link, so an agent does not read a plan
  waiting its turn as an unscheduled one; `update_schedule` refuses a link that
  would make a loop; and a phone may not move a chained plan's time, since the
  chain is what sets it.

- **A plan in a chain that fails for a temporary reason now retries every hour
  on the hour until it works, instead of taking the rest of the chain down with
  it.** `chronos.maxRetries` defaults to three attempts an hour apart, which is
  the right answer for a plan that fails alone and the wrong one for the failure
  that actually happens overnight: credits run out, or a session limit is hit,
  and three hours later it is still the same. The chain then read that exhausted
  failure as the plan's outcome and — with the default "stop the chain if a plan
  fails" — switched off every plan behind it. One temporary outage at 2am cost
  the whole night's work, and the morning's fix was to re-arm each plan by hand.

  Past its ordinary attempts, a plan that is part of a chain now queues another
  retry at the next top of the hour, and keeps doing so until it completes.
  Everything behind it stays parked meanwhile — a queued retry is already what
  the arming rule waits for — and the moment it completes the chain carries on
  from where it stopped, with no change to how the next plan is armed.

  Only *retryable* failures recover. A cancelled run, a missing plan file, a bad
  working directory or rejected credentials fail identically forever, so those
  still stop and report exactly as before; `outcome.ts` already drew that line.
  A plan outside a chain is unchanged too — nothing is waiting on it, so an
  endless retry would only be an endless failure nobody asked to keep watching.
  The recovery retry also survives a closed window: if its hour came round while
  VS Code was shut it moves to the next one rather than being marked missed,
  which would have become the final outcome the chain stops on. Recovery retries
  are labelled *chain recovery — hourly* in the run history, so they do not read
  as a plan nobody is going to fix. The policy is a pure function in the new
  `src/retry.ts`, tested without a clock or an editor.

- **A landing page for Chronos, in `site/`.** Until now the only public-facing
  description of the extension was `README.md`. `site/` is a hand-written static
  page — plain HTML and one stylesheet, no build step, no dependencies and no
  JavaScript — with real screenshots of the manager and the Tasks inbox, the
  four-step pipeline, and the unattended-scheduling warnings carried over from
  the README rather than softened for a shop window. Cloudflare Pages serves it
  from this repo with no build command. It ships nothing inside the extension:
  `site/**` is in `.vscodeignore`, so the page lives in the repo and never
  reaches the `.vsix`.

- **A schedule made with no VS Code window open now says so.** Chronos only
  fires a task while a window is open on the project; the MCP server writes the
  schedule to disk and exits, and a window picks it up later. That is the design,
  but `schedule_plan` replied with the same plain success either way, so an agent
  told you "booked for tonight" when the truthful answer was "booked for whenever
  you next open this project" — and nothing ran overnight, with nothing anywhere
  to say why.

  It now reads the scheduler's own lock file, which an open window heartbeats
  every tick, and adds a second `queued` field to the reply when nobody is
  renewing it. A separate field rather than a reworded success, so an agent can
  tell "this is what it will run as" from "this is when, if ever". The same field
  appears on `update_schedule`, but only when the call actually moved the timing —
  pausing or renaming a task says nothing about when it will next run.

- **Explain, a read-only third action on a task row.** The inbox is filled from
  two directions, and one of them is other people's agents: a task captured
  through the MCP server arrives as one line of somebody else's shorthand, and
  there was no way to find out what it meant without opening a terminal and
  asking Claude yourself. Both existing buttons commit you to something before
  you know — **Generate plan** ends with a document in the library, **Run** fires
  the task at the scheduler — and neither answers *what is this, and do I even
  want it?*

  The question mark, first on the row, opens a terminal that reads the task,
  gathers what it needs from the project, and explains in plain language what the
  change actually is, why it is needed, and what the alternatives are, including
  doing nothing. Then it stays open so you can ask follow-up questions.

  It writes nothing at all, which is the whole design: no staging folder, no file
  watcher, no session to track, and the task is exactly where it was when the
  terminal closes. It is also the one action with no busy check — reading about a
  task cannot collide with a plan being written for it or a run already in
  flight. The session runs in `default` rather than plan mode deliberately: a
  plan-mode session ends by offering its work through `ExitPlanMode`, and
  approving that prompt would set the agent off *implementing* the very task you
  asked it to explain. In `default` every write tool still stops and asks, with
  you sitting right there.

  It reuses `chronos.planModel` rather than adding a setting of its own, so that
  setting now covers both of the sessions you sit at.

- **Connecting Chronos to any MCP client, by picking it from a list.** The MCP
  server was already client-neutral; the setup was not. **Chronos: Copy MCP
  Server Config** copied one snippet in Claude's shape, and the README documented
  two CLIs. Anyone driving Chronos from Codex, Gemini, Cursor, Copilot, Windsurf
  or opencode had to know for themselves that Codex wants TOML in
  `~/.codex/config.toml`, that VS Code is alone in using `servers` rather than
  `mcpServers` and insists on `type: "stdio"`, and that opencode wants the whole
  command as one array — and had to hand-translate the snippet each time.

  The command is now a picker over eight clients, and copies the shape the one
  you picked actually wants, naming the file to paste it into and the one-line
  CLI equivalent where the client has one. There is still no HTTP endpoint, no
  port and no token: the server stays stdio-only, and an off-machine device
  reaches it the way it always has, by driving a client running on this PC.

- **Read and write hints on all fifteen MCP tools.** Clients that decide for
  themselves what to auto-approve — Codex's `default_tools_approval_mode`, VS
  Code, Cursor — read the standard MCP annotations to do it. Without them, every
  tool looks equally dangerous, so listing the schedule costs a prompt in exactly
  the same way rewriting it does. The seven reads are now marked read-only, and
  `unschedule` is the one call marked destructive, because it drops a series
  together with its run history.

  These are advice to the client and change nothing about what the server
  permits. The `permissionMode` refusal is still the actual boundary: an agent
  may author a plan over MCP and may not choose the permissions it runs under.

- **A standing weekly security review.** Chronos runs a coding agent with
  filesystem and shell access, on a schedule, while nobody is at the machine. A
  defect in its path handling, its command building or its MCP surface is
  reached by a plan file rather than by a person, so ordinary use of the product
  never finds it. `docs/WEEKLY-SECURITY-REVIEW.md` is the plan that goes looking
  on purpose: it runs every Monday at 08:00, walks a fixed route through the
  webview message surface, path containment, command construction, the MCP and
  remote-command channels, CSP, logging, permission modes and state integrity,
  and writes one dated report to `.chronos/audits/`.

  It changes no code, and everything it writes lands inside `.chronos`, which is
  git-ignored — a run leaves the working tree exactly as it found it.

  The new half is that each of the top findings becomes both an inbox task and a
  ready-to-run fix plan in the library, so acting on one is a single click. What
  it deliberately does not do is schedule them. A review that could put its own
  conclusions on the schedule would be an agent granting itself recurring write
  access to the repository on the strength of its own reasoning — the same gate
  Chronos already enforces on itself, where an agent may author a plan over MCP
  but may not set its permission mode. A person reads a fix plan and presses
  Schedule.

  This retires the combined security/performance/functionality audit, which ran
  twice. Security is now its own standing plan and its reports continue the same
  `.chronos/audits/` series, so the security findings of the two existing
  `*-codebase-audit.md` reports are read for continuity and de-duplication
  rather than being started over. Performance becomes its own plan later, and
  will share the same audits folder and the same de-duplication rules so nothing
  is raised twice.

- **A separate Reinstall closing step, alongside Rebuild.** A generated plan
  could already be asked to end by rebuilding the project, which for anything
  that ships as an installed artefact — an extension, a CLI, a packaged app —
  stops one step short. The build lands on disk and the thing you are actually
  running carries on being the old one, with nothing anywhere saying the two have
  diverged. That is not hypothetical; it is why `reinstall.js` exists in this
  repo.

  New setting `chronos.planStep.reinstall`, off by default like Rebuild, because
  most projects have nothing to install. It is a step of its own rather than a
  wider Rebuild: a library rebuilds and never installs, so switching one on must
  not drag the other along. Only useful with Rebuild switched on, though —
  reinstalling without rebuilding just reinstalls the old build.

- **Answer a planning session's questions from your phone.** Pressing **Generate
  plan** opens an interactive Claude session in a terminal, and every question it
  asks needs somebody sitting at that terminal to answer. That is fine at the
  desk and useless anywhere else: capture a task on the way out and the plan does
  not get written until you are back.

  The questions now come out through the Chronos MCP server instead. The session
  calls `ask_user`, which writes the question into `.chronos/questions` and then
  blocks, polling once a second until an answer lands. Anything with access to
  the same folder can answer it — in practice Claude Desktop, driven from a phone
  by the Dispatch app, on this same machine. Same filesystem, so a question and
  its answer are just files: no port, no token, nothing leaving the machine.

  Both prompts travel that way, not just the first. Routing only the questions
  would still leave the session parked at *shall I go ahead?* until you were back
  at the keyboard, so the finished plan is sent as a question too, and on
  approval the session calls `submit_plan` rather than writing a file itself. The
  plan lands in the staging folder the existing watcher already watches, so it is
  adopted into the library and clears its task exactly as before. Capture a task
  on the phone, press Generate on the way out, answer from the bus, and come back
  to a plan sitting in the library.

  Four new tools, taking the surface from eleven to fifteen. `ask_user` and
  `submit_plan` are what a planning session calls; `list_questions` and
  `answer_question` are what you answer it with. A session is spawned with
  `--ask-only`, which withholds every other tool from it — it can ask, and it can
  deliver a plan, and it cannot put anything on the schedule. Nobody is watching
  it, so that is the only surface it should have.

  A routed session runs in `--permission-mode default` rather than
  `--permission-mode plan`. This was measured before anything was built, and it
  is the one thing the design turned on: plan mode refuses an MCP tool call
  outright even when it is allowlisted — `Cannot call mcp__chronos-ask__ask_user
  while in plan mode` — which would leave the session unable to ask its question
  or deliver its plan. In `default` the two allowlisted tools go through without
  a prompt and everything else still stops and asks; nobody is there to approve
  those, so an unattended session still cannot make an edit. The mode changes
  what it may *call*, not what it may *change*.

  A routed session is its own command — **Chronos: Generate Plan (Answer
  Remotely)** in the palette — rather than a setting on the **Generate plan**
  button, for the reason given under *Fixed* below: it costs plan mode, so it has
  to be something you go and ask for. The button itself is unchanged and still
  asks in the terminal. Unanswered questions are swept after a week, alongside
  the existing `.pending` sweep.

- **Chronos as an MCP server, so a coding agent can drive it.** Until now the
  only way to get work into Chronos was to sit in VS Code and do it by hand:
  plans written in the manager, tasks typed into the sidebar, schedules set by
  clicking. Meanwhile the machine already runs several coding agents, every one
  of which speaks the Model Context Protocol as a client — and from an agent's
  point of view Chronos is exactly what MCP is for: a set of tools and some data.

  The extension now ships a second bundle, `dist/mcp-server.js`, which an agent
  spawns as a child process scoped to one project folder. It reads and writes
  the same `.chronos` tree the editor does, so an agent working in a project can
  capture a task, write it up as a plan, and put it on the schedule — and the
  open window runs it that night, transcript and all, exactly as if a human had
  scheduled it.

  Eleven tools. Six read: `list_plans`, `read_plan`, `list_tasks`,
  `list_schedule`, `list_runs` and `read_transcript`. Five write: `add_task`,
  `add_plan`, `schedule_plan`, `update_schedule` and `unschedule`. Writing a plan
  and scheduling it are deliberately separate, because that is the same
  capture → generate → schedule → run pipeline the product already has, with the
  agent standing in for the human at the first two steps.

  stdio rather than HTTP: no port, no token, no auth surface, and it works with
  VS Code closed — the writes land on disk and fire when a window next opens.
  The server holds no state of its own; every call re-reads the folder and writes
  back through the same read-modify-write that already lets two editor windows
  share one schedule.

  **An agent may not set `permissionMode`.** This is the one rule the whole
  surface is built around. Chronos runs coding agents unattended, on a schedule,
  in a real repository, and an agent that could raise its own task to
  `bypassPermissions` would be granting itself recurring, unrestricted tool
  access on this machine with nobody ever seeing the decision. New series get the
  ordinary `auto` default; raising one stays a click in the manager, made by a
  person looking at the plan. There is no `run_now` either — an agent sets a
  time and the window fires it, which keeps every run on the single path that
  carries the concurrency cap, the watchdogs, the retry logic and the transcript
  machinery.

  Two containment rules sit at the filesystem edge. A plan is addressed by
  **name**, never by path, and resolved through the same check every other read
  and write in the library goes through — so a scheduled task cannot be aimed at
  an arbitrary file on disk. And everything written stays under the project's own
  `.chronos`, created on the first write rather than at start-up, so an agent
  merely listing an unconfigured project does not litter it.

  The rules themselves live in `src/mcp-tools.ts`, which imports no `vscode`, no
  `fs` and nothing from the process — the same shape as `command.ts`, the phone
  channel's gate, and for the same reason: every refusal is a unit test rather
  than something we hope is right. Field validation is not reimplemented there;
  the patch goes through `edit.ts`, the manager's own validator, with the
  `permissionMode` refusal applied on top.

- **`Chronos: Copy MCP Server Config`**, a command that puts a ready-to-paste
  client entry on the clipboard carrying the real absolute path to the server
  bundle and the active folder. Without it, connecting an agent means going
  looking for whichever versioned directory VS Code installed the extension into.

- **A re-run button on every finished run.** The Runs panel across the bottom of
  the manager is the record of what the agent did, but a finished row offered
  only **result** and **raw log** — reading, never doing. Running the same plan
  again meant hunting it down in the library on the left, selecting it, and
  pressing **Run now** in the detail pane, which is a long way round for the
  thing you most often want after reading a result.

  Every **completed**, **failed** or **cancelled** row in the panel now carries a
  restart icon at its right-hand edge. A running row still offers **cancel**, a
  queued row **skip**, and a missed row its existing **run now** — no row ends up
  with two buttons that mean the same thing.

  It asks first, in a modal, because a run spends money and edits the repository.
  The prompt also says the thing the button cannot: no run keeps a copy of the
  plan text it ran, so this runs the plan **as it stands now**, not a replay of
  what happened before — including a plan you have since edited. A plan Chronos
  has already auto-archived still runs, which covers most finished rows, since a
  completed one-shot is archived and marked spent as a matter of course.

- **Run a task straight from the inbox.** The only thing a captured task could
  become was a plan: pressing **Generate plan** opened an interactive planning
  session, and nothing ran until a plan had been written and landed in the
  library. That is the right route for real work, but it was the only one, so a
  one-line chore — bump the copyright year, delete the dead `.vsix` files in the
  repo root — meant sitting through a planning session before anything happened.

  Selecting a task and pressing **Run** (or <kbd>R</kbd>, as on a plan row in the
  manager) now runs that task's own text as the prompt, immediately and
  unattended, in `auto` permission mode, against the folder it was captured in.
  It is the ordinary scheduled path fired at once — a real run, with a run
  record, a transcript and the same concurrency budget — rather than anything new.

  The task stays in the inbox while the job is in flight, its dot teal and
  pulsing, and only a completed run clears it: a run that failed, was cancelled
  or was missed leaves the row exactly where it was, to be run again or planned
  properly. The task is copied into the plan library first, so every scheduled
  plan is still a library plan, and that copy is archived once it has run, like
  any other one-shot. Nothing about **Generate plan** changes.

- **Generated plans now end by recording what they changed.** A plan written by
  the **Generate plan** button said what to build and nothing about what to do
  afterwards, so an unattended overnight run finished with new behaviour in the
  working tree, the old version number in `package.json`, no changelog entry and
  nothing committed — the diff was the only record that anything had happened.

  Chronos now asks for a closing step in every plan it generates: bump the
  version, add a matching changelog entry, commit the result. Commit only,
  nothing pushed. Two further steps are available and off by default — run the
  test suite, and rebuild the project — because both cost an unattended run real
  time and not every project wants either.

  Each is its own setting, on the manager's **Settings** page under *Planning*
  and in VS Code's own settings UI: `chronos.planStep.version`,
  `chronos.planStep.changelog` and `chronos.planStep.commit` are on;
  `chronos.planStep.tests` and `chronos.planStep.rebuild` are off. Switch all
  five off and the instruction is exactly what it was before. This changes what
  new plans say — plans already in the library are not rewritten.

- **A spinner beside the plan title while a run is live.** The countdown ring
  already swapped its arc for a rotating sweep, but sitting inside the clock it
  read as part of the countdown; the only other signal was the words "running
  now". The title now carries VS Code's own loading glyph for as long as the run
  lasts.

- **The manager works from the keyboard.** It was mouse-only. Every plan row is
  a button, so Tab walked through the whole library one row at a time to reach
  anything past it, and there was no way at all to open a plan, change its date
  or schedule it without the pointer — while the Tasks sidebar had had arrow
  keys since 0.8.0-rc.20.

  The library now works the way that sidebar does: Tab crosses it once, and
  <kbd>↑</kbd> / <kbd>↓</kbd> move through the plans with the detail pane
  following the highlight, <kbd>Home</kbd> and <kbd>End</kbd> going to the first
  and last. The ends are clamped rather than wrapped. From a row,
  <kbd>Enter</kbd> steps into the plan's text, <kbd>S</kbd> schedules the plan or
  pauses a scheduled one, <kbd>R</kbd> runs it now, and <kbd>D</kbd> opens the
  When calendar. Those three letters fire only while the library has focus, so
  typing *sardines* into a plan does not schedule anything.

  <kbd>/</kbd> jumps to the search box from anywhere, <kbd>↓</kbd> from the
  search box drops into the filtered list, and <kbd>Esc</kbd> goes back to the
  list with the search term intact. <kbd>F6</kbd> moves between the library, the
  plan and the Runs strip, <kbd>Shift+F6</kbd> back the other way.

  In the When calendar the arrows move a day or a week, <kbd>PageUp</kbd> and
  <kbd>PageDown</kbd> a month, and <kbd>Enter</kbd> sets the highlighted date,
  keeping the plan's existing time of day. Nothing is saved until then and
  <kbd>Esc</kbd> closes it having changed nothing, so you can browse to next
  March and back without touching the schedule. The hour, minute and AM/PM
  dropdowns are native controls and are left alone. **One existing control
  changes**: the calendar's month arrows now carry the highlight with them
  instead of moving the view alone — they still schedule nothing.

  The whole map is listed under **Keyboard shortcuts** at the foot of the
  manager's Settings page, generated from the same table the handlers are
  written beside, so the page and the keys cannot drift apart.

- **The manager's three panels resize by dragging their dividers.** The plan
  library was a hard 260px, which truncated any plan name longer than a few
  words, and the Runs strip was 220px or hidden with nothing in between. There
  is now a thin divider between the library and the detail pane, and another
  above Runs: press and drag, and the panes follow the pointer. Each stops
  before it can squeeze its neighbour out of usefulness, and a narrowed window
  pulls an oversized pane back in rather than leaving it off screen. Below 700px
  the panes stack as they already did and the dividers go away. The sizes are
  remembered per tab — they survive a window reload alongside the Runs filter
  and collapse state, but closing the Chronos tab and reopening it starts again
  at 260 and 220. Nothing is written to `.chronos`.

- **A Settings page in the manager, covering every Chronos setting.** Removing
  the model prompt left `chronos.planModel` with nowhere visible to live: a
  setting nothing asks about is a setting you have to go looking for, and VS
  Code's own Settings editor is a different window with a search box in it. The
  gear beside **Plan library** turns the detail pane into Settings — all thirteen
  `chronos.*` settings, grouped under Planning, Engines, Locations, Running and
  Limits, each with its control and its help text. Clicking a plan leaves the
  page again.

  The page is generated from the configuration schema already in
  `package.json` rather than from a second hand-written table, so there is one
  source of truth for every setting's type, default, range and help text, and
  adding a setting to the manifest puts it on the page for free — anything not
  named in a group lands under **Other** rather than vanishing. Edits write to
  *user* scope, on change rather than on every keystroke, and a value the schema
  refuses is dropped and the control snapped back to what is stored; a number
  outside its range is clamped instead, so a typed `99` for **Max concurrent**
  writes `5`. It reads both ways: changing a setting in VS Code's own editor
  updates the page without a reload, and **Edit in VS Code Settings ↗** is the
  escape hatch for the workspace-scope edits this page deliberately does not do.

- **`npm run reinstall` puts the build into VS Code.** `npm run package` stopped
  at a `.vsix` on the disk, and nothing carried it any further. Because Chronos
  schedules work on its own repository, that gap had teeth: an unattended run
  could edit the source, typecheck, test, compile and package, report itself
  completed — and the editor went on serving the copy it loaded at startup, with
  nothing anywhere saying the two had drifted apart. An evening of finished work
  read as an evening of work that had silently done nothing. The new script
  packages and then installs, naming the `.vsix` from the version in
  `package.json` so it can never push a stale one, and closes by saying to reload
  the window — installing over a running window does not swap the code already
  loaded, which is the other half of the same trap. It installs into VSCodium,
  which is the editor this is developed in: it and Microsoft's build keep
  separate extension folders, and the `code` command on PATH is the latter, so
  installing with it succeeds, says so, and leaves the editor you are actually
  looking at untouched — a third way for the same evening's work to disappear,
  and the one that hid the first two. It is called `reinstall` rather than
  `install` because npm runs a script by the latter name itself during
  `npm install`; source guards now hold that name, the editor it targets, the
  script's existence and its version lookup.

- **`/reinstall`, for installing this extension by hand.** The script above is
  what a scheduled run reaches through **Plan steps → Reinstall**; this is the
  same thing for a session you are sitting in front of, where the reason to
  install is usually that you have just found the window running an old build.
  It runs the checks first and stops if either fails, because installing a broken
  build is worse than not installing, then packages, installs and says to reload.
  It lives in `.claude/commands/`, which `.vscodeignore` now keeps out of the
  packaged extension.

- **The Chronos mark turns while a plan runs.** The ring beside a plan's title
  used to swap its countdown arc for a sweeping dash during a live run; the
  sweep is now the ouroboros mark itself, spinning in the ring's place for as
  long as the run lasts and handing the clock back the moment it ends. It
  honours `prefers-reduced-motion` like the sweep it replaces.

### Security

- **A connected agent can no longer point a scheduled run at any folder on the
  disk.** `schedule_plan` and `update_schedule` both accept a `cwd`, and it was
  written through to the store unchecked — `seriesEdit` only asked that it be a
  non-empty string. The plan a run is handed has always been contained, by
  `library.planPath`, but the directory it is handed that plan *in* is the thing
  that decides how far the run can actually reach. Since a new task runs in
  `auto` mode, unattended, an agent that could already write a plan could
  schedule an unsupervised coding agent against any folder on the machine —
  the same grant `permissionMode` is refused for, reached from the other side.

  A new `planCwd` in `src/mcp-tools.ts` holds `cwd` to the folder the server was
  started with: the project folder itself, or anything under it, so a package
  inside a monorepo still works. A relative path resolves against the project
  rather than being refused, which also means the stored value is always the
  absolute one `runner.ts` spawns with. The comparison goes through
  `path.relative`, so a sibling folder that merely shares a prefix
  (`/repo-evil` against `/repo`) is refused rather than mistaken for a child.

  This changes nothing about the manager, where `cwd` is picked by a person from
  a folder dialog and may still point anywhere they choose.

### Fixed

- **Unscheduling from a coding agent no longer strands the rest of the chain.**
  Removing a series closes up the chain around it — each plan that ran after it
  is relinked to run after its predecessor instead — but only the manager did
  that. The `unschedule` tool an agent calls over MCP dropped the series and its
  runs and left the links alone. With A → B → C chained and A unscheduled, B was
  left waiting on an id that no longer existed: the next tick switched it off and
  said so, which is the loud half. C was the quiet half — its predecessor B still
  existed, so nothing looked broken, and it simply parked forever with no
  notification of any kind. One removal cost three plans and mentioned one.

  The tool now applies the same splice the manager does, computed before the
  removal while the link being closed up is still readable. Nothing about the
  splice rule itself changed; the two removal paths just agree now, and a source
  guard keeps them from drifting apart again.

- **Re-running a retired plan no longer restarts the whole chain behind it out
  of the archive.** When a chain finishes, every plan in it moves to
  `.chronos/archive/plans` and is marked spent, so no untaken occurrence can fire
  from there. But `spent` is also how a plan waiting its turn in a chain waits —
  that is the design — and retirement left the link itself in place. Press
  **Re-run** on the head of a finished chain from the Runs panel and the arming
  rule saw exactly what it looks for: a fresh finished run, and followers behind
  it that are parked, enabled and linked. It armed all of them on the next tick.
  They then ran unattended, from the archive folder, spending money on plans the
  user believed were retired and cannot see in the library, with no row anywhere
  to show for it. The button's own warning says it runs the plan as it stands
  now — not that it runs everything that used to follow it.

  Retirement now ends the link as well as the occurrence: an archived plan comes
  back with no `chain`, so nothing the plan before it does can reach it again.
  Re-run runs the one plan you pressed it on. Nothing else changed — the arming
  rule still knows nothing about the filesystem, and `enabled` is still only ever
  the user's own pause, never written by the sweep.

- **A failed MCP tool call now leaves a record.** Every handler in the server did
  real work on the filesystem — a full disk, a file removed between the check and
  the read, a permissions change — and a throw became a failure at the client and
  nothing at all on this side. A server failing every call left no trace anywhere
  the user could look, and the raw error travelled to the client carrying more of
  the machine's paths than it needed to. All fifteen tools are now registered
  through one wrapper that turns a throw into a line on stderr and a refusal the
  agent can read and repeat back.

- **The server no longer dies without saying why.** A process that exits silently
  looks identical to one the client never managed to start. An uncaught error now
  writes its reason to stderr and exits, so the client can respawn it; a stray
  rejected promise is logged rather than taking the process with it.

- **A `--folder` that does not exist is refused at start-up.** Chronos creates its
  `.chronos` tree with a recursive mkdir, so a folder misspelled in somebody's
  client config did not fail — the first write built the whole missing chain and
  left a Chronos tree inside a path that had never existed, while the server went
  on serving a project that was not there. The folder is now checked once, at
  start-up, where the mistake actually is. A folder that exists without a
  `.chronos` in it is normal and still works exactly as before.

- **The version the server announces is the real one.** It was a literal reading
  `0.8.0` while the package was sixty release candidates past that, and it is the
  first thing anyone reads when working out which build a client is talking to.
  It is now stamped into the bundle from `package.json` at build time, so it
  cannot be forgotten.

- **The stdout and `vscode` guards now follow the server's imports.** stdout is
  the JSON-RPC transport, so one `console.log` corrupts the conversation
  mid-message — but the guard against it read only `mcp-server.ts`, while the
  server pulls in a dozen modules shared with the extension, where a debug line
  looks harmless. Its neighbour checked a hand-written list of thirteen file
  names, correct on the day it was written and quietly incomplete from the first
  import added afterwards. Both now crawl the imports themselves, and a third
  test checks the crawl is still finding them, so neither can pass by finding
  nothing.

- **The MCP client config is built in one place.** The JSON that tells a client
  how to spawn Chronos was assembled twice — once for the config you paste into
  your own client, once for the private back-channel a planning session is
  spawned with. Same key, same command, different arguments, and nothing keeping
  them in step. One builder now produces both.

- **A client config no longer breaks the next time Chronos updates.** VS Code
  installs an extension into a folder named after its version, so the path the
  copy command handed out — straight into `dist/mcp-server.js` — stopped existing
  on every update. Nothing said so. The client went on spawning a file that was
  no longer there and simply listed no tools, which reads as the server being
  broken rather than as the config pointing at last week's install.

  What Chronos copies now is a small launcher inside its own storage folder,
  which is keyed by publisher and extension id rather than by version. It is
  rewritten on each activation to point at whichever install is running, so a
  config registered once keeps working across updates with no change. A launcher
  whose target has gone — Chronos uninstalled, or moved — says so on stderr and
  exits, rather than leaving the client hanging.

- **Generate plan opens in plan mode again.** Routing a planning session's
  questions through the MCP back-channel costs plan mode — the two genuinely
  cannot share a session, because plan mode refuses an MCP tool call outright
  even when it is allowlisted (`Cannot call mcp__chronos-ask__ask_user while in
  plan mode`), and `--allowedTools` does not override it. A routed session has to
  run in `--permission-mode default` or it cannot ask its question at all.

  That trade was fine; making it the default was not. `chronos.remoteQuestions`
  shipped on, so the **Generate plan** button stopped being a plan-mode session
  for everyone, whether or not they were going anywhere — plan mode was not
  traded away for a feature asked for in the moment, it was traded away
  permanently by a default.

  The button is back to plan mode, unconditionally: it writes a plan, changes
  nothing, and asks in its own terminal. The back-channel moves to a
  command-palette command, **Chronos: Generate Plan (Answer Remotely)**, which
  picks a task from the inbox and opens the routed session in `default` mode
  under a terminal named `Chronos: plan (remote) …` so the two are tellable
  apart. The mode now follows the door you came in through, and choosing the one
  that costs plan mode is a deliberate act.

  `chronos.remoteQuestions` is gone, because the choice is the command you run.
  Nothing else about routing changed. A routed session that cannot write its own
  MCP config now says so rather than silently falling back to asking in the
  terminal — tolerable for a default, not for a command whose whole purpose is
  the back-channel.

- **A generated plan could land in the library without ever appearing in it.**
  The end of a planning session hands over to the manager: the plan file is
  copied into the library, the task is cleared, and the manager is opened with
  the new plan selected. But opening a tab that was *already* open only brought
  it forward — it never re-read the folder. The panel went on showing the list
  it was last sent, and the "select this plan" message that followed named a row
  it did not have, so nothing was selected either.

  Keeping that list current was left entirely to the folder watcher, and a
  watcher is not a guarantee: `fs.watch` drops events on Windows, and it is not
  running at all when the library folder could not be watched. When it missed,
  the plan was on disk, the task was gone from the inbox, and the manager showed
  no sign of either — the work looked lost. Reopening the manager now re-reads
  the library folder, which is one directory listing on a tab you just asked for. Recurring plans were already held in the library — the
  archive sweep refuses any series with a repeat rule — but the moment you
  changed **Repeat** from Weekly to Once, that protection was gone and the pile
  of completed runs the plan had made *while* it was repeating was suddenly a
  pile of completed runs behind a one-shot. The very next sweep archived it:
  activation, a folder switch, or any finished run anywhere in the folder. The
  single occurrence you had just set never fired, and the plan was out of the
  list before you saw it there.

  Second way to lose one: two windows open on the same folder, only one of them
  holding the scheduler lock. The store keeps the schedule in memory and only
  re-reads on its own writes, so setting **Repeat = Daily** in window B left
  window A still seeing a one-shot — and when a run finished there, window A
  archived a plan that now repeats. Every *field* write is protected by a
  read-modify-write against the file on disk; moving the file itself was not, so
  nothing downstream caught the mistake.

  A series now records when its repeat rule was removed, and the sweep only
  counts a completed run that started after that — so a plan that stops
  repeating stays in the library until it has run once on its own. The stamp is
  applied wherever a series is written, the extension and the MCP server alike,
  so the two processes cannot disagree about when a plan became a one-shot; a
  run with no start time cannot be placed either side of the change and is
  treated as older, on the reasoning that a plan wrongly kept is a row in a list
  while one wrongly archived has to be gone looking for. The sweep also re-reads
  the schedule from disk before it moves anything, which closes the two-window
  case. One new optional field, so nothing needed migrating.

  This does not bring back plans already sitting in `.chronos/archive/plans`.
  Their series all read `recurrence: null` and `spent: true`, and no automatic
  rule can tell which of those you thought of as repeating. They are recoverable
  by hand exactly as the README describes: the **Import** button, or copy the
  file back into `.chronos/plans`. Nothing in the archive is ever pruned, so they
  are all still there.

- **Generate plan lost its instruction entirely whenever no model was pinned.**
  The command ended `--add-dir <library> <instruction>`, and the CLI declares
  `--add-dir` variadic (`<directories...>`), so it went on swallowing arguments
  until it met another flag — taking the instruction with it as one more
  directory. The session then opened with no prompt at all: a terminal sitting at
  an empty Claude prompt, with nothing anywhere to say why. It only worked when
  `chronos.planModel` was set, because `--model` then sat between the two and
  stopped the swallowing.

  The instruction now goes first, ahead of every flag, where nothing variadic can
  reach it — and `--mcp-config` and `--allowedTools`, both also variadic, cannot
  reintroduce the same bug. A `--` separator would have worked too, but not
  portably: cmd only accepts it bare and PowerShell only passes it through
  quoted, and moving one argument does the same job in all three shells.

### Changed

- **Every setting now says what it does in one line (0.8.0-rc.61).** The manager's
  **Settings** page printed a paragraph of help under each control, taken straight
  from the configuration schema in `package.json`. Several ran past 400
  characters, and all five plan-step toggles closed with the same sentence about
  plans already in your library — so the controls sat buried in prose you had read
  four times already, and the page could not be scanned.

  The descriptions are shortened at their source in the manifest, which keeps the
  single source of truth the page was built on and shortens VS Code's own Settings
  editor at the same time. The caveats that were cut are not relocated: they are
  already recorded in the project's plan text, and a second copy would only be a
  second thing to keep in step. The one line worth keeping — that these settings
  shape future plans, not existing ones — becomes a `note` on the group, said once
  under the **Planning** heading instead of five times inside it.

- **A generated plan now arrives in the library under a three-word name.**
  Chronos asks the planning session to name the plan after the change it makes,
  but never said how long that name should be — and its own worked example was
  four words. So the library filled up with `fix-auth.md` sitting next to
  `add-monthly-repeat-option-to-the-scheduler-panel.md`, and a column of file
  names in uneven, sentence-length prose is hard to scan and harder to keep on
  top of.

  Both instructions now ask for exactly three words describing the outcome the
  plan produces, with an example that is itself three words. An instruction is a
  request, though, and a model can drift from it — so Chronos also clamps the
  name to its first three words as the plan is adopted into the library. The
  clamp sits at the single door every outside file already comes through, which
  means one check covers both planning flows: the terminal session that writes
  the file itself, and the routed session that delivers it through
  `submit_plan`. The collision suffix still applies afterwards, which matters
  more now that shorter names collide more often.

  Only a name Chronos generated is shortened. A name typed into the Rename
  dialog, and a title an external agent passes to the `add_plan` MCP tool, are
  deliberate choices and are left exactly as they are.

- **A task row now says what is happening to it in its own colour.** The row
  already carried a small state dot — hollow when captured, amber while a plan
  was being written, teal while a run was in flight — but at 9px on a sidebar
  that is often 250px wide, it is the one part of the row you do not look at.
  The text is what you read.

  The label now takes the same state colour as the dot: amber while a planning
  session is open for the task, green while a run fired from the inbox is in
  flight, and the ordinary foreground colour otherwise. Both parts are driven
  from a single class, so the dot and the text cannot end up disagreeing.

  The running dot changed from teal to green to go with it. Teal is Chronos's
  accent — buttons, outlines, links — and spending it on liveness here as well
  made a running row read as two states at once. Green was already the manager's
  colour for a run that is going well, taken from the theme's own chart palette
  where the theme supplies one, so the two panels now agree. Amber is unchanged
  and still means only one thing: a plan being written.

  Colour is not the only signal in either case — the dot's pulsing halo and the
  disabled buttons still say the same thing — so nothing in the panel depends on
  telling amber from green.

- **A generated plan is submitted without waiting for approval.** A routed
  planning session — one whose questions come out through `chronos-ask` so they
  can be answered from a phone — used to send its finished plan back as one last
  question and sit there until somebody replied yes. It no longer does: it calls
  `submit_plan` the moment the plan is written. The plan lands in the library,
  the manager opens with it selected, and the library's editor is where it gets
  read and changed. Nothing in the library runs until a person schedules it, so
  the approval reply was a gate standing in front of a gate, and all it bought
  was a finished session parked on a reply that might not come until morning.

  Clarifying questions are untouched: the session still asks them through
  `ask_user`, still retries an unanswered one with the same id, and still cannot
  usefully ask in the terminal. So is the terminal session — it runs in plan
  mode, where the CLI puts up its own approve-the-plan prompt and there is
  somebody sitting at it to answer.

- **The plan text box sizes itself to the pane.** It was a fixed 180px textarea
  with a drag grip, sitting in a scrolling column between the plan header and the
  Schedule and Runs sections. Dragging the Plan library or Runs sash resized the
  pane around it and changed nothing about the box, so a taller window bought a
  band of empty pane and the grip had to be dragged by hand to claim it. The
  detail pane is now split: the box is pinned below the header and takes whatever
  height the two sashes leave, and Schedule and Runs sit in their own scrolling
  strip underneath so they stay on screen however tall the box gets. The grip is
  still there and still wins when you use it, but only for the plan you dragged
  it on — pick another and the box goes back to sizing itself. `media/` only: no
  logic, no message types, no storage.

- **New extension icon** (`media/icon.png`, 128×128) — the teal-and-orange
  ouroboros dragon, replacing the faceted sculpted head. It is the marketplace
  icon and the manager panel's tab icon. Source art is kept at
  `src/img/chronos-logo-v1.png`; `src/**` is in `.vscodeignore`, so the
  half-megabyte original does not ship in the `.vsix`.

- **The activity-bar icon is the dragon too** (`media/chronos.svg`), replacing
  the clock-and-arrows line mark, so nothing anywhere still shows the old head.
  Earlier releases left this one alone on the grounds that a dragon cannot
  survive the constraints, and half of that was right: VS Code masks the icon to
  a single theme colour and draws it at 16px, so the teal-and-sodium split, the
  scales and the eye are all unusable.

  What does survive is silhouette. The mark is redrawn as three flat shapes — a
  heavy ring, a wedge head sized to take the downscale, and one horn — with the
  tail ending in the jaws instead of curling into them. At 16px it reads as a
  ring with a horned head rather than as the full ouroboros; at the 32px and
  48px the icon is also served at, it reads properly. `currentColor` throughout,
  so the activity bar still tints it to the theme foreground.

  README now calls it the dragon icon rather than the clock icon, in both places
  that told you what to click.

- **The schedule is re-read when it changes on disk.** The store only re-read
  `state.json` on its own writes, which was enough while every writer was a VS
  Code window with its own scheduler running. The MCP server is not one: it
  writes a series and the process exits, so a task an agent scheduled would have
  sat there unfired until somebody reloaded the window — the feature above would
  have looked broken about half the time, and silently.

  The extension now watches for external writes and reloads. The watch is on the
  `.chronos` **directory**, filtered to `state.json`, not on the file itself:
  writes go through a temp file and a rename, which replaces the inode and leaves
  a file-level watch pointed at something nothing will ever write to again. That
  is the same shape as the manager's existing plans-directory watcher, debounce
  included. Reloading is a read, so it cannot re-trigger the watch.

  A second VS Code window on the same folder gets the same benefit: schedule
  changes made in one now appear in the other without a reload. The manager
  repaints off its existing store subscription and the scheduler picks new series
  up on its next 30-second tick, so nothing downstream needed changing.

- **A task in the sidebar shows in full instead of being cut off mid-sentence.**
  The row was built from the first non-empty line of the task file and clipped at
  80 characters, so anything longer than a short sentence ended in an ellipsis
  and a task you could no longer read was a task you could not act on. The
  sidebar's CSS was never the cause — the label already wrapped freely; the text
  was cut on the host side before the webview ever saw it. The cap is now 300
  characters, which holds a real task whole while still stopping a pasted essay
  from growing the row without bound, and the row is every non-empty line of the
  file rather than only the first, because a task grows extra lines once Claude
  has asked about it and those lines are part of the description. Blank lines are
  closed up so paragraph gaps do not pad the row out. Where one line is still the
  right answer — the planning terminal's name, the archive confirmation, the
  buttons' screen-reader labels — the first line is used.

- **Scheduling and unscheduling are one button, and unscheduling no longer
  throws the run history away.** The plan pane carried two controls for the same
  idea. A three-label toggle said **Schedule**, **Scheduled** or **Paused**
  depending on where the plan was, and beside it sat a separate red
  **Unschedule** button — two buttons, two vocabularies, and only one of them
  obviously destructive. The red one deleted the series outright, and with it
  every run record belonging to that series: unschedule a plan you had been
  running for a month and the month's transcripts stopped being attributable to
  it, the plan's own Runs list emptied, and the Runs panel relabelled what was
  left *Removed plan*. There was no confirmation on any of that.

  There is one toggle now, with two faces: **Schedule** when the plan is not
  scheduled, **Unschedule** when it is. Unscheduling switches the series off and
  keeps it — nothing is deleted, the past runs stay in the panel still named
  after the plan and still listed under it, and pressing **Schedule** again
  brings back the time, repeat, working directory, permission mode and model you
  had already set. It is the same treatment a finished one-shot has always had.

  Pause is gone as a user-facing idea along with it. A plan is scheduled or it
  is not, so the head and the library row both read *Not scheduled* where they
  used to read *Paused*, the <kbd>S</kbd> key schedules and unschedules rather
  than schedules and pauses, and the amber still means only one thing: this is
  genuinely going to run. Nothing in the manager removes a series any more —
  **Archive**, which has always asked first, is how you are rid of one.

- **Every schedule now points at this folder.** Six series carried a working
  directory of `d:\03-Software\Chronus` — the pre-rename spelling, for a folder
  that no longer exists. They were left enabled, so each was a run waiting to
  fail on a directory that could not be entered. Rewritten in place to the real
  path; the schedules themselves are untouched.

- **Generate plan no longer asks which model should plan the task.** The
  QuickPick fired before every planning session and preselected the answer you
  gave last time, which was almost always the answer you wanted again — a prompt
  on the fastest path in the product, capture a task and press the lightbulb, for
  a choice that rarely changes. It reads `chronos.planModel` instead, which
  already existed and already defaulted to *Account default*, meaning no
  `--model` flag at all. The setting is not migrated: whatever it holds now is
  what planning will use.

- **The primary buttons now carry a Chronos teal instead of borrowing the
  editor's blue accent.** **New plan**, **Save**, **Run now**, **Add** and
  **Generate plan** were painted with `--vscode-button-background`, so the one
  colour a user reads as *this is the thing to press* was whichever accent their
  theme happened to ship — the same blue as every other extension. Teal is a
  second colour Chronos owns outright, alongside sodium, and it is spent only on
  those filled buttons. Light themes get a darkened variant so the white label
  stays legible against it, the same treatment sodium already gets. High-contrast
  themes are untouched: the buttons hand the colour back to the theme, because a
  brand should never paint over an accessibility setting. The amber schedule
  toggle is unchanged — it means imminence, not emphasis.

- **The rest of the accent is teal now too, so the blue is gone entirely.**
  Painting only the buttons left the odd result of a UI whose one owned colour
  was teal but whose every outline and link was still the editor's blue, which
  read as an accident rather than a choice. Three theme variables were leaking
  it in: `--vscode-focusBorder`, which `--accent` was defined as and which paints
  every focus ring, the drop target, the calendar's today marker and the weekday
  toggles; the active-selection pair on the selected plan row; and the link
  colour on the **Hide** buttons. `--accent` is now the same teal as the buttons,
  which fixes all eighteen of its uses in one line per stylesheet, and the
  selected plan and task rows trade their solid fill for a teal outline over a
  faint teal wash so the row reads as chosen without shouting. Light themes take
  the darkened variant, and high-contrast themes hand `--accent` back to
  `--vscode-focusBorder` explicitly, keeping the same exemption the buttons have.

- **A plan that has run now leaves the library.** A one-shot has no future once
  it has finished — but its `.md` file used to sit in `.chronos/plans` forever.
  The manager hid the row and the folder kept the file, so the list you saw in
  Chronos and the folder you saw in Explorer disagreed about what your library
  contained, and the disagreement grew by one plan every time something ran. The
  file now moves to `.chronos/archive/plans` the moment the run completes, and
  the row goes with it.

  Only a **successful** run archives. A plan that failed or was cancelled stays
  exactly where it is, and — this is the visible change — it is no longer hidden
  from the list either. It is there to be fixed and run again, and it has to be
  visible to be fixable; its row reads *Missed*, *Queued* or *Ran once* according
  to how it actually ended. A plan is also left alone while it still has a retry
  queued or a second attempt in flight, since that attempt needs the file.
  Recurring plans never leave the library at all: they always have a next time.

  **Nothing is lost.** The run card and its **Open result** link are untouched —
  the series and its history stay in `state.json`, so the Runs panel still names
  the plan and still opens the transcript. The file itself comes back with the
  **Import** button, the same one you already use for any other file, and lands
  in the library as a normal plan ready to schedule again.

  One consequence worth stating plainly: pressing **Run now** on a one-shot
  archives it as soon as it completes, *even if its scheduled time has not
  arrived yet*, and that pending occurrence is consumed along with it. The
  alternative is worse — a plan sitting in the archive folder that quietly fires
  on Thursday, with no row anywhere in the manager to explain where it came from.
  If you want it to run again on a schedule, import it back and schedule it.

  The first window you open after upgrading sweeps the library once, so plans
  that already ran under an older build are archived then rather than lingering
  until they run again. Each move writes one line to the **Chronos** output
  channel and nothing else — no popup, since the row disappearing in front of you
  is answer enough.

- **Deleting a plan or a task now archives the file instead of destroying it.**
  The × on a plan row and the bin in the task inbox both called `unlink`, which
  has no recycle bin and no undo behind it, on a button that sits at hover height
  where a misclick is a matter of time. The file now moves instead:

  ```
  your-project/.chronos/
    archive/
      plans/   <- archived plans
      tasks/   <- archived tasks
  ```

  A new toolbar button beside **Show results folder** opens that folder, creating
  it if this folder has never archived anything. Bringing a plan back is the
  **Import** button you already use for any other file — it copies the plan into
  the library, where it can be scheduled again. Nothing is ever pruned: there is
  no retention setting and no cleanup pass, because a plan you wrote is worth
  more than the bytes it costs to keep. Two plans archived under one title both
  survive, the second suffixed `-2`.

  Archiving a **scheduled** plan now asks once, with one button, where it used to
  offer "Delete both" and "Delete plan only". That second option never worked:
  the library watcher runs `consolidate` when a plan file leaves the folder, and
  `consolidate` drops every series whose file has gone — so the schedule died
  about 150ms later whichever button you pressed. The prompt now says plainly
  that the schedule and its run history go too.

- **Everything Chronos knows is now per folder.** Tasks, plans, schedules, run
  history and transcripts all live in a `.chronos` directory inside the folder
  you are working in, instead of one machine-wide set shared by every project:

  ```
  your-project/.chronos/
    plans/  tasks/  results/  logs/  state.json  scheduler.lock
  ```

  Open a project and you see that project's work and nothing else. The state
  that used to sit in VS Code's `globalState` is a `state.json` written through
  a temp file and a rename, so an interrupted write leaves the old schedule
  rather than a truncated one. The directory is still the database — there is
  no index, and `.chronos/plans` can be edited from outside Chronos exactly as
  the library always could.

  `.chronos/.gitignore` is written once on creation and contains `*`. Edit it if
  you would rather commit your plans; Chronos never rewrites it, and it never
  touches your project's own `.gitignore`.

  Three consequences worth knowing:

  - **A folder's tasks only run while a window is open on that folder.** This is
    what folder-specific means, and it cuts both ways: two windows on two
    different projects now both schedule, where before a single global lock
    meant only one window scheduled anything at all. The lock moved into
    `.chronos` with everything else.
  - **The first folder you open after upgrading adopts the old data** — plans,
    tasks, transcripts, schedules and history, all of it. Splitting it up
    automatically would be guesswork, since a plan file says nothing about which
    repository it belongs to, so it lands in one place and you move plans on
    from there. It is copied, not moved: the old extension storage is left
    exactly as it was, and the log says where.
  - **A multi-root workspace shows one folder at a time.** A dropdown above the
    plan list chooses which, remembered per workspace, with **Chronos: Select
    Folder** as the command-palette route. Switching is refused while a run is
    in flight rather than orphaning the child process and its half-written
    transcript.

  `chronos.libraryPath` and `chronos.resultsPath` still work and still override
  their part of the layout. Set in workspace settings they move one project's
  files; set in user settings they deliberately put every project back in one
  shared place.

- Generating a plan from a task no longer asks which folder to work in on a
  multi-root workspace. The task belongs to a folder now, so that folder is the
  answer.

- **The task inbox is readable and keyboard-driven.** Task text wraps over as
  many lines as it needs instead of being cut off at the width of an activity-bar
  panel, which is narrow enough that most tasks ended in an ellipsis — you could
  not read what you had written down. The row you are working with is marked with
  an outline, and the arrow keys, Home and End move it; `Enter` generates,
  `F2` edits and `Delete` removes, so the whole list works without the mouse.

  The per-row **Generate plan** lightbulb is gone, replaced by one full-width
  button under the list that acts on the selected task. It was the panel's main
  action and it was a 17px target that only appeared on hover, repeated once per
  row; now it is one button you can hit, and its tooltip names the task it will
  plan. Nothing changed on the extension side — the button sends the same message
  the row button did, and the host still checks the task exists before opening
  anything.

- **A task row in the sidebar shows a hand cursor when you point at it.** The
  whole row has always been the click target that selects a task, but the
  pointer stayed an arrow, so the row read as a label rather than something you
  could press. Every other clickable surface in the extension — the plan library
  rows, the run names, the buttons, the calendar days — already showed the hand,
  so this is the inbox catching up with the rest.

### Added

- **Added a Monthly repeat option** — runs on the same day of the month, clamped
  to the last day for shorter months. The day comes from the **When** field
  rather than a picker of its own, the way Weekly takes its weekday: set When to
  the 15th, choose **Repeat → Monthly**, and it runs on the 15th from then on.
  Set it to the 31st and February fires on the 28th (29th in a leap year) — the
  month is never silently skipped.

  Recurrence has never been stored as a word. `once`, `daily` and `weekly` are
  all read back out of `{ daysOfWeek, timeLocal }`, and "the 15th of the month"
  is not a thing a days-of-week array can say, so the rule gained an optional
  `dayOfMonth`. Optional and additive, like `agent` before it: every rule already
  on disk still parses, so there was no migration and no schema bump. When it is
  set, `daysOfWeek` is empty and unused.

- **The plan library reads as a traffic light.** The status line under each plan
  is green while that plan is on a live schedule, amber while it is paused or not
  scheduled at all, and red while an occurrence it missed is still waiting on you
  to run or skip it. A repeating plan stays red even though the time it shows has
  already moved on to the next slot — that is the case the old flat grey hid most
  completely. Colours come from the palette the run badges already use, so a light
  or high-contrast theme is handled by the same overrides.
- **A task can now run on an engine other than Claude.** The Schedule section
  gains an **Engine** dropdown beside **Model**, and picking `opencode` runs that
  plan through the `opencode` CLI instead — which is one binary that routes to
  Kimi, the GPT family and a local Ollama model through a single interface. That
  is the whole reason it was chosen over adding one integration per vendor:
  Chronos gets "other models" without growing a stream parser per provider.

  Claude remains the default and its path is untouched. A series with no engine
  set *is* a Claude series, which is what every existing schedule already means,
  so there was no migration and no schema bump.

  The dropdown only lists engines this machine answered `--version` on, checked
  once at startup by the same probe that already reported a broken `claudePath`.
  If you have no `opencode` on PATH the field does not appear at all. Claude is
  the exception: it stays listed even when broken, because a missing default is
  a setup problem to fix rather than a choice to withdraw.

  What made this small is that `TranscriptEvent` never named a vendor — it is
  `session | text | tool | result`. Both engines produce that union, so the live
  terminal, the Markdown transcript, the run cards and the status bar are all
  unchanged. Only the parse forks.

  Three things worth knowing:

  - **opencode has one approval control where Claude has six.** Its `--auto` is
    the only lever, so the Permissions dropdown offers just two options when the
    engine is opencode — auto-approve, and plan — rather than four more that
    would quietly mean the same thing. Switching engines does not overwrite a
    stored mode, so switching back restores it.
  - **Credentials stay with opencode.** It keeps its own provider logins and
    Chronos never sees a token, so there is nothing new stored on disk. The
    model list offers opencode's free hosted catalogue; anything else — Kimi,
    GPT, a local Ollama model — needs `opencode providers login` first and is
    then reached through the new **Custom…** box, since neither CLI can
    enumerate what your account can actually run.
  - **The phone still cannot change it.** `agent` joins `permissionMode` and
    `model` as published-but-read-only over the remote channel: which engine
    runs is *what* a task does, and a remote caller may only change *when*.

  New setting `chronos.opencodePath`. `src/models.ts` became `src/agents.ts`,
  which now holds the engine table and both model lists.

  Verified against a real `opencode` 1.18.5 run rather than assumed: the tool
  event arrives as `type:"tool_use"` with the name in `part.tool` and the target
  in `part.state.input.filePath`, so opencode transcripts record what a run
  touched the same way Claude's do.

- **A rejected opencode login is now reported instead of retried.** Chronos
  treats an authentication failure as permanent, because an expired token fails
  every task identically and three retries an hour apart only delay the
  discovery by three hours. That check reads either an API status code or the
  wording of the error, and opencode supplied neither: it words a 401 as
  "Upstream request failed: [401] Provider returned error", which matches none
  of the credential phrases, and its status code was being dropped during
  parsing. So a run that failed purely because you had not logged in was filed
  as an ordinary failure and retried. The parser now carries the status code
  through, which is all the existing check needed. Claude's path is unchanged.

- **The activity-bar view is now a task inbox.** It held two rows — *Open
  Manager* and *Schedule a Markdown file…* — both of which the status bar, the
  command palette and the manager already offered, so it read as a second,
  thinner UI beside the one that matters. The intent was to delete it outright.
  That is not possible: VS Code only draws an activity-bar icon for a view
  container, a container must hold at least one view, and there is no "icon runs
  a command" API. Keeping the clock icon means a panel opens either way, so the
  only real question was what goes in it.

  It is now the front of the pipeline the manager does not have — **capture →
  generate → schedule → run**, reading left to right across the two surfaces
  with no overlap. Type a one-line task, press **Generate plan**, and Claude
  works it into a real implementation plan that lands in the library ready to
  schedule. The sidebar owns capture, because it is always visible and costs no
  tab switch; the manager owns everything after it.

  A task is a `.md` file in `<library>/tasks/` — no schema bump and no new
  store, since `library.ts` is already parameterised by directory and
  `listPlans` skips subdirectories, so `tasks/` never appears as a plan. A task
  therefore survives a state reset, and can grow past one line.

  Generation is an *authoring* session, like the manager's own Generate plan
  button and outside the scheduler for the same reason: no `TaskRun`, no
  concurrency slot, no transcript, no leader lock. It is a real terminal running
  `claude` in plan mode, so Claude can ask clarifying questions before you
  approve. The destination file appearing in the library is the completion
  signal — the CLI exits when *you* close it, long after the plan is written —
  at which point the task is cleared and the manager opens with the new plan
  selected. Backing out at any point creates nothing and leaves the task where
  it was.

  The model comes from a QuickPick backed by a new `chronos.planModel` setting,
  which remembers your last choice and renders as a dropdown in Settings. The
  model list moved out of the webview and is sent to it in its state message, so
  the sidebar picker and the manager's Model dropdown can no longer drift apart.

  The drop controller moved to the new view unchanged: dropping a `.md` on the
  panel still schedules it in place. That is why the view contributes no
  `viewsWelcome` — welcome content cannot accept a drop, and the empty body has
  to stay a drop target.

- **A Generate plan button beside *Open in editor*, which turns a rough note in
  the Plan text box into a run-ready plan.** Writing a plan meant either typing
  the finished thing by hand or opening a terminal yourself, changing directory
  to the right repo, remembering the plan-mode flag and pasting the text in.
  Pressing the button saves what you have written, then opens a terminal in the
  plan's working directory running `claude` in plan mode on the plan's chosen
  model, already planning from your text. Approve the plan and Claude writes it
  over the plan file; the library watcher reloads the Plan text box on its own,
  so the result lands back in the manager without you fetching it.

  This is a real interactive terminal — `createTerminal` and `sendText` — not
  the read-only pseudo-terminal a scheduled run streams into, because the point
  is to talk back to Claude. It is an authoring session rather than a run, so it
  deliberately sits outside the scheduler: no concurrency slot, no run record,
  no transcript, no leader lock.

  The plan text is named, not pasted. `sendText` writes a single line into a
  shell; a plan body is multi-line and can be tens of kilobytes, cmd.exe caps a
  command line at 8191 characters, and every shell treats newlines, quotes and
  `$` differently. The prompt therefore names the file and Claude reads it with
  its own Read tool — no length limit, and only a path to quote. `--add-dir` on
  the plan's own folder covers the usual case of a plan living in the library
  while the working directory is the repo. Quoting branches on `vscode.env.shell`,
  since no one form is safe in PowerShell, cmd and bash alike.

- **A Runs panel across the bottom of the manager, listing every run for every
  plan.** Run history only ever lived inside the selected plan's detail pane, so
  answering *what is Chronus doing, and did anything fail?* meant clicking each
  plan in turn. The panel is pinned under whatever plan you have open and splits
  into **Upcoming** — each active series' next occurrence, plus any retry the
  scheduler has queued ahead of time — and **Recent**, everything that has
  already happened, newest first. Countdowns and elapsed timers tick there as
  they do in the detail pane. The per-plan Runs section is unchanged; the panel
  is the overview, the section is the detail.

  Row actions — cancel, skip, reschedule, result, raw log — work on runs
  belonging to plans you are not looking at, which is the one thing the per-plan
  section could not do. The plan name on each row is a button that selects it.
  A filter narrows to **Upcoming**, **Completed** or **Needs attention** (failed,
  missed, auth required, denials — cancelling is left out, since you did that
  yourself). **Hide** collapses the panel to its header, and both the collapse
  state and the filter survive a reload.

  *Upcoming* deliberately means only occurrences that exist: a series' own
  `nextRunAt` and a queued retry's `scheduledAt`. Expanding a recurrence rule
  across the coming week would be a forecast, and this panel is a record.

  The panel reuses the statusline's space, so the 7-day cost figure moves into
  its header rather than costing another strip. No schema, scheduler or runner
  changes: `TaskSeries` and `TaskRun` are untouched, and `Manager.post()` sends
  one new derived field over the state message it already sent.

- New `src/activity.ts` — `buildActivity(series, runs, now)`, pure and unit
  tested, holding the ordering and the upcoming/recent split. The webview renders
  what it is handed. `recency()` is now exported from `history.ts` and shared, so
  "newest first" has one definition rather than two that can drift; it gained a
  `startedAt` step for runs that have neither finished nor been missed, which
  pruning never sees.

- **Right-click any `.md` file → Schedule with Chronus.** In the explorer or on
  an editor tab; multi-select works. This is now the shortest way in and the one
  that does not depend on drag-and-drop working, which — see below — it largely
  had stopped doing. Hidden from the command palette, since it needs a file to
  act on and `Chronus: Schedule Markdown File…` already covers the palette case.

- **The activity-bar view accepts dropped files.** It was an empty tree dressed
  up with `viewsWelcome` links; it is now two real rows — *Open Manager* and
  *Schedule a Markdown file…* — behind a `TreeDragAndDropController`. Welcome
  content cannot be a drop target, which is why the rows had to become real ones.
  Drops here work from both the VS Code explorer and Windows Explorer, need no
  modifier key, and schedule the file **in place**. New `src/launcher.ts` holds
  the view and its controller, out of `extension.ts`.

- **A Completed section pinned to the foot of the plan library.** A one-shot
  that has run keeps its place in the list forever, so the top of the sidebar
  slowly fills with plans that will never fire again and the ones that still
  have a future get pushed down. Finished one-shots now drop out of **Library**
  and **External** and collect under **Completed**, newest first, with their
  names dimmed. Their meta line says when they ran rather than *Ran once*, which
  under that heading would only repeat it.

  The section sits outside the scrolling list, anchored above the folder links,
  so a growing pile of finished plans neither pushes the live ones out of view
  nor scrolls away itself. It takes a third of the panel at most and scrolls
  within that.

- **Rename (✎) and delete (×) buttons on every library plan in the sidebar.**
  Both meant selecting the plan and scrolling the detail pane to **Manage plan**
  — several steps to act on a file already in front of you. They appear on
  hover, stay visible on the selected row, and are reachable by keyboard.

  Renaming saves the open editor first: a rename moves the file, so anything
  typed has to reach the old path before it goes. Deleting does the opposite and
  drops a queued save for that plan, which would otherwise have written the file
  back a second or two after the delete removed it.

  External plans get neither. Their file lives outside the library and is not
  Chronus's to rename or delete — **Unschedule** in the detail pane is the
  equivalent, and it is the same line the Manage plan section used to draw.

  "Completed" is stricter than the stored `spent` flag, which the scheduler also
  sets the moment a run starts and on a one-shot that was missed. A plan only
  moves once its last run has actually finished — so a one-shot mid-run stays
  put and reads *Running now*, and a missed one stays put and reads *Missed*,
  since that one is still waiting for you to run or reschedule it.

### Fixed

- **Backing out of a planning session no longer leaves the task stuck.** Pressing
  **Generate plan** turned the task's dot amber and disabled its Generate button
  until the plan came back. Nothing ever put that right if the plan did not come
  back — press Esc, close the terminal, decide against it, and the task stayed
  amber and un-plannable for the rest of the session, with the only way out being
  to reload the window. Each attempt also left an empty folder behind in
  `.chronos/.pending`, and a file watcher running on it for as long as the window
  was open.

  A planning session now ends when its terminal tab closes. If a plan is sitting
  in the staging folder it is adopted exactly as it always was — so a session that
  finished while the watcher missed the event still lands in your library — and if
  there is no plan there the session is simply discarded: the dot goes back to
  grey, the button re-enables, the staging folder is deleted and the task file is
  not touched. The signal is the tab closing rather than Claude exiting, because
  quitting Claude only returns you to a shell prompt and the session is still
  resumable from there. Closing a terminal you meant to close is not news, so the
  whole of the notice is one line in **Chronos: Show Logs**.

  Folders stranded by a window that crashed or reloaded are swept on startup and
  whenever you switch folder, once they are a day old — old enough that a second
  window's session in flight cannot be caught by it. One with a plan still in it
  is kept rather than deleted, since that plan never reached your library and is
  the only copy; the log names the folder so you can rescue it by hand.

- **Two windows open on one folder can no longer wipe the schedule between
  them.** Every write to `state.json` goes through a temp file first and is then
  renamed into place, which is what keeps a crash mid-write from truncating your
  schedule. But that temp file had one fixed name, shared by every window — so
  the scheduling window saving a finished run at the same instant you dragged a
  time in a second window meant both were writing the same path. The two writes
  interleaved into a file that parsed as nothing, and the next read set it aside
  as unrecoverable and handed back an empty schedule: every plan and every run
  gone from the manager at once.

  Each window now writes through a temp name of its own, picked once when it
  starts. Two windows can no longer pick the same one, and because a window
  reuses its name for every write rather than picking a fresh one each time,
  there is nothing left to accumulate — the worst a crash mid-write can leave
  behind is a single stray file per window.

- **Dragging a file from Windows Explorer onto the manager works again.** It had
  been failing with *"Could not read the dropped files — use Import instead."*
  for some time, and the cause was outside Chronus: the code read the dropped
  file's location from `File.path`, a non-standard property Electron added and
  then removed in version 32. Every current VS Code build is well past that, so
  the property was simply `undefined` and the list came back empty.

  There is no replacement — a sandboxed webview cannot learn where a file lives
  any more, by design. What it can still do is read the contents, so an OS drop
  now copies the file into your plan library and schedules the copy, exactly as
  **Import** does. The notice after the drop says so, because "scheduled" and
  "copied, then scheduled" differ in a way you would otherwise discover later:
  edits to the original would never run. Drops onto the activity-bar view and the
  right-click command still schedule in place, and remain the better route.

- **Dragging from the VS Code explorer onto the manager no longer silently does
  nothing.** VS Code disables mouse interaction over a webview while a drag is in
  flight, so the manager never saw the drag unless you held Shift
  ([vscode#182449](https://github.com/microsoft/vscode/issues/182449)). Nobody
  would guess that. The Shift path still works, but the activity-bar view added
  above is a real drop target that needs no modifier.

- **The external-plan guard no longer folds case on filesystems that don't.**
  The check deciding whether the manager may write to an absolute path compared
  paths lowercased on every platform. On Linux `Plan.md` and `plan.md` are two
  different files, so the guard was wider than intended there and would have
  permitted a write to a file the caller never named. Case is now folded only on
  Windows. No change to Windows behaviour.

- **Windows open on different projects each run their own schedule
  (0.8.0-rc.28).** If two VS Code or VSCodium windows are open on two different
  projects and only one of them will schedule anything — the other refusing
  **Run now** and showing a banner about another window — that installation
  predates the per-folder layout. Everything Chronos writes moved into a
  `.chronos` directory inside the folder you are working in as of **0.8.0-rc.24**,
  the scheduler lock along with it, so each window now arbitrates only its own
  folder. Before that there was a single `scheduler.lock` in extension storage
  for the whole machine, and exactly one window could hold it no matter what any
  of them had open. **Anyone still on 0.8.0-rc.20 or earlier must reinstall to
  get this** — there is no fix available to an older build, because the layout it
  is using is the problem.

  The lock itself is deliberately kept. It only engages now when two windows are
  genuinely sharing one dataset — the same folder, or two folder-less windows on
  the fallback root — and there one scheduler is the right answer: two windows
  firing the same task means two agents editing one repository at the same
  moment.

- **Two windows open during the upgrade no longer both adopt the old library.**
  Adoption — the one-time copy of the machine-wide dataset into the first folder
  opened after the upgrade — was guarded only by a flag in VS Code's global
  state, and that flag does not reach another window the moment it is written. So
  two windows open when the new build first loaded would both see "not adopted
  yet", and every legacy plan *and its schedule* would land in two different
  projects, both of which then started firing them. A claim file is now created
  in the old storage before anything is copied, using an atomic create-or-fail —
  the same guarantee the schedule's temp-file-and-rename write relies on. The
  window that loses the race logs that it stood aside and leaves the data alone.
  The global-state flag is unchanged and still handles the ordinary single-window
  case without touching the disk.

- **A second window on the same folder can no longer wipe the first one's run
  history.** The store read `state.json` once at startup and wrote its whole
  in-memory copy back on every change. With two windows on one folder, the
  window not holding the lock held a snapshot that went stale the instant the
  other recorded a run — and its next edit, however small, put that snapshot back
  over the top, silently destroying every run and schedule change made since.
  Each change now re-reads the file, applies itself to that, and writes the
  result, so "last writer wins" is narrowed from the whole file down to the one
  field being changed. This is not syncing and nothing watches anything: a window
  still shows what it last read, it simply stops overwriting what it never read.

- **The "another window" banner says which window it means.** It read *"Another
  VS Code window is running the Chronos scheduler. Nothing will run from this
  window, and changes made here may not reach it"*, which was written for the old
  machine-wide lock, where it was true of any other window at all. It can now
  only mean a second window on this same folder, so it says that and names the
  folder — and the **Run now** refusal says the same thing. If you ever see it in
  a window on a different project, that is a bug, and now you can tell.

- **The published extension no longer contains the plans and transcripts of
  whoever built it (0.8.0-rc.31).** A side effect of the per-folder layout above:
  running Chronos on its own repository leaves a real `.chronos` in the project
  root, holding that developer's plans, run transcripts, logs and schedule.
  `.chronos/.gitignore` keeps all of it out of git, which is why nothing looked
  amiss, but the packaging tool reads `.vscodeignore` and does not consult a
  nested `.gitignore` — so the directory went into the `.vsix` and would have
  reached every install, 13MB of one machine's private work included. It is now
  excluded by name. Builds before 0.8.0-rc.24 could not hit this, because there
  was no `.chronos` directory to sweep up.

### Changed

- **One schedule toggle instead of two buttons (0.8.0-rc.23).** The detail pane
  had a **Schedule this plan** button when a plan had no schedule and a separate
  **Pause** / **Resume** button once it did. They are now a single control that
  reads its own state: grey **Schedule** when nothing is scheduled, sodium amber
  **Scheduled** while the job is live, grey **Paused** when it is scheduled but
  paused. Clicking it schedules the plan, or toggles between live and paused.

  The colour is the point. Amber is the one thing Chronos spends on liveness, so
  it appears only while the job will actually fire — a paused series and a spent
  one-shot both stay quiet, the same rule the countdown ring already follows.
  **Run now** and **Unschedule** are unchanged, and so is everything outside
  `media/`.

- **The Schedule section's When field is a real picker now (0.8.0-rc.22).** It
  was a native `datetime-local` input, which meant setting a time was six typed
  segments — `MM/DD/YYYY hh:mm AM` — and the calendar it opened was drawn by the
  browser, outside the page, where the only thing Chronos could change about it
  was whether it came up dark or light. A white-and-blue Chromium calendar over
  the manager looked like it belonged to a different program, because it did.

  It is now a button that reads the scheduled time back to you, and opens a
  popover built from the same palette as everything else: a month grid you click
  a day in, arrows to page through months, and three dropdowns for hour, minute
  and AM/PM. Nothing is typed. The selected day is filled in sodium, the same
  colour the countdown ring and the run dots use for the scheduled instant, and
  today is outlined.

  Two details worth naming. Past days are still clickable — the native input
  allowed them and the host is what decides whether a past time means anything,
  so nothing new was invented here. And the minute dropdown steps in fives but
  always includes whatever minute is already set: a series running at `:07` does
  not get quietly rounded to `:05` just because you opened its picker to change
  the hour.

  The value itself is unchanged. It still leaves through the same path it always
  did, so recurring series keep moving their rule with their time, and nothing on
  the host side knows the control was replaced.

- **A generated plan is now named after the change it makes (0.8.0-rc.21).**
  Chronos used to name the file before the plan existed, by slugging the first
  line of the task — so the library filled with truncated request text on files
  whose contents said something else entirely. A plan about controlling the
  desktop from a phone was filed as
  `when-clicking-generate-plan-in-the-task-sidecar-i-would-like.md`. Claude now
  names the file itself, as part of approving the plan: it knows what the plan
  does, and Chronos does not.

  That name has to land somewhere safe, because a self-chosen one could collide
  with a plan you already have. So each planning session writes into its own
  staging folder, `.pending/<session>/` inside the library, and Chronos adopts
  the file from there through the same door every imported plan comes through —
  which slugs the name and appends `-2` rather than overwriting anything. The
  folder is also what still matches a finished plan back to the task that asked
  for it, so the task clears exactly as before, even with two sessions open at
  once. Backing out of a session still creates nothing; its folder is cleared on
  the next window reload.

  Plans already in your library keep the names they have — nothing is renamed
  retrospectively. Import, drag-and-drop and **Schedule with Chronos** are
  unchanged, and so is the manager's own **Generate plan** button, which rewrites
  a plan in place under the name you gave it.

- **The Tasks view is a real to-do list now (0.8.0-rc.20).** It was a native tree:
  one grey circle per row, and adding a task meant clicking **＋** in the title
  bar and answering a pop-up input box. It is now an HTML view, styled like the
  manager, with a **What needs doing?** field and an **Add** button always
  visible at the top — type, press Enter, and the row is there. Editing happens
  in place on the row rather than in a pop-up: the pencil turns the text into a
  field, Enter saves, Esc cancels. Deleting still asks first, because the file is
  unlinked rather than recycled.

  Each row carries a status dot, the same one the Runs panel uses. A captured
  task is a hollow neutral ring; a task with a planning session open glows amber
  with a halo, so the list says which of them Claude is working on. Nothing new
  is stored for this — the dot reads the same in-memory map that already clears a
  task when its plan lands, so a window reload leaves the dot neutral while the
  plan still arrives.

  A tree cannot host an input field, in-body buttons or freely coloured rows —
  that is an API limit, not a styling one — so the view had to change technology
  to change shape. The cost is below, under Removed.

- **The clock icon in the activity bar now opens the manager too.** Clicking it
  used to show only the Tasks inbox, so the most visible thing Chronos puts in
  the editor did not lead to Chronos' actual UI — you needed a second click on
  **Open Manager**, the status bar item, or the command palette to get there.
  Now one click reveals the Tasks sidebar exactly as before *and* opens the
  manager tab behind it.

  The sidebar deliberately stays open. It is the capture inbox, so collapsing it
  to make the icon a pure launcher would cost more than it gained.
  The manager opens without taking focus, which means your keystrokes stay in the
  sidebar where you clicked. **Open Manager**, the status bar item and
  `Chronos: Open Manager` all still work and still open the manager *with* focus
  — they are how you get the tab back after closing it.

  One consequence worth knowing: if VS Code reopens a window with the Chronos
  container showing, the manager opens with it.

- **The two folder links in the plan library are now icon buttons, up in the
  header.** *Show library folder* and *Show results folder* were underlined blue
  text stacked on two lines in a footer — the loudest thing in the panel, spent
  on the two actions you reach for least. They are now two 24px codicon buttons
  sitting beside **Import**, quiet at `--muted` and lighting on hover, like the
  rename and delete actions on a plan row. The tooltip and the screen-reader
  label both still say the full wording, and clicking either does exactly what
  it did before.

  Moving them retires the footer entirely, so the plan list and the **Completed**
  section now run to the bottom of the pane. The class is `.icon-action` rather
  than `.foot-action`, since it no longer describes where the button lives. The
  header row wraps rather than shrinks: at a large editor font four controls do
  not fit 260px, and a squashed *New plan* reads worse than a second row.

  This adds the official VS Code **codicon** font to the project, vendored as
  `media/codicon.css` and `media/codicon.ttf`. The webview may only load from
  `media/` and the packaged `.vsix` excludes `node_modules/`, so the files are
  committed there rather than copied by the build. Both are byte-identical to
  upstream `@vscode/codicons`, so refreshing them is a re-copy, not a merge.

- **There is one kind of plan now: every scheduled plan lives in the library.**
  Chronos used to have two. Library plans were `.md` files in the library folder,
  addressed by name. *External* plans were files anywhere else on disk that had
  been scheduled where they lay — addressed by absolute path, listed under their
  own heading with a badge, and denied rename and delete.

  Nobody asked for that distinction, and it cost a second file watcher, a second
  security model on the load and save messages, an `external` flag threaded
  through the webview protocol, and a second list in the sidebar. It was already
  inconsistent with itself: dropping a file onto the manager tab copied it into
  the library, while dropping the same file onto the activity-bar view scheduled
  it in place, and the README carried a paragraph whose only job was to explain
  why.

  **Every way of adding a plan now copies the file into your library and
  schedules the copy** — New plan, Import, right-click → **Schedule with
  Chronos**, and a drop onto either the activity-bar view or the manager tab.

  Copy, never move: **your original file stays exactly where it is**, and Chronos
  never edits or moves it. The consequence is worth stating plainly, because it
  is the one thing this changes for you — after adding a file, editing your
  original no longer affects what runs. The notice after adding says so.

  A plan added from a project keeps that project as its working directory. The
  file moves into the library; the work it does still belongs where it was.

- **Plans scheduled in place by an older version are copied into the library on
  first launch, and their schedules repointed at the copy.** Time, recurrence,
  permission mode and working directory all survive; only the file path changes.
  Two schedules pointing at the same file share one copy rather than getting two,
  and a name that collides with an existing plan is imported as `name-2.md` with
  both schedules intact. `Chronos: Show Logs` names every file it copied.

  This runs on every activation and needs no schema bump — once it has run, every
  path is already inside the library, so a second pass finds nothing to do.

- **A schedule whose plan file no longer exists is removed, along with its run
  history.** Previously it stayed in the list and fired on time, forever, failing
  every time because the file it names is gone. Delete a plan file in your file
  manager and the row now disappears within a second or so, whether the manager
  tab is open at the time or not; the removal is recorded in the log, since it
  discards work you created and the row is the only other place it was accounted
  for.

  A library folder that cannot be *read* is never mistaken for one that is empty.
  If `chronos.libraryPath` points at an unplugged drive or an offline share,
  Chronos touches nothing at all and says why in the log — pruning on that would
  destroy an entire schedule over a kicked-out cable.

- **New tasks default to the `auto` permission mode, not `bypassPermissions`.**
  The old default handed every scheduled task unrestricted tool access, and on a
  recurring series that waiver repeats indefinitely. `auto` leans on the CLI's
  own judgement about what is safe to do unattended instead.

  The trade-off is the reason the old default existed, and it has not gone away:
  a mode that can still stop and ask has nobody to answer at 3am, so a run may
  end having done only part of the job. Reviewing a plan before scheduling it
  remains the real safety step, and `bypassPermissions` is still one click away
  in the manager, still carrying its ⚠.

  **Existing tasks are untouched.** The default applies when a series is
  created; anything already scheduled keeps the mode stored with it. To move an
  old task, change **Permissions** on it in the manager.

- **The date picker no longer opens a white panel over a dark editor.** The
  **When** field's popup is browser chrome — drawn outside the page, where no
  selector reaches inside it. The one lever that does is `color-scheme`, now
  declared on `body` and flipped for both light themes, which decides whether
  Chromium paints the calendar, the **Repeat** dropdown and the native
  scrollbars dark or light. The popup keeps Chromium's own layout; it stops
  being the only light surface in the window.

  What *is* reachable is the control itself, and that is what you look at the
  rest of the time. The field now uses the editor font with tabular figures —
  the two-typeface rule the rest of the manager already follows, since a date is
  a measurement. The segment being edited is highlighted in sodium rather than
  the OS selection blue, which belonged to no theme here, and the calendar glyph
  sits muted and lights on hover, the same move the sidebar row actions make.

- **The publisher is now `Z3n`, not `onemedialabs`.** The extension id becomes
  `Z3n.chronos`, and the MIT copyright holder changes to match.

  Note that VS Code lowercases extension ids, so the installed extension reports
  itself as `z3n.chronos`. `package.json` keeps the capitalisation.

  **This resets your data a second time,** for the same reason the rename below
  did: VS Code keys stored state by the full id, and the publisher is half of
  it. Scheduled tasks and run history do not carry over. Plan files are ordinary
  Markdown and survive — copy them from the `onemedialabs.chronos\plans\` folder
  in globalStorage into the new `Z3n.chronos\plans\` one and re-schedule them.
  Settings are keyed by `chronos.*`, not by publisher, so those are kept.

  **Uninstall `onemedialabs.chronos` before installing this build**, on the same
  grounds as below: a changed id means the new build installs alongside the old
  one rather than over it, and two schedulers can fire the same plan twice.

- **The extension is now called Chronos, not Chronus.** The name was always meant
  to be Chronos; it had simply been misspelled everywhere since the first commit.
  Because it was never published, fixing it properly was still cheap, so the
  rename goes all the way down: extension id (`onemedialabs.chronos`), settings
  (`chronos.*`), command ids, view ids, storage keys and the `ChronosState` type.

  **This resets your data.** VS Code keys an extension's stored state by id, so
  `onemedialabs.chronos` starts with an empty one: scheduled tasks, run history
  and any customised `chronus.*` settings do not carry over, and no migration was
  written. Plan files are unaffected — they are ordinary Markdown in
  globalStorage, so copy them from the `onemedialabs.chronus\plans\` folder into
  the new `onemedialabs.chronos\plans\` one and re-schedule them.

  **Uninstall the old extension before installing this build.** Two installs mean
  two schedulers holding two separate lock files, neither aware of the other, and
  the same plan can fire twice.

- **New extension icon** (`media/icon.png`, 128×128) — the faceted sculpted
  head, replacing the clock-and-arrows mark. It is the marketplace icon and the
  manager panel's tab icon.

  `media/chronos.svg`, the activity-bar icon, is deliberately left as the old
  line mark. VS Code masks that icon to a single theme colour, so a photographic
  image can only arrive there as a silhouette.

- **Deleting a plan always asks now, and says the file is not recycled.** It
  only asked when the plan was scheduled; an unscheduled one was unlinked on the
  first click, with no way back. That was survivable while Delete was buried at
  the bottom of the detail pane, but the new sidebar × puts a permanent delete
  one misclick from every row. Both prompts now carry the same detail line —
  *The file is deleted, not moved to the recycle bin* — because `removePlan`
  unlinks, and a dialog that does not say so is worse than none.

- **The detail pane follows the authoring flow: write the plan, decide when it
  runs, read what happened.** Plan text is first, schedule second, runs third.
  Rename, Duplicate and Delete move to the bottom under a **Manage plan** heading
  — they are rare and one is destructive, but they sat directly under the title
  competing with the schedule. `Open in editor` moves inline beside the *Plan
  text* label, where the affordance belongs. The editor's default height drops
  from 260px to 180px so the schedule and runs stay reachable without scrolling;
  it is still resizable.
- **The head is now the hero, and it carries the countdown.** A plan's next run
  used to hide inside the *Schedule* section heading, set in the same font as
  everything else. It is now a large amber countdown beside the title
  (`in 6h 12m · daily 21:30`), with the file path demoted to a quiet third line.
- **One owned colour.** The shell still derives every background, border and
  focus ring from `--vscode-*`, so the manager belongs to whatever theme you run.
  Chronus owns a single amber — sodium — and spends it only on liveness and
  imminence: the countdown, the ring, the queued badge, and a left edge on a plan
  that is running right now. Focus rings stay `--vscode-focusBorder`; splitting
  focus from status is what stops one accent becoming decoration. Light themes
  get a darker sodium, and **high-contrast themes fall back to the focus colour**
  rather than having amber painted over an accessibility theme.
- **Run badges read as a traffic light.** A completed run used to wear a *blue*
  outline borrowed from the focus colour, which is not a verdict. Completed is
  now green, queued is sodium, and failed / missed / auth required / denied stay
  red. Cost, `retry N` and cancellation stay neutral grey — they are facts, not
  verdicts, and colouring them would dilute the three that matter.
- **Two typefaces, one rule.** Prose — titles, buttons, notices — is set in the
  UI font; every measurement — time, duration, cost, badge, path, section label —
  is set in the editor font with `tabular-nums`, so costs and durations align
  into a column down the runs list. No web font is bundled: a display face would
  fight every theme and inflate the `.vsix` for nothing.
- **A time axis, in two expressions.** A countdown ring in the head fills as the
  current interval elapses toward the next run — a weekly plan uses its own
  interval, and a one-shot shows an outline with no arc rather than inventing a
  progress figure. The runs list gains a vertical rail with one dot per run,
  replacing the flat bordered rows; the dot carries the same three-state colour
  as the badges. Circles are occurrences, the rail is elapsed time, and nothing
  else in the UI uses the motif.
- The elapsed-run ticker generalises to drive the countdown text and the ring's
  arc as well. The arc is written with `setAttribute('stroke-dashoffset', …)` —
  an SVG presentation attribute — because the webview's CSP allows no inline
  styles. Reduced motion disables the ring sweep and the running dot's halo while
  leaving the arc rendered.
- The drop overlay reads *Drop a .md file to schedule it*; the common case is one
  file and the active voice matches the rest of the UI.

- `samePath` and the scheduled-plan check moved from `manager.ts` to
  `library.ts`, which already owns the library's traversal guard and has no
  `vscode` import. A duplicated copy of `samePath` went with the move.
- `finaliseInterrupted` moved from `runner.ts` to `transcript.ts`, taking its
  filesystem and logging as injected operations in the manner of
  `preflightError`. `runner.ts` keeps a one-line wrapper supplying the real
  `fs`; `Scheduler.reconcile` is unchanged. The cases worth testing here are the
  ones where the disk refuses — a rename or an append that throws must return the
  original path and must not take the scheduler down at startup — and those are
  awkward to force against a real directory.
- New `test/source-guards.test.ts` fails the build if `Math.random(` reappears
  anywhere in `src/`. The CSP nonce's only worthwhile property is that it cannot
  be guessed, which no assertion on a returned string can demonstrate; a test
  that two nonces differ would pass for a counter. Reading the source is the
  check that would actually have caught the original defect.
- `docs/TEST-PLAN.md` gains step 7.8, confirming by eye that the nonce reaches
  the document and changes between opens — the half of the fix no test reaches.
- The manual test plan's numbered sections are **steps** rather than *gates*,
  and each one's table column is **Check** rather than *Step* — the old naming
  had a "Step 1" containing fourteen "steps". Sprint exit criteria in the
  planning documents keep the word *Gate*, as do the concurrency and permission
  gates in the source; those are different things.

### Removed

- **The Completed panel at the foot of the plan library (0.8.0-rc.29).** Finished
  one-shots used to collect in a pinned strip below the plan list, newest first,
  capped at a third of the panel. It was there so they stopped pushing live plans
  out of view — but a panel that never empties is permanent furniture for plans
  with nothing ahead of them. The library is now a single scrolling list of plans
  that still have a future, and a plan whose one run has finished simply leaves
  it.

  Nothing is deleted: the plan file stays in the library folder and every run
  stays under **Runs**. The trade is that the ✎ rename and × delete buttons live
  on library rows, so a finished plan can no longer be renamed or deleted from
  inside Chronos — the 📚 *Show library folder* button is the way to do either.
  Search will not surface a finished plan either, and clicking its run row under
  **Runs** is how you open it again. A plan mid-run or one that was missed is
  still shown; neither is finished.

- **The sidebar is no longer a drop target (0.8.0-rc.20).** Dragging a `.md` file
  onto the Tasks view used to schedule it, and a webview cannot accept that drop
  the way a tree could — VS Code blocks mouse events over a webview mid-drag, and
  Electron 32 removed `File.path`, so a sandboxed view can no longer learn where
  a dropped file came from. `PlanDropController` is gone with it.

  The three other routes are unchanged and one of them is a drop: drag onto the
  **manager** pane (hold **Shift** when dragging from the VS Code explorer),
  right-click a `.md` file → **Schedule with Chronos**, or use **Schedule
  Markdown File…** in the Tasks view's **⋯** menu. All four still end the same
  way — a copy in the library, scheduled, your original untouched.

  The **＋** button in the Tasks title bar went too, since adding is now a field
  in the panel itself. `Chronos: Add Task` remains in the command palette. The
  `chronos.generatePlan`, `chronos.editTask` and `chronos.deleteTask` commands
  are gone: they existed only to put icons on a tree row, were hidden from the
  palette, and the row buttons now speak to the view directly.

- **The External group and its badge**, along with everything that existed to
  support the second kind of plan: the second `fs.watch` on an external plan's
  own directory, `readPlanAt` / `writePlanAt` / `isScheduledPlan`, and the
  `external` flag in the webview protocol.

  The messages that address a plan — `loadPlan`, `savePlan`, `openInEditor`,
  `schedulePlan`, `generatePlan` — now carry a **name and nothing else**. No
  absolute path crosses the webview boundary in either direction, so every read,
  write, schedule and open resolves through the one library guard rather than
  through an "is this path actually in the schedule?" check standing in for it.
  With a single group, the **Library** heading over it named nothing, so it went
  too.
- `.badge.is-repeat` — dead CSS, nothing ever emitted the class.
- Status dots on library list items, which were redundant: each item already
  prints its next run in text.
- **The Manage plan section at the foot of the detail pane.** Rename and Delete
  moved to the sidebar row, where they act on a plan without selecting it first;
  the section held nothing else worth the heading. The detail pane now ends
  after the Runs section.
- **Duplicate**, which had no home once the section went and no other entry
  point. `library.duplicatePlan` and its tests are kept — the function is pure
  and harmless, and restoring the feature is then a UI change only — but the
  `duplicatePlan` webview message and its handler are gone, so nothing can
  reach it. The IPC surface should not outlive the button.

## [0.8.0-rc.3] - 2026-08-02

A full audit of the codebase, and the ten defects it found. Two of them could
lose or duplicate real work; the rest are hardening. No feature changes.

### Fixed

- **A task queued behind a busy slot is no longer marked missed.** With
  `maxConcurrent` at 1 — the default — any run lasting longer than the 15-minute
  grace window caused whatever was queued behind it to age out and be reported as
  *missed while VS Code was closed*, with the editor open in front of you. The
  task then never ran. The scheduler now records the runs it deferred for
  capacity and exempts them from the grace window, so a queued run waits rather
  than expiring. Deferrals are held in memory, not the store: after a restart or
  a suspend nothing was holding the run back, and the grace window should judge
  it normally again.
- **Two VS Code windows no longer run every scheduled task twice.** Each window
  activates its own extension host, and `globalState` gives neither any sight of
  the other's writes — so both saw the same task as due and both spawned an
  agent for it, in the same repository, at the same moment. `maxConcurrent` could
  not help; it counts one window's runs. A lock file beside the state now decides
  which window schedules. The others show the UI, say so in a banner, and stay
  out of the way. Closing the holder hands scheduling over within about a minute.
  This also stops a second window reconciling — and failing — a run the first
  window is still executing.
- **One unusable repeat rule no longer stops every other task.** A recurrence
  with no days, or a time that is not a wall clock, threw inside the scheduler's
  tick, which caught it and moved on — silently halting the entire schedule every
  30 seconds with nothing but a log line. A broken rule is now caught per series:
  that one task is paused and reported, and everything else keeps running.
- **Transcripts left behind by a crash are closed out on the next launch.**
  Killing VS Code mid-run left the file without its footer and without its
  `-failed` suffix, so the results folder stopped answering "which nights went
  wrong" for exactly the runs that went most wrong. Reconciling an orphaned run
  now appends the footer and applies the suffix.

### Security

- **The manager's schedule edits are validated rather than trusted.**
  `updateSeries` accepted any `Partial<TaskSeries>` — a type erased at runtime —
  and wrote it straight to the store. Two of those fields leave the process:
  `model` becomes an argv entry for a shell-invoked spawn on Windows, where Node
  does not quote arguments, and `filePath` decides which file the agent is handed
  as its prompt. A new `edit.ts` checks every field against the same
  allowlist-and-reject pattern `command.ts` already uses for the phone; identity
  fields are not editable at all.
- **Editing an external plan is confined to plans that are actually scheduled.**
  `savePlan` would write arbitrary text to any absolute path the webview named.
  The design note that justified bypassing the library guard rested on those
  paths already being trusted because the runner executes them — true only of
  paths in the schedule, which is now what the code checks.
- **The webview CSP nonce comes from `crypto`,** not `Math.random()`.

### Changed

- Missed runs are capped at 100, so a catch-up decision that is never answered
  cannot grow the store without bound. Finished runs keep their own cap of 50.
  Pending and running runs are still never pruned.
- `chronus.logRetentionDays` said it deleted transcripts; it deletes raw logs,
  and the transcripts are kept indefinitely. The description now says so, and no
  longer contradicts `chronus.resultsPath`.

### Internal

- New `vscode`-free modules on the test allowlist: `lock.ts` (which window
  schedules), `edit.ts` (what the manager may change), `history.ts` (what is
  pruned). Run-history pruning moved out of `store.ts` so the one place Chronus
  deletes user data is covered by tests.
- 257 tests across 59 suites, up from 201 across 45.

## [0.8.0-rc.2] - 2026-07-28

### Added

- **Pick a specific model per schedule.** The Model dropdown now offers pinned
  versions — Opus 5, Opus 4.8, Sonnet 5, Haiku 4.5, Fable 5 — alongside the
  account default and the bare family aliases (Opus/Sonnet/Haiku "latest", which
  track the newest of a family). The selected value is passed to the CLI's
  `--model` verbatim, so a run is reproducible against a named model rather than
  whatever the default happens to be that week.

## [0.8.0-rc.1] - 2026-07-27

Chronus had two renderers over one store — a sidebar and a manager — and neither
was complete, so every feature since 0.6.0 was built twice or landed in only one.
This release removes the sidebar and leaves the manager as the single UI, after
first porting everything the sidebar could do that the manager could not.

### Added

- **Drop zone in the manager.** Drag `.md` files anywhere onto the manager to
  schedule them; a whole-pane overlay marks the target. `readDrop` was ported
  verbatim from the sidebar rather than rewritten — it is the only drop code
  exercised against real events. A dropped file is scheduled **in place** and
  listed under **External**; **Import** still copies into the library, the
  deliberately different gesture. Text dragged inside the plan editor is left
  alone.
- **Missed-run actions in the manager.** A missed one-shot offers **run now** /
  **reschedule** (prefilling the run's own time of day on its next occurrence); a
  missed recurring series offers **run now** / **skip**.
- **Setup-problem banner in the manager.** An unreachable `chronus.claudePath`
  now surfaces as a sticky banner here too, replayed when the tab is revealed.
- **External plans are editable.** A plan scheduled from outside the library is
  now edited in place and saved back to its own path — never copied in. Its
  directory is watched, so the two-editor conflict logic works outside the
  library too. New `readPlanAt` / `writePlanAt` operate on absolute paths; the
  name-derived `resolveInLibrary` guard is unchanged and still tested.
- **Activity-bar launcher.** The branded clock icon stays, backed by an empty
  view whose `viewsWelcome` content is a button to the manager — a launcher, not
  a second renderer.

### Removed

- **The sidebar webview.** `src/panel.ts` and `media/panel.{html,css,js}` are
  gone, along with the `chronus.dashboard` view, its `view/title` menu and the
  `chronus.open` command. `chronus.addFiles` now targets the manager.

### Changed

- The manager carries the house glass aesthetic the sidebar had: `backdrop-filter`
  panels and hairline borders, plus a first-run empty state explaining what
  Chronus does and the two ways to add a plan.
- Tests: **160, up from 157** — covering the absolute-path plan helpers.
- Docs: README rewritten from "two views" to the single manager; `TEST-PLAN.md`
  folds Step 8b into one manager step and adds drop-zone and missed-action cases.

## [0.7.0-rc.1] - 2026-07-26

Chronus could tell you a scheduled job had finished, what it cost and how long
it took — but not what it did. This release makes the result of a run the thing
you get back from it.

### Added

- **Run transcripts.** Every run now writes a readable Markdown file: a header
  recording the conditions it executed under (time, directory, permission mode,
  model, retry number), the agent's narration and every tool call with its
  target, and a footer stating the outcome, turns, cost and duration.
- **A results folder you can actually browse.** One subfolder per plan, one file
  per run, named `2026-07-26-213045-completed.md`. The filename carries the
  outcome, so the folder answers "which nights failed" before anything is
  opened. Defaults to `results` beside the plan library; set
  `chronus.resultsPath` to move it. **Show results folder** in the manager opens
  it in the file manager.
- **The agent's closing message is kept and shown.** It appears under the run in
  both views — clamped to three lines in the sidebar, in full in the manager —
  with **View result** opening the transcript in Markdown preview. **Raw log**
  still reaches the underlying stream for debugging.
- Permission denials are called out prominently in the transcript footer, since
  a gated run exits successfully having quietly done a fraction of the work.

### Changed

- **New tasks default to `bypassPermissions` instead of `acceptEdits`.** Chronus
  runs plans while nobody is at the keyboard, and every gentler mode blocks on a
  prompt no one is there to answer — the run then exits 0 having done part of
  the job. Reviewing a plan before scheduling it is the safety step; a
  permission dialog at 3am is not. Existing tasks are untouched.
- NDJSON rendering moved out of `runner.ts` into `transcript.ts`, which parses
  each event once and formats it twice — ANSI for the live terminal, Markdown
  for the file. It was previously untestable behind the `vscode` import.
- Transcript path arithmetic lives in `results.ts`, reusing the plan library's
  existing slug and containment rules rather than a second implementation.
- Tests: **157, up from 124.**

### Fixed

- **A run no longer holds its entire output in memory.** `runner.ts` accumulated
  every byte of stdout for the life of the run purely to read the final result
  line back out at the end, while the same bytes were already streaming to disk.
  Only the last result line is retained now.

### Notes

- Raw logs are still pruned on `chronus.logRetentionDays`. Transcripts are
  **not** deleted automatically — they are written to be kept and read, and
  silently deleting a record of unattended work is the wrong default.
- `bypassPermissions` is paired with `--allow-dangerously-skip-permissions`,
  which the CLI documents as making the bypass *available* rather than active.
  That pairing is still unverified end to end — `docs/TEST-PLAN.md` Step 2.

## [0.6.0-rc.4] - 2026-07-26

### Fixed

- **A run's terminal was effectively invisible.** The tab was created without
  being revealed, and on completion the runner fired the pseudoterminal's
  `onDidClose`, which makes VS Code dispose the tab. A run lasting seconds
  therefore appeared in a tab list nobody was looking at and then deleted
  itself. The terminal is now revealed on start (focus is left alone) and stays
  open after the run, ending with a "Run finished" line.

### Added

- `chronus.showTerminalOnRun` (default `true`) to turn the reveal off.

### Notes

- Chronus has never used an existing terminal, and still does not. Runs are
  spawned as their own process and mirrored into a dedicated
  `Chronus: <plan>` pseudoterminal — `terminal.sendText()` carries no exit
  code, which would make the retry logic unimplementable.

## [0.6.0-rc.3] - 2026-07-26

### Added

- Branding from `favicon.ico`. The extension tile and the manager's editor tab
  now use the full-colour clock-and-arrows mark (`media/icon.png`, 128×128).
- The activity bar icon was redrawn to echo it — clock plus recurrence ring —
  as a monochrome SVG.

### Notes

- `favicon.ico` cannot be used directly. VS Code needs SVG for the activity bar
  and PNG ≥128×128 for the extension tile, and the source is a 48×48 BMP that is
  **fully opaque**. The activity bar masks icons into a flat silhouette, so an
  opaque square would render as a solid block — hence a matching SVG instead of
  the bitmap.

## [0.6.0-rc.2] - 2026-07-26

### Fixed

- The **Open Manager** toolbar icon used `$(window)`, which is not a codicon
  present in every VS Code build — an unknown name renders as blank space, so
  the button was there but invisible. Now `$(multiple-windows)`.

## [0.6.0-rc.1] - 2026-07-26

The plan manager. Still a candidate: the manager's own UI has not been driven by
hand, and the 0.5.0 steps in `docs/TEST-PLAN.md` remain outstanding. What *is*
confirmed is that the execution engine works — a real run completed on
2026-07-26 (2 turns, $0.26, no permission denials), which was the one genuinely
unproven layer.

### Added

- **Plan manager** — a full editor-tab webview (`Chronus: Open Manager`), with a
  plan library on the left and detail on the right. The sidebar stays as the
  compact status view; both read the same store, so there is one source of truth
  and two renderers.
- **Plan library** — a folder of `.md` files with create, rename, duplicate,
  delete, import and search. Deliberately no index or manifest: an index is a
  second source of truth that drifts from the filesystem the moment a file is
  edited outside Chronus. Configurable via `chronus.libraryPath`.
- **In-app Markdown editor** with autosave on blur and a 2s debounce, a dirty
  indicator, and **Open in editor** for anything longer than a tweak.
- **Status bar item** — the persistent launch surface. Shows the next run,
  spins while running, warns on missed tasks, and opens the manager on click.
- **First-run starter plan**, written only when the library is first created.
- Renaming a plan repoints any series scheduled against it, rather than
  stranding them on the old path.
- Deleting a scheduled plan asks whether to remove the schedule too.

### Notes

- **No schema change.** `TaskSeries.filePath` stays an absolute path, so plans
  outside the library keep working and appear under *External*. Nothing to
  migrate.
- `window.prompt()` is not implemented in Electron, so plan naming uses VS Code
  input boxes rather than a webview dialog.
- The webview does not set `retainContextWhenHidden`; a panel serializer
  restores the tab across reloads instead of holding it in memory.

## [0.5.0-rc.1] - 2026-07-26

Release candidate, not a release: everything below is typechecked and covered by
tests, but **no part of Chronus has yet been observed running end-to-end**. The
manual gates in `docs/COMPLETION-PLAN.md` Sprints 8 and 12 promote this to
0.5.0.

### Fixed

- **F5 works on a clean machine.** The launch task referenced `$esbuild-watch`,
  a problem matcher that ships in a third-party extension, so a machine without
  it failed with "error exists after running preLaunchTask" before the extension
  host ever started. `esbuild.js` now logs single-line, matcher-readable build
  state and `tasks.json` carries its own inline matcher — no extension needed.
- **Pausing a series now stops its queued retries.** The pending-run loop looked
  up the series but never checked `enabled`, so a retry queued before a pause
  still fired. "Run now" is the deliberate exception, marked by a new `manual`
  flag on `TaskRun`.
- **Bumping the schema no longer destroys stored state.** The store had a
  version *gate* — exact equality, everything else moved to a backup key and
  replaced with empty state — but no migration *path*. Added a real `migrate()`
  ladder that upgrades known versions and refuses only genuinely foreign shapes,
  including state written by a newer Chronus.
- `TaskSeries.enabled` no longer carries two meanings. A fired one-shot is now
  `spent`; `enabled` is the user's pause alone. Conflating them stranded a
  materialised run that had not yet found a concurrency slot — it would have
  been skipped forever.

### Added

- **`Chronus: Open Dashboard` command.** The activity-bar container is titled
  Chronus but the view inside it is named "Scheduled Tasks", so the panel was
  hard to find by name. VS Code's generated `<viewId>.focus` command exists but
  is listed under the view's name; this gives it an obvious entry.
- **Authentication failures are reported, not retried.** An expired token failed
  every task identically and burned three retries across three hours first.
  Detected via `api_error_status` or the result text, and only ever on a run
  that actually failed — a healthy run that merely *mentions* a 401 is not one.
- **`claude` is probed at activation**, asynchronously so it never delays
  startup. A bad `chronus.claudePath` now surfaces as a sticky panel banner
  instead of a failed run at 2am.
- **Live elapsed time on running rows**, computed in the webview from
  `startedAt` rather than pushed per-second from the extension.
- **Cancel button** for a running task. `Runner.cancel()` already existed; the
  only way to reach it was closing the terminal tab.
- **Queued group** showing pending runs with a countdown and `retry N/max`, so a
  waiting retry — or a run stranded by the concurrency gate — is visible.
- Spent one-shots leave the Scheduled group rather than lingering as a card
  offering to pause something that will never fire again.

### Changed

- Scheduler split into a pure decision function (`decide.ts`) and an applier.
  `buildArgs` and pre-flight moved to `launch.ts`; the watchdog rules to
  `watchdogVerdict()`. All are `vscode`-free and on the `tsconfig.test.json`
  allowlist. `scheduler.ts` is 205 lines, down from 280.
- Tests: **93, up from 36** — including the eleven cases owed since the
  recurrence amendment, which were unwritable while the logic imported `vscode`.

### Notes

- The auth-detection patterns are inferred, not observed. Sprint 12 forces one
  real auth failure to correct them.

### Added — developer tooling

- `docs/TEST-PLAN.md` — the ten manual steps that unit tests structurally cannot
  reach: process spawning, drag-and-drop, real editor restarts, theme rendering.
- `.sandbox/` — a throwaway working directory the Extension Development Host
  opens at launch, so smoke runs have somewhere safe to write.
- A second launch config, **Run Chronus (no build)**, for when the task layer
  misbehaves.

### Added — documentation

- `docs/PLAN.md` — the original implementation plan and its two amendments,
  recovered from the design session and kept as a record of intent. Excluded
  from the packaged extension.
- `docs/COMPLETION-PLAN.md` — Sprints 8–12 to reach 0.5.0, written against the
  audited state of 0.4.0.
- `docs/GUI-PLAN.md` — Sprints 13–18 for the editor-tab manager and plan
  library, targeting 0.6.0. Gated on 0.5.0 passing its smoke test first.

## [0.4.0] - 2026-07-26

### Added

- **Sidebar dashboard**: drag-and-drop of `.md` files (handling both
  `application/vnd.code.uri-list` from the VS Code explorer and OS-level drops),
  with an always-available browse fallback. Datetime picker, quick chips,
  recurrence controls, and an Options disclosure for working directory,
  permission mode and model. Groups render only when they have content.
- **Execution engine**: spawns `claude -p --output-format stream-json --verbose`,
  mirroring live progress into a `Pseudoterminal` tab and the run transcript.
  The plan travels on stdin. Concurrency gate, pre-flight file and cwd checks.
- **Watchdogs** for idle and total runtime, compared against wall-clock
  timestamps rather than timers — Windows suspends timers during sleep and fires
  them on resume, which would otherwise kill a task that had just woken.
- **Scheduler**: 30-second tick with drift-based sleep detection, a three-way
  due / within-grace / missed split, and startup reconciliation of runs orphaned
  by a mid-flight shutdown.
- **Recurrence**: daily and weekly rules, with catch-up collapsing an outage into
  a single decision rather than one notification per missed occurrence.
- **Retry**: failed runs requeue after one hour up to `maxRetries`. Failures that
  retrying cannot fix — deleted plan file, missing working directory,
  cancellation — are not retried.
- **Permission denial reporting**: a run can exit 0 with tools blocked. Chronus
  surfaces this as a badge and a warning instead of a silent success, and does
  not retry it.
- Run transcripts with configurable retention, rolling 7-day cost footer, and a
  README covering the unattended-execution risks.
- 36 unit tests over the pure result and recurrence logic, including both DST
  transition directions.

### Notes

- `--allow-dangerously-skip-permissions` is passed automatically when a task
  selects `bypassPermissions`, since that flag makes the capability available
  rather than applying it. This pairing follows the CLI's documented semantics
  and has not been exercised end-to-end.

## [0.2.0] - 2026-07-26

### Added

- Data model separating `TaskSeries` (the definition you create) from `TaskRun`
  (one execution attempt). Keeps per-run history intact when a recurring series
  fires repeatedly.
- `Recurrence` stored as local wall-clock time (`daysOfWeek` + `timeLocal`) so a
  rule like "weekdays at 09:00" holds across DST boundaries. Concrete UTC
  instants are derived from it, never incremented.
- `Store` over `globalState`: write-through CRUD for both collections, an
  `onDidChange` event, and finished-run history capped at 50.
- Unrecognised stored state is preserved under a backup key rather than dropped.
- `chronus.addFiles` now creates a real series, defaulting to one hour out
  rounded to the next quarter hour, with `cwd` resolved to the workspace folder
  containing the plan file.

### Notes

- Schema starts at version 1. Earlier "v2/v3" numbering tracked plan revisions,
  not shipped schemas; the migration hook is in place for real future changes.

### Added

- Project skeleton: TypeScript (strict), esbuild bundling, zero runtime dependencies.
- Extension manifest with a Chronus activity bar container and `chronus.dashboard` webview view.
- Commands: `chronus.addFiles`, `chronus.showLogs`.
- Settings: `claudePath`, `maxConcurrent`, `maxRetries`, `retryDelayMinutes`,
  `graceWindowMinutes`, `idleTimeoutMinutes`, `maxRuntimeMinutes`, `logRetentionDays`.
- Placeholder dashboard panel confirming the extension host loads.
