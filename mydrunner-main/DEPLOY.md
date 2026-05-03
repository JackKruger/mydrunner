# Deploying mydrunner

Two deployable pieces:

- **Server** (`packages/server`) — Node WebSocket process. Deployed to
  **Railway** (auto-deploys on push via Railway's GitHub integration).
- **Client** (`packages/client`) — static Vite SPA. Deployed to
  **GitHub Pages** (auto-deploys on push via `.github/workflows/deploy.yml`).

End-to-end: push → server redeploys on Railway in ~2 min, client redeploys
to Pages in ~1 min.

## Setup checklist (all web UI)

### 1. Create the Railway service

1. Go to [railway.app](https://railway.app/) and sign in with GitHub.
2. **New Project → Deploy from GitHub repo** → pick `JackKruger/mydrunner`.
3. Railway detects `railway.json` at the repo root and uses
   `packages/server/Dockerfile`. Build context is the monorepo root so it
   can see the workspace files.
4. After the first build, open the service → **Settings → Networking → Generate
   Domain**. You'll get a URL like `mydrunner-server-production.up.railway.app`.
   The WebSocket URL is `wss://<that-domain>` (Railway terminates TLS).
5. (Optional) **Settings → Service → Watch Paths** → set to
   `packages/server/**` and `packages/shared/**` so unrelated commits
   (e.g. client-only changes) don't trigger a server rebuild.

### 2. GitHub repo configuration

Settings → **Secrets and variables → Actions → New repository secret**:

- `PUBLIC_SERVER_URL` = `wss://<your-railway-domain>` (from step 1.4).

Settings → **Pages**:

- **Source** = "GitHub Actions".

That's it. Push a commit; Railway redeploys the server, the deploy
workflow publishes the client to Pages.

## Running the deploy locally

Server (Docker):

```bash
docker build -f packages/server/Dockerfile -t mydrunner-server .
docker run -p 2567:2567 mydrunner-server
```

Client (static):

```bash
VITE_SERVER_URL=wss://your-railway-domain.up.railway.app \
  VITE_BASE=/mydrunner/ \
  pnpm --filter @mydrunner/client run build
# Output is in packages/client/dist - serve it with any static host.
```

## Cost / scale notes

- Railway free trial covers the basic instance Mydrunner needs ($5/mo
  starter plan after that, or $0 with their sleeping-services tier).
- The server image is small (~250MB) and uses ~80MB RAM at idle.
- For >10 concurrent players, bump to Railway's "Pro" plan or upgrade
  the instance size in the service settings.
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

`.github/workflows/ci.yml` runs typecheck + unit + Playwright tests on
every push, regardless of branch. Screenshot artifacts are uploaded so
you can inspect the visual state of any commit.
