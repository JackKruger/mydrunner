# Deploying mydrunner

The architecture has two deployable pieces:

- **Server** (`packages/server`) — Node process holding WebSocket connections.
  Deployed as a Docker container to Fly.io.
- **Client** (`packages/client`) — static Vite SPA. Deployed to GitHub Pages.

Once the secrets below are set, every push to `main` (or the active dev branch
listed in `.github/workflows/deploy.yml`) auto-deploys both. CI runs typecheck,
unit tests, Playwright tests, and a build on every push regardless.

## One-time setup

### 1. Fly.io app

```bash
# Install flyctl: https://fly.io/docs/hands-on/install-flyctl/
flyctl auth login
flyctl apps create mydrunner-server     # name must match fly.toml `app`
flyctl deploy                           # first deploy, sanity check
```

After it's up, your server's URL will be `wss://mydrunner-server.fly.dev`.

Generate a deploy token for CI:

```bash
flyctl tokens create deploy -x 999999h
```

Copy the token.

### 2. GitHub repo secrets

In **Settings → Secrets and variables → Actions**, add:

- `FLY_API_TOKEN` — paste the token from the previous step.
- `PUBLIC_SERVER_URL` (optional) — override the WSS URL the client connects to.
  Defaults to `wss://mydrunner-server.fly.dev`. If you use a custom domain or a
  different app name, set this.

### 3. Enable GitHub Pages

In **Settings → Pages**, set the source to **GitHub Actions**. The
`deploy.yml` workflow handles publishing.

### 4. Push

```bash
git push
```

CI runs and the deploy workflow takes over. ~3 minutes end to end.

## Running the deploy locally

Server (Docker):

```bash
docker build -f packages/server/Dockerfile -t mydrunner-server .
docker run -p 2567:2567 mydrunner-server
```

Client (static):

```bash
VITE_SERVER_URL=wss://mydrunner-server.fly.dev \
  pnpm --filter @mydrunner/client run build
# Output is in packages/client/dist - serve it with any static host.
```

## Cost / scale notes

- Fly's free tier covers a single shared-cpu-1x instance (256MB), plenty for
  the MVP. The `auto_stop_machines = "stop"` config in `fly.toml` lets the
  server sleep when no one is connected and wake on the first packet.
- GitHub Pages is free for public repos.
- For >10 simultaneous players, bump `[[vm]]` size to `dedicated-cpu-1x` and
  `memory = "512mb"`.
- For multi-region, you'll need room-sharding first (see CLAUDE.md roadmap).

## Picking a different host

If you'd rather use Railway / Render / a VPS:

- The Dockerfile is generic; any Docker host works.
- Render's free tier sleeps after 15min idle which kills WebSocket connections.
  Annoying for a game; pay $7/mo for "Starter" or use Fly.
- Railway: same shape as Fly but with a different CLI. Replace
  `superfly/flyctl-actions` with the Railway action in `deploy.yml`.
