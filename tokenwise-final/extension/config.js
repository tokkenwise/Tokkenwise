// TokenWise — Shared Config
// Used by background.js, popup, and content scripts

export const CONFIG = {
  SUPABASE_URL: 'https://txpcmysqyyxtkqvlmhxs.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_T0JGBsYoRrBRM34qor3BZA_0QP8IG2C',
  NETLIFY_BASE: 'https://scintillating-snickerdoodle-c87a1a.netlify.app/.netlify/functions',
  APP_URL: 'https://scintillating-snickerdoodle-c87a1a.netlify.app/frontend/app.html',
  VERSION: '1.0.0',
};

export const MODELS = {
  // Claude
  'claude-3-opus':   { name: 'Claude 3 Opus',     family: 'claude', inputPer1M: 15,    context: 200000 },
  'claude-3-sonnet': { name: 'Claude 3.5 Sonnet',  family: 'claude', inputPer1M: 3,     context: 200000 },
  'claude-3-haiku':  { name: 'Claude 3 Haiku',     family: 'claude', inputPer1M: 0.25,  context: 200000 },
  // GPT
  'gpt-4o':          { name: 'GPT-4o',             family: 'gpt',    inputPer1M: 5,     context: 128000 },
  'gpt-4-turbo':     { name: 'GPT-4 Turbo',        family: 'gpt',    inputPer1M: 10,    context: 128000 },
  'gpt-3.5':         { name: 'GPT-3.5 Turbo',      family: 'gpt',    inputPer1M: 0.5,   context: 16000  },
  // Gemini
  'gemini-1.5-pro':  { name: 'Gemini 1.5 Pro',     family: 'gemini', inputPer1M: 3.5,   context: 1000000 },
  'gemini-flash':    { name: 'Gemini Flash',        family: 'gemini', inputPer1M: 0.35,  context: 1000000 },
};

// Auto-detect which model the user is likely using based on the site
export const SITE_DEFAULT_MODEL = {
  'claude.ai':        'claude-3-sonnet',
  'chat.openai.com':  'gpt-4o',
  'chatgpt.com':      'gpt-4o',
  'gemini.google.com':'gemini-1.5-pro',
};

export const SITE_FAMILY = {
  'claude.ai':        'claude',
  'chat.openai.com':  'gpt',
  'chatgpt.com':      'gpt',
  'gemini.google.com':'gemini',
};
