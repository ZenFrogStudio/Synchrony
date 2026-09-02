import * as vscode from 'vscode';
import { Action, decide, newRun } from './decide';
import { holdLock, releaseLock } from './lock';
import { log } from './log';
import { retryPlan } from './retry';
import { RunFinished, Runner } from './runner';
import { newId, Store } from './store';
import { nowUtc } from './time';
import { LOCK_STALE_MS, MissedReason, TICK_MS, TaskRun } from './types';

export class Scheduler implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private lastTickMs = Date.now();
  private ticking = false;
  /**
   * Runs the previous tick held back for capacity. Deliberately in memory
   * rather than the store: a deferral only means anything while this process is
   * alive to keep making it. After a restart or a suspend the queue is gone,
   * and the grace window should judge those runs on their own merits again.
   */
  private deferred = new Set<string>();
  private readonly subscription: vscode.Disposable;

  /** This window's identity in the lock file. */
  private readonly owner = newId();
  /** Whether this window is the one that schedules. See `lock.ts`. */
  private holdsLock = false;
  private readonly leadershipChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeLeadership = this.leadershipChanged.event;

  constructor(
    private readonly store: Store,
    private readonly runner: Runner,
    /** Resolved per tick: the lock lives beside the folder it arbitrates, so it
     *  moves when the active folder does. */
    private readonly lockFile: () => string,
    /** Moves plans that have nothing left to do out of the library. See `retire.ts`. */
    private readonly retirePlans: () => Promise<void>
  ) {
    this.subscription = runner.onDidFinish((e) => {
      void this.onFinished(e);
    });
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.releaseNow();
    this.subscription.dispose();
    this.leadershipChanged.dispose();
  }

  /** True when this window is the one running the schedule. */
  get leading(): boolean {
    return this.holdsLock;
  }

  /**
   * Drops the lock on the folder being left, before `lockFile()` starts
   * answering with the new one. Without this the old folder waits out
   * `LOCK_STALE_MS` before another window can schedule it, for no reason —
   * this window has already stopped.
   */
  releaseNow(): void {
    if (!this.holdsLock) {
      return;
    }
    releaseLock(this.lockFile(), this.owner);
    this.holdsLock = false;
    this.deferred.clear();
    this.leadershipChanged.fire();
  }

  /**
   * Note that nothing is reconciled here. That happens in `claimLeadership`,
   * once this window is known to be the one scheduling: a run left `running` may
   * belong to another window that is still executing it, and failing it from
   * here would requeue work that is already in flight.
   */
  async start(): Promise<void> {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    await this.tick();
  }

  /**
   * Fires a series immediately, independent of its schedule. Flagged `manual`
   * so it still runs on a paused or spent series — which is the whole point of
   * the button.
   */
  async runNow(seriesId: string): Promise<void> {
    const series = this.store.getSeriesById(seriesId);
    if (!series) {
      return;
    }
    if (!this.holdsLock) {
      // The run would land in this window's copy of the state, which the window
      // that actually schedules will never read. Better to refuse than to queue
      // something that silently never fires.
      log.warn('run now ignored — another window holds the Chronos scheduler');
      return;
    }
    await this.store.addRun({ ...newRun(series, nowUtc(), 1, newId()), manual: true });
    await this.tick();
  }

  /** Stops a run that is currently executing. */
  cancelRun(runId: string): void {
    this.runner.cancel(runId);
  }

  /**
   * Claims the new folder's lock straight away after a switch, rather than
   * leaving the window standing by until the next tick. Half a minute of "Run
   * now" being refused, and of a banner saying another window is scheduling,
   * would read as a bug.
   */
  async reclaim(): Promise<void> {
    await this.tick();
  }

  /**
   * Renews or claims the scheduler lock, and reports whether this window should
   * act on this tick. A window that has just taken over inherits responsibility
   * for whatever the previous holder left running.
   */
  private async claimLeadership(now: number): Promise<boolean> {
    const before = this.holdsLock;
    this.holdsLock = holdLock(this.lockFile(), this.owner, now, LOCK_STALE_MS);

    if (this.holdsLock === before) {
      return this.holdsLock;
    }

    this.leadershipChanged.fire();

    if (!this.holdsLock) {
      // Another window took over while we were suspended. Anything we still
      // have running keeps running; we simply stop deciding.
      log.info('another window now holds the Chronos scheduler — standing by');
      this.deferred.clear();
      return false;
    }

    log.info('holding the Chronos scheduler for this window');
    await this.reconcile();
    return true;
  }

  /**
   * A run left `running` has no process behind it — VS Code closed mid-flight.
   * Without this the concurrency slot is held forever.
   */
  private async reconcile(): Promise<void> {
    const orphans = this.store.getRuns().filter((r) => r.status === 'running');
    for (const run of orphans) {
      const error = 'Interrupted — VS Code closed during execution.';
      const startedAtMs = run.startedAt ? Date.parse(run.startedAt) : Date.now();
      await this.store.updateRun(run.id, {
        status: 'failed',
        finishedAt: nowUtc(),
        lastError: error,
        resultPath: this.runner.finaliseInterrupted(
          run.resultPath,
          error,
          Math.max(0, Date.now() - startedAtMs)
        )
      });
      log.warn(`reconciled orphaned run ${run.id}`);
      await this.afterTerminalOutcome(run, true);
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.evaluate();
    } catch (err) {
      log.error('scheduler tick failed', err);
    } finally {
      this.ticking = false;
    }
  }

  /** Gathers the clock and config, delegates the judgement, applies the result. */
  private async evaluate(): Promise<void> {
    const now = Date.now();

    // A gap far larger than the interval means the process was suspended.
    // Only used to word the notification.
    const drift = now - this.lastTickMs;
    this.lastTickMs = now;
    const reason: MissedReason = drift > TICK_MS * 3 ? 'sleep' : 'not-running';

    // Nothing was holding these back across a suspend — the machine was. Drop
    // the deferrals so the grace window judges them as the missed runs they are.
    if (reason === 'sleep') {
      this.deferred.clear();
    }

    if (!(await this.claimLeadership(now))) {
      return;
    }

    this.runner.checkWatchdogs();

    const actions = decide({
      series: this.store.getSeries(),
      runs: this.store.getRuns(),
      now,
      graceMs: config().get<number>('graceWindowMinutes', 15) * 60_000,
      reason,
      isSeriesRunning: (id) => this.runner.isSeriesRunning(id),
      freeSlots: this.runner.freeSlots(),
      wasDeferred: (id) => this.deferred.has(id),
      newId
    });

    // Replaced rather than added to: a run that started, was dropped or fell out
    // of the queue simply stops appearing, so the set prunes itself.
    this.deferred = new Set(
      actions.flatMap((a) => (a.kind === 'defer' ? [a.runId] : []))
    );

    for (const action of actions) {
      await this.apply(action);
    }
  }

  private async apply(action: Action): Promise<void> {
    switch (action.kind) {
      case 'addRun':
        return this.store.addRun(action.run);
      case 'updateSeries':
        return this.store.updateSeries(action.id, action.patch);
      case 'updateRun':
        return this.store.updateRun(action.id, action.patch);
      case 'removeRun':
        return this.store.removeRun(action.id);
      case 'start':
        return this.runner.begin(action.series, action.run);
      case 'defer':
        // Recorded in `deferred` by evaluate(). Nothing to write.
        return;
      case 'announceMissed':
        return this.announceMissed(action.count, action.reason);
      case 'announceBroken':
        return this.announceBroken(action.fileName, action.problem);
    }
  }

  private async onFinished(event: RunFinished): Promise<void> {
    const run = this.store.getRunById(event.runId);
    if (!run) {
      return;
    }

    if (event.outcome.ok) {
      if (event.outcome.denials > 0) {
        vscode.window.showWarningMessage(
          `Chronos: ${runLabel(this.store, run)} finished with ${event.outcome.denials} ` +
            'permission denial(s) — part of the plan may not have run.'
        );
      }
    } else {
      await this.afterTerminalOutcome(run, event.outcome.retryable);
    }

    // Deliberately after `afterTerminalOutcome` and on both branches: a retry
    // queued above is already a `pending` run by the time the rule looks, which
    // is what stops a failed plan being archived out from under its own retry.
    await this.retirePlans();
  }

  /** Retry, keep a chain alive, or give up and report. See `retry.ts`. */
  private async afterTerminalOutcome(run: TaskRun, retryable: boolean): Promise<void> {
    const series = this.store.getSeriesById(run.seriesId);
    if (!series) {
      return;
    }

    const retriesUsed = run.attempt - 1;
    const plan = retryPlan({
      run,
      series,
      allSeries: this.store.getSeries(),
      retryable,
      nowMs: Date.now(),
      delayMinutes: config().get<number>('retryDelayMinutes', 60)
    });

    if (plan.kind !== 'report') {
      const queued = newRun(series, plan.scheduledAt, plan.attempt, newId());
      await this.store.addRun(
        plan.kind === 'recovery' ? { ...queued, chainRecovery: true } : queued
      );
      log.info(
        plan.kind === 'recovery'
          ? `run ${run.id} failed in a chain; recovery retry queued for ${plan.scheduledAt}`
          : `run ${run.id} failed — retry ${run.attempt} queued for ${plan.scheduledAt}`
      );
      return;
    }

    vscode.window
      .showErrorMessage(
        `Chronos: ${series.fileName} failed${
          retriesUsed > 0 ? ` after ${retriesUsed} retries` : ''
        }.`,
        'Show Logs'
      )
      .then((choice) => {
        if (choice === 'Show Logs') {
          log.show();
        }
      });
  }

  /**
   * A repeat rule that cannot produce an occurrence has been unscheduled by
   * `decide`. Said out loud rather than only logged: the task has stopped, and
   * a silently stopped scheduled task is the failure this whole design is
   * built to avoid.
   */
  private announceBroken(fileName: string, problem: string): void {
    log.error(`unscheduled ${fileName} — unusable repeat rule: ${problem}`);
    vscode.window.showErrorMessage(
      `Chronos: unscheduled "${fileName}" — its repeat rule is unusable (${problem}). ` +
        'Set its schedule again to start it back up.'
    );
  }

  private announceMissed(count: number, reason: MissedReason): void {
    const plural = count > 1;
    vscode.window.showWarningMessage(
      `Chronos: ${count} task${plural ? 's' : ''} missed ${plural ? 'their' : 'its'} ` +
        `scheduled time while ${
          reason === 'sleep' ? 'your machine was asleep' : 'VS Code was closed'
        }.`
    );
    log.warn(`${count} missed occurrence(s), reason=${reason}`);
  }
}

function runLabel(store: Store, run: TaskRun): string {
  return store.getSeriesById(run.seriesId)?.fileName ?? 'Task';
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('chronos');
}
