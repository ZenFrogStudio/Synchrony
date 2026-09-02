import { Outcome, RunSummary } from './outcome';
import { withStatus } from './results';
import { AgentId } from './types';

/**
 * Turning an engine's NDJSON stream into something a person reads. Pure — no
 * `vscode` import — so both renderings are directly testable.
 *
 * Two outputs come from one parse: ANSI for the live terminal, Markdown for the
 * transcript on disk. They serve different moments — watching a run happen, and
 * auditing one that ran while you were asleep — but the events are identical,
 * so the JSON is parsed once and formatted twice.
 *
 * The Markdown side is the point of the whole module. A scheduled task runs
 * unattended, often with permissions wide open; the transcript is the only
 * record of what it actually did, so it deliberately includes tool calls and
 * their targets rather than just the closing message.
 *
 * `TranscriptEvent` names nothing vendor-specific, which is what keeps a second
 * engine cheap: only the parse forks. Every renderer below is shared.
 */

export type TranscriptEvent =
  | { kind: 'session'; sessionId: string; model: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail?: string }
  | { kind: 'result'; turns: number; costUsd?: number; denials: number };

export interface ParsedLine {
  events: TranscriptEvent[];
  /** What this line contributed to the outcome, folded by `foldSummary`. */
  summary?: Partial<RunSummary>;
}

export interface TranscriptContext {
  fileName: string;
  cwd: string;
  engine: string;
  permissionMode: string;
  model?: string;
  startedAt: Date;
  attempt: number;
}

/** A tool input rendered into a transcript. Long enough to identify, short
 *  enough that one pathological argument cannot dominate the file. */
const DETAIL_MAX_CHARS = 200;

/**
 * The input field worth recording per tool. Reviewing an unattended run means
 * asking "what did it touch?", and the answer is a path, a command or a
 * pattern — not the whole argument object.
 */
const TOOL_DETAIL_KEYS = [
  'command',
  'file_path',
  // opencode's own tools spell the same thing in camelCase.
  'filePath',
  'path',
  'pattern',
  'url',
  'description',
  'query'
];

export function parseLine(line: string, agent: AgentId = 'claude'): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return { events: [] };
  }

  let event: any;
  try {
    event = JSON.parse(trimmed);
  } catch {
    // Progress lines can be truncated mid-stream; ignore and keep scanning.
    return { events: [] };
  }

  switch (agent) {
    case 'opencode':
      return parseOpencodeLine(event);
    case 'codex':
      return parseCodexLine(event);
    default:
      return parseClaudeLine(event);
  }
}

/** `claude -p --output-format stream-json --verbose`. */
function parseClaudeLine(event: any): ParsedLine {
  if (event.type === 'system' && event.subtype === 'init') {
    return {
      events: [{ kind: 'session', sessionId: String(event.session_id ?? ''), model: String(event.model ?? '') }],
      summary: { sessionId: text(event.session_id) }
    };
  }

  if (event.type === 'assistant') {
    const parts: any[] = event.message?.content ?? [];
    const events: TranscriptEvent[] = [];
    for (const part of parts) {
      if (part.type === 'text' && part.text?.trim()) {
        events.push({ kind: 'text', text: String(part.text).trim() });
      } else if (part.type === 'tool_use') {
        events.push({ kind: 'tool', name: String(part.name ?? 'tool'), detail: toolDetail(part.input) });
      }
    }
    return { events };
  }

  // One per run, carrying cumulative totals.
  if (event.type === 'result') {
    const denials = event.permission_denials?.length ?? 0;
    return {
      events: [
        {
          kind: 'result',
          turns: Number(event.num_turns ?? 0),
          costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
          denials
        }
      ],
      summary: {
        sessionId: text(event.session_id),
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
        numTurns: typeof event.num_turns === 'number' ? event.num_turns : undefined,
        denials,
        resultText: text(event.result),
        sawResult: true,
        isError: event.is_error === true,
        apiErrorStatus: text(event.api_error_status)
      }
    };
  }

  return { events: [] };
}

/**
 * `opencode run --format json`. Same NDJSON-with-a-`type` shape as Claude's
 * stream, with the payload one level down in `part` and the totals reported per
 * step rather than once at the end — which is what `foldSummary` accumulates.
 *
 * No `session` event: opencode repeats its `sessionID` on every line and never
 * names the model, so a session event would be either duplicated or empty. The
 * id still reaches the summary, and the transcript header states the model.
 */
function parseOpencodeLine(event: any): ParsedLine {
  const part = event.part ?? {};
  const summary: Partial<RunSummary> = { sessionId: text(event.sessionID) };

  if (event.type === 'text') {
    const body = String(part.text ?? '').trim();
    return body ? { events: [{ kind: 'text', text: body }], summary: { ...summary, resultText: body } } : { events: [], summary };
  }

  if (event.type === 'tool_use') {
    return {
      events: [{ kind: 'tool', name: String(part.tool ?? 'tool'), detail: toolDetail(part.state?.input) }],
      summary
    };
  }

  // Emitted per step, so this is a turn. No transcript event: "1 turn" after
  // every step is noise, and the footer states the totals once.
  if (event.type === 'step_finish') {
    return {
      events: [],
      summary: {
        ...summary,
        numTurns: 1,
        costUsd: typeof part.cost === 'number' ? part.cost : undefined,
        sawResult: true
      }
    };
  }

  if (event.type === 'error') {
    return {
      events: [],
      summary: {
        ...summary,
        resultText: String(event.error?.data?.message ?? event.error?.name ?? 'opencode reported an error.'),
        // The only reliable sign of a rejected login. opencode words a 401 as
        // "Upstream request failed: [401] Provider returned error", which none
        // of `AUTH_PATTERNS` matches — so without the code an expired provider
        // login is filed as an ordinary failure and retried for hours.
        apiErrorStatus: text(event.error?.data?.statusCode),
        sawResult: true,
        isError: true
      }
    };
  }

  return { events: [], summary };
}

/** `codex --ask-for-approval ... exec --json`. */
function parseCodexLine(event: any): ParsedLine {
  if (event.type === 'thread.started') {
    return {
      events: [
        { kind: 'session', sessionId: String(event.thread_id ?? ''), model: String(event.model ?? '') }
      ],
      summary: { sessionId: text(event.thread_id) }
    };
  }

  if (event.type === 'item.completed') {
    const item = event.item ?? {};
    if (item.type === 'agent_message') {
      const body = String(item.text ?? '').trim();
      return body
        ? { events: [{ kind: 'text', text: body }], summary: { resultText: body } }
        : { events: [] };
    }

    const tool = codexToolEvent(item);
    return tool ? { events: [tool] } : { events: [] };
  }

  if (event.type === 'turn.completed') {
    const usage = event.usage ?? {};
    return {
      events: [
        {
          kind: 'result',
          turns: 1,
          costUsd: costOf(usage),
          denials: 0
        }
      ],
      summary: {
        numTurns: 1,
        costUsd: costOf(usage),
        sawResult: true
      }
    };
  }

  if (event.type === 'turn.failed' || event.type === 'error') {
    return {
      events: [],
      summary: {
        resultText: String(event.error?.message ?? event.error ?? event.message ?? 'Codex reported an error.'),
        apiErrorStatus: text(event.error?.status ?? event.status),
        sawResult: true,
        isError: true
      }
    };
  }

  return { events: [] };
}

/** A non-empty string, or undefined — so `foldSummary` can skip it. */
function text(value: unknown): string | undefined {
  const trimmed = value === undefined || value === null ? '' : String(value).trim();
  return trimmed || undefined;
}

function toolDetail(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of TOOL_DETAIL_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return truncate(value.trim().replace(/\s+/g, ' '), DETAIL_MAX_CHARS);
    }
  }
  return undefined;
}

function codexToolEvent(item: any): TranscriptEvent | undefined {
  const type = text(item.type);
  if (!type) {
    return undefined;
  }

  if (type === 'command_execution') {
    return { kind: 'tool', name: 'command_execution', detail: toolDetail(item) };
  }
  if (type === 'file_change') {
    return { kind: 'tool', name: 'file_change', detail: toolDetail(item) };
  }
  if (type === 'mcp_tool_call' || type === 'tool_call') {
    const name = text(item.name ?? item.tool) ?? type;
    return { kind: 'tool', name, detail: toolDetail(item.arguments ?? item.input ?? item) };
  }

  return undefined;
}

function costOf(usage: any): number | undefined {
  return typeof usage?.cost_usd === 'number'
    ? usage.cost_usd
    : typeof usage?.total_cost_usd === 'number'
      ? usage.total_cost_usd
      : undefined;
}

// ---------- terminal ----------

export function toAnsi(event: TranscriptEvent): string | undefined {
  switch (event.kind) {
    case 'session':
      return `\x1b[2msession ${event.sessionId} · ${event.model}\x1b[0m`;
    case 'text':
      return event.text;
    case 'tool':
      return `\x1b[36m⚙ ${event.name}\x1b[0m${event.detail ? `\x1b[2m ${event.detail}\x1b[0m` : ''}`;
    case 'result': {
      const cost = event.costUsd !== undefined ? ` · $${event.costUsd.toFixed(4)}` : '';
      const denials = event.denials
        ? ` · \x1b[33m${event.denials} permission denial(s)\x1b[0m`
        : '';
      return `\x1b[2m${event.turns} turns${cost}\x1b[0m${denials}`;
    }
  }
}

// ---------- transcript ----------

export function toMarkdown(event: TranscriptEvent): string | undefined {
  switch (event.kind) {
    case 'session':
      // Recorded in the header instead; repeating it mid-document is noise.
      return undefined;
    case 'text':
      return event.text;
    case 'tool':
      // Fenced rather than inline: a command containing backticks would
      // otherwise break out and corrupt the rest of the document.
      return event.detail
        ? `**${event.name}**\n\n\`\`\`\n${event.detail}\n\`\`\``
        : `**${event.name}**`;
    case 'result':
      // The footer states the outcome authoritatively once the process exits.
      return undefined;
  }
}

export function transcriptHeader(context: TranscriptContext): string {
  const rows = [
    ['Started', localStamp(context.startedAt)],
    ['Directory', context.cwd],
    ['Permissions', context.permissionMode],
    ['Engine', context.engine],
    ['Model', context.model || 'default']
  ];
  if (context.attempt > 1) {
    rows.push(['Attempt', `retry ${context.attempt - 1}`]);
  }

  return [
    `# ${context.fileName}`,
    '',
    '| | |',
    '|---|---|',
    ...rows.map(([label, value]) => `| ${label} | ${escapeCell(value)} |`),
    '',
    '---',
    '',
    ''
  ].join('\n');
}

export function transcriptFooter(outcome: Outcome, durationMs: number): string {
  const facts = [formatDuration(durationMs)];
  if (outcome.numTurns !== undefined) {
    facts.unshift(`${outcome.numTurns} turns`);
  }
  if (outcome.costUsd !== undefined) {
    facts.push(`$${outcome.costUsd.toFixed(4)}`);
  }

  const lines = [
    '',
    '---',
    '',
    '## Outcome',
    '',
    outcome.ok ? `**Completed** — ${facts.join(' · ')}` : `**Failed** — ${outcome.error ?? 'unknown error'}`,
    ''
  ];

  if (!outcome.ok) {
    lines.push(`${facts.join(' · ')}`, '');
  }

  // A run can exit successfully having been blocked from most of its work, so
  // this must be prominent rather than a footnote.
  if (outcome.denials > 0) {
    lines.push(
      `> ⚠ ${outcome.denials} tool call(s) were blocked by permission gating.`,
      '> Part of this plan did not run.',
      ''
    );
  }

  return lines.join('\n');
}

/** The filesystem and logging a transcript needs to be closed out. Injected so
 *  the failure paths below — which are the ones worth testing — can be forced. */
export interface FinaliseOps {
  exists: (filePath: string) => boolean;
  append: (filePath: string, text: string) => void;
  rename: (from: string, to: string) => void;
  warn: (message: string) => void;
}

/**
 * Closes out a transcript abandoned by a window that died mid-run, returning
 * where the transcript now lives.
 *
 * The footer and the `-failed` rename normally happen in `Runner.settle`, which
 * a killed extension host never reaches. Left alone, those transcripts keep
 * their un-suffixed name — so the results folder stops answering "which nights
 * went wrong" for precisely the runs that went most wrong. Called from
 * `Scheduler.reconcile()` on the next launch, where there is time to do it.
 *
 * Never throws. This runs while reconciling orphans at startup, and a results
 * folder that has gone read-only must not stop the scheduler from coming up.
 */
export function finaliseInterrupted(
  resultPath: string | undefined,
  error: string,
  durationMs: number,
  ops: FinaliseOps
): string | undefined {
  if (!resultPath || !ops.exists(resultPath)) {
    return resultPath;
  }

  try {
    const outcome: Outcome = { ok: false, error, denials: 0, retryable: true };
    ops.append(resultPath, transcriptFooter(outcome, durationMs));
    const target = withStatus(resultPath, 'failed');
    ops.rename(resultPath, target);
    return target;
  } catch (err) {
    ops.warn(`could not finalise an interrupted transcript: ${String(err)}`);
    return resultPath;
  }
}

// ---------- helpers ----------

/**
 * Local time, formatted deterministically. A transcript is read by a person in
 * their own timezone, so it is the one place local wall-clock beats UTC — and
 * building it by hand rather than through `toLocaleString` keeps the output
 * stable enough to assert on.
 */
export function localStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** A literal pipe would split a Markdown table cell in two. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}
