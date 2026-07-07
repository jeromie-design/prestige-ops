// Bridge service, translates Strapi webhooks into useful side-effects.
//
// Routes:
//   POST /strapi/draft    , fires on entry.create / entry.update of a Drop.
//                            If socialCopy is empty, generates it with Claude
//                            (vision + product details) and PATCHes Strapi.
//                            Tyler then reviews/edits before publishing.
//   POST /strapi/publish  , fires on entry.publish of a Drop.
//                            1) schedules Postiz social posts (when configured)
//                            2) triggers a Cloudflare site rebuild.
//
// Both routes share an HMAC-style shared secret (x-bridge-secret header).
//
// Webhook setup in Strapi (Settings -> Webhooks):
//   - "AI - Drop draft"
//       URL:    https://ops.prestigeaccessories.net/bridge/strapi/draft
//       Header: x-bridge-secret: <BRIDGE_WEBHOOK_SECRET>
//       Events: entry.create AND entry.update on Drop
//   - "Bridge Drop publish"     (already configured)
//       URL:    https://ops.prestigeaccessories.net/bridge/strapi/publish
//       Header: x-bridge-secret: <BRIDGE_WEBHOOK_SECRET>
//       Events: entry.publish on Drop

import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const {
  PORT = 4000,
  WEBHOOK_SHARED_SECRET,

  // Postiz (publish path), currently disabled until Temporal is sorted
  POSTIZ_API_URL,
  POSTIZ_API_KEY,

  // Strapi write-back (draft path)
  STRAPI_PUBLIC_URL = 'https://ops.prestigeaccessories.net',
  STRAPI_INTERNAL_URL = 'http://strapi:1337',
  STRAPI_BRIDGE_TOKEN,

  // Claude, drives socialCopy generation
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = 'claude-sonnet-4-5',

  // Site rebuild
  CLOUDFLARE_DEPLOY_HOOK_URL,
  GITHUB_DEPLOY_TOKEN,
  GITHUB_DEPLOY_REPO = 'jeromie-design/prestige-site',
  GITHUB_DEPLOY_BRANCH = 'main',
  GITHUB_DEPLOY_MARKER_PATH = '.cloudflare/last-drop.txt',

  // eBay Sell API. Full design in docs/EBAY-INTEGRATION.md.
  // The whole integration is behind an if-configured guard, if EBAY_APP_ID or
  // EBAY_REFRESH_TOKEN are unset the eBay path is skipped and the rest of
  // /strapi/publish still runs as before.
  EBAY_ENV = 'sandbox',
  EBAY_APP_ID,
  EBAY_CERT_ID,
  EBAY_DEV_ID,
  EBAY_USER_TOKEN,
  EBAY_REFRESH_TOKEN,
  EBAY_DEFAULT_SHIPPING_POLICY_ID,
  EBAY_DEFAULT_RETURN_POLICY_ID,
  EBAY_DEFAULT_PAYMENT_POLICY_ID,
  EBAY_DEFAULT_LOCATION_ZIP,
  EBAY_DEFAULT_CATEGORY_ID = '2993',
} = process.env;

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// Fields the bridge auto-fills. Order matters for the "skip if any already set" check below.
const CAPTION_FIELDS = [
  'socialCopy',
  'captionInstagram',
  'captionTikTok',
  'captionPinterest',
  'captionThreads',
  'captionYoutubeTitle',
  'captionYoutubeDescription',
  // Manual-channel captions: copied to clipboard by Tyler and pasted into native UIs.
  // FB Marketplace / FB Groups / Whatnot have no useful public API; eBay has one but
  // the listing schema is structured (separate workstream). Generating clean text for
  // all of them up front means Tyler never re-writes a caption per platform.
  'captionMarketplace',
  'captionFacebookGroup',
  'captionWhatnot',
  'ebayTitle',
  'ebayDescription',
];

const BRAND_VOICE_SYSTEM_PROMPT = `You write product copy for Prestige Accessories, a curated boutique selling designer goods (belts, shoes, jackets, and other accessories).

Brand voice, applies to EVERY platform:
- Restrained, considered, slightly literary
- Confident without being boastful. Describes the piece, never the buyer.
- Specific sensory details (texture, weight, color, finish, presentation)
- Mentions the maker and signature touches when distinctive
- No exclamation marks, no hard-sell language, no clichés ("luxury redefined", "elevate your style")
- NEVER use em-dashes (the long dash character, U+2014). Use commas, periods, parentheses, or rewrite the sentence. This is a hard rule.
- Hashtags only when the platform expects them. Keep tag counts lean (3-6); luxury brands don't spam.

Reference voice example:
"Italian leather, hand-finished marble buckle. Buscemi at their most restrained, and most worth owning. Presented in the signature feather-embossed box."

Per-platform specs:
- socialCopy: brand-voice base description used on the product page. 2-3 sentences, ~30 words. NO hashtags.
- captionInstagram: 100-150 words. Short hook line, then descriptive paragraph. 4-6 hashtags at end (brand + category + material + style).
- captionTikTok: 80-120 words. Hook-first opening question or statement. Slightly more conversational. 3-5 hashtags at end.
- captionPinterest: 100-200 words. SEO-rich, keyword-dense. Sensory descriptors. No hashtags (Pinterest treats text differently). Include the brand, material, and color naturally.
- captionThreads: 50-100 words. Conversational but still considered. 2-3 hashtags max.
- captionYoutubeTitle: <60 chars. Format: "<Brand> <Piece>, <Distinctive Detail>" or similar. Searchable.
- captionYoutubeDescription: 200-300 words. Longer story. Material origin, finish, presentation, fit/care notes. End with brand/site URL line. No hashtags in body; YouTube uses tags separately.

Manual-channel specs (Tyler pastes these into native apps; no API automation):
- captionMarketplace: 80-150 words for Facebook Marketplace listing description. Lead with condition + brand + size if known. Then the piece description in brand voice. End with "Inquire via message for measurements or additional photos." Plain text only, no hashtags.
- captionFacebookGroup: 60-100 words for buy/sell groups. Format: Brand + piece, condition, asking price line, then 2-3 sentence brand-voice description, then "DM to inquire." Plain text, no hashtags. Direct but never aggressive.
- captionWhatnot: 40-80 words. Punchy for a live show context, like Tyler is holding the piece up to camera. One sensory line, one condition note, one call to bid. No hashtags, no links.
- ebayTitle: HARD CAP 80 characters. Format: "<Brand> <Model/Piece> <Color> <Size> <Material> <Condition>" with whatever fits. Stuff the title with the words a buyer would actually search. No marketing fluff, no exclamation, no all-caps. Example: "Buscemi Marble Buckle Belt Black Italian Leather Mens 95cm Pre-Owned"
- ebayDescription: 200-400 words. Plain text or simple HTML. Open with brand + piece. List item specifics by line (Brand, Material, Color, Hardware, Country of origin if known). Then 2-3 paragraphs of considered description in brand voice. Then condition disclosure paragraph (always say "Pre-Owned" or "New with tags" honestly, mention any visible wear). Close with the brand line. NO hashtags. NO em-dashes.

When you call the publish_captions tool, fill every field with a finished caption. No preamble, no labels, no markdown.`;

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} (secret=${req.get('x-bridge-secret') ? 'present' : 'missing'})`);
  next();
});

app.get('/health', (_req, res) => res.json({
  ok: true,
  features: {
    ai_copy: Boolean(anthropic && STRAPI_BRIDGE_TOKEN),
    postiz: Boolean(POSTIZ_API_URL && POSTIZ_API_KEY),
    cloudflare_hook: Boolean(CLOUDFLARE_DEPLOY_HOOK_URL),
    github_fallback: Boolean(GITHUB_DEPLOY_TOKEN),
    ebay: Boolean(EBAY_APP_ID && EBAY_REFRESH_TOKEN),
  },
}));

// -----------------------------------------------------------------------------
// /strapi/draft, entry.create / entry.update, AI-fill socialCopy if empty
// -----------------------------------------------------------------------------

app.post('/strapi/draft', async (req, res) => {
  if (req.get('x-bridge-secret') !== WEBHOOK_SHARED_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const event = req.body;
  if (event?.model !== 'drop' || !['entry.create', 'entry.update'].includes(event?.event)) {
    return res.json({ skipped: true, reason: 'not a drop draft event' });
  }

  const drop = event.entry;
  if (!drop) return res.json({ skipped: true, reason: 'no entry payload' });

  // Figure out which caption fields are empty. Only fill empty ones, Tyler's edits never get clobbered.
  const emptyFields = CAPTION_FIELDS.filter(field => {
    const v = drop[field];
    return !v || (typeof v === 'string' && v.trim().length === 0);
  });

  if (emptyFields.length === 0) {
    console.log(`[bridge] drop=${drop.slug ?? drop.id} all captions already set; skipping AI fill`);
    return res.json({ skipped: true, reason: 'all captions already populated' });
  }

  if (!anthropic) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }
  if (!STRAPI_BRIDGE_TOKEN) {
    return res.status(503).json({ error: 'STRAPI_BRIDGE_TOKEN not configured' });
  }

  try {
    const captions = await generateAllCaptions(drop);
    // Build a patch with only the empty fields filled (preserve Tyler's edits)
    const patch = {};
    for (const field of emptyFields) {
      if (captions[field]) patch[field] = captions[field];
    }
    await patchDrop(drop.documentId ?? drop.id, patch);
    console.log(`[bridge] drop=${drop.slug ?? drop.id} ai_filled=[${Object.keys(patch).join(',')}]`);
    res.json({ ok: true, drop: drop.slug ?? drop.id, filled: Object.keys(patch) });
  } catch (err) {
    console.error(`[bridge] AI fill failed for drop=${drop.slug ?? drop.id}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

async function generateAllCaptions(drop) {
  const content = [];

  const imagePath = drop?.image?.url ?? null;
  if (imagePath) {
    const fullImageUrl = imagePath.startsWith('http') ? imagePath : `${STRAPI_PUBLIC_URL}${imagePath}`;
    content.push({
      type: 'image',
      source: { type: 'url', url: fullImageUrl },
    });
  }

  const details = [
    `Name: ${drop.name ?? 'Unnamed piece'}`,
    drop.category ? `Category: ${drop.category}` : null,
    drop.tag ? `Tag: ${drop.tag}` : null,
    drop.price ? `Price: ${drop.price}` : null,
  ].filter(Boolean).join('\n');

  content.push({
    type: 'text',
    text: `Use the image (if provided) to anchor sensory details. Then write platform-specific captions for this piece by calling the publish_captions tool.\n\nProduct details:\n${details}\n\nFill every field with a complete, ready-to-publish caption. Follow the per-platform specs in the system prompt strictly.`,
  });

  const tool = {
    name: 'publish_captions',
    description: 'Set the platform-specific captions for this Drop. Every field is required and must be a complete caption ready to publish.',
    input_schema: {
      type: 'object',
      properties: {
        socialCopy: { type: 'string', description: 'Brand-voice base description for the product page. 2-3 sentences, ~30 words. No hashtags.' },
        captionInstagram: { type: 'string', description: 'Instagram caption: 100-150 words, hook + paragraph, 4-6 hashtags at end.' },
        captionTikTok: { type: 'string', description: 'TikTok caption: 80-120 words, hook-first, 3-5 hashtags at end.' },
        captionPinterest: { type: 'string', description: 'Pinterest description: 100-200 words, SEO-rich, no hashtags.' },
        captionThreads: { type: 'string', description: 'Threads post: 50-100 words, conversational, 2-3 hashtags max.' },
        captionYoutubeTitle: { type: 'string', description: 'YouTube video title: under 60 characters, searchable, brand + piece + distinctive detail.' },
        captionYoutubeDescription: { type: 'string', description: 'YouTube description: 200-300 words, longer story, ends with brand/site line.' },
        captionMarketplace: { type: 'string', description: 'Facebook Marketplace listing description: 80-150 words, condition-first, ends with inquiry CTA.' },
        captionFacebookGroup: { type: 'string', description: 'Buy/sell group post: 60-100 words, brand + condition + price + brand-voice description + DM CTA.' },
        captionWhatnot: { type: 'string', description: 'Whatnot live-show line: 40-80 words, punchy, in-the-moment, no hashtags or links.' },
        ebayTitle: { type: 'string', description: 'eBay listing title: HARD MAX 80 characters, keyword-stuffed, brand + piece + color + size + material + condition.' },
        ebayDescription: { type: 'string', description: 'eBay listing description: 200-400 words, item specifics as a list then brand-voice paragraphs then honest condition disclosure.' },
      },
      required: CAPTION_FIELDS,
    },
  };

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 2500,
    system: BRAND_VOICE_SYSTEM_PROMPT,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'publish_captions' },
    messages: [{ role: 'user', content }],
  });

  const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === 'publish_captions');
  if (!toolUse) throw new Error('Claude did not call the publish_captions tool');
  return toolUse.input;
}

async function patchDrop(documentId, patch) {
  const url = `${STRAPI_INTERNAL_URL}/api/drops/${documentId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${STRAPI_BRIDGE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: patch }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`strapi PUT ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// -----------------------------------------------------------------------------
// /strapi/publish, entry.publish, schedule social posts + rebuild site
// -----------------------------------------------------------------------------

app.post('/strapi/publish', async (req, res) => {
  if (req.get('x-bridge-secret') !== WEBHOOK_SHARED_SECRET) {
    console.warn('[bridge] 401, x-bridge-secret missing or mismatched');
    return res.status(401).json({ error: 'unauthorized' });
  }

  const event = req.body;
  console.log(`[bridge] event ${event?.event} on model ${event?.model}`);
  if (event?.model !== 'drop' || event?.event !== 'entry.publish') {
    return res.json({ skipped: true, reason: 'not a drop publish' });
  }

  const drop = event.entry;
  // Always return 200 even on partial failure; Strapi will otherwise retry the
  // webhook indefinitely and we'd double-post on every retry.
  const results = await Promise.allSettled([
    scheduleSocialPosts(drop),
    triggerSiteRebuild(drop),
  ]);

  const social = summarize(results[0]);
  const rebuild = summarize(results[1]);

  // eBay listing creation runs after Postiz fan-out. Independent of Postiz +
  // Cloudflare success, if either of those errored we still want the item live
  // on eBay so the sale channel is not gated on a social hiccup.
  let ebay;
  try {
    ebay = await publishDropToEbay(drop);
    if (ebay?.ok && ebay.listingId) {
      // Write listing state back to Strapi so Tyler sees "live" in the admin.
      try {
        await patchDrop(drop?.documentId ?? drop?.id, {
          ebayListingState: 'live',
          ebayListingId: String(ebay.listingId),
        });
      } catch (err) {
        console.error(`[bridge] drop=${drop?.slug ?? drop?.id} ebay patch-back failed: ${err.message}`);
      }
    }
  } catch (err) {
    // publishDropToEbay is written not to throw, but belt-and-suspenders.
    console.error(`[bridge] drop=${drop?.slug ?? drop?.id} ebay unexpected throw: ${err.message}`);
    ebay = { ok: false, error: err.message };
  }

  console.log(`[bridge] drop=${drop?.slug ?? drop?.id} social=${JSON.stringify(social)} rebuild=${JSON.stringify(rebuild)} ebay=${JSON.stringify(ebay)}`);

  res.json({
    drop: drop?.slug ?? drop?.id,
    social,
    rebuild,
    ebay,
  });
});

// -----------------------------------------------------------------------------
// Postiz fan-out
//
// For each connected Postiz integration (Instagram, FB Page, Threads, Pinterest,
// etc.), pick the right per-platform caption field on the Drop and create one
// scheduled Postiz post with the Drop image. Channels without a caption value
// or that need video without a video are skipped.
//
// Postiz public API (confirmed via grep inside the running container against
// /app/apps/backend/dist):
//   GET  /public/v1/integrations          -> [{ id, name, identifier, ... }]
//   POST /public/v1/upload-from-url       <- { url } -> { id, path }
//   POST /public/v1/posts                 <- {
//          type: 'now' | 'schedule',
//          date: ISO,
//          shortLink: bool,
//          posts: [{ integration: { id }, value: [{ content, image: [{ id, path }] }] }]
//        }
// If the actual shape differs in any deployed Postiz version, the per-channel
// try/catch below will log and continue rather than aborting the whole fan-out.
// -----------------------------------------------------------------------------

// identifier -> { field, requiresVideo }
// requiresVideo channels are skipped until we have a video pipeline.
const POSTIZ_CHANNEL_MAP = {
  'instagram-standalone': { field: 'captionInstagram', requiresVideo: false },
  'instagram': { field: 'captionInstagram', requiresVideo: false },
  'facebook': { field: 'socialCopy', requiresVideo: false },
  'threads': { field: 'captionThreads', requiresVideo: false },
  'pinterest': { field: 'captionPinterest', requiresVideo: false },
  'tiktok': { field: 'captionTikTok', requiresVideo: true },
  'youtube': { field: 'captionYoutubeTitle', requiresVideo: true },
  // Reddit posts are most natural in the buy/sell community voice (price + condition
  // + brief description + DM CTA). Reuse the captionFacebookGroup field which is
  // tuned for that tone, no separate field needed.
  'reddit': { field: 'captionFacebookGroup', requiresVideo: false },
};

function postizHeaders() {
  return {
    'Content-Type': 'application/json',
    // Postiz public API uses an 'Authorization' API-key header.
    // Some deployments accept the raw key; Bearer prefix is also accepted by the
    // controller's guard. Send raw for the widest compatibility.
    'Authorization': POSTIZ_API_KEY,
  };
}

async function postizFetch(path, init = {}) {
  const url = `${POSTIZ_API_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...postizHeaders(), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const snippet = typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200);
    throw new Error(`postiz ${path} ${res.status}: ${snippet}`);
  }
  return body;
}

async function listPostizIntegrations() {
  const data = await postizFetch('/public/v1/integrations', { method: 'GET' });
  // Defensive: some Postiz versions wrap the list under { integrations: [...] }.
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.integrations)) return data.integrations;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

async function uploadImageToPostiz(imageUrl) {
  // POST /public/v1/upload-from-url accepts { url } and returns { id, path }.
  return postizFetch('/public/v1/upload-from-url', {
    method: 'POST',
    body: JSON.stringify({ url: imageUrl }),
  });
}

async function createPostizPost({ integrationId, content, imageRef, when }) {
  const scheduleType = when ? 'schedule' : 'now';
  const date = (when ?? new Date()).toISOString();
  const value = [{
    content,
    image: imageRef ? [imageRef] : [],
  }];
  return postizFetch('/public/v1/posts', {
    method: 'POST',
    body: JSON.stringify({
      type: scheduleType,
      date,
      shortLink: false,
      posts: [{ integration: { id: integrationId }, value }],
    }),
  });
}

async function scheduleSocialPosts(drop) {
  if (!POSTIZ_API_URL || !POSTIZ_API_KEY) {
    return { skipped: true, reason: 'Postiz not configured' };
  }
  if (!drop) {
    return { skipped: true, reason: 'no drop payload' };
  }

  const slug = drop.slug ?? drop.id ?? 'unknown';

  // Resolve the public image URL up front. If the Drop has no image we can still
  // try text-only posts on the platforms that accept them, but most social posts
  // are image-driven; log and continue.
  const imagePath = drop?.image?.url ?? null;
  const fullImageUrl = imagePath
    ? (imagePath.startsWith('http') ? imagePath : `${STRAPI_PUBLIC_URL}${imagePath}`)
    : null;

  let integrations;
  try {
    integrations = await listPostizIntegrations();
  } catch (err) {
    console.error(`[bridge] postiz list integrations failed: ${err.message}`);
    return { ok: false, error: err.message, scheduled: [], skipped: [] };
  }

  if (!integrations.length) {
    console.log(`[bridge] drop=${slug} postiz has no connected integrations; nothing to fan out`);
    return { ok: true, scheduled: [], skipped: [], reason: 'no connected channels' };
  }

  // Upload image once, reuse the same Postiz media ref across every post.
  let imageRef = null;
  if (fullImageUrl) {
    try {
      const uploaded = await uploadImageToPostiz(fullImageUrl);
      if (uploaded?.id && uploaded?.path) {
        imageRef = { id: uploaded.id, path: uploaded.path };
      } else {
        console.warn(`[bridge] postiz upload-from-url returned unexpected shape: ${JSON.stringify(uploaded).slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[bridge] postiz image upload failed for drop=${slug}: ${err.message}`);
      // Continue without image; posts that need media will fail per-channel and be logged.
    }
  }

  // Resolve schedule time. If the Drop carries a scheduledAt in the future, honor it; else 'now'.
  let when = null;
  if (drop.scheduledAt) {
    const parsed = new Date(drop.scheduledAt);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) {
      when = parsed;
    }
  }

  const scheduled = [];
  const skipped = [];

  for (const integration of integrations) {
    const identifier = integration?.identifier ?? integration?.providerIdentifier;
    const id = integration?.id;
    const name = integration?.name ?? identifier ?? id;

    if (!id || !identifier) {
      skipped.push({ name, reason: 'integration missing id/identifier' });
      continue;
    }

    const mapping = POSTIZ_CHANNEL_MAP[identifier];
    if (!mapping) {
      skipped.push({ identifier, name, reason: 'no caption mapping' });
      continue;
    }

    if (mapping.requiresVideo) {
      skipped.push({ identifier, name, reason: 'requires video, not supported yet' });
      continue;
    }

    let content = drop[mapping.field];
    if (typeof content === 'string') content = content.trim();
    if (!content) {
      // Fallback chain: per-platform field -> socialCopy -> name. Avoid posting an empty caption.
      content = (drop.socialCopy && drop.socialCopy.trim()) || drop.name;
    }
    if (!content) {
      skipped.push({ identifier, name, reason: 'no caption available' });
      continue;
    }

    try {
      const result = await createPostizPost({
        integrationId: id,
        content,
        imageRef,
        when,
      });
      const postId = result?.id ?? result?.[0]?.id ?? result?.posts?.[0]?.id ?? null;
      console.log(`[bridge] drop=${slug} postiz scheduled ${identifier} (${name}) id=${postId} when=${when ? when.toISOString() : 'now'}`);
      scheduled.push({ identifier, name, id: postId, when: when ? when.toISOString() : 'now' });
    } catch (err) {
      console.error(`[bridge] drop=${slug} postiz post failed for ${identifier}: ${err.message}`);
      skipped.push({ identifier, name, reason: `error: ${err.message}` });
    }
  }

  return { ok: true, scheduled, skipped };
}

async function triggerSiteRebuild(drop) {
  if (CLOUDFLARE_DEPLOY_HOOK_URL) {
    const res = await fetch(CLOUDFLARE_DEPLOY_HOOK_URL, { method: 'POST' });
    if (!res.ok) throw new Error(`cloudflare ${res.status}: ${await res.text()}`);
    return res.json().catch(() => ({ ok: true, via: 'cloudflare-hook' }));
  }
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

  let sha;
  const getRes = await fetch(`${repoUrl}?ref=${GITHUB_DEPLOY_BRANCH}`, { headers });
  if (getRes.ok) {
    sha = (await getRes.json()).sha;
  } else if (getRes.status !== 404) {
    throw new Error(`github GET ${getRes.status}: ${await getRes.text()}`);
  }

  const now = new Date().toISOString();
  const slug = drop?.slug ?? drop?.id ?? 'unknown';
  const content = Buffer.from(`${now} ${slug}\n`, 'utf-8').toString('base64');

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
  console.log(`features: ai_copy=${Boolean(anthropic && STRAPI_BRIDGE_TOKEN)} postiz=${Boolean(POSTIZ_API_URL && POSTIZ_API_KEY)} cloudflare_hook=${Boolean(CLOUDFLARE_DEPLOY_HOOK_URL)}`);
});
