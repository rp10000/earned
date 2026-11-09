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

const events = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.AUTHORIZATION.CREATED',
  'PAYMENT.AUTHORIZATION.VOIDED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTSBATCH.DENIED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED',
];
if (existing) {
  // Already registered: make sure it subscribes to every event Earned handles.
  const u = await fetch(base + '/v1/notifications/webhooks/' + existing.id, { method: 'PATCH', headers: h, body: JSON.stringify([{ op: 'replace', path: '/event_types', value: events.map(name => ({ name })) }]) });
  if (!u.ok) { console.error(JSON.stringify(await u.json(), null, 2)); process.exit(1); }
  console.log(existing.id);
  process.exit(0);
}
const r = await fetch(base + '/v1/notifications/webhooks', { method: 'POST', headers: h, body: JSON.stringify({ url, event_types: events.map(name => ({ name })) }) });
const j = await r.json();
if (!r.ok) { console.error(JSON.stringify(j, null, 2)); process.exit(1); }
console.log(j.id);
