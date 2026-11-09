export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  PAYPAL_WEBHOOK_ID?: string;
  PAYPAL_API_BASE?: string;          // defaults to the sandbox
  AI_API_BASE?: string;
  AI_API_KEY: string;
  RECEIPT_SIGNING_JWK: string;
  IP_HASH_SALT?: string;
  PUBLIC_ORIGIN?: string;            // optional override for links in MCP/agent replies
  SPEND_CAP_USD?: string;            // hard cap for AI spend across the whole demo
  DAILY_ORDER_CAP?: string;
  DAILY_SPEND_CAP_USD?: string;      // daily slice of the AI budget, checked when an order is created
  STUDIO_PAYOUT_EMAILS?: string;     // optional JSON {studio_id: email} for PayPal Payouts receivers
  PAYOUT_ID_PREFIX?: string;         // keeps sender_batch_id unique across environments that share a PayPal app
  VISITOR_DAILY_ORDERS?: string;
  VISITOR_DAILY_CHAT?: string;
}

export type CriterionCategory = 'text' | 'count' | 'subject' | 'color' | 'composition' | 'style' | 'safety' | 'other';

export interface Criterion {
  id: number;
  text: string;
  category: CriterionCategory;
  /** Required items decide payment. Preferences (style, mood) are inspected and reported, never billed. */
  required: boolean;
}

export interface JudgeCheck {
  id: number;
  pass: boolean;
  evidence: string;
}

export interface JudgeOpinion {
  judge: string;          // model id
  transcribed_text: string;
  checks: JudgeCheck[];
  error?: string;
}

export interface ConsensusCheck {
  id: number;
  pass: boolean;
  decided_by: 'consensus' | 'tiebreak' | 'split';
  evidence: string;
  votes: { judge: string; pass: boolean; evidence: string }[];
}

export interface ItemVerdict {
  verdict: 'pass' | 'fail';
  transcript: string;
  checks: ConsensusCheck[];
}

export type OrderStatus =
  | 'awaiting_approval' | 'authorized' | 'generating' | 'judging' | 'settling'
  | 'settled' | 'voided' | 'failed' | 'cancelled';

export interface OrderRow {
  id: string;
  shop_id: string;
  brief: string;
  criteria_json: string;
  criteria_hash: string;
  quantity: number;
  unit_price_cents: number;
  currency: string;
  authorized_cents: number;
  captured_cents: number;
  released_cents: number;
  refunded_cents: number;
  status: OrderStatus;
  status_detail: string | null;
  paypal_order_id: string | null;
  paypal_authorization_id: string | null;
  paypal_capture_id: string | null;
  paypal_capture_status: string | null;
  approve_url: string | null;
  source: string;
  visitor: string | null;
  lease_until: number;
  receipt_json: string | null;
  receipt_sig: string | null;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
  payout_status: string | null;
  payout_cents: number;
  fee_cents: number;
  recovered_cents: number;
  clawback_cents: number;
  payout_batch_id: string | null;
  payout_item_id: string | null;
}

export interface ItemRow {
  order_id: string;
  idx: number;
  model: string;
  task_id: string | null;
  source_url: string | null;
  media_key: string | null;
  gen_status: 'pending' | 'submitted' | 'done' | 'failed';
  verdict: 'pass' | 'fail' | null;
  checks_json: string | null;
  transcript: string | null;
  appeal_json: string | null;
  judged_at: number | null;
}
