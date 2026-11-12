// Seek to given times, capture stills and report layout problems.
// Usage: node inspect.mjs 3 13 22 ...
import fs from 'node:fs';

const times = process.argv.slice(2).map(Number);
const port = 9222;
const out = 'build/stills';
fs.mkdirSync(out, { recursive: true });
const res = await fetch(`http://127.0.0.1:${port}/json/list`);
const page = (await res.json()).find((t) => t.type === 'page' && t.url.includes('film.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

const diag = `(() => {
  const active = [...document.querySelectorAll('.scene')].filter(s => parseFloat(getComputedStyle(s).opacity) > 0.55);
  const scene = active.map(s => s.id).join(',');
  const issues = [];
  const root = active[0];
  if (!root) return { scene: 'none', issues: ['NO-ACTIVE-SCENE'] };
  const pk = document.getElementById('packet').getBoundingClientRect();
  const pkOn = parseFloat(getComputedStyle(document.getElementById('packet')).opacity) > 0.5;
  const capEl = document.getElementById('caption');
  const capOn = parseFloat(getComputedStyle(capEl).opacity) > 0.4;
  const cap = capEl.getBoundingClientRect();
  const all = [...root.querySelectorAll('*')];
  for (const n of all) {
    const st = getComputedStyle(n);
    if (st.visibility === 'hidden' || parseFloat(st.opacity) < 0.25) continue;
    const r = n.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) continue;
    const tag = n.id || (typeof n.className === 'string' ? n.className : n.tagName);
    if (r.left < -2 || r.top < -2 || r.right > 1922 || r.bottom > 1082) issues.push('OUT ' + tag + ' ' + [r.left,r.top,r.right,r.bottom].map(Math.round).join(','));
    const txt = (n.childElementCount === 0 && n.textContent.trim().length > 2);
    if (txt) {
      if (n.scrollWidth > n.clientWidth + 2 && st.overflow !== 'visible') issues.push('CLIP ' + tag);
      if (capOn && r.left < cap.right && r.right > cap.left && r.top < cap.bottom && r.bottom > cap.top) issues.push('CAP-OVER ' + tag + ' ' + [r.left,r.top,r.right,r.bottom].map(Math.round).join(','));
      if (pkOn && r.left < pk.right && r.right > pk.left && r.top < pk.bottom && r.bottom > pk.top) issues.push('PKT-OVER ' + tag + '|' + (document.getElementById('pk-label').textContent));
    }
  }
  return { scene, issues: [...new Set(issues)].slice(0, 12), packet: pkOn ? [pk.left,pk.top,pk.width,pk.height].map(Math.round) : null };
})()`;

await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
for (const t of times) {
  await send('Runtime.evaluate', { expression: `window.__seek(${t})` });
  await new Promise((r) => setTimeout(r, 120));
  const r = await send('Runtime.evaluate', { expression: diag, returnByValue: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const name = `t-${String(t).padStart(5, '0')}.png`;
  fs.writeFileSync(`${out}/${name}`, Buffer.from(shot.data, 'base64'));
  console.log(`t=${t}`, JSON.stringify(r.result.value));
}
ws.close();
