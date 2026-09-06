/**
 * The Chronos instance dashboard's local server.
 *
 * Every editor window writes a small JSON heartbeat into a shared directory
 * under the user's home (see `src/dashboard-export.ts`). A browser cannot read
 * a directory, so this hands that directory over HTTP and serves the three
 * static files in `dashboard/` that draw it.
 *
 * Node built-ins only, and deliberately outside the extension: it is started by
 * hand with `npm run dashboard`, has no dependency on the TypeScript build, and
 * outlives or precedes any particular editor window. Read-only throughout —
 * nothing here can reach a schedule, cancel a run or write to a `.chronos`.
 *
 * Bound to 127.0.0.1. The instance files name real project paths, and the loop
 * back interface is the only audience that should ever see them.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 7373;
const STATIC_ROOT = path.resolve(__dirname, '..', 'dashboard');

/**
 * Kept in step with `src/dashboard-payload.ts` by a test, not by an import:
 * this file is plain JavaScript run straight from the repo, and requiring the
 * extension's build would mean the dashboard could not start until somebody had
 * compiled it.
 */
const DASHBOARD_DIR = '.chronos-dashboard';
const STALE_MS = 45_000;

/** An instance file is a status document. Anything larger is not one. */
const MAX_FILE_BYTES = 256 * 1024;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/** Where every window on this machine writes its heartbeat. */
function instancesDir(home = os.homedir()) {
  return path.join(home, DASHBOARD_DIR, 'instances');
}

/**
 * Turns a request path into a file inside `root`, or null.
 *
 * The containment check is the whole point: `..` segments, an encoded `%2e%2e`
 * and an absolute path all resolve to somewhere outside the served folder, and
 * this server runs on a developer's machine with their home directory one level
 * up. `path.resolve` normalises first, then the result has to still be under
 * the root — no falling through on a failed check.
 */
function resolveStatic(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null; // Malformed percent-encoding.
  }

  if (decoded.includes('\0')) {
    return null;
  }

  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, relative);

  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  return full;
}

/**
 * Every readable heartbeat in the directory, annotated with its age.
 *
 * A malformed file is skipped rather than fatal: the dashboard's whole job is
 * to keep showing the windows that are fine when one is not, and a heartbeat
 * caught mid-rename or written by a newer build must not take the response
 * down with it.
 *
 * Nothing is ever deleted here. An old heartbeat is marked stale and shown —
 * a window that stopped reporting while it still had work running is exactly
 * what somebody would open this page to find out about. The writing side
 * clears genuinely abandoned files.
 */
function readInstances(dir, nowMs) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // No window has exported yet, which is an empty board.
  }

  const instances = [];

  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue; // `.tmp` files are half-written by definition.
    }

    let parsed;
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      if (raw.length > MAX_FILE_BYTES) {
        continue;
      }
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== 'object' || typeof parsed.instanceId !== 'string') {
      continue;
    }

    const beatMs = Date.parse(parsed.lastHeartbeatAt);
    const ageMs = Number.isNaN(beatMs) ? null : Math.max(0, nowMs - beatMs);

    instances.push({
      ...parsed,
      heartbeatAgeMs: ageMs,
      stale: ageMs === null || ageMs > STALE_MS
    });
  }

  // Grouped by project, so two windows on one folder sit next to each other.
  instances.sort(
    (a, b) =>
      String(a.workspaceName ?? '').localeCompare(String(b.workspaceName ?? '')) ||
      String(a.instanceId).localeCompare(String(b.instanceId))
  );

  return instances;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(text);
}

function sendFile(res, file) {
  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const headers = {
    'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  };

  // Everything the page needs it already has. Nothing is fetched from
  // anywhere but this origin, so say so rather than leaving it open.
  if (path.extname(file).toLowerCase() === '.html') {
    headers['Content-Security-Policy'] =
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
      "img-src 'self' data:; base-uri 'none'; form-action 'none'";
  }

  res.writeHead(200, headers);
  res.end(body);
}

function handle(req, res) {
  // Read-only, stated at the door. Anything that could change something would
  // have to arrive as one of these, and none of them is answered.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'this dashboard is read-only' });
    return;
  }

  const url = req.url || '/';
  const route = url.split('?')[0];

  if (route === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'chronos-dashboard',
      instancesDir: instancesDir(),
      staleAfterMs: STALE_MS,
      uptimeSeconds: Math.round(process.uptime())
    });
    return;
  }

  if (route === '/api/instances') {
    const now = Date.now();
    sendJson(res, 200, {
      generatedAt: new Date(now).toISOString(),
      staleAfterMs: STALE_MS,
      instances: readInstances(instancesDir(), now)
    });
    return;
  }

  const file = resolveStatic(STATIC_ROOT, route);
  if (!file) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  sendFile(res, file);
}

function start(port) {
  const server = http.createServer(handle);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `Port ${port} is already in use. Either the dashboard is already running ` +
          `at http://${HOST}:${port}, or set CHRONOS_DASHBOARD_PORT to another port.`
      );
    } else {
      console.error(`Chronos dashboard failed to start: ${err.message}`);
    }
    process.exitCode = 1;
  });

  server.listen(port, HOST, () => {
    console.log(`Chronos dashboard: http://${HOST}:${port}`);
    console.log(`Reading instances from ${instancesDir()}`);
  });

  return server;
}

module.exports = { instancesDir, readInstances, resolveStatic, start, STALE_MS, DASHBOARD_DIR };

if (require.main === module) {
  const fromArgv = process.argv.find((arg) => arg.startsWith('--port='));
  const port =
    Number(fromArgv ? fromArgv.slice('--port='.length) : process.env.CHRONOS_DASHBOARD_PORT) ||
    DEFAULT_PORT;
  start(port);
}
