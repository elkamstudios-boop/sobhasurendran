# Handoff: Media Thumbnail Fetch API

## Overview
A small backend service that fetches **real cover thumbnails** for the reel and news
cards on the Sobha Surendran site — Instagram/Facebook reel covers via Meta's oEmbed
API, and news-article images via Open Graph (`og:image`) scraping. Today those cards
use local stock photos as placeholders; this service replaces them with the actual
image each platform/outlet published.

**This is real, runnable Node.js code** — not a mockup. Run it with Claude Code (or
any Node environment) using the steps below.

## About the design files
`Sobha Surendran.dc.html` (and `News.dc.html` / `Article.dc.html`) are **design
references built in HTML** for a design tool — they render live but were not written
against a real framework. Treat them as the visual/behavioral spec. This handoff adds
one real backend piece (the thumbnail API) that the existing frontend can call; you
are not obligated to rebuild the whole frontend in React/etc. unless you choose to.

## Fidelity
High-fidelity. Card layout, sizing, and hover states are final in the HTML files —
only the **image source** for each card changes (from local placeholder to fetched
thumbnail).

---

## Why this needs a backend at all
Instagram and Facebook do not allow other websites to hotlink their CDN image URLs
directly (they're session-signed and expire), and browsers block cross-origin
`fetch()` of the platform pages themselves (CORS). A server-side call is the only way
to legitimately retrieve a thumbnail. News-site images are simpler (`og:image` meta
tag, scrapeable server-side) but still need a server to avoid CORS in the browser.

## What you need before running this
1. **Node.js 18+**.
2. **A Meta developer app** (developers.facebook.com) with:
   - An **App ID** and **App Secret** → used to generate an app access token.
   - Instagram Graph API / oEmbed Read product added to the app.
   - Meta's oEmbed endpoints (`graph.facebook.com/v19.0/instagram_oembed`,
     `.../facebook_oembed`) require this token — there is no keyless public oEmbed
     anymore. **I could not create this app on your behalf** — it requires your Meta
     business verification. Sign up, grab the App ID/Secret, put them in `.env`.
3. No account needed for the news-image scraper (`og:image` is public HTML).

## Run it
```bash
cd design_handoff_thumbnail_api
npm install
cp .env.example .env         # fill in META_APP_ID and META_APP_SECRET
npm start                    # starts on http://localhost:8787
```

## Endpoints

### `GET /api/thumbnail?url=<post-url>`
Detects the platform from the URL and returns a thumbnail.
- Instagram/Facebook → calls Meta oEmbed, returns `thumbnail_url` (+ author, title).
- Any other URL (news article) → fetches the page HTML server-side, extracts
  `og:image` (falls back to `twitter:image`, then first `<img>`).

Response:
```json
{ "url": "https://www.instagram.com/reel/DaDXYe1hWRy/", "platform": "instagram",
  "thumbnail_url": "https://scontent...", "title": "...", "author_name": "..." }
```

### `GET /api/thumbnails?urls=<url1>,<url2>,...`
Batch version — same shape, returns an array in the same order. Use this once at
build/deploy time (or on a cron) for all 12 reel links + all news article links, and
cache the results — see below.

### `GET /health`
Returns `{ ok: true }`.

### `GET /api/most-viewed?platform=instagram|facebook|all&limit=N`
Auto-discovers **every** video/reel on your connected Instagram Business Account
and/or Facebook Page directly from the Graph API — no link list required — ranks
them by **real view count**, and attaches each one's cover thumbnail. Requires
`IG_BUSINESS_ACCOUNT_ID`/`IG_ACCESS_TOKEN` and/or `FB_PAGE_ID`/`FB_PAGE_ACCESS_TOKEN`
in `.env` — see "Setting up Meta credentials" below.

Add `&urls=a,b,c` to restrict the ranking to a specific known set of post URLs
instead of every video (matched against the same account-wide data).

**Important scope limit:** view counts only exist for content posted from *your own*
connected Instagram Business Account / Facebook Page. There is no public Meta API for
view counts (or "trending"/"most viewed") on posts you don't own — oEmbed itself never
returns a view count for anyone.

Response:
```json
{
  "count": 24,
  "results": [
    { "url": "https://www.instagram.com/reel/DaDXYe1hWRy/", "platform": "instagram",
      "view_count": 184320, "thumbnail_url": "https://scontent...",
      "title": "...", "permalink": "...", "note": null },
    { "url": "https://www.facebook.com/SobhaSurendranOfficial/videos/1234567890/",
      "platform": "facebook", "view_count": 52104,
      "thumbnail_url": "https://scontent...", "title": "...", "permalink": "...", "note": null }
  ]
}
```
Results are sorted by `view_count` descending. View-count data is cached for
`VIEWS_CACHE_TTL_HOURS` (default 6h) in `data/views-cache.json`, same pattern as the
thumbnail cache.

## Caching (important — do this, don't call live on every page load)
oEmbed thumbnail URLs are time-limited and rate limits are low. Recommended pattern,
already stubbed in `server.js`:
1. Run `/api/thumbnails` once for all known URLs (see `data/sources.json`).
2. Write the results to `data/thumbnail-cache.json` (the server does this
   automatically, with a 12-hour TTL per entry).
3. Have the frontend read from `/api/thumbnail?url=...` as normal — the server
   serves from cache and only re-fetches when an entry is stale.
4. Re-run on a schedule (hourly/daily cron) to pick up new posts/expired URLs.

## Wiring into the existing frontend
In `Sobha Surendran.dc.html`, `ringData()` and the news `articles()`/`releases()`
methods currently hardcode `img: 'images/g_rally.png'` etc. Replace that pattern with
a fetch to this API in `componentDidMount`, keyed by each item's real `url`:

```js
async componentDidMount() {
  const urls = this.ringData().map(v => v.url);
  const res = await fetch('/api/thumbnails?urls=' + encodeURIComponent(urls.join(',')));
  const { results } = await res.json();
  this.setState({ thumbs: Object.fromEntries(results.map(r => [r.url, r.thumbnail_url])) });
}
```
Then in `renderVals()`, prefer `this.state.thumbs?.[v.url]` over the local `v.img`,
falling back to the local placeholder while loading or if a fetch fails (some
platforms occasionally reject oEmbed for private/rate-limited requests — always keep
the local fallback image so a card never renders broken).

## Files in this handoff
- `server.js` — the Express API (oEmbed + OG-scrape logic, file-based cache).
- `package.json` — dependencies (`express`, `node-fetch`, `cheerio`, `dotenv`).
- `.env.example` — the two secrets you must fill in.
- `data/sources.json` — the exact 12 reel URLs + news article URLs already in the
  site, ready to batch-fetch on first run.
- `data/thumbnail-cache.json` — created automatically after the first run.

## Setting up Meta credentials (do this once)
Needed for `/api/most-viewed`. `META_APP_ID`/`META_APP_SECRET` alone (already covered
above) are enough for plain thumbnail fetching, but view counts require your app to be
authorized against your own IG Business Account and Facebook Page.

1. **Create the app** (if you haven't): [developers.facebook.com/apps](https://developers.facebook.com/apps)
   → "Create App" → type **Business**. This requires your own Meta/Facebook business
   verification — I can't do this step for you.
2. **Link Instagram to a Facebook Page**: in the Instagram app, Settings → Account
   type → switch to Professional (Business or Creator), then connect it to a Facebook
   Page you manage. `/api/most-viewed` only sees content on this linked account.
3. **Add products to the app**: in the App Dashboard, add "Instagram Graph API".
4. **Get a User Access Token with the right permissions**: open the
   [Graph API Explorer](https://developers.facebook.com/tools/explorer/), select your
   app, click "Generate Access Token", and grant these scopes: `pages_show_list`,
   `pages_read_engagement`, `pages_read_user_content`, `read_insights`,
   `instagram_basic`, `instagram_manage_insights`.
5. **Exchange it for a long-lived token** (60 days instead of ~1 hour) — paste into
   the browser or curl, replacing the placeholders:
   ```
   https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id={app-id}&client_secret={app-secret}&fb_exchange_token={short-lived-token-from-step-4}
   ```
6. **Get your Page ID + Page Access Token** (Page tokens inherit the long-lived
   duration from the user token that requested them):
   ```
   https://graph.facebook.com/v19.0/me/accounts?access_token={long-lived-user-token}
   ```
   Find your Page in the returned list → its `id` is `FB_PAGE_ID`, its `access_token`
   is `FB_PAGE_ACCESS_TOKEN`.
7. **Get your Instagram Business Account ID**:
   ```
   https://graph.facebook.com/v19.0/{page-id}?fields=instagram_business_account&access_token={page-access-token}
   ```
   The returned id is `IG_BUSINESS_ACCOUNT_ID`. Use the same Page access token from
   step 6 as `IG_ACCESS_TOKEN`.
8. Paste all five values into `.env`.

Page access tokens obtained this way typically last ~60 days; re-run steps 4–6
periodically, or (advanced) create a **System User** in Meta Business Manager to get a
Page token that doesn't expire.

## Setting up Google Sheets (for the Concern / Volunteer forms)
The site's two forms (`/api/submit-concern`, `/api/submit-volunteer`) each append one
row to a tab in a Google Sheet you own — it updates live, and you can export it to
`.xlsx` from Sheets any time (File → Download → Microsoft Excel).

1. **Create the Sheet**: make a new Google Sheet, add two tabs named exactly `Concerns`
   and `Volunteers`. (Optional: add header rows — the API only appends data rows.)
2. **Create a Google Cloud project + service account**:
   [console.cloud.google.com](https://console.cloud.google.com) → create/select a
   project → **APIs & Services → Library** → enable **Google Sheets API** →
   **APIs & Services → Credentials** → **Create Credentials → Service Account** → give
   it any name → **Create and Continue** → skip role assignment → **Done**.
3. **Create a key for it**: open the service account you just made → **Keys** tab →
   **Add Key → Create new key → JSON** → downloads a `.json` file. Keep this private —
   it's a real credential.
4. **Share the Sheet with it**: open the downloaded JSON, copy the `client_email`
   value (looks like `something@your-project.iam.gserviceaccount.com`) → in your
   Google Sheet, click **Share** → paste that email → give it **Editor** access.
5. **Fill in `.env`**:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL` = the `client_email` from the JSON.
   - `GOOGLE_PRIVATE_KEY` = the `private_key` value from the JSON, pasted as-is
     (it contains literal `\n` sequences — leave them, the server un-escapes them).
   - `GOOGLE_SHEET_ID` = the long ID in the Sheet's URL:
     `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.

Until these are set, both form endpoints respond with a clear "Google Sheets not
configured" error instead of silently failing — the rest of the site is unaffected.

## Assets / attribution note
Fetched thumbnails remain the property of the original platform/publisher. Store only
the thumbnail URL (or a cached copy) for display with a link back to the source —
never claim ownership or strip attribution.
