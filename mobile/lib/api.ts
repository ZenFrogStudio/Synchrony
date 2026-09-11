import { McpError } from './mcp';
import { getClient } from './session';

/**
 * Typed shapes mirroring what `src/hub.ts` actually returns (via
 * `describeSeries`/`describeRun`/`summarizeInstance` in `src/mcp-actions.ts`,
 * and `read_instance`'s own assembly), plus one thin typed function per hub
 * tool. No abstraction beyond that — screens call these, not `McpClient`
 * directly.
 */

///////////////////////////*Shapes*////////////////////////////

export type PermissionMode = 'acceptEdits' | 'auto' | 'bypassPermissions' | 'dontAsk' | 'manual' | 'plan';
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'missed' | 'cancelled';

export interface Recurrence {
  daysOfWeek: number[];
  timeLocal: string;
  dayOfMonth?: number;
}

export interface Series {
  id: string;
  plan: string;
  nextRunAt: string;
  recurrence: Recurrence | null;
  enabled: boolean;
  spent: boolean;
  runsAfter?: { seriesId: string; delayMinutes: number };
  engine: string;
  model: string;
  permissionMode?: PermissionMode;
  cwd: string;
  maxRetries: number;
}

export interface Run {
  id: string;
  seriesId: string;
  status: RunStatus;
  attempt: number;
  scheduledAt: string;
  startedAt?: string;
  finishedAt?: string;
  costUsd?: number;
  denials?: number;
  result?: string;
  lastError?: string;
  hasTranscript: boolean;
}

export interface Task {
  name: string;
  text: string;
  captured: string;
}

export interface PlanFile {
  name: string;
  title: string;
  modified: string;
  sizeBytes: number;
}

export interface AskedQuestion {
  id: string;
  question: string;
  options?: string[];
}

export interface Answer {
  id: string;
  answer: string;
}

export interface Question {
  id: string;
  askedAt: string;
  source?: string;
  summary: string;
  questions: AskedQuestion[];
  answeredAt?: string;
  answers?: Answer[];
}

export interface RunningInfo {
  runId: string;
  plan: string;
  startedAt: string;
  attempt: number;
  engine: string;
  model: string | null;
}

export interface InstanceCounts {
  series: number;
  armed: number;
  parked: number;
  spent: number;
  off: number;
}

export interface InstanceSummary {
  instance: string;
  folder: string;
  live: boolean;
  lockAgeSec: number | null;
  running: RunningInfo | null;
  next: Series | null;
  counts: InstanceCounts;
  tasks: number;
  pendingRequests: number;
  missedRuns: number;
  costLast7Days: number;
}

export interface ActivityEntry {
  seriesId: string;
  planTitle: string;
  at: string;
  runId?: string;
}

export interface ActivityFeed {
  upcoming: ActivityEntry[];
  recent: ActivityEntry[];
}

export interface SettingField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  default: unknown;
  options?: { value: string; label: string }[];
  help: string;
  minimum?: number;
  maximum?: number;
}

export interface SettingGroup {
  title: string;
  note?: string;
  fields: SettingField[];
}

export interface InstanceWindow {
  status: 'active' | 'stopped';
  leader: boolean;
  heartbeatAt: string;
}

/** The one document `read_instance` returns — everything a phone needs to poll. */
export interface InstanceSnapshot {
  capturedAt: string;
  instance: string;
  folder: string;
  live: boolean;
  lockAgeSec: number | null;
  running: RunningInfo | null;
  next: Series | null;
  counts: InstanceCounts;
  pendingRequests: number;
  missedRuns: number;
  costLast7Days: number;
  plans: PlanFile[];
  series: Series[];
  runs: Run[];
  tasks: Task[];
  questions: Question[];
  activity: ActivityFeed;
  settings: { groups: SettingGroup[]; values: Record<string, unknown> } | null;
  availableAgents: string[] | null;
  windows: InstanceWindow[];
}

export interface ScheduleArgs {
  name: string;
  at?: string;
  repeat?: 'once' | 'daily' | 'weekly' | 'monthly';
  timeLocal?: string;
  daysOfWeek?: number[];
  dayOfMonth?: number;
  agent?: 'claude' | 'opencode' | 'codex';
  model?: string;
  permissionMode?: PermissionMode;
  maxRetries?: number;
}

export interface ChainPlansArgs {
  names: string[];
  startIso: string;
  gapMinutes: number;
  stopOnFailure: boolean;
  agent?: 'claude' | 'opencode' | 'codex';
  model?: string;
  permissionMode?: PermissionMode;
}

///////////////////////////*Transport helpers*////////////////////////////

function client() {
  const c = getClient();
  if (!c) throw new McpError('Not connected to a desktop. Pair first.');
  return c;
}

function callText(name: string, args: object): Promise<string> {
  return client()
    .call(name, args)
    .then(({ text, isError }) => {
      if (isError) throw new McpError(text || `${name} was refused.`);
      return text;
    });
}

///////////////////////////*Reads*////////////////////////////

export const listInstances = (): Promise<{ capturedAt: string; instances: InstanceSummary[] }> =>
  client().callJson('list_instances', {});

export const listTasks = (instance: string): Promise<Task[]> => client().callJson('list_tasks', { instance });

export const listPlans = (instance: string): Promise<PlanFile[]> => client().callJson('list_plans', { instance });

export const readPlan = (instance: string, name: string): Promise<string> =>
  callText('read_plan', { instance, name });

export const listSchedule = (instance: string): Promise<Series[]> =>
  client().callJson('list_schedule', { instance });

export const listRuns = (instance: string, limit?: number): Promise<Run[]> =>
  client().callJson('list_runs', { instance, ...(limit !== undefined ? { limit } : {}) });

export const listQuestions = (instance: string, includeAnswered?: boolean): Promise<Question[]> =>
  client().callJson('list_questions', { instance, ...(includeAnswered !== undefined ? { includeAnswered } : {}) });

export const readInstance = (instance: string): Promise<InstanceSnapshot> =>
  client().callJson('read_instance', { instance });

export const readTranscript = (instance: string, runId: string): Promise<string> =>
  callText('read_transcript', { instance, runId });

export const readLog = (instance: string, runId: string): Promise<string> =>
  callText('read_log', { instance, runId });

export const requestStatus = (
  instance: string,
  id: string
): Promise<{ instance: string; id: string; status: string; outcome?: unknown }> =>
  client().callJson('request_status', { instance, id });

///////////////////////////*Writes*////////////////////////////

export const addTask = (instance: string, text: string): Promise<{ instance: string; captured: string; title: string }> =>
  client().callJson('add_task', { instance, text });

export const requestPlan = (
  instance: string,
  task: string,
  opts: { series?: boolean; model?: string } = {}
): Promise<{ instance: string; requestId: string; live: boolean; note: string }> =>
  client().callJson('request_plan', { instance, task, ...opts });

export const schedulePlan = (instance: string, args: ScheduleArgs): Promise<Series & { instance: string; scheduled: string; queued?: string }> =>
  client().callJson('schedule_plan', { instance, ...args });

export const answerQuestion = (instance: string, id: string, answers: Answer[]): Promise<string> =>
  callText('answer_question', { instance, id, answers });

export const updateSeries = (
  instance: string,
  id: string,
  patch: Record<string, unknown>
): Promise<Series & { instance: string }> => client().callJson('update_series', { instance, id, patch });

export const unscheduleSeries = (instance: string, id: string): Promise<{ instance: string; fileName: string }> =>
  client().callJson('unschedule_series', { instance, id });

export const runNow = (
  instance: string,
  seriesId: string,
  dismissRunId?: string
): Promise<{ instance: string; run: Run; note: string }> =>
  client().callJson('run_now', { instance, seriesId, ...(dismissRunId ? { dismissRunId } : {}) });

export const rerunRun = (instance: string, runId: string): Promise<{ instance: string; run: Run; note: string }> =>
  client().callJson('rerun_run', { instance, runId });

export const dismissRun = (instance: string, runId: string): Promise<{ instance: string; id: string }> =>
  client().callJson('dismiss_run', { instance, runId });

export const createPlan = (
  instance: string,
  title: string,
  body?: string
): Promise<PlanFile & { instance: string }> =>
  client().callJson('create_plan', { instance, title, ...(body !== undefined ? { body } : {}) });

export const savePlan = (instance: string, name: string, text: string): Promise<string> =>
  callText('save_plan', { instance, name, text });

export const renamePlan = (
  instance: string,
  name: string,
  newTitle: string
): Promise<PlanFile & { instance: string }> => client().callJson('rename_plan', { instance, name, newTitle });

export const archivePlan = (instance: string, name: string): Promise<PlanFile & { instance: string }> =>
  client().callJson('archive_plan', { instance, name });

export const editTask = (instance: string, name: string, text: string): Promise<string> =>
  callText('edit_task', { instance, name, text });

export const deleteTask = (instance: string, name: string): Promise<Task & { instance: string }> =>
  client().callJson('delete_task', { instance, name });

export const runTask = (
  instance: string,
  name: string,
  model?: string
): Promise<{ instance: string; series: Series; note: string }> =>
  client().callJson('run_task', { instance, name, ...(model ? { model } : {}) });

export const chainPlans = (instance: string, args: ChainPlansArgs): Promise<{ instance: string; series: Series[] }> =>
  client().callJson('chain_plans', { instance, ...args });

export const cancelRun = (instance: string, runId: string): Promise<string> =>
  callText('cancel_run', { instance, runId });

export const updateSetting = (instance: string, key: string, value: unknown): Promise<string> =>
  callText('update_setting', { instance, key, value });
