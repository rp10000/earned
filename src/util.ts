export const now = () => Math.floor(Date.now() / 1000);
export const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'error') { super(message); this.status = status; this.code = code; }
}

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export function newId(prefix: string, len = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += ALPHABET[b & 31];
  return `${prefix}_${s}`;
}

/** JSON with object keys sorted recursively, so the same data always hashes and signs the same way. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).filter(k => obj[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const money = (cents: number) => (cents / 100).toFixed(2);

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}

export function clampText(s: unknown, max: number): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function originOf(req: Request, env: { PUBLIC_ORIGIN?: string }): string {
  return env.PUBLIC_ORIGIN || new URL(req.url).origin;
}
