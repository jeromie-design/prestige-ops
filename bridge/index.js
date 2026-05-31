// Bridge service: receives Strapi publish webhooks, fans out to Postiz + GitHub.
//
// Strapi sends a webhook on entry.publish for the Drop content type. This service:
//   1. Validates a shared-secret header.
//   2. Schedules social posts in Postiz via its API.
//   3. Makes a marker commit on the prestige-site repo via the GitHub API,
//      which triggers Cloudflare Workers to auto-rebuild and redeploy the site.
//
// Strapi webhook config (set in Strapi admin -> Settings -> Webhooks):
//   URL:    https://ops.prestigeaccessories.net/bridge/strapi/publish
//   Header: x-bridge-secret: <BRIDGE_WEBHOOK_SECRET>
//   Events: entry.publish on Drop

import express from 'express';

const {
  PORT = 4000,
  POSTIZ_API_URL,
  POSTIZ_API_KEY,
  WEBHOOK_SHARED_SECRET,
  // GitHub-driven site rebuild (preferred for Cloudflare Workers projects)
  GITHUB_DEPLOY_TOKEN,
  GITHUB_DEPLOY_REPO = 'jeromie-design/prestige-site',
  GITHUB_DEPLOY_BRANCH = 'main',
  GITHUB_DEPLOY_MARKER_PATH = '.cloudflare/last-drop.txt',
  // Legacy / fallback: direct Cloudflare deploy hook (Pages projects only)
  CLOUDFLARE_DEPLOY_HOOK_URL,
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
    triggerSiteRebuild(drop),
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

async function triggerSiteRebuild(drop) {
  // Prefer Cloudflare Pages deploy hook if one is configured (legacy/Pages projects).
  if (CLOUDFLARE_DEPLOY_HOOK_URL) {
    const res = await fetch(CLOUDFLARE_DEPLOY_HOOK_URL, { method: 'POST' });
    if (!res.ok) throw new Error(`cloudflare ${res.status}: ${await res.text()}`);
    return res.json().catch(() => ({ ok: true, via: 'cloudflare-hook' }));
  }

  // Otherwise touch a marker file via the GitHub API; Cloudflare Workers auto-deploys on push.
  if (!GITHUB_DEPLOY_TOKEN) {
    throw new Error('Neither CLOUDFLARE_DEPLOY_HOOK_URL nor GITHUB_DEPLOY_TOKEN configured');
  }
  return touchMarkerCommit(drop);
}

async function touchMarkerCommit(drop) {
  const repoUrl = `https://api.github.com/repos/${GITHUB_DEPLOY_REPO}/contents/${GITHUB_DEPLOY_MARKER_PATH}`;
  const headers = {
    'Authorization': `Bearer ${GITHUB_DEPLOY_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'prestige-ops-bridge',
  };

  // Look up the current marker sha so we can update (not create) the file.
  let sha;
  const getRes = await fetch(`${repoUrl}?ref=${GITHUB_DEPLOY_BRANCH}`, { headers });
  if (getRes.ok) {
    sha = (await getRes.json()).sha;
  } else if (getRes.status !== 404) {
    throw new Error(`github GET ${getRes.status}: ${await getRes.text()}`);
  }

  const now = new Date().toISOString();
  const slug = drop?.slug ?? drop?.id ?? 'unknown';
  const content = Buffer.from(
    `${now} ${slug}\n`,
    'utf-8',
  ).toString('base64');

  const body = {
    message: `redeploy: drop ${slug} published @ ${now}`,
    content,
    branch: GITHUB_DEPLOY_BRANCH,
    ...(sha && { sha }),
  };

  const putRes = await fetch(repoUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!putRes.ok) throw new Error(`github PUT ${putRes.status}: ${await putRes.text()}`);
  const out = await putRes.json();
  return { ok: true, via: 'github-marker', sha: out?.commit?.sha };
}

function summarize(settled) {
  return settled.status === 'fulfilled'
    ? { ok: true, result: settled.value }
    : { ok: false, error: settled.reason?.message ?? String(settled.reason) };
}

app.listen(PORT, () => {
  console.log(`bridge listening on :${PORT}`);
});
