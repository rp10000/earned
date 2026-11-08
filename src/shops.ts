// Demo merchants. Each is a small AI studio that sells the same kind of product (custom cards and
// posters) but runs on a different image model. Their real pass rates, measured by settled money,
// are what the Quality Index ranks.

export interface Shop {
  id: string;
  name: string;
  tagline: string;
  model: string;          // image model behind the studio (disclosed in the README, not in the UI)
  unitPriceCents: number;
  estCostUsd: number;      // what one image costs the merchant, used for the demo spend cap
  accent: string;
}

export const SHOPS: Shop[] = [
  { id: 'lantern', name: 'Paper Lantern', tagline: 'Hand-lettered cards in seconds', model: 'qwen-image-2.0', unitPriceCents: 150, estCostUsd: 0.02, accent: '#e4572e' },
  { id: 'quickcard', name: 'Quickcard', tagline: 'Fast, cheap, cheerful', model: 'z-image-turbo', unitPriceCents: 150, estCostUsd: 0.01, accent: '#2e86ab' },
  { id: 'kite', name: 'Kite & Ink', tagline: 'Posters for small businesses', model: 'flux-3-image-klein', unitPriceCents: 150, estCostUsd: 0.0072, accent: '#7b2d8b' },
  { id: 'northpole', name: 'Northpole Press', tagline: 'Premium festive illustration', model: 'gpt-image-2.6-flare', unitPriceCents: 150, estCostUsd: 0.0201, accent: '#1b7f5f' },
];

export const shopById = (id: string) => SHOPS.find(s => s.id === id);

export const MAX_QUANTITY = 4;
export const MIN_QUANTITY = 1;
