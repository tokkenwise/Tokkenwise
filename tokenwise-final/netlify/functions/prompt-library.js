// netlify/functions/prompt-library.js
// Handles: save prompt, get library, update prompt, delete, get patterns
// Method routing: GET=fetch, POST=save/update, DELETE=remove

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

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
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Content-Type': 'application/json',
  };
}

// Auth helper
async function getUser(token) {
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY }
  });
  const user = await res.json();
  return user?.id ? user : null;
}

// Supabase REST helper
async function sb(path, method = 'GET', body = null, extra = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
      ...extra
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return method === 'DELETE' || (method === 'PATCH' && !extra.return)
    ? { ok: res.ok }
    : res.json();
}

exports.handler = async (event) => {
  const origin = event.headers.origin || '';
  const headers = getCorsHeaders(origin);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const token = (event.headers.authorization || '').replace('Bearer ', '').trim();
    const user = await getUser(token);
    if (!user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

    const method = event.httpMethod;
    const params = event.queryStringParameters || {};
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {}

    // ── GET: fetch library ─────────────────────────────────────
    if (method === 'GET' && params.action === 'library') {
      const category = params.category ? `&category=eq.${params.category}` : '';
      const pinned = params.pinned === 'true' ? '&is_pinned=eq.true' : '';
      const limit = Math.min(parseInt(params.limit) || 50, 200);
      const offset = parseInt(params.offset) || 0;

      const data = await sb(
        `prompt_library?user_id=eq.${user.id}&is_hidden=eq.false${category}${pinned}&order=use_count.desc,last_used_at.desc&limit=${limit}&offset=${offset}&select=id,title,category,intent,domain_tags,use_count,success_rate,best_model,avg_tokens,avg_cost_usd,is_pinned,last_used_at,created_at,original_text,compressed_text,has_code_block,has_bullet_list,char_count`
      );

      // Get pattern clusters
      const patterns = await sb(
        `prompt_patterns?user_id=eq.${user.id}&order=count.desc&limit=10`
      );

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ prompts: data, patterns })
      };
    }

    // ── GET: search ────────────────────────────────────────────
    if (method === 'GET' && params.action === 'search') {
      const q = (params.q || '').replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 100);
      if (!q) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No query' }) };

      const data = await sb(
        `prompt_library?user_id=eq.${user.id}&is_hidden=eq.false&original_text=ilike.*${encodeURIComponent(q)}*&order=use_count.desc&limit=20&select=id,title,category,original_text,compressed_text,use_count,best_model,avg_cost_usd`
      );
      return { statusCode: 200, headers, body: JSON.stringify({ results: data }) };
    }

    // ── GET: stats ─────────────────────────────────────────────
    if (method === 'GET' && params.action === 'stats') {
      const [totals] = await sb(
        `prompt_library?user_id=eq.${user.id}&select=use_count,avg_cost_usd,category,best_model`
      );
      const all = await sb(
        `prompt_library?user_id=eq.${user.id}&select=use_count,avg_cost_usd,category,best_model,success_rate`
      );
      const byCategory = {};
      let totalUses = 0, totalSaved = 0;
      (Array.isArray(all) ? all : []).forEach(p => {
        byCategory[p.category] = (byCategory[p.category]||0) + 1;
        totalUses += p.use_count||0;
        totalSaved += (p.avg_cost_usd||0) * (p.use_count||0);
      });
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ total: Array.isArray(all)?all.length:0, totalUses, byCategory, totalSaved })
      };
    }

    // ── POST: save prompt to library ───────────────────────────
    if (method === 'POST' && params.action === 'save') {
      const { prompt_hash, original_text, compressed_text, structure, model_used, tokens, cost, follow_ups } = body;
      if (!prompt_hash || !original_text) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
      }

      // Sanitize
      const text = original_text.substring(0, 10000);
      const compressed = (compressed_text||'').substring(0, 10000);
      const hash = prompt_hash.substring(0, 64);

      // Classify prompt (rule-based, no API call needed)
      const classification = classifyPrompt(text, structure || {});

      // Check if exists (upsert by hash)
      const existing = await sb(
        `prompt_library?user_id=eq.${user.id}&prompt_hash=eq.${hash}&select=id,use_count,avg_follow_ups,avg_tokens,avg_cost_usd`
      );

      if (Array.isArray(existing) && existing.length > 0) {
        // Update existing — increment use count, recalculate averages
        const ex = existing[0];
        const newCount = (ex.use_count||1) + 1;
        const newAvgFollowUps = ((ex.avg_follow_ups||0) * (newCount-1) + (follow_ups||0)) / newCount;
        const newAvgTokens = Math.round(((ex.avg_tokens||tokens||0) * (newCount-1) + (tokens||0)) / newCount);
        const newAvgCost = (((ex.avg_cost_usd||0) * (newCount-1)) + (cost||0)) / newCount;

        await sb(`prompt_library?id=eq.${ex.id}`, 'PATCH', {
          use_count: newCount,
          last_used_at: new Date().toISOString(),
          avg_follow_ups: parseFloat(newAvgFollowUps.toFixed(3)),
          avg_tokens: newAvgTokens,
          avg_cost_usd: parseFloat(newAvgCost.toFixed(8)),
          best_model: model_used || undefined,
          compressed_text: compressed || undefined,
        });

        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, action: 'updated', id: ex.id }) };
      }

      // Insert new
      const newPrompt = {
        user_id: user.id,
        prompt_hash: hash,
        original_text: text,
        compressed_text: compressed || null,
        title: generateTitle(text),
        category: classification.category,
        domain_tags: classification.tags,
        intent: classification.intent,
        best_model: model_used || null,
        avg_tokens: tokens || null,
        avg_cost_usd: cost || null,
        char_count: text.length,
        word_count: text.split(/\s+/).filter(Boolean).length,
        sentence_count: text.split(/[.!?]+/).filter(Boolean).length,
        has_code_block: /```|`[^`]+`/.test(text),
        has_bullet_list: /^[-*•]/m.test(text),
        has_numbered_list: /^\d+\./m.test(text),
        question_count: (text.match(/\?/g)||[]).length,
        starts_with_verb: /^(write|create|explain|analyze|analyse|help|build|make|fix|debug|convert|translate|summarize|generate|list|find|compare|review|improve|optimize)/i.test(text.trim()),
        has_examples: /for example|e\.g\.|such as|like:|e\.g:/i.test(text),
        has_constraints: /must|should|don't|do not|avoid|never|always|only|limit|maximum|minimum/i.test(text),
        structure_hash: computeStructureHash(text),
        ...sanitizeStructure(structure),
      };

      const [saved] = await sb('prompt_library', 'POST', newPrompt);
      await updatePatterns(user.id, newPrompt);

      return { statusCode: 201, headers, body: JSON.stringify({ ok: true, action: 'created', id: saved?.id }) };
    }

    // ── PATCH: update (pin, hide, notes, title) ────────────────
    if (method === 'PATCH') {
      const { id, is_pinned, is_hidden, user_notes, title } = body;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };

      // Verify ownership
      const [existing] = await sb(`prompt_library?id=eq.${id}&user_id=eq.${user.id}&select=id`);
      if (!existing) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };

      const updates = {};
      if (is_pinned !== undefined) updates.is_pinned = Boolean(is_pinned);
      if (is_hidden !== undefined) updates.is_hidden = Boolean(is_hidden);
      if (user_notes !== undefined) updates.user_notes = String(user_notes).substring(0, 500);
      if (title !== undefined) updates.title = String(title).substring(0, 100);

      await sb(`prompt_library?id=eq.${id}`, 'PATCH', updates);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ── DELETE ─────────────────────────────────────────────────
    if (method === 'DELETE') {
      const id = params.id;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
      await sb(`prompt_library?id=eq.${id}&user_id=eq.${user.id}`, 'DELETE');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };

  } catch (err) {
    console.error('[prompt-library]', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Service unavailable' }) };
  }
};

// ── CLASSIFICATION ─────────────────────────────────────────────────────────
function classifyPrompt(text, structure) {
  const t = text.toLowerCase();
  let category = 'general', intent = 'instruct', tags = [];

  // Category detection
  if (/```|function |const |let |var |def |class |import |export |async |await |\bsql\b|\bapi\b/.test(text)) {
    category = 'code';
    if (/debug|error|fix|broken|doesn't work|not working/.test(t)) intent = 'fix';
    else if (/explain|what does|how does/.test(t)) intent = 'question';
    else intent = 'generate';
  } else if (/write|draft|essay|article|blog|email|letter|paragraph|story/.test(t)) {
    category = 'writing';
    intent = 'generate';
  } else if (/analyze|analyse|summarize|summarise|compare|evaluate|review|assess/.test(t)) {
    category = 'analysis';
    intent = 'summarize';
  } else if (/translate|in spanish|in french|in german|in chinese|in japanese/.test(t)) {
    category = 'translate';
    intent = 'translate';
  } else if (/data|csv|table|spreadsheet|chart|graph|statistics|dataset/.test(t)) {
    category = 'data';
    intent = 'analyze';
  } else if (/\?$|\?.*\?/.test(t) || t.startsWith('what') || t.startsWith('how') || t.startsWith('why') || t.startsWith('when') || t.startsWith('who')) {
    category = 'qa';
    intent = 'question';
  } else if (/imagine|creative|story|poem|fiction|character/.test(t)) {
    category = 'creative';
    intent = 'generate';
  }

  // Tag extraction (domain keywords)
  const domainMap = {
    javascript: /javascript|js|node|react|vue|angular|typescript/,
    python: /python|django|flask|pandas|numpy|pytorch/,
    sql: /sql|database|query|postgres|mysql|supabase/,
    marketing: /marketing|seo|ad copy|campaign|email marketing|social media/,
    legal: /legal|contract|law|terms|privacy|gdpr|compliance/,
    finance: /financial|budget|invoice|accounting|revenue|profit/,
    design: /design|ui|ux|figma|css|layout|typography/,
    ai: /prompt|llm|gpt|claude|gemini|ai model|fine-tune|training/,
  };
  for (const [tag, regex] of Object.entries(domainMap)) {
    if (regex.test(t)) tags.push(tag);
  }

  return { category, intent, tags: tags.slice(0, 5) };
}

function generateTitle(text) {
  // Take first meaningful sentence, cap at 60 chars
  const first = text.split(/[.!?\n]/)[0].trim();
  if (first.length <= 60) return first;
  const words = first.split(' ');
  let title = '';
  for (const w of words) {
    if ((title + ' ' + w).length > 57) break;
    title += (title ? ' ' : '') + w;
  }
  return title + '…';
}

// Simple structure fingerprint — groups prompts with same shape
function computeStructureHash(text) {
  const features = [
    text.length > 500 ? 'long' : text.length > 100 ? 'medium' : 'short',
    /```/.test(text) ? 'code' : 'prose',
    /^[-*]/m.test(text) ? 'bullets' : 'nobullets',
    /\?/.test(text) ? 'question' : 'statement',
    (text.match(/\n/g)||[]).length > 5 ? 'multiline' : 'inline',
  ];
  return features.join('_');
}

function sanitizeStructure(s) {
  if (!s || typeof s !== 'object') return {};
  return {
    formality_score: typeof s.formality_score === 'number' ? Math.min(1, Math.max(0, s.formality_score)) : null,
  };
}

// Update pattern clusters when a new prompt is saved
async function updatePatterns(userId, prompt) {
  const existing = await fetch(
    `${SUPABASE_URL}/rest/v1/prompt_patterns?user_id=eq.${userId}&category=eq.${prompt.category}&select=id,count,prompt_ids`,
    { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } }
  ).then(r => r.json());

  const patternName = `${capitalize(prompt.category)} prompts`;

  if (Array.isArray(existing) && existing.length > 0) {
    const p = existing[0];
    await fetch(`${SUPABASE_URL}/rest/v1/prompt_patterns?id=eq.${p.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: (p.count||0)+1, updated_at: new Date().toISOString(), sample_title: prompt.title })
    });
  } else {
    await fetch(`${SUPABASE_URL}/rest/v1/prompt_patterns`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ user_id: userId, pattern_name: patternName, category: prompt.category, count: 1, sample_title: prompt.title })
    });
  }
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
