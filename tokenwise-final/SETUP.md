# TokenWise — Complete Setup Guide

## What's in this package

```
tokenwise-final/
├── frontend/
│   ├── app.html                ← Main web app (updated with Library + Context tabs)
│   ├── team-dashboard.html     ← Team dashboard
│   ├── tokenwise-landing.html  ← Landing page
│   ├── privacy.html / terms.html / 404.html
├── netlify/functions/
│   ├── compress.js             ← Prompt compression (unchanged)
│   ├── log-session.js          ← UPDATED: prompt library + follow-up detection
│   ├── send-email.js           ← Email (unchanged)
│   ├── lemonsqueezy-webhook.js ← Payments (unchanged)
│   ├── prompt-library.js       ← NEW: personal prompt library CRUD
│   └── context-portability.js  ← NEW: cross-model context saving/retrieval
├── extension/
│   ├── manifest.json
│   ├── background.js           ← UPDATED: context portability messages
│   ├── content.js              ← UPDATED: smart switch warnings + context injection
│   ├── content.css             ← UPDATED: new widget styles
│   ├── config.js / tokenizer.js / popup.html / popup.js / onboarding.html
│   └── icons/
├── sql/
│   └── master-schema.sql       ← Run this ONCE in Supabase SQL Editor
├── netlify.toml                ← UPDATED: CSP headers + /teams route
└── SETUP.md                    ← This file
```

---

## Step 1 — Run the SQL (3 minutes)

1. Open Supabase → SQL Editor
2. Paste the entire contents of `sql/master-schema.sql`
3. Click Run

---

## Step 2 — Configure your keys (5 minutes)

### In `frontend/app.html` (line ~719):
```js
const SUPABASE_ANON_KEY = 'PASTE_YOUR_REAL_KEY_HERE';
const LEMON_PRO_LINK    = 'https://YOUR_LEMONSQUEEZY_PRO_LINK';
const LEMON_AGENCY_LINK = 'https://YOUR_LEMONSQUEEZY_AGENCY_LINK';
```

### In `extension/config.js`:
```js
SUPABASE_ANON_KEY: 'PASTE_YOUR_REAL_KEY_HERE',
APP_URL: 'https://YOUR_ACTUAL_DOMAIN.netlify.app/frontend/app.html',
NETLIFY_BASE: 'https://YOUR_ACTUAL_DOMAIN.netlify.app/.netlify/functions',
```

### In `netlify.toml` — update the CSP header domain from:
`charming-paprenjak-a981d7.netlify.app` → your actual domain

---

## Step 3 — Netlify environment variables

In Netlify → Site → Environment Variables, ensure these are set:
```
SUPABASE_URL         = https://eojugvrsovcheebdtwfc.supabase.co
SUPABASE_SERVICE_KEY = your_service_key (from Supabase → Settings → API)
ANTHROPIC_API_KEY    = your_anthropic_key (for compression + context summarization)
RESEND_API_KEY       = your_resend_key (for emails)
LEMONSQUEEZY_WEBHOOK_SECRET = your_webhook_secret
APP_URL              = https://your-domain.netlify.app
```

---

## Step 4 — Sentry (optional but recommended)

1. Create free account at sentry.io
2. Create a project → Browser JavaScript
3. Copy your DSN
4. In `frontend/app.html`, find the Sentry script block and replace:
   - The `src` URL with your actual Sentry CDN URL
   - `'YOUR_SENTRY_DSN_HERE'` with your actual DSN

---

## Step 5 — Deploy to Netlify

```bash
git add .
git commit -m "TokenWise v4 - full feature set"
git push
```
Netlify auto-deploys on push.

---

## Step 6 — Install Chrome Extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder

---

## Step 7 — Supabase Auth redirect URL

Supabase → Auth → URL Configuration:
- Site URL: `https://YOUR_DOMAIN.netlify.app`
- Redirect URLs: `https://YOUR_DOMAIN.netlify.app/frontend/app.html`

---

## What's new vs v3

| Feature | Status |
|---------|--------|
| Prompt Library tab in app | ✅ Added |
| Context Portability tab in app | ✅ Added |
| Context Portability Netlify function | ✅ Added |
| Smart switch warnings in extension widget | ✅ Added |
| Context injection button in extension | ✅ Added |
| Auto context save on prompt submit | ✅ Added |
| Prompt instrumentation in log-session | ✅ Added |
| Follow-up detection | ✅ Added |
| Sentry error monitoring hook | ✅ Added (needs DSN) |
| Master SQL schema (single file) | ✅ Added |
| /teams route in netlify.toml | ✅ Added |
| CSP security header | ✅ Added |
