// netlify/functions/compress.js
// Production ready: CORS locked, rate limited, input validated, errors sanitized

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FREE_LIMIT    = 3;

// Allowed origins — locked to your domain only
const ALLOWED_ORIGINS = [
  'https://charming-paprenjak-a981d7.netlify.app',
  'https://tokenwise.app', // add your custom domain when ready
];

function getCorsHeaders(requestOrigin) {
  const origin = ALLOWED_ORIGINS.includes(requestOrigin)
    ? requestOrigin
    : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

// In-memory rate limiter (10 requests/minute per user)
const rateLimitMap = new Map();
function checkRateLimit(userId) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxPerMinute = 10;
  const key = `${userId}_${Math.floor(now / windowMs)}`;
  const count = (rateLimitMap.get(key) || 0) + 1;
  rateLimitMap.set(key, count);
  if (rateLimitMap.size > 500) {
    const oldKey = `${userId}_${Math.floor((now - windowMs * 2) / windowMs)}`;
    rateLimitMap.delete(oldKey);
  }
  return count <= maxPerMinute;
}

// Sanitize text input — strip dangerous characters
function sanitizeInput(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim();
}

// Safe error response — never expose internals
function errorResponse(headers, status, message) {
  return {
    statusCode: status,
    headers,
    body: JSON.stringify({ error: message })
  };
}

exports.handler = async (event) => {
  const requestOrigin = event.headers.origin || event.headers.Origin || '';
  const headers = getCorsHeaders(requestOrigin);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return errorResponse(headers, 405, 'Method not allowed');

  try {
    // 1. Verify auth token
    const token = (event.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token || token.length < 10) return errorResponse(headers, 401, 'Unauthorized');

    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY }
    });

    if (!userRes.ok) return errorResponse(headers, 401, 'Unauthorized');
    const userData = await userRes.json();
    if (!userData?.id) return errorResponse(headers, 401, 'Unauthorized');
    const userId = userData.id;

    // 2. Rate limit
    if (!checkRateLimit(userId)) {
      return errorResponse(headers, 429, 'Too many requests. Please wait a minute.');
    }

    // 3. Get user profile
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=plan,compressions_used,compressions_reset_at,subscription_status,trial_ends_at`,
      { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } }
    );
    if (!profileRes.ok) return errorResponse(headers, 500, 'Service unavailable');
    const [profile] = await profileRes.json();
    if (!profile) return errorResponse(headers, 404, 'Profile not found');

    // 4. Check pro status
    const isPro = ['pro', 'agency'].includes(profile.plan) ||
                  ['trialing', 'active'].includes(profile.subscription_status) ||
                  (profile.trial_ends_at && new Date(profile.trial_ends_at) > new Date());

    // 5. Check and reset monthly limit for free users
    if (!isPro) {
      const resetAt = new Date(profile.compressions_reset_at);
      if (new Date() > resetAt) {
        await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${SUPABASE_KEY}`,
            apikey: SUPABASE_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            compressions_used: 0,
            compressions_reset_at: new Date(
              new Date().getFullYear(),
              new Date().getMonth() + 1, 1
            ).toISOString()
          })
        });
        profile.compressions_used = 0;
      }

      if ((profile.compressions_used || 0) >= FREE_LIMIT) {
        return {
          statusCode: 402,
          headers,
          body: JSON.stringify({
            error: 'limit_reached',
            message: `Free plan allows ${FREE_LIMIT} compressions/month.`,
            used: profile.compressions_used,
            limit: FREE_LIMIT
          })
        };
      }
    }

    // 6. Parse and validate input
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return errorResponse(headers, 400, 'Invalid request body'); }

    const rawText = body.text;
    if (!rawText || typeof rawText !== 'string') {
      return errorResponse(headers, 400, 'Text is required');
    }

    // Sanitize input
    const text = sanitizeInput(rawText);
    if (text.length < 10) return errorResponse(headers, 400, 'Text too short');
    if (text.length > 50000) return errorResponse(headers, 400, 'Text too long (max 50,000 characters)');

    // 7. Call Claude API (key always server-side)
    const claudeRes = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `You are an expert prompt engineer specializing in token efficiency.

Compress this prompt to use fewer tokens while preserving all meaning.

Return ONLY valid JSON, no markdown, no explanation:
{
  "compressed": "compressed version",
  "tips": [{"icon": "emoji", "issue": "what was changed", "saving": "~X tokens"}],
  "original_tokens": number,
  "compressed_tokens": number
}

Rules:
- Remove filler words (please, kindly, could you)
- Remove redundant context
- Shorten verbose phrases  
- Remove intensifiers (very, really, extremely)
- NEVER remove technical requirements or constraints
- NEVER change meaning

Prompt:
"""
${text}
"""`
        }]
      })
    });

    if (!claudeRes.ok) return errorResponse(headers, 502, 'AI service unavailable');

    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.map(c => c.text || '').join('') || '';

    let result;
    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      result = JSON.parse(clean);
    } catch {
      return errorResponse(headers, 500, 'Service error. Please try again.');
    }

    const tokensSaved = (result.original_tokens || 0) - (result.compressed_tokens || 0);
    const pctSaved = result.original_tokens > 0
      ? ((tokensSaved / result.original_tokens) * 100).toFixed(1) : '0';

    // 8. Save compression to database
    await fetch(`${SUPABASE_URL}/rest/v1/compressions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        user_id: userId,
        original_text: text.substring(0, 10000), // cap storage
        compressed_text: (result.compressed || '').substring(0, 10000),
        original_tokens: result.original_tokens,
        compressed_tokens: result.compressed_tokens,
        tokens_saved: tokensSaved,
        pct_saved: pctSaved,
        tips: result.tips
      })
    });

    // 9. Increment free user counter
    if (!isPro) {
      await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${SUPABASE_KEY}`,
          apikey: SUPABASE_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          compressions_used: (profile.compressions_used || 0) + 1
        })
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ...result,
        tokens_saved: tokensSaved,
        pct_saved: pctSaved,
        compressions_remaining: isPro
          ? 'unlimited'
          : FREE_LIMIT - ((profile.compressions_used || 0) + 1)
      })
    };

  } catch (err) {
    // Never expose internal errors to client
    console.error('Compress error:', err.message);
    return errorResponse(headers, 500, 'Service unavailable. Please try again.');
  }
};
