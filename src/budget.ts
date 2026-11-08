import type { Env } from './types.ts';
import { HttpError, now, sha256Hex, today } from './util.ts';

// The public demo spends real money on AI calls (PayPal is sandbox, the models are not).
// Every call is written to a ledger; once the cap is reached the demo refuses new AI work.

export const COST = {
  judge: 0.004,       // one vision judge call, conservative
  tiebreak: 0.01,
  criteria: 0.003,
  chatTurn: 0.004,
};

export async function spent(env: Env): Promise<number> {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(usd_micros),0) AS m FROM spend').first<{ m: number }>();
  return (r?.m ?? 0) / 1e6;
}

export function capUsd(env: Env): number {
  return Number(env.SPEND_CAP_USD || 15);
}

export async function assertBudget(env: Env, needUsd: number): Promise<void> {
  if ((await spent(env)) + needUsd > capUsd(env)) {
    throw new HttpError(503, 'The public demo has used its AI budget. Recorded receipts and the Quality Index stay available; run it locally with your own key to try more.', 'budget_exhausted');
  }
}

export async function record(env: Env, kind: string, usd: number, orderId?: string): Promise<void> {
  await env.DB.prepare('INSERT INTO spend (day, kind, usd_micros, order_id, created_at) VALUES (?,?,?,?,?)')
    .bind(today(), kind, Math.round(usd * 1e6), orderId ?? null, now()).run();
}

export async function visitorId(req: Request, env: Env): Promise<string> {
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'local';
  return (await sha256Hex((env.IP_HASH_SALT || 'earned') + '|' + ip)).slice(0, 20);
}

/** Increments a per-visitor daily counter and throws once the limit is passed. */
export async function hit(env: Env, visitor: string, kind: string, limit: number): Promise<void> {
  const day = today();
  const r = await env.DB.prepare(
    'INSERT INTO hits (visitor, day, kind, n) VALUES (?,?,?,1) ON CONFLICT(visitor, day, kind) DO UPDATE SET n = n + 1 RETURNING n',
  ).bind(visitor, day, kind).first<{ n: number }>();
  if ((r?.n ?? 0) > limit) {
    throw new HttpError(429, `Daily demo limit reached (${limit} ${kind} per visitor per day). Come back tomorrow or run it locally.`, 'rate_limited');
  }
}
