// Registers https://<your-worker>/webhooks/paypal on your PayPal sandbox app and prints the webhook id.
// Usage: PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/register-webhook.mjs https://earned.example.workers.dev
// Then: npx wrangler secret put PAYPAL_WEBHOOK_ID   (paste the printed id)

const base = 'https://api-m.sandbox.paypal.com';
const origin = (process.argv[2] || '').replace(/\/$/, '');
if (!/^https:\/\//.test(origin)) throw new Error('Pass the public https origin of your deployment');
const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) throw new Error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET');

const tok = await (await fetch(base + '/v1/oauth2/token', {
  method: 'POST',
  headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
})).json();
const h = { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' };
const url = origin + '/webhooks/paypal';

const list = await (await fetch(base + '/v1/notifications/webhooks', { headers: h })).json();
const existing = (list.webhooks || []).find(w => w.url === url);
if (existing) { console.log(existing.id); process.exit(0); }

const events = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.AUTHORIZATION.CREATED',
  'PAYMENT.AUTHORIZATION.VOIDED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
];
const r = await fetch(base + '/v1/notifications/webhooks', { method: 'POST', headers: h, body: JSON.stringify({ url, event_types: events.map(name => ({ name })) }) });
const j = await r.json();
if (!r.ok) { console.error(JSON.stringify(j, null, 2)); process.exit(1); }
console.log(j.id);
