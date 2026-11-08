// Shared helpers for every page. No framework: plain DOM, so the demo loads instantly.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { code: j.code, status: r.status });
  return j;
}

export const usd = v => '$' + Number(v || 0).toFixed(2);
export const pct = v => (v === null || v === undefined) ? '—' : (v * 100).toFixed(v >= 0.995 || v === 0 ? 0 : 1) + '%';
export const time = t => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const ago = t => {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - t));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
};

const LINKS = [
  ['/studio', 'Order'],
  ['/agent', 'Agent'],
  ['/quality', 'Quality Index'],
  ['/developers', 'Developers', 'hide-sm'],
];

export function chrome() {
  const here = location.pathname.replace(/\/$/, '') || '/';
  const nav = document.createElement('header');
  nav.className = 'nav';
  nav.innerHTML = `<div class="wrap">
    <a class="brand" href="/"><span class="mark">e</span>Earned</a>
    <span class="pill-sandbox" title="PayPal sandbox: no real money moves">PayPal sandbox</span>
    <nav>${LINKS.map(([h, t, c]) => `<a href="${h}" class="${c || ''}" ${here === h ? 'aria-current="page"' : ''}>${t}</a>`).join('')}</nav>
  </div>`;
  document.body.prepend(nav);
  const foot = document.createElement('footer');
  foot.className = 'site';
  foot.innerHTML = `<div class="wrap"><span>Earned: pay AI only for what works. Open source (MIT). Payments run in the PayPal sandbox; images and inspections use real AI models.</span>
    <span><a href="/developers">MCP &amp; API</a> · <a href="/.well-known/earned-receipt-key.json">Receipt key</a> · <a href="/llms.txt">llms.txt</a></span></div>`;
  document.body.append(foot);
}

export function moneyBar(m) {
  const auth = Number(m.authorized) || Number(m.on_hold) || 0;
  const paid = Number(m.captured) - Number(m.refunded || 0);
  const rel = Number(m.released) + Number(m.refunded || 0);
  const held = Number(m.on_hold);
  const w = v => auth ? Math.max(0, Math.min(100, (v / auth) * 100)) : 0;
  return `<div class="moneybar" role="img" aria-label="Paid ${usd(paid)}, released ${usd(rel)}, on hold ${usd(held)}">
      <span class="m-paid" style="width:${w(paid)}%"></span><span class="m-released" style="width:${w(rel)}%"></span><span class="m-held" style="width:${w(held)}%"></span>
    </div>
    <div class="money-legend">
      <span><i class="dot held"></i>Held <b>${usd(auth)}</b></span>
      <span><i class="dot paid"></i>Paid <b>${usd(paid)}</b></span>
      <span><i class="dot released"></i>Released to buyer <b>${usd(rel)}</b></span>
    </div>`;
}

export function checksHtml(item, criteria) {
  if (!item.checks) return '';
  return `<ul class="checks">${item.checks.map(c => {
    const k = criteria.find(x => x.id === c.id);
    return `<li><span class="${c.pass ? 'ok' : 'no'}">${c.pass ? '✓' : '✕'}</span><span>${esc(k ? k.text : 'Item ' + c.id)}${c.decided_by === 'tiebreak' ? '<span class="tb">tiebreak</span>' : ''}<span class="ev">${esc(c.evidence)}</span></span></li>`;
  }).join('')}</ul>`;
}

chrome();
