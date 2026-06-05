// netlify/functions/lemonsqueezy-webhook.js
// Handles LemonSqueezy payment events → updates Supabase user plan
// Set webhook URL in LemonSqueezy Dashboard:
// https://YOUR_SITE.netlify.app/.netlify/functions/lemonsqueezy-webhook

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const LEMON_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;

// Map your LemonSqueezy variant IDs to plans
// Replace these with your actual variant IDs from LemonSqueezy dashboard
const VARIANT_TO_PLAN = {
  'YOUR_PRO_VARIANT_ID':    'pro',
  'YOUR_AGENCY_VARIANT_ID': 'agency',
};

async function updateUserPlan(email, plan, status, subscriptionId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        plan,
        subscription_status: status,
        stripe_subscription_id: subscriptionId, // reusing this field for LS subscription ID
        updated_at: new Date().toISOString()
      })
    }
  );
  return res.ok;
}

// Verify LemonSqueezy webhook signature
async function verifySignature(body, signature) {
  if (!LEMON_SECRET) return true; // skip in dev
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(LEMON_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const sigBytes = Buffer.from(signature, 'hex');
  const bodyBytes = encoder.encode(body);
  return crypto.subtle.verify('HMAC', key, sigBytes, bodyBytes);
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method not allowed' };
  }

  try {
    const signature = event.headers['x-signature'] || '';
    const body = event.body;

    // Verify signature
    const valid = await verifySignature(body, signature);
    if (!valid) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
    }

    const payload = JSON.parse(body);
    const eventName = payload.meta?.event_name;
    const data = payload.data;
    const attrs = data?.attributes;

    console.log('LemonSqueezy event:', eventName);

    switch (eventName) {

      // ── Subscription created or updated ──────────
      case 'subscription_created':
      case 'subscription_updated': {
        const email = attrs?.user_email;
        const variantId = String(attrs?.variant_id);
        const plan = VARIANT_TO_PLAN[variantId] || 'pro';
        const status = attrs?.status; // 'active', 'cancelled', 'expired', 'past_due', 'on_trial'
        const subId = String(data?.id);

        if (email) {
          await updateUserPlan(email, plan, status, subId);
          console.log(`Updated plan: ${email} → ${plan} (${status})`);
        }
        break;
      }

      // ── Subscription cancelled ────────────────────
      case 'subscription_cancelled':
      case 'subscription_expired': {
        const email = attrs?.user_email;
        if (email) {
          await updateUserPlan(email, 'free', 'canceled', null);
          console.log(`Cancelled: ${email}`);
        }
        break;
      }

      // ── Payment successful ────────────────────────
      case 'subscription_payment_success': {
        const email = attrs?.user_email;
        const variantId = String(attrs?.first_subscription_item?.variant_id);
        const plan = VARIANT_TO_PLAN[variantId] || 'pro';
        if (email) {
          await updateUserPlan(email, plan, 'active', null);
          console.log(`Payment success: ${email}`);
        }
        break;
      }

      // ── Payment failed ────────────────────────────
      case 'subscription_payment_failed': {
        const email = attrs?.user_email;
        if (email) {
          await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`,
            {
              method: 'PATCH',
              headers: {
                Authorization: `Bearer ${SUPABASE_KEY}`,
                apikey: SUPABASE_KEY,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ subscription_status: 'past_due' })
            }
          );
          console.log(`Payment failed: ${email}`);
        }
        break;
      }

      // ── Order created (one-time purchase) ─────────
      case 'order_created': {
        const email = attrs?.user_email;
        const variantId = String(attrs?.first_order_item?.variant_id);
        const plan = VARIANT_TO_PLAN[variantId] || 'pro';
        if (email && attrs?.status === 'paid') {
          await updateUserPlan(email, plan, 'active', null);
          console.log(`Order paid: ${email} → ${plan}`);
        }
        break;
      }

      default:
        console.log(`Unhandled event: ${eventName}`);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ received: true })
    };

  } catch (err) {
    console.error('Webhook error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
