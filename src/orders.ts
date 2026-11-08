import { imageTask, submitImage } from './ai.ts';
import { COST, assertBudget, hit, record } from './budget.ts';
import { TERMS_VERSION, contractHash, normalizeCriteria } from './criteria.ts';
import { JUDGES, TIEBREAKER, judgeImage } from './judge.ts';
import * as paypal from './paypal.ts';
import { keyId, signReceipt } from './receipts.ts';
import { payerNote, settle } from './settle.ts';
import { MAX_QUANTITY, MIN_QUANTITY, shopById } from './shops.ts';
import type { ConsensusCheck, Criterion, Env, ItemRow, OrderRow, OrderStatus } from './types.ts';
import { HttpError, clampText, money, newId, now, today } from './util.ts';

const TERMINAL: OrderStatus[] = ['settled', 'voided', 'failed', 'cancelled'];
const GENERATION_TIMEOUT_S = 8 * 60;

export async function logEvent(env: Env, orderId: string | null, type: string, data: unknown = {}): Promise<void> {
  await env.DB.prepare('INSERT INTO events (order_id, type, data_json, created_at) VALUES (?,?,?,?)')
    .bind(orderId, type, JSON.stringify(data), now()).run();
}

export async function loadOrder(env: Env, id: string): Promise<OrderRow> {
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<OrderRow>();
  if (!o) throw new HttpError(404, 'Order not found', 'not_found');
  return o;
}

async function loadItems(env: Env, id: string): Promise<ItemRow[]> {
  const r = await env.DB.prepare('SELECT * FROM items WHERE order_id = ? ORDER BY idx').bind(id).all<ItemRow>();
  return r.results;
}

async function setStatus(env: Env, id: string, status: OrderStatus, detail: string | null = null, extra: Record<string, unknown> = {}): Promise<void> {
  const cols = Object.keys(extra);
  const sets = ['status = ?', 'status_detail = ?', 'updated_at = ?', ...cols.map(c => `${c} = ?`)].join(', ');
  await env.DB.prepare(`UPDATE orders SET ${sets} WHERE id = ?`)
    .bind(status, detail, now(), ...cols.map(c => extra[c] as any), id).run();
}

export interface CreateOrderInput {
  shop_id: string;
  brief: string;
  criteria: unknown;
  quantity?: number;
  source: 'web' | 'agent' | 'mcp';
  visitor: string;
  origin: string;
}

export async function createOrder(env: Env, input: CreateOrderInput): Promise<OrderRow> {
  const shop = shopById(String(input.shop_id));
  if (!shop) throw new HttpError(400, 'Unknown studio. Use one of the ids from the Quality Index.');
  const brief = clampText(input.brief, 700);
  if (brief.length < 10) throw new HttpError(400, 'Describe what you want in at least a sentence.');
  const criteria = normalizeCriteria(input.criteria);
  const quantity = Math.max(MIN_QUANTITY, Math.min(MAX_QUANTITY, Math.floor(Number(input.quantity) || MAX_QUANTITY)));

  await hit(env, input.visitor, 'orders', Number(env.VISITOR_DAILY_ORDERS || 4));
  const dayCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND status != 'cancelled'")
    .bind(Math.floor(Date.parse(today() + 'T00:00:00Z') / 1000)).first<{ n: number }>();
  if ((dayCount?.n ?? 0) >= Number(env.DAILY_ORDER_CAP || 80)) throw new HttpError(429, 'The demo has reached today\'s order limit. Try again tomorrow.', 'rate_limited');
  await assertBudget(env, quantity * (shop.estCostUsd + COST.judge * JUDGES.length + COST.tiebreak));

  const id = newId('ord');
  const contract = { shop_id: shop.id, brief, criteria, quantity, unit_price_cents: shop.unitPriceCents, currency: 'USD', terms: TERMS_VERSION };
  const hash = await contractHash(contract);
  const t = now();
  await env.DB.prepare(`INSERT INTO orders (id, shop_id, brief, criteria_json, criteria_hash, quantity, unit_price_cents, currency, status, source, visitor, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, shop.id, brief, JSON.stringify(criteria), hash, quantity, shop.unitPriceCents, 'USD', 'awaiting_approval', input.source, input.visitor, t, t).run();

  try {
    const hold = await paypal.createHold(env, {
      orderId: id,
      contractHash: hash,
      shopName: shop.name,
      itemName: `${shop.name}: custom AI card, pay-per-pass`,
      quantity,
      unitPriceCents: shop.unitPriceCents,
      returnUrl: `${input.origin}/paypal/return?order=${id}`,
      cancelUrl: `${input.origin}/paypal/cancel?order=${id}`,
    });
    await env.DB.prepare('UPDATE orders SET paypal_order_id = ?, approve_url = ?, updated_at = ? WHERE id = ?').bind(hold.id, hold.approveUrl, now(), id).run();
    await logEvent(env, id, 'paypal.order.created', { paypal_order_id: hold.id, intent: 'AUTHORIZE', contract_hash: hash });
  } catch (e) {
    await setStatus(env, id, 'failed', 'Could not create the PayPal hold: ' + (e as Error).message);
    throw new HttpError(502, 'PayPal did not accept the hold request. ' + (e as Error).message, 'paypal_error');
  }
  return loadOrder(env, id);
}

/** Called when the buyer returns from PayPal (or when the CHECKOUT.ORDER.APPROVED webhook arrives). */
export async function onApproved(env: Env, order: OrderRow): Promise<OrderRow> {
  if (order.status !== 'awaiting_approval' || !order.paypal_order_id) return order;
  const auth = await paypal.authorize(env, order.paypal_order_id, order.id);
  const res = await env.DB.prepare(`UPDATE orders SET status = 'authorized', status_detail = NULL, paypal_authorization_id = ?, authorized_cents = ?, updated_at = ?
    WHERE id = ? AND status = 'awaiting_approval'`).bind(auth.authorizationId, auth.amountCents, now(), order.id).run();
  if (res.meta.changes) await logEvent(env, order.id, 'paypal.authorized', { authorization_id: auth.authorizationId, amount: money(auth.amountCents), status: auth.status, expires: auth.expiresAt });
  return loadOrder(env, order.id);
}

async function takeLease(env: Env, id: string, seconds: number): Promise<boolean> {
  const t = now();
  const r = await env.DB.prepare('UPDATE orders SET lease_until = ? WHERE id = ? AND lease_until < ?').bind(t + seconds, id, t).run();
  return r.meta.changes === 1;
}

async function releaseLease(env: Env, id: string): Promise<void> {
  await env.DB.prepare('UPDATE orders SET lease_until = 0 WHERE id = ?').bind(id).run();
}

/**
 * Moves an order one or more steps through: authorized -> generating -> judging -> settling -> settled.
 * Any caller can drive it (the order page, an MCP client polling status, the cron trigger); a short
 * lease in D1 keeps two callers from doing the same step.
 */
export async function advance(env: Env, id: string, budgetMs = 25000): Promise<OrderRow> {
  let order = await loadOrder(env, id);
  if ((order.status === 'settled' || order.status === 'voided') && !order.receipt_sig) {
    // Settlement happened but signing failed earlier: sign now so every settled order has a receipt.
    await issueReceipt(env, id).catch(e => logEvent(env, id, 'error', { message: 'receipt: ' + (e as Error).message }));
    return loadOrder(env, id);
  }
  if (TERMINAL.includes(order.status) || order.status === 'awaiting_approval') return order;
  if (!(await takeLease(env, id, Math.ceil(budgetMs / 1000) + 40))) return order;
  const deadline = Date.now() + budgetMs;
  try {
    for (let step = 0; step < 6 && Date.now() < deadline; step++) {
      order = await loadOrder(env, id);
      const before = order.status;
      if (before === 'authorized') await startGeneration(env, order);
      else if (before === 'generating') await pollGeneration(env, order);
      else if (before === 'judging') await judgeItems(env, order);
      else if (before === 'settling') await settleOrder(env, order);
      else break;
      order = await loadOrder(env, id);
      // One transition per call: callers poll, so the UI shows each stage (images, then verdicts,
      // then the PayPal settlement) as soon as it happens. 'authorized' -> 'generating' is instant.
      if (order.status === before || before !== 'authorized') break;
    }
  } catch (e) {
    await logEvent(env, id, 'error', { message: (e as Error).message, status: order.status });
    await env.DB.prepare('UPDATE orders SET status_detail = ?, updated_at = ? WHERE id = ?').bind(clampText((e as Error).message, 300), now(), id).run();
  } finally {
    await releaseLease(env, id);
  }
  return loadOrder(env, id);
}

// Each of the studio's variations tries a different composition, like a designer showing options.
const VARIATIONS = ['a centered composition', 'an off-center composition with generous empty space', 'a close-up composition', 'a wider composition with a simple background'];

function promptFor(order: OrderRow, idx: number): string {
  return `${order.brief}\n\nSquare format, ${VARIATIONS[idx % VARIATIONS.length]}. If the request includes words, render them exactly as written, correctly spelled, with no other text.`;
}

async function startGeneration(env: Env, order: OrderRow): Promise<void> {
  const shop = shopById(order.shop_id)!;
  const existing = await loadItems(env, order.id);
  if (!existing.length) {
    const stmts = Array.from({ length: order.quantity }, (_, idx) =>
      env.DB.prepare('INSERT INTO items (order_id, idx, model) VALUES (?,?,?)').bind(order.id, idx, shop.model));
    await env.DB.batch(stmts);
  }
  const items = await loadItems(env, order.id);
  await Promise.all(items.filter(i => i.gen_status === 'pending').map(async i => {
    try {
      const task = await submitImage(env, shop.model, promptFor(order, i.idx));
      await record(env, 'image:' + shop.model, shop.estCostUsd, order.id);
      await env.DB.prepare("UPDATE items SET task_id = ?, gen_status = 'submitted' WHERE order_id = ? AND idx = ?").bind(task, order.id, i.idx).run();
    } catch (e) {
      await env.DB.prepare("UPDATE items SET gen_status = 'failed', verdict = 'fail', checks_json = ? WHERE order_id = ? AND idx = ?")
        .bind(JSON.stringify(notDelivered(order, (e as Error).message)), order.id, i.idx).run();
    }
  }));
  await setStatus(env, order.id, 'generating', `${shop.name} is making ${order.quantity} images`);
  await logEvent(env, order.id, 'generation.started', { studio: shop.name, quantity: order.quantity });
}

function notDelivered(order: OrderRow, reason: string): ConsensusCheck[] {
  const criteria = JSON.parse(order.criteria_json) as Criterion[];
  return criteria.map(c => ({ id: c.id, pass: false, decided_by: 'consensus', evidence: 'Not delivered: ' + clampText(reason, 160), votes: [] }));
}

async function pollGeneration(env: Env, order: OrderRow): Promise<void> {
  const items = await loadItems(env, order.id);
  const timedOut = now() - order.updated_at > GENERATION_TIMEOUT_S;
  await Promise.all(items.filter(i => i.gen_status === 'submitted').map(async i => {
    const t = await imageTask(env, i.task_id!);
    if (t.state === 'done' && t.url) {
      const img = await fetch(t.url, { signal: AbortSignal.timeout(30000) });
      if (!img.ok) throw new Error('Could not download generated image');
      const type = img.headers.get('content-type') || 'image/png';
      const key = `orders/${order.id}/${i.idx}.${type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : 'png'}`;
      await env.MEDIA.put(key, await img.arrayBuffer(), { httpMetadata: { contentType: type } });
      await env.DB.prepare("UPDATE items SET gen_status = 'done', source_url = ?, media_key = ? WHERE order_id = ? AND idx = ?").bind(t.url, key, order.id, i.idx).run();
    } else if (t.state === 'failed' || timedOut) {
      await env.DB.prepare("UPDATE items SET gen_status = 'failed', verdict = 'fail', checks_json = ? WHERE order_id = ? AND idx = ?")
        .bind(JSON.stringify(notDelivered(order, t.error || 'timed out')), order.id, i.idx).run();
    }
  }));
  const after = await loadItems(env, order.id);
  if (after.every(i => i.gen_status === 'done' || i.gen_status === 'failed')) {
    await setStatus(env, order.id, 'judging', 'Two AI inspectors are checking every image against the signed checklist');
    await logEvent(env, order.id, 'generation.finished', { delivered: after.filter(i => i.gen_status === 'done').length, failed: after.filter(i => i.gen_status === 'failed').length });
  } else {
    await env.DB.prepare('UPDATE orders SET status_detail = ? WHERE id = ?').bind(`${after.filter(i => i.gen_status === 'done').length} of ${after.length} images ready`, order.id).run();
  }
}

async function judgeItems(env: Env, order: OrderRow): Promise<void> {
  const criteria = JSON.parse(order.criteria_json) as Criterion[];
  const items = await loadItems(env, order.id);
  await Promise.all(items.filter(i => i.gen_status === 'done' && !i.verdict).map(async i => {
    const v = await judgeImage(env, i.source_url!, criteria);
    await record(env, 'judge', v.calls.judges * COST.judge + v.calls.tiebreaks * COST.tiebreak, order.id);
    await env.DB.prepare('UPDATE items SET verdict = ?, checks_json = ?, transcript = ?, judged_at = ? WHERE order_id = ? AND idx = ?')
      .bind(v.verdict, JSON.stringify(v.checks), v.transcript, now(), order.id, i.idx).run();
  }));
  const after = await loadItems(env, order.id);
  if (after.every(i => i.verdict)) {
    await setStatus(env, order.id, 'settling', 'Settling with PayPal');
    await logEvent(env, order.id, 'judging.finished', { passed: after.filter(i => i.verdict === 'pass').length, total: after.length });
  }
}

async function settleOrder(env: Env, order: OrderRow): Promise<void> {
  const items = await loadItems(env, order.id);
  const s = settle({ authorizedCents: order.authorized_cents, unitPriceCents: order.unit_price_cents, verdicts: items.map(i => i.verdict) });
  const note = payerNote(s, items.length);
  let captureId: string | null = null, captureStatus: string;
  if (s.action === 'capture') {
    const cap = await paypal.captureEarned(env, order.paypal_authorization_id!, s.captureCents, order.id, note);
    captureId = cap.captureId; captureStatus = cap.status;
    await logEvent(env, order.id, 'paypal.captured', { capture_id: cap.captureId, amount: money(s.captureCents), released: money(s.releaseCents), final_capture: true, status: cap.status });
  } else {
    captureStatus = await paypal.voidHold(env, order.paypal_authorization_id!, order.id);
    await logEvent(env, order.id, 'paypal.voided', { authorization_id: order.paypal_authorization_id, released: money(s.releaseCents) });
  }
  const t = now();
  await setStatus(env, order.id, s.action === 'capture' ? 'settled' : 'voided', note, {
    captured_cents: s.captureCents, released_cents: s.releaseCents,
    paypal_capture_id: captureId, paypal_capture_status: captureStatus, settled_at: t,
  });
  await issueReceipt(env, order.id);
}

export async function issueReceipt(env: Env, id: string): Promise<void> {
  const order = await loadOrder(env, id);
  const items = await loadItems(env, id);
  const shop = shopById(order.shop_id)!;
  const receipt = {
    v: 1,
    receipt_id: order.id,
    issued_at: new Date().toISOString(),
    key_id: await keyId(env),
    merchant: { id: shop.id, name: shop.name },
    contract: {
      hash: order.criteria_hash,
      brief: order.brief,
      criteria: JSON.parse(order.criteria_json),
      quantity: order.quantity,
      unit_price: money(order.unit_price_cents),
      currency: order.currency,
      terms: TERMS_VERSION,
    },
    inspectors: { judges: JUDGES, tiebreaker: TIEBREAKER },
    items: items.map(i => ({
      idx: i.idx,
      delivered: i.gen_status === 'done',
      verdict: i.verdict,
      checks: (JSON.parse(i.checks_json || '[]') as ConsensusCheck[]).map(c => ({ id: c.id, pass: c.pass, decided_by: c.decided_by })),
      appeal: i.appeal_json ? JSON.parse(i.appeal_json) : undefined,
    })),
    money: {
      authorized: money(order.authorized_cents),
      captured: money(order.captured_cents),
      released: money(order.released_cents),
      refunded: money(order.refunded_cents),
      currency: order.currency,
    },
    paypal: {
      environment: (env.PAYPAL_API_BASE || '').includes('sandbox') || !env.PAYPAL_API_BASE ? 'sandbox' : 'live',
      order_id: order.paypal_order_id,
      authorization_id: order.paypal_authorization_id,
      capture_id: order.paypal_capture_id,
      settlement: order.status === 'voided' ? 'void' : 'partial_capture_final',
    },
  };
  const { json, sig } = await signReceipt(env, receipt);
  await env.DB.prepare('UPDATE orders SET receipt_json = ?, receipt_sig = ?, updated_at = ? WHERE id = ?').bind(json, sig, now(), id).run();
  await logEvent(env, id, 'receipt.signed', { key_id: receipt.key_id });
}

export async function cancelOrder(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE orders SET status = 'cancelled', status_detail = 'Buyer left PayPal without approving. Nothing was held.', updated_at = ? WHERE id = ? AND status = 'awaiting_approval'")
    .bind(now(), id).run();
}

/** Public, JSON-safe view of an order used by the web UI, the agent and MCP. */
export async function orderView(env: Env, order: OrderRow, origin: string) {
  const items = await loadItems(env, order.id);
  const shop = shopById(order.shop_id)!;
  const criteria = JSON.parse(order.criteria_json) as Criterion[];
  return {
    id: order.id,
    status: order.status,
    status_detail: order.status_detail,
    studio: { id: shop.id, name: shop.name },
    brief: order.brief,
    criteria,
    contract_hash: order.criteria_hash,
    quantity: order.quantity,
    unit_price: money(order.unit_price_cents),
    money: {
      on_hold: money(order.status === 'settled' || order.status === 'voided' ? 0 : order.authorized_cents),
      authorized: money(order.authorized_cents),
      captured: money(order.captured_cents),
      released: money(order.released_cents),
      refunded: money(order.refunded_cents),
      currency: order.currency,
    },
    paypal: {
      order_id: order.paypal_order_id,
      authorization_id: order.paypal_authorization_id,
      capture_id: order.paypal_capture_id,
      capture_status: order.paypal_capture_status,
      approve_url: order.status === 'awaiting_approval' ? order.approve_url : null,
    },
    items: items.map(i => ({
      idx: i.idx,
      status: i.gen_status,
      image: i.media_key ? `${origin}/media/${i.media_key}` : null,
      verdict: i.verdict,
      transcript: i.transcript,
      checks: i.checks_json ? JSON.parse(i.checks_json) : null,
      appeal: i.appeal_json ? JSON.parse(i.appeal_json) : null,
    })),
    order_url: `${origin}/orders/${order.id}`,
    receipt_url: order.receipt_sig ? `${origin}/receipts/${order.id}` : null,
    created_at: order.created_at,
    settled_at: order.settled_at,
  };
}

export async function orderEvents(env: Env, id: string) {
  const r = await env.DB.prepare('SELECT type, data_json, created_at FROM events WHERE order_id = ? ORDER BY id').bind(id).all<{ type: string; data_json: string; created_at: number }>();
  return r.results.map(e => ({ type: e.type, data: JSON.parse(e.data_json || '{}'), at: e.created_at }));
}

/** Drives every unfinished order a little; runs from the cron trigger. */
export async function sweep(env: Env): Promise<void> {
  const r = await env.DB.prepare(`SELECT id FROM orders WHERE status IN ('authorized','generating','judging','settling') AND lease_until < ? ORDER BY updated_at LIMIT 5`).bind(now()).all<{ id: string }>();
  for (const { id } of r.results) await advance(env, id, 20000);
  // Holds the buyer never approved expire on PayPal's side; mark them so they leave the queue.
  await env.DB.prepare("UPDATE orders SET status = 'cancelled', status_detail = 'PayPal approval was not completed within 3 hours.', updated_at = ? WHERE status = 'awaiting_approval' AND created_at < ?")
    .bind(now(), now() - 3 * 3600).run();
}
