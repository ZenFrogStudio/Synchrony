import * as vscode from 'vscode';
import { spliceChain } from './chain';
import { pruneRuns, pruneSeries } from './history';
import { log } from './log';
import { newId, stampRepeatEnd } from './series';
import { readState, updateState } from './state-file';
import { ChronosState, SCHEMA_VERSION, TaskRun, TaskSeries } from './types';

/**
 * Re-exported rather than defined here: `series.ts` is deliberately `vscode`-free
 * so the MCP server can load it, and this module is not. Every existing importer
 * of `newId` keeps working unchanged.
 */
export { newId };

export class Store {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private constructor(
    private file: string,
    private state: ChronosState
  ) {}

  /**
   * Loads one folder's schedule. The reading, migrating and setting-aside all
   * happen in `state-file.ts`; this only reports what it did.
   */
  static async create(file: string): Promise<Store> {
    return new Store(file, load(file));
  }

  /**
   * Points the store at a different folder's state. This is the whole of what
   * switching folders means to the schedule — everything else in Chronos reads
   * through the store or through a path thunk.
   */
  async retarget(file: string): Promise<void> {
    this.file = file;
    this.state = load(file);
    this.emitter.fire();
  }

  /**
   * Re-reads the current folder's state, for a write this window did not make.
   *
   * The store only re-reads on its own writes, which was enough while every
   * writer was a VS Code window with its own scheduler. The MCP server is not:
   * it writes a series and then does nothing, so without this a task an agent
   * scheduled would sit on disk unfired until the window was reloaded. Called
   * from the `state.json` watcher in `extension.ts`.
   *
   * `retarget` for the same file, minus the folder-switch logging — a reload
   * happens on every external write and would otherwise fill the log.
   */
  reload(): void {
    this.state = readState(this.file).state;
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  getSeries(): readonly TaskSeries[] {
    return this.state.series;
  }

  getSeriesById(id: string): TaskSeries | undefined {
    return this.state.series.find((s) => s.id === id);
  }

  getRuns(): readonly TaskRun[] {
    return this.state.runs;
  }

  getRunById(id: string): TaskRun | undefined {
    return this.state.runs.find((r) => r.id === id);
  }

  getRunsForSeries(seriesId: string): TaskRun[] {
    return this.state.runs.filter((r) => r.seriesId === seriesId);
  }

  /** Rolling spend. Surfaced in both views so a runaway series is noticed early. */
  costLast7Days(): number {
    const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
    return this.state.runs
      .filter((r) => r.costUsd !== undefined && r.finishedAt !== undefined)
      .filter((r) => Date.parse(r.finishedAt as string) >= cutoff)
      .reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  }

  async addSeries(series: TaskSeries): Promise<void> {
    await this.persist((state) => {
      state.series.push(series);
    });
  }

  async updateSeries(id: string, patch: Partial<TaskSeries>): Promise<void> {
    await this.persist((state) => {
      const series = state.series.find((s) => s.id === id);
      if (!series) {
        log.warn(`updateSeries: no series ${id}`);
        return;
      }
      // Through `stampRepeatEnd` so a plan that stops repeating records when it
      // did. One call covers the manager, the phone commands, the scheduler and
      // `retire.ts` — every editor in this process is id-and-patch shaped.
      Object.assign(series, stampRepeatEnd(series, patch));
    });
  }

  /** Removes the series and its run history together. */
  async removeSeries(id: string): Promise<void> {
    await this.persist((state) => {
      // Before the removal, while the link being closed up is still readable.
      // Anything waiting on this series would otherwise wait forever.
      const splices = spliceChain(state.series, id);
      state.series = state.series.filter((s) => s.id !== id);
      state.runs = state.runs.filter((r) => r.seriesId !== id);
      for (const { id: followerId, patch } of splices) {
        const follower = state.series.find((s) => s.id === followerId);
        if (follower) {
          Object.assign(follower, patch);
        }
      }
    });
  }

  async addRun(run: TaskRun): Promise<void> {
    await this.persist((state) => {
      state.runs.push(run);
    });
  }

  async updateRun(id: string, patch: Partial<TaskRun>): Promise<void> {
    await this.persist((state) => {
      const run = state.runs.find((r) => r.id === id);
      if (!run) {
        log.warn(`updateRun: no run ${id}`);
        return;
      }
      Object.assign(run, patch);
    });
  }

  async removeRun(id: string): Promise<void> {
    await this.persist((state) => {
      state.runs = state.runs.filter((r) => r.id !== id);
    });
  }

  /**
   * Applies one change to the file rather than to the copy in memory.
   *
   * Every mutator above is id-and-patch shaped, which is what lets this re-read
   * before it writes instead of merging two schedules: the change is applied to
   * whatever is on disk now, so a second window on this folder cannot put its
   * stale snapshot back over the scheduling window's run history. See
   * `updateState` for why that matters.
   *
   * The re-read hands back new objects, so `getSeries()` and `getRuns()` are
   * snapshots for reading — a caller that assigned to one of them and expected
   * the change to stick would be writing to a discarded copy. None do; every
   * edit in Chronos goes through a mutator here.
   */
  private async persist(change: (state: ChronosState) => void): Promise<void> {
    this.state = updateState(this.file, (state) => {
      change(state);
      state.runs = pruneRuns(state.runs);
      state.series = pruneSeries(state.series, state.runs);
    });
    this.emitter.fire();
  }
}

function load(file: string): ChronosState {
  const result = readState(file);

  if (result.backedUpTo) {
    log.warn(`state at ${file} was unreadable — copied to ${result.backedUpTo}, starting fresh`);
  } else if (result.migratedFrom !== undefined) {
    log.info(`migrated ${file} from schema v${result.migratedFrom} to v${SCHEMA_VERSION}`);
  }

  log.info(
    `loaded ${result.state.series.length} series, ${result.state.runs.length} runs from ${file}`
  );
  return result.state;
}
