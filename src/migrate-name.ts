import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Chronos → Synchrony: the on-disk half of the rename.
 *
 * The product was renamed after eight projects had a `.chronos/` and a home
 * directory had a `.chronos-dashboard/`. Nothing about those trees changed but
 * the name, so migration is a rename — atomic, and losing nothing if it never
 * happens. Everything here is best-effort and idempotent: a folder can be
 * migrated by whichever process sees it first (extension host, hub, stdio
 * server), and a folder that cannot be renamed right now (an older window
 * holding a handle on it) is used under its old name until it can.
 *
 * Nothing here imports `vscode`. The settings and workspace-state halves of
 * the rename live in `extension.ts`, where the API for them is.
 */

export const ROOT_DIR = '.synchrony';
export const LEGACY_ROOT_DIR = '.chronos';
export const DASHBOARD_DIR = '.synchrony-dashboard';
export const LEGACY_DASHBOARD_DIR = '.chronos-dashboard';

export type MigrateOutcome = 'migrated' | 'current' | 'none' | 'failed';

/**
 * Which root directory a project folder is using right now. The new name when
 * it exists; the legacy name when only it exists; the new name for a folder
 * that has neither, so a fresh project is born under the right one.
 */
export function rootDirFor(folder: string): string {
  if (fs.existsSync(path.join(folder, ROOT_DIR))) return ROOT_DIR;
  if (fs.existsSync(path.join(folder, LEGACY_ROOT_DIR))) return LEGACY_ROOT_DIR;
  return ROOT_DIR;
}

/** True when a folder is a project by either name. */
export function hasRoot(folder: string): boolean {
  return fs.existsSync(path.join(folder, ROOT_DIR)) || fs.existsSync(path.join(folder, LEGACY_ROOT_DIR));
}

/**
 * Renames `<folder>/.chronos` to `<folder>/.synchrony` when the latter does
 * not exist. A directory rename is atomic on NTFS and POSIX, so the tree is
 * whole under one name or the other at every instant. `failed` is a rename
 * refused by the OS — typically a Windows handle held by a window still
 * running the old build — and the caller carries on under the legacy name.
 */
export function migrateRoot(folder: string): MigrateOutcome {
  return renameIfLegacy(path.join(folder, LEGACY_ROOT_DIR), path.join(folder, ROOT_DIR));
}

/** The same rename for the per-machine dashboard directory (hub token, heartbeats). */
export function migrateHomeDir(home: string = os.homedir()): MigrateOutcome {
  return renameIfLegacy(path.join(home, LEGACY_DASHBOARD_DIR), path.join(home, DASHBOARD_DIR));
}

/** Where the per-machine directory is right now, by the same rule as `rootDirFor`. */
export function dashboardDirFor(home: string = os.homedir()): string {
  if (fs.existsSync(path.join(home, DASHBOARD_DIR))) return path.join(home, DASHBOARD_DIR);
  if (fs.existsSync(path.join(home, LEGACY_DASHBOARD_DIR))) return path.join(home, LEGACY_DASHBOARD_DIR);
  return path.join(home, DASHBOARD_DIR);
}

/** What the editor reports for one installed extension. */
export interface InstalledExtension {
  /** `publisher.name`, in whatever case the editor keeps it. */
  id: string;
  /** The manifest's `name` — the half of the id that survived the publisher change. */
  name: string;
  version: string;
}

/**
 * Package names this product has shipped under. Ids are `publisher.name`, and
 * both halves have changed (`onemedialabs.chronus` → `z3n.chronos` →
 * `z3n.synchrony`), so the name is matched on its own.
 */
const PRODUCT_NAMES = ['chronus', 'chronos', 'synchrony'];

/**
 * Older builds still installed under a previous id. The editor sees each id as
 * a separate extension, so they all activate in the same window — one
 * scheduler each, on the same folder — and whichever loses the lock tells the
 * user that "another window" holds it, when no other window exists.
 */
export function oldCopies(installed: InstalledExtension[], selfId: string): InstalledExtension[] {
  const self = selfId.toLowerCase();
  return installed.filter(
    (e) => e.id.toLowerCase() !== self && PRODUCT_NAMES.includes(e.name.toLowerCase())
  );
}

function renameIfLegacy(from: string, to: string): MigrateOutcome {
  if (fs.existsSync(to)) return 'current';
  if (!fs.existsSync(from)) return 'none';
  try {
    fs.renameSync(from, to);
    return 'migrated';
  } catch {
    return 'failed';
  }
}
