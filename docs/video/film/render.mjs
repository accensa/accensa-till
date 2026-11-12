// Renders the film frame by frame through Chrome DevTools Protocol.
// Usage: node render.mjs <port> <fps> <start> <end> <outdir>
import fs from 'node:fs';
import path from 'node:path';

const [, , portArg, fpsArg, startArg, endArg, outArg] = process.argv;
const port = Number(portArg || 9222);
const fps = Number(fpsArg || 60);
const startFrame = Number(startArg || 0);
const endFrame = Number(endArg || -1);
const outDir = outArg || 'build/frames';
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('film.html'));
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('no film.html target');
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};
function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
}

for (let i = 0; i < 100; i++) {
  const r = await send('Runtime.evaluate', { expression: 'window.__ready === true', returnByValue: true });
  if (r.result.value) break;
  await sleep(200);
}

await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
const dur = (await send('Runtime.evaluate', { expression: 'window.__duration', returnByValue: true })).result.value;
const total = endFrame < 0 ? Math.ceil(dur * fps) : endFrame;
console.log(`duration ${dur}s · fps ${fps} · frames ${startFrame}..${total}`);

const t0 = Date.now();
for (let f = startFrame; f < total; f++) {
  const t = f / fps;
  // Two frames of the page's own clock before the capture: seeking only mutates
  // styles, and without this the compositor can hand back the previous frame
  // (measured: 233 identical neighbours in a 6 255-frame cut).
  await send('Runtime.evaluate', {
    expression: `window.__seek(${t}); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))`,
    awaitPromise: true,
  });
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 94, captureBeyondViewport: false });
  fs.writeFileSync(path.join(outDir, String(f).padStart(5, '0') + '.jpg'), Buffer.from(shot.data, 'base64'));
  if (f % 120 === 0) {
    const el = (Date.now() - t0) / 1000;
    const rate = (f - startFrame + 1) / el;
    const eta = (total - f) / rate;
    console.log(`frame ${f}/${total}  ${rate.toFixed(1)} fps  eta ${eta.toFixed(0)}s`);
  }
}
console.log(`done ${total - startFrame} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
ws.close();
