import { randomBytes } from 'crypto';
import * as fs from 'fs';
import { migrate } from './migrate';
import { SynchronyState, SCHEMA_VERSION } from './types';

/**
 * The schedule on disk.
 *
 * State used to live in `globalState`, which is one bucket for the whole
 * machine — the reason Synchrony could not tell one project's work from
 * another's. A file per folder replaces it, and the read half is written here
 * rather than in `store.ts` so it can be exercised by the plain Node test
 * runner: no `vscode` import, same rule as `consolidate.ts` and `remote.ts`.
 */

/**
 * Names this window's temp file apart from every other window's.
 *
 * Once per process rather than once per write: unique against the window next
 * door, but reused by every write this window makes, so a crash mid-write can
 * strand one temp file here and never a growing pile of them.
 */
const WRITER = randomBytes(4).toString('hex');

export function emptyState(): SynchronyState {
  return { schemaVersion: SCHEMA_VERSION, series: [], runs: [] };
}

export interface ReadResult {
  state: SynchronyState;
  /** Where unrecognisable content was set aside, if it was. */
  backedUpTo?: string;
  /** The version read, when it was older than the current one. */
  migratedFrom?: number;
}

/**
 * Loads a folder's state, upgrading a known older schema through `migrate()`.
 *
 * A missing file is an empty schedule, not an error: it is what every folder
 * looks like before Synchrony has run in it. Only a genuinely unrecognisable
 * shape is set aside, and even then it is copied rather than dropped — losing
 * somebody's schedule to a parse error is not a recovery.
 */
export function readState(file: string): ReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { state: emptyState() };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: emptyState(), backedUpTo: setAside(file, raw) };
  }

  const migrated = migrate(parsed);
  if (!migrated) {
    return { state: emptyState(), backedUpTo: setAside(file, raw) };
  }

  const from = (parsed as Partial<SynchronyState>).schemaVersion;
  if (from !== SCHEMA_VERSION) {
    writeState(file, migrated);
    return { state: migrated, migratedFrom: from };
  }

  return { state: migrated };
}

/**
 * Read, change, write — never write back from a snapshot.
 *
 * Two windows open on the same folder each hold their own copy of this file,
 * and neither is told when the other writes. A window that persisted its
 * in-memory copy would put back everything it had never seen: every run the
 * scheduling window recorded since, and every schedule change with it, silently
 * gone. Re-reading first costs one small read per edit, and narrows "last writer
 * wins" from the whole file down to the field actually being changed.
 *
 * This is not syncing. A window still shows what it last read; it just stops
 * overwriting what it never read.
 */
export function updateState(
  file: string,
  change: (state: SynchronyState) => void
): SynchronyState {
  const { state } = readState(file);
  change(state);
  writeState(file, state);
  return state;
}

/**
 * Writes through a temp file and a rename. A rename is atomic on both NTFS and
 * ext4, so a crash mid-write leaves either the old schedule or the new one —
 * never a truncated file that reads as "every task has been deleted".
 *
 * That only holds while nobody else is writing the same temp path, though. Two
 * windows on one folder are two processes with no sight of each other, and a
 * shared temp name would let their writes interleave into a file that parses as
 * nothing — hence the per-window name.
 */
export function writeState(file: string, state: SynchronyState): void {
  const temp = `${file}.${WRITER}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state), 'utf8');
  fs.renameSync(temp, file);
}

/** Keeps a copy of content we could not read, so it is recoverable by hand. */
function setAside(file: string, raw: string): string | undefined {
  const backup = `${file}.bak`;
  try {
    fs.writeFileSync(backup, raw, 'utf8');
    return backup;
  } catch {
    return undefined;
  }
}
