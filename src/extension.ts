import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { adoptGlobal, claimAdoption } from './adopt';
import { AGENTS } from './agents';
import { consolidate } from './consolidate';
import { DashboardExporter } from './dashboard-export';
import { seedLibrary } from './library';
import { initLog, log, logConsolidation, logRetirement, pruneLogs } from './log';
import { Manager } from './manager';
import { MCP_CLIENTS } from './mcp-clients';
import { migrate } from './migrate';
import { sweepQuestions } from './questions';
import { retireCompletedPlans } from './retire';
import { ChronosPaths, ensureRoot, pathsFor, sweepPending } from './roots';
import { probeAgent, Runner } from './runner';
import { Scheduler } from './scheduler';
import { writeState } from './state-file';
import { StatusItem } from './status';
import { Store } from './store';
import { TaskView } from './tasks';
import { STORE_KEY } from './types';

/** Which folder this window is showing. See `activeFolder` below. */
const ACTIVE_FOLDER_KEY = 'chronos.activeFolder';
/** Set once the old machine-wide dataset has been moved into a folder. */
const ADOPTED_KEY = 'chronos.adoptedInto';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLog(context);
  log.info(`Chronos ${context.extension.packageJSON.version} activating`);

  let active = activeFolder(context);
  const paths = (): ChronosPaths =>
    resolvePaths(active ?? context.globalStorageUri.fsPath);

  const fresh = ensureRoot(paths());
  if (fresh) {
    log.info(`created ${paths().root}`);
  }
  // Only into a real folder. With no folder open there is nothing folder-
  // specific to adopt into, and claiming the data for the fallback root would
  // strand it somewhere the user's actual projects never look.
  if (active) {
    adoptOnce(context, paths());
  }
  seedIfNew(paths(), fresh);

  const store = await Store.create(paths().state);
  const runner = new Runner(store, () => paths().logs, () => paths().results);
  // Picks up schedules written by anything that is not this window — the MCP
  // server an agent spawned, or a second editor window on the same folder.
  const stateWatcher = new StateWatcher(paths, store);

  /** A one-shot that has run has no future, so its file leaves the library.
   *  Re-read first: this moves files from what the schedule says, and a repeat
   *  rule set in a second window on this folder has not reached this window's
   *  copy — a file move is not covered by the read-modify-write that protects
   *  every field write, so nothing would catch the mistake. */
  const retire = async (): Promise<void> => {
    store.reload();
    logRetirement(await retireCompletedPlans(store, paths().plans, paths().archivedPlans));
  };

  const scheduler = new Scheduler(store, runner, () => paths().lock, retire);

  // This window's status, written to a shared directory under the user's home
  // so a browser can show every window at once. Read-only and one-way: nothing
  // outside this process can reach the schedule through it. See
  // `dashboard-export.ts`.
  const dashboard = new DashboardExporter(store, scheduler, paths);

  /**
   * Staging folders left by planning sessions that ended with the window rather
   * than with their terminal. `roots.ts` cannot reach the log channel, so it
   * reports rather than logs and the writing happens here.
   *
   * A kept folder is a `warn`: it holds a generated plan that never reached the
   * library, and its path is the only thing that will lead the user back to it.
   */
  const sweep = (): void => {
    const report = sweepPending(paths().pending);
    if (report.removed > 0) {
      log.info(`removed ${report.removed} abandoned plan staging folder(s)`);
    }
    for (const dir of report.kept) {
      log.warn(`kept ${dir} — it still holds a generated plan that never reached the library`);
    }

    // Questions from sessions that ended mid-conversation. Nothing will ever
    // come back for these: the session that was waiting on the answer is gone.
    const questions = sweepQuestions(paths().questions);
    if (questions > 0) {
      log.info(`removed ${questions} stale planning question(s)`);
    }
  };

  pruneLogs(paths().logs, config().get<number>('logRetentionDays', 30));
  sweep();

  // Plans scheduled in place by an older version are copied in here, so the rest
  // of the session can assume every scheduled plan is a library plan. The sweep
  // that follows is what tidies plans already run by a build that kept them.
  logConsolidation(await consolidate(store, paths().plans, paths().archivedPlans));
  await retire();

  /**
   * Moves this window to another folder in the workspace. Everything downstream
   * reads a path thunk or the store, so the move is: release the old folder's
   * lock, remember the choice, and re-point the store.
   */
  const switchFolder = async (folder: string): Promise<void> => {
    if (folder === active) {
      return;
    }
    if (!(vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.fsPath === folder)) {
      log.warn(`refused to switch to ${folder} — not a folder in this workspace`);
      return;
    }
    // A run holds a child process, a pseudoterminal and a half-written
    // transcript, all belonging to the folder being left. Cancelling somebody's
    // overnight job to change a dropdown is not a trade worth making silently.
    if (runner.activeCount > 0) {
      void vscode.window.showWarningMessage(
        `Chronos is running ${runner.activeCount} task${runner.activeCount > 1 ? 's' : ''}. ` +
          'Wait for it to finish, or cancel it, before switching folder.'
      );
      manager.post();
      return;
    }

    scheduler.releaseNow();
    active = folder;
    await context.workspaceState.update(ACTIVE_FOLDER_KEY, folder);

    seedIfNew(paths(), ensureRoot(paths()));
    await store.retarget(paths().state);
    pruneLogs(paths().logs, config().get<number>('logRetentionDays', 30));
    // Switching folder changes which `.pending` is in play.
    sweep();
    logConsolidation(await consolidate(store, paths().plans, paths().archivedPlans));
    await retire();

    manager.restartWatching();
    stateWatcher.restart();
    manager.post();
    // Explicitly, rather than leaning on the store change `retarget` fires: the
    // folder name, library path and results path in the heartbeat all move with
    // this switch, and none of them is something the store reports.
    dashboard.refresh();
    await scheduler.reclaim();
    log.info(`switched to ${folder}`);
  };

  // The manifest's own configuration schema, which is what the manager's
  // Settings page is generated from — one source of truth for every setting's
  // type, default, range and help text.
  const manager = new Manager(
    context.extensionUri,
    store,
    scheduler,
    paths,
    switchFolder,
    context.extension.packageJSON.contributes.configuration.properties
  );
  const status = new StatusItem(store);

  // A webview rather than a tree: a to-do list needs an always-there text field,
  // in-body buttons and coloured rows, none of which the TreeView API can draw.
  // The view opens the manager itself, since resolving is the only signal an
  // activity-bar click produces.
  const taskView = new TaskView(context.extensionUri, paths, store, scheduler, manager);

  stateWatcher.restart();

  // Re-pointed at this install every activation, so configs already registered
  // in other clients keep working across an update. See `mcpLauncherPath`.
  const mcpLauncher = mcpLauncherPath(context);

  context.subscriptions.push(
    // First, so its closing heartbeat is written while the store and the
    // scheduler are still answering.
    dashboard,
    store,
    runner,
    scheduler,
    manager,
    status,
    taskView,
    stateWatcher,
    vscode.window.registerWebviewViewProvider(TaskView.viewType, taskView),
    vscode.window.registerWebviewPanelSerializer(Manager.viewType, {
      // Restores the tab after a window reload instead of holding it in memory.
      async deserializeWebviewPanel(restored: vscode.WebviewPanel) {
        manager.restore(restored);
      }
    }),
    // A folder removed from the workspace must not go on receiving writes.
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const resolved = activeFolder(context);
      if (resolved && resolved !== active) {
        void switchFolder(resolved);
      }
    }),
    vscode.commands.registerCommand('chronos.openManager', () => manager.open()),
    vscode.commands.registerCommand('chronos.selectFolder', () => selectFolder(switchFolder)),
    vscode.commands.registerCommand('chronos.addFiles', () => addFiles(manager)),
    vscode.commands.registerCommand(
      'chronos.scheduleFile',
      async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        // `explorer/context` passes (clicked, whole selection), but
        // `editor/title/context` passes a menu group reference as the second
        // argument — so filter it rather than trusting its shape.
        const picked = (Array.isArray(uris) ? uris : []).filter((u) => u instanceof vscode.Uri);
        const paths = (picked.length ? picked : uri ? [uri] : []).map((u) => u.fsPath);
        if (!paths.length) {
          return addFiles(manager);
        }
        manager.open();
        await manager.addPaths(paths);
      }
    ),
    vscode.commands.registerCommand('chronos.showLogs', () => log.show()),
    vscode.commands.registerCommand('chronos.addTask', () => taskView.addTask()),
    vscode.commands.registerCommand('chronos.generatePlanRemote', () =>
      taskView.generatePlanRemotely()
    ),
    vscode.commands.registerCommand('chronos.copyMcpConfig', () =>
      copyMcpConfig(mcpLauncher, paths().folder)
    )
  );

  await scheduler.start();
  // After the scheduler, so the first heartbeat already knows whether this
  // window is the one holding the schedule.
  dashboard.start();

  // Not awaited: activation must not wait on a child process. A bad path should
  // surface here rather than at fire time.
  //
  // The same probe decides what the manager's Engine dropdown offers, so it
  // only ever lists engines this machine actually answered on. Claude is the
  // exception: it stays listed even when broken, because it is the default and
  // a missing one is a setup problem to fix rather than a choice to withdraw.
  void Promise.all(
    AGENTS.map((agent) => probeAgent(agent).then((problem) => ({ agent, problem })))
  ).then((probes) => {
    for (const { agent, problem } of probes) {
      if (!problem) {
        continue;
      }
      if (agent.id === 'claude') {
        log.error(`claude pre-flight failed — ${problem}`);
        manager.setSetupProblem(problem);
      } else {
        log.info(`${agent.id} is not available, so it is not offered — ${problem}`);
      }
    }

    manager.setAvailableAgents(
      probes.filter((p) => !p.problem || p.agent.id === 'claude').map((p) => p.agent.id)
    );
  });

  log.info(`Chronos activated on ${paths().folder}`);
}

export function deactivate(): void {
  log.info('Chronos deactivating');
}

///////////////////////////*Schedules written from outside*////////////////////////////

/**
 * Reloads the store when `state.json` changes underneath this window.
 *
 * The store only re-read on its own writes, which was enough while every writer
 * was an editor window with its own scheduler. The MCP server is not: an agent
 * schedules a task and the process exits, so without this the series would sit
 * on disk unfired until someone reloaded the window. A second editor window on
 * the same folder gets the same benefit for free.
 *
 * The watch is on the `.chronos` **directory**, filtered to the file — not on
 * the file itself. `writeState` writes a temp file and renames it over the
 * target, which replaces the inode and leaves a file-level watch pointed at
 * something nothing will ever write to again. `Manager.restartWatching` watches
 * its plans directory the same way, debounce included.
 *
 * Reloading is a read, so it cannot re-trigger this watcher — a plain debounce
 * is enough, and no window suppressing this window's own writes is needed.
 */
class StateWatcher implements vscode.Disposable {
  private watcher: fs.FSWatcher | undefined;
  private debounce: NodeJS.Timeout | undefined;

  constructor(
    private readonly paths: () => ChronosPaths,
    private readonly store: Store
  ) {}

  restart(): void {
    this.stop();
    const resolved = this.paths();
    const stateFile = path.basename(resolved.state);

    try {
      this.watcher = fs.watch(resolved.root, (_event, filename) => {
        if (filename && path.basename(String(filename)) !== stateFile) {
          return; // The same directory holds the lock, the logs and the plans.
        }
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.store.reload(), 150);
      });
    } catch (err) {
      log.warn(`could not watch the schedule file: ${String(err)}`);
    }
  }

  dispose(): void {
    this.stop();
  }

  private stop(): void {
    clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = undefined;
  }
}

/**
 * The path a client config points at — one that survives an update.
 *
 * `extensionUri` names the *versioned* install folder, so a config written
 * against it breaks silently the next time Chronos updates: the client goes on
 * spawning a file that is no longer there, and the only symptom is tools that
 * quietly stop appearing. `globalStorageUri` is keyed by publisher and extension
 * id rather than by version, so it is the one path that does not move.
 *
 * What is written there is a shim that `require`s the real bundle of whichever
 * install is currently running — requiring it *is* starting the server, since
 * the bundle serves on load. It is rewritten on every activation, which is what
 * re-points it after an update, and only when the content actually differs, so
 * ordinary start-up does not churn the disk.
 *
 * If the write fails, the real path is returned instead: the command degrades to
 * what it did before this existed rather than stopping working.
 */
function mcpLauncherPath(context: vscode.ExtensionContext): string {
  const real = vscode.Uri.joinPath(context.extensionUri, 'dist', 'mcp-server.js').fsPath;
  const dir = context.globalStorageUri.fsPath;
  const launcher = path.join(dir, 'mcp-server.js');

  // stderr, never stdout: stdout is the JSON-RPC transport, and one line on it
  // corrupts the handshake. A client connecting after Chronos was uninstalled
  // should be told so and see the process end, rather than hang.
  const shim =
    `const target = ${JSON.stringify(real)};\n` +
    'if (!require(\'fs\').existsSync(target)) {\n' +
    '  process.stderr.write(`[chronos-mcp] ${target} is missing — Chronos was moved or ' +
    'uninstalled. Re-run "Chronos: Copy MCP Server Config..." from VS Code.\\n`);\n' +
    '  process.exit(1);\n' +
    '}\n' +
    'require(target);\n';

  try {
    fs.mkdirSync(dir, { recursive: true });
    if (readIfPresent(launcher) !== shim) {
      fs.writeFileSync(launcher, shim, 'utf8');
      log.info(`pointed the MCP launcher at ${real}`);
    }
    return launcher;
  } catch (err) {
    log.warn(`could not write the MCP launcher, using the versioned path instead: ${String(err)}`);
    return real;
  }
}

/** A file that is not there yet is not an error here — it just needs writing. */
function readIfPresent(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Puts a ready-to-paste MCP client entry on the clipboard.
 *
 * The shapes clients want differ enough that one snippet cannot serve them all,
 * so this asks which client first and copies that client's own format. `where`
 * is the whole answer to "and now what do I do with it", so it is both the
 * detail line in the picker and the first thing said afterwards.
 */
async function copyMcpConfig(serverPath: string, folder: string): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    MCP_CLIENTS.map((client) => ({ label: client.label, detail: client.where, client })),
    { placeHolder: 'Which client are you registering Chronos with?' }
  );
  if (!picked) {
    return; // Cancelled. Nothing copied, so the clipboard is left as it was.
  }

  const { client } = picked;
  await vscode.env.clipboard.writeText(client.config(serverPath, folder));

  const said = [
    `Copied the Chronos MCP config for ${path.basename(folder)}. Paste it into ${client.where}.`
  ];
  if (client.cli) {
    said.push(`Or run: ${client.cli(serverPath, folder)}`);
  }
  if (client.note) {
    said.push(client.note);
  }
  void vscode.window.showInformationMessage(said.join(' '));
}

/**
 * The folder this window operates in. Chronos data is per-folder, so this is
 * the single decision every path below hangs off.
 *
 * One folder is active at a time rather than all of them at once: a second
 * active folder means a second scheduler, a second concurrency budget and a
 * merged list that has to say which folder every row came from — a lot of
 * machinery for a case that is rare, when a dropdown covers it.
 *
 * A remembered choice is only honoured while that folder is still in the
 * workspace; otherwise the first folder wins.
 */
function activeFolder(context: vscode.ExtensionContext): string | undefined {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const remembered = context.workspaceState.get<string>(ACTIVE_FOLDER_KEY);

  if (remembered && folders.includes(remembered)) {
    return remembered;
  }
  return folders[0];
}

/**
 * Where this window's data lives. With no folder open there is nothing to be
 * specific to, so Chronos falls back to a `.chronos` root inside its own
 * extension storage and goes on working.
 *
 * `chronos.libraryPath` and `chronos.resultsPath` still override their part of
 * the layout, which is what makes the change safe for anyone already using
 * them. Set in *workspace* settings they keep a folder's data folder-specific;
 * set in user settings they deliberately put every folder back in one place.
 */
function resolvePaths(folder: string): ChronosPaths {
  const paths = pathsFor(folder);
  const library = config().get<string>('libraryPath', '').trim();
  const results = config().get<string>('resultsPath', '').trim();

  return {
    ...paths,
    plans: library || paths.plans,
    results: results || paths.results
  };
}

/**
 * The old machine-wide dataset, moved wholesale into the first folder opened
 * after the upgrade.
 *
 * Splitting it by folder automatically would be guesswork — a plan file says
 * nothing about which repository it belongs to — so it all lands in one place
 * and the user moves plans on from there. Runs once ever, and copies rather than
 * moves: the old storage is left intact.
 *
 * Two gates, because there are two ways to run twice. The flag in global state
 * covers the ordinary case of this window activating again, and answers without
 * touching the disk. The marker file covers the case the flag cannot see: a
 * second window activating on the new build at the same moment, before the flag
 * it writes has reached anyone else.
 */
function adoptOnce(context: vscode.ExtensionContext, next: ChronosPaths): void {
  if (context.globalState.get<string>(ADOPTED_KEY) || fs.existsSync(next.state)) {
    return;
  }

  const legacyLibrary =
    config().get<string>('libraryPath', '').trim() ||
    path.join(context.globalStorageUri.fsPath, 'plans');

  const legacy = {
    plans: legacyLibrary,
    tasks: path.join(legacyLibrary, 'tasks'),
    results:
      config().get<string>('resultsPath', '').trim() || path.join(legacyLibrary, 'results')
  };

  // Through the ladder first: the old key may hold a v1 or v2 shape, and an
  // unrecognisable one is better left where it is than copied into a folder.
  const previous = migrate(context.globalState.get<unknown>(STORE_KEY));
  if (!fs.existsSync(legacy.plans) && !previous) {
    // Nothing to adopt — a fresh install. Flag it anyway, so a plan later
    // dropped into the old location is never hoovered up by surprise.
    void context.globalState.update(ADOPTED_KEY, next.folder);
    return;
  }

  // Staked before a single file is copied. Claiming it afterwards would leave
  // the whole copy inside the race it is meant to close.
  if (!claimAdoption(context.globalStorageUri.fsPath)) {
    log.info(
      'another window is adopting the previous machine-wide Chronos data — ' +
        'leaving it to that one, so it is not copied into two projects at once'
    );
    return;
  }

  const { state, report } = adoptGlobal(legacy, next, previous);
  writeState(next.state, state);
  void context.globalState.update(ADOPTED_KEY, next.folder);

  log.info(
    `adopted the previous machine-wide Chronos data into ${next.root}: ` +
      `${report.plans} plan(s), ${report.tasks} task(s), ${report.repointed} schedule(s), ` +
      `${report.runs} run(s)${report.results ? ', plus past transcripts' : ''}. ` +
      `The originals are untouched in ${legacyLibrary}.`
  );
}

/**
 * A first-run plan, so a folder new to Chronos opens with something to look at
 * and a safe thing to try.
 *
 * Only when the root was just created, never merely because the library is
 * empty: deleting the starter plan must not bring it back on the next reload.
 * The emptiness check on top of that is for the folder that just adopted the
 * old machine-wide library — it has plans already, and does not need a
 * thirteenth one explaining what a plan is.
 */
function seedIfNew(paths: ChronosPaths, rootWasCreated: boolean): void {
  if (!rootWasCreated) {
    return;
  }
  try {
    if (fs.readdirSync(paths.plans).length === 0) {
      seedLibrary(paths.plans);
      log.info(`seeded ${paths.plans} with a starter plan`);
    }
  } catch (err) {
    log.warn(`could not seed the plan library: ${String(err)}`);
  }
}

/** The command-palette route to the manager's folder dropdown. */
async function selectFolder(switchFolder: (folder: string) => Promise<void>): Promise<void> {
  const picked = await vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Which folder should Chronos show?'
  });
  if (picked) {
    await switchFolder(picked.uri.fsPath);
  }
}

/** Guaranteed path to adding files, independent of drag-and-drop. */
async function addFiles(manager: Manager): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: 'Schedule',
    filters: { Markdown: ['md'] }
  });

  if (picked?.length) {
    await manager.addPaths(picked.map((u) => u.fsPath));
    manager.open();
  }
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('chronos');
}
