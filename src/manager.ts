import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildActivity } from './activity';
import { AGENTS, DEFAULT_AGENT } from './agents';
import { chainPatches } from './chain';
import { consolidate } from './consolidate';
import { seriesEdit } from './edit';
import * as library from './library';
import { log, logConsolidation } from './log';
import { ChronosPaths } from './roots';
import { Scheduler } from './scheduler';
import { createSeries, SeriesDefaults } from './series';
import { coerceSetting, SettingGroup, settingGroups } from './settings';
import { Store } from './store';
import { AgentId, MAX_CHAIN_DELAY_MINUTES, TaskSeries } from './types';

/** Messages the webview may send. Anything else is logged and ignored. */
type Inbound =
  | { type: 'ready' }
  | { type: 'drop'; items: string[] }
  | { type: 'dropText'; files: { name: string; text: string }[] }
  | { type: 'createPlan' }
  | { type: 'renamePlan'; name: string }
  | { type: 'archivePlan'; name: string }
  | { type: 'loadPlan'; name: string }
  | { type: 'savePlan'; name: string; text: string }
  | { type: 'openInEditor'; name: string }
  | { type: 'importPlan' }
  | { type: 'revealLibrary' }
  | { type: 'schedulePlan'; name: string; nextRunAt?: string }
  | {
      type: 'chainPlans';
      names: string[];
      startIso: string;
      gapMinutes: number;
      stopOnFailure: boolean;
    }
  | { type: 'updateSeries'; id: string; patch: Partial<TaskSeries> }
  | { type: 'browseCwd'; id: string }
  | { type: 'runNow'; seriesId: string; dismissRunId?: string }
  | { type: 'rerunRun'; id: string }
  | { type: 'cancelRun'; id: string }
  | { type: 'dismissRun'; id: string }
  | { type: 'openResult'; id: string }
  | { type: 'revealResults' }
  | { type: 'revealArchive' }
  | { type: 'openLog'; id: string }
  | { type: 'switchFolder'; folder: string }
  | { type: 'updateSetting'; key: string; value: unknown }
  | { type: 'openNativeSettings' };

/**
 * The plan manager: a single editor-tab webview. Deliberately one panel reused
 * rather than one per invocation — every extra surface is another renderer to
 * keep in memory and in sync.
 *
 * `retainContextWhenHidden` is *not* set. It is the easy option and it holds the
 * whole view in memory for the session; the serializer below restores the tab
 * across reloads instead, and re-rendering a list this size is free.
 */
export class Manager implements vscode.Disposable {
  static readonly viewType = 'chronos.manager';

  private panel: vscode.WebviewPanel | undefined;
  private watcher: fs.FSWatcher | undefined;
  private watchDebounce: NodeJS.Timeout | undefined;
  private readonly storeListener: vscode.Disposable;
  private readonly leadershipListener: vscode.Disposable;
  private readonly configListener: vscode.Disposable;
  /** The Settings page, built once: a schema cannot change at runtime. */
  private readonly settingGroups: SettingGroup[];
  /** Sticky, unlike a notice: a broken `claudePath` stays broken until fixed. */
  private setupProblem: string | undefined;
  /** Engines that answered `--version`. Optimistic until the probes land, so
   *  the dropdown is never briefly empty. */
  private availableAgents: AgentId[] = [DEFAULT_AGENT];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: Store,
    private readonly scheduler: Scheduler,
    /** The active folder's layout. A thunk, so a folder switch needs no rebuild. */
    private readonly paths: () => ChronosPaths,
    /** Owned by `activate`, which is the only place that can move the store, the
     *  scheduler's lock and this panel together. */
    private readonly switchFolder: (folder: string) => Promise<void>,
    /** `contributes.configuration.properties`, straight from the manifest. The
     *  Settings page is generated from it rather than from a second table, so a
     *  setting cannot exist without a control. */
    configProperties: Record<string, unknown>
  ) {
    this.settingGroups = settingGroups(configProperties);
    this.storeListener = store.onDidChange(() => this.post());
    // A non-leading window's store never changes, so the banner below would
    // otherwise never appear or clear.
    this.leadershipListener = scheduler.onDidChangeLeadership(() => this.post());
    // Both directions: this is what keeps the Settings page in step with an edit
    // made in VS Code's own Settings editor, and what redraws a control after
    // the page's own write lands.
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('chronos')) {
        return;
      }
      // The watcher is bound to a folder that this one setting moves. Nothing
      // else needs invalidating: every module reads config live, and `paths()`
      // is a thunk that re-resolves on each call.
      if (e.affectsConfiguration('chronos.libraryPath')) {
        this.restartWatching();
      }
      this.post();
    });
  }

  dispose(): void {
    this.storeListener.dispose();
    this.leadershipListener.dispose();
    this.configListener.dispose();
    this.stopWatching();
    this.panel?.dispose();
  }

  /**
   * Opens the manager, or reveals the tab that is already open. `preserveFocus`
   * is for callers the user did not aim at the manager — the activity-bar icon,
   * which reveals the Tasks view and this tab from one click.
   */
  open(preserveFocus = false): void {
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active, preserveFocus);
      // Rebuilt from the folder here rather than left to the watcher. A plan
      // adopted from a planning session lands while this tab is already open,
      // and `fs.watch` is not a guarantee — it misses events on Windows, and it
      // is not running at all if the library folder could not be watched. The
      // plan file was then in the library with no row for it, and `reveal()`
      // below selected a plan the panel had never heard of. One directory read
      // on a tab the user just asked for is not worth being clever about.
      this.post();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      Manager.viewType,
      'Chronos',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus },
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] }
    );
    this.adopt(panel);
  }

  /**
   * Selects a plan in the library list. Public because the task view calls it
   * once a generated plan lands, so the pipeline ends where scheduling starts
   * rather than leaving you to find the new file yourself.
   */
  reveal(name: string): void {
    this.select(name);
  }

  /** Survives the panel not being open yet — `post()` replays it on reveal. */
  setSetupProblem(text: string): void {
    this.setupProblem = text;
    this.post();
  }

  /** What the Engine dropdown may offer. Set once the probes in `activate` land. */
  setAvailableAgents(ids: AgentId[]): void {
    this.availableAgents = ids;
    this.post();
  }

  /**
   * Copies Markdown files from any source into the library and schedules the
   * copies. Every route in — right-click, a drop on the activity-bar view, the
   * file picker — lands here, so no schedule can point outside the library and
   * the user's own file is never edited or moved by Chronos.
   */
  async addPaths(filePaths: string[]): Promise<void> {
    const dir = this.paths().plans;
    const markdown = filePaths.filter((p) => path.extname(p).toLowerCase() === '.md');
    const rejected = filePaths.length - markdown.length;
    const scheduled: string[] = [];

    for (const filePath of markdown) {
      const plan = library.importFile(dir, filePath);
      // `defaultCwd` reads the *original* path on purpose: it picks the workspace
      // folder containing the file, which is not necessarily the folder whose
      // library the copy lands in. A plan dropped in from another project keeps
      // running against that project.
      const series = createSeries(plan.filePath, seriesDefaults(filePath));
      await this.store.addSeries(series);
      log.info(`copied ${filePath} into the library as ${plan.name} and scheduled it (cwd ${series.cwd})`);
      scheduled.push(plan.title);
    }

    this.post();

    if (scheduled.length) {
      this.notify(
        `Copied ${scheduled.join(', ')} into your library and scheduled the copy — ` +
          'your original file is untouched, and editing it will not change what runs.'
      );
    }
    if (rejected > 0) {
      this.notify(`Ignored ${rejected} non-Markdown file${rejected > 1 ? 's' : ''}.`);
    }
  }

  /** Re-attaches to a panel VS Code restored after a window reload. */
  restore(panel: vscode.WebviewPanel): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    this.adopt(panel);
  }

  private adopt(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    // The tab icon is drawn as-is rather than masked, so the full-colour mark
    // survives here — unlike the activity bar, which flattens to a silhouette.
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
    panel.webview.html = this.render(panel.webview);

    panel.webview.onDidReceiveMessage((message: Inbound) => {
      this.handle(message).catch((err) => {
        log.error('manager message failed', err);
        this.notify(String(err instanceof Error ? err.message : err));
      });
    });

    panel.onDidDispose(() => {
      this.panel = undefined;
      this.stopWatching();
    });

    this.restartWatching();
  }

  // ---------- library watching ----------

  /**
   * Plans edited outside Chronos must not go stale in the manager. The webview
   * owns dirty state, so it decides whether to reload — this only reports that
   * something changed. One watcher covers every plan, because every plan lives
   * in this one folder.
   */
  restartWatching(): void {
    this.stopWatching();
    const dir = this.paths().plans;
    try {
      library.ensureLibrary(dir);
      this.watcher = fs.watch(dir, (_event, filename) => {
        clearTimeout(this.watchDebounce);
        this.watchDebounce = setTimeout(() => {
          // Deleting a plan file in a file manager mid-session leaves a schedule
          // pointing at nothing, which would fire and fail on time forever. One
          // `existsSync` per series on a debounced event is cheap enough to just
          // check every time rather than work out which file went.
          void this.dropSchedulesWithNoFile(dir).then(() => {
            this.post();
            if (filename && library.isPlanFile(String(filename))) {
              this.panel?.webview.postMessage({ type: 'planChanged', name: String(filename) });
            }
          });
        }, 150);
      });
    } catch (err) {
      log.warn(`could not watch plan library: ${String(err)}`);
    }
  }

  private async dropSchedulesWithNoFile(dir: string): Promise<void> {
    logConsolidation(await consolidate(this.store, dir, this.paths().archivedPlans));
  }

  private stopWatching(): void {
    clearTimeout(this.watchDebounce);
    this.watcher?.close();
    this.watcher = undefined;
  }

  // ---------- messages ----------

  private async handle(message: Inbound): Promise<void> {
    const dir = this.paths().plans;

    switch (message.type) {
      case 'ready':
        this.post();
        return;

      case 'drop':
        await this.addPaths(message.items.map(toFsPath));
        return;

      // A drop from the OS shell, which carries contents but no path — see the
      // drop handler in manager.js. The file is copied into the library and the
      // copy is what gets scheduled, so the notice says so rather than letting
      // the user assume their original is now on a schedule.
      case 'dropText': {
        const scheduled: string[] = [];
        // The webview already caps this, but it is the untrusted side of the
        // boundary — so the size and shape are checked again here, where it
        // counts. `createPlan` sanitises the name itself.
        const dropped = (Array.isArray(message.files) ? message.files : []).filter(
          (f) => f && typeof f.name === 'string' && typeof f.text === 'string' && f.text.length <= 1_000_000
        );
        for (const file of dropped) {
          const plan = library.createPlan(dir, path.basename(file.name, '.md'), file.text);
          await this.store.addSeries(createSeries(plan.filePath, seriesDefaults(plan.filePath)));
          log.info(`copied a dropped file into the library and scheduled ${plan.name}`);
          scheduled.push(plan.title);
        }
        this.post();
        if (scheduled.length) {
          this.notify(
            `Copied ${scheduled.join(', ')} into your library and scheduled the copy — ` +
              'a dropped file does not carry its location, so the original is untouched.'
          );
        }
        return;
      }

      // Electron does not implement window.prompt(), so naming happens here.
      case 'createPlan': {
        const title = await askForTitle('Name for the new plan', 'New plan');
        if (!title) {
          return;
        }
        const plan = library.createPlan(dir, title);
        this.post();
        this.select(plan.name);
        return;
      }

      case 'renamePlan': {
        const title = await askForTitle('New name for this plan', library.titleOf(message.name));
        if (!title) {
          return;
        }
        const before = path.join(dir, message.name);
        const plan = library.renamePlan(dir, message.name, title);
        await this.repointSeries(before, plan.filePath, plan.name);
        this.post();
        this.select(plan.name);
        return;
      }

      case 'archivePlan':
        return this.archivePlan(dir, message.name);

      case 'loadPlan':
        this.sendText(dir, message.name);
        return;

      case 'savePlan':
        library.writePlan(dir, message.name, message.text);
        return;

      case 'openInEditor': {
        // `planPath` rather than a path from the webview: a name is the only way
        // in, and it is checked here the same as on every read and write.
        const filePath = library.planPath(dir, message.name);
        if (!fs.existsSync(filePath)) {
          this.notify('That file no longer exists.');
          return;
        }
        await vscode.window.showTextDocument(vscode.Uri.file(filePath), {
          viewColumn: vscode.ViewColumn.Beside
        });
        return;
      }

      case 'importPlan': {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Copy into library',
          filters: { Markdown: ['md'] }
        });
        for (const uri of picked ?? []) {
          library.importFile(dir, uri.fsPath);
        }
        this.post();
        return;
      }

      case 'revealLibrary':
        fs.mkdirSync(dir, { recursive: true });
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
        return;

      case 'switchFolder':
        return this.switchFolder(message.folder);

      case 'schedulePlan': {
        const filePath = library.planPath(dir, message.name);
        const { patch, rejected } = message.nextRunAt
          ? seriesEdit({ nextRunAt: message.nextRunAt })
          : { patch: {}, rejected: [] };
        if (rejected.length) {
          log.warn(`schedulePlan: ignored ${rejected.join(', ')}`);
        }
        const series = createSeries(filePath, seriesDefaults(filePath), patch);
        await this.store.addSeries(series);
        log.info(`scheduled ${series.fileName} for ${series.nextRunAt}`);
        return;
      }

      case 'chainPlans':
        return this.chainPlans(dir, message);

      case 'updateSeries': {
        const { patch, rejected } = seriesEdit(message.patch);
        if (rejected.length) {
          log.warn(`updateSeries: ignored ${rejected.join(', ')}`);
        }
        if (!Object.keys(patch).length) {
          return;
        }
        return this.store.updateSeries(message.id, patch);
      }

      case 'browseCwd': {
        const series = this.store.getSeriesById(message.id);
        if (!series) {
          return;
        }
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Use as working directory',
          defaultUri: vscode.Uri.file(series.cwd)
        });
        if (picked?.length) {
          await this.store.updateSeries(message.id, { cwd: picked[0].fsPath });
        }
        return;
      }

      case 'runNow':
        if (!this.canRunHere()) {
          return;
        }
        if (message.dismissRunId) {
          await this.store.removeRun(message.dismissRunId);
        }
        return this.scheduler.runNow(message.seriesId);

      // No dismissRun here, unlike a missed run's Run now: the original run is
      // history and stays in the panel.
      case 'rerunRun': {
        const run = this.store.getRunById(message.id);
        const series = run ? this.store.getSeriesById(run.seriesId) : undefined;
        if (!series) {
          this.notify('That run belongs to a plan that is no longer scheduled.');
          return;
        }
        // Before the modal: asking the user to confirm something that is then
        // refused reads as a bug.
        if (!this.canRunHere()) {
          return;
        }
        // No run keeps a copy of the plan text it ran, so this is the plan as it
        // stands now — said out loud, because the button does not imply it.
        const choice = await vscode.window.showWarningMessage(
          `Run "${series.fileName}" again now?`,
          {
            modal: true,
            detail: 'Runs the plan as it stands now, not a copy of what ran before.'
          },
          'Run'
        );
        if (!choice) {
          return;
        }
        return this.scheduler.runNow(series.id);
      }

      case 'cancelRun':
        this.scheduler.cancelRun(message.id);
        return;

      case 'dismissRun':
        return this.store.removeRun(message.id);

      case 'openResult': {
        const run = this.store.getRunById(message.id);
        if (!run?.resultPath || !fs.existsSync(run.resultPath)) {
          this.notify('No transcript was recorded for that run.');
          return;
        }
        // Preview rather than source: the transcript is written to be read.
        await vscode.commands.executeCommand(
          'markdown.showPreview',
          vscode.Uri.file(run.resultPath)
        );
        return;
      }

      case 'revealResults': {
        const results = this.paths().results;
        fs.mkdirSync(results, { recursive: true });
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(results));
        return;
      }

      case 'revealArchive': {
        const archive = this.paths().archive;
        fs.mkdirSync(archive, { recursive: true });
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(archive));
        return;
      }

      case 'openLog': {
        const run = this.store.getRunById(message.id);
        if (!run?.logPath || !fs.existsSync(run.logPath)) {
          this.notify('No log recorded for that run.');
          return;
        }
        await vscode.window.showTextDocument(vscode.Uri.file(run.logPath), {
          viewColumn: vscode.ViewColumn.Beside
        });
        return;
      }

      // User scope, matching what the old model QuickPick wrote: these are
      // preferences about how you work, not facts about one project.
      case 'updateSetting': {
        const field = this.settingGroups
          .flatMap((group) => group.fields)
          .find((f) => f.key === message.key);
        if (!field) {
          log.warn(`updateSetting: no such setting ${message.key}`);
          return;
        }

        const value = coerceSetting(field, message.value);
        if (value === undefined) {
          // Re-posted rather than silently dropped, so the control snaps back to
          // what is actually stored instead of showing a value that never landed.
          log.warn(`updateSetting: refused ${message.key}=${JSON.stringify(message.value)}`);
          this.post();
          return;
        }

        // No post() on success: the configuration listener above does it, and
        // doing both would redraw the field twice under the user's cursor.
        await vscode.workspace
          .getConfiguration('chronos')
          .update(field.key, value, vscode.ConfigurationTarget.Global);
        return;
      }

      // The escape hatch this page deliberately does not cover: workspace scope,
      // and the JSON view.
      case 'openNativeSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:Z3n.chronos');
        return;

      default:
        log.warn(`unhandled manager message: ${JSON.stringify(message)}`);
    }
  }

  /**
   * Puts several plans in a row: the first starts at the time you picked, and
   * each of the rest is armed when the one before it finishes. See `chain.ts`
   * for the arming rule.
   *
   * A plan already on the schedule keeps its series — its working directory,
   * permissions and run history — and only its timing is rewritten. Minting a
   * second series against the same file would run the plan twice.
   */
  private async chainPlans(
    dir: string,
    message: Extract<Inbound, { type: 'chainPlans' }>
  ): Promise<void> {
    const names = (Array.isArray(message.names) ? message.names : []).filter(
      (n): n is string => typeof n === 'string'
    );
    const start = Date.parse(message.startIso);

    // The webview already enforces all of this; it is checked again here because
    // this is the side of the boundary where it counts.
    if (names.length < 2) {
      this.notify('A chain needs at least two plans.');
      return;
    }
    // One plan twice would link it to itself, and a plan waiting on itself waits
    // forever — a loop nothing announces, because nothing has failed.
    if (new Set(names).size !== names.length) {
      this.notify('A plan can only be in a chain once.');
      return;
    }
    if (Number.isNaN(start)) {
      this.notify('That start time is not a date.');
      return;
    }
    if (
      !Number.isInteger(message.gapMinutes) ||
      message.gapMinutes < 0 ||
      message.gapMinutes > MAX_CHAIN_DELAY_MINUTES
    ) {
      this.notify(`The gap between plans must be 0 to ${MAX_CHAIN_DELAY_MINUTES} minutes.`);
      return;
    }

    // Every plan gets its series first, so the links below can name real ids.
    const ids: string[] = [];
    for (const name of names) {
      const filePath = library.planPath(dir, name);
      if (!fs.existsSync(filePath)) {
        this.notify(`${library.titleOf(name)} is no longer in the library.`);
        return;
      }
      const existing = this.store
        .getSeries()
        .find((s) => library.samePath(s.filePath, filePath));
      if (existing) {
        ids.push(existing.id);
        continue;
      }
      const series = createSeries(filePath, seriesDefaults(filePath));
      await this.store.addSeries(series);
      ids.push(series.id);
    }

    for (const { id, patch } of chainPatches(
      ids,
      new Date(start).toISOString(),
      message.gapMinutes,
      message.stopOnFailure === true
    )) {
      await this.store.updateSeries(id, patch);
    }

    log.info(
      `chained ${names.length} plans from ${new Date(start).toISOString()}, ` +
        `${message.gapMinutes}m apart (${names.join(' → ')})`
    );
    this.post();
    this.notify(
      `Chained ${names.length} plans. ${library.titleOf(names[0])} starts it off; ` +
        `each plan after it runs ${message.gapMinutes} minute(s) after the one before finishes.`
    );
  }

  /**
   * Refuses, out loud, when another window is running this folder's schedule.
   * Shared by Run now and Re-run: a run queued here would land in this window's
   * copy of the state and never fire. See `Scheduler.runNow`.
   */
  private canRunHere(): boolean {
    if (this.scheduler.leading) {
      return true;
    }
    // Names the folder for the reason the banner in manager.js does: with
    // per-folder data this can only be a second window on this one folder.
    this.notify(
      `Another window is open on this same folder (${path.basename(this.paths().folder)}) ` +
        'and is running its schedule. Nothing will run from this window — use that ' +
        'window, or close it.'
    );
    return false;
  }

  /**
   * Still asks, because this sits on a hover-height button on a list row and the
   * plan disappears from the library either way. One button, not two: a plan
   * whose file leaves the folder loses its schedule regardless — the watcher
   * above runs `consolidate` a moment later, and that drops every series whose
   * file has gone — so offering to keep the schedule would be offering something
   * that does not survive the next tick.
   */
  private async archivePlan(dir: string, name: string): Promise<void> {
    const filePath = path.join(dir, name);
    const scheduled = this.store
      .getSeries()
      .filter((s) => library.samePath(s.filePath, filePath));

    const detail = 'The file moves to .chronos/archive. Bring it back with Import.';
    const choice = await vscode.window.showWarningMessage(
      scheduled.length > 0 ? `"${name}" is scheduled. Archive it?` : `Archive "${name}"?`,
      {
        modal: true,
        detail:
          scheduled.length > 0
            ? `${detail} Its schedule and run history are removed.`
            : detail
      },
      'Archive'
    );
    if (!choice) {
      return;
    }

    for (const series of scheduled) {
      await this.store.removeSeries(series.id);
    }

    library.archivePlan(dir, this.paths().archivedPlans, name);
    this.post();
    this.notify(`Archived ${library.titleOf(name)} to .chronos/archive/plans — Import brings it back.`);
  }

  /** A renamed plan must not strand the series pointing at its old path. */
  private async repointSeries(before: string, after: string, fileName: string): Promise<void> {
    for (const series of this.store.getSeries()) {
      if (library.samePath(series.filePath, before)) {
        await this.store.updateSeries(series.id, { filePath: after, fileName });
      }
    }
  }

  // ---------- outbound ----------

  private select(name: string): void {
    this.panel?.webview.postMessage({ type: 'select', name });
  }

  private notify(text: string): void {
    this.panel?.webview.postMessage({ type: 'notice', text });
  }

  private sendText(dir: string, name: string): void {
    try {
      const text = library.readPlan(dir, name);
      this.panel?.webview.postMessage({ type: 'planText', name, text });
    } catch (err) {
      this.notify(`Could not read ${name}: ${String(err)}`);
    }
  }

  /** Public because `activate` re-posts after a folder switch, which changes
   *  every list on the panel at once. */
  post(): void {
    if (!this.panel) {
      return;
    }

    const paths = this.paths();
    const dir = paths.plans;
    const config = vscode.workspace.getConfiguration('chronos');

    this.panel.webview.postMessage({
      type: 'state',
      libraryPath: dir,
      resultsPath: paths.results,
      // Which folder's plans, tasks and schedule these are, and what else could
      // be shown instead. One folder is active at a time — the dropdown only
      // appears when there is more than one to choose from.
      activeFolder: paths.folder,
      folders: (vscode.workspace.workspaceFolders ?? []).map((f) => ({
        path: f.uri.fsPath,
        name: f.name
      })),
      // One list, because there is one kind of plan: `consolidate` guarantees
      // every series points at a file in this folder.
      plans: library.listPlans(dir),
      series: this.store.getSeries(),
      runs: this.store.getRuns(),
      activity: buildActivity(this.store.getSeries(), this.store.getRuns(), Date.now()),
      // Sent rather than hard-coded in the webview: the task view's model picker
      // reads the same table, and two copies would drift the next time a model
      // ships. Only engines this machine answered on are included, so the
      // dropdown cannot offer something that would fail at fire time.
      agents: AGENTS.filter((agent) => this.availableAgents.includes(agent.id)),
      costLast7Days: this.store.costLast7Days(),
      // The Settings page: its shape, and what each control currently reads.
      // The shape is fixed, the values are not, so only the values are looked up
      // afresh each time.
      settings: this.settingGroups,
      settingValues: Object.fromEntries(
        this.settingGroups
          .flatMap((group) => group.fields)
          .map((field) => [field.key, config.get(field.key, field.default)])
      ),
      setupProblem: this.setupProblem,
      schedulerElsewhere: !this.scheduler.leading
    });
  }

  private render(webview: vscode.Webview): string {
    const mediaUri = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name)).toString();

    const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'manager.html').fsPath;

    return fs
      .readFileSync(htmlPath, 'utf8')
      .replaceAll('{{nonce}}', createNonce())
      .replaceAll('{{cspSource}}', webview.cspSource)
      .replaceAll('{{styleUri}}', mediaUri('manager.css'))
      .replaceAll('{{codiconUri}}', mediaUri('codicon.css'))
      .replaceAll('{{markUri}}', mediaUri('icon.png'))
      .replaceAll('{{scriptUri}}', mediaUri('manager.js'));
  }
}

/**
 * Working directory for the agent process. Prefers the workspace folder that
 * actually contains the plan file, since a plan may live outside the project it
 * targets.
 *
 * It lives here rather than in `series.ts` because it is the one genuinely
 * `vscode`-shaped decision in creating a series, and `series.ts` is loaded by
 * the MCP server process, which has no workspace to ask.
 */
export function defaultCwd(filePath: string): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return path.dirname(filePath);
  }
  const owner = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
  return (owner ?? folders[0]).uri.fsPath;
}

/**
 * The two defaults `createSeries` cannot work out for itself, read from the
 * editor. `series.ts` used to reach for `chronos.maxRetries` directly; it no
 * longer imports `vscode` at all, so the reading happens here.
 */
export function seriesDefaults(filePath: string): SeriesDefaults {
  return {
    cwd: defaultCwd(filePath),
    maxRetries: vscode.workspace.getConfiguration('chronos').get<number>('maxRetries', 3)
  };
}

/**
 * Drops arrive as file:// URIs from the VS Code explorer and as plain paths
 * from the OS shell. Parsing the URI form handles percent-encoding correctly.
 */
export function toFsPath(item: string): string {
  return item.startsWith('file:') ? vscode.Uri.parse(item).fsPath : item;
}

function askForTitle(prompt: string, value: string): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    value,
    validateInput: (input) =>
      input.trim() ? undefined : 'Give the plan a name.'
  });
}

/** Cryptographic, not `Math.random`: a nonce is the CSP's only guarantee that a
 *  `<script>` in this document came from us. Shared with the task view, which
 *  renders its own webview the same way. */
export function createNonce(): string {
  return randomBytes(24).toString('base64');
}
