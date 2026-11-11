/**
 * Deterministic renderer for the launch film.
 *
 * The picture is a pure function of time: `window.seek(t)` sets every style and every
 * string, so a frame can be reproduced by asking for its timestamp. This script opens
 * the page in headless Chrome over the DevTools protocol (no npm dependency), renders
 * two subframes per output frame, and pipes JPEGs straight into ffmpeg, which averages
 * the pair into a 30 fps motion-blurred frame.
 *
 *   node render.mjs
 *
 * Outputs silent.mp4 next to this file. Run ./build.sh for score, mux and storyboard.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(here, "index.html");
const profile = "/tmp/till-launch-chrome";
const chromeBin = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
const PORT = 9222;
const FPS = 30;
const SECONDS = 30;
const SUBFRAMES = 2;
const frames = FPS * SECONDS;

await rm(profile, { recursive: true, force: true });
await mkdir(profile, { recursive: true });

const chrome = spawn(
  chromeBin,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1920,1080",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let chromeLog = "";
chrome.stderr.on("data", (chunk) => {
  chromeLog += chunk.toString();
});

async function httpJson(path) {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

let target;
for (let attempt = 0; attempt < 80; attempt++) {
  try {
    const targets = await httpJson("/json/list");
    target = targets.find((item) => item.type === "page");
    if (target) break;
  } catch {
    // Chrome is still starting.
  }
  await new Promise((r) => setTimeout(r, 250));
}
if (!target?.webSocketDebuggerUrl) {
  console.error(chromeLog.slice(-4000));
  throw new Error("no DevTools page target");
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
await once(socket, "open");

let nextId = 0;
const pending = new Map();
const events = [];

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve: done, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else done(message.result);
  } else if (message.method) {
    events.push(message);
  }
});

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "page exception");
  }
  return result.result?.value;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1920,
  height: 1080,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.navigate", { url: `file://${pagePath}` });

let ready = false;
for (let attempt = 0; attempt < 200; attempt++) {
  try {
    ready =
      (await evaluate("document.readyState === 'complete' && window.__ready === true")) === true;
    if (ready) break;
  } catch {
    // navigation in flight
  }
  await new Promise((r) => setTimeout(r, 100));
}
if (!ready) throw new Error("film page never became ready");
await evaluate("document.fonts.ready.then(() => true)");

const ffmpeg = spawn(
  "ffmpeg",
  [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "-framerate",
    String(FPS * SUBFRAMES),
    "-i",
    "-",
    "-vf",
    `tmix=frames=${SUBFRAMES},fps=${FPS}`,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "17",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
    resolve(here, "silent.mp4"),
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);

const started = Date.now();
for (let frame = 0; frame < frames; frame++) {
  for (let sub = 0; sub < SUBFRAMES; sub++) {
    const t = frame / FPS + sub / (FPS * SUBFRAMES);
    await evaluate(
      `window.seek(${t.toFixed(5)}); new Promise(r => requestAnimationFrame(() => r(1)))`,
    );
    const shot = await send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 96,
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const buffer = Buffer.from(shot.data, "base64");
    if (!ffmpeg.stdin.write(buffer)) await once(ffmpeg.stdin, "drain");
  }
  if (frame % 90 === 0) {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(`  frame ${frame}/${frames}  ${elapsed}s\n`);
  }
}

ffmpeg.stdin.end();
const [code] = await once(ffmpeg, "close");
socket.close();
chrome.kill("SIGKILL");

if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
console.log(`rendered ${frames} frames at ${FPS}fps → silent.mp4`);
