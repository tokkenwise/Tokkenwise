// netlify/functions/log-session.js — v4 (with prompt library + context portability instrumentation)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ALLOWED_ORIGINS = [
  'https://charming-paprenjak-a981d7.netlify.app',
  'https://tokenwise.app',
  'chrome-extension://',
];

function getCorsHeaders(requestOrigin) {
  const allowed = ALLOWED_ORIGINS.some(o => requestOrigin?.startsWith(o));
  return {
    'Access-Control-Allow-Origin': allowed ? requestOrigin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

const rateLimitMap = new Map();
function checkRateLimit(userId) {
  const now = Date.now();
  const key = `${userId}_${Math.floor(now / 60000)}`;
  const count = (rateLimitMap.get(key) || 0) + 1;
  rateLimitMap.set(key, count);
  if (rateLimitMap.size > 1000) rateLimitMap.clear();
  return count <= 60;
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

function normalizeText(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function classifyPromptType(text) {
  const t = (text || '').toLowerCase();
  if (/```|function |const |def |class |import /.test(text)) return 'code';
  if (/write|draft|essay|article|blog|email/.test(t)) return 'writing';
  if (/analyze|analyse|summarize|compare|review/.test(t)) return 'analysis';
  if (/translate/.test(t)) return 'translate';
  if (/data|csv|table|chart/.test(t)) return 'data';
  if (/\?$/.test(t.trim()) || /^(what|how|why|when|who|where)/.test(t)) return 'qa';
  return 'general';
}

// Detect if a prompt is a follow-up (for smart switch warnings)
function isFollowUp(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  const followUpPhrases = /^(also|what about|can you|following up|one more|and |but |however|additionally|furthermore|now |next |then )/;
  const vaguePronouns = /\b(it|that|them|this|those|these|he|she|they)\b/;
  const shortLength = text.length < 120;
  return followUpPhrases.test(t) || (vaguePronouns.test(t) && shortLength);
}

exports.handler = async (event) => {
  const origin = event.headers.origin || '';
  const headers = getCorsHeaders(origin);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: '{}' };

  try {
    const token = (event.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY }
    });
    const user = await userRes.json();
    if (!user?.id) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

    if (!checkRateLimit(user.id)) {
      return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests' }) };
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid body' }) }; }

    const tokens     = Math.max(0, Math.min(2000000, parseInt(body.tokens) || 0));
    const words      = Math.max(0, Math.min(500000,  parseInt(body.words)  || 0));
    const characters = Math.max(0, Math.min(8000000, parseInt(body.characters) || 0));

    const allowedSources = ['chat.openai.com','claude.ai','gemini.google.com','mail.google.com','notion.so','perplexity.ai','tokenwise-app','extension','unknown'];
    const sourceUrl = allowedSources.includes(body.source_url) ? body.source_url : 'unknown';

    const allowedModels = ['claude-3-opus','claude-3-sonnet','claude-3-haiku','gpt-4o','gpt-4-turbo','gpt-3.5','gemini-1.5-pro','gemini-flash','unknown'];
    const modelUsed = allowedModels.includes(body.model_used) ? body.model_used : 'unknown';

    // Prompt instrumentation
    const promptText    = typeof body.prompt_text === 'string' ? body.prompt_text.substring(0, 10000) : null;
    const promptHash    = promptText ? simpleHash(normalizeText(promptText)) : null;
    const promptType    = promptText ? classifyPromptType(promptText) : (body.prompt_type || null);
    const lengthBefore  = parseInt(body.prompt_length_before) || characters || null;
    const lengthAfter   = parseInt(body.prompt_length_after)  || null;
    const compressionRatio = (lengthBefore && lengthAfter)
      ? parseFloat((1 - lengthAfter / lengthBefore).toFixed(3)) : null;
    const followUpDetected = promptText ? isFollowUp(promptText) : false;

    const session = {
      user_id:              user.id,
      tokens, words, characters,
      source_url:           sourceUrl,
      model_used:           modelUsed,
      cost_gpt4o:           parseFloat(((tokens / 1e6) * 5).toFixed(8)),
      cost_claude_opus:     parseFloat(((tokens / 1e6) * 15).toFixed(8)),
      cost_claude_sonnet:   parseFloat(((tokens / 1e6) * 3).toFixed(8)),
      cost_gemini_pro:      parseFloat(((tokens / 1e6) * 3.5).toFixed(8)),
      cost_gemini_flash:    parseFloat(((tokens / 1e6) * 0.35).toFixed(8)),
      prompt_hash:          promptHash,
      prompt_type:          promptType,
      prompt_length_before: lengthBefore,
      prompt_length_after:  lengthAfter,
      compression_ratio:    compressionRatio,
    };

    const res = await fetch(`${SUPABASE_URL}/rest/v1/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(session)
    });

    if (!res.ok) {
      console.error('Session save failed:', await res.text());
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to save' }) };
    }

    // Fire-and-forget: save to prompt library + check budget alerts
    if (promptHash && tokens > 10) {
      saveToPromptLibrary(user.id, { prompt_hash: promptHash, prompt_text: promptText, model_used: modelUsed, tokens, cost: session.cost_claude_sonnet, follow_ups: parseInt(body.follow_up_count) || 0, prompt_type: promptType, compressed_text: typeof body.compressed_text === 'string' ? body.compressed_text.substring(0, 10000) : null })
        .catch(e => console.warn('[library silent]', e.message));
    }
    checkBudgetAlerts(user.id, session).catch(e => console.error('Alert check failed:', e.message));

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, follow_up_detected: followUpDetected }) };

  } catch (err) {
    console.error('log-session error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Service unavailable' }) };
  }
};

async function saveToPromptLibrary(userId, data) {
  try {
    const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=training_consent`, { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } });
    const [profile] = await profileRes.json();
    const hasConsent = profile?.training_consent === true;

    const existing = await fetch(`${SUPABASE_URL}/rest/v1/prompt_library?user_id=eq.${userId}&prompt_hash=eq.${data.prompt_hash}&select=id,use_count,avg_tokens,avg_cost_usd,avg_follow_ups`, { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } }).then(r => r.json());

    if (Array.isArray(existing) && existing.length > 0) {
      const ex = existing[0];
      const newCount = (ex.use_count || 1) + 1;
      await fetch(`${SUPABASE_URL}/rest/v1/prompt_library?id=eq.${ex.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ use_count: newCount, last_used_at: new Date().toISOString(), avg_follow_ups: parseFloat((((ex.avg_follow_ups || 0) * (newCount - 1) + (data.follow_ups || 0)) / newCount).toFixed(3)), avg_tokens: Math.round(((ex.avg_tokens || data.tokens || 0) * (newCount - 1) + (data.tokens || 0)) / newCount), avg_cost_usd: parseFloat((((ex.avg_cost_usd || 0) * (newCount - 1) + (data.cost || 0)) / newCount).toFixed(8)), best_model: data.model_used || undefined })
      });
    } else {
      const title = (hasConsent && data.prompt_text ? data.prompt_text : `${data.prompt_type || 'general'} prompt, ${data.tokens} tokens`).substring(0, 60);
      await fetch(`${SUPABASE_URL}/rest/v1/prompt_library`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ user_id: userId, prompt_hash: data.prompt_hash, original_text: hasConsent && data.prompt_text ? data.prompt_text : `[structure: ${data.prompt_type || 'general'}, ${data.tokens} tokens]`, compressed_text: hasConsent && data.compressed_text ? data.compressed_text : null, title: title + (title.length >= 60 ? '…' : ''), category: data.prompt_type || 'general', best_model: data.model_used || null, avg_tokens: data.tokens || null, avg_cost_usd: data.cost || null, use_count: 1, avg_follow_ups: data.follow_ups || 0, char_count: (data.prompt_text || '').length, word_count: (data.prompt_text || '').split(/\s+/).filter(Boolean).length })
      });
    }
  } catch (e) { console.warn('[saveToLibrary]', e.message); }
}

async function checkBudgetAlerts(userId, session) {
  const alertsRes = await fetch(`${SUPABASE_URL}/rest/v1/budget_alerts?user_id=eq.${userId}&select=*`, { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } });
  const alerts = await alertsRes.json();
  if (!alerts?.length) return;
  const spendRes = await fetch(`${SUPABASE_URL}/rest/v1/monthly_spend?user_id=eq.${userId}&select=*`, { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } });
  const [spend] = await spendRes.json();
  if (!spend) return;
  const totalSpend = parseFloat(spend.total_cost_gpt4o || 0) + parseFloat(spend.total_cost_claude_opus || 0);
  for (const alert of alerts) {
    if (totalSpend >= alert.threshold_usd && !alert.triggered_at) {
      await fetch(`${SUPABASE_URL}/rest/v1/budget_alerts?id=eq.${alert.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ triggered_at: new Date().toISOString() }) });
    }
  }
}
