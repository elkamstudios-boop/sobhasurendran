// Thumbnail Fetch API
// - Instagram/Facebook post URLs -> Meta oEmbed (requires META_APP_ID/SECRET)
// - Any other URL (news article) -> server-side og:image scrape
// - "Most viewed" ranking for YOUR OWN IG Business Account / FB Page content ->
//   Graph API Insights (requires IG_BUSINESS_ACCOUNT_ID/IG_ACCESS_TOKEN and/or
//   FB_PAGE_ID/FB_PAGE_ACCESS_TOKEN). There is no public API for view counts on
//   content you don't own, so this only ranks the reels/videos already listed in
//   data/sources.json against your connected account's real Insights data.
//
// Run: npm install && npm start   (fill in .env first — see .env.example)

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const cron = require('node-cron');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8787;

// The frontend (Sobha Surendran.dc.html) is served from a different origin
// (the Claude Design preview, or wherever the static site is hosted), so these
// endpoints need CORS enabled. POST + Content-Type:application/json (the form
// submit routes) counts as a non-simple request, so browsers send a CORS
// preflight OPTIONS request first — it must get an explicit 204, not fall
// through to Express's routing (which would 404 it).
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_HOURS) || 12) * 60 * 60 * 1000;
const CACHE_PATH = path.join(__dirname, 'data', 'thumbnail-cache.json');
const VIEWS_CACHE_TTL_MS = (Number(process.env.VIEWS_CACHE_TTL_HOURS) || 6) * 60 * 60 * 1000;
const VIEWS_CACHE_PATH = path.join(__dirname, 'data', 'views-cache.json');
const FB_SHARE_MAP_PATH = path.join(__dirname, 'data', 'fb-share-link-map.json');
const NEWSROOM_CACHE_TTL_MS = (Number(process.env.NEWSROOM_CACHE_TTL_HOURS) || 1) * 60 * 60 * 1000;
const NEWSROOM_CACHE_PATH = path.join(__dirname, 'data', 'newsroom-cache.json');
const GRAPH_VERSION = 'v19.0';

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}
function loadViewsCache() {
  try { return JSON.parse(fs.readFileSync(VIEWS_CACHE_PATH, 'utf8')); } catch { return {}; }
}
function saveViewsCache(cache) {
  fs.mkdirSync(path.dirname(VIEWS_CACHE_PATH), { recursive: true });
  fs.writeFileSync(VIEWS_CACHE_PATH, JSON.stringify(cache, null, 2));
}
function loadShareMap() {
  try { return JSON.parse(fs.readFileSync(FB_SHARE_MAP_PATH, 'utf8')); } catch { return {}; }
}
function saveShareMap(map) {
  fs.mkdirSync(path.dirname(FB_SHARE_MAP_PATH), { recursive: true });
  fs.writeFileSync(FB_SHARE_MAP_PATH, JSON.stringify(map, null, 2));
}
function loadNewsroomCache() {
  try { return JSON.parse(fs.readFileSync(NEWSROOM_CACHE_PATH, 'utf8')); } catch { return null; }
}
function saveNewsroomCache(data) {
  fs.mkdirSync(path.dirname(NEWSROOM_CACHE_PATH), { recursive: true });
  fs.writeFileSync(NEWSROOM_CACHE_PATH, JSON.stringify({ fetched_at: Date.now(), data }, null, 2));
}

// Scraping external sites (Facebook share links, news articles) has no
// guaranteed response time — some targets are slow or silently drop the
// connection from this server's network. A plain fetch() with no timeout
// hangs for the platform default (tens of seconds), blocking the whole
// request behind it. Abort and move on instead.
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function detectPlatform(url) {
  if (/instagram\.com/i.test(url)) return 'instagram';
  if (/facebook\.com|fb\.watch/i.test(url)) return 'facebook';
  return 'article';
}

function getAppAccessToken() {
  // Meta's simplest server-to-server token: "{app-id}|{app-secret}"
  // (Sufficient for oEmbed Read; for production, prefer a proper token exchange.)
  const id = process.env.META_APP_ID;
  const secret = process.env.META_APP_SECRET;
  if (!id || !secret) return null;
  return `${id}|${secret}`;
}

async function fetchMetaOEmbed(url, platform) {
  const token = getAppAccessToken();
  if (!token) {
    throw new Error(
      'META_APP_ID / META_APP_SECRET not set — required for Instagram/Facebook oEmbed. ' +
      'See README.md for how to create a Meta developer app.'
    );
  }
  const endpoint = platform === 'instagram' ? 'instagram_oembed' : 'facebook_oembed';
  const api = `https://graph.facebook.com/v19.0/${endpoint}?url=${encodeURIComponent(url)}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(api);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Meta oEmbed ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return {
    url,
    platform,
    thumbnail_url: data.thumbnail_url || null,
    title: data.title || null,
    author_name: data.author_name || null,
  };
}

async function fetchOgImage(url) {
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ThumbnailFetchBot/1.0)' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Fetch ${res.status} for ${url}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const image =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('article img').first().attr('src') ||
    $('img').first().attr('src') ||
    null;
  const title = $('meta[property="og:title"]').attr('content') || $('title').first().text() || null;
  return { url, platform: 'article', thumbnail_url: image, title, author_name: null };
}

// ---------------------------------------------------------------------------
// "Most viewed" ranking — only works for content posted from YOUR OWN
// connected IG Business Account / FB Page. Meta's public APIs (oEmbed
// included) never expose view counts for arbitrary posts you don't own, and
// there is no legitimate endpoint for "trending" content platform-wide.
// ---------------------------------------------------------------------------

function extractIgShortcode(url) {
  const m = url.match(/instagram\.com\/(?:reel|p|tv)\/([^/?]+)/i);
  return m ? m[1] : null;
}

function extractFbVideoId(url) {
  // Canonical FB video/reel permalinks end in a numeric ID, but the path shape
  // varies: /reel/<id>/, /<page>/videos/<id>/, /<page>/videos/<title-slug>/<id>/.
  // Parse the path rather than assuming the ID immediately follows "videos/".
  try {
    const u = new URL(url, 'https://www.facebook.com');
    const segments = u.pathname.split('/').filter(Boolean);
    if (segments.includes('videos') || segments.includes('reel')) {
      const last = segments[segments.length - 1];
      if (/^\d+$/.test(last)) return last;
    }
    const v = u.searchParams.get('v');
    if (v && /^\d+$/.test(v)) return v;
  } catch {
    // malformed URL — fall through to null
  }
  return null; // share links (facebook.com/share/r/...) have no embedded ID
}

// facebook.com/share/r/... links are opaque tokens with no video ID in the
// URL itself. Resolve by following the redirect and reading the canonical
// og:url Meta renders into the logged-out HTML. Successful resolutions are
// cached permanently (the mapping never changes) in fb-share-link-map.json.
// `sharedMap` lets callers resolve many URLs in parallel against one in-memory
// map and persist it once at the end — resolving independently (each call doing
// its own load+save) races on the cache file and silently drops all but the
// last writer's entry.
async function resolveFbVideoId(url, sharedMap) {
  const direct = extractFbVideoId(url);
  if (direct) return direct;

  const map = sharedMap || loadShareMap();
  if (map[url]) return map[url];

  try {
    const res = await fetchWithTimeout(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ThumbnailFetchBot/1.0)' },
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    const ogUrl = $('meta[property="og:url"]').attr('content') || '';
    const id = extractFbVideoId(ogUrl) || extractFbVideoId(res.url || '');
    if (id) {
      map[url] = id;
      if (!sharedMap) saveShareMap(map);
      return id;
    }
  } catch {
    // swallow — caller falls back to a null match
  }
  return null;
}

async function fetchAllInstagramMedia() {
  const igId = process.env.IG_BUSINESS_ACCOUNT_ID;
  const token = process.env.IG_ACCESS_TOKEN;
  if (!igId || !token) {
    throw new Error(
      'IG_BUSINESS_ACCOUNT_ID / IG_ACCESS_TOKEN not set — required to read view counts ' +
      'for your own Instagram content. See README.md.'
    );
  }
  let items = [];
  let url = `https://graph.facebook.com/${GRAPH_VERSION}/${igId}/media` +
    `?fields=id,permalink,media_type,media_product_type,thumbnail_url,media_url,caption,timestamp` +
    `&limit=50&access_token=${encodeURIComponent(token)}`;
  while (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`IG media list ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    items = items.concat(data.data || []);
    url = (data.paging && data.paging.next) || null;
  }
  return items;
}

// "views" is the current unified Insights metric for reels/videos; "plays"
// is the older name it replaced. Try both since app/API versions differ.
async function fetchInstagramViewCount(mediaId, token) {
  for (const metric of ['views', 'plays']) {
    const api = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}/insights` +
      `?metric=${metric}&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(api);
    if (!res.ok) continue;
    const data = await res.json();
    const val = data.data?.[0]?.values?.[0]?.value;
    if (typeof val === 'number') return val;
  }
  return null;
}

// Runs `fn` over `items` with at most `limit` in flight at once — a plain
// sequential loop here means one insights call at a time, and an account with
// hundreds of posts turns a cold cache rebuild into several minutes.
async function mapWithConcurrency(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function getInstagramViewsByShortcode() {
  const cache = loadViewsCache();
  if (cache.instagram && Date.now() - cache.instagram.fetched_at < VIEWS_CACHE_TTL_MS) {
    return cache.instagram.data;
  }
  const token = process.env.IG_ACCESS_TOKEN;
  const media = await fetchAllInstagramMedia();
  const result = {};
  await mapWithConcurrency(media, 10, async (item) => {
    const shortcode = extractIgShortcode(item.permalink || '');
    if (!shortcode) return;
    const isVideo = item.media_type === 'VIDEO' || item.media_product_type === 'REELS';
    result[shortcode] = {
      view_count: isVideo ? await fetchInstagramViewCount(item.id, token) : null,
      thumbnail_url: item.thumbnail_url || item.media_url || null,
      permalink: item.permalink,
      title: item.caption || null,
    };
  });
  cache.instagram = { fetched_at: Date.now(), data: result };
  saveViewsCache(cache);
  return result;
}

async function fetchAllFacebookVideos() {
  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!pageId || !token) {
    throw new Error(
      'FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN not set — required to read view counts ' +
      'for your own Facebook Page videos. See README.md.'
    );
  }
  let items = [];
  // "picture" alone returns a 160x160 square-cropped thumbnail — wrong aspect
  // ratio for a portrait reel cover. The thumbnails edge returns the same
  // source image at full resolution (1080x1920) with is_preferred flagged.
  // Capped at limit(5) — the uncapped edge returns every auto-generated frame
  // and roughly triples the per-page response time across a large video list.
  let url = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/videos` +
    `?fields=id,title,permalink_url,views,created_time,thumbnails.limit(5){uri,width,height,is_preferred}` +
    `&limit=50&access_token=${encodeURIComponent(token)}`;
  while (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`FB videos list ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    items = items.concat(data.data || []);
    url = (data.paging && data.paging.next) || null;
  }
  return items;
}

function bestFacebookThumbnail(v) {
  const thumbs = (v.thumbnails && v.thumbnails.data) || [];
  if (!thumbs.length) return v.picture || null;
  const preferred = thumbs.find((t) => t.is_preferred);
  if (preferred) return preferred.uri;
  // Fall back to the largest by area if nothing is explicitly preferred.
  return thumbs.reduce((best, t) => (!best || t.width * t.height > best.width * best.height ? t : best), null).uri;
}

async function getFacebookViewsByVideoId() {
  const cache = loadViewsCache();
  if (cache.facebook && Date.now() - cache.facebook.fetched_at < VIEWS_CACHE_TTL_MS) {
    return cache.facebook.data;
  }
  const videos = await fetchAllFacebookVideos();
  const result = {};
  for (const v of videos) {
    result[v.id] = {
      view_count: typeof v.views === 'number' ? v.views : null,
      thumbnail_url: bestFacebookThumbnail(v),
      // permalink_url comes back as a relative path (e.g. "/1234/videos/5678") — absolutize it.
      permalink: v.permalink_url ? new URL(v.permalink_url, 'https://www.facebook.com').toString() : null,
      title: v.title || null,
    };
  }
  cache.facebook = { fetched_at: Date.now(), data: result };
  saveViewsCache(cache);
  return result;
}

// `sharedCache` lets callers resolve many URLs in parallel against one
// in-memory cache object and persist it once — resolving independently (each
// call doing its own load+save) races on the cache file and silently drops
// all but the last writer's entry.
async function resolveThumbnail(url, sharedCache) {
  const cache = sharedCache || loadCache();
  const cached = cache[url];
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) {
    return cached.data;
  }

  const platform = detectPlatform(url);
  let data;
  try {
    data = platform === 'article' ? await fetchOgImage(url) : await fetchMetaOEmbed(url, platform);
  } catch (err) {
    data = { url, platform, thumbnail_url: null, title: null, author_name: null, error: err.message };
  }

  cache[url] = { fetched_at: Date.now(), data };
  if (!sharedCache) saveCache(cache);
  return data;
}

// ---------------------------------------------------------------------------
// Newsroom feed (News.dc.html) — aggregates news articles (auto-discovered),
// your own Facebook posts, Instagram posts, and X posts (once configured)
// into one normalized, chronologically-sorted feed. Refreshed on a schedule
// (see the cron job near the bottom) rather than fetched live per visitor.
// ---------------------------------------------------------------------------

// Google News' public RSS search — no API key needed. Returns recent articles
// matching the query; each one is then run through the same og:image scraper
// used for manually-curated article links, so thumbnails work identically.
async function fetchGoogleNewsRss(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ThumbnailFetchBot/1.0)' } });
  if (!res.ok) throw new Error(`Google News RSS ${res.status}`);
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  $('item').each((_, el) => {
    const $el = $(el);
    const title = $el.find('title').first().text();
    const link = $el.find('link').first().text();
    const pubDate = $el.find('pubDate').first().text();
    const source = $el.find('source').first().text();
    if (title && link) items.push({ title, link, pubDate, source });
  });
  return items;
}

async function getNewsArticles(sharedCache) {
  const query = process.env.NEWS_SEARCH_QUERY || 'Sobha Surendran';
  const items = await fetchGoogleNewsRss(query);
  const top = items.slice(0, 20); // RSS can return a lot of near-duplicate wire coverage
  return Promise.all(top.map(async (item) => {
    const resolved = await resolveThumbnail(item.link, sharedCache);
    return {
      platform: 'news',
      title: item.title,
      summary: null,
      url: item.link,
      thumbnail_url: resolved.thumbnail_url,
      source: item.source || 'News',
      published_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
    };
  }));
}

// Recent Page posts (not just videos) — same Page Access Token already used
// for reel view counts, just a different Graph API edge.
async function fetchAllFacebookPosts(limit = 15) {
  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!pageId || !token) return [];
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/posts` +
    `?fields=id,message,created_time,permalink_url,full_picture` +
    `&limit=${limit}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FB posts list ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.data || []).map((p) => ({
    platform: 'facebook',
    title: (p.message || '').split('\n')[0].slice(0, 140) || 'Facebook post',
    summary: p.message || null,
    url: p.permalink_url ? new URL(p.permalink_url, 'https://www.facebook.com').toString() : null,
    thumbnail_url: p.full_picture || null,
    source: 'Facebook',
    published_at: p.created_time || null,
  }));
}

// Recent Instagram posts (photos + reels) for the feed — a small, cheap fetch
// distinct from the account-wide media list used for reel view-count matching.
async function fetchRecentInstagramPosts(limit = 10) {
  const igId = process.env.IG_BUSINESS_ACCOUNT_ID;
  const token = process.env.IG_ACCESS_TOKEN;
  if (!igId || !token) return [];
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${igId}/media` +
    `?fields=id,permalink,caption,thumbnail_url,media_url,timestamp` +
    `&limit=${limit}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`IG posts list ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.data || []).map((m) => ({
    platform: 'instagram',
    title: (m.caption || '').split('\n')[0].slice(0, 140) || 'Instagram post',
    summary: m.caption || null,
    url: m.permalink,
    thumbnail_url: m.thumbnail_url || m.media_url || null,
    source: 'Instagram',
    published_at: m.timestamp || null,
  }));
}

// X (Twitter) API v2 — requires a paid Developer tier (the free tier no
// longer supports reading a user's post history). Inactive (returns empty)
// until X_BEARER_TOKEN / X_USERNAME are set — everything else in the feed
// works fine without it.
async function fetchRecentXPosts(limit = 10) {
  const bearer = process.env.X_BEARER_TOKEN;
  const username = process.env.X_USERNAME;
  if (!bearer || !username) return [];

  const userRes = await fetch(`https://api.twitter.com/2/users/by/username/${encodeURIComponent(username)}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!userRes.ok) throw new Error(`X user lookup ${userRes.status}: ${(await userRes.text()).slice(0, 300)}`);
  const userData = await userRes.json();
  const userId = userData.data && userData.data.id;
  if (!userId) return [];

  const tweetsRes = await fetch(
    `https://api.twitter.com/2/users/${userId}/tweets` +
    `?max_results=${Math.max(5, Math.min(limit, 100))}` +
    `&tweet.fields=created_at,text,attachments&expansions=attachments.media_keys&media.fields=url,preview_image_url` +
    `&exclude=retweets,replies`,
    { headers: { Authorization: `Bearer ${bearer}` } }
  );
  if (!tweetsRes.ok) throw new Error(`X tweets fetch ${tweetsRes.status}: ${(await tweetsRes.text()).slice(0, 300)}`);
  const tweetsData = await tweetsRes.json();
  const mediaByKey = {};
  ((tweetsData.includes && tweetsData.includes.media) || []).forEach((m) => { mediaByKey[m.media_key] = m; });

  return (tweetsData.data || []).map((t) => {
    const mediaKey = t.attachments && t.attachments.media_keys && t.attachments.media_keys[0];
    const media = mediaKey ? mediaByKey[mediaKey] : null;
    return {
      platform: 'x',
      title: (t.text || '').split('\n')[0].slice(0, 140) || 'X post',
      summary: t.text || null,
      url: `https://x.com/${username}/status/${t.id}`,
      thumbnail_url: (media && (media.url || media.preview_image_url)) || null,
      source: 'X (Twitter)',
      published_at: t.created_at || null,
    };
  });
}

async function buildNewsroomFeed() {
  const cache = loadCache(); // shared thumbnail cache, used for article og:image resolution
  // Instagram and X are intentionally not fetched here — Instagram was asked to
  // be excluded from this feed (still used elsewhere, e.g. the reel carousel),
  // and X needs a paid Developer tier that isn't set up yet. fetchRecentXPosts
  // and fetchRecentInstagramPosts are left defined above so either can be
  // re-added with a one-line change once wanted again.
  const [news, fbPosts] = await Promise.all([
    getNewsArticles(cache).catch((err) => { console.error('newsroom: news fetch failed:', err.message); return []; }),
    fetchAllFacebookPosts().catch((err) => { console.error('newsroom: fb posts fetch failed:', err.message); return []; }),
  ]);
  saveCache(cache);
  return [...news, ...fbPosts]
    .filter((item) => item.url)
    .sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));
}

async function getNewsroomFeed(forceRefresh) {
  if (!forceRefresh) {
    const cached = loadNewsroomCache();
    if (cached && Date.now() - cached.fetched_at < NEWSROOM_CACHE_TTL_MS) {
      return cached.data;
    }
  }
  const feed = await buildNewsroomFeed();
  saveNewsroomCache(feed);
  return feed;
}

// ---------------------------------------------------------------------------
// Form submissions -> Google Sheets. Each submission appends one row to a
// tab in a Sheet you own — opens/updates instantly like any live document,
// and can be exported to .xlsx from Sheets any time with one click.
// Requires a Google Cloud service account (see README "Setting up Google
// Sheets") — GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SHEET_ID.
// ---------------------------------------------------------------------------

function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  // Private keys are stored in env vars as a single line with literal "\n"
  // sequences (real newlines don't survive most .env / host dashboard
  // input fields), so they must be un-escaped back into actual newlines.
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) return null;
  const auth = new google.auth.JWT(email, null, key, ['https://www.googleapis.com/auth/spreadsheets']);
  return google.sheets({ version: 'v4', auth });
}

async function appendToSheet(sheetTabName, rowValues) {
  const sheets = getSheetsClient();
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheets || !sheetId) {
    throw new Error(
      'Google Sheets not configured — set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, ' +
      'and GOOGLE_SHEET_ID. See README.md "Setting up Google Sheets".'
    );
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetTabName}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowValues] },
  });
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/thumbnail', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'missing ?url=' });
  const cache = loadCache();
  const result = await resolveThumbnail(url, cache);
  saveCache(cache);
  res.json(result);
});

app.get('/api/thumbnails', async (req, res) => {
  const { urls } = req.query;
  if (!urls) return res.status(400).json({ error: 'missing ?urls=comma,separated,list' });
  const list = urls.split(',').map((u) => u.trim()).filter(Boolean);
  const cache = loadCache();
  const results = await Promise.all(list.map((u) => resolveThumbnail(u, cache)));
  saveCache(cache);
  res.json({ results });
});

// Convenience: warm the cache for every URL already known in the site.
app.post('/api/warm-cache', async (_req, res) => {
  const sources = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sources.json'), 'utf8'));
  const all = [...sources.reels, ...sources.news_articles];
  const cache = loadCache();
  const results = await Promise.all(all.map((u) => resolveThumbnail(u, cache)));
  saveCache(cache);
  res.json({ warmed: results.length, results });
});

// Ranks videos by real view count, pulled from Insights on YOUR OWN connected
// IG Business Account / FB Page — with each item's cover thumbnail attached.
//
// Two modes:
//  - Default (no ?urls=): auto-discovers EVERY video/reel on the connected
//    account/Page directly from the Graph API and ranks all of them. This is
//    what you want for "show my most viewed videos" — no link list needed.
//  - ?urls=a,b,c: restricts to just those specific post URLs (matched against
//    the same account/Page data), for when you only want to rank a known set
//    of links, e.g. the ones already embedded on the site.
app.get('/api/most-viewed', async (req, res) => {
  const platformFilter = (req.query.platform || 'all').toLowerCase();
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;
  const results = [];

  if (platformFilter === 'all' || platformFilter === 'instagram') {
    try {
      const igViews = await getInstagramViewsByShortcode();
      for (const [shortcode, m] of Object.entries(igViews)) {
        results.push({
          url: m.permalink || `https://www.instagram.com/reel/${shortcode}/`,
          platform: 'instagram',
          view_count: m.view_count,
          thumbnail_url: m.thumbnail_url,
          title: m.title,
          permalink: m.permalink,
          note: null,
        });
      }
    } catch (err) {
      results.push({ url: null, platform: 'instagram', view_count: null, thumbnail_url: null, title: null, permalink: null, note: err.message });
    }
  }

  if (platformFilter === 'all' || platformFilter === 'facebook') {
    try {
      const fbViews = await getFacebookViewsByVideoId();
      for (const m of Object.values(fbViews)) {
        results.push({
          url: m.permalink,
          platform: 'facebook',
          view_count: m.view_count,
          thumbnail_url: m.thumbnail_url,
          title: m.title,
          permalink: m.permalink,
          note: null,
        });
      }
    } catch (err) {
      results.push({ url: null, platform: 'facebook', view_count: null, thumbnail_url: null, title: null, permalink: null, note: err.message });
    }
  }

  let filtered = results;
  if (req.query.urls) {
    // Restrict to a specific known set of links, matched by IG shortcode /
    // resolved FB video ID against the account-wide data fetched above.
    const wanted = req.query.urls.split(',').map((u) => u.trim()).filter(Boolean);
    const wantedIgShortcodes = new Set(wanted.map(extractIgShortcode).filter(Boolean));
    const shareMap = loadShareMap();
    const wantedFbIds = new Set((await Promise.all(wanted.map((u) => resolveFbVideoId(u, shareMap)))).filter(Boolean));
    saveShareMap(shareMap);
    filtered = results.filter((r) => {
      if (r.platform === 'instagram') return wantedIgShortcodes.has(extractIgShortcode(r.url || ''));
      if (r.platform === 'facebook') return wantedFbIds.has(extractFbVideoId(r.permalink || '') );
      return false;
    });
  }

  filtered.sort((a, b) => (b.view_count ?? -1) - (a.view_count ?? -1));
  const limited = limit ? filtered.slice(0, limit) : filtered;
  res.json({ count: limited.length, results: limited });
});

// Unified newsroom feed for News.dc.html: news articles + Facebook posts +
// Instagram posts + X posts (once configured), newest first. Served from
// cache — refreshed hourly by the cron job below, not fetched live per visitor.
app.get('/api/newsroom', async (req, res) => {
  try {
    const feed = await getNewsroomFeed(req.query.refresh === 'true');
    const cached = loadNewsroomCache();
    res.json({ count: feed.length, items: feed, updated_at: cached ? cached.fetched_at : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual trigger — useful for an external uptime-ping service to both keep a
// free-tier host awake AND force a refresh outside the hourly schedule.
app.post('/api/newsroom/refresh', async (_req, res) => {
  try {
    const feed = await getNewsroomFeed(true);
    res.json({ refreshed: true, count: feed.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/submit-concern', async (req, res) => {
  const { name, phone, panchayat, assembly, ward, booth, message } = req.body || {};
  if (!name || !phone || !message) return res.status(400).json({ error: 'name, phone, and message are required' });
  try {
    await appendToSheet('Concerns', [
      new Date().toISOString(), name, phone || '', panchayat || '', assembly || '', ward || '', booth || '', message,
    ]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/submit-volunteer', async (req, res) => {
  const { name, phone, email, interest } = req.body || {};
  if (!name || !phone || !email) return res.status(400).json({ error: 'name, phone, and email are required' });
  try {
    await appendToSheet('Volunteers', [new Date().toISOString(), name, phone, email, interest || '']);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Refresh the newsroom feed hourly in the background so pages are always
// served from a warm cache instead of live-fetching on every visitor. Note:
// on a free-tier host that sleeps after inactivity, this only fires while the
// instance is actually awake — pair with an external ping (see README) to
// keep it running continuously.
cron.schedule('0 * * * *', () => {
  getNewsroomFeed(true).catch((err) => console.error('scheduled newsroom refresh failed:', err.message));
});

// Warm the newsroom cache once at startup so the very first request doesn't
// have to wait on a live fetch across four sources.
getNewsroomFeed(true).catch((err) => console.error('initial newsroom warm-up failed:', err.message));

app.listen(PORT, () => {
  console.log(`Thumbnail Fetch API listening on http://localhost:${PORT}`);
  console.log(`Try: curl http://localhost:${PORT}/health`);
});
