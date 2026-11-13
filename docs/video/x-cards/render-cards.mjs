// Renders the three X cards to PNG through Chrome DevTools Protocol, and refuses
// to write one that overflows its frame or fell back to a system font.
//
// Usage: node docs/video/x-cards/render-cards.mjs [outdir]
//
// No npm dependency, for the same reason docs/video/film/render.mjs has none: the
// repository must render these from a clean clone with only Chrome installed.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// The PNGs are committed beside their sources, like docs/video/film/stills: they are
// the artefact the post attaches, not a build by-product.
const outDir = process.argv[2] ?? here;
const WIDTH = 1200;
const HEIGHT = 675;
const SCALE = 2;
const CARDS = [2, 3, 4];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chromeBinary() {
  const candidates = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const name of candidates) {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) {
        return full;
      }
    }
  }
  throw new Error(`no Chrome found on PATH (tried ${candidates.join(", ")})`);
}

/** A port the OS says is free, so two runs cannot collide. */
async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** PNG width and height, read out of the IHDR chunk rather than trusted. */
function pngSize(file) {
  const buf = fs.readFileSync(file);
  const signature = buf.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") {
    throw new Error(`${file} is not a PNG`);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

class Session {
  #socket;
  #nextId = 0;
  #pending = new Map();

  static async open(wsUrl) {
    const session = new Session();
    session.#socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      session.#socket.onopen = () => resolve(undefined);
      session.#socket.onerror = () => reject(new Error(`cannot open ${wsUrl}`));
    });
    session.#socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiter = message.id === undefined ? undefined : session.#pending.get(message.id);
      if (waiter === undefined) {
        return;
      }
      session.#pending.delete(message.id);
      if (message.error === undefined) {
        waiter.resolve(message.result);
      } else {
        waiter.reject(new Error(JSON.stringify(message.error)));
      }
    };
    return session;
  }

  send(method, params = {}) {
    const id = ++this.#nextId;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.text);
    }
    return result.result.value;
  }

  close() {
    this.#socket.close();
  }
}

/**
 * What "the card is right" means, measured in the page rather than eyeballed:
 * the three families resolved, nothing painted outside the 1200x675 frame, and the
 * document does not scroll (a page that scrolls is a card whose bottom is cut off).
 */
const MEASURE = `(() => {
  const box = { width: ${WIDTH}, height: ${HEIGHT} };
  const outside = [];
  for (const el of document.querySelectorAll("body *")) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.left < -0.5 || r.top < -0.5 || r.right > box.width + 0.5 || r.bottom > box.height + 0.5) {
      outside.push({
        tag: el.tagName.toLowerCase(),
        cls: el.className && typeof el.className === "string" ? el.className : "",
        right: Math.round(r.right),
        bottom: Math.round(r.bottom),
      });
    }
  }
  // Type: nothing painted below 10 px, and the smallest size is reported so a card
  // that drifted to unreadable footnotes is visible in the run log.
  let smallest = { px: 999, text: "" };
  const hex = (value) => {
    const m = value.match(/^rgba?\\(([\\d.]+), ?([\\d.]+), ?([\\d.]+)(?:, ?([\\d.]+))?\\)$/);
    if (m === null) return null;
    if (m[4] !== undefined && Number(m[4]) < 0.5) return null;
    const to = (n) => Math.round(Number(n)).toString(16).padStart(2, "0");
    return "#" + to(m[1]) + to(m[2]) + to(m[3]);
  };
  const colors = new Set();
  for (const el of document.querySelectorAll("body *")) {
    const text = (el.textContent ?? "").trim();
    if (text === "") continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const c = hex(style.color);
    if (c !== null) colors.add(c);
    const px = Number.parseFloat(style.fontSize);
    if (Number.isFinite(px) && px < smallest.px) smallest = { px, text: text.slice(0, 24) };
  }
  return {
    fonts: {
      spaceGrotesk: document.fonts.check('700 16px "Space Grotesk"'),
      inter: document.fonts.check('400 16px "Inter"'),
      jetbrains: document.fonts.check('400 16px "JetBrains Mono"'),
    },
    scroll: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
    outside: outside.slice(0, 8),
    card: document.querySelector(".card.on")?.dataset.card ?? null,
    smallest,
    colors: [...colors],
  };
})()`;

/** The film's palette, and the only colours a text run may use. */
const ALLOWED = new Set([
  "#f5f3ec",
  "#a4aab3",
  "#727984",
  "#c9ff57",
  "#63e6a4",
  "#ffb454",
  "#ff6f61",
  "#0a0d12",
]);

const chrome = chromeBinary();
const port = await freePort();
fs.mkdirSync(outDir, { recursive: true });
// Outside the repository, so a killed Chrome cannot leave a profile in the tree.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "till-x-cards-"));

const browser = spawn(
  chrome,
  [
    "--headless=new",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--allow-file-access-from-files",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let failures = 0;
const written = [];

try {
  let version = null;
  for (let attempt = 0; attempt < 80 && version === null; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      version = await response.json();
    } catch {
      await sleep(250);
    }
  }
  if (version === null) {
    throw new Error(`Chrome never answered on port ${port}`);
  }
  console.log(`chrome ${version.Browser}`);

  for (const card of CARDS) {
    const url = `file://${path.join(here, "cards.html")}?card=${card}`;
    const opened = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
      method: "PUT",
    });
    const target = await opened.json();
    const session = await Session.open(target.webSocketDebuggerUrl);
    try {
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: WIDTH,
        height: HEIGHT,
        deviceScaleFactor: SCALE,
        mobile: false,
      });
      let ready = false;
      for (let attempt = 0; attempt < 100 && !ready; attempt++) {
        ready = (await session.evaluate("window.__ready === true")) === true;
        if (!ready) {
          await sleep(100);
        }
      }
      if (!ready) {
        throw new Error(`card ${card}: the page never signalled readiness`);
      }

      const measured = await session.evaluate(MEASURE);
      const problems = [];
      if (measured.card !== String(card)) {
        problems.push(`showed card ${measured.card}`);
      }
      for (const [name, ok] of Object.entries(measured.fonts)) {
        if (ok !== true) {
          problems.push(`font missing: ${name}`);
        }
      }
      if (measured.scroll.w > WIDTH || measured.scroll.h > HEIGHT) {
        problems.push(`document scrolls to ${measured.scroll.w}x${measured.scroll.h}`);
      }
      if (measured.outside.length > 0) {
        problems.push(
          `outside the frame: ${measured.outside
            .map((el) => `${el.tag}.${el.cls}(r${el.right},b${el.bottom})`)
            .join(" ")}`,
        );
      }
      if (measured.smallest.px < 10) {
        problems.push(`type below 10 px: ${measured.smallest.px} on "${measured.smallest.text}"`);
      }
      const offPalette = measured.colors.filter((color) => !ALLOWED.has(color));
      if (offPalette.length > 0) {
        problems.push(`colours outside the palette: ${offPalette.join(" ")}`);
      }

      const shot = await session.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      const file = path.join(outDir, `x-post-${card}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
      const size = pngSize(file);
      const expected = WIDTH * SCALE;
      if (size.width !== expected || size.height !== HEIGHT * SCALE) {
        problems.push(
          `png is ${size.width}x${size.height}, expected ${expected}x${HEIGHT * SCALE}`,
        );
      }
      written.push({ file, ...size });

      if (problems.length === 0) {
        console.log(
          `card ${card}: ok · ${size.width}x${size.height} · ${size.bytes} bytes · ` +
            `smallest type ${measured.smallest.px}px · ${measured.colors.length} palette colours`,
        );
      } else {
        failures += 1;
        console.error(`card ${card}: FAILED — ${problems.join(" | ")}`);
      }
    } finally {
      session.close();
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => undefined);
    }
  }
} catch (error) {
  failures += 1;
  console.error(`render failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  browser.kill("SIGKILL");
  // Chrome writes into its profile while it dies, so a single rmdir raced it and
  // threw ENOTEMPTY (observed on the second run). Retry a few times; a profile left
  // behind is a warning under `build/`, not a failed render.
  await sleep(300);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 4) {
        console.warn(
          `could not remove ${profile}: ${error instanceof Error ? error.message : error}`,
        );
      }
      await sleep(300);
    }
  }
}

for (const file of written) {
  console.log(`${path.relative(process.cwd(), file.file)} · ${file.bytes} bytes`);
}
process.exit(failures === 0 ? 0 : 1);
