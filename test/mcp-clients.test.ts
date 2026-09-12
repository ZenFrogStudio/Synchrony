import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MCP_CLIENTS, McpClient, SERVER_NAME } from '../src/mcp-clients';

/**
 * The client table, driven as a table.
 *
 * Everything here is about one failure: a config that parses cleanly and points
 * at nothing. Both halves of that are silent — the client accepts the file, the
 * tools simply never appear, and there is nothing in any log to read. So the
 * paths fed in are the awkward ones on purpose: a Windows path with backslashes
 * and a space in it, which is what an install under "Program Files" or a user
 * folder called "Ada Lovelace" actually looks like.
 */

const SERVER = 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\Code\\User\\globalStorage\\z3n.synchrony\\mcp-server.js';
const FOLDER = 'D:\\03-Software\\My Project';

const byId = (id: string): McpClient => {
  const client = MCP_CLIENTS.find((c) => c.id === id);
  assert.ok(client, `there is no ${id} row in MCP_CLIENTS`);
  return client;
};

/** The rows that emit JSON. Codex is the one that does not. */
const jsonClients = MCP_CLIENTS.filter((client) => client.id !== 'codex');

describe('MCP_CLIENTS', () => {
  it('should_offer_every_client_the_readme_documents', () => {
    // Without this the table below can quietly lose a row and every other test
    // here goes on passing, because they all only check what is present.
    assert.deepEqual(
      MCP_CLIENTS.map((client) => client.id).sort(),
      [
        'claude-code',
        'claude-desktop',
        'codex',
        'cursor',
        'gemini',
        'opencode',
        'vscode',
        'windsurf'
      ]
    );
  });

  it('should_give_every_client_a_unique_id_a_label_and_a_file_to_paste_into', () => {
    // `where` is the whole answer to "and now what do I do with it" — an empty
    // one leaves the user with a snippet and nowhere to put it. A duplicate id
    // means the picker shows two rows that are impossible to tell apart.
    const ids = MCP_CLIENTS.map((client) => client.id);

    assert.equal(new Set(ids).size, ids.length, `duplicate id in ${ids.join(', ')}`);
    for (const client of MCP_CLIENTS) {
      assert.ok(client.label.trim(), `${client.id} has no label`);
      assert.ok(client.where.trim(), `${client.id} has no file to paste into`);
    }
  });

  for (const client of jsonClients) {
    it(`should_emit_parseable_json_carrying_both_paths_verbatim_for_${client.id}`, () => {
      // Round-tripping through JSON.parse is what proves the backslashes were
      // escaped: a config built by concatenation parses as `D:03-Software...`
      // or fails outright, and both are invisible until the client is started.
      const parsed = JSON.parse(client.config(SERVER, FOLDER));
      const flat = JSON.stringify(parsed);

      assert.ok(flat.includes(JSON.stringify(SERVER).slice(1, -1)), 'the server path is mangled');
      assert.ok(flat.includes(JSON.stringify(FOLDER).slice(1, -1)), 'the project folder is mangled');
    });
  }

  it('should_register_every_client_under_the_one_server_name', () => {
    // Instructions written for one client have to read correctly in another, and
    // they name the tools by their server. A row that renamed it would break
    // every "ask Synchrony what is scheduled" sentence in the README for that
    // client alone.
    for (const client of MCP_CLIENTS) {
      assert.match(
        client.config(SERVER, FOLDER),
        new RegExp(SERVER_NAME),
        `${client.id} does not register the server as "${SERVER_NAME}"`
      );
    }
  });

  it('should_key_vs_code_off_servers_rather_than_mcpServers', () => {
    // VS Code is alone in this, and alone in requiring `type`. Get either wrong
    // and the file is accepted, the server never starts, and MCP: List Servers
    // simply shows nothing.
    const parsed = JSON.parse(byId('vscode').config(SERVER, FOLDER));

    assert.ok(!('mcpServers' in parsed), 'VS Code uses `servers`, not `mcpServers`');
    assert.equal(parsed.servers[SERVER_NAME].type, 'stdio');
    assert.deepEqual(parsed.servers[SERVER_NAME].args, [SERVER, '--folder', FOLDER]);
  });

  it('should_give_opencode_the_whole_command_as_one_array', () => {
    // opencode takes no separate `args`; the executable is the first element.
    const parsed = JSON.parse(byId('opencode').config(SERVER, FOLDER));
    const entry = parsed.mcp[SERVER_NAME];

    assert.equal(entry.type, 'local');
    assert.deepEqual(entry.command, ['node', SERVER, '--folder', FOLDER]);
    assert.equal(entry.enabled, true);
  });

  it('should_emit_toml_with_a_raised_tool_timeout_for_codex', () => {
    // Codex is TOML, and its default tool timeout is 60 seconds — shorter than
    // `ask_user` waits, so without the raised value a routed planning session is
    // cut off every single time.
    const toml = byId('codex').config(SERVER, FOLDER);

    assert.match(toml, new RegExp(`\\[mcp_servers\\.${SERVER_NAME}\\]`));
    assert.match(toml, /^tool_timeout_sec = 300$/m);
    assert.ok(toml.includes(JSON.stringify([SERVER, '--folder', FOLDER])), 'args are not escaped');
  });

  it('should_raise_the_tool_timeout_for_gemini_too', () => {
    // Same problem, different unit: Gemini's `timeout` is milliseconds.
    const parsed = JSON.parse(byId('gemini').config(SERVER, FOLDER));

    assert.equal(parsed.mcpServers[SERVER_NAME].timeout, 300_000);
  });

  it('should_never_put_a_version_number_into_a_config', () => {
    // The regression this whole table exists to stop. `extensionUri` names the
    // versioned install folder, so a config written against it dies on the next
    // update with the client still reporting a healthy handshake. Handed the
    // launcher path, nothing any row emits may carry a version.
    const version = /\d+\.\d+\.\d+/;

    for (const client of MCP_CLIENTS) {
      assert.doesNotMatch(
        client.config(SERVER, FOLDER),
        version,
        `${client.id} emits a version number — its config will break on the next update`
      );
    }
  });

  it('should_quote_both_paths_in_every_cli_one_liner', () => {
    // A command line is not JSON: doubled backslashes would be passed through
    // literally, and an unquoted path with a space in it splits into two
    // arguments. Either way the server is spawned pointing at nothing.
    const withCli = MCP_CLIENTS.filter((client) => client.cli);
    assert.ok(withCli.length > 0, 'no client offers a CLI one-liner any more');

    for (const client of withCli) {
      const line = client.cli!(SERVER, FOLDER);

      assert.ok(line.includes(`"${SERVER}"`), `${client.id} does not quote the server path`);
      assert.ok(line.includes(`"${FOLDER}"`), `${client.id} does not quote the project folder`);
      assert.ok(!line.includes('\\\\'), `${client.id} escapes backslashes into a shell command`);
    }
  });
});
