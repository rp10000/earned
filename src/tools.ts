import { COST, assertBudget, record } from './budget.ts';
import { draftCriteria } from './criteria.ts';
import { advance, createOrder, loadOrder, orderView } from './orders.ts';
import { qualityIndex } from './quality.ts';
import { publicJwk, verifyReceipt } from './receipts.ts';
import type { Env } from './types.ts';
import { HttpError } from './util.ts';

// One set of tools, two front doors: the MCP server (/mcp) for any AI client and the built-in
// shopping agent (/agent). Neither can move money on its own: create_outcome_order only returns a
// PayPal approval link that a human must open, and nothing is charged until items pass inspection.

export interface ToolCtx { env: Env; origin: string; visitor: string; source: 'agent' | 'mcp' }

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  run: (args: any, ctx: ToolCtx) => Promise<unknown>;
}

const criteriaSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 8,
  items: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'One objectively checkable requirement' },
      category: { type: 'string', enum: ['text', 'count', 'subject', 'color', 'composition', 'style', 'safety', 'other'] },
      required: { type: 'boolean', description: 'true: decides payment. false: style preference, inspected and reported but never billed.' },
    },
    required: ['text'],
  },
};

export const TOOLS: ToolDef[] = [
  {
    name: 'search_quality_index',
    title: 'Search the Quality Index',
    description: 'Ranks the AI studios on the Earned network by how often their work actually passed the buyer\'s signed checklist, measured only from orders settled with PayPal. Call this first to pick a studio.',
    inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'What the buyer wants made, e.g. "birthday card with a name on it"' } } },
    readOnly: true,
    async run(_args, { env }) {
      const idx = await qualityIndex(env);
      return {
        ranked_by: idx.ranked_by,
        studios: idx.studios.map(s => ({
          id: s.id, name: s.name, unit_price_usd: s.unit_price,
          pass_rate: s.pass_rate === null ? null : Math.round(s.pass_rate * 1000) / 10,
          confidence_floor: Math.round(s.confidence_floor * 1000) / 10,
          items_judged: s.items_judged, settled_orders: s.settled_orders,
          weakest_area: s.weakest_area ? `${s.weakest_area.category} (${Math.round(s.weakest_area.fail_rate * 100)}% of those checks failed)` : null,
        })),
        note: 'Pass rates are percentages of delivered images that met every checklist item. All orders on Earned are pay-per-pass.',
      };
    },
  },
  {
    name: 'draft_acceptance_checklist',
    title: 'Draft an acceptance checklist',
    description: 'Turns the buyer\'s request into 3-6 objectively checkable acceptance criteria. The checklist becomes the contract: images are paid for only if they pass every item. Show it to the buyer and let them edit before ordering.',
    inputSchema: { type: 'object', properties: { brief: { type: 'string', description: 'The buyer\'s request in their own words, including any exact text, names, numbers, colours' } }, required: ['brief'] },
    readOnly: true,
    async run(args, { env }) {
      const brief = String(args?.brief || '').trim();
      if (brief.length < 10) throw new HttpError(400, 'brief is too short');
      await assertBudget(env, COST.criteria);
      const out = await draftCriteria(env, brief);
      await record(env, 'criteria', COST.criteria);
      return { brief, ...out };
    },
  },
  {
    name: 'create_outcome_order',
    title: 'Create a pay-per-pass order',
    description: 'Creates an order and a PayPal authorization request for quantity x unit price. Returns approve_url: the human buyer must open it and approve the hold on PayPal. The hold is NOT a charge; after AI inspectors check each image against the checklist, PayPal captures only the passed items and releases the rest. Only call after the buyer confirmed the studio, the checklist and the maximum amount.',
    inputSchema: {
      type: 'object',
      properties: {
        studio_id: { type: 'string', description: 'id from search_quality_index' },
        brief: { type: 'string' },
        criteria: criteriaSchema,
        quantity: { type: 'integer', minimum: 1, maximum: 4, description: 'Number of image variations (default 4)' },
      },
      required: ['studio_id', 'brief', 'criteria'],
    },
    readOnly: false,
    async run(args, { env, origin, visitor, source }) {
      const order = await createOrder(env, { shop_id: args?.studio_id, brief: args?.brief, criteria: args?.criteria, quantity: args?.quantity, source, visitor, origin });
      const v = await orderView(env, order, origin);
      return {
        order_id: v.id,
        approve_url: order.approve_url,
        max_amount_usd: (Number(v.unit_price) * v.quantity).toFixed(2),
        what_happens: `The buyer approves a hold of $${(Number(v.unit_price) * v.quantity).toFixed(2)} on PayPal. ${v.studio.name} makes ${v.quantity} images, two AI inspectors check each one against the signed checklist, and PayPal captures $${v.unit_price} per passed image. The rest is released automatically.`,
        order_url: v.order_url,
        contract_hash: v.contract_hash,
      };
    },
  },
  {
    name: 'get_order_status',
    title: 'Get order status',
    description: 'Returns the order\'s progress and, once settled, every image with its verdict, the reasons for any failure, the money captured and released by PayPal, and the signed receipt URL. Calling it also moves the order forward, so poll every few seconds after the buyer approves.',
    inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
    readOnly: true,
    async run(args, { env, origin }) {
      const id = String(args?.order_id || '');
      await loadOrder(env, id);
      const order = await advance(env, id, 20000);
      const v = await orderView(env, order, origin);
      return {
        order_id: v.id, status: v.status, detail: v.status_detail, studio: v.studio.name,
        money: v.money, paypal: { order_id: v.paypal.order_id, authorization_id: v.paypal.authorization_id, capture_id: v.paypal.capture_id, approve_url: v.paypal.approve_url },
        items: v.items.map(i => ({
          number: i.idx + 1, image: i.image, verdict: i.verdict,
          failed_checks: (i.checks || []).filter((c: any) => !c.pass).map((c: any) => ({ requirement: v.criteria.find(k => k.id === c.id)?.text, why: c.evidence })),
        })),
        order_url: v.order_url, receipt_url: v.receipt_url,
      };
    },
  },
  {
    name: 'verify_receipt',
    title: 'Verify a verdict receipt',
    description: 'Checks the Ed25519 signature on an order\'s verdict receipt against the network\'s public key and returns the signed outcome.',
    inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
    readOnly: true,
    async run(args, { env, origin }) {
      const o = await loadOrder(env, String(args?.order_id || ''));
      if (!o.receipt_json || !o.receipt_sig) return { verified: false, reason: 'Order not settled yet' };
      const ok = await verifyReceipt(publicJwk(env), o.receipt_json, o.receipt_sig);
      return { verified: ok, receipt: JSON.parse(o.receipt_json), signature: o.receipt_sig, public_key: `${origin}/.well-known/earned-receipt-key.json` };
    },
  },
];

export const toolByName = (n: string) => TOOLS.find(t => t.name === n);
