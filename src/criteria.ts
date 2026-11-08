import { chatJson } from './ai.ts';
import type { Criterion, CriterionCategory, Env } from './types.ts';
import { HttpError, canonicalJson, clampText, sha256Hex } from './util.ts';

export const CRITERIA_MODEL = 'gpt-6-luna';
export const TERMS_VERSION = 'earned-terms-v1';
const CATEGORIES: CriterionCategory[] = ['text', 'count', 'subject', 'color', 'composition', 'style', 'safety', 'other'];

const SYSTEM = `You turn a customer's request for an AI-generated image (a card, poster or flyer) into an acceptance checklist.
The checklist is a contract: the merchant is paid only for images that pass every item, and an AI inspector will check each item by looking at ONE image.
Rules:
- 3 to 6 items. Each item is one atomic, objectively checkable fact about the image. No taste words like "beautiful" or "high quality".
- If the request asks for words on the image, the first item must quote the exact text verbatim inside double quotes and say it must be spelled exactly, with nothing missing or added.
- Keep explicit numbers, names, colours, dates, prices and exclusions ("no dogs") from the request. Do not invent requirements the customer did not ask for, except one item that the image is free of garbled or unreadable extra text when any text is requested.
- category is one of: text, count, subject, color, composition, style, safety, other.
Return JSON: {"title": short order title (max 60 chars), "criteria": [{"text": string, "category": string}]}`;

export async function draftCriteria(env: Env, brief: string): Promise<{ title: string; criteria: Criterion[] }> {
  const out = await chatJson<{ title?: string; criteria?: { text?: string; category?: string }[] }>(env, CRITERIA_MODEL, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Customer request:\n${brief}` },
  ], { temperature: 0.2, timeoutMs: 45000 });
  return { title: clampText(out.title || 'Custom card', 60), criteria: normalizeCriteria(out.criteria || []) };
}

export function normalizeCriteria(input: unknown): Criterion[] {
  if (!Array.isArray(input)) throw new HttpError(400, 'criteria must be a list');
  const list = input.map((c: any, i) => {
    const text = clampText(typeof c === 'string' ? c : c?.text, 240);
    const cat = String(c?.category || 'other').toLowerCase() as CriterionCategory;
    return { id: i + 1, text, category: CATEGORIES.includes(cat) ? cat : 'other' };
  }).filter(c => c.text.length >= 5);
  if (list.length < 1 || list.length > 8) throw new HttpError(400, 'Give between 1 and 8 checklist items.');
  return list.map((c, i) => ({ ...c, id: i + 1 }));
}

export interface Contract {
  shop_id: string;
  brief: string;
  criteria: Criterion[];
  quantity: number;
  unit_price_cents: number;
  currency: string;
  terms: string;
}

/** The hash both sides "sign": it is written into the PayPal order (custom_id) and every receipt. */
export async function contractHash(c: Contract): Promise<string> {
  return sha256Hex(canonicalJson(c));
}
