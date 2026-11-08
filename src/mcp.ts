import { TOOLS, toolByName, type ToolCtx } from './tools.ts';
import { HttpError } from './util.ts';

// Minimal MCP server over Streamable HTTP (JSON responses, no sessions needed).
// Works with any MCP client that can add a remote server by URL.

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface RpcRequest { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: any }

const ok = (id: RpcRequest['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const err = (id: RpcRequest['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export async function handleMcp(req: Request, ctx: Omit<ToolCtx, 'source'>): Promise<Response> {
  if (req.method === 'GET') return new Response('This MCP endpoint speaks JSON-RPC over POST (Streamable HTTP).', { status: 405, headers: { allow: 'POST' } });
  if (req.method === 'DELETE') return new Response(null, { status: 204 });
  let body: RpcRequest | RpcRequest[];
  try { body = await req.json(); } catch { return Response.json(err(null, -32700, 'Parse error'), { status: 400 }); }
  const batch = Array.isArray(body) ? body : [body];
  const out = [];
  for (const m of batch) {
    const r = await dispatch(m, { ...ctx, source: 'mcp' });
    if (r) out.push(r);
  }
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? out : out[0], { headers: { 'cache-control': 'no-store' } });
}

async function dispatch(m: RpcRequest, ctx: ToolCtx) {
  const isNotification = m.id === undefined;
  try {
    switch (m.method) {
      case 'initialize': {
        const asked = m.params?.protocolVersion;
        return ok(m.id, {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'earned', title: 'Earned: pay AI only for what works', version: '0.1.0' },
          instructions: 'Use search_quality_index to pick a studio, draft_acceptance_checklist to agree the contract with the buyer, then create_outcome_order. Hand approve_url to the human; you cannot approve payments yourself. Poll get_order_status until settled and report what passed, what failed and why, and how much PayPal captured vs released.',
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return ok(m.id, {});
      case 'tools/list':
        return ok(m.id, {
          tools: TOOLS.map(t => ({
            name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
            annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: !t.readOnly },
          })),
        });
      case 'tools/call': {
        const tool = toolByName(m.params?.name);
        if (!tool) return err(m.id, -32602, `Unknown tool: ${m.params?.name}`);
        try {
          const result = await tool.run(m.params?.arguments || {}, ctx);
          return ok(m.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
        } catch (e) {
          const msg = e instanceof HttpError ? e.message : 'Tool failed: ' + (e as Error).message;
          return ok(m.id, { content: [{ type: 'text', text: msg }], isError: true });
        }
      }
      default:
        return isNotification ? null : err(m.id, -32601, `Method not found: ${m.method}`);
    }
  } catch (e) {
    return isNotification ? null : err(m.id, -32603, (e as Error).message);
  }
}
