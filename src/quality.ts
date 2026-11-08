import { SHOPS } from './shops.ts';
import type { ConsensusCheck, Criterion, CriterionCategory, Env } from './types.ts';
import { money } from './util.ts';

// The Quality Index: pass rates of AI studios measured only from orders that were settled with
// real PayPal money movement (sandbox in this demo). Benchmarks can be gamed and reviews can be
// faked; a capture that the buyer did not appeal is much harder to fake.

/** Wilson score lower bound (95%) so a studio with two lucky orders cannot top the table. */
export function wilsonLower(passes: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = passes / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (c - m) / d);
}

interface Row { shop_id: string; order_id: string; criteria_json: string; verdict: string | null; checks_json: string | null; gen_status: string }

export async function qualityIndex(env: Env) {
  const orders = await env.DB.prepare(`SELECT shop_id, COUNT(*) AS n, SUM(authorized_cents) AS auth, SUM(captured_cents) AS cap, SUM(released_cents) AS rel, SUM(refunded_cents) AS ref
    FROM orders WHERE status IN ('settled','voided') GROUP BY shop_id`).all<{ shop_id: string; n: number; auth: number; cap: number; rel: number; ref: number }>();
  const items = await env.DB.prepare(`SELECT o.shop_id, o.id AS order_id, o.criteria_json, i.verdict, i.checks_json, i.gen_status
    FROM items i JOIN orders o ON o.id = i.order_id WHERE o.status IN ('settled','voided')`).all<Row>();

  const byShop = new Map<string, { items: number; passes: number; undelivered: number; cats: Map<CriterionCategory, { checked: number; failed: number }> }>();
  for (const r of items.results) {
    const s = byShop.get(r.shop_id) || { items: 0, passes: 0, undelivered: 0, cats: new Map() };
    s.items++;
    if (r.verdict === 'pass') s.passes++;
    if (r.gen_status !== 'done') s.undelivered++;
    const criteria = JSON.parse(r.criteria_json) as Criterion[];
    for (const c of (JSON.parse(r.checks_json || '[]') as ConsensusCheck[])) {
      const crit = criteria.find(x => x.id === c.id);
      if (crit && crit.required === false) continue; // preferences are reported, not scored
      const cat = crit?.category || 'other';
      const e = s.cats.get(cat) || { checked: 0, failed: 0 };
      e.checked++; if (!c.pass) e.failed++;
      s.cats.set(cat, e);
    }
    byShop.set(r.shop_id, s);
  }

  const rows = SHOPS.map(shop => {
    const o = orders.results.find(x => x.shop_id === shop.id);
    const s = byShop.get(shop.id);
    const passRate = s && s.items ? s.passes / s.items : null;
    const weakest = s ? [...s.cats.entries()].filter(([, v]) => v.checked >= 3)
      .map(([k, v]) => ({ category: k, fail_rate: v.failed / v.checked, checked: v.checked }))
      .sort((a, b) => b.fail_rate - a.fail_rate)[0] : undefined;
    return {
      id: shop.id,
      name: shop.name,
      tagline: shop.tagline,
      accent: shop.accent,
      unit_price: money(shop.unitPriceCents),
      settled_orders: o?.n ?? 0,
      items_judged: s?.items ?? 0,
      items_passed: s?.passes ?? 0,
      pass_rate: passRate,
      confidence_floor: s ? wilsonLower(s.passes, s.items) : 0,
      money: {
        authorized: money(o?.auth ?? 0),
        captured: money(o?.cap ?? 0),
        released: money(o?.rel ?? 0),
        refunded: money(o?.ref ?? 0),
      },
      earned_rate: o && o.auth ? (o.cap - o.ref) / o.auth : null,
      weakest_area: weakest && weakest.fail_rate > 0 ? weakest : null,
      by_category: s ? Object.fromEntries([...s.cats.entries()].map(([k, v]) => [k, { checked: v.checked, failed: v.failed }])) : {},
    };
  }).sort((a, b) => b.confidence_floor - a.confidence_floor || (b.pass_rate ?? 0) - (a.pass_rate ?? 0));

  const totals = rows.reduce((t, r) => ({
    orders: t.orders + r.settled_orders,
    items: t.items + r.items_judged,
    passes: t.passes + r.items_passed,
    authorized: t.authorized + Number(r.money.authorized),
    captured: t.captured + Number(r.money.captured),
    released: t.released + Number(r.money.released),
  }), { orders: 0, items: 0, passes: 0, authorized: 0, captured: 0, released: 0 });

  return {
    ranked_by: 'Lower bound of the 95% confidence interval of the item pass rate, from settled PayPal orders only',
    studios: rows,
    totals: { ...totals, authorized: totals.authorized.toFixed(2), captured: totals.captured.toFixed(2), released: totals.released.toFixed(2) },
    generated_at: new Date().toISOString(),
  };
}

export async function recentReceipts(env: Env, limit = 12) {
  const r = await env.DB.prepare(`SELECT id, shop_id, brief, quantity, captured_cents, released_cents, authorized_cents, settled_at,
      (SELECT COUNT(*) FROM items i WHERE i.order_id = o.id AND i.verdict = 'pass') AS passed
    FROM orders o WHERE status IN ('settled','voided') AND receipt_sig IS NOT NULL ORDER BY settled_at DESC LIMIT ?`).bind(limit).all<any>();
  return r.results.map(o => ({
    id: o.id,
    studio: SHOPS.find(s => s.id === o.shop_id)?.name,
    brief: String(o.brief).slice(0, 120),
    passed: o.passed,
    quantity: o.quantity,
    captured: money(o.captured_cents),
    released: money(o.released_cents),
    authorized: money(o.authorized_cents),
    settled_at: o.settled_at,
  }));
}
