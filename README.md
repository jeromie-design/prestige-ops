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
| `category` | Enum | `Leather Goods`, `Jewelry`, `Silks`, `Eyewear`. |
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
sudo dnf install -y nodejs npm
cd strapi
npx --yes create-strapi-app@latest . --quickstart --skip-cloud --no-run --typescript=false
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

**Post-boot checklist:**

1. Visit `https://ops.prestigeaccessories.net` &rarr; create the Strapi admin account.
2. Build the **Drop** content type per the table above.
3. Create the **webhook** pointing at the bridge.
4. Issue a Strapi **API token** &rarr; paste into `.env` as `STRAPI_API_TOKEN` &rarr; `docker compose up -d bridge`.
5. Visit `https://social.prestigeaccessories.net` &rarr; create Postiz admin account &rarr; connect Tyler's IG / TikTok / YouTube / etc. (each platform needs its own developer-app credentials; document those in `1Password &gt; Prestige` or similar).
6. Issue a Postiz **API key** &rarr; paste into `.env` as `POSTIZ_API_KEY` &rarr; `docker compose up -d bridge`.
7. In Cloudflare dashboard &rarr; Pages &rarr; `prestige-site` &rarr; Settings &rarr; Builds & deployments &rarr; **Deploy hooks** &rarr; create one named "drop-publish" &rarr; paste URL into `.env` as `CLOUDFLARE_DEPLOY_HOOK_URL` &rarr; `docker compose up -d bridge`.
8. Tyler creates a test Drop &rarr; clicks publish &rarr; confirm social post lands AND prestige-site rebuilds.

---

## Updating the site

Patching `prestige-site/src/pages/products.astro` to consume Strapi is a follow-up — tracked separately. Until that lands, publishing a Drop still triggers a site rebuild but the tiles remain placeholder.

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
