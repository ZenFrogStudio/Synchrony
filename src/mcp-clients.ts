/**
 * The MCP clients Synchrony can hand a ready-to-paste config to.
 *
 * One flat table, modelled on `agents.ts`: a client is a label, the file its
 * config belongs in, and the shape that file wants. The command in
 * `extension.ts` picks a row and copies what it returns; nothing else knows
 * anything about any particular client.
 *
 * A table rather than one snippet, because the shapes genuinely differ and the
 * differences are not guessable. Codex wants TOML. VS Code is alone in using
 * `servers` rather than `mcpServers`, and insists on `type: "stdio"`. opencode
 * wants the whole command as one array. Hand-translating between them is exactly
 * the work this file exists to remove.
 *
 * Every value that lands in a config file is built through `JSON.stringify`
 * rather than by string concatenation. These are Windows paths full of
 * backslashes, and one unescaped backslash produces a config that parses cleanly
 * and points at nothing. JSON string escaping is also valid TOML basic-string
 * escaping, so the one rule covers both formats emitted here.
 *
 * No `vscode` import, so the tests can load it in the plain Node runner.
 */

import { mcpClientConfig } from './launch';

export interface McpClient {
  id: string;
  label: string;
  /** The file the config goes in, named exactly. Shown after copying. */
  where: string;
  /** The text to paste. JSON for most; TOML for Codex. */
  config(serverPath: string, folder: string): string;
  /** A one-line CLI that does the same job, where the client has one. */
  cli?(serverPath: string, folder: string): string;
  /** One sentence the user has to know. Omitted when there is nothing. */
  note?: string;
}

/** The key every config registers the server under, and the name the tools
 *  appear beneath in the client. One name everywhere, so instructions written
 *  for one client read correctly in another. */
export const SERVER_NAME = 'synchrony';

/**
 * The stdio entry five of the eight clients share, give or take a timeout key.
 * Named once here rather than five times in the table below: the shape is the
 * same fact repeated, and a fix applied to four of five copies is worse than no
 * fix at all.
 *
 * The shape itself comes from `mcpClientConfig`, which a planning session's own
 * `mcp.json` is built with too — same key, same command, different arguments,
 * and no way for the two to drift.
 */
function mcpServersJson(
  serverPath: string,
  folder: string,
  extra: Record<string, unknown> = {}
): string {
  return mcpClientConfig(SERVER_NAME, serverPath, ['--folder', folder], extra);
}

/**
 * A path as a shell argument — plain double quotes, not `JSON.stringify`.
 *
 * The config files above want JSON escaping; a command line does not. Neither
 * cmd.exe nor PowerShell treats a backslash as an escape inside double quotes,
 * so `JSON.stringify`'s doubled separators would be passed through literally.
 * A double quote is not a legal character in a Windows path, so quoting is all
 * that is needed here.
 */
const arg = (value: string): string => `"${value}"`;

export const MCP_CLIENTS: McpClient[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    where: '.mcp.json in the project root',
    config: mcpServersJson,
    cli: (serverPath, folder) =>
      `claude mcp add ${SERVER_NAME} -- node ${arg(serverPath)} --folder ${arg(folder)}`
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    where: 'claude_desktop_config.json',
    config: mcpServersJson,
    note:
      'On a Microsoft Store install that file lives under ' +
      '%LOCALAPPDATA%\\Packages\\…\\LocalCache\\Roaming\\Claude, not %APPDATA%\\Claude.'
  },
  {
    id: 'codex',
    label: 'Codex CLI / ChatGPT desktop',
    where: '~/.codex/config.toml',
    // The only TOML in the table. `tool_timeout_sec` is raised because Codex
    // defaults to 60 and `ask_user` waits four minutes.
    config: (serverPath, folder) =>
      [
        `[mcp_servers.${SERVER_NAME}]`,
        'command = "node"',
        `args = ${JSON.stringify([serverPath, '--folder', folder])}`,
        'tool_timeout_sec = 300'
      ].join('\n'),
    cli: (serverPath, folder) =>
      `codex mcp add ${SERVER_NAME} -- node ${arg(serverPath)} --folder ${arg(folder)}`
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    where: '~/.gemini/settings.json',
    config: (serverPath, folder) => mcpServersJson(serverPath, folder, { timeout: 300_000 })
  },
  {
    id: 'cursor',
    label: 'Cursor',
    where: '.cursor/mcp.json in the project, or ~/.cursor/mcp.json for every project',
    config: mcpServersJson
  },
  {
    id: 'vscode',
    label: 'VS Code / Copilot',
    where: '.vscode/mcp.json in the project',
    config: (serverPath, folder) =>
      JSON.stringify(
        {
          servers: {
            [SERVER_NAME]: {
              type: 'stdio',
              command: 'node',
              args: [serverPath, '--folder', folder]
            }
          }
        },
        null,
        2
      ),
    note:
      'VS Code is the one client that uses `servers` rather than `mcpServers`, and MCP tools ' +
      'only run in Agent mode.'
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    where: '~/.codeium/windsurf/mcp_config.json',
    config: mcpServersJson
  },
  {
    id: 'opencode',
    label: 'opencode',
    where: 'opencode.json in the project root',
    config: (serverPath, folder) =>
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          mcp: {
            [SERVER_NAME]: {
              type: 'local',
              command: ['node', serverPath, '--folder', folder],
              enabled: true
            }
          }
        },
        null,
        2
      )
  }
];
