import * as fs from 'fs';
import { log } from './log';
import { claimRequest, finishRequest, listUnclaimed, PlanRequest } from './requests';
import { SynchronyPaths } from './roots';

/**
 * Watches a folder's `requests/` and hands each claimed request to the window.
 *
 * The request protocol (`requests.ts`) makes the claim exclusive by rename; this
 * is the part that notices a file has landed and decides *when* this window
 * should reach for it. Two windows on one folder both see the file. The one
 * leading the scheduler goes first; a follower waits a beat and takes only what
 * is still unclaimed — so the ordinary case has one predictable actor and the
 * degenerate case (leader hung) still gets served.
 *
 * Watched the same way `StateWatcher` watches `state.json`: on the directory,
 * debounced, and swept at start so a request written while no window was open
 * runs as soon as one is.
 */

const DEBOUNCE_MS = 200;
/** How long a non-leader waits before it claims what the leader left. */
const FOLLOWER_DELAY_MS = 1500;

export type RequestHandler = (request: PlanRequest) => Promise<{ ok: boolean; note?: string }>;

export class RequestWatcher {
  private watcher: fs.FSWatcher | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private followerTimer: NodeJS.Timeout | undefined;
  private sweeping = false;

  constructor(
    private readonly paths: () => SynchronyPaths,
    private readonly leading: () => boolean,
    private readonly handle: RequestHandler
  ) {}

  restart(): void {
    this.stop();
    const dir = this.paths().requests;
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
      log.warn(`could not watch plan requests: ${String(err)}`);
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

  /** Claims and serves everything unclaimed. Re-entrancy guarded: a sweep that
   *  opens a terminal can take a while, and a second one would double-claim nothing
   *  but would double-log. */
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    const dir = this.paths().requests;
    const pending = listUnclaimed(dir);
    if (!pending.length) return;

    if (!this.leading()) {
      // Give the leader first refusal; take what is still there afterwards.
      clearTimeout(this.followerTimer);
      this.followerTimer = setTimeout(() => void this.claimAll(dir), FOLLOWER_DELAY_MS);
      return;
    }
    await this.claimAll(dir);
  }

  private async claimAll(dir: string): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const id of listUnclaimed(dir)) {
        const claim = claimRequest(dir, id);
        if (!claim.claimed) continue; // Another window got it, or it was corrupt and is already marked.
        log.info(`claimed plan request ${id} for ${claim.request.task}`);
        let outcome: { ok: boolean; note?: string };
        try {
          outcome = await this.handle(claim.request);
        } catch (err) {
          outcome = { ok: false, note: err instanceof Error ? err.message : String(err) };
        }
        finishRequest(dir, id, outcome);
        log.info(`plan request ${id}: ${outcome.ok ? 'opened' : 'failed'}${outcome.note ? ` — ${outcome.note}` : ''}`);
      }
    } finally {
      this.sweeping = false;
    }
  }
}
