// netlify/functions/send-email.js
// Handles: password reset emails, budget alert emails, welcome emails
// Uses Resend.com free tier (100 emails/day free)

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const FROM_EMAIL     = 'TokenWise <hello@tokenwise.app>';
const APP_URL        = process.env.APP_URL || 'https://charming-paprenjak-a981d7.netlify.app';

const ALLOWED_ORIGINS = [
  'https://charming-paprenjak-a981d7.netlify.app',
  'https://tokenwise.app',
];

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
}

async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Email send failed: ${err}`);
  }
  return res.json();
}

exports.handler = async (event) => {
  const origin = event.headers.origin || '';
  const headers = getCorsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: '{}' };

  try {
    const body = JSON.parse(event.body || '{}');
    const { type, email } = body;

    if (!type || !email || typeof email !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing type or email' }) };
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid email' }) };
    }

    switch (type) {

      // ── Password reset ─────────────────────────────
      case 'password_reset': {
        // Use Supabase built-in password reset
        const res = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email,
            redirect_to: `${APP_URL}/frontend/app.html`
          })
        });
        // Always return success to prevent email enumeration
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      }

      // ── Welcome email ──────────────────────────────
      case 'welcome': {
        await sendEmail(
          email,
          'Welcome to TokenWise ⚡',
          `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px">
            <div style="font-size:24px;font-weight:800;margin-bottom:8px">⚡ Welcome to TokenWise</div>
            <p style="color:#666;margin-bottom:24px">You're all set. Here's how to get the most out of TokenWise:</p>
            <div style="background:#f5f5f2;border-radius:12px;padding:20px;margin-bottom:16px">
              <div style="font-weight:700;margin-bottom:6px">1. Install the Chrome Extension</div>
              <p style="color:#666;font-size:14px;margin:0">See token counts inside ChatGPT, Claude, and Gemini as you type.</p>
            </div>
            <div style="background:#f5f5f2;border-radius:12px;padding:20px;margin-bottom:16px">
              <div style="font-weight:700;margin-bottom:6px">2. Use the Prompt Analyzer</div>
              <p style="color:#666;font-size:14px;margin:0">Paste any prompt to instantly see costs across all AI models.</p>
            </div>
            <div style="background:#f5f5f2;border-radius:12px;padding:20px;margin-bottom:24px">
              <div style="font-weight:700;margin-bottom:6px">3. Set a budget alert</div>
              <p style="color:#666;font-size:14px;margin:0">Get notified before you overspend on AI this month.</p>
            </div>
            <a href="${APP_URL}/frontend/app.html" style="display:inline-block;background:#00a572;color:white;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700">Open TokenWise →</a>
            <p style="color:#aaa;font-size:12px;margin-top:32px">You're on the Free plan. <a href="${APP_URL}/frontend/app.html" style="color:#00a572">Upgrade to Pro</a> for unlimited compressions.</p>
          </div>
          `
        );
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      }

      // ── Budget alert email ─────────────────────────
      case 'budget_alert': {
        const { threshold, current_spend } = body;
        await sendEmail(
          email,
          `⚠️ TokenWise Budget Alert — You've reached $${threshold}`,
          `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px">
            <div style="font-size:24px;font-weight:800;margin-bottom:8px">⚠️ Budget Alert</div>
            <p style="color:#666;margin-bottom:24px">Your AI spending has reached your alert threshold.</p>
            <div style="background:#fff3f0;border:1px solid #ffccc7;border-radius:12px;padding:20px;margin-bottom:24px">
              <div style="font-size:13px;color:#888;margin-bottom:4px">CURRENT MONTHLY SPEND</div>
              <div style="font-size:32px;font-weight:800;color:#e05a1a">$${parseFloat(current_spend || 0).toFixed(4)}</div>
              <div style="font-size:13px;color:#888;margin-top:4px">Alert threshold: $${threshold}</div>
            </div>
            <p style="color:#666;margin-bottom:24px">Consider switching to cheaper models like Gemini Flash or Claude Haiku for simple tasks to reduce costs.</p>
            <a href="${APP_URL}/frontend/app.html" style="display:inline-block;background:#00a572;color:white;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700">View Dashboard →</a>
          </div>
          `
        );
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      }

      // ── Team invitation ────────────────────────────
      case 'team_invite': {
        const { inviter_name, team_name, invite_token } = body;
        await sendEmail(
          email,
          `${inviter_name} invited you to join ${team_name} on TokenWise`,
          `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px">
            <div style="font-size:24px;font-weight:800;margin-bottom:8px">⚡ You've been invited</div>
            <p style="color:#666;margin-bottom:24px"><strong>${inviter_name}</strong> has invited you to join the <strong>${team_name}</strong> workspace on TokenWise.</p>
            <p style="color:#666;margin-bottom:24px">TokenWise tracks AI token usage and costs for your team — so you always know where your AI budget is going.</p>
            <a href="${APP_URL}/frontend/app.html?invite=${invite_token}" style="display:inline-block;background:#00a572;color:white;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700">Accept Invitation →</a>
            <p style="color:#aaa;font-size:12px;margin-top:32px">This invitation expires in 7 days.</p>
          </div>
          `
        );
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      }

      default:
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown email type' }) };
    }

  } catch (err) {
    console.error('send-email error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email service unavailable' }) };
  }
};
