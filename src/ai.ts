import type { Env } from './types.ts';

// Thin client for an OpenAI-compatible AI gateway (the demo uses APIMart, which serves both the
// image models behind the studios and the vision models used as judges).

const base = (env: Env) => (env.AI_API_BASE || 'https://api.apimart.ai').replace(/\/$/, '');
const headers = (env: Env) => ({ Authorization: `Bearer ${env.AI_API_KEY}`, 'Content-Type': 'application/json' });

export type ChatContent = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatContent | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatOptions {
  json?: boolean;
  temperature?: number;
  tools?: unknown[];
  timeoutMs?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export async function chat(env: Env, model: string, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatMessage> {
  const body: Record<string, unknown> = { model, messages, stream: false };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.json) body.response_format = { type: 'json_object' };
  if (opts.tools) { body.tools = opts.tools; body.tool_choice = 'auto'; }
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
  const r = await fetch(base(env) + '/v1/chat/completions', {
    method: 'POST', headers: headers(env), body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60000),
  });
  const j = await r.json<any>().catch(() => ({}));
  const msg = j?.choices?.[0]?.message;
  if (!r.ok || !msg) throw new Error(`AI gateway ${r.status} for ${model}: ${String(j?.error?.message || 'no message').slice(0, 200)}`);
  return msg as ChatMessage;
}

/** Calls a model that must answer with a JSON object; tolerates code fences around it. */
export async function chatJson<T>(env: Env, model: string, messages: ChatMessage[], opts: ChatOptions = {}): Promise<T> {
  const msg = await chat(env, model, messages, { ...opts, json: true });
  return parseJsonLoose<T>(typeof msg.content === 'string' ? msg.content : '');
}

export function parseJsonLoose<T>(text: string): T {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t) as T; } catch { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1)) as T;
  throw new Error('Model did not return JSON');
}

export async function submitImage(env: Env, model: string, prompt: string): Promise<string> {
  const body: Record<string, unknown> = { model, prompt, n: 1, size: '1:1' };
  if (model.startsWith('gpt-image')) body.resolution = '1K';
  const r = await fetch(base(env) + '/v1/images/generations', {
    method: 'POST', headers: headers(env), body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const j = await r.json<any>().catch(() => ({}));
  const d = Array.isArray(j?.data) ? j.data[0] : j?.data;
  const id = d?.task_id || d?.id;
  if (!r.ok || !/^[\w-]+$/.test(id || '')) throw new Error(`Image submit failed (${r.status}): ${String(j?.error?.message || '').slice(0, 160)}`);
  return id;
}

export interface ImageTask { state: 'running' | 'done' | 'failed'; url?: string; error?: string }

export async function imageTask(env: Env, taskId: string): Promise<ImageTask> {
  const r = await fetch(base(env) + '/v1/tasks/' + encodeURIComponent(taskId), { headers: headers(env), signal: AbortSignal.timeout(20000) });
  const j = await r.json<any>().catch(() => ({}));
  const d = j?.data || j;
  const status = String(d?.status || '').toLowerCase();
  if (['completed', 'succeeded', 'success'].includes(status)) {
    const img = d?.result?.images?.[0];
    const url = Array.isArray(img?.url) ? img.url[0] : img?.url || d?.result?.data?.[0]?.url;
    return url ? { state: 'done', url } : { state: 'failed', error: 'No image in result' };
  }
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) return { state: 'failed', error: String(d?.error?.message || d?.fail_reason || status).slice(0, 200) };
  return { state: 'running' };
}
