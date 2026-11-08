import type { Env } from './types.ts';

// PayPal REST client (sandbox by default). Money flow used by Earned:
//   1. Orders v2 with intent AUTHORIZE  -> buyer approves on PayPal, funds are held, nothing is charged
//   2. POST /v2/checkout/orders/{id}/authorize -> authorization id
//   3. after the AI verdict: capture only the earned amount with final_capture=true (rest is released)
//      or void the authorization when nothing passed
//   4. refunds for upheld buyer appeals; webhooks confirm every step

const apiBase = (env: Env) => (env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com').replace(/\/$/, '');

let cached: { token: string; exp: number; key: string } | null = null;

export async function accessToken(env: Env): Promise<string> {
  const key = env.PAYPAL_CLIENT_ID;
  if (cached && cached.key === key && cached.exp > Date.now() + 60_000) return cached.token;
  const r = await fetch(apiBase(env) + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json<any>().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new PayPalError(r.status, 'auth', j);
  cached = { token: j.access_token, exp: Date.now() + Number(j.expires_in || 3000) * 1000, key };
  return j.access_token;
}

export class PayPalError extends Error {
  status: number;
  op: string;
  body: any;
  constructor(status: number, op: string, body: any) {
    super(`PayPal ${op} failed (${status}): ${body?.name || ''} ${body?.details?.[0]?.issue || body?.message || ''}`.trim());
    this.status = status; this.op = op; this.body = body;
  }
  get issue(): string { return this.body?.details?.[0]?.issue || this.body?.name || ''; }
}

async function call<T = any>(env: Env, op: string, method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
  const token = await accessToken(env);
  const r = await fetch(apiBase(env) + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (!r.ok) throw new PayPalError(r.status, op, j);
  return j as T;
}

const usd = (cents: number) => ({ currency_code: 'USD', value: (cents / 100).toFixed(2) });

export interface HoldRequest {
  orderId: string;          // our id; also used as invoice id
  contractHash: string;
  shopName: string;
  itemName: string;
  quantity: number;
  unitPriceCents: number;
  returnUrl: string;
  cancelUrl: string;
}

export async function createHold(env: Env, h: HoldRequest): Promise<{ id: string; approveUrl: string }> {
  const total = h.quantity * h.unitPriceCents;
  const order = await call(env, 'create order', 'POST', '/v2/checkout/orders', {
    intent: 'AUTHORIZE',
    purchase_units: [{
      reference_id: h.orderId,
      invoice_id: h.orderId,
      custom_id: `earned:${h.contractHash.slice(0, 64)}`,
      description: `Held, not charged: you pay only for items that pass the signed checklist`.slice(0, 127),
      soft_descriptor: 'EARNED DEMO',
      amount: { ...usd(total), breakdown: { item_total: usd(total) } },
      items: [{
        name: h.itemName.slice(0, 127),
        description: `Pay-per-pass. Contract ${h.contractHash.slice(0, 12)}`,
        quantity: String(h.quantity),
        unit_amount: usd(h.unitPriceCents),
        category: 'DIGITAL_GOODS',
      }],
    }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: `${h.shopName} via Earned`.slice(0, 127),
          locale: 'en-US',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'CONTINUE',
          return_url: h.returnUrl,
          cancel_url: h.cancelUrl,
        },
      },
    },
  }, `${h.orderId}:create`);
  const approve = (order.links || []).find((l: any) => l.rel === 'payer-action' || l.rel === 'approve');
  if (!approve) throw new PayPalError(500, 'create order', { message: 'no approval link' });
  return { id: order.id, approveUrl: approve.href };
}

export async function getOrder(env: Env, paypalOrderId: string): Promise<any> {
  return call(env, 'get order', 'GET', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`);
}

/** Authorizes an approved order. Idempotent: if it was already authorized, returns that authorization. */
export async function authorize(env: Env, paypalOrderId: string, ourId: string): Promise<{ authorizationId: string; amountCents: number; status: string; expiresAt?: string }> {
  let order: any;
  try {
    order = await call(env, 'authorize', 'POST', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/authorize`, {}, `${ourId}:authorize`);
  } catch (e) {
    if (e instanceof PayPalError && (e.issue === 'ORDER_ALREADY_AUTHORIZED' || e.issue === 'ORDER_ALREADY_CAPTURED')) {
      order = await getOrder(env, paypalOrderId);
    } else throw e;
  }
  const auth = order?.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth?.id) throw new PayPalError(500, 'authorize', { message: `order status ${order?.status}` });
  return {
    authorizationId: auth.id,
    amountCents: Math.round(Number(auth.amount?.value || 0) * 100),
    status: auth.status,
    expiresAt: auth.expiration_time,
  };
}

export async function captureEarned(env: Env, authorizationId: string, cents: number, ourId: string, note: string): Promise<{ captureId: string; status: string }> {
  const cap = await call(env, 'capture', 'POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, {
    amount: usd(cents),
    final_capture: true,
    invoice_id: `${ourId}-capture`,
    note_to_payer: note.slice(0, 255),
  }, `${ourId}:capture`);
  return { captureId: cap.id, status: cap.status };
}

export async function voidHold(env: Env, authorizationId: string, ourId: string): Promise<string> {
  const r = await call(env, 'void', 'POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, undefined, `${ourId}:void`);
  return r?.status || 'VOIDED';
}

export async function getAuthorization(env: Env, authorizationId: string): Promise<any> {
  return call(env, 'get authorization', 'GET', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`);
}

export async function refund(env: Env, captureId: string, cents: number, requestId: string, note: string): Promise<{ id: string; status: string }> {
  const r = await call(env, 'refund', 'POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    amount: usd(cents),
    note_to_payer: note.slice(0, 255),
  }, requestId);
  return { id: r.id, status: r.status };
}

/** Verifies a webhook with PayPal's verify-webhook-signature API (no local cert handling needed). */
export async function verifyWebhook(env: Env, req: Request, rawBody: string): Promise<boolean> {
  if (!env.PAYPAL_WEBHOOK_ID) return false;
  const h = (n: string) => req.headers.get(n) || '';
  const r = await call(env, 'verify webhook', 'POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'),
    webhook_id: env.PAYPAL_WEBHOOK_ID,
    webhook_event: JSON.parse(rawBody),
  });
  return r?.verification_status === 'SUCCESS';
}
