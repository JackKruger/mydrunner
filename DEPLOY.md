# Deploying mydrunner

Two deployable pieces, both deployed from **`main`**:

- **Server** (`packages/server`) — Node WebSocket process. Deployed to
  **Railway** (auto-deploys on push to `main` via Railway's GitHub
  integration).
- **Client** (`packages/client`) — static Vite SPA. Deployed to
  **GitHub Pages** (auto-deploys on push to `main` via
  `.github/workflows/deploy.yml`).

End-to-end: push to `main` → server redeploys on Railway in ~2 min, client
redeploys to Pages in ~1–2 min. Other branches deploy nothing; CI still
runs on them.

## What is configured where

### Railway

Project `dependable-enjoyment`, environment `production`, service
`mydrunner-server`
([dashboard](https://railway.com/project/3871a3c4-d56e-4eeb-9e32-6d78aa4c7a9b)).

The service's build and deploy settings live on the service itself, not
in the repo. There used to be a `railway.json` ("Config as Code"); Railway
stops reading those on 2026-12-01, so its contents were copied onto the
service and the file was deleted. Current values:

| Setting | Value |
| --- | --- |
| Source | `JackKruger/mydrunner`, branch `main` |
| Wait for CI | off |
| Root directory | repo root (the Dockerfile needs the workspace files) |
| Dockerfile path | `packages/server/Dockerfile` (Railway always builds with a Dockerfile it finds) |
| Start command | `pnpm --filter @mydrunner/server run start` |
| Healthcheck | `/health`, 30 s timeout |
| Restart policy | on failure, max 5 retries |
| Serverless (sleep when idle) | on — required on the free plan |
| Watch paths | none (every push to `main` rebuilds the server) |
| Public domain | `mydrunner-server-production.up.railway.app` (Railway terminates TLS) |

To change them: the dashboard (service → Settings), or the Railway CLI
from a linked checkout (`railway link`, then `railway api` /
`railway status`). `railway config migrate` can generate a
`.railway/railway.ts` (Railway's Infrastructure as Code) if the settings
should ever live in the repo again.

### GitHub

- **Secret** `PUBLIC_SERVER_URL` = `wss://mydrunner-server-production.up.railway.app`.
  The client build bakes it in as `VITE_SERVER_URL`.
- **Pages** source = "GitHub Actions".
- **Environment** `github-pages` only accepts deployments from `main`.

## Setting it up from scratch

1. [railway.com](https://railway.com/) → **New Project → Deploy from GitHub
   repo** → `JackKruger/mydrunner`, branch `main`.
2. Service → **Settings**: set the values in the table above.
3. **Settings → Networking → Generate Domain**. The WebSocket URL is
   `wss://<that-domain>`.
4. GitHub → Settings → **Secrets and variables → Actions**: set
   `PUBLIC_SERVER_URL` to that URL. Settings → **Pages**: Source =
   "GitHub Actions".

## Running the deploy locally

Server (container):

```bash
podman build -f packages/server/Dockerfile -t mydrunner-server .
podman run -p 127.0.0.1:2567:2567 mydrunner-server
```

Client (static):

```bash
VITE_SERVER_URL=wss://mydrunner-server-production.up.railway.app \
  VITE_BASE=/mydrunner/ \
  pnpm --filter @mydrunner/client run build
# Output is in packages/client/dist - serve it with any static host.
```

## Cost / scale notes

- The service runs on Railway's free plan, which requires it to sleep when
  idle. The first connection after a quiet spell wakes it (a few seconds).
- The server image is small (~250MB) and uses ~80MB RAM at idle.
- For >10 concurrent players, move to a paid Railway plan or upgrade the
  instance size in the service settings.
- GitHub Pages is free for public repos.

## Alternative: Fly.io

The repo also has `fly.toml` and a Fly-compatible Dockerfile, in case you
want to switch back. To deploy on Fly:

```bash
flyctl auth login
flyctl apps create mydrunner-server
flyctl deploy
flyctl tokens create deploy -x 999999h
# Then add FLY_API_TOKEN to repo secrets and re-add a Fly deploy job to
# .github/workflows/deploy.yml.
```

Fly's free tier is more aggressive about sleeping the server (which
disconnects WS clients). Railway's "auto-sleep" is gentler.

## CI

`.github/workflows/ci.yml` runs typecheck + build + unit tests on every
push, regardless of branch, and on pull requests. Playwright e2e runs only
when the repo variable `RUN_TESTS` is `true`. Railway does not wait
for it before deploying.
