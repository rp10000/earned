// Prints a new Ed25519 private key as one-line JWK JSON for RECEIPT_SIGNING_JWK.
// Usage: node scripts/gen-receipt-key.mjs   (store the output as a secret; never commit it)
const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
console.log(JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)));
