import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { CLAUDE_MODELS } from '../src/agents';

/**
 * Rules about the source itself, for properties no unit test can observe.
 *
 * The CSP nonce is the case that prompted this: its only worthwhile property is
 * that an attacker cannot guess it, and nothing about a returned string proves
 * that. A test asserting two nonces differ passes for `randomBytes`, for a
 * counter and for `Math.random` alike — it cannot fail until after the bug is
 * back. Reading the source can.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const MEDIA = path.join(ROOT, 'media');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Every file in `src/` the given entry point can reach through its imports.
 *
 * A hand-written list is right until somebody adds an import, and then it is
 * quietly wrong — which is the failure mode the guards below exist to prevent,
 * so they should not depend on one. Relative specifiers only: a package import
 * is not ours to check, and `src/` is flat, so `./name` is the whole grammar.
 */
function reachableFrom(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);

    const source = fs.readFileSync(path.join(SRC, name), 'utf8');
    for (const match of source.matchAll(/from '\.\/([\w-]+)'/g)) {
      queue.push(`${match[1]}.ts`);
    }
  }

  return [...seen];
}

describe('source guards', () => {
  it('should_find_the_source_tree_it_is_meant_to_be_checking', () => {
    // Without this the greps below pass vacuously the day the layout moves.
    const files = sourceFiles(SRC);

    assert.ok(files.length > 10, `expected the src tree at ${SRC}, found ${files.length} files`);
  });

  it('should_never_call_Math_random_anywhere_in_src', () => {
    // The CSP nonce is the only guarantee that a <script> in the manager came
    // from us. Seeded from Math.random it is predictable, and the guarantee is
    // worth nothing. Nothing else in Chronos needs randomness either, so the
    // rule is a flat ban rather than a carve-out for one file.
    //
    // The call form specifically, so prose may still name it — `manager.ts`
    // carries a comment saying why the nonce does not use it. Aliasing the
    // function to evade this would defeat it; the guard is a tripwire for the
    // easy mistake, not a proof.
    const offenders = sourceFiles(SRC)
      .filter((file) => fs.readFileSync(file, 'utf8').includes('Math.random('))
      .map((file) => path.relative(SRC, file));

    assert.deepEqual(offenders, [], `use crypto.randomBytes instead: ${offenders.join(', ')}`);
  });

  it('should_replace_every_placeholder_manager_html_contains', () => {
    // render() needs a live vscode.Webview, so no unit test can watch it work.
    // An unreplaced {{name}} does not throw either — it reaches the browser as a
    // literal, and a stylesheet or script simply never loads. Reading both sides
    // catches it the moment a placeholder is added without its replaceAll.
    const html = fs.readFileSync(path.join(MEDIA, 'manager.html'), 'utf8');
    const manager = fs.readFileSync(path.join(SRC, 'manager.ts'), 'utf8');

    const missing = [...new Set(html.match(/\{\{\w+\}\}/g) ?? [])].filter(
      (token) => !manager.includes(`replaceAll('${token}'`)
    );

    assert.deepEqual(missing, [], `manager.ts never replaces: ${missing.join(', ')}`);
  });

  it('should_replace_every_placeholder_tasks_html_contains', () => {
    // The task view is rendered the same way and fails the same silently: an
    // unreplaced {{styleUri}} leaves the inbox unstyled with nothing in the log.
    const html = fs.readFileSync(path.join(MEDIA, 'tasks.html'), 'utf8');
    const tasks = fs.readFileSync(path.join(SRC, 'tasks.ts'), 'utf8');

    const missing = [...new Set(html.match(/\{\{\w+\}\}/g) ?? [])].filter(
      (token) => !tasks.includes(`replaceAll('${token}'`)
    );

    assert.deepEqual(missing, [], `tasks.ts never replaces: ${missing.join(', ')}`);
  });

  it('should_keep_the_task_view_listening_for_its_planning_terminal_closing', () => {
    // `tasks.ts` imports `vscode` and cannot load in the plain Node runner, so
    // nothing else here can watch a session end. Losing this listener fails
    // completely silently: a session backed out of holds its row amber and its
    // Generate button disabled for the life of the window, with nothing in the
    // log to say why.
    const tasks = fs.readFileSync(path.join(SRC, 'tasks.ts'), 'utf8');

    assert.ok(
      tasks.includes('onDidCloseTerminal'),
      'src/tasks.ts no longer listens for the planning terminal closing'
    );
  });

  it('should_never_schedule_a_directly_run_task_for_a_second_go', () => {
    // `createSeries` dates a new series an hour out. A task fired straight from
    // the inbox is running *now*, so its series must be born spent — otherwise
    // the same job runs again an hour later, from a plan nobody scheduled, and
    // nothing anywhere says why.
    const tasks = fs.readFileSync(path.join(SRC, 'tasks.ts'), 'utf8');

    assert.match(tasks, /spent: true/, 'src/tasks.ts no longer marks a directly-run task spent');
  });

  it('should_ship_the_codicons_the_task_view_asks_for', () => {
    // Both files, because the inbox names glyphs in two places: the rows are
    // built in JS, the Generate button is in the HTML.
    const css = fs.readFileSync(path.join(MEDIA, 'codicon.css'), 'utf8');
    const markup = ['tasks.html', 'tasks.js']
      .map((file) => fs.readFileSync(path.join(MEDIA, file), 'utf8'))
      .join('\n');

    for (const name of markup.match(/codicon-[\w-]+/g) ?? []) {
      assert.ok(css.includes(`.${name}:before`), `${name} is not in media/codicon.css`);
    }
  });

  it('should_keep_the_task_rows_looking_clickable', () => {
    // The whole row is the click target that selects a task, and the cursor is
    // the only thing that says so — nothing in the row's paint reads as a
    // control. Lose the declaration and the panel keeps working while looking
    // inert, with nothing anywhere failing to say why.
    const css = fs.readFileSync(path.join(MEDIA, 'tasks.css'), 'utf8');
    // The base rule, not `.task-row:hover` or `.task-row.is-selected` — the
    // space before the brace is what tells them apart.
    const rule = css.match(/\.task-row \{[^}]*\}/)?.[0] ?? '';

    assert.match(rule, /cursor:\s*pointer/, '.task-row no longer shows a hand cursor');
  });

  it('should_ship_the_codicon_font_the_manager_asks_for', () => {
    // The webview may only load from media/, and the .vsix excludes
    // node_modules/, so these two are vendored rather than built. If either goes
    // missing the footer buttons render as empty rectangles and nothing errors.
    for (const asset of ['codicon.css', 'codicon.ttf']) {
      assert.ok(fs.existsSync(path.join(MEDIA, asset)), `media/${asset} is missing`);
    }

    const css = fs.readFileSync(path.join(MEDIA, 'codicon.css'), 'utf8');
    // Both files, as with the task view: the footer buttons are in the HTML,
    // while the plan rows, the calendar and the run spinner are built in JS.
    const markup = ['manager.html', 'manager.js']
      .map((file) => fs.readFileSync(path.join(MEDIA, file), 'utf8'))
      .join('\n');

    // Codicon names change between releases, and a renamed one is invisible in
    // the same way — a blank glyph, no error. `codicon-modifier-*` is skipped:
    // those are behaviour classes like the spin animation, with no glyph and so
    // no `:before` rule of their own.
    for (const name of markup.match(/codicon-[\w-]+/g) ?? []) {
      if (name.startsWith('codicon-modifier-')) continue;
      assert.ok(css.includes(`.${name}:before`), `${name} is not in media/codicon.css`);
    }
  });

  it('should_keep_the_sash_defaults_in_step_with_the_stylesheet', () => {
    // The default pane sizes are written twice: as the custom-property fallback
    // the browser uses before anything is dragged, and as a constant in the
    // clamp maths. Let them drift and the panel jumps the first time you touch
    // its divider, with nothing in the log to say why.
    const js = fs.readFileSync(path.join(MEDIA, 'manager.js'), 'utf8');
    const css = fs.readFileSync(path.join(MEDIA, 'manager.css'), 'utf8');

    const constant = (name: string) => js.match(new RegExp(`${name}\\s*=\\s*(\\d+)`))?.[1];
    const fallback = (prop: string) => css.match(new RegExp(`var\\(${prop},\\s*(\\d+)px\\)`))?.[1];

    assert.equal(constant('LIBRARY_DEFAULT'), fallback('--library-width'));
    assert.equal(constant('ACTIVITY_DEFAULT'), fallback('--activity-height'));
    // Both sides matching `undefined` would pass the two above vacuously.
    assert.equal(constant('LIBRARY_DEFAULT'), '260');
    assert.equal(constant('ACTIVITY_DEFAULT'), '220');
  });

  it('should_keep_a_script_that_installs_the_build_into_vs_code', () => {
    // `package` stops at a .vsix on disk. With no step past it, a run that edits
    // this extension can typecheck, test, compile and package, and the editor
    // carries on running whatever it loaded at startup — completed work that
    // looks like it did nothing. Lose this script and that returns silently.
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    assert.ok(fs.existsSync(path.join(ROOT, 'reinstall.js')), 'reinstall.js is missing');
    assert.match(manifest.scripts.reinstall ?? '', /node reinstall\.js/);
  });

  it('should_never_name_the_install_script_after_an_npm_lifecycle_hook', () => {
    // npm runs `install`, `preinstall` and `postinstall` itself during
    // `npm install`. Renaming `reinstall` to the obvious `install` would package
    // the extension and push it into VS Code every time a dependency was added.
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    for (const hook of ['install', 'preinstall', 'postinstall']) {
      assert.ok(!(hook in manifest.scripts), `"${hook}" is an npm lifecycle hook — use "reinstall"`);
    }
  });

  it('should_name_the_vsix_from_the_manifest_rather_than_a_literal', () => {
    // The filename carries the version, so a hardcoded one installs an older
    // .vsix still sitting in the folder — the exact staleness this script is
    // here to prevent, and invisible, because the install still reports success.
    const script = fs.readFileSync(path.join(ROOT, 'reinstall.js'), 'utf8');

    assert.ok(script.includes('package.json'), 'reinstall.js must read the version');
    assert.doesNotMatch(script, /chronos-\d+\.\d+\.\d+/, 'reinstall.js hardcodes a version');
  });

  it('should_declare_every_engine_where_engine_choices_are_hardcoded', () => {
    // The manager list itself is derived from src/agents.ts, but the surfaces
    // that validate or map an engine still need explicit rows. Missing one is
    // exactly how a runnable CLI vanishes from the UI or from MCP scheduling.
    const agents = fs.readFileSync(path.join(SRC, 'agents.ts'), 'utf8');
    const server = fs.readFileSync(path.join(SRC, 'mcp-server.ts'), 'utf8');
    const manager = fs.readFileSync(path.join(MEDIA, 'manager.js'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    const ids = [...agents.matchAll(/id: '([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual(ids, [...new Set(ids)], 'src/agents.ts declares a duplicate engine id');

    const permissionTable = manager.match(/const PERMISSION_MODES = \{[\s\S]*?\n  \};/)?.[0] ?? '';
    const agentSchemas = server.match(/agent: z\.enum\(\[[^\]]+\]\)/g) ?? [];
    assert.equal(agentSchemas.length, 2, 'both MCP write tools must declare an agent enum');

    for (const id of ids) {
      assert.ok(permissionTable.includes(`${id}: [`), `media/manager.js has no permission row for ${id}`);
      for (const schema of agentSchemas) {
        assert.ok(schema.includes(`'${id}'`), `an MCP agent enum omits ${id}`);
      }
    }

    for (const match of agents.matchAll(/pathSetting: '([^']+)'/g)) {
      const key = `chronos.${match[1]}`;
      assert.ok(manifest.contributes.configuration.properties[key], `package.json omits ${key}`);
    }
  });

  it('should_keep_the_plan_model_manifest_enum_in_step_with_the_claude_model_list', () => {
    // The Tasks dropdown reads src/agents.ts, while VS Code Settings enforces
    // package.json. If the tables drift, one UI offers a value the other
    // refuses at the moment it is picked.
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const setting = manifest.contributes.configuration.properties['chronos.planModel'];

    assert.deepEqual(
      setting.enum,
      CLAUDE_MODELS.map((model) => model.value),
      'package.json chronos.planModel enum changed without src/agents.ts CLAUDE_MODELS'
    );
    assert.deepEqual(
      setting.enumDescriptions,
      CLAUDE_MODELS.map((model) => model.label),
      'package.json chronos.planModel enumDescriptions changed without src/agents.ts CLAUDE_MODELS'
    );
  });

  it('should_install_into_the_editor_this_project_is_developed_in', () => {
    // VSCodium and Microsoft's build keep separate extension folders, and the
    // `code` CLI on PATH is the latter. Installing with it succeeds, says so,
    // and leaves VSCodium on the version it already had — which is how a whole
    // evening of finished work stayed invisible. Drop codium from the list and
    // that returns, still reporting success.
    const script = fs.readFileSync(path.join(ROOT, 'reinstall.js'), 'utf8');

    assert.match(script, /'codium'/, 'reinstall.js must try the codium CLI');
  });

  it('should_wire_every_key_the_manager_documents', () => {
    // The manager's key map is written twice by necessity: once as the handlers
    // that implement it, once as the table the Settings page prints. There is no
    // DOM harness here to press a key in, so this reads both sides instead —
    // otherwise the table can silently drop off the page while the keys keep
    // working, or outlive a key that no longer does anything.
    const js = fs.readFileSync(path.join(MEDIA, 'manager.js'), 'utf8');

    const keys = [
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'Enter',
      'Escape',
      'F6'
    ];
    for (const key of keys) {
      assert.ok(js.includes(`'${key}'`), `media/manager.js never handles ${key}`);
    }

    assert.match(js, /const SHORTCUTS = \[/, 'media/manager.js has no SHORTCUTS table');

    // The call site, not merely the definition: a table nothing renders is the
    // half of this the key names above cannot catch.
    const page = js.slice(js.indexOf('function settingsPage()'));
    assert.ok(
      page.slice(0, page.indexOf('\n  }')).includes('${shortcutsSection()}'),
      'settingsPage never renders the shortcuts table'
    );
  });

  it('should_never_let_the_manager_destroy_a_series_and_its_run_history', () => {
    // Unscheduling switches a series off; it does not delete it. `removeSeries`
    // takes every run record with it (store.ts), so a webview that can still send
    // it turns one click on the main toggle into a silent loss of history.
    const js = fs.readFileSync(path.join(MEDIA, 'manager.js'), 'utf8');

    assert.ok(!js.includes('removeSeries'), 'media/manager.js can still remove a series');
  });

  it('should_declare_permission_mode_on_both_mcp_write_tools_so_it_can_be_refused', () => {
    // `mcp-tools.ts` refuses `permissionMode`, and its tests prove it does. But
    // zod strips a key the schema does not declare, so dropping this one line
    // from either tool means the argument never reaches that refusal: the call
    // succeeds, the task quietly stays `auto`, and the agent reports back that
    // it raised the permissions. Safe, and completely misleading — which is
    // worse than an error, and invisible to every unit test.
    const server = fs.readFileSync(path.join(SRC, 'mcp-server.ts'), 'utf8');

    const declarations = server.match(/permissionMode: permissionModeArg/g) ?? [];
    assert.equal(
      declarations.length,
      2,
      'schedule_plan and update_schedule must both declare permissionMode so the gate sees it'
    );

    // The declaration is only half of it: the value has to be forwarded to the
    // gate as well, or it is parsed and then dropped on the floor.
    assert.equal(
      (server.match(/'permissionMode'/g) ?? []).length,
      2,
      'both write tools must forward permissionMode to mcp-tools.ts'
    );
  });

  it('should_carry_read_write_hints_on_every_mcp_tool', () => {
    // Clients read these to decide what they can run without asking — Codex's
    // `default_tools_approval_mode = "writes"`, VS Code and Cursor all do. A tool
    // registered without them is treated as the most dangerous thing it could
    // be, so listing the schedule costs the user a prompt every time. Nothing
    // errors, and no unit test can see it: the annotations only exist in the tool
    // list a client fetches over the wire.
    const server = fs.readFileSync(path.join(SRC, 'mcp-server.ts'), 'utf8');

    // Counted at the `tool()` wrapper rather than at `registerTool`, which the
    // wrapper now calls once for all fifteen.
    const registrations = (server.match(/tool\(\s*(fullSurface|server),/g) ?? []).length;
    // The value, not the field name: `ToolSpec` declares an `annotations` field
    // too, and counting that would let one registration go without.
    const annotated = (server.match(/^\s+annotations: (READS|WRITES|\{)/gm) ?? []).length;

    assert.ok(registrations > 0, 'src/mcp-server.ts registers no tools at all');
    assert.equal(
      annotated,
      registrations,
      `${registrations} tools are registered but ${annotated} carry annotations`
    );

    // The hints have to say something, not merely be present. Unschedule is the
    // one call that destroys anything — it drops a series and its run history —
    // and a client that is not told so will wave it through.
    assert.match(server, /destructiveHint: true/, 'nothing is marked destructive any more');
    assert.match(server, /readOnlyHint: true/, 'nothing is marked read-only any more');
  });

  it('should_close_up_the_chain_when_the_mcp_server_unschedules_a_series', () => {
    // There are two paths that remove a series — the manager's `removeSeries`
    // and this tool — and only the store's is covered by a unit test, because
    // `mcp-server.ts` reads and writes the state file itself and no test here
    // can call into it. Drop the splice from this side and the failure is
    // almost entirely silent: the plan immediately behind the removed one is
    // switched off with one notification, and everything behind *that* parks
    // forever with none at all. `test/chain.test.ts` proves `spliceChain`
    // works; this proves the tool still calls it.
    const server = fs.readFileSync(path.join(SRC, 'mcp-server.ts'), 'utf8');

    assert.match(
      server,
      /import \{[^}]*\bspliceChain\b[^}]*\} from '\.\/chain'/,
      "src/mcp-server.ts no longer imports spliceChain from './chain'"
    );

    const start = server.indexOf("'unschedule'");
    assert.ok(start > 0, 'src/mcp-server.ts no longer registers unschedule');
    const handler = server.slice(start, server.indexOf('\n);', start));

    assert.ok(
      handler.includes('spliceChain('),
      'the unschedule handler must splice the chain, or its followers wait on a series that is gone'
    );
  });

  it('should_hand_out_the_update_proof_mcp_path_rather_than_the_versioned_one', () => {
    // `extensionUri` names the folder VS Code installed *this version* into, so
    // a config copied from it stops working the next time Chronos updates. The
    // client goes on spawning a file that is no longer there and reports a
    // perfectly healthy failure to connect, which nobody traces back to an
    // update. The launcher under globalStorage is the path that survives.
    const extension = fs.readFileSync(path.join(SRC, 'extension.ts'), 'utf8');

    const start = extension.indexOf('async function copyMcpConfig');
    assert.ok(start > 0, 'src/extension.ts no longer defines copyMcpConfig');
    const body = extension.slice(start, extension.indexOf('\n}', start));

    assert.ok(
      !body.includes("'dist', 'mcp-server.js'"),
      'copyMcpConfig must take its path from mcpLauncherPath, not build a versioned one'
    );
    assert.match(
      extension,
      /const mcpLauncher = mcpLauncherPath\(context\)/,
      'activate() no longer writes the MCP launcher, so it never re-points after an update'
    );
    assert.ok(
      extension.includes('globalStorageUri'),
      'the launcher must live under globalStorage, which is not keyed by version'
    );
  });

  it('should_follow_the_mcp_server_imports_it_is_meant_to_be_checking', () => {
    // Without this the two guards below pass vacuously the day the import
    // regex stops matching — the same reasoning as the src tree check above.
    const reachable = reachableFrom('mcp-server.ts');

    assert.ok(
      reachable.length > 8,
      `expected the server's imports, followed only ${reachable.length} files`
    );
  });

  it('should_never_write_to_stdout_from_the_mcp_server', () => {
    // stdout *is* the JSON-RPC transport. One `console.log` anywhere on this
    // side interleaves with a reply and corrupts the protocol mid-session —
    // the client sees a parse error, not a message it can trace to a log line.
    // stderr is the channel; `note()` is the only way to it.
    //
    // Every module the server pulls in, not just the entry point: most of them
    // are shared with the extension, where a debug line is harmless and where
    // nobody adding one is thinking about this process at all.
    for (const name of reachableFrom('mcp-server.ts')) {
      const source = fs.readFileSync(path.join(SRC, name), 'utf8');
      for (const banned of ['console.log(', 'console.info(', 'process.stdout.write(']) {
        assert.ok(!source.includes(banned), `src/${name} calls ${banned} — use note()`);
      }
    }
  });

  it('should_take_the_mcp_server_version_from_the_build_rather_than_a_literal', () => {
    // A hand-written version is wrong in a way that still compiles and still
    // runs, so no unit test can catch it: the server simply announces a number
    // it is not to every client that connects, and the one place anybody looks
    // to work out which build is running says something untrue.
    const server = fs.readFileSync(path.join(SRC, 'mcp-server.ts'), 'utf8');
    const build = fs.readFileSync(path.join(ROOT, 'esbuild.js'), 'utf8');

    assert.ok(
      server.includes('process.env.CHRONOS_VERSION'),
      'src/mcp-server.ts must take its version from the build'
    );
    assert.doesNotMatch(server, /const VERSION = '\d/, 'src/mcp-server.ts hardcodes a version');
    // Both halves: the reader is useless without the stamp, and the stamp is
    // useless without the reader.
    assert.ok(
      build.includes('process.env.CHRONOS_VERSION'),
      'esbuild.js no longer defines CHRONOS_VERSION, so the server falls back to 0.0.0-dev'
    );
  });

  it('should_keep_the_mcp_server_free_of_vscode', () => {
    // The server is a plain Node process an agent spawns; there is no extension
    // host to provide `vscode`. An import of it — or of any module that reaches
    // it — builds fine and then throws MODULE_NOT_FOUND at the client's first
    // connection attempt. esbuild catches the direct case, this catches the
    // transitive one before the build does.
    //
    // `mcp-clients.ts` is added for the sibling reason: nothing spawns it, and
    // the server does not import it, but the plain Node test runner loads it,
    // and an import of `vscode` there takes its whole test file down rather
    // than failing one assertion.
    const reachable = [...new Set([...reachableFrom('mcp-server.ts'), 'mcp-clients.ts'])];

    for (const name of reachable) {
      const source = fs.readFileSync(path.join(SRC, name), 'utf8');
      assert.ok(
        !/from '(vscode)'|require\('vscode'\)/.test(source),
        `src/${name} imports vscode, so the MCP server cannot load it`
      );
    }
  });

  it('should_register_every_tool_a_planning_session_is_allowed_to_call', () => {
    // `ASK_TOOLS` is both the `--allowedTools` allowlist and the wording of the
    // instruction. Rename a tool in `mcp-server.ts` without changing it and the
    // allowlist points at nothing: the session calls a tool that does not
    // exist, or sits on a permission prompt nobody is there to answer, with
    // nothing in any log to say why. No unit test can see that — the two sides
    // are a string constant and a registration in another process.
    const server = fs.readFileSync(path.join(SRC, 'mcp-server.ts'), 'utf8');
    const launch = fs.readFileSync(path.join(SRC, 'launch.ts'), 'utf8');

    const names = launch.match(/export const ASK_TOOLS = \[([^\]]*)\]/)?.[1];
    assert.ok(names, 'src/launch.ts no longer declares ASK_TOOLS');

    const tools = [...names.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(tools, ['ask_user', 'submit_plan'], 'ASK_TOOLS changed — check both sides');

    for (const tool of tools) {
      assert.match(
        server,
        new RegExp(`tool\\(\\s*server,\\s*'${tool}'`),
        `src/mcp-server.ts never registers ${tool}, so the allowlist points at nothing`
      );
    }
  });

  it('should_keep_the_ask_server_name_the_same_on_both_sides_of_the_spawn', () => {
    // `launch.ts` puts this name into every allowlisted tool id; `tasks.ts`
    // writes the `mcp.json` key the CLI matches them against. A mismatch means
    // the tools are registered under one name and allowlisted under another.
    const launch = fs.readFileSync(path.join(SRC, 'launch.ts'), 'utf8');
    const tasks = fs.readFileSync(path.join(SRC, 'tasks.ts'), 'utf8');

    assert.match(launch, /export const ASK_SERVER = 'chronos-ask'/);
    assert.match(
      tasks,
      /mcpClientConfig\(\s*ASK_SERVER/,
      'src/tasks.ts must key its mcp.json off ASK_SERVER rather than a literal'
    );
    // The key itself is built inside `mcpClientConfig` now, so this is the other
    // half of the same rule: the builder must use the name it was handed.
    assert.match(
      launch,
      /mcpServers: \{ \[name\]:/,
      'src/launch.ts must build the server key from its name argument'
    );
  });

  it('should_never_let_a_routed_planning_session_reach_the_scheduler', () => {
    // The session runs unattended by design. `--ask-only` is what withholds
    // `schedule_plan` and the rest of the write surface from it; drop it from
    // the spawn and an overnight planning session could put its own work on the
    // schedule, in a mode nobody chose.
    const tasks = fs.readFileSync(path.join(SRC, 'tasks.ts'), 'utf8');

    assert.ok(tasks.includes("'--ask-only'"), 'src/tasks.ts no longer spawns with --ask-only');
  });

  it('should_reload_the_schedule_before_deciding_what_to_archive', () => {
    // The sweep moves plan files from what the schedule says, and the store only
    // re-reads on its own writes. Set Repeat = Daily in a second window on this
    // folder and this window can still hold `recurrence: null` when a run
    // finishes — archiving a plan that now repeats. A file move is not covered
    // by the read-modify-write that protects every field write, so nothing
    // downstream would catch it. Only a live two-window session could show the
    // ordering, which is why it is read out of the source here.
    const extension = fs.readFileSync(path.join(SRC, 'extension.ts'), 'utf8');

    const start = extension.indexOf('const retire =');
    assert.ok(start > 0, 'src/extension.ts no longer defines the retire thunk');
    const thunk = extension.slice(start, extension.indexOf('};', start));

    const reload = thunk.indexOf('store.reload()');
    const sweep = thunk.indexOf('retireCompletedPlans(');
    assert.ok(reload > -1, 'the retire thunk no longer re-reads the schedule first');
    assert.ok(reload < sweep, 'store.reload() must come before retireCompletedPlans()');
  });

  it('should_rebuild_the_plan_list_when_an_already_open_manager_is_reopened', () => {
    // `open()` on a tab that already exists used to reveal it and return, which
    // left the plan list as whatever was last posted. A plan adopted from a
    // planning session lands exactly then — the task view calls `open()` and
    // `reveal()` the moment the file reaches the library — so the new plan
    // appeared only if `fs.watch` happened to catch it, and `reveal()` then
    // selected a row the panel did not have. Nothing errors when it fails: the
    // panel simply shows yesterday's library. `manager.ts` imports `vscode`, so
    // reading the source is the only place this can be checked.
    const manager = fs.readFileSync(path.join(SRC, 'manager.ts'), 'utf8');

    const start = manager.indexOf('open(preserveFocus = false): void {');
    assert.ok(start > 0, 'src/manager.ts no longer defines open()');
    // The early-return branch only — the freshly created panel posts on `ready`.
    const branch = manager.slice(start, manager.indexOf('return;', start));

    assert.ok(
      branch.includes('this.post()'),
      'open() must re-post state when the manager tab is already open'
    );
  });

  it('should_ship_a_sash_element_for_every_sash_rule', () => {
    // The dividers are found by id, styled by class and never rendered by JS, so
    // a renamed id leaves the CSS styling nothing and the drag silently dead.
    const html = fs.readFileSync(path.join(MEDIA, 'manager.html'), 'utf8');
    const js = fs.readFileSync(path.join(MEDIA, 'manager.js'), 'utf8');

    for (const id of ['library-sash', 'activity-sash']) {
      assert.ok(html.includes(`id="${id}"`), `media/manager.html has no #${id}`);
      assert.ok(js.includes(`'${id}'`), `media/manager.js never looks up #${id}`);
    }
  });

  it('should_keep_the_header_mark_wired_from_the_host_to_the_page', () => {
    // The mark reaches the page through three string literals in three files —
    // the filename in manager.ts, the {{markUri}} meta tag in manager.html, and
    // the lookup in manager.js. Break any one and the plan panel's header
    // renders an empty 40px box: nothing throws, nothing else fails, and the
    // countdown ring that used to stand there most of the time is gone, so
    // there is no longer anything covering for it.
    assert.ok(fs.existsSync(path.join(MEDIA, 'icon.png')), 'media/icon.png is missing');

    const manager = fs.readFileSync(path.join(SRC, 'manager.ts'), 'utf8');
    const html = fs.readFileSync(path.join(MEDIA, 'manager.html'), 'utf8');
    const js = fs.readFileSync(path.join(MEDIA, 'manager.js'), 'utf8');

    assert.ok(manager.includes("'{{markUri}}'"), 'src/manager.ts no longer replaces {{markUri}}');
    assert.ok(
      manager.includes("mediaUri('icon.png')"),
      'src/manager.ts no longer points {{markUri}} at media/icon.png'
    );
    assert.ok(html.includes('name="chronos-mark"'), 'media/manager.html has no chronos-mark meta');
    assert.ok(html.includes('{{markUri}}'), 'media/manager.html never carries the mark URI');
    assert.ok(
      js.includes('meta[name="chronos-mark"]'),
      'media/manager.js no longer reads the mark URI out of the page'
    );
    assert.ok(js.includes('class="head-mark'), 'media/manager.js never renders the header mark');
  });

  it('should_keep_the_plan_text_box_flexing_with_its_pane', () => {
    // The box fills the detail pane by CSS alone, driven by classes written into
    // a template string. Renaming either side reverts it to a fixed-height box
    // with nothing thrown and no other test failing.
    const css = fs.readFileSync(path.join(MEDIA, 'manager.css'), 'utf8');
    const js = fs.readFileSync(path.join(MEDIA, 'manager.js'), 'utf8');

    for (const cls of ['section is-editor', 'detail-lower']) {
      assert.ok(js.includes(cls), `media/manager.js never renders .${cls}`);
    }

    for (const rule of [
      '.section.is-editor',
      '.section.is-editor.is-manual .editor',
      '.detail-lower',
    ]) {
      assert.ok(css.includes(rule), `media/manager.css has no ${rule} rule`);
    }

    assert.ok(js.includes('is-manual'), 'media/manager.js never sets .is-manual');
    assert.match(
      css,
      /\.detail\s*\{[^}]*flex-direction:\s*column/,
      '.detail must be a flex column or the box cannot stretch'
    );
  });
});
