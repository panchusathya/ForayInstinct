# browser-gateway

Always-on Node service that fronts Brightdata's Browser API for the main app.
Brightdata hands out a CDP endpoint whose browser session lives only while its
CDP WebSocket stays open (5-minute idle timeout upstream, roughly 30-60 minutes
max). Vercel serverless cannot hold sockets, so this gateway holds
`playwright-core` `connectOverCDP` connections in memory, keyed by generated
session ids, and exposes an authenticated JSON HTTP API. The wire contract is
the repo-root `lib/browser/contract.ts` — both sides import the same zod
schemas.

## Environment

| Variable                 | Required | Purpose                                              |
| ------------------------ | -------- | ---------------------------------------------------- |
| `BRIGHTDATA_CUSTOMER_ID` | yes      | Brightdata account id (`brd-customer-<ID>-...`)      |
| `BRIGHTDATA_ZONE`        | yes      | Browser API zone name                                |
| `BRIGHTDATA_PASSWORD`    | yes      | Zone password                                        |
| `GATEWAY_AUTH_SECRET`    | yes      | Bearer token every route except `GET /health` checks |
| `PORT`                   | no       | Listen port, default `8080`                          |

All four secrets are validated at boot; the process refuses to start without
them. The CDP endpoint is built as
`wss://brd-customer-<ID>-zone-<ZONE>:<PASSWORD>@brd.superproxy.io:9222`.

## Routes

- `GET /health` — unauthenticated; `{ok, sessions, draining}`.
- `POST /sessions` — create; `GET /sessions`, `GET /sessions/:id`,
  `DELETE /sessions/:id` (idempotent, returns the exported storage state).
- `GET /sessions/:id/storage-state`
- `POST /sessions/:id/playwright` — evals model-authored code (see security).
- `POST /sessions/:id/actions` — Kernel-style computer actions.
- `POST /sessions/:id/screenshot` — viewport / full_page / review_slices.
- `POST /sessions/:id/files` — stages a file at the caller-chosen
  `/tmp/goforay-*` or `/tmp/workspace-*` path.
- `POST /sessions/:id/cdp-targets`, `POST /sessions/:id/cdp` — flat CDP
  passthrough via short-lived opaque refs.
- `POST /admin/drain` — refuse new sessions ahead of a deploy.

A session missing from the registry is `404 session_not_found`; one the
registry still remembers but whose browser died is `410 session_gone` (or
`cross_domain_navigation` with the domains involved when a registrable-domain
hop was the recorded cause — Brightdata terminates sessions on those). Dead
entries are kept for 10 minutes so the app can observe the death, then evicted.

## Run locally

```sh
pnpm --dir services/browser-gateway install
BRIGHTDATA_CUSTOMER_ID=... BRIGHTDATA_ZONE=... BRIGHTDATA_PASSWORD=... \
GATEWAY_AUTH_SECRET=... pnpm --dir services/browser-gateway dev
pnpm --dir services/browser-gateway test
pnpm --dir services/browser-gateway types:check
```

The file-staging route writes to literal `/tmp/goforay-*` / `/tmp/workspace-*`
paths because the app's stage tools assert those exact prefixes in their output
contracts — the gateway must run on Linux for that contract to hold (locally on
Windows the paths land on the current drive; fine for everything but staging).

## Deploy (Railway — recommended, no CLI needed)

The repo-root `railway.json` already tells Railway how to build this service
(the Dockerfile, repo-root build context so `lib/browser/contract.ts` is
included, `/health` checks, one replica, no app sleep). Steps, all in the
browser:

1. Sign in at railway.com (GitHub login) and create a project → **Deploy from
   GitHub repo** → pick this repository. Leave **Root Directory** as `/`.
2. On the new service, open **Variables** and add the four secrets:
   `BRIGHTDATA_CUSTOMER_ID`, `BRIGHTDATA_ZONE`, `BRIGHTDATA_PASSWORD` (all
   three from the Brightdata dashboard's Browser API zone), and
   `GATEWAY_AUTH_SECRET` (generate one: `openssl rand -base64 32`, or any long
   random string). Railway supplies `PORT` itself.
3. It deploys on save. Open **Settings → Networking → Generate Domain** to get
   the public URL, e.g. `https://foray-browser-gateway.up.railway.app`.
4. Verify: `https://<that-domain>/health` should return
   `{"ok":true,"sessions":0,"draining":false}`.
5. On Vercel, set `BROWSER_GATEWAY_URL` to that domain and
   `BROWSER_GATEWAY_SECRET` to the same value as `GATEWAY_AUTH_SECRET`.

Keep it at exactly **one replica with app sleep off** (the config pins both):
sessions are in-process state, so a second replica would split the registry and
a slept instance would kill every live browser. Railway redeploys on every push
to the connected branch — see the drain discipline below, or point the service
at a branch you promote deliberately.

## Deploy (Fly.io, alternative)

From the **repo root** (the Docker build context must include
`lib/browser/contract.ts`):

```sh
fly apps create foray-browser-gateway   # once
fly secrets set --config services/browser-gateway/fly.toml \
  BRIGHTDATA_CUSTOMER_ID=... BRIGHTDATA_ZONE=... \
  BRIGHTDATA_PASSWORD=... GATEWAY_AUTH_SECRET=...
fly deploy --config services/browser-gateway/fly.toml \
  --dockerfile services/browser-gateway/Dockerfile .
fly scale count 1 --config services/browser-gateway/fly.toml   # exactly one machine
```

Keep it at a single always-on machine (`min_machines_running = 1`,
`auto_stop_machines = false`) for the same single-registry reason.

### Drain-on-deploy discipline

A deploy replaces the machine and severs every held CDP WebSocket, killing all
live sessions. Before deploying:

1. `POST /admin/drain` (authenticated) — the gateway starts refusing new
   session creates with `503 gateway_error`.
2. Wait for `GET /health` to report `sessions: 0` (or accept killing the rest).
3. Deploy (push the branch on Railway, or `fly deploy ...` as above).

## Security

This service **intentionally evaluates model-authored JavaScript** in-process
(`POST /sessions/:id/playwright` compiles the request body with
`AsyncFunction`). Treat the whole machine as being at the mercy of whoever
holds `GATEWAY_AUTH_SECRET`:

- Never co-host other services or secrets on this app. The only secrets that
  belong here are the Brightdata credentials and the gateway's own auth token.
- Keep `GATEWAY_AUTH_SECRET` long and random; it is the entire access control.
- The eval exists to preserve Kernel's `browsers.playwright.execute` contract
  byte-for-byte; do not "harden" it with sandboxing that changes semantics —
  isolate at the machine boundary instead.
