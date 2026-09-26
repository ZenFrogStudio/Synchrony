import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Agent, agentFor } from './agents';
import { buildArgs, preflightError } from './launch';
import { log } from './log';
import {
  emptySummary,
  foldSummary,
  KillReason,
  Outcome,
  resolveOutcome,
  RunSummary,
  watchdogVerdict
} from './outcome';
import { resultPathFor, withStatus } from './results';
import { Store } from './store';
import { nowUtc, truncate, truncateError } from './time';
import {
  finaliseInterrupted,
  parseLine,
  toAnsi,
  toMarkdown,
  transcriptFooter,
  transcriptHeader
} from './transcript';
import { RESULT_MAX_CHARS, TaskRun, TaskSeries } from './types';

export interface RunFinished {
  runId: string;
  seriesId: string;
  outcome: Outcome;
}

interface ActiveRun {
  runId: string;
  seriesId: string;
  child: ChildProcess;
  /** Which engine is running, so the parser and the messages can say. */
  agent: Agent;
  startedAtMs: number;
  lastOutputAtMs: number;
  /**
   * The stream folded down as it arrives, rather than the stream itself. The
   * full transcript is already going to disk twice over; holding a megabyte of
   * it in memory to re-read at the end would be pure waste.
   */
  summary: RunSummary;
  pending: string;
  logStream: fs.WriteStream;
  /** Absent when the results folder could not be written to. */
  resultStream?: fs.WriteStream;
  resultPath?: string;
  killReason?: KillReason;
  writer: vscode.EventEmitter<string>;
  closer: vscode.EventEmitter<number>;
}

export class Runner implements vscode.Disposable {
  private readonly active = new Map<string, ActiveRun>();
  private readonly finished = new vscode.EventEmitter<RunFinished>();
  readonly onDidFinish = this.finished.event;

  constructor(
    private readonly store: Store,
    /** Resolved per run, like `resultsDir`: it moves when the folder does. */
    private readonly logDir: () => string,
    /** Resolved per run: the setting can change without an editor restart. */
    private readonly resultsDir: () => string
  ) {}

  dispose(): void {
    for (const run of this.active.values()) {
      run.killReason = 'shutdown';
      killTree(run.child);
    }
    this.finished.dispose();
    // The streams are deliberately left open. Ending them here would race
    // `settle`, which still runs whenever the child's `close` event arrives —
    // and it does whenever the extension is deactivated without the host
    // exiting, as on a window reload. `settle` would then be writing a footer to
    // an ended stream, lose both the footer and the rename, and mark the run
    // `failed` so that `finaliseInterrupted` skips it on the next launch too.
    // Letting `settle` finish the job when it can, and finalising on the next
    // launch when it cannot, covers both without the race.
  }

  /** Real filesystem behind `finaliseInterrupted`, whose rules live in `transcript`. */
  finaliseInterrupted(
    resultPath: string | undefined,
    error: string,
    durationMs: number
  ): string | undefined {
    return finaliseInterrupted(resultPath, error, durationMs, {
      exists: fs.existsSync,
      append: (p, text) => fs.appendFileSync(p, text, 'utf8'),
      rename: fs.renameSync,
      warn: log.warn
    });
  }

  get activeCount(): number {
    return this.active.size;
  }

  isSeriesRunning(seriesId: string): boolean {
    for (const run of this.active.values()) {
      if (run.seriesId === seriesId) {
        return true;
      }
    }
    return false;
  }

  /** Whether this window's `Runner` holds the child process for `runId` — the
   *  ownership `control-watcher.ts` checks before claiming a cancel, since a
   *  deposed scheduler leader keeps its running processes (see `scheduler.ts`). */
  owns(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Remaining concurrency. Parallel agents in one repo collide, hence the cap. */
  freeSlots(): number {
    const max = config().get<number>('maxConcurrent', 1);
    return Math.max(0, max - this.active.size);
  }

  cancel(runId: string, reason: KillReason = 'cancelled'): void {
    const run = this.active.get(runId);
    if (!run) {
      return;
    }
    run.killReason = reason;
    killTree(run.child);
  }

  /** Applies `watchdogVerdict` to every live run. The rules themselves are pure. */
  checkWatchdogs(): void {
    const idleMs = config().get<number>('idleTimeoutMinutes', 15) * 60_000;
    const maxMs = config().get<number>('maxRuntimeMinutes', 60) * 60_000;
    const now = Date.now();

    for (const run of this.active.values()) {
      const verdict = watchdogVerdict(run, now, idleMs, maxMs);
      if (verdict) {
        this.cancel(run.runId, verdict);
      }
    }
  }

  async begin(series: TaskSeries, run: TaskRun): Promise<void> {
    const failFast = async (error: string) => {
      await this.store.updateRun(run.id, {
        status: 'failed',
        finishedAt: nowUtc(),
        lastError: error
      });
      this.finished.fire({
        runId: run.id,
        seriesId: series.id,
        outcome: { ok: false, error, denials: 0, retryable: false }
      });
    };

    // Pre-flight. These failures are not retryable — the same missing file
    // would fail identically an hour later.
    const readFile = (p: string) => fs.readFileSync(p, 'utf8');
    const problem = preflightError(series, fs.existsSync, readFile);
    if (problem) {
      return failFast(problem);
    }

    const prompt = readFile(series.filePath);
    const startedAt = new Date();
    const logDir = this.logDir();
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${run.id}.log`);
    const resultPath = this.prepareResultPath(series, startedAt);

    await this.store.updateRun(run.id, {
      status: 'running',
      startedAt: nowUtc(),
      logPath,
      resultPath
    });

    this.spawnRun(series, run, prompt, logPath, resultPath, startedAt);
  }

  /**
   * Creates the plan's results folder and returns where this run's transcript
   * goes. A results folder that cannot be written to must not stop the run —
   * the work matters more than the record of it — so this degrades to
   * undefined and says so in the log.
   */
  private prepareResultPath(series: TaskSeries, startedAt: Date): string | undefined {
    try {
      const target = resultPathFor(this.resultsDir(), series.fileName, startedAt);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      return target;
    } catch (err) {
      log.warn(`could not prepare a results folder: ${String(err)}`);
      return undefined;
    }
  }

  private spawnRun(
    series: TaskSeries,
    run: TaskRun,
    prompt: string,
    logPath: string,
    resultPath: string | undefined,
    startedAt: Date
  ): void {
    const agent = agentFor(series.agent);
    const args = buildArgs(series);
    const exe = agentExe(agent);

    log.info(`run ${run.id}: ${exe} ${args.join(' ')} (cwd ${series.cwd})`);

    let child: ChildProcess;
    try {
      child = spawnAgent(exe, args, series.cwd);
    } catch (err) {
      void this.store.updateRun(run.id, {
        status: 'failed',
        finishedAt: nowUtc(),
        lastError: truncateError(`Could not start ${agent.id}: ${String(err)}`)
      });
      this.finished.fire({
        runId: run.id,
        seriesId: series.id,
        outcome: { ok: false, error: `Could not start ${agent.id}.`, denials: 0, retryable: true }
      });
      return;
    }

    const now = Date.now();
    const active: ActiveRun = {
      runId: run.id,
      seriesId: series.id,
      child,
      agent,
      startedAtMs: now,
      lastOutputAtMs: now,
      summary: emptySummary(),
      pending: '',
      logStream: fs.createWriteStream(logPath, { flags: 'a' }),
      resultPath,
      resultStream: openTranscript(resultPath, series, run, startedAt),
      writer: new vscode.EventEmitter<string>(),
      closer: new vscode.EventEmitter<number>()
    };
    this.active.set(run.id, active);

    this.openTerminal(series, active);

    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(active, chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => {
      active.lastOutputAtMs = Date.now();
      active.logStream.write(chunk);
      this.write(active, chunk.toString());
    });

    child.on('error', (err) => {
      active.logStream.write(`\n[synchrony] spawn error: ${String(err)}\n`);
    });

    child.on('close', (code) => {
      void this.settle(active, code);
    });

    // Prompt goes over stdin: no argv length limit, no shell escaping, and the
    // path having spaces stops mattering.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(prompt);
  }

  private openTerminal(series: TaskSeries, active: ActiveRun): void {
    const pty: vscode.Pseudoterminal = {
      onDidWrite: active.writer.event,
      onDidClose: active.closer.event,
      open: () => {
        active.writer.fire(`\x1b[2mSynchrony — ${series.fileName}\x1b[0m\r\n`);
        active.writer.fire(`\x1b[2m${series.cwd}\x1b[0m\r\n\r\n`);
      },
      // Closing the tab of a live run cancels it; closing a finished one is a
      // no-op, since it is no longer in `active`.
      close: () => this.cancel(active.runId, 'cancelled')
    };

    const terminal = vscode.window.createTerminal({
      name: `Synchrony: ${series.fileName}`,
      pty
    });

    // Reveal without stealing focus. A run you never see is indistinguishable
    // from one that never happened; taking the cursor mid-typing is worse.
    if (config().get<boolean>('showTerminalOnRun', true)) {
      terminal.show(true);
    }
  }

  private write(active: ActiveRun, text: string): void {
    active.writer.fire(text.replace(/\r?\n/g, '\r\n'));
  }

  /**
   * Buffers NDJSON by line, then renders each event twice from one parse: ANSI
   * into the live terminal, Markdown into the transcript. The raw stream goes
   * to the log verbatim.
   */
  private onStdout(active: ActiveRun, chunk: string): void {
    active.lastOutputAtMs = Date.now();
    active.logStream.write(chunk);

    active.pending += chunk;
    const lines = active.pending.split('\n');
    active.pending = lines.pop() ?? '';

    for (const line of lines) {
      const { events, summary } = parseLine(line, active.agent.id);
      if (summary) {
        foldSummary(active.summary, summary);
      }

      for (const event of events) {
        const ansi = toAnsi(event);
        if (ansi) {
          this.write(active, `${ansi}\n`);
        }
        const markdown = toMarkdown(event);
        if (markdown) {
          active.resultStream?.write(`${markdown}\n\n`);
        }
      }
    }
  }

  /**
   * Closes the transcript and renames it to carry the outcome, so the results
   * folder answers "which nights failed" without opening anything.
   *
   * The rename waits for `close` rather than `finish`: Windows refuses to
   * rename a file whose handle is still open, and `finish` fires before the
   * descriptor is released.
   */
  private finishTranscript(active: ActiveRun, outcome: Outcome): Promise<string | undefined> {
    const stream = active.resultStream;
    const source = active.resultPath;
    if (!stream || !source) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      const rename = () => {
        const target = withStatus(source, outcome.ok ? 'completed' : 'failed');
        try {
          fs.renameSync(source, target);
          resolve(target);
        } catch (err) {
          log.warn(`could not rename transcript: ${String(err)}`);
          resolve(source);
        }
      };

      stream.once('close', rename);
      stream.once('error', (err) => {
        log.warn(`transcript write failed: ${String(err)}`);
        resolve(source);
      });
      stream.end(transcriptFooter(outcome, Date.now() - active.startedAtMs));
    });
  }

  private async settle(active: ActiveRun, exitCode: number | null): Promise<void> {
    this.active.delete(active.runId);
    active.logStream.end();

    const outcome = resolveOutcome({
      exitCode,
      summary: active.summary,
      killReason: active.killReason,
      engine: active.agent.id
    });

    const resultPath = await this.finishTranscript(active, outcome);

    // The tab closes itself. Firing onDidClose tells VS Code the pty exited and
    // it disposes the tab and the terminal; the transcript is already on disk
    // in the result file and the log, which is where an unattended run gets
    // read anyway. Leaving the tab open leaked one terminal and two emitters
    // per scheduled run for the life of the window. `fire` is synchronous, so
    // disposing straight after is safe.
    active.closer.fire(exitCode ?? 0);
    active.writer.dispose();
    active.closer.dispose();

    await this.store.updateRun(active.runId, {
      status: outcome.ok ? 'completed' : 'failed',
      finishedAt: nowUtc(),
      exitCode: exitCode ?? undefined,
      sessionId: outcome.sessionId,
      costUsd: outcome.costUsd,
      denials: outcome.denials || undefined,
      authFailure: outcome.authFailure,
      result: outcome.resultText ? truncate(outcome.resultText, RESULT_MAX_CHARS) : undefined,
      resultPath,
      lastError: outcome.error ? truncateError(outcome.error) : undefined
    });

    log.info(
      `run ${active.runId} ${outcome.ok ? 'completed' : 'failed'}` +
        (outcome.denials ? ` with ${outcome.denials} permission denial(s)` : '')
    );

    this.finished.fire({ runId: active.runId, seriesId: active.seriesId, outcome });
  }
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('synchrony');
}

/** Where this engine's executable lives, per its own setting. */
export function agentExe(agent: Agent): string {
  return config().get<string>(agent.pathSetting, agent.exe);
}

/**
 * Confirms an engine is reachable before a task depends on it, returning why
 * not. Deliberately not awaited during activation: a bad path should surface as
 * a setup notice when you install, not as a failed run at 2am, and neither
 * should cost anyone a slow editor start.
 *
 * Doubles as the availability check behind the manager's Engine dropdown, which
 * is the only honest one available — neither CLI can list its models, but both
 * answer `--version`.
 */
export function probeAgent(agent: Agent, timeoutMs = 5_000): Promise<string | undefined> {
  const exe = agentExe(agent);

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnAgent(exe, ['--version'], process.cwd());
    } catch (err) {
      resolve(`Could not start "${exe}": ${String(err)}`);
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      resolve(`"${exe}" did not respond to --version within ${timeoutMs / 1000}s.`);
    }, timeoutMs);

    const settle = (problem: string | undefined) => {
      clearTimeout(timer);
      resolve(problem);
    };

    child.on('error', () => settle(`Could not run "${exe}". Check synchrony.${agent.pathSetting}.`));
    child.on('close', (code) =>
      settle(code === 0 ? undefined : `"${exe} --version" exited with code ${code}.`)
    );
  });
}

/**
 * On Windows both `claude` and `opencode` are .cmd shims, which spawn cannot
 * execute without a shell. Under `shell: true` Node quotes nothing — not the
 * executable, not the arguments — so both are quoted here.
 *
 * The prompt still travels on stdin, never the command line. Everything in
 * `args` is a fixed flag, a validated enum value, or the working directory,
 * which is the one entry that can contain a space and is the reason quoting the
 * arguments matters rather than only the executable.
 */
function spawnAgent(exe: string, args: string[], cwd: string): ChildProcess {
  const isWindows = process.platform === 'win32';
  return spawn(isWindows ? quoteForCmd(exe) : exe, isWindows ? args.map(quoteForCmd) : args, {
    cwd,
    shell: isWindows,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

/**
 * Stops a run's process, and on Windows everything under it. `spawnAgent` goes
 * through cmd.exe there, so the agent is a grandchild: `child.kill()` ends the
 * wrapper and leaves the agent working, still holding the stdio pipes that keep
 * `close` — and so `settle` — from ever firing. `taskkill /T` walks the tree.
 * If taskkill itself cannot start, the plain kill is better than nothing.
 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    }).on('error', () => child.kill());
    return;
  }
  child.kill();
}

/** cmd has no escape character inside quotes, and a Windows path cannot contain
 *  a double quote, so stripping one is a guard rather than a loss. */
function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '')}"`;
}

/**
 * Opens the run's transcript and writes its header. Returns undefined when
 * there is nowhere to write — the run still goes ahead without a record.
 */
function openTranscript(
  resultPath: string | undefined,
  series: TaskSeries,
  run: TaskRun,
  startedAt: Date
): fs.WriteStream | undefined {
  if (!resultPath) {
    return undefined;
  }

  try {
    const stream = fs.createWriteStream(resultPath, { flags: 'a' });
    stream.write(
      transcriptHeader({
        fileName: series.fileName,
        cwd: series.cwd,
        engine: agentFor(series.agent).label,
        permissionMode: series.permissionMode,
        model: series.model,
        startedAt,
        attempt: run.attempt
      })
    );
    return stream;
  } catch (err) {
    log.warn(`could not open a transcript for run ${run.id}: ${String(err)}`);
    return undefined;
  }
}
