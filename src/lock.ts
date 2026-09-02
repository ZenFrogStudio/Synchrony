import * as fs from 'fs';

/**
 * A single-holder lock, so only one VS Code window schedules a given folder.
 *
 * Two windows each activate their own extension host, and each reads the
 * folder's `state.json` once into memory — neither has any sight of the other's
 * writes. So both see the same task as due, and both spawn an agent for it, in
 * the same repository, at the same moment. `maxConcurrent` cannot help: it
 * counts one window's runs.
 *
 * One file on disk arbitrates instead. Whoever holds it schedules; the others
 * show the UI and stay out of the way. The lock lives inside the folder's
 * `.chronos`, so two windows on two different projects both schedule — they are
 * not competing for the same tasks.
 *
 * No `vscode` import, so the rules are testable against a temp directory.
 */

export interface LockHolder {
  /** Identifies a window, not a process: pids are reused, this is not. */
  owner: string;
  /** Epoch ms of the holder's last tick. */
  heartbeatAt: number;
}

/** Missing, half-written or hand-edited all mean the same thing: nobody holds it. */
export function readLock(file: string): LockHolder | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockHolder>;
    if (typeof parsed.owner === 'string' && typeof parsed.heartbeatAt === 'number') {
      return { owner: parsed.owner, heartbeatAt: parsed.heartbeatAt };
    }
  } catch {
    // Fall through: an unreadable lock is an unheld lock.
  }
  return undefined;
}

/**
 * Claims the lock, renews it, or reports that someone else holds it.
 *
 * Called every tick, so one function covers all three: the holder's call renews
 * the claim, and a waiting window's call takes over once the holder has stopped
 * renewing for `staleMs`. A window that closes without releasing is therefore
 * waited out rather than deadlocking the schedule.
 */
export function holdLock(
  file: string,
  owner: string,
  now: number,
  staleMs: number
): boolean {
  const held = readLock(file);

  // Someone else's, and still being renewed.
  if (held && held.owner !== owner && now - held.heartbeatAt <= staleMs) {
    return false;
  }

  try {
    fs.writeFileSync(file, JSON.stringify({ owner, heartbeatAt: now }), 'utf8');
  } catch {
    // Nowhere to write means no way to coordinate. Declining to schedule is the
    // safe reading: a duplicate run edits a repository, a skipped tick does not.
    return false;
  }

  // Read back rather than trusting the write. Two windows can judge the same
  // abandoned lock free in the same instant, and the file is the only arbiter
  // of which of them actually ended up holding it.
  return readLock(file)?.owner === owner;
}

/** Hands the lock over promptly on shutdown, rather than making the next window wait out `staleMs`. */
export function releaseLock(file: string, owner: string): void {
  try {
    // Read immediately before the unlink rather than trusting an earlier check.
    // A window suspended past the staleness window has its lock legitimately
    // taken over by another, and unlinking then deletes *their* claim, leaving
    // two windows both scheduling this folder — the one thing this file exists
    // to prevent. This narrows that gap to as small as the filesystem allows;
    // it does not close it, as there is no atomic compare-and-delete here
    // without a platform-specific call, which is not worth it for a 90-second
    // suspend.
    if (readLock(file)?.owner !== owner) {
      return; // Never drop a lock we do not hold.
    }
    fs.unlinkSync(file);
  } catch {
    // Already gone, or taken by someone else between the read and the unlink.
  }
}
