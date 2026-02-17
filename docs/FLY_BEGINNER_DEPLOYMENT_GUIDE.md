# Fly.io Beginner Deployment Guide (Manual CLI, No GitHub Actions)

This guide assumes you have never deployed before.
It is written for this repository exactly as it exists now.

## What you are deploying

One Fly app runs:
1. API
2. Worker
3. Dashboard frontend (served by the API)
4. Postgres (inside the same container)
5. Redis (inside the same container)

Important:
1. `docker-compose.yml` is for local development only.
2. Fly does not run your Docker Compose services in production.
3. Persistence comes from a Fly volume mounted at `/data`.
4. If the volume is deleted, app data is lost (you can re-run scans from GitHub).

## Step 0: Install prerequisites

1. Install Fly CLI:
```bash
brew install flyctl
```

2. Install project dependencies:
```bash
pnpm install
```

3. Log into Fly:
```bash
fly auth login
```

4. Verify tools:
```bash
flyctl version
pnpm --version
docker --version
```

## Step 1: Pick your Fly app name

1. Choose a globally unique app name, for example:
- `<your-app-name>`

2. Update `fly.toml`:
```toml
app = "<your-app-name>"
```

3. Create the app:
```bash
fly apps create <your-app-name>
```

If it says the app already exists, continue to the next step.

## Step 2: Create persistent volume (required)

Create a volume named `data` for the app:
```bash
fly volumes create data --app <your-app-name> --region ord --size 10
```

Notes:
1. `--size 10` means 10GB; increase if needed.
2. Keep region aligned with `fly.toml` primary region.

Verify volume:
```bash
fly volumes list -a <your-app-name>
```

## Step 3: Set required app secrets

Generate secure tokens:
```bash
openssl rand -hex 32
```
Run it twice and keep both values:
1. one for `OPS_TRIGGER_TOKEN`
2. one for `DASHBOARD_TOKEN` (only if dashboard auth is enabled)

Set runtime secrets:
```bash
fly secrets set -a <your-app-name> \
  GITHUB_MODE="public" \
  GITHUB_TOKEN="<optional_github_token_for_higher_rate_limits>" \
  OPS_TRIGGER_TOKEN="<your_ops_trigger_token>" \
  PUBLIC_SCAN_ALLOWED_REPOS="<owner>/<repo>"
```

Dashboard auth options:
1. Easiest first deploy (no dashboard token required):
```bash
fly secrets set -a <your-app-name> DASHBOARD_AUTH_MODE=disabled
```
2. Secure mode:
```bash
fly secrets set -a <your-app-name> DASHBOARD_AUTH_MODE=required DASHBOARD_TOKEN="<your_dashboard_token>"
```

You do not need to set `DATABASE_URL` or `REDIS_URL` for this all-in-one mode.
The startup script sets local defaults to `127.0.0.1` and initializes services automatically.

Optional GitHub App mode (only if you want webhook/installation ingest):
```bash
fly secrets set -a <your-app-name> \
  GITHUB_MODE="app" \
  GITHUB_APP_ID="<your_github_app_id>" \
  GITHUB_WEBHOOK_SECRET="<your_webhook_secret>" \
  GITHUB_PRIVATE_KEY_PEM="$(cat path/to/github-app-private-key.pem)"
```

## Step 4: Deploy the app

From the repository root:
```bash
pnpm deploy:fly
```

This runs:
1. `flyctl deploy --remote-only`
2. `flyctl scale count app=1`
3. `flyctl status`

The container startup script:
1. starts Postgres on localhost
2. starts Redis on localhost
3. runs `pnpm db:migrate`
4. starts API + worker

## Step 5: Verify deployment

1. Health endpoint:
```bash
curl https://<your-app-name>.fly.dev/api/health
```
Expected:
```json
{"ok":true}
```

2. Verify one machine:
```bash
fly scale show -a <your-app-name>
```

3. Open dashboard:
```bash
fly open -a <your-app-name>
```

4. Verify in-machine services:
```bash
fly ssh console -a <your-app-name> -C "pg_isready -h 127.0.0.1 -p 5432 && redis-cli -h 127.0.0.1 -p 6379 ping"
```

Expected final line:
```text
PONG
```

## Step 6: Trigger a scan manually (authorized push workflow replacement)

Use the built-in script:
```bash
FLY_APP_URL=https://<your-app-name>.fly.dev \
OPS_TRIGGER_TOKEN="<your_ops_trigger_token>" \
pnpm trigger:scan --owner <owner> --repo <repo>
```

Optional limit:
```bash
FLY_APP_URL=https://<your-app-name>.fly.dev \
OPS_TRIGGER_TOKEN="<your_ops_trigger_token>" \
pnpm trigger:scan --owner <owner> --repo <repo> --max-open-prs 50
```

## Step 7: Add scheduled runs (Fly-native cron style)

Fly scheduled Machines support coarse intervals (`hourly`, `daily`, `monthly`).

Create a tiny scheduler app:
```bash
fly apps create <your-cron-app-name>
```

Set scheduler secrets:
```bash
fly secrets set -a <your-cron-app-name> \
  FLY_APP_URL="https://<your-app-name>.fly.dev" \
  OPS_TRIGGER_TOKEN="<your_ops_trigger_token>" \
  PUBLIC_SCAN_OWNER="<owner>" \
  PUBLIC_SCAN_REPO="<repo>"
```

Create a scheduled machine (hourly):
```bash
fly machine run curlimages/curl:8.12.1 sh -lc 'curl --fail-with-body --silent --show-error -X POST "${FLY_APP_URL%/}/api/ops/public-scan" -H "Content-Type: application/json" -H "Authorization: Bearer ${OPS_TRIGGER_TOKEN}" -d "{\"owner\":\"${PUBLIC_SCAN_OWNER}\",\"repo\":\"${PUBLIC_SCAN_REPO}\"}"' \
  --app <your-cron-app-name> \
  --schedule hourly \
  --restart no \
  --region ord
```

Check scheduled machine status:
```bash
fly machine list -a <your-cron-app-name>
```

## Common first-time mistakes

1. Forgetting to create the `data` volume before deploy.
2. Forgetting `PUBLIC_SCAN_ALLOWED_REPOS` (ops trigger will return `403`).
3. Using local `docker-compose.yml` as if Fly will run it.
4. Setting `DASHBOARD_AUTH_MODE=auto` in production without `DASHBOARD_TOKEN`.
5. Running too little memory for all-in-one mode (use at least 2GB in `fly.toml`).

## Quick recovery commands

Show app logs:
```bash
fly logs -a <your-app-name>
```

Show current Fly secrets names:
```bash
fly secrets list -a <your-app-name>
```

Re-deploy:
```bash
pnpm deploy:fly
```
