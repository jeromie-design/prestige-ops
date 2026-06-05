# prestige-ops

Ops stack for **Prestige Accessories** content + social outreach. One dashboard for Tyler; fans out to Instagram / TikTok / YouTube / etc., and updates the `/products` tiles on https://www.prestigeaccessories.net/.

> **Isolation:** This stack is independent from CinderLabs. Lives on its own EC2 box. No shared infra, no shared accounts. Do not co-tenant with AIRA / Shield / license-server.

---

## Architecture

```
            +-----------------------------+
  Tyler --> | Strapi (ops.*)              |  one dashboard
            |   - creates "Drop" entries  |
            +--------------+--------------+
                           | webhook on publish
                           v
            +-----------------------------+
            | bridge (internal)           |
            +------+----------------+-----+
                   |                |
                   v                v
        +----------+--+   +---------+----------------+
        | Postiz       |  | Cloudflare Pages         |
        | (social.*)   |  | deploy hook              |
        | -> IG/TikTok |  | -> prestige-site rebuild |
        | /YouTube/etc |  | -> /products tiles       |
        +--------------+  +--------------------------+
```

Reverse proxy (Caddy) terminates TLS for two public subdomains:
- `ops.prestigeaccessories.net` &rarr; Strapi admin
- `social.prestigeaccessories.net` &rarr; Postiz (must be public for OAuth callbacks from Meta/TikTok/Google)

Everything else stays on the internal Docker network.

---

## The "Drop" content type (Strapi)

Tyler creates one Drop per piece. Create this in **Strapi admin &rarr; Content-Type Builder &rarr; Create new collection type** after first boot.

| Field | Type | Notes |
|---|---|---|
| `name` | Text (short) | Required. Product name, e.g. "Piece 09". |
| `slug` | UID (target: name) | Required. URL fragment. |
| `category` | Enum | `Belts`, `Shoes`, `Jackets`, `Accessories`. |
| `price` | Text (short) | Free-form so we can write "$240" or "POA". |
| `tag` | Enum (optional) | `New`, `Limited`, blank. Renders as the corner badge on the tile. |
| `image` | Media (single, images) | Required. Drives both the social post and the product tile. |
| `gallery` | Media (multiple, images) | Optional. Reserved for future product detail page. |
| `socialCopy` | Text (long) | Caption used on social. If empty, bridge falls back to `name`. |
| `channels` | JSON | List of Postiz channel IDs to publish to. Populated after channels are connected in Postiz. |
| `scheduledAt` | DateTime (optional) | If set, Postiz schedules instead of publishing immediately. |
| `featured` | Boolean (default true) | Tile appears on /products when true. |
| `publishedAt` | DateTime | Built-in. Used by Strapi's draft/publish flow — bridge only fires on publish. |

Add a **webhook** in Strapi (Settings &rarr; Webhooks):
- **URL:** `http://bridge:4000/strapi/publish`
- **Header:** `x-bridge-secret: <BRIDGE_WEBHOOK_SECRET from .env>`
- **Events:** `Entry &rarr; publish` on Drop only.

Issue a read-only **API token** in Strapi (Settings &rarr; API Tokens) and paste it into `.env` as `STRAPI_API_TOKEN` so the Astro site can fetch Drop entries at build time.

---

## First-time deploy (EC2)

**Box:** t3.medium, Amazon Linux 2023, 30 GB gp3, public IP, security group open on 22 (your IP only) + 80 + 443. Run from inside the box.

```bash
# 1. Install Docker + git + compose V2 plugin
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -fsSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
newgrp docker
docker compose version   # verify

# 2. Clone this repo
cd /opt
sudo mkdir prestige-ops && sudo chown ec2-user:ec2-user prestige-ops
git clone https://github.com/jeromie-design/prestige-ops.git prestige-ops
cd prestige-ops

# 3. Populate .env (auto-generates all initial secrets; leaves post-boot tokens blank)
cp .env.example .env
gen() { openssl rand -hex 32; }
sed -i \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(gen)|" \
  -e "s|^STRAPI_APP_KEYS=.*|STRAPI_APP_KEYS=$(gen),$(gen),$(gen),$(gen)|" \
  -e "s|^STRAPI_API_TOKEN_SALT=.*|STRAPI_API_TOKEN_SALT=$(gen)|" \
  -e "s|^STRAPI_ADMIN_JWT_SECRET=.*|STRAPI_ADMIN_JWT_SECRET=$(gen)|" \
  -e "s|^STRAPI_TRANSFER_TOKEN_SALT=.*|STRAPI_TRANSFER_TOKEN_SALT=$(gen)|" \
  -e "s|^STRAPI_JWT_SECRET=.*|STRAPI_JWT_SECRET=$(gen)|" \
  -e "s|^POSTIZ_JWT_SECRET=.*|POSTIZ_JWT_SECRET=$(gen)|" \
  -e "s|^BRIDGE_WEBHOOK_SECRET=.*|BRIDGE_WEBHOOK_SECRET=$(gen)|" \
  .env
# STRAPI_API_TOKEN, POSTIZ_API_KEY, CLOUDFLARE_DEPLOY_HOOK_URL stay blank — fill after first boot.

# 4. One-time Strapi project init (only on a fresh box; ~5 min)
# AL2023's default nodejs package is v18 — too old for Strapi 5. Use NodeSource v22.
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
cd strapi
rm -f .gitkeep
npx --yes create-strapi-app@latest . --skip-cloud --no-run --javascript
cd ..

# 5. Point DNS — at your DNS provider:
#    ops.prestigeaccessories.net      A  <EC2 public IP>
#    social.prestigeaccessories.net   A  <EC2 public IP>
# Wait for DNS to propagate (dig ops.prestigeaccessories.net) before bringing Caddy up,
# otherwise Let's Encrypt will rate-limit.

# 6. Up
docker compose up -d
docker compose logs -f
```

## Post-boot runbook (Strapi admin first-time setup)

The Drop content type ships as schema-as-code under `strapi/src/api/drop/`. On first Strapi container boot, Strapi auto-migrates the columns. Everything below is what a human still has to click after that — the steps that can't be committed to the repo (they create credentials).

### 1. Create the Strapi admin user

- Visit `https://ops.prestigeaccessories.net/admin` — Strapi shows a one-time registration form.
- Enter first name, last name, real email (gets password-reset links), strong password.
- Click **Let's start**.

If you ever lock yourself out, reset the password from inside the running container (no email infra required):

```bash
docker compose exec -it strapi npx strapi admin:reset-user-password
```

### 2. Issue the read-only API token (powers the prestige-site Astro build)

- Strapi admin &rarr; **Settings** (gear icon) &rarr; **API Tokens** &rarr; **Create new API Token**.
- Name: `prestige-site`
- Description: `Read-only access for prestige-site Astro build`
- Token duration: **Unlimited**
- Token type: **Read-only**
- Click **Save**. The 256-char hex token is shown ONCE on the next screen — click **Copy**.
- Paste into Cloudflare: `prestige-site` Worker &rarr; Settings &rarr; **Build &rarr; Variables and secrets** (the second one — Build section, not the top-level runtime one) &rarr; **+ Add**:
  - Type: Secret
  - Name: `STRAPI_API_TOKEN`
  - Value: paste the token
- Also add (Plaintext): `STRAPI_URL` = `https://ops.prestigeaccessories.net`
- Trigger a redeploy on the prestige-site Cloudflare project (or push any commit).

### 3. Issue the bridge write-back token (powers AI caption fill)

The bridge needs to PATCH Drops to write back AI-generated captions. This is a SEPARATE token from #2.

- Strapi admin &rarr; **Settings** &rarr; **API Tokens** &rarr; **Create new API Token**.
- Name: `bridge`
- Description: `Bridge write-back — AI caption fill on entry.create/update`
- Token duration: **Unlimited**
- Token type: **Custom**
- In **Permissions**, expand **Drop** and tick:
  - `find`
  - `findOne`
  - `update`
- Leave everything else unticked. **Save**.
- Copy the 256-char token shown on the next screen.
- On the EC2 box, paste into `/opt/prestige-ops/.env` as `STRAPI_BRIDGE_TOKEN=<token>`.
- Restart bridge: `docker compose up -d bridge`.

### 4. Add the two Strapi webhooks

Both webhooks point at the bridge through Caddy (`/bridge/strapi/...`). Strapi 5's URL validator rejects internal Docker hostnames, so the bridge has to be reached via the public HTTPS URL.

The bridge validates a shared secret (`BRIDGE_WEBHOOK_SECRET` from `.env`) on every request, so unauthorized callers get 401.

**Webhook A — AI caption fill on draft save**

- Settings &rarr; **Webhooks** &rarr; **Create new webhook**.
- Name: `AI Drop draft` (only letters / numbers / spaces / underscores allowed)
- URL: `https://ops.prestigeaccessories.net/bridge/strapi/draft`
- Headers: add one row &rarr; Key `x-bridge-secret`, Value = your `BRIDGE_WEBHOOK_SECRET` from `.env` (grab it via `grep '^BRIDGE_WEBHOOK_SECRET=' .env | cut -d= -f2-`)
- Events: under **Entry**, tick **Create** and **Update**. Nothing else.
- Save.

**Webhook B — site rebuild + social fan-out on publish**

- Settings &rarr; **Webhooks** &rarr; **Create new webhook**.
- Name: `Bridge Drop publish`
- URL: `https://ops.prestigeaccessories.net/bridge/strapi/publish`
- Headers: `x-bridge-secret` = same `BRIDGE_WEBHOOK_SECRET` value.
- Events: under **Entry**, tick **Publish** only.
- Save.

### 5. Cloudflare deploy hook (Workers site rebuild)

- Cloudflare dashboard &rarr; **prestige-site** project &rarr; Settings &rarr; scroll to **Build** section &rarr; **Deploy Hooks** &rarr; **+ Add**.
- Name: `drop-publish`
- Branch: `main`
- Save. Cloudflare gives you a URL like `https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/...`. Copy it.
- On EC2: paste into `.env` as `CLOUDFLARE_DEPLOY_HOOK_URL=<url>`.
- Restart bridge: `docker compose up -d bridge`.

### 6. Verify the chain end-to-end

- In Strapi admin &rarr; **Content Manager** &rarr; **Drop** &rarr; **Create new entry**.
- Fill: name, category, image (upload one), price, tag.
- Click **Save** (not Publish yet). Within ~10 sec, all six caption fields auto-fill via Claude.
- Refresh the entry — review the captions, edit any that need tweaking.
- Click **Publish**. The bridge fires the Cloudflare deploy hook; the live site rebuilds in ~2-3 min.
- Visit `https://www.prestigeaccessories.net/products` — the new tile should appear.

### 7. Postiz + social platform credentials (separate setup, multi-week)

Each social platform (Instagram, TikTok, YouTube, Pinterest, Threads) needs:
- A Business account on that platform connected to Prestige Accessories
- A Developer app with the right scopes (most require app review, days to weeks)
- OAuth credentials pasted into Postiz at `https://social.prestigeaccessories.net`

See the **Application roadmap** section below for the per-platform sequence and time estimates.

---

## Application roadmap — social platforms

For Postiz to actually post to a platform, that platform requires a registered developer app with review-approved scopes. Reviews are slow; start them in parallel.

| # | Platform | Where to register | Scope to request | Review window |
|---|---|---|---|---|
| 1 | **Meta** (Instagram + Facebook + Threads) | [developers.facebook.com](https://developers.facebook.com) | `instagram_content_publish`, `pages_manage_posts`, `business_management` + Meta Business verification | **2-4 weeks** |
| 2 | **YouTube** (Google) | [console.cloud.google.com](https://console.cloud.google.com) | YouTube Data API v3 + `youtube.upload` (OAuth verification) | 1-2 weeks |
| 3 | **TikTok** | [developers.tiktok.com](https://developers.tiktok.com) | Content Posting API + `video.publish` | 1-2 weeks |
| 4 | **Pinterest** | [developers.pinterest.com](https://developers.pinterest.com) | Pin creation API (standard) | 3-5 days |

**Documents needed for Meta Business verification (the slowest item):**
- Legal business name + EIN
- Business address (matching formation docs)
- Business formation documents (LLC/Corp filings)
- Verified phone number
- Brand website + privacy + terms URLs (all live on prestigeaccessories.net)
- Brand logo (square, &ge;512&times;512)

**Order: start Meta tonight.** Even if you don't finish the app review submission, get Business Verification submitted so its clock starts. Pinterest comes online fastest if you want a quick early win.

---

## Day-2

- **Backups:** Postgres data in the `postgres-data` volume. Set up a nightly `pg_dump` + push to S3 (Prestige's own bucket, not CinderLabs').
- **Updates:** `docker compose pull && docker compose up -d` for postiz/postgres/redis/caddy. Strapi requires a rebuild: `docker compose build strapi && docker compose up -d strapi`.
- **Logs:** `docker compose logs -f <service>`.
- **Why Caddy not nginx:** auto-TLS via Let's Encrypt with zero config beyond the two domain lines in `Caddyfile`. The CinderLabs stack uses nginx for historical reasons; Prestige starts fresh.

---

## Notes

- **AWS account:** Currently same account as CinderLabs boxes for cost/setup simplicity. If stricter isolation is wanted later (separate billing, separate IAM blast radius), open a new AWS account and move this box over.
- **Node 24** matches the local-dev convention. Postiz image pins its own Node version internally; we only control versions for the Strapi build and the bridge.
- **No CI/CD yet.** Deploy is `git pull && docker compose up -d` on the box.
