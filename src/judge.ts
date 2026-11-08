import { chatJson } from './ai.ts';
import type { ConsensusCheck, Criterion, Env, ItemVerdict, JudgeOpinion } from './types.ts';
import { clampText } from './util.ts';

// Two independent vision models inspect every delivered image against the signed checklist.
// A criterion passes when both say pass and fails when both say fail. When they disagree, a third,
// stronger model sees both opinions and decides that criterion alone. An item is paid for only if
// every criterion passes.

export const JUDGES = ['gemini-3.8-flash', 'gpt-6-luna'];
export const TIEBREAKER = 'gemini-3.1-pro-preview';

const SYSTEM = `You are an impartial acceptance inspector for an AI image marketplace. Money moves on your answer.
You check ONE delivered image against a checklist that buyer and seller signed before work started.
- First transcribe every piece of text visible in the image exactly, character by character (keep line breaks as " / ").
- Then judge each checklist item on what is visible. Pass only if the item is clearly and fully met. Do not judge taste.
- Spelling, punctuation that changes meaning, missing or extra words, wrong numbers, wrong counts and wrong colours are failures.
- Layout is not spelling: text may wrap onto several lines and may use any font, size or case styling. Join the lines in reading order with single spaces and compare that sequence of words, numbers and separators. A separator that lands at the start of a new line still sits between the same words.
- Evidence must point at something concrete in the image (quote text, name the object or region).
Return JSON only: {"transcribed_text": string, "checks": [{"id": number, "pass": boolean, "evidence": string}]}`;

function checklist(criteria: Criterion[]): string {
  return 'Signed checklist:\n' + criteria.map(c => `${c.id}. ${c.text}${c.required ? '' : ' (style preference)'}`).join('\n');
}

export async function askJudge(env: Env, model: string, imageUrl: string, criteria: Criterion[]): Promise<JudgeOpinion> {
  try {
    const out = await chatJson<{ transcribed_text?: string; checks?: { id?: number; pass?: boolean; evidence?: string }[] }>(env, model, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: [{ type: 'text', text: checklist(criteria) }, { type: 'image_url', image_url: { url: imageUrl } }] },
    ], { temperature: 0, timeoutMs: 70000 });
    const byId = new Map((out.checks || []).map(c => [Number(c.id), c]));
    return {
      judge: model,
      transcribed_text: clampText(out.transcribed_text, 600),
      checks: criteria.map(c => {
        const v = byId.get(c.id);
        return { id: c.id, pass: v?.pass === true, evidence: clampText(v?.evidence || 'No answer for this item.', 300) };
      }),
    };
  } catch (e) {
    return { judge: model, transcribed_text: '', checks: [], error: String((e as Error).message).slice(0, 200) };
  }
}

const TIE_SYSTEM = `You are the deciding inspector. Two inspectors disagreed about one checklist item for the attached image.
Look at the image yourself, read both opinions, and decide. Be strict about exact text, numbers, counts and colours.
Return JSON only: {"pass": boolean, "evidence": string}`;

export async function tiebreak(env: Env, imageUrl: string, criterion: Criterion, votes: ConsensusCheck['votes']): Promise<{ pass: boolean; evidence: string }> {
  const opinions = votes.map(v => `- ${v.pass ? 'PASS' : 'FAIL'}: ${v.evidence}`).join('\n');
  const out = await chatJson<{ pass?: boolean; evidence?: string }>(env, TIEBREAKER, [
    { role: 'system', content: TIE_SYSTEM },
    { role: 'user', content: [{ type: 'text', text: `Checklist item: ${criterion.text}\nOpinions:\n${opinions}` }, { type: 'image_url', image_url: { url: imageUrl } }] },
  ], { temperature: 0, timeoutMs: 90000 });
  return { pass: out.pass === true, evidence: clampText(out.evidence || '', 300) };
}

/** Pure: merges two opinions; returns the merged checks and the ids that still need a tiebreak. */
export function mergeOpinions(criteria: Criterion[], opinions: JudgeOpinion[]): { checks: ConsensusCheck[]; disputed: number[] } {
  const usable = opinions.filter(o => !o.error && o.checks.length === criteria.length);
  const disputed: number[] = [];
  const checks = criteria.map<ConsensusCheck>(c => {
    const votes = usable.map(o => {
      const v = o.checks.find(x => x.id === c.id)!;
      return { judge: o.judge, pass: v.pass, evidence: v.evidence };
    });
    const passes = votes.filter(v => v.pass).length;
    if (votes.length >= 2 && passes !== 0 && passes !== votes.length) {
      // Only items that decide payment are worth a tiebreak; split preferences are reported as split.
      if (!c.required) return { id: c.id, pass: false, decided_by: 'split', evidence: votes.find(v => !v.pass)?.evidence || 'Inspectors disagreed.', votes };
      disputed.push(c.id);
      return { id: c.id, pass: false, decided_by: 'tiebreak', evidence: 'Inspectors disagreed.', votes };
    }
    const pass = votes.length > 0 && passes === votes.length;
    const lead = votes.find(v => v.pass === pass) || votes[0];
    return { id: c.id, pass, decided_by: 'consensus', evidence: lead?.evidence || 'No inspector could read this image.', votes };
  });
  if (usable.length === 1) {
    // Only one inspector answered: every required item gets a second opinion from the tiebreaker.
    return { checks, disputed: criteria.filter(c => c.required).map(c => c.id) };
  }
  return { checks, disputed };
}

/** An item is paid for when every required item passes; preferences never block payment. */
export function itemVerdict(criteria: Criterion[], checks: ConsensusCheck[]): 'pass' | 'fail' {
  return criteria.filter(c => c.required).every(c => checks.find(k => k.id === c.id)?.pass === true) ? 'pass' : 'fail';
}

export async function judgeImage(env: Env, imageUrl: string, criteria: Criterion[]): Promise<ItemVerdict & { calls: { judges: number; tiebreaks: number } }> {
  const opinions = await Promise.all(JUDGES.map(m => askJudge(env, m, imageUrl, criteria)));
  const { checks, disputed } = mergeOpinions(criteria, opinions);
  if (opinions.every(o => o.error)) throw new Error('No inspector could review this image: ' + opinions.map(o => o.error).join('; '));
  await Promise.all(disputed.map(async id => {
    const c = criteria.find(x => x.id === id)!;
    const check = checks.find(x => x.id === id)!;
    const t = await tiebreak(env, imageUrl, c, check.votes);
    check.pass = t.pass;
    check.decided_by = 'tiebreak';
    check.evidence = t.evidence;
    check.votes.push({ judge: TIEBREAKER, pass: t.pass, evidence: t.evidence });
  }));
  const transcript = opinions.find(o => o.transcribed_text)?.transcribed_text || '';
  return {
    verdict: itemVerdict(criteria, checks),
    transcript,
    checks,
    calls: { judges: opinions.length, tiebreaks: disputed.length },
  };
}
