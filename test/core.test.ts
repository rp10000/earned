import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contractHash, normalizeCriteria } from '../src/criteria.ts';
import { itemVerdict, mergeOpinions } from '../src/judge.ts';
import { handleMcp } from '../src/mcp.ts';
import { stripApprovalLinks } from '../src/agent.ts';
import { wilsonLower } from '../src/quality.ts';
import { generateKeyJwk, publicJwk, signReceipt, verifyReceipt } from '../src/receipts.ts';
import { payerNote, payoutAfterClawbacks, settle, studioShare } from '../src/settle.ts';
import { payoutPending } from '../src/orders.ts';
import { payoutEmailFor, shopById } from '../src/shops.ts';
import type { Criterion, Env, JudgeOpinion } from '../src/types.ts';
import { canonicalJson } from '../src/util.ts';

test('settlement captures only passed items and releases the rest', () => {
  const s = settle({ authorizedCents: 600, unitPriceCents: 150, verdicts: ['pass', 'fail', 'pass', 'pass'] });
  assert.deepEqual(s, { passed: 3, failed: 1, captureCents: 450, releaseCents: 150, action: 'capture' });
  assert.match(payerNote(s, 4), /3 of 4 items passed.*\$1\.50 of the hold was released/);
});

test('settlement voids the hold when nothing passed', () => {
  const s = settle({ authorizedCents: 300, unitPriceCents: 150, verdicts: ['fail', 'fail'] });
  assert.equal(s.action, 'void');
  assert.equal(s.captureCents, 0);
  assert.equal(s.releaseCents, 300);
});

test('settlement never captures more than was authorized and refuses to settle early', () => {
  assert.equal(settle({ authorizedCents: 200, unitPriceCents: 150, verdicts: ['pass', 'pass'] }).captureCents, 200);
  assert.throws(() => settle({ authorizedCents: 300, unitPriceCents: 150, verdicts: ['pass', null] }));
});

test('canonical JSON is stable regardless of key order', async () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"x":2,"y":1}]},"b":1}');
  const base = { shop_id: 's', brief: 'b', criteria: [{ id: 1, text: 'x', category: 'text' as const, required: true }], quantity: 2, unit_price_cents: 150, currency: 'USD', terms: 't' };
  assert.equal(await contractHash(base), await contractHash({ ...base }));
  assert.notEqual(await contractHash(base), await contractHash({ ...base, quantity: 3 }));
});

test('criteria are renumbered, trimmed and bounded', () => {
  const c = normalizeCriteria([{ text: '  The text reads "Hi"  ', category: 'TEXT' }, 'abc', { text: 'Exactly two cats', category: 'weird' }]);
  assert.deepEqual(c, [{ id: 1, text: 'The text reads "Hi"', category: 'text', required: true }, { id: 2, text: 'Exactly two cats', category: 'other', required: true }]);
  const s = normalizeCriteria([{ text: 'Watercolour style', category: 'style' }, { text: 'Says "Hi"', category: 'text', required: true }]);
  assert.equal(s[0].required, false);
  assert.throws(() => normalizeCriteria([{ text: 'Watercolour style', category: 'style' }]));
  assert.throws(() => normalizeCriteria([]));
  assert.throws(() => normalizeCriteria(Array.from({ length: 9 }, (_, i) => `criterion number ${i}`)));
});

const criteria: Criterion[] = [{ id: 1, text: 'Text reads "Hi"', category: 'text', required: true }, { id: 2, text: 'Two cats', category: 'count', required: true }];
const op = (judge: string, a: boolean, b: boolean): JudgeOpinion => ({ judge, transcribed_text: 'Hi', checks: [{ id: 1, pass: a, evidence: 'e1' }, { id: 2, pass: b, evidence: 'e2' }] });

test('judges must agree; disagreements go to the tiebreaker', () => {
  const agree = mergeOpinions(criteria, [op('a', true, false), op('b', true, false)]);
  assert.deepEqual(agree.disputed, []);
  assert.deepEqual(agree.checks.map(c => c.pass), [true, false]);
  const split = mergeOpinions(criteria, [op('a', true, true), op('b', true, false)]);
  assert.deepEqual(split.disputed, [2]);
  assert.equal(split.checks[1].pass, false);
});

test('style preferences are reported but never block payment or trigger a tiebreak', () => {
  const withPref: Criterion[] = [...criteria, { id: 3, text: 'Flat illustration style', category: 'style', required: false }];
  const op3 = (judge: string, a: boolean, b: boolean, c: boolean): JudgeOpinion => ({ judge, transcribed_text: '', checks: [{ id: 1, pass: a, evidence: '' }, { id: 2, pass: b, evidence: '' }, { id: 3, pass: c, evidence: 'painterly' }] });
  const r = mergeOpinions(withPref, [op3('a', true, true, true), op3('b', true, true, false)]);
  assert.deepEqual(r.disputed, []);
  assert.equal(r.checks[2].decided_by, 'split');
  assert.equal(itemVerdict(withPref, r.checks), 'pass');
  const r2 = mergeOpinions(withPref, [op3('a', false, true, true), op3('b', false, true, true)]);
  assert.equal(itemVerdict(withPref, r2.checks), 'fail');
});

test('a single working judge is never enough on its own', () => {
  const r = mergeOpinions(criteria, [op('a', true, true), { judge: 'b', transcribed_text: '', checks: [], error: 'timeout' }]);
  assert.deepEqual(r.disputed, [1, 2]);
});

test('Wilson lower bound punishes small samples', () => {
  assert.equal(wilsonLower(0, 0), 0);
  assert.ok(wilsonLower(2, 2) < wilsonLower(90, 100));
  assert.ok(wilsonLower(90, 100) > 0.8 && wilsonLower(90, 100) < 0.9);
});

test('receipts verify with the public key and fail when tampered', async () => {
  const jwk = await generateKeyJwk();
  const env = { RECEIPT_SIGNING_JWK: JSON.stringify(jwk) } as Env;
  const { json, sig } = await signReceipt(env, { receipt_id: 'ord_x', money: { captured: '4.50' } });
  const pub = publicJwk(env);
  assert.equal((pub as any).d, undefined);
  assert.equal(await verifyReceipt(pub, json, sig), true);
  assert.equal(await verifyReceipt(pub, json.replace('4.50', '6.00'), sig), false);
});

test('MCP server negotiates a version and lists the tools', async () => {
  const call = (body: unknown) => handleMcp(new Request('https://x/mcp', { method: 'POST', body: JSON.stringify(body) }), { env: {} as Env, origin: 'https://x', visitor: 'v' });
  const init = await (await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json() as any;
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await (await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json() as any;
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['search_quality_index', 'draft_acceptance_checklist', 'create_outcome_order', 'get_order_status', 'verify_receipt']);
  const create = list.result.tools.find((t: any) => t.name === 'create_outcome_order');
  assert.equal(create.annotations.readOnlyHint, false);
  const unknown = await (await call({ jsonrpc: '2.0', id: 3, method: 'nope' })).json() as any;
  assert.equal(unknown.error.code, -32601);
});

test('agent replies never carry raw PayPal approval links', () => {
  const t = 'Approve below.\n\n[Approve payment on PayPal](https://www.sandbox.paypal.com/checkoutnow?token=ABC)\nThen tell me. https://www.sandbox.paypal.com/checkoutnow?token=XYZ';
  const out = stripApprovalLinks(t);
  assert.ok(!/paypal\.com/.test(out));
  assert.match(out, /Approve below\./);
});

test('studio payout: captured minus refunds, minus a 10% fee', () => {
  assert.deepEqual(studioShare(450, 0), { net: 450, fee: 45, share: 405 });
  assert.deepEqual(studioShare(450, 150), { net: 300, fee: 30, share: 270 });
  assert.deepEqual(studioShare(150, 300), { net: 0, fee: 0, share: 0 });
});

test('studio payout: earlier clawbacks are recovered from the next payout', () => {
  assert.deepEqual(payoutAfterClawbacks(405, 0), { amount: 405, recovered: 0 });
  assert.deepEqual(payoutAfterClawbacks(405, 135), { amount: 270, recovered: 135 });
  assert.deepEqual(payoutAfterClawbacks(135, 270), { amount: 0, recovered: 135 });
});

test('payout is pending until PayPal reports a final item status', () => {
  assert.equal(payoutPending({ status: 'settled', payout_status: null }), true);
  assert.equal(payoutPending({ status: 'settled', payout_status: 'PENDING' }), true);
  assert.equal(payoutPending({ status: 'settled', payout_status: 'UNCLAIMED' }), false);
  assert.equal(payoutPending({ status: 'settled', payout_status: 'none' }), false);
  assert.equal(payoutPending({ status: 'voided', payout_status: null }), false);
});

test('studio payout receivers can be overridden per environment', () => {
  const shop = shopById('kite')!;
  assert.equal(payoutEmailFor({}, shop), shop.payoutEmail);
  assert.equal(payoutEmailFor({ STUDIO_PAYOUT_EMAILS: '{"kite":"kite@business.example.com"}' }, shop), 'kite@business.example.com');
  assert.equal(payoutEmailFor({ STUDIO_PAYOUT_EMAILS: 'not json' }, shop), shop.payoutEmail);
});
