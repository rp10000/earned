import { chat, type ChatMessage } from './ai.ts';
import { COST, assertBudget, hit, record } from './budget.ts';
import { TOOLS, toolByName, type ToolCtx } from './tools.ts';
import { HttpError } from './util.ts';

// The built-in shopping agent: an LLM that buys on the Earned network with the same tools any MCP
// client gets. It is deliberately unable to pay: the PayPal approval stays with the human.

export const AGENT_MODEL = 'gemini-3.8-flash';
const MAX_STEPS = 6;

const SYSTEM = `You are Earned's shopping agent. You buy custom AI-made cards and posters for the user from independent AI studios, and you only ever buy on a pay-per-pass basis.
How you work:
1. When the user says what they want, call search_quality_index and pick the studio with the best money-backed record for this kind of job. Tell the user in one sentence why (pass rate and sample size).
2. Call draft_acceptance_checklist with the user's request. Show the checklist as a short numbered list and ask the user to confirm or edit it. Mention the price (unit price x number of images) and that nothing is charged for images that fail.
3. Only after the user confirms, call create_outcome_order. Then tell the user to approve the hold with the PayPal button that appears below your message (do not paste the approval URL; the button carries it). You cannot approve payments yourself.
4. When the user tells you the hold is approved (or a system note says the order changed), call get_order_status until the status is settled or voided. Then report: how many images passed, the exact reason each failed image failed, how much PayPal captured and how much was released, and the receipt link.
Style: short, warm, concrete. Plain text, no markdown tables. Never invent pass rates, prices or verdicts: only report what the tools returned.`;

const openAiTools = TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

export interface AgentEvent { tool: string; args: unknown; result?: unknown; error?: string }

function sanitizeHistory(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out = raw.slice(-40).filter((m: any) => m && ['user', 'assistant', 'tool'].includes(m.role)) as ChatMessage[];
  if (JSON.stringify(out).length > 120_000) throw new HttpError(413, 'Conversation is too long. Start a new chat.');
  return out;
}

export async function runAgent(history: unknown, userText: string, ctx: Omit<ToolCtx, 'source'>) {
  const text = String(userText || '').trim().slice(0, 1500);
  if (!text) throw new HttpError(400, 'Say something first.');
  await hit(ctx.env, ctx.visitor, 'chat', Number(ctx.env.VISITOR_DAILY_CHAT || 40));
  await assertBudget(ctx.env, COST.chatTurn * 3);

  const messages: ChatMessage[] = [...sanitizeHistory(history), { role: 'user', content: text }];
  const events: AgentEvent[] = [];
  const toolCtx: ToolCtx = { ...ctx, source: 'agent' };
  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await chat(ctx.env, AGENT_MODEL, [{ role: 'system', content: SYSTEM }, ...messages], { tools: openAiTools, temperature: 0.3, timeoutMs: 60000 });
    await record(ctx.env, 'chat', COST.chatTurn);
    messages.push(reply);
    if (!reply.tool_calls?.length) break;
    for (const call of reply.tool_calls) {
      const tool = toolByName(call.function.name);
      let args: unknown = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* keep empty */ }
      let content: string;
      try {
        if (!tool) throw new Error('Unknown tool ' + call.function.name);
        const result = await tool.run(args, toolCtx);
        events.push({ tool: call.function.name, args, result });
        content = JSON.stringify(result);
      } catch (e) {
        const msg = (e as Error).message;
        events.push({ tool: call.function.name, args, error: msg });
        content = JSON.stringify({ error: msg });
      }
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content });
    }
  }
  const last = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
  return { reply: (last?.content as string) || 'Done.', events, history: messages };
}
