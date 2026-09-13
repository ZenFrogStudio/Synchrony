import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import Module from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { RequestHandler } from '../src/request-watcher';
import { listUnclaimed, requestStatus, writeRequest } from '../src/requests';
import { pathsFor, SynchronyPaths } from '../src/roots';

/**
 * The watcher is driven here the way the extension drives it — a real temp
 * directory, real request files, `restart()` — with a stub in place of the
 * window's handler. The renames are the claim, as in `requests.test.ts`, so a
 * mocked `fs` would prove nothing.
 *
 * `request-watcher.ts` reaches `vscode` through `./log`, and there is no
 * extension host here. `log` only touches `vscode` inside `initLog`, which
 * nothing below calls, so answering `require('vscode')` with an empty object
 * while the watcher loads is enough: every log line becomes a no-op. The hook
 * is restored the moment the module is in the cache.
 */
const loader = Module.prototype as unknown as { require: (this: unknown, id: string) => unknown };
const realRequire = loader.require;
loader.require = function (id) {
  return id === 'vscode' ? {} : realRequire.call(this, id);
};
const { MAX_PER_SWEEP, RequestWatcher } = require('../src/request-watcher') as typeof import('../src/request-watcher');
loader.require = realRequire;

let dir: string;
let paths: SynchronyPaths;
let watcher: InstanceType<typeof RequestWatcher> | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-request-watcher-'));
  paths = pathsFor(dir);
});

afterEach(() => {
  watcher?.dispose();
  watcher = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes `count` requests whose ids sort in the order they were written. */
function flood(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => writeRequest(paths.requests, { task: 'a.md', id: `req${String(i + 1).padStart(3, '0')}` }).id
  );
}

/** A handler that records what it was given and answers at once. */
function recorder(): { served: string[]; handle: RequestHandler } {
  const served: string[] = [];
  const handle: RequestHandler = async (request) => {
    served.push(request.id);
    return { ok: true };
  };
  return { served, handle };
}

/** Starts a leading watcher on the temp folder. Disposed by `afterEach`. */
function start(handle: RequestHandler): void {
  watcher = new RequestWatcher(() => paths, () => true, handle);
  watcher.restart();
}

/** Polls until `check` holds, or gives up after two seconds. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('request watcher — cap per sweep', () => {
  it('should_claim_no_more_than_the_cap_in_one_sweep', async () => {
    const ids = flood(MAX_PER_SWEEP + 3);
    const { served, handle } = recorder();

    start(handle);
    await until(() => served.length >= MAX_PER_SWEEP);

    assert.equal(served.length, MAX_PER_SWEEP);
    assert.deepEqual(listUnclaimed(paths.requests), ids.slice(MAX_PER_SWEEP), 'the rest are still unclaimed');
  });

  it('should_serve_the_oldest_requests_first', async () => {
    const ids = flood(MAX_PER_SWEEP + 3);
    const { served, handle } = recorder();

    start(handle);
    await until(() => served.length >= MAX_PER_SWEEP);

    assert.deepEqual(served, ids.slice(0, MAX_PER_SWEEP));
  });

  it('should_serve_everything_when_fewer_than_the_cap_are_waiting', async () => {
    const ids = flood(MAX_PER_SWEEP - 1);
    const { served, handle } = recorder();

    start(handle);
    await until(() => served.length >= ids.length);

    assert.deepEqual(served, ids);
    assert.deepEqual(listUnclaimed(paths.requests), []);
    for (const id of ids) {
      assert.equal(requestStatus(paths.requests, id), 'done');
    }
  });

  it('should_come_back_for_what_it_left_without_a_new_request_landing', async () => {
    const ids = flood(MAX_PER_SWEEP + 3);
    const { served, handle } = recorder();
    // The claims themselves fire `fs.watch` on a platform that reports a
    // rename's old name, which would mask a missing follow-up. Holding the last
    // claim of the first batch past the watcher's 200 ms debounce makes that
    // incidental sweep fire mid-loop, where the re-entrancy guard drops it — so
    // only the follow-up the loop schedules for itself is left to finish the job.
    const stalling: RequestHandler = async (request) => {
      if (served.length === MAX_PER_SWEEP - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return handle(request);
    };

    start(stalling);
    await until(() => served.length >= ids.length);

    assert.deepEqual(served, ids);
    assert.deepEqual(listUnclaimed(paths.requests), []);
  });
});
