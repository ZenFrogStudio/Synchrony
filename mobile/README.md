# Chronos phone remote

An Expo app that talks to the [hub](../docs/HUB.md) over the same MCP
connection claude.ai uses — read every instance's tasks, plans, schedule and
run history, and write to them, from a phone.

## Run it

```
cd mobile
npx expo start
```

Scan the printed QR code with the **Expo Go** app (iOS or Android) to load it
on a phone, or press `a` / `i` in the terminal for an emulator.

## Pair it

On the desktop, from the repo root:

```
npm run hub:up
```

This starts the hub, opens a tunnel to it, and prints a connector URL
(`https://<host>/<token>/mcp`) plus a QR code for it. On the pairing screen in
the app, scan that QR code or paste the URL. The tunnel gets a new host every
time `hub:up` restarts, so re-pairing after a restart is expected, not an
error.

See [`docs/HUB.md`](../docs/HUB.md) for what needs a live editor window,
write latency, and why the connector URL must be treated as a secret.

## Test

```
npm run typecheck
npm test
```

`npm test` compiles the test sources with `tsconfig.test.json` and runs them
under Node's built-in test runner (`node --test dist-test/`) — no device or
emulator required.
