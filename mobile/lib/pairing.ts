/**
 * The only gate a pasted or scanned connector URL passes through before it is
 * fetched. A QR payload is untrusted input, so this file is deliberately
 * import-free (no React, no Expo) — it compiles under `tsconfig.test.json`
 * and runs under plain Node, the same way `lib/mcp.ts` does.
 */

/** `https://<host>/<token>/mcp` — the shape `scripts/hub-up.ps1` prints. */
export function parseConnectorUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'That does not look like a URL.' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'The connector URL must start with https://.' };
  }
  if (!/^\/[^/]+\/mcp\/?$/.test(parsed.pathname)) {
    return { ok: false, reason: 'The connector URL should look like https://<host>/<token>/mcp.' };
  }
  return { ok: true, url: parsed.toString() };
}
