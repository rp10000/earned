// Pure settlement math, kept separate so it can be tested without PayPal.

export interface SettlementInput {
  authorizedCents: number;
  unitPriceCents: number;
  verdicts: ('pass' | 'fail' | null)[];
}

export interface Settlement {
  passed: number;
  failed: number;
  captureCents: number;
  releaseCents: number;
  action: 'capture' | 'void';
}

export function settle(input: SettlementInput): Settlement {
  if (input.verdicts.some(v => v === null)) throw new Error('Cannot settle before every item has a verdict');
  const passed = input.verdicts.filter(v => v === 'pass').length;
  const failed = input.verdicts.length - passed;
  const captureCents = Math.min(passed * input.unitPriceCents, input.authorizedCents);
  return {
    passed,
    failed,
    captureCents,
    releaseCents: input.authorizedCents - captureCents,
    action: captureCents > 0 ? 'capture' : 'void',
  };
}

export function payerNote(s: Settlement, total: number): string {
  if (s.action === 'void') return `None of the ${total} items passed the signed checklist, so the hold was released in full.`;
  const released = s.releaseCents > 0 ? ` $${(s.releaseCents / 100).toFixed(2)} of the hold was released.` : '';
  return `${s.passed} of ${total} items passed the signed checklist; you paid only for those.${released}`;
}

/** Earned keeps a platform fee; the studio gets the rest of what the buyer finally paid. */
export const PLATFORM_FEE_BPS = 1000; // 10%

export function studioShare(capturedCents: number, refundedCents: number, feeBps = PLATFORM_FEE_BPS): { net: number; fee: number; share: number } {
  const net = Math.max(0, capturedCents - refundedCents);
  const fee = Math.round((net * feeBps) / 10000);
  return { net, fee, share: net - fee };
}

/** Refunds from appeals upheld after an earlier payout are recovered from the studio's next payout. */
export function payoutAfterClawbacks(shareCents: number, outstandingCents: number): { amount: number; recovered: number } {
  const recovered = Math.max(0, Math.min(shareCents, outstandingCents));
  return { amount: shareCents - recovered, recovered };
}
