import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConsolidationReport } from './consolidate';
import type { RetirementReport } from './retire';

let channel: vscode.OutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('Synchrony');
  context.subscriptions.push(channel);
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

function write(level: string, message: string): void {
  channel?.appendLine(`${new Date().toISOString()} [${level}] ${message}`);
}

/**
 * Drops raw run logs past the retention window. Best-effort, and deliberately
 * only the raw stream: the readable Markdown transcripts are the record of what
 * ran unattended, and they are kept indefinitely.
 */
export function pruneLogs(dir: string, retentionDays: number): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
  let removed = 0;

  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.unlinkSync(file);
          removed++;
        }
      } catch {
        // A log being read or already gone is not worth failing activation for.
      }
    }
  } catch {
    return; // Directory does not exist yet.
  }

  if (removed > 0) {
    write('info', `pruned ${removed} log file(s) older than ${retentionDays} days`);
  }
}

export const log = {
  info: (message: string) => write('info', message),
  warn: (message: string) => write('warn', message),
  error: (message: string, err?: unknown) =>
    write('error', err === undefined ? message : `${message} — ${describe(err)}`),
  show: () => channel?.show(true)
};

/**
 * What consolidating the plan library did. It lives here rather than in
 * `consolidate.ts` because that module is deliberately free of `vscode` so it
 * can be tested in plain Node, and this channel is the one thing it cannot have.
 *
 * A discarded schedule is written at `warn`: it is user-created work, and once
 * the row is gone from the manager the log is the only place it is accounted for.
 */
export function logConsolidation(report: ConsolidationReport): void {
  if (report.libraryUnreadable) {
    write('warn', `plan library unreadable, so nothing was consolidated: ${report.libraryUnreadable}`);
    return;
  }
  for (const move of report.imported) {
    write('info', `copied ${move.sourcePath} into the library as ${move.planName}`);
  }
  for (const name of report.droppedSchedules) {
    write('warn', `removed the schedule for ${name} — its plan file no longer exists`);
  }
}

/**
 * What retiring finished plans did. Here for the same reason as the above:
 * `retire.ts` is free of `vscode` so it can be tested in plain Node.
 *
 * The log is the whole of the notice. A row leaving the plan list is a visible
 * enough answer on its own, and a popup for something the user just watched
 * happen is one more thing to dismiss.
 */
export function logRetirement(report: RetirementReport): void {
  for (const move of report.archived) {
    write('info', `archived ${move.planName} to the archive as ${move.archivedAs} — it has run`);
  }
}
