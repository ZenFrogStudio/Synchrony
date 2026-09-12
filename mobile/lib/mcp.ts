/**
 * A dependency-free MCP-over-HTTP client, speaking the same JSON-RPC 2.0
 * "Streamable HTTP" transport `scripts/hub-smoke.mjs` drives against
 * `src/hub.ts`: POST every message to the connector URL, echo back whatever
 * `mcp-session-id` the server hands out, and accept either a plain JSON body
 * or one `data:` line of SSE — the hub picks whichever the SDK feels like
 * that call.
 *
 * No React or Expo imports here on purpose: this file has to compile and run
 * under plain Node for `mobile/test/mcp.test.mjs`, with nothing mocked.
 */

const PROTOCOL_VERSION = '2025-06-18';

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpError';
  }
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

interface ToolCallResult {
  text: string;
  isError: boolean;
}

export interface HealthInfo {
  ok: boolean;
  version: string;
  instances: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `<origin>/healthz` for a connector URL of the form `https://host/<token>/mcp`. */
export function healthUrl(pairUrl: string): string {
  return `${new URL(pairUrl).origin}/healthz`;
}

/** Fetches `<origin>/healthz` for a connector URL. Throws `McpError` on any failure. */
export async function checkHealth(pairUrl: string): Promise<HealthInfo> {
  let res: Response;
  try {
    res = await fetch(healthUrl(pairUrl));
  } catch (err) {
    throw new McpError(
      `Could not reach the desktop at all. Check "npm run hub:up" is still running there. (${errorMessage(err)})`
    );
  }
  if (!res.ok) {
    throw new McpError(
      `The desktop answered but with HTTP ${res.status} — the tunnel URL may be stale. Re-pair with a fresh URL from "npm run hub:up".`
    );
  }
  return (await res.json()) as HealthInfo;
}

export class McpClient {
  private readonly url: string;
  private sessionId: string | undefined;
  private nextId = 1;

  constructor(connectorUrl: string) {
    this.url = connectorUrl;
  }

  /** The host name only, never the token — for display, e.g. a paired-desktop header. */
  get host(): string {
    return new URL(this.url).host;
  }

  async initialize(): Promise<void> {
    await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'synchrony-mobile', version: '0.0.0' }
      }
    });
    await this.post(
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { notification: true }
    );
  }

  async call(name: string, args: object): Promise<ToolCallResult> {
    const result = (await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args }
    })) as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;
    return { text: result?.content?.[0]?.text ?? '', isError: Boolean(result?.isError) };
  }

  async callJson<T>(name: string, args: object): Promise<T> {
    const { text, isError } = await this.call(name, args);
    if (isError) {
      throw new McpError(text || `${name} was refused.`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new McpError(`${name} did not return valid JSON.`);
    }
  }

  private async post(
    body: Record<string, unknown>,
    opts: { notification?: boolean } = {}
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    let res: Response;
    try {
      res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (err) {
      throw new McpError(
        `Could not reach the hub — the tunnel may be down or the URL stale. Re-pair with a fresh URL from "npm run hub:up". (${errorMessage(err)})`
      );
    }

    const returnedSession = res.headers.get('mcp-session-id');
    if (returnedSession) this.sessionId = returnedSession;

    if (opts.notification) {
      if (!res.ok) {
        throw new McpError(`The hub rejected the connection (HTTP ${res.status}).`);
      }
      await res.text();
      return undefined;
    }

    if (!res.ok) {
      if (res.status === 404) {
        throw new McpError(
          'The hub said "not found" (404) — the tunnel URL is likely stale or the token is wrong. Re-pair with a fresh URL from "npm run hub:up".'
        );
      }
      throw new McpError(`The hub returned HTTP ${res.status}.`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    let message: JsonRpcResponse;
    if (contentType.includes('application/json')) {
      message = (await res.json()) as JsonRpcResponse;
    } else if (contentType.includes('text/event-stream')) {
      const text = await res.text();
      const dataLines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'));
      if (!dataLines.length) {
        throw new McpError('The hub sent an empty response.');
      }
      try {
        message = JSON.parse(dataLines[dataLines.length - 1].slice('data:'.length).trim()) as JsonRpcResponse;
      } catch {
        throw new McpError('The hub sent a response that could not be parsed.');
      }
    } else {
      throw new McpError(`The hub sent an unexpected content type: "${contentType}".`);
    }

    if (message.error) {
      throw new McpError(message.error.message || 'The hub returned an error.');
    }
    return message.result;
  }
}
