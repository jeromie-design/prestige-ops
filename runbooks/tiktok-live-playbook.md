# TikTok Live Playbook (Tonight)

Shortcut path to a usable Client Key + Client Secret in Postiz, Tyler's TikTok connected, photo carousels publishing. Sibling to `tiktok-setup.md` (long form).

---

## 0. Use Sandbox, not Production

Skip the Production form tonight. Create the app, flip to Sandbox, add Tyler as a Target User.

- Sandbox is "a restricted environment that allows you to try out integrations without having to submit your app for review" (TikTok `add-a-sandbox` doc).
- Sandbox issues its own Client Key + Client Secret immediately. No URL verification for Login Kit, no audit wait.
- Up to 10 Target Users per sandbox. Tyler is #1.
- Caveat: sandbox posts are forced to **private visibility** regardless of scope. Fine for tonight. Public posting waits on Production audit (separate work stream).
- If TikTok blocks the redirect asking for URL verification, jump to Section 3.

---

## 1. Create the app (5 min)

1. `https://developers.tiktok.com` -> Login.
2. Manage apps -> **Connect an app**.
3. Name: `Prestige Accessories Social`. Category: Retail. Description: "Publish Prestige Accessories product Drops to owned social channels."
4. Add products: **Login Kit** and **Content Posting API**. Save.

## 2. Flip to Sandbox, grab creds (2 min)

1. Top of app page: toggle **Sandbox**. Create one named `prestige-social-sbx-1`.
2. Sandbox left nav -> **Credentials**. Copy **Client Key** and **Client Secret** to your password manager NOW. Secret masks after this session.
3. **Target Users** -> **Add** -> enter Tyler's TikTok handle. Tyler gets an in-app notification he must accept from his phone. Text him: "Accept the TikTok developer invite, just popped in your app."
4. **Login Kit** -> **Redirect URI** -> add `https://social.prestigeaccessories.net/integrations/social/tiktok`.
5. **Scopes** -> enable `user.info.basic`, `video.upload`, `video.publish`. Photo carousels use `video.publish` via `/v2/post/publish/content/init/` with `media_type=PHOTO`. No separate `photo.publish` scope exists. Direct Post is faster to unlock in Sandbox than Upload/Inbox (skips the "open TikTok app to finish" hop).

If step 4 demands URL verification, do Section 3 first.

## 3. URL verification via Cloudflare DNS (60 sec)

TikTok shows the exact TXT value in the portal. Copy verbatim. Shape:

- **Host / Name**: `@` (root of `prestigeaccessories.net`). Not a `_tiktok` subdomain.
- **Value**: `tiktok-developers-site-verification=<token TikTok gives you>`
- Alternates: meta tag, or `/tiktok-developers-site-verification.txt` at site root. DNS is fastest on Cloudflare.

Verification is per exact host. A subdomain does NOT inherit apex verification. Terms + Privacy URLs are separate properties on the same domain (each needs its own token, though the same DNS record can satisfy multiple properties on the same host).

Cloudflare:

1. `dash.cloudflare.com` -> pick `prestigeaccessories.net` zone.
2. **DNS** -> **Records** -> **Add record**.
   - Type: `TXT`, Name: `@`, Content: paste full string, TTL: Auto.
   - Proxy status: N/A for TXT (always DNS-only, greyed out).
3. Save. Back in TikTok portal, click **Verify**. Cloudflare propagates in seconds.

Redirect host note: the redirect `https://social.prestigeaccessories.net/...` is a different host from the verified apex. TikTok's Login Kit redirect field itself does not require domain verification (redirects must be HTTPS, no params, no fragment, under 512 chars, exact match at token exchange). Only URL properties (Terms, Privacy, Web URL) hit the verification wall. If Production later demands the redirect host be verified, add a second TXT on `social.prestigeaccessories.net`.

## 4. Paste creds into Postiz, restart (3 min)

SSH to the Prestige ops box:

```bash
cd /opt/prestige-ops
sudo nano .env
```

Set:
```
TIKTOK_CLIENT_ID=<Client Key>
TIKTOK_CLIENT_SECRET=<Client Secret>
```

Then:
```bash
sudo docker compose up -d --force-recreate postiz && sleep 30
```

Open `https://social.prestigeaccessories.net`, log in, **Channels** -> **Add Channel** -> **TikTok**. Kicks Tyler's OAuth; he finishes on his phone. Channel appears connected.

Smoke test: Postiz post with 2 test images. Confirm it lands as a private post on Tyler's TikTok.

---

## Top 3 stall points

1. **Tyler never accepts the Target User invite.** In-app notification only, no email. Sandbox -> Target Users -> **Resend**, then screen-share and walk him to the TikTok app notification bell. Fallback: add Jeromie's personal TikTok as Target User #2 for tonight's smoke test, hand off to Tyler tomorrow.
2. **Cloudflare TXT "not found" on verify.** Usually a mangled `=` or trailing space. Also verify Name is `@`, not literal `prestigeaccessories.net` (some UIs double it). Wait 60s, retry.
3. **Postiz "invalid client" after paste.** Stray newline in `.env`, or the secret rotated when "reveal" was clicked twice in the portal. Regenerate the sandbox secret, replace in `.env`, force-recreate the container, retry.
