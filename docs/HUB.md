# Synchrony hub

One MCP server, over HTTP, for every project on this machine. It is the door a
remote client uses — a published board, a phone, another machine — where
`mcp-server.ts` is the door a coding agent uses. Same `.synchrony` tree, same
`mcp-actions.ts` underneath, so a live window notices a hub write exactly as it
notices any other writer.

## Run it

One command starts the hub, opens a Cloudflare quick tunnel to it and prints the
connector URL to paste into claude.ai:

```
npm run hub:up                          # default root D:\03-Software
npm run hub:up -- -Root E:\projects     # another root
```

It needs `cloudflared` on PATH (`winget install Cloudflare.cloudflared`); without
it the hub still starts, locally only. The pieces on their own:

```
npm run compile            # builds dist/hub.js alongside the extension and the MCP server
npm run hub -- --root D:\03-Software
```

Every immediate child of `--root` with a `.synchrony/` folder is an instance, named
by its folder. Add `--folder <path>` for projects elsewhere; both flags repeat.

Defaults: binds `127.0.0.1:7433`. The bearer token is read from
`SYNCHRONY_HUB_TOKEN`, else from `~/.synchrony-dashboard/hub.token`; if neither
exists one is minted, written there (mode 600) and printed once. `/healthz` is
the only unauthenticated path.

```
--port 7433   --host 127.0.0.1   --token-file <path>
```

## Tools

Every tool takes `instance` except `list_instances`.

| tool | kind | what it does |
|---|---|---|
| `list_instances` | read | live / running / next / counts for every instance |
| `list_tasks`, `list_plans`, `read_plan`, `list_schedule`, `list_runs`, `list_questions` | read | one instance's inbox, library, schedule, history, open questions |
| `add_task` | write | capture a one-line task into the inbox |
| `request_plan` | write | ask a live window to open a routed planning session for a task |
| `schedule_plan` | write | put a plan on the schedule — time, repeat, engine, model, permission mode |
| `answer_question` | write | answer what a planning session asked |

`permissionMode` is accepted here and refused on the stdio server: the token
belongs to a person, the stdio door to an agent.

## Plan requests

`request_plan` writes `<id>.json` into the instance's `.synchrony/requests/`. A
live window claims it by renaming it `<id>.claimed.json` (exactly one wins),
opens the routed planning session — questions go to `.synchrony/questions/`, where
`list_questions` / `answer_question` see them — and renames it `<id>.done.json`
with the outcome. A request written while no window is open is picked up when
one opens. The scheduler leader gets first refusal; another window takes what is
still unclaimed 1.5 s later. See `src/requests.ts` and `src/request-watcher.ts`.

## Reach it from the board

The published board calls the hub through a claude.ai custom connector, so the
hub must be reachable from the internet over HTTPS. The hub stays on loopback;
the tunnel terminates TLS.

claude.ai custom connectors authenticate with OAuth or not at all — there is no
field for a static bearer token. So the hub also accepts the token as the first
path segment, and the connector URL *is* the credential:

```
https://<your-tunnel-host>/<token>/mcp
```

The hub prints this URL (with `127.0.0.1:7433` as the host) every time it
starts. A request without the token on either the path or the header gets a
plain 404.

1. Build and start: `npm run compile`, then `npm run hub -- --root D:\03-Software`.
   Confirm `curl http://127.0.0.1:7433/healthz` answers `{"ok":true,…}`.
2. Expose it: `cloudflared tunnel --url http://127.0.0.1:7433` (or Tailscale
   Funnel, ngrok — anything that gives an HTTPS URL to port 7433). Copy the host.
3. In claude.ai → Settings → Connectors → Add custom connector: name it
   **Synchrony Hub** (the board addresses it by this exact name), URL
   `https://<tunnel-host>/<token>/mcp`. Leave the OAuth fields empty.
4. Open the board. It lists tools on load, then polls `list_instances` every
   30 s; opening an instance polls its inbox, schedule, runs and questions.

Treat the URL like a password: it is stored by claude.ai and appears in the
tunnel's access logs. Rotate it by deleting `~/.synchrony-dashboard/hub.token`
and restarting the hub, then updating the connector URL.

## Phone remote

`mobile/` is an Expo app that talks to the hub over the same MCP connection as
claude.ai, so it needs the same connector URL.

1. On the desktop: `npm run hub:up`. It prints the connector URL and, where
   `npx` and a network are available, a QR code for it.
2. On the phone: open the Synchrony app, scan the QR code or paste the URL on
   the pairing screen.

The quick tunnel gets a new random host every time `hub:up` restarts, so the
old URL stops working and re-pairing is normal — it is not a bug.

Reading — instances, tasks, plans, schedule, runs, transcripts — works with no
editor window open, served from the last heartbeat. Plan generation
(`request_plan`), cancelling a run, and changing settings all need a live
editor window; without one, writes queue on disk until a window opens, and the
app says so rather than pretending the action landed. Runs kicked off from the
phone go through the desktop scheduler, so expect up to ~30s before a `run_now`
or a newly-scheduled series actually starts.

The connector URL contains the hub token — anyone with it can read and write
through the hub exactly as the phone app does. Treat it like a password: don't
paste it anywhere public, and rotate it (see above) if it leaks.

## What is not here yet

Chaining from the hub (`after` on `schedule_plan`), `update_schedule` /
`unschedule`, and starting the hub from the extension itself.
