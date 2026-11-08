import type { Env } from './types.ts';
import { b64url, canonicalJson, fromB64url } from './util.ts';

// Every settled order gets a verdict receipt signed with Ed25519. Anyone (a person, a buyer's AI
// agent, another marketplace) can verify it against the public key at /.well-known/earned-receipt-key.json.
// Receipts are what the Quality Index is built from: money-backed, tamper-evident outcomes.

const ALG = { name: 'Ed25519' } as const;

// Runtimes disagree about the JWK "alg" for Ed25519 ("Ed25519" vs "EdDSA"), so keys are imported
// with only the fields that define the key.
const bare = (k: JsonWebKey & { d?: string }, priv: boolean): JsonWebKey =>
  (priv ? { kty: k.kty, crv: k.crv, x: k.x, d: k.d } : { kty: k.kty, crv: k.crv, x: k.x }) as JsonWebKey;

export function publicJwk(env: Env): JsonWebKey {
  return bare(JSON.parse(env.RECEIPT_SIGNING_JWK), false);
}

export async function keyId(env: Env): Promise<string> {
  const x = (publicJwk(env) as { x?: string }).x || '';
  return x.slice(0, 16);
}

export async function signReceipt(env: Env, receipt: Record<string, unknown>): Promise<{ json: string; sig: string }> {
  const json = canonicalJson(receipt);
  const key = await crypto.subtle.importKey('jwk', bare(JSON.parse(env.RECEIPT_SIGNING_JWK), true), ALG, false, ['sign']);
  const sig = await crypto.subtle.sign(ALG, key, new TextEncoder().encode(json));
  return { json, sig: b64url(sig) };
}

export async function verifyReceipt(pub: JsonWebKey, json: string, sig: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('jwk', bare(pub, false), ALG, false, ['verify']);
  return crypto.subtle.verify(ALG, key, fromB64url(sig), new TextEncoder().encode(json));
}

export async function generateKeyJwk(): Promise<JsonWebKey> {
  const pair = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']) as CryptoKeyPair;
  return crypto.subtle.exportKey('jwk', pair.privateKey) as Promise<JsonWebKey>;
}
