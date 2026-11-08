import { runAgent } from './agent.ts';
import { appealItem } from './appeal.ts';
import { COST, assertBudget, capUsd, record, spent, visitorId } from './budget.ts';
import { draftCriteria } from './criteria.ts';
import { handleMcp } from './mcp.ts';
import { advance, cancelOrder, createOrder, loadOrder, logEvent, onApproved, orderEvents, orderView, sweep } from './orders.ts';
import * as paypal from './paypal.ts';
import { qualityIndex, recentReceipts } from './quality.ts';
import { keyId, publicJwk, verifyReceipt } from './receipts.ts';
import { SHOPS } from './shops.ts';
import type { Env, OrderRow } from './types.ts';
import { HttpError, json, now, originOf } from './util.ts';

const PAGE_ROUTES: [RegExp, string][] = [
  [/^\/orders\/ord_[a-z0-9]+\/?$/, '/order.html'],
  [/^\/receipts\/ord_[a-z0-9]+\/?$/, '/receipt.html'],
];

async function body(req: Request): Promise<any> {
  try { return await req.json(); } catch { throw new HttpError(400, 'Expected a JSON body'); }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const origin = originOf(req, env);
    try {
      for (const [re, file] of PAGE_ROUTES) {
        if (re.test(path)) return env.ASSETS.fetch(new Request(new URL(file, url.origin), req));
      }

      // --- JSON API -----------------------------------------------------------------------
      if (path === '/api/shops' && req.method === 'GET') {
        return json({ studios: SHOPS.map(s => ({ id: s.id, name: s.name, tagline: s.tagline, unit_price: (s.unitPriceCents / 100).toFixed(2), accent: s.accent })) });
      }
      if (path === '/api/index' && req.method === 'GET') {
        const [index, receipts] = await Promise.all([qualityIndex(env), recentReceipts(env)]);
        return json({ ...index, recent: receipts }, 200, { 'cache-control': 'public, max-age=10' });
      }
      if (path === '/api/criteria' && req.method === 'POST') {
        const b = await body(req);
        const brief = String(b?.brief || '').trim();
        if (brief.length < 10) throw new HttpError(400, 'Describe what you want in at least a sentence.');
        await assertBudget(env, COST.criteria);
        const out = await draftCriteria(env, brief.slice(0, 700));
        await record(env, 'criteria', COST.criteria);
        return json(out);
      }
      if (path === '/api/orders' && req.method === 'POST') {
        const b = await body(req);
        const order = await createOrder(env, { shop_id: b?.studio_id, brief: b?.brief, criteria: b?.criteria, quantity: b?.quantity, source: 'web', visitor: await visitorId(req, env), origin });
        return json({ order: await orderView(env, order, origin), approve_url: order.approve_url }, 201);
      }
      let m = path.match(/^\/api\/orders\/(ord_[a-z0-9]+)$/);
      if (m && req.method === 'GET') {
        let order = await loadOrder(env, m[1]);
        if (url.searchParams.get('advance') !== '0') order = await advance(env, order.id, 20000);
        return json({ order: await orderView(env, order, origin), events: await orderEvents(env, order.id) });
      }
      m = path.match(/^\/api\/orders\/(ord_[a-z0-9]+)\/appeal$/);
      if (m && req.method === 'POST') {
        const b = await body(req);
        const appeal = await appealItem(env, m[1], Number(b?.item), String(b?.reason || ''), await visitorId(req, env));
        const order = await loadOrder(env, m[1]);
        return json({ appeal, order: await orderView(env, order, origin) });
      }
      m = path.match(/^\/api\/receipts\/(ord_[a-z0-9]+)$/);
      if (m && req.method === 'GET') {
        const o = await loadOrder(env, m[1]);
        if (!o.receipt_json || !o.receipt_sig) throw new HttpError(404, 'No receipt yet: the order has not settled.');
        const verified = await verifyReceipt(publicJwk(env), o.receipt_json, o.receipt_sig);
        return json({ receipt: JSON.parse(o.receipt_json), canonical: o.receipt_json, signature: o.receipt_sig, algorithm: 'Ed25519', key_id: await keyId(env), public_key_url: `${origin}/.well-known/earned-receipt-key.json`, verified });
      }
      if (path === '/api/agent' && req.method === 'POST') {
        const b = await body(req);
        const out = await runAgent(b?.history, b?.message, { env, origin, visitor: await visitorId(req, env) });
        return json(out);
      }
      if (path === '/api/status' && req.method === 'GET') {
        const used = await spent(env);
        return json({ ai_budget_usd: capUsd(env), ai_spent_usd: Math.round(used * 100) / 100, paypal: 'sandbox' });
      }
      if (path === '/.well-known/earned-receipt-key.json') {
        return json({ keys: [{ ...publicJwk(env), kid: await keyId(env), alg: 'Ed25519', use: 'sig' }] }, 200, { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' });
      }
      if (path === '/mcp') return handleMcp(req, { env, origin, visitor: await visitorId(req, env) });

      // --- PayPal redirects and webhooks ---------------------------------------------------
      if (path === '/paypal/return') {
        const id = url.searchParams.get('order') || '';
        const token = url.searchParams.get('token') || '';
        const order = await loadOrder(env, id);
        if (!token || token !== order.paypal_order_id) throw new HttpError(400, 'This PayPal approval does not match the order.');
        await onApproved(env, order);
        ctx.waitUntil(advance(env, id, 25000).catch(() => undefined));
        return Response.redirect(`${origin}/orders/${id}?approved=1`, 303);
      }
      if (path === '/paypal/cancel') {
        const id = url.searchParams.get('order') || '';
        await cancelOrder(env, id);
        return Response.redirect(`${origin}/orders/${id}`, 303);
      }
      if (path === '/webhooks/paypal' && req.method === 'POST') {
        const raw = await req.text();
        const verified = await paypal.verifyWebhook(env, req, raw).catch(() => false);
        const event = JSON.parse(raw || '{}');
        if (!verified) {
          await logEvent(env, null, 'webhook.rejected', { type: event?.event_type, id: event?.id });
          return new Response('signature not verified', { status: 400 });
        }
        ctx.waitUntil(handleWebhook(env, event));
        return new Response('ok');
      }

      // --- media --------------------------------------------------------------------------
      if (path.startsWith('/media/orders/') && req.method === 'GET') {
        const obj = await env.MEDIA.get(path.slice('/media/'.length));
        if (!obj) return new Response('Not found', { status: 404 });
        return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType || 'image/png', 'cache-control': 'public, max-age=86400, immutable' } });
      }

      if (path.startsWith('/api/')) throw new HttpError(404, 'No such endpoint');
      return env.ASSETS.fetch(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong: ' + (e as Error).message, code: 'internal' }, 500);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweep(env));
  },
} satisfies ExportedHandler<Env>;

async function handleWebhook(env: Env, event: any): Promise<void> {
  const type = String(event?.event_type || '');
  const res = event?.resource || {};
  const related = res?.supplementary_data?.related_ids || {};
  const paypalOrderId = type.startsWith('CHECKOUT.ORDER') ? res.id : related.order_id;
  const order = paypalOrderId
    ? await env.DB.prepare('SELECT * FROM orders WHERE paypal_order_id = ?').bind(paypalOrderId).first<OrderRow>()
    : null;
  await logEvent(env, order?.id ?? null, 'webhook.' + type.toLowerCase(), { id: event?.id, resource_id: res?.id, status: res?.status, amount: res?.amount?.value });
  if (!order) return;
  if (type === 'CHECKOUT.ORDER.APPROVED' && order.status === 'awaiting_approval') {
    // The buyer approved but never came back to our return URL (closed the tab): continue anyway.
    await onApproved(env, order);
    await advance(env, order.id, 25000);
  }
  if (type === 'PAYMENT.CAPTURE.COMPLETED' || type === 'PAYMENT.CAPTURE.PENDING' || type === 'PAYMENT.CAPTURE.DENIED') {
    await env.DB.prepare('UPDATE orders SET paypal_capture_status = ?, updated_at = ? WHERE id = ?').bind(String(res.status || type.split('.').pop()), now(), order.id).run();
  }
}
