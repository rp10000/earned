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
