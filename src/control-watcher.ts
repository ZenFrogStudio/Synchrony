import * as fs from 'fs';
import * as vscode from 'vscode';
import { claimCommand, ControlCommand, finishCommand, listUnclaimed, peekUnclaimed } from './control';
import { log } from './log';
import { SynchronyPaths } from './roots';
import { Runner } from './runner';
import { Scheduler } from './scheduler';
import { coerceSetting, settingGroups } from './settings';

/**
 * Watches a folder's `control/` and hands each claimed command to the window
 * that should act on it.
 *
 * Modelled on `RequestWatcher`, with one difference `cancelRun` forces: a plan
 * request is claimed by whichever window is scheduling, but a cancel belongs to
 * whichever window's `Runner` actually holds the child process — and because a
 * deposed leader keeps its running processes (`scheduler.ts`), that is not
 * always the leader. So ownership is checked by every window on every sweep,
 * ahead of the leader/follower rule that settles everything else.
 */

const DEBOUNCE_MS = 200;
/** How long a non-leader waits before it claims what the leader left. */
const FOLLOWER_DELAY_MS = 1500;
/** How long a `cancelRun` may sit unowned before it is given up on. */
const CANCEL_STALE_MS = 15_000;

export class ControlWatcher implements vscode.Disposable {
  private watcher: fs.FSWatcher | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private followerTimer: NodeJS.Timeout | undefined;
  private sweeping = false;

  constructor(
    private readonly paths: () => SynchronyPaths,
    private readonly isLeader: () => boolean,
    private readonly runner: Runner,
    private readonly scheduler: Scheduler,
    private readonly configProperties: Record<string, unknown>
  ) {}

  restart(): void {
    this.stop();
    const dir = this.paths().control;
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.watcher = fs.watch(dir, (_event, filename) => {
        const name = filename ? String(filename) : '';
        if (!name.endsWith('.json') || name.endsWith('.claimed.json') || name.endsWith('.done.json')) {
          return;
        }
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.sweep(), DEBOUNCE_MS);
      });
    } catch (err) {
      log.warn(`could not watch control commands: ${String(err)}`);
    }
    void this.sweep();
  }

  dispose(): void {
    this.stop();
  }

  private stop(): void {
    clearTimeout(this.debounce);
    clearTimeout(this.followerTimer);
    this.watcher?.close();
    this.watcher = undefined;
  }

  /**
   * Ownership claims happen first, on every window, every sweep — a cancel
   * must not wait out `FOLLOWER_DELAY_MS` on the one window that can actually
   * act on it. What is left is everything leadership decides: settings, a
   * malformed command, and a `cancelRun` nobody owns once it has gone stale.
   */
  private async sweep(): Promise<void> {
    const dir = this.paths().control;
    if (!listUnclaimed(dir).length) return;

    await this.claimOwnedCancels(dir);

    if (!this.isLeader()) {
      clearTimeout(this.followerTimer);
      this.followerTimer = setTimeout(() => void this.claimRest(dir), FOLLOWER_DELAY_MS);
      return;
    }
    await this.claimRest(dir);
  }

  /** `cancelRun` commands this window's `Runner` actually holds the process for. */
  private async claimOwnedCancels(dir: string): Promise<void> {
    if (this.sweeping) return;
    for (const id of listUnclaimed(dir)) {
      const peek = peekUnclaimed(dir, id);
      if (peek?.kind === 'cancelRun' && this.runner.owns(peek.runId)) {
        await this.claimAndHandle(dir, id);
      }
    }
  }

  /**
   * Everything else. Called by the leader immediately and, after
   * `FOLLOWER_DELAY_MS`, by a follower picking up whatever the leader left —
   * the same first-refusal rule `RequestWatcher` uses, so a setting is never
   * claimed twice. A `cancelRun` nobody owns is skipped here until it has aged
   * past `CANCEL_STALE_MS`, so its actual owner gets first chance at it.
   */
  private async claimRest(dir: string): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const id of listUnclaimed(dir)) {
        const peek = peekUnclaimed(dir, id);
        if (peek?.kind === 'cancelRun' && !this.runner.owns(peek.runId)) {
          const ageMs = Date.now() - Date.parse(peek.requestedAt);
          if (!(ageMs >= CANCEL_STALE_MS)) continue; // still within its window to be claimed by its owner
        }
        await this.claimAndHandle(dir, id);
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async claimAndHandle(dir: string, id: string): Promise<void> {
    const claim = claimCommand(dir, id);
    if (!claim.claimed) return; // another window got it, or it was corrupt and is already marked done
    log.info(`claimed control command ${id} (${claim.command.kind})`);
    const outcome = await this.handle(claim.command);
    finishCommand(dir, id, outcome);
    log.info(
      `control command ${id}: ${outcome.ok ? 'done' : 'refused'}${outcome.note ? ` — ${outcome.note}` : ''}`
    );
  }

  private async handle(command: ControlCommand): Promise<{ ok: boolean; note?: string }> {
    try {
      if (command.kind === 'cancelRun') {
        if (!this.runner.owns(command.runId)) {
          return { ok: false, note: 'no live window owns that run' };
        }
        this.scheduler.cancelRun(command.runId);
        return { ok: true };
      }

      // Mirrors Manager's `updateSetting` handler exactly, so a setting
      // written from outside a window is validated the same way one typed
      // into the manager's Settings page is.
      const field = settingGroups(this.configProperties)
        .flatMap((group) => group.fields)
        .find((f) => f.key === command.key);
      if (!field) {
        return { ok: false, note: 'unknown setting' };
      }

      const value = coerceSetting(field, command.value);
      if (value === undefined) {
        return { ok: false, note: 'value refused for this setting' };
      }

      await vscode.workspace
        .getConfiguration('synchrony')
        .update(field.key, value, vscode.ConfigurationTarget.Global);
      return { ok: true };
    } catch (err) {
      return { ok: false, note: err instanceof Error ? err.message : String(err) };
    }
  }
}
