// Creates real pay-per-pass orders against a running Earned instance so the Quality Index has data.
// Every order still needs a human to approve its PayPal sandbox hold (the script prints the links);
// after approval the script keeps polling until each order has settled through PayPal.
//
// Usage: node scripts/seed-orders.mjs http://localhost:8787 [count]
//        node scripts/seed-orders.mjs http://localhost:8787 --watch ord_a,ord_b   (resume polling)

const BRIEFS = [
  'A square holiday card: exactly three cats sitting on a blue sofa, one black, one orange, one white. No dogs. Printed text: "Happy Holidays from Wei Ling, Arjun & Mochi — Singapore 2026".',
  'A poster for my bakery opening. A steaming cup of tea next to two slices of kaya toast. Text exactly: "Grand Opening · Sat 22 Nov · Kaya Toast $2.50 · Teh Tarik $1.80".',
  'A birthday card: a bunch of exactly 7 yellow tulips in a glass vase on a wooden table. Text: "Happy 60th, Linda! Love, Sam & Priya".',
  'A thank-you card for a teacher: one red apple on a stack of exactly 3 books. Text: "Thank you, Ms. Okafor — Class 4B, 2026".',
  'A save-the-date card with two interlocking gold rings and no people. Text exactly: "Save the Date · Aisha & Tom · 14.02.2027 · Penang".',
  'A yard sale flyer with exactly 3 red balloons. Text exactly: "YARD SALE · Sun 9am–1pm · 42 Maple Road · Everything $1".',
  'A lost cat poster showing a grey tabby cat. Text exactly: "LOST CAT · Answers to Pepper · Call 9123 4567".',
  'A Diwali greeting card with exactly 5 lit clay diyas in a row. Text: "Happy Diwali from the Nair Family".',
  'A kids party invitation with a green dinosaur wearing a party hat. Text exactly: "Maya turns 7! · Sat 6 Dec, 3pm · Unit 12-04".',
  'A cafe menu board, chalkboard look. Text exactly: "Today: Laksa $6.90 · Chicken Rice $5.50 · Kopi $1.60".',
  'A retirement card with a fishing rod and a straw hat, no people. Text: "Happy Retirement, Mr. Hendricks — 32 years at Larkfield Primary".',
  'A plant shop sale sign with exactly 2 potted plants: one monstera and one pothos. Text exactly: "Monstera 20% off · Pothos 3 for $15".',
  'A get-well card with exactly 4 orange daisies in a blue mug. Text: "Get well soon, Grandpa Joe! ♥ Lily".',
  'A bake sale poster with exactly 6 cupcakes with pink icing. Text exactly: "School Bake Sale · Fri 28 Nov · All cakes $2".',
  'A new home card with a small red front door and a doormat that says "HOME". Text: "Welcome home, Priya & Ken — 18 Orchid Lane".',
  'A gym class flyer with a pair of blue dumbbells and no people. Text exactly: "Morning HIIT · Mon/Wed/Fri 7:00 · First class free".',
];
const SHOPS = ['lantern', 'quickcard', 'kite', 'northpole'];

const base = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');
const watchIdx = process.argv.indexOf('--watch');
const api = async (path, body) => {
  const r = await fetch(base + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error}`);
  return j;
};

let ids = [];
if (watchIdx > 0) ids = process.argv[watchIdx + 1].split(',');
else {
  const count = Math.min(Number(process.argv[3]) || BRIEFS.length, BRIEFS.length);
  for (let i = 0; i < count; i++) {
    const brief = BRIEFS[i];
    const { criteria } = await api('/api/criteria', { brief });
    const { order, approve_url } = await api('/api/orders', { studio_id: SHOPS[i % SHOPS.length], brief, criteria, quantity: 4 });
    ids.push(order.id);
    console.log(`${order.id}\t${order.studio.name}\t${approve_url}`);
  }
  console.log('\nApprove each link above with a PayPal sandbox buyer, then this script settles them.\nIDS=' + ids.join(','));
}

const done = new Set();
while (done.size < ids.length) {
  for (const id of ids) {
    if (done.has(id)) continue;
    try {
      const { order } = await api(`/api/orders/${id}`);
      if (['settled', 'voided', 'failed', 'cancelled'].includes(order.status)) {
        done.add(id);
        const passed = order.items.filter(i => i.verdict === 'pass').length;
        console.log(`${id}\t${order.status}\t${passed}/${order.items.length} passed\tcaptured $${order.money.captured} released $${order.money.released}`);
      }
    } catch (e) { console.error(id, e.message); }
  }
  await new Promise(r => setTimeout(r, 2000));
}
