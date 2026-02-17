# Fly.io Beginner Deployment Guide (Manual CLI, No GitHub Actions)

This guide assumes you have never deployed before.
It is written for this repository exactly as it exists now.

## What you are deploying

One Fly app runs:
1. API
2. Worker
3. Dashboard frontend (served by the API)

Important:
1. `docker-compose.yml` is for local development only.
2. Fly does not run your Docker Compose services in production.
3. Postgres and Redis must be provisioned separately, then connected with `DATABASE_URL` and `REDIS_URL`.

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

## Step 2: Create Postgres (Managed Postgres)

1. Create a cluster:
```bash
fly mpg create --name <your-pg-name> --region ord
```

2. List clusters and copy the cluster ID:
```bash
fly mpg list
```

3. Attach Postgres to your app (this sets `DATABASE_URL` secret automatically):
```bash
fly mpg attach <CLUSTER_ID> -a <your-app-name>
```

## Step 3: Create Redis (Upstash Redis)

1. Create Redis:
```bash
fly redis create --name <your-redis-name> --region ord
```

2. Copy the private Redis URL from command output.

3. Set `REDIS_URL` on your app:
```bash
fly secrets set -a <your-app-name> REDIS_URL="redis://default:<password>@<host>:<port>"
```

## Step 4: Set required app secrets

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
  OPS_TRIGGER_TOKEN="<your_ops_trigger_token>" \
  PUBLIC_SCAN_ALLOWED_REPOS="<owner>/<repo>" \
  GITHUB_APP_ID="<your_github_app_id>" \
  GITHUB_WEBHOOK_SECRET="<your_webhook_secret>" \
  GITHUB_PRIVATE_KEY_PEM="$(cat path/to/github-app-private-key.pem)"
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

## Step 5: Deploy the app

From the repository root:
```bash
pnpm deploy:fly
```

This runs:
1. `flyctl deploy --remote-only`
2. `flyctl scale count app=1`
3. `flyctl status`

## Step 6: Run database migrations

After the first deploy, run migrations inside the Fly machine:
```bash
fly ssh console -a <your-app-name> -C "pnpm db:migrate"
```

Run this again any time new migrations are added.

## Step 7: Verify deployment

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

## Step 8: Trigger a scan manually (authorized push workflow replacement)

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

## Step 9: Add scheduled runs (Fly-native cron style)

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

1. Forgetting to set `REDIS_URL` on Fly after creating Redis.
2. Forgetting `PUBLIC_SCAN_ALLOWED_REPOS` (ops trigger will return `403`).
3. Using local `docker-compose.yml` as if Fly will run it.
4. Skipping `pnpm db:migrate` after first deploy.
5. Setting `DASHBOARD_AUTH_MODE=auto` in production without `DASHBOARD_TOKEN`.

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
