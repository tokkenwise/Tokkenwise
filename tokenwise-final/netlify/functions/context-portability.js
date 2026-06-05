// netlify/functions/context-portability.js
// Handles saving and retrieving cross-model context summaries
// POST ?action=save  — save a context summary after a session ends
// GET  ?action=get   — get the latest active context for a user
// POST ?action=mark  — mark a context as reused

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const ALLOWED_ORIGINS = [
  'https://charming-paprenjak-a981d7.netlify.app',
  'https://tokenwise.app',
  'chrome-extension://',
];

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(o => origin?.startsWith(o));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

async function getUser(token) {
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY }
  });
  const u = await res.json();
  return u?.id ? u : null;
}

async function sb(path, method = 'GET', body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (method === 'PATCH' || method === 'DELETE') return { ok: res.ok };
  return res.json();
}

// Generate a compressed context summary using Claude Haiku
async function generateSummary(conversationText) {
  if (!ANTHROPIC_KEY) return { summary: conversationText.substring(0, 500), tokens: 100 };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Compress this conversation into a 150-200 token context summary for injecting into a new AI session. Capture: key decisions made, entities discussed, questions answered, current state of work. Be dense and specific. No filler.

Conversation:
"""
${conversationText.substring(0, 4000)}
"""

Return ONLY the summary, no preamble:`
      }]
    })
  });

  if (!res.ok) return { summary: conversationText.substring(0, 400), tokens: 80 };
  const data = await res.json();
  const summary = data.content?.map(c => c.text || '').join('') || '';
  return { summary: summary.trim(), tokens: data.usage?.output_tokens || 150 };
}

// Extract topic tags from text
function extractTopics(text) {
  const t = text.toLowerCase();
  const tags = [];
  const topicMap = {
    javascript: /javascript|react|node|typescript|vue|angular/,
    python: /python|django|flask|pandas|numpy/,
    sql: /sql|database|query|postgres|supabase/,
    code: /function|class|import|export|const|let|var|def /,
    writing: /essay|article|blog|email|letter|draft/,
    analysis: /analyze|analyse|compare|evaluate|review/,
    design: /design|ui|ux|layout|color|figma/,
    marketing: /marketing|seo|campaign|copy|ad/,
    legal: /contract|legal|terms|privacy|clause/,
    finance: /budget|revenue|cost|invoice|financial/,
  };
  for (const [tag, regex] of Object.entries(topicMap)) {
    if (regex.test(t)) tags.push(tag);
  }
  return tags.slice(0, 5);
}

exports.handler = async (event) => {
  const origin = event.headers.origin || '';
  const headers = getCorsHeaders(origin);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const token = (event.headers.authorization || '').replace('Bearer ', '').trim();
    const user = await getUser(token);
    if (!user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

    const params = event.queryStringParameters || {};
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {}

    // ── GET: fetch latest active context for user ─────────────
    if (event.httpMethod === 'GET' && params.action === 'get') {
      const site = params.site || '';
      const data = await sb(
        `context_sessions?user_id=eq.${user.id}&expires_at=gt.${new Date().toISOString()}&was_reused=eq.false&order=created_at.desc&limit=1&select=id,site,model_used,context_summary,topic_tags,summary_tokens,created_at`
      );
      const context = Array.isArray(data) && data.length > 0 ? data[0] : null;
      return { statusCode: 200, headers, body: JSON.stringify({ context }) };
    }

    // ── POST: save a new context summary ─────────────────────
    if (event.httpMethod === 'POST' && params.action === 'save') {
      const { conversation_text, site, model_used, token_count } = body;
      if (!conversation_text || !site) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
      }

      const text = String(conversation_text).substring(0, 8000);
      const { summary, tokens: summaryTokens } = await generateSummary(text);
      const topicTags = extractTopics(text);

      const [saved] = await sb('context_sessions', 'POST', {
        user_id: user.id,
        site: String(site).substring(0, 50),
        model_used: String(model_used || 'unknown').substring(0, 50),
        context_summary: summary,
        topic_tags: topicTags,
        token_count: parseInt(token_count) || 0,
        summary_tokens: summaryTokens,
        expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      });

      return {
        statusCode: 201, headers,
        body: JSON.stringify({ ok: true, id: saved?.id, summary_tokens: summaryTokens })
      };
    }

    // ── POST: mark context as reused ─────────────────────────
    if (event.httpMethod === 'POST' && params.action === 'mark') {
      const { id, reused_on_site } = body;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
      await sb(`context_sessions?id=eq.${id}&user_id=eq.${user.id}`, 'PATCH', {
        was_reused: true,
        reused_on_site: String(reused_on_site || '').substring(0, 50)
      });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };

  } catch (err) {
    console.error('[context-portability]', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Service unavailable' }) };
  }
};
