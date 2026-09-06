/**
 * The Chronos instance dashboard.
 *
 * Polls `/api/instances`, merges what every editor window reported, and draws
 * it. Read-only by construction: there is no message back to any window, and
 * nothing here can change a schedule or stop a run.
 *
 * Every value that lands on the page goes through `textContent`. The instance
 * files are written by Chronos, but they carry plan names and error text that
 * originated in a plan file or a coding agent's output, so none of it is
 * treated as markup.
 */

const POLL_MS = 4000;

const el = (id) => document.getElementById(id);

/*//////////////////////////////*Polling*//////////////////////////////*/

async function refresh() {
  try {
    const response = await fetch('/api/instances', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    render(await response.json());
    setConnection('Live', 'live');
  } catch {
    // The server is started by hand, so it going away is an ordinary thing to
    // see. The board keeps showing the last good reading rather than blanking.
    setConnection('No server', 'down');
  }
}

function setConnection(text, className) {
  const pill = el('connection');
  pill.textContent = text;
  pill.className = `pill ${className}`;
}

/*//////////////////////////////*Rendering*//////////////////////////////*/

function render(data) {
  const instances = Array.isArray(data.instances) ? data.instances : [];
  const live = instances.filter((i) => !i.stale && i.status !== 'stopped');
  const quiet = instances.filter((i) => i.stale || i.status === 'stopped');

  renderSummary(instances, live, data.generatedAt);
  fill('instances', instances.map(instanceRow), 'No Chronos window is reporting.');
  fill(
    'running',
    across(live, 'activeRuns', (entry, instance) => workRow(entry, instance, 'running')),
    'Nothing is running.'
  );
  fill(
    'upcoming',
    across(live, 'upcoming', (entry, instance) => workRow(entry, instance)).slice(0, 20),
    'Nothing is queued.'
  );
  fill(
    'missed',
    across(instances, 'missed', (entry, instance) => workRow(entry, instance, 'attention'), 'newest'),
    'No missed runs.'
  );
  fill(
    'failures',
    across(instances, 'failures', (entry, instance) => workRow(entry, instance, 'attention'), 'newest'),
    'No failures in the last 24 hours.'
  );
  fill('stale', quiet.map(instanceRow), 'Every window is reporting.');
}

function renderSummary(instances, live, generatedAt) {
  const sum = (key) => instances.reduce((total, i) => total + count(i, key), 0);
  const running = sum('running');
  const missed = sum('missed');
  const failed = sum('failedRecent');
  const cost = instances.reduce((total, i) => total + numberOr(i.costLast7Days, 0), 0);

  el('sum-instances').textContent = String(instances.length);
  el('sum-instances-note').textContent = `${folderCount(instances)} folder(s)`;
  el('sum-active').textContent = String(live.length);
  el('sum-active-note').textContent = `${instances.length - live.length} stale or stopped`;
  el('sum-running').textContent = String(running);
  el('sum-missed').textContent = String(missed);
  el('sum-failed').textContent = String(failed);
  el('sum-cost').textContent = money(cost);

  el('tile-running').className = running > 0 ? 'tile hot' : 'tile';
  el('tile-missed').className = missed > 0 ? 'tile hot' : 'tile';
  el('tile-failed').className = failed > 0 ? 'tile bad' : 'tile';

  const at = Date.parse(generatedAt);
  el('refreshed').textContent = Number.isNaN(at)
    ? '—'
    : `Refreshed ${new Date(at).toLocaleTimeString()}`;
}

/** One editor window: what it is, whether it schedules, and what it is doing. */
function instanceRow(instance) {
  const running = count(instance, 'running');
  const stopped = instance.status === 'stopped';

  const row = document.createElement('div');
  row.className = ['row', running > 0 ? 'running' : '', instance.stale || stopped ? 'stale' : '']
    .filter(Boolean)
    .join(' ');

  const head = document.createElement('div');
  head.className = 'row-head';
  head.appendChild(text('div', 'name', String(instance.workspaceName || 'Unknown folder')));

  const tags = document.createElement('div');
  tags.className = 'meta';
  if (stopped) {
    tags.appendChild(text('span', 'tag', 'Stopped'));
  } else if (instance.stale) {
    tags.appendChild(text('span', 'tag bad', 'Stale'));
  } else {
    tags.appendChild(text('span', 'tag active', 'Active'));
  }
  if (instance.schedulerLeader) {
    tags.appendChild(text('span', 'tag leader', 'Scheduler'));
  }
  if (running > 0) {
    tags.appendChild(text('span', 'tag busy', `${running} running`));
  }
  head.appendChild(tags);
  row.appendChild(head);

  row.appendChild(text('div', 'path', String(instance.activeFolder || '')));

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.appendChild(text('span', '', `${count(instance, 'scheduled')} scheduled`));
  meta.appendChild(text('span', '', `Next ${when(instance.nextRunAt)}`));
  meta.appendChild(text('span', '', `Beat ${age(instance.heartbeatAgeMs)}`));
  meta.appendChild(text('span', '', money(numberOr(instance.costLast7Days, 0))));
  // Two windows on the same folder are only tellable apart by this.
  meta.appendChild(text('span', '', String(instance.instanceId)));
  row.appendChild(meta);

  return row;
}

/** One piece of work, labelled with the window it belongs to. */
function workRow(entry, instance, tone) {
  const row = document.createElement('div');
  row.className = `row ${tone || ''}`.trim();

  const head = document.createElement('div');
  head.className = 'row-head';
  head.appendChild(text('div', 'name', String(entry.planTitle || 'Untitled plan')));
  head.appendChild(text('span', 'tag', String(instance.workspaceName || '')));
  row.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.appendChild(text('span', '', when(entry.at)));
  if (entry.status) {
    meta.appendChild(text('span', '', String(entry.status)));
  }
  if (entry.attempt > 1) {
    meta.appendChild(text('span', '', `attempt ${entry.attempt}`));
  }
  if (typeof entry.costUsd === 'number') {
    meta.appendChild(text('span', '', money(entry.costUsd)));
  }
  row.appendChild(meta);

  if (entry.error) {
    row.appendChild(text('div', 'error', String(entry.error)));
  }
  return row;
}

/*//////////////////////////////*Helpers*//////////////////////////////*/

/**
 * Collects one list from every window into a single ordered column. Queued work
 * reads soonest first; what already went wrong reads newest first.
 */
function across(instances, key, build, order) {
  const direction = order === 'newest' ? -1 : 1;
  return instances
    .flatMap((instance) =>
      (Array.isArray(instance[key]) ? instance[key] : []).map((entry) => ({ entry, instance }))
    )
    .sort((a, b) => direction * String(a.entry.at).localeCompare(String(b.entry.at)))
    .map(({ entry, instance }) => build(entry, instance));
}

function fill(id, nodes, emptyText) {
  const target = el(id);
  target.replaceChildren();
  if (!nodes.length) {
    target.appendChild(text('div', 'empty', emptyText));
    return;
  }
  for (const node of nodes) {
    target.appendChild(node);
  }
}

function text(tag, className, value) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  node.textContent = value;
  return node;
}

function count(instance, key) {
  return numberOr(instance.counts && instance.counts[key], 0);
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function folderCount(instances) {
  return new Set(instances.map((i) => String(i.activeFolder || ''))).size;
}

function money(amount) {
  return `$${amount.toFixed(2)}`;
}

/** Times arrive in UTC and are only ever turned into local time here. */
function when(iso) {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return '—';
  }

  const deltaMs = at - Date.now();
  const label = new Date(at).toLocaleString();
  return deltaMs >= 0 ? `in ${duration(deltaMs)} (${label})` : `${duration(-deltaMs)} ago`;
}

function age(ms) {
  return typeof ms === 'number' ? `${duration(ms)} ago` : 'unknown';
}

function duration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

refresh();
setInterval(refresh, POLL_MS);
