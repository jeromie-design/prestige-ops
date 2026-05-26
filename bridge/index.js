// Bridge service: receives Strapi publish webhooks, fans out to Postiz + Cloudflare Pages.
//
// Strapi sends a webhook on entry.publish for the Drop content type. This service:
//   1. Validates a shared-secret header.
//   2. Schedules social posts in Postiz via its API.
//   3. Hits the Cloudflare Pages deploy hook to rebuild prestigeaccessories.net.
//
// Strapi webhook config (set in Strapi admin -> Settings -> Webhooks):
//   URL:    http://bridge:4000/strapi/publish
//   Header: x-bridge-secret: <BRIDGE_WEBHOOK_SECRET>
//   Events: entry.publish on Drop

import express from 'express';

const {
  PORT = 4000,
  POSTIZ_API_URL,
  POSTIZ_API_KEY,
  CLOUDFLARE_DEPLOY_HOOK_URL,
  WEBHOOK_SHARED_SECRET,
} = process.env;

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/strapi/publish', async (req, res) => {
  if (req.get('x-bridge-secret') !== WEBHOOK_SHARED_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const event = req.body;
  if (event?.model !== 'drop' || event?.event !== 'entry.publish') {
    return res.json({ skipped: true, reason: 'not a drop publish' });
  }

  const drop = event.entry;
  const results = await Promise.allSettled([
    scheduleSocialPosts(drop),
    triggerSiteRebuild(),
  ]);

  res.json({
    drop: drop?.slug ?? drop?.id,
    social: summarize(results[0]),
    rebuild: summarize(results[1]),
  });
});

async function scheduleSocialPosts(drop) {
  if (!POSTIZ_API_URL || !POSTIZ_API_KEY) {
    throw new Error('Postiz not configured');
  }
  // TODO: map drop -> Postiz post payload per channel (Instagram, TikTok, YouTube, X, LinkedIn).
  // Postiz API shape varies by version; finalize once we authenticate Tyler's accounts in the UI.
  const res = await fetch(`${POSTIZ_API_URL}/posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${POSTIZ_API_KEY}`,
    },
    body: JSON.stringify({
      caption: drop.socialCopy ?? drop.name,
      mediaUrl: drop.image?.url,
      channels: drop.channels ?? [],
      scheduledAt: drop.scheduledAt ?? null,
    }),
  });
  if (!res.ok) throw new Error(`postiz ${res.status}: ${await res.text()}`);
  return res.json();
}

async function triggerSiteRebuild() {
  if (!CLOUDFLARE_DEPLOY_HOOK_URL) {
    throw new Error('Cloudflare deploy hook not configured');
  }
  const res = await fetch(CLOUDFLARE_DEPLOY_HOOK_URL, { method: 'POST' });
  if (!res.ok) throw new Error(`cloudflare ${res.status}: ${await res.text()}`);
  return res.json().catch(() => ({ ok: true }));
}

function summarize(settled) {
  return settled.status === 'fulfilled'
    ? { ok: true, result: settled.value }
    : { ok: false, error: settled.reason?.message ?? String(settled.reason) };
}

app.listen(PORT, () => {
  console.log(`bridge listening on :${PORT}`);
});
