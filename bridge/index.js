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
  // Kill switch: when 'true' the bridge builds the exact payload it would send
  // to Postiz's /public/v1/posts and logs it, but skips the actual POST. Lets
  // us validate fan-out shape end to end without any content going live.
  // Flip to any other value (or unset) to publish for real.
  POSTIZ_DRY_RUN = 'true',

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
//
// Strapi 5 fires entry.publish the FIRST time a draft is published. On
// re-publishes of an already-published entry, Strapi fires entry.update on the
// draft, not entry.publish, so we also accept entry.update when the entry is
// currently published (publishedAt set). A short-TTL in-memory de-dupe stops
// us from double-firing when both events land in the same request-cycle.
// -----------------------------------------------------------------------------

// key = `${documentId}-${publishedAt}` -> Date.now(). 10-second TTL.
const publishDedupe = new Map();
const PUBLISH_DEDUPE_TTL_MS = 10_000;
function sweepPublishDedupe() {
  const cutoff = Date.now() - PUBLISH_DEDUPE_TTL_MS;
  for (const [k, ts] of publishDedupe) {
    if (ts < cutoff) publishDedupe.delete(k);
  }
}

app.post('/strapi/publish', async (req, res) => {
  if (req.get('x-bridge-secret') !== WEBHOOK_SHARED_SECRET) {
    console.warn('[bridge] 401, x-bridge-secret missing or mismatched');
    return res.status(401).json({ error: 'unauthorized' });
  }

  const event = req.body;
  console.log(`[bridge] event ${event?.event} on model ${event?.model}`);
  if (event?.model !== 'drop') {
    return res.json({ skipped: true, reason: 'not a drop' });
  }
  const entryPublishedAt = event?.entry?.publishedAt;
  const isPublishEvent = event?.event === 'entry.publish';
  const isRepublishUpdate =
    event?.event === 'entry.update'
    && typeof entryPublishedAt === 'string'
    && entryPublishedAt.trim().length > 0;
  if (!isPublishEvent && !isRepublishUpdate) {
    return res.json({ skipped: true, reason: 'not a drop publish' });
  }

  sweepPublishDedupe();
  const dedupeKey = `${event?.entry?.documentId ?? event?.entry?.id ?? 'unknown'}-${entryPublishedAt ?? ''}`;
  if (publishDedupe.has(dedupeKey)) {
    console.log(`[bridge] fan-out skipped, duplicate publish within TTL (key=${dedupeKey}, trigger=${event.event})`);
    return res.json({ skipped: true, reason: 'duplicate publish within TTL', trigger: event.event });
  }
  publishDedupe.set(dedupeKey, Date.now());

  if (isPublishEvent) {
    console.log('[bridge] fan-out triggered by entry.publish');
  } else {
    console.log('[bridge] fan-out triggered by entry.update (already-published re-fire)');
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

// identifier -> {
//   field:            caption field on the Drop to send as post content.
//   requiresVideo:    true means skip until we have a video pipeline.
//   maxContentLength: hard cap the caption at N chars before posting
//                     (X: 280, Bluesky: 300, Mastodon: 500). Truncated with
//                     a trailing period, no em-dashes.
//   note:             human-readable note surfaced through /health (currently
//                     latent) so Tyler sees per-channel gotchas without
//                     spelunking through this file.
//   buildSettings(drop): return the platform-specific settings object Postiz
//                        expects for that provider's DTO. Return null to
//                        signal "cannot post without more config, skip this
//                        channel this run". Used for channels whose Postiz
//                        DTO requires a per-account id (Pinterest board,
//                        Discord/Slack channel, Whop company/experience,
//                        etc.) that we source from env vars.
//   settings:         static settings object, alternative to buildSettings.
// If neither settings nor buildSettings is provided, an empty {} is sent,
// which is correct for providers whose DTO is empty or whose fields are all
// optional (Facebook, Threads, Twitch, Kick, Tumblr, GMB, Bluesky, Mastodon,
// Telegram, Nostr, VK).
const POSTIZ_CHANNEL_MAP = {
  // ---- Photo-first, active today ----
  'instagram-standalone': {
    field: 'captionInstagram',
    requiresVideo: false,
    // InstagramDto requires post_type: 'post' | 'story'. Default to feed post.
    buildSettings: () => ({ post_type: 'post' }),
  },
  'instagram': {
    field: 'captionInstagram',
    requiresVideo: false,
    buildSettings: () => ({ post_type: 'post' }),
  },
  'facebook': {
    field: 'socialCopy',
    requiresVideo: false,
    // FacebookDto: all fields optional. Empty {} is valid.
  },
  'threads': {
    field: 'captionThreads',
    requiresVideo: false,
    // No DTO in Postiz for Threads.
  },
  'pinterest': {
    field: 'captionPinterest',
    requiresVideo: false,
    note: 'Pinterest requires a board id from the OAuth-connected board list. Set POSTIZ_PINTEREST_BOARD_ID env var (the Pinterest board id) before publishing.',
    buildSettings: (drop) => {
      const board = process.env.POSTIZ_PINTEREST_BOARD_ID;
      if (!board) return null;
      const title = (drop && drop.name ? String(drop.name) : '').slice(0, 100);
      return { board, title };
    },
  },
  // TikTok supports photo carousels via the Content Posting API's PHOTO media
  // type (rides on video.publish scope). Postiz handles the mode selection
  // automatically based on the media type we upload. Flip requiresVideo false
  // so we actually attempt the post; if it fails inside Postiz we surface the
  // error rather than silently skipping.
  // TikTok Sandbox forces all posts to private regardless of the requested
  // privacy_level. In Production the accepted values are:
  //   PUBLIC_TO_EVERYONE, MUTUAL_FOLLOW_FRIENDS, FOLLOWER_OF_CREATOR, SELF_ONLY
  // We ship SELF_ONLY explicitly so Sandbox test posts land as private drafts
  // in the account owner's TikTok Studio, and so Production posts remain
  // private until Tyler flips the value here.
  // Postiz's TikTokDto validates all ten of the fields below; sending fewer
  // yields a 400 with "must be a boolean value" errors. We pass a function
  // (not a plain object) so we can slice the drop name into TikTok's 90-char
  // title cap without touching the rest of the fan-out logic.
  'tiktok': {
    field: 'captionTikTok',
    requiresVideo: false,
    buildSettings: (drop) => ({
      title: (drop && drop.name ? String(drop.name) : '').slice(0, 90),
      privacy_level: 'SELF_ONLY',
      duet: false,
      stitch: false,
      comment: false,
      autoAddMusic: 'no',
      brand_content_toggle: false,
      video_made_with_ai: false,
      brand_organic_toggle: false,
      content_posting_method: 'DIRECT_POST',
    }),
  },
  'youtube': {
    field: 'captionYoutubeTitle',
    requiresVideo: true,
    // YoutubeSettingsDto requires title (2..100 chars) and type (public /
    // private / unlisted). Kept as requiresVideo so the fan-out skips the
    // post entirely; when the video pipeline lands, buildSettings should be
    // { title: drop.name.slice(0, 100), type: 'private' } for test posts.
    note: 'Requires a video asset. Skipped until we have a Drop video pipeline. When enabled, ship type=private for initial test posts.',
  },
  // Reddit posts are most natural in the buy/sell community voice (price +
  // condition + brief description + DM CTA). Reuse the captionFacebookGroup
  // field which is tuned for that tone. Reddit DTO requires per-subreddit
  // settings (subreddit id, flair rules, post type); Postiz UI handles that
  // when the integration is picked, so we send an empty settings object and
  // let Postiz's own validation surface the error if any is missing.
  'reddit': { field: 'captionFacebookGroup', requiresVideo: false },

  // ---- Text-first channels with empty or all-optional DTOs ----
  'linkedin': {
    field: 'socialCopy',
    requiresVideo: false,
    // LinkedinDto fields are all optional. Explicit false keeps posts as a
    // single share rather than an image carousel.
    buildSettings: () => ({ post_as_images_carousel: false }),
  },
  'linkedin-page': {
    field: 'socialCopy',
    requiresVideo: false,
    buildSettings: () => ({ post_as_images_carousel: false }),
  },
  'x': {
    field: 'socialCopy',
    requiresVideo: false,
    maxContentLength: 280,
    note: 'X (Twitter) API access requires the paid Basic tier (~$100/mo as of 2026-07). Postiz posts will 401 without it. XDto also requires who_can_reply_post, defaulted to everyone.',
    buildSettings: () => ({ who_can_reply_post: 'everyone' }),
  },
  'bluesky': {
    field: 'socialCopy',
    requiresVideo: false,
    maxContentLength: 300,
    // No DTO in Postiz. Bluesky natively caps posts at 300 chars.
  },
  'mastodon': {
    field: 'socialCopy',
    requiresVideo: false,
    maxContentLength: 500,
    // No DTO. Default Mastodon instances cap at 500 chars.
  },
  'telegram': { field: 'socialCopy', requiresVideo: false },
  'nostr':    { field: 'socialCopy', requiresVideo: false },
  'vk':       { field: 'socialCopy', requiresVideo: false },
  'twitch':   { field: 'socialCopy', requiresVideo: false }, // TwitchDto all optional.
  'kick':     { field: 'socialCopy', requiresVideo: false }, // KickDto is an empty class.
  'tumblr':   { field: 'socialCopy', requiresVideo: false }, // TumblrDto all optional.
  'gmb':      { field: 'socialCopy', requiresVideo: false }, // GmbSettingsDto all optional.
  // Alias in case a future Postiz build emits the long form on integrations.
  'google-my-business': { field: 'socialCopy', requiresVideo: false },

  // ---- Channels needing per-account IDs, gated on env vars ----
  'discord': {
    field: 'socialCopy',
    requiresVideo: false,
    note: 'Discord requires a channel id from the connected server. Set POSTIZ_DISCORD_CHANNEL_ID env var.',
    buildSettings: () => {
      const channel = process.env.POSTIZ_DISCORD_CHANNEL_ID;
      if (!channel) return null;
      return { channel };
    },
  },
  'slack': {
    field: 'socialCopy',
    requiresVideo: false,
    note: 'Slack requires a channel id from the connected workspace. Set POSTIZ_SLACK_CHANNEL_ID env var.',
    buildSettings: () => {
      const channel = process.env.POSTIZ_SLACK_CHANNEL_ID;
      if (!channel) return null;
      return { channel };
    },
  },
  'mewe': {
    field: 'socialCopy',
    requiresVideo: false,
    // MeweDto requires postType (timeline or group). Default to timeline;
    // set POSTIZ_MEWE_GROUP_ID to switch to a group post.
    buildSettings: () => {
      const group = process.env.POSTIZ_MEWE_GROUP_ID;
      if (group) return { postType: 'group', group };
      return { postType: 'timeline' };
    },
  },
  'whop': {
    field: 'socialCopy',
    requiresVideo: false,
    note: 'Whop requires company id + experience (forum) id. Set POSTIZ_WHOP_COMPANY_ID and POSTIZ_WHOP_EXPERIENCE_ID env vars.',
    buildSettings: (drop) => {
      const company = process.env.POSTIZ_WHOP_COMPANY_ID;
      const experience = process.env.POSTIZ_WHOP_EXPERIENCE_ID;
      if (!company || !experience) return null;
      const title = (drop && drop.name ? String(drop.name) : 'New Drop').slice(0, 200);
      return { company, experience, title };
    },
  },
  'skool': {
    field: 'socialCopy',
    requiresVideo: false,
    note: 'Skool requires a group id and a label (category) id. Set POSTIZ_SKOOL_GROUP_ID and POSTIZ_SKOOL_LABEL_ID env vars.',
    buildSettings: (drop) => {
      const group = process.env.POSTIZ_SKOOL_GROUP_ID;
      const label = process.env.POSTIZ_SKOOL_LABEL_ID;
      if (!group || !label) return null;
      const title = (drop && drop.name ? String(drop.name) : 'New Drop').slice(0, 200);
      return { group, label, title };
    },
  },
  'moltbook': {
    field: 'socialCopy',
    requiresVideo: false,
    note: 'Moltbook requires a submolt id (Moltbook s equivalent of a subreddit). Set POSTIZ_MOLTBOOK_SUBMOLT env var.',
    buildSettings: () => {
      const submolt = process.env.POSTIZ_MOLTBOOK_SUBMOLT;
      if (!submolt) return null;
      return { submolt };
    },
  },
  'listmonk': {
    field: 'socialCopy',
    requiresVideo: false,
    note: 'Listmonk requires a mailing list id. Set POSTIZ_LISTMONK_LIST_ID (and optionally POSTIZ_LISTMONK_TEMPLATE_ID) env vars.',
    buildSettings: (drop) => {
      const list = process.env.POSTIZ_LISTMONK_LIST_ID;
      if (!list) return null;
      const subject = (drop && drop.name ? String(drop.name) : 'New Drop').slice(0, 150);
      const previewSrc = drop && drop.socialCopy ? String(drop.socialCopy) : subject;
      const preview = previewSrc.slice(0, 200);
      const template = process.env.POSTIZ_LISTMONK_TEMPLATE_ID;
      return template ? { subject, preview, list, template } : { subject, preview, list };
    },
  },
  'lemmy': {
    field: 'captionFacebookGroup',
    requiresVideo: false,
    note: 'Lemmy requires at least one community. Set POSTIZ_LEMMY_COMMUNITY_ID and POSTIZ_LEMMY_COMMUNITY_NAME env vars.',
    buildSettings: (drop) => {
      const communityId = process.env.POSTIZ_LEMMY_COMMUNITY_ID;
      const communityName = process.env.POSTIZ_LEMMY_COMMUNITY_NAME;
      if (!communityId || !communityName) return null;
      const title = (drop && drop.name ? String(drop.name) : 'New Drop').slice(0, 200);
      return {
        subreddit: [{
          value: {
            id: communityId,
            subreddit: communityName,
            title,
          },
        }],
      };
    },
  },
  'wrapcast': {
    // Postiz's identifier for Farcaster in the AllProvidersSettings union is
    // "wrapcast". Kept for the deployed Postiz build.
    field: 'socialCopy',
    requiresVideo: false,
    note: 'Farcaster (wrapcast) requires channel ids. Set POSTIZ_FARCASTER_CHANNEL_ID env var.',
    buildSettings: () => {
      const channelId = process.env.POSTIZ_FARCASTER_CHANNEL_ID;
      if (!channelId) return null;
      return { subreddit: [{ value: { id: channelId } }] };
    },
  },
  'farcaster': {
    // Alias in case a future Postiz build normalizes the identifier.
    field: 'socialCopy',
    requiresVideo: false,
    note: 'Farcaster requires channel ids. Set POSTIZ_FARCASTER_CHANNEL_ID env var.',
    buildSettings: () => {
      const channelId = process.env.POSTIZ_FARCASTER_CHANNEL_ID;
      if (!channelId) return null;
      return { subreddit: [{ value: { id: channelId } }] };
    },
  },

  // ---- Long-form content channels ----
  'medium': {
    field: 'captionYoutubeDescription',
    requiresVideo: false,
    // MediumSettingsDto requires title (min 2) and subtitle (min 2).
    buildSettings: (drop) => {
      const title = (drop && drop.name ? String(drop.name) : 'New Drop').slice(0, 100);
      const subtitleSrc = drop && drop.socialCopy
        ? String(drop.socialCopy)
        : (drop && drop.name ? String(drop.name) : 'New Drop');
      const subtitle = subtitleSrc.slice(0, 200);
      return { title, subtitle, tags: [] };
    },
  },
  'devto': {
    field: 'captionYoutubeDescription',
    requiresVideo: false,
    // DevToSettingsDto requires title (min 2) and a tags array (may be empty).
    buildSettings: (drop) => ({
      title: (drop && drop.name ? String(drop.name) : 'New Drop').slice(0, 100),
      tags: [],
    }),
  },
  // Alias in case a future Postiz build emits the hyphenated identifier.
  'dev-to': {
    field: 'captionYoutubeDescription',
    requiresVideo: false,
    buildSettings: (drop) => ({
      title: (drop && drop.name ? String(drop.name) : 'New Drop').slice(0, 100),
      tags: [],
    }),
  },
  'hashnode': {
    field: 'captionYoutubeDescription',
    requiresVideo: false,
    note: 'Hashnode requires a publication id and at least one tag. Set POSTIZ_HASHNODE_PUBLICATION_ID env var. Optional POSTIZ_HASHNODE_TAG_VALUE / POSTIZ_HASHNODE_TAG_LABEL override the default tag.',
    buildSettings: (drop) => {
      const publication = process.env.POSTIZ_HASHNODE_PUBLICATION_ID;
      if (!publication) return null;
      const tagValue = process.env.POSTIZ_HASHNODE_TAG_VALUE || 'fashion';
      const tagLabel = process.env.POSTIZ_HASHNODE_TAG_LABEL || 'Fashion';
      const title = (drop && drop.name ? String(drop.name) : 'New Drop').slice(0, 100);
      return {
        title,
        publication,
        tags: [{ value: tagValue, label: tagLabel }],
      };
    },
  },
  'wordpress': {
    field: 'captionYoutubeDescription',
    requiresVideo: false,
    // WordpressDto requires title and type. Default type=post and
    // status=publish so entries go live rather than sitting as drafts.
    buildSettings: (drop) => ({
      title: (drop && drop.name ? String(drop.name) : 'New Drop').slice(0, 100),
      type: 'post',
      status: 'publish',
    }),
  },
  'dribbble': {
    field: 'socialCopy',
    requiresVideo: false,
    // DribbbleDto requires title (min 1). Team is optional.
    buildSettings: (drop) => ({
      title: (drop && drop.name ? String(drop.name) : 'New Drop').slice(0, 100),
    }),
  },
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

async function createPostizPost({ integrationId, content, imageRef, when, settings }) {
  const scheduleType = when ? 'schedule' : 'now';
  const date = (when ?? new Date()).toISOString();
  // PostContent DTO shape: content string, an id (arbitrary, we use random),
  // a delay in seconds (0 for immediate), and image[] of {id, path} refs.
  const value = [{
    content,
    id: randomIdish(),
    delay: 0,
    image: imageRef ? [imageRef] : [],
  }];
  const postEntry = {
    integration: { id: integrationId },
    value,
    group: randomIdish(),
    settings: settings || {},
  };
  const body = {
    type: scheduleType,
    date,
    shortLink: false,
    tags: [],
    posts: [postEntry],
  };
  if (POSTIZ_DRY_RUN === 'true') {
    console.log(`[postiz] DRY_RUN body=${JSON.stringify(body).slice(0, 400)}`);
    return { dryRun: true, postId: `dry-run-${randomIdish()}`, wouldPost: body };
  }
  return postizFetch('/public/v1/posts', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// Postiz's PostsService.createPost returns an array of { postId, integration }
// (one entry per created channel post). posts.controller returns that array
// verbatim, so the /public/v1/posts response body is that shape too. Some
// deployments wrap it under { posts: [...] }, so we accept both.
function extractPostizPostId(result) {
  if (!result) return null;
  if (typeof result === 'object' && 'postId' in result && result.postId) return result.postId;
  if (Array.isArray(result) && result[0]?.postId) return result[0].postId;
  if (Array.isArray(result?.posts) && result.posts[0]?.postId) return result.posts[0].postId;
  // Legacy/compat fallbacks in case a future Postiz version renames the field.
  if (Array.isArray(result) && result[0]?.id) return result[0].id;
  if (result?.id) return result.id;
  return null;
}

function randomIdish() {
  // Postiz just wants a string in these id/group slots; we generate one on
  // the fly so it does not collide across drops or channels.
  return 'br-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now();
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

    // Honor per-platform hard length caps (X 280, Bluesky 300, Mastodon 500).
    // Slice with a trailing period rather than an em-dash, per brand rule.
    if (mapping.maxContentLength && typeof content === 'string'
        && content.length > mapping.maxContentLength) {
      const cap = Math.max(1, mapping.maxContentLength - 1);
      content = content.slice(0, cap).trimEnd() + '.';
    }

    // Per-platform settings can be either a static object on mapping.settings
    // or a function on mapping.buildSettings(drop) when values need to derive
    // from the drop (TikTok's title from drop.name, for example).
    // buildSettings may return null to signal "cannot post without more
    // per-account config" (e.g., Pinterest board id, Discord/Slack channel
    // id). In that case we skip the channel with the mapping's note so Tyler
    // sees the specific env var to set.
    let settings;
    if (typeof mapping.buildSettings === 'function') {
      settings = mapping.buildSettings(drop);
      if (settings === null) {
        skipped.push({
          identifier,
          name,
          reason: mapping.note || 'requires per-account config, not yet set',
        });
        continue;
      }
    } else {
      settings = mapping.settings;
    }
    try {
      const result = await createPostizPost({
        integrationId: id,
        content,
        imageRef,
        when,
        settings,
      });
      const postId = extractPostizPostId(result);
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

// -----------------------------------------------------------------------------
// eBay Sell API integration
//
// Full design + auth flow: docs/EBAY-INTEGRATION.md.
// Three-call dance per Drop publish:
//   1. PUT  /sell/inventory/v1/inventory_item/{sku}      (create/update product)
//   2. POST /sell/inventory/v1/offer                     (attach price + policies)
//   3. POST /sell/inventory/v1/offer/{offerId}/publish/  (flip live, get listingId)
//
// Token refresh uses the long-lived EBAY_REFRESH_TOKEN in .env. Access token is
// cached in-process for ~2h, refreshed on demand.
//
// Merchant location "prestige_default" is bootstrapped at startup (once) if the
// eBay env vars are present. eBay requires at least one merchant location key
// on every offer.
//
// Everything here is guarded by if-configured checks. If EBAY_APP_ID or
// EBAY_REFRESH_TOKEN are unset, the module logs and returns skip results so
// the rest of /strapi/publish is not blocked.
// -----------------------------------------------------------------------------

const EBAY_MERCHANT_LOCATION_KEY = 'prestige_default';
const EBAY_INVENTORY_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.inventory';

// Access-token cache. Refresh when missing or when within 60s of expiry.
let ebayAccessToken = null;
let ebayAccessTokenExpiresAt = 0; // epoch ms

function ebayBaseUrl() {
  return EBAY_ENV === 'production'
    ? 'https://api.ebay.com'
    : 'https://api.sandbox.ebay.com';
}

function ebayAuthUrl() {
  return EBAY_ENV === 'production'
    ? 'https://api.ebay.com/identity/v1/oauth2/token'
    : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';
}

async function refreshEbayUserToken() {
  if (!EBAY_APP_ID || !EBAY_CERT_ID || !EBAY_REFRESH_TOKEN) {
    console.warn('[bridge][ebay] refresh skipped, missing EBAY_APP_ID / EBAY_CERT_ID / EBAY_REFRESH_TOKEN');
    return null;
  }
  const basic = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT_ID}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: EBAY_REFRESH_TOKEN,
    scope: EBAY_INVENTORY_SCOPE,
  }).toString();
  try {
    const res = await fetch(ebayAuthUrl(), {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok || !json?.access_token) {
      const snippet = (text ?? '').slice(0, 300);
      console.error(`[bridge][ebay] token refresh failed ${res.status}: ${snippet}`);
      return null;
    }
    ebayAccessToken = json.access_token;
    const expiresInSec = Number(json.expires_in) || 7200;
    ebayAccessTokenExpiresAt = Date.now() + (expiresInSec * 1000) - 60_000;
    if (json.refresh_token && json.refresh_token !== EBAY_REFRESH_TOKEN) {
      console.warn('[bridge][ebay] refresh_token was rotated by eBay, update EBAY_REFRESH_TOKEN in .env');
    }
    console.log(`[bridge][ebay] access token refreshed, valid for ${expiresInSec}s (env=${EBAY_ENV})`);
    return ebayAccessToken;
  } catch (err) {
    console.error(`[bridge][ebay] token refresh threw: ${err.message}`);
    return null;
  }
}

async function ensureEbayAccessToken() {
  if (ebayAccessToken && Date.now() < ebayAccessTokenExpiresAt) return ebayAccessToken;
  return refreshEbayUserToken();
}

async function ebayHeaders() {
  await ensureEbayAccessToken();
  return {
    'Authorization': `Bearer ${ebayAccessToken}`,
    'Content-Type': 'application/json',
    'Content-Language': 'en-US',
  };
}

// eBay Sell Inventory API ConditionEnum, as strings (not the legacy numeric
// codes used by the Trading API). "New with tags" is not a distinct Inventory
// API value for most categories, it maps to NEW. Refurbished maps to the
// generic SELLER_REFURBISHED bucket. Pre-owned resale designer goods go under
// USED_EXCELLENT since Tyler curates to that quality bar.
function mapCondition(strapiCondition) {
  switch ((strapiCondition ?? '').trim()) {
    case 'New':               return 'NEW';
    case 'New with tags':     return 'NEW_WITH_TAGS';
    case 'Pre-Owned':         return 'USED_EXCELLENT';
    case 'Refurbished':       return 'SELLER_REFURBISHED';
    case 'For parts':         return 'FOR_PARTS_OR_NOT_WORKING';
    default:                  return 'USED_EXCELLENT';
  }
}

function firstWord(str) {
  if (!str || typeof str !== 'string') return '';
  const trimmed = str.trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0];
}

function numericPrice(priceString) {
  if (priceString == null) return '0.00';
  const raw = String(priceString).replace(/[^0-9.]/g, '');
  const num = Number.parseFloat(raw);
  if (!Number.isFinite(num)) return '0.00';
  return num.toFixed(2);
}

function publicImageUrl(image) {
  if (!image) return null;
  // Strapi payload shape can be a media object ({url}) or a raw path string.
  const path = typeof image === 'string' ? image : (image.url ?? image.formats?.large?.url ?? null);
  if (!path) return null;
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return `${STRAPI_PUBLIC_URL}${path.startsWith('/') ? '' : '/'}${path}`;
}

async function ebayApiFetch(path, init = {}) {
  const url = `${ebayBaseUrl()}${path}`;
  const headers = { ...(await ebayHeaders()), ...(init.headers ?? {}) };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body, rawText: text };
}

async function ensureEbayMerchantLocation() {
  if (!EBAY_APP_ID || !EBAY_REFRESH_TOKEN) {
    console.log('[bridge][ebay] merchant location bootstrap skipped, eBay not configured');
    return { skipped: 'not configured' };
  }
  if (!EBAY_DEFAULT_LOCATION_ZIP) {
    console.warn('[bridge][ebay] merchant location bootstrap skipped, EBAY_DEFAULT_LOCATION_ZIP unset');
    return { skipped: 'no default zip' };
  }
  const token = await ensureEbayAccessToken();
  if (!token) {
    console.warn('[bridge][ebay] merchant location bootstrap skipped, no access token');
    return { skipped: 'no access token' };
  }
  const body = {
    location: {
      address: {
        postalCode: EBAY_DEFAULT_LOCATION_ZIP,
        country: 'US',
      },
    },
    name: 'Prestige Accessories',
    merchantLocationStatus: 'ENABLED',
    locationTypes: ['WAREHOUSE'],
  };
  try {
    const result = await ebayApiFetch(`/sell/inventory/v1/location/${EBAY_MERCHANT_LOCATION_KEY}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    // 204 on create. 409 (conflict) means the location already exists, treat as success.
    if (result.ok || result.status === 204 || result.status === 409) {
      console.log(`[bridge][ebay] merchant location "${EBAY_MERCHANT_LOCATION_KEY}" ready (status=${result.status})`);
      return { ok: true, status: result.status };
    }
    const snippet = typeof result.body === 'string' ? result.body.slice(0, 300) : JSON.stringify(result.body).slice(0, 300);
    console.error(`[bridge][ebay] merchant location bootstrap failed ${result.status}: ${snippet}`);
    return { ok: false, status: result.status, error: snippet };
  } catch (err) {
    console.error(`[bridge][ebay] merchant location bootstrap threw: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function publishDropToEbay(drop) {
  if (!EBAY_APP_ID || !EBAY_REFRESH_TOKEN) {
    return { skipped: 'ebay not configured' };
  }
  if (!drop) {
    return { skipped: 'no drop payload' };
  }
  const sku = drop.slug;
  if (!sku) {
    return { skipped: 'drop has no slug (required as SKU)' };
  }

  const token = await ensureEbayAccessToken();
  if (!token) {
    return { ok: false, step: 'auth', error: 'could not obtain access token' };
  }

  const imageUrl = publicImageUrl(drop.image);
  const imageUrls = imageUrl ? [imageUrl] : [];

  // Step 1, create or replace the inventory item.
  const inventoryBody = {
    product: {
      title: drop.ebayTitle || drop.name || sku,
      description: drop.ebayDescription || drop.socialCopy || drop.name || '',
      aspects: {
        Brand:    [firstWord(drop.name) || 'Prestige'],
        Color:    [drop.ebayColor || 'Unspecified'],
        Size:     [drop.ebaySize || 'One Size'],
        Material: [drop.ebayMaterial || 'Unspecified'],
      },
      imageUrls,
    },
    condition: mapCondition(drop.condition),
    availability: {
      shipToLocationAvailability: {
        quantity: Number(drop.ebayInventoryQuantity) || 1,
      },
    },
  };

  const step1 = await ebayApiFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: 'PUT',
    body: JSON.stringify(inventoryBody),
  });
  if (!step1.ok && step1.status !== 204) {
    const snippet = typeof step1.body === 'string' ? step1.body.slice(0, 300) : JSON.stringify(step1.body).slice(0, 300);
    console.error(`[bridge][ebay] createOrReplaceInventoryItem ${step1.status}: ${snippet}`);
    return { ok: false, step: 'inventory_item', status: step1.status, error: snippet };
  }

  // Step 2, create the offer.
  const offerBody = {
    sku,
    marketplaceId: 'EBAY_US',
    format: 'FIXED_PRICE',
    availableQuantity: Number(drop.ebayInventoryQuantity) || 1,
    pricingSummary: {
      price: {
        value: numericPrice(drop.price),
        currency: 'USD',
      },
    },
    categoryId: String(drop.ebayCategoryId || EBAY_DEFAULT_CATEGORY_ID),
    merchantLocationKey: EBAY_MERCHANT_LOCATION_KEY,
    listingPolicies: {
      fulfillmentPolicyId: drop.ebayShippingPolicyId || EBAY_DEFAULT_SHIPPING_POLICY_ID,
      paymentPolicyId:     drop.ebayPaymentPolicyId  || EBAY_DEFAULT_PAYMENT_POLICY_ID,
      returnPolicyId:      drop.ebayReturnPolicyId   || EBAY_DEFAULT_RETURN_POLICY_ID,
    },
    listingDescription: drop.ebayDescription || drop.socialCopy || drop.name || '',
  };

  const step2 = await ebayApiFetch('/sell/inventory/v1/offer', {
    method: 'POST',
    body: JSON.stringify(offerBody),
  });
  if (!step2.ok) {
    const snippet = typeof step2.body === 'string' ? step2.body.slice(0, 300) : JSON.stringify(step2.body).slice(0, 300);
    console.error(`[bridge][ebay] createOffer ${step2.status}: ${snippet}`);
    return { ok: false, step: 'offer', status: step2.status, error: snippet };
  }
  const offerId = step2.body?.offerId;
  if (!offerId) {
    return { ok: false, step: 'offer', error: 'createOffer returned no offerId' };
  }

  // Step 3, publish the offer, flip live.
  const step3 = await ebayApiFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish/`, {
    method: 'POST',
  });
  if (!step3.ok) {
    const snippet = typeof step3.body === 'string' ? step3.body.slice(0, 300) : JSON.stringify(step3.body).slice(0, 300);
    console.error(`[bridge][ebay] publishOffer ${step3.status}: ${snippet}`);
    return { ok: false, step: 'publish', status: step3.status, error: snippet, offerId };
  }
  const listingId = step3.body?.listingId;
  console.log(`[bridge][ebay] drop=${sku} listing live, listingId=${listingId} offerId=${offerId}`);
  return { ok: true, listingId, offerId };
}

app.listen(PORT, () => {
  console.log(`bridge listening on :${PORT}`);
  console.log(`features: ai_copy=${Boolean(anthropic && STRAPI_BRIDGE_TOKEN)} postiz=${Boolean(POSTIZ_API_URL && POSTIZ_API_KEY)} cloudflare_hook=${Boolean(CLOUDFLARE_DEPLOY_HOOK_URL)} ebay=${Boolean(EBAY_APP_ID && EBAY_REFRESH_TOKEN)}`);
  // Best-effort merchant location bootstrap at startup. Never crashes the process.
  if (EBAY_APP_ID && EBAY_REFRESH_TOKEN) {
    ensureEbayMerchantLocation()
      .then(r => console.log(`[bridge][ebay] merchant location bootstrap result: ${JSON.stringify(r)}`))
      .catch(err => console.error(`[bridge][ebay] merchant location bootstrap error: ${err.message}`));
  }
});
