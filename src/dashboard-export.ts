import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ABANDONED_MS,
  DashboardInstance,
  HEARTBEAT_MS,
  buildInstancePayload,
  instancesDir
} from './dashboard-payload';
import { log } from './log';
import { migrateHomeDir } from './migrate-name';
import { SynchronyPaths } from './roots';
import { Scheduler } from './scheduler';
import { settingGroups, SettingGroup } from './settings';
import { Store } from './store';
import { nowUtc } from './time';

/**
 * This window's status, on disk where a browser can read it.
 *
 * Four or five editor windows are four or five extension hosts that cannot see
 * each other, so "what is Synchrony doing right now" has no single answer inside
 * any one of them. Each window writes its own small JSON file into a shared
 * directory under the user's home, and `scripts/dashboard-server.js` reads the
 * lot. No IPC, no port per window, no process to keep alive: the filesystem is
 * the meeting point, which is the same thing `scheduler.lock` already relies on.
 *
 * Deliberately thin. It assembles facts and hands them to `buildInstancePayload`
 * — nothing about how the dashboard looks or behaves lives on this side.
 */
export class DashboardExporter implements vscode.Disposable {
  /**
   * Unique across windows, stable for this extension host's life. The pid makes
   * it readable in a directory listing; the random half covers a reused pid, so
   * a new window can never write over a file the dashboard is still reading as
   * somebody else's.
   */
  private readonly instanceId = `${process.pid}-${randomBytes(3).toString('hex')}`;
  private readonly startedAt = nowUtc();
  private readonly file = path.join(instancesDir(), `${this.instanceId}.json`);
  /** The Settings page's shape, built once like `Manager`'s copy: a schema
   *  cannot change at runtime, only the values read for it can. */
  private readonly settingGroups: SettingGroup[];

  private timer: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;

  constructor(
    private readonly store: Store,
    private readonly scheduler: Scheduler,
    /** Resolved per write: the active folder moves, and the payload names it. */
    private readonly paths: () => SynchronyPaths,
    /** `contributes.configuration.properties`, straight from the manifest —
     *  the same source `Manager`'s Settings page is generated from. */
    configProperties: Record<string, unknown>,
    /** Engines this machine answered `--version` on. A thunk because the probe
     *  in `extension.ts` runs after this exporter is constructed and can
     *  change what it reports as it lands. */
    private readonly availableAgents: () => string[]
  ) {
    this.settingGroups = settingGroups(configProperties);
  }

  /**
   * Begins exporting. A heartbeat on a timer answers "is this window still
   * there"; the two subscriptions are what make the board react rather than
   * lag a quarter of a minute behind every schedule change.
   */
  start(): void {
    migrateHomeDir();
    sweepAbandoned();
    this.write('active');

    this.timer = setInterval(() => this.write('active'), HEARTBEAT_MS);
    this.subscriptions.push(
      this.store.onDidChange(() => this.refresh()),
      this.scheduler.onDidChangeLeadership(() => this.refresh()),
      // So a setting applied through `control.ts` — or typed into VS Code's
      // own Settings UI — shows up in the heartbeat within `refresh`'s debounce
      // rather than waiting out the next 15s tick.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('synchrony')) {
          this.refresh();
        }
      })
    );
  }

  /**
   * Rewrites the heartbeat soon. Debounced because one user action can be
   * several store writes in a row — starting a run touches the series and the
   * run record — and the board does not need to see each of them separately.
   */
  refresh(): void {
    if (this.disposed) {
      return;
    }
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.write('active'), 250);
  }

  /**
   * Best effort, and synchronous on purpose: `deactivate` does not wait, so a
   * closing heartbeat that went through a promise would usually lose the race
   * with the host exiting. A window killed outright writes nothing, which is
   * what the staleness rule is for.
   */
  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.write('stopped');
  }

  private write(status: 'active' | 'stopped'): void {
    const resolved = this.paths();
    const config = vscode.workspace.getConfiguration('synchrony');

    const payload = buildInstancePayload({
      instanceId: this.instanceId,
      processId: process.pid,
      startedAt: this.startedAt,
      nowMs: Date.now(),
      status,
      workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? resolved.folder,
      workspaceName: this.workspaceName(resolved.folder),
      activeFolder: resolved.folder,
      schedulerLeader: this.scheduler.leading,
      libraryPath: resolved.plans,
      resultsPath: resolved.results,
      costLast7Days: this.store.costLast7Days(),
      series: this.store.getSeries(),
      runs: this.store.getRuns(),
      settings: {
        groups: this.settingGroups,
        values: Object.fromEntries(
          this.settingGroups
            .flatMap((group) => group.fields)
            .map((field) => [field.key, config.get(field.key, field.default)])
        )
      },
      availableAgents: this.availableAgents()
    });

    try {
      writeInstanceFile(this.file, payload);
    } catch (err) {
      // The dashboard is a read-only convenience. A home directory that cannot
      // be written to is not a reason to interrupt somebody's schedule, so this
      // is logged once per failed write and never surfaced.
      log.warn(`could not write the dashboard heartbeat: ${String(err)}`);
    }
  }

  /** The name the editor shows for the folder, falling back to its basename. */
  private workspaceName(folder: string): string {
    const match = (vscode.workspace.workspaceFolders ?? []).find((f) => f.uri.fsPath === folder);
    return match?.name || path.basename(folder) || folder;
  }
}

/**
 * Writes through a temp file and a rename, for the reason `writeState` does: a
 * rename is atomic on NTFS and ext4, so the dashboard reads either the previous
 * heartbeat or the new one and never a half-written document that parses as
 * nothing. The temp name carries the instance id, so two windows writing at the
 * same moment cannot interleave into one file.
 */
function writeInstanceFile(file: string, payload: DashboardInstance): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(payload), 'utf8');
  fs.renameSync(temp, file);
}

/**
 * Removes heartbeats nothing will ever write again.
 *
 * A window that crashes or is killed leaves its file behind, and the instance
 * id is new every time an extension host starts — so without this the directory
 * gains a file per window opened, forever. The dashboard itself never deletes
 * anything: it marks old heartbeats stale and shows them. This runs on the
 * writing side, only against files a full day past their last heartbeat, which
 * is far beyond any window that is merely busy or suspended.
 */
function sweepAbandoned(): void {
  const dir = instancesDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // Nothing has exported on this machine yet.
  }

  const cutoff = Date.now() - ABANDONED_MS;
  let removed = 0;

  for (const name of names) {
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs >= cutoff) {
        continue;
      }
      fs.rmSync(full, { force: true });
      removed++;
    } catch {
      // One unreadable file is not worth abandoning the rest of the sweep for.
    }
  }

  if (removed > 0) {
    log.info(`removed ${removed} abandoned dashboard heartbeat file(s)`);
  }
}
