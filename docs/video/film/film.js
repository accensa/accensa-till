/* Till — launch film. Every pixel is a pure function of t. */
window.addEventListener("error", (e) => {
  window.__err = String(e.message);
});
(() => {
  const T = window.TIMELINE;
  const S = {};
  T.scenes.forEach((s) => (S[s.id] = s));
  const D = T.duration;
  const $ = (id) => document.getElementById(id);
  const clamp = (x, a, b) =>
    Math.max(a === undefined ? 0 : a, Math.min(b === undefined ? 1 : b, x));
  const st = (t, a, b) => clamp((t - a) / (b - a));
  const eo = (x) => 1 - Math.pow(1 - clamp(x), 3);
  const ei = (x) => Math.pow(clamp(x), 3);
  const eio = (x) => {
    x = clamp(x);
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  };
  const lerp = (a, b, k) => a + (b - a) * k;
  const spring = (x) => {
    x = clamp(x);
    return 1 - Math.exp(-7 * x) * Math.cos(9.5 * x);
  };
  const pop = (t, at, amt) => (t < at ? 0 : amt * Math.exp(-(t - at) * 11));

  /* ---------------------------------------------------------- build DOM */
  const eps = [
    { p: "/prices", v: "$", r: "3.1k", w: 74 },
    { p: "/inference", v: "AI", r: "8.4k", w: 92 },
    { p: "/market-data", v: "MB", r: "5.6k", w: 61 },
    { p: "/weather", v: "°C", r: "1.2k", w: 38 },
    { p: "/search", v: "⌕", r: "9.8k", w: 83 },
    { p: "/translate", v: "A", r: "2.7k", w: 46 },
  ];
  const epGrid = $("ep-grid");
  eps.forEach((e, i) => {
    const d = document.createElement("div");
    d.className = "ep";
    d.id = "ep" + i;
    d.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<span class="path">' +
      e.p +
      "</span>" +
      '<span style="font-family:JetBrains Mono,monospace;font-size:11px;color:#c9ff57;border:1px solid rgba(201,255,87,.3);padding:2px 6px;border-radius:4px">' +
      e.v +
      "</span></div>" +
      '<div class="price">' +
      (i === 0
        ? "1.00 <small>USDC / REQ</small>"
        : i === 1
          ? "0.02 <small>USDC / REQ</small>"
          : "0.01 <small>USDC / REQ</small>") +
      "</div>" +
      '<div class="bar"><i style="width:' +
      e.w +
      '%"></i></div>' +
      '<div class="meta"><span>' +
      e.r +
      " req/h</span><b>LIVE</b></div>";
    if (i === 0) d.classList.add("on");
    epGrid.appendChild(d);
  });

  const s1lines = $("s1-lines");
  [
    "09:57:04  GET /prices        200",
    "09:57:04  GET /prices        200",
    "09:57:05  GET /market-data   200",
    "09:57:05  GET /prices        200",
    "09:57:06  GET /inference      200",
    "09:57:06  GET /prices        200",
  ].forEach((ln, i) => {
    const d = document.createElement("div");
    d.className = "line";
    d.innerHTML = "<span>" + ln.slice(0, 9) + "</span><b>" + ln.slice(10, 31) + "</b><i>200</i>";
    d.id = "log" + i;
    s1lines.appendChild(d);
  });

  const chalRows = [
    ["scheme", "exact"],
    ["network", "near:testnet"],
    ["asset", "USDC · NEP-141"],
    ["amount", "1.000000 USDC"],
    ["payTo", "till-seller.testnet"],
    ["maxTimeoutSeconds", "60"],
  ];
  chalRows.forEach((r, i) => {
    const d = document.createElement("div");
    d.className = "ch-row";
    d.id = "chr" + i;
    d.innerHTML = "<span>" + r[0] + "</span><b>" + r[1] + "</b>";
    $("s4-rows").appendChild(d);
  });

  const txRows = [
    ["relayer", "till-relayer-dev.testnet"],
    ["payer", "till-payer-dev.testnet"],
    ["recipient", "till-seller-dev.testnet"],
    ["outcome", "SUCCESS · all receipts"],
    ["network", "near:testnet"],
    ["gas", "sponsored by Till"],
  ];
  txRows.forEach((r, i) => {
    const d = document.createElement("div");
    d.className = "tx-row";
    d.id = "txr" + i;
    d.innerHTML = "<span>" + r[0] + "</span><b>" + r[1] + "</b>";
    $("s6-rows").appendChild(d);
  });

  const ledRows = [
    ["payment_in", "near:testnet · 09:57:04", "1.000000", "USDC"],
    ["payout_out", "base · 09:57:04", "1.000000", "USDC"],
  ];
  function ledger(host, prefix) {
    ledRows.forEach((r, i) => {
      const d = document.createElement("div");
      d.className = "led-row";
      d.id = prefix + i;
      d.innerHTML =
        '<div class="k"><b>' +
        r[0] +
        "</b><span>" +
        r[1] +
        "</span></div>" +
        '<div class="amt">' +
        r[2] +
        "<i>" +
        r[3] +
        "</i></div>";
      host.appendChild(d);
    });
  }
  ledger($("s7-rows"), "s7r");
  ledger($("s8-rows"), "s8r");

  /* ---------------------------------------------------------- packet */
  const PK = [
    { t: 1.3, x: 150, y: 706, w: 190, h: 52, o: 0, k: "req", l: "GET /prices" },
    { t: 1.65, x: 330, y: 706, w: 190, h: 52, o: 1, k: "req", l: "GET /prices" },
    { t: 4.6, x: 860, y: 700, w: 190, h: 52, o: 0.9, k: "req", l: "GET /prices" },
    { t: 6.9, x: 1240, y: 600, w: 190, h: 52, o: 0.35, k: "req", l: "GET /prices" },
    { t: 10.9, x: 1240, y: 600, w: 190, h: 52, o: 0.3, k: "req", l: "GET /prices" },
    { t: 11.6, x: 1160, y: 780, w: 190, h: 52, o: 0.25, k: "req", l: "GET /prices" },
    { t: 20.6, x: 1160, y: 780, w: 190, h: 52, o: 0.15, k: "req", l: "GET /prices" },
    { t: 21.05, x: 960, y: 560, w: 74, h: 74, o: 1, k: "token", l: "" },
    { t: 21.55, x: 960, y: 616, w: 540, h: 8, o: 1, k: "bar", l: "" },
    { t: 26.3, x: 960, y: 616, w: 540, h: 8, o: 1, k: "bar", l: "" },
    { t: 26.95, x: 1510, y: 596, w: 176, h: 44, o: 1, k: "token", l: "1.00 USDC" },
    { t: 33.9, x: 1510, y: 596, w: 176, h: 44, o: 1, k: "token", l: "1.00 USDC" },
    { t: 34.55, x: 700, y: 600, w: 176, h: 44, o: 1, k: "token", l: "1.00 USDC" },
    { t: 35.2, x: 700, y: 600, w: 176, h: 44, o: 1, k: "token", l: "1.00 USDC" },
    { t: 39.9, x: 790, y: 560, w: 150, h: 44, o: 0.9, k: "token", l: "1.00 USDC" },
    { t: 40.45, x: 960, y: 470, w: 92, h: 92, o: 0, k: "token", l: "" },
    { t: 44.55, x: 960, y: 470, w: 92, h: 92, o: 0, k: "token", l: "" },
    { t: 44.9, x: 560, y: 520, w: 176, h: 44, o: 1, k: "token", l: "1.00 USDC" },
    { t: 47.9, x: 800, y: 520, w: 130, h: 44, o: 1, k: "token", l: "1.00" },
    { t: 48.7, x: 900, y: 610, w: 176, h: 44, o: 0.9, k: "token", l: "1.00 USDC" },
    { t: 50.5, x: 1300, y: 820, w: 176, h: 44, o: 0.45, k: "token", l: "1.00 USDC" },
    { t: 53.2, x: 1300, y: 820, w: 176, h: 44, o: 0.45, k: "token", l: "1.00 USDC" },
    { t: 53.55, x: 1700, y: 110, w: 160, h: 36, o: 0.6, k: "proof", l: "SETTLED" },
    { t: 62.45, x: 1700, y: 110, w: 160, h: 36, o: 0.6, k: "proof", l: "SETTLED" },
    { t: 62.75, x: 1010, y: 530, w: 176, h: 44, o: 1, k: "token", l: "1.00 USDC" },
    { t: 65.0, x: 1206, y: 450, w: 130, h: 44, o: 1, k: "token", l: "USDC" },
    { t: 66.2, x: 1590, y: 238, w: 110, h: 40, o: 1, k: "token", l: "USDC" },
    { t: 70.7, x: 1590, y: 238, w: 110, h: 40, o: 1, k: "token", l: "USDC" },
    { t: 72.95, x: 380, y: 520, w: 176, h: 36, o: 1, k: "proof", l: "MATCHED" },
    { t: 74.6, x: 1700, y: 850, w: 156, h: 36, o: 0.45, k: "alert", l: "REFUNDED" },
    { t: 82.6, x: 1700, y: 850, w: 156, h: 36, o: 0.45, k: "alert", l: "REFUNDED" },
    { t: 82.95, x: 760, y: 700, w: 120, h: 44, o: 1, k: "block", l: "403" },
    { t: 85.25, x: 760, y: 700, w: 120, h: 44, o: 0, k: "block", l: "403" },
    { t: 89.85, x: 960, y: 280, w: 96, h: 96, o: 0, k: "logo", l: "" },
    { t: 90.1, x: 960, y: 280, w: 96, h: 96, o: 1, k: "logo", l: "" },
    { t: 90.85, x: 960, y: 280, w: 96, h: 96, o: 0, k: "logo", l: "" },
  ];
  const pk = $("packet");
  let pkText = "";
  let pkSwap = -9;

  function packet(t) {
    if (t < PK[0].t || t > PK[PK.length - 1].t) {
      pk.style.opacity = "0";
      return;
    }
    let i = 0;
    while (i < PK.length - 1 && t > PK[i + 1].t) i++;
    const a = PK[i],
      b = PK[Math.min(i + 1, PK.length - 1)];
    const k = b.t > a.t ? eio((t - a.t) / (b.t - a.t)) : 0;
    const w = lerp(a.w, b.w, k),
      h = lerp(a.h, b.h, k);
    const cx = lerp(a.x, b.x, k) + Math.sin(t * 1.7) * 3;
    const cy = lerp(a.y, b.y, k) + Math.cos(t * 1.3) * 2;
    const op = lerp(a.o, b.o, k);
    const kind = k < 0.5 ? a.k : b.k;
    const label = k < 0.5 ? a.l : b.l;
    const bump = (t > 21.5 ? pop(t, 21.5, 0.16) : 0) + pop(t, 40.45, 0.1) + pop(t, 85.25, 0.22);
    pk.style.width = w + "px";
    pk.style.height = h + "px";
    pk.style.left = cx - w / 2 + "px";
    pk.style.top = cy - h / 2 + "px";
    pk.style.opacity = op;
    pk.style.transform = "scale(" + (1 + bump) + ")";
    if (kind !== pk.dataset.kind) pk.dataset.kind = kind;
    if (label !== pkText) {
      pkText = label;
      pkSwap = t;
      $("pk-label").textContent = label;
    }
    $("pk-icon").textContent =
      kind === "req"
        ? "→"
        : kind === "token"
          ? "$"
          : kind === "alert"
            ? "!"
            : kind === "block"
              ? "×"
              : "✓";
    $("pk-icon").style.display = kind === "bar" || kind === "logo" ? "none" : "flex";
    $("packet").querySelector(".pk-inner").style.filter =
      "blur(" + 14 * Math.exp(-Math.max(0, t - pkSwap) * 22) + "px)";
  }

  /* ---------------------------------------------------------- scenes */
  const scEls = {};
  T.scenes.forEach((s) => {
    scEls[s.id] = $("sc-" + s.id);
  });

  function sceneVis(t, s, i) {
    const a = i === 0 ? st(t, 0, 0.7) : st(t, s.start - 0.35, s.start + 0.15);
    const b = 1 - st(t, s.end - 0.45, s.end + 0.05);
    return Math.min(a, b);
  }

  function cam(id, s, t, scale, dx, dy) {
    const el = $(id);
    const k = eio(st(t, s.start, s.end));
    // A slow parallax breathe rides on every shot: a held frame never freezes completely,
    // which is the difference between a photograph and a camera.
    const breathe = 1 + 0.006 * Math.sin(t * 0.53 + s.start * 1.7);
    const ax = 5 * Math.sin(t * 0.29 + s.start);
    const ay = 4 * Math.cos(t * 0.23 + s.start * 0.5);
    el.style.transform =
      "translate(" +
      (dx * k + ax).toFixed(1) +
      "px," +
      (dy * k + ay).toFixed(1) +
      "px) scale(" +
      (scale * breathe).toFixed(4) +
      ")";
  }

  function hook(t, s) {
    const lt = t - s.start;
    $("h-eye").style.opacity = st(lt, 0.5, 1.2);
    const hk = eo(st(lt, 0.7, 1.9));
    $("h-title").style.opacity = hk;
    $("h-title").style.transform = "translateY(" + (1 - hk) * 34 + "px)";
    $("h-title").style.filter = "blur(" + (1 - hk) * 8 + "px)";
    document.querySelectorAll("#h-words .word").forEach((w) => {
      const c = s.cues[w.dataset.cue] - 0.08;
      const k = eo(st(t, c, c + 0.45));
      w.style.opacity = k;
      w.style.transform = "translateY(" + (1 - k) * 18 + "px)";
    });
    const ak = st(t, 2.1, 3.4);
    $("h-agents").style.opacity = ak * 0.9;
    $("ag1").style.transform =
      "translate(" + Math.sin(t * 0.9) * 16 + "px," + Math.cos(t * 1.1) * 10 + "px)";
    $("ag2").style.transform =
      "translate(" + Math.sin(t * 0.7 + 2) * 12 + "px," + Math.cos(t * 0.8 + 1) * 8 + "px)";
    $("ag1").style.opacity = st(t, 2.2, 3.0);
    $("ag2").style.opacity = st(t, 3.0, 3.8) * 0.9;
    for (let i = 0; i < 6; i++) {
      const k = eo(st(t, 2.4 + i * 0.32, 3.1 + i * 0.32));
      const e = $("ep" + i);
      e.style.opacity = 0.25 + 0.75 * k;
      e.style.transform = "translateY(" + (1 - k) * 26 + "px)";
    }
    const ck = eo(st(t, s.cues.card - 0.05, s.cues.card + 0.5));
    $("ghost-card").style.opacity = ck * 0.95;
    $("ghost-card").style.transform =
      "rotate(-7deg) translate(" + (1 - ck) * 30 + "px," + (1 - ck) * 10 + "px)";
    const ik = eo(st(t, s.cues.invoice - 0.05, s.cues.invoice + 0.5));
    $("ghost-invoice").style.opacity = ik * 0.9;
    $("ghost-invoice").style.transform = "translate(" + (1 - ik) * 26 + "px,0)";
    cam("cam-hook", s, t, 1 + 0.025 * st(t, s.start, s.end), 0, 0);
  }

  function problem(t, s) {
    const lt = t - s.start;
    const k = eo(st(lt, 0.15, 1.0));
    $("s1-card").style.opacity = k;
    $("s1-card").style.transform = "translateY(" + (1 - k) * 22 + "px)";
    $("s1-server").style.opacity = st(lt, 0.6, 1.4);
    const count = Math.round(48213 * eo(st(t, s.vo_start + 0.15, s.vo_start + 3.2)));
    $("s1-req").textContent = count.toLocaleString("en-US");
    $("s1-line").style.strokeDashoffset = 1 - eo(st(t, s.vo_start + 0.4, s.vo_start + 3.4));
    for (let i = 0; i < 6; i++) {
      const kk = eo(st(t, s.vo_start + 0.7 + i * 0.22, s.vo_start + 1.1 + i * 0.22));
      const n = $("log" + i);
      n.style.opacity = kk * 0.85;
      n.style.transform = "translateX(" + (1 - kk) * 12 + "px)";
    }
    const tags = [
      ["free", s.cues.free],
      ["charge", s.cues.charge],
      ["prove", s.cues.prove],
    ];
    tags.forEach((tg) => {
      const el = document.querySelector('.s1-tag[data-tag="' + tg[0] + '"]');
      const kk = spring(st(t, tg[1] - 0.1, tg[1] + 0.55));
      el.style.opacity = clamp(kk);
      el.style.transform = "translateX(" + (1 - kk) * -26 + "px)";
    });
    cam("cam-problem", s, t, 1.01 + 0.045 * st(t, s.start, s.end), 0, -8);
  }

  function reveal(t, s) {
    const lt = t - s.start;
    const hit = s.cues.till;
    const split = spring(st(t, hit + 0.05, hit + 0.95));
    $("gate2-l").style.transform = "translateX(" + -190 * split + "px)";
    $("gate2-r").style.transform = "translateX(" + 190 * split + "px)";
    $("gate2").style.opacity = 1 - st(t, hit + 1.1, hit + 1.8);
    const wk = eo(st(t, hit + 0.15, hit + 1.25));
    $("s2-word").style.opacity = wk;
    $("s2-word").style.transform = "scale(" + (0.94 + 0.06 * wk) + ")";
    $("s2-word").style.filter = "blur(" + (1 - wk) * 16 + "px)";
    $("brandmark-big").style.opacity = st(t, hit + 0.9, hit + 1.5);
    $("s2-tagline").style.opacity = st(t, hit + 1.15, hit + 1.9);
    $("s2-tagline").style.transform =
      "translateY(" + (1 - st(t, hit + 1.15, hit + 1.9)) * 16 + "px)";
    $("s2-chips").style.opacity = 0.35 + 0.65 * st(t, s.cues.near - 0.1, s.cues.near + 0.6);
    $("glow").style.opacity = Math.max(0, 0.55 * Math.exp(-(t - hit) * 2.2));
    cam("cam-reveal", s, t, 1.075 - 0.075 * eo(st(t, s.start, s.start + 3.4)), 0, 0);
  }

  const url = "api.yourshop.com/prices";
  function setup(t, s) {
    const lt = t - s.start;
    const typeK = eo(st(t, s.cues.point + 0.15, s.cues.point + 2.2));
    const shown = Math.floor(typeK * url.length);
    $("s3-url").textContent = url.slice(0, shown);
    $("s3-caret").style.opacity = shown < url.length ? 1 : Math.sin(t * 9) > 0 ? 1 : 0;
    const pk = eo(st(t, s.cues.price + 0.05, s.cues.price + 0.5));
    $("s3-price").style.opacity = 0.25 + 0.75 * pk;
    $("s3-price").style.color = pk > 0.5 ? "#c9ff57" : "#f5f3ec";
    const on = spring(st(t, s.cues.switch, s.cues.switch + 0.55));
    $("s3-knob").style.transform = "translateX(" + 36 * on + "px)";
    $("s3-knob").style.background = on > 0.5 ? "#07080a" : "#e9e6dd";
    $("s3-track").style.opacity = clamp(on);
    $("s3-status-text").textContent = on > 0.5 ? "LIVE · 402 ENFORCED" : "PAYWALL OFF";
    $("s3-status-text").style.color = on > 0.5 ? "#c9ff57" : "#5b6169";
    $("s3-led").style.background = on > 0.5 ? "#c9ff57" : "#5b6169";
    $("s3-led").style.boxShadow = on > 0.5 ? "0 0 10px rgba(201,255,87,.8)" : "none";
    document.querySelectorAll(".step").forEach((el) => {
      const c = s.cues[el.dataset.step];
      const k = st(t, c - 0.2, c + 0.4);
      el.style.opacity = 0.34 + 0.66 * k;
      el.style.transform = "translateX(" + (1 - k) * -10 + "px)";
    });
    const ck = spring(st(t, s.cues.switch - 1.35, s.cues.switch));
    $("s3-cursor").style.transform =
      "translate(" + -105 * (1 - ck) + "px," + -100 * (1 - ck) + "px)";
    $("s3-cursor").style.opacity = st(t, s.cues.switch - 1.6, s.cues.switch - 1.1);
    const rp = st(t, s.cues.switch, s.cues.switch + 0.6);
    $("s3-ripple").style.opacity = rp > 0 && rp < 1 ? (1 - rp) * 0.8 : 0;
    $("s3-ripple").style.transform = "scale(" + (0.6 + rp * 4) + ")";
    cam("cam-setup", s, t, 1.005 + 0.03 * st(t, s.start, s.end), 0, 0);
  }

  function challenge(t, s) {
    const gate = $("s4-gate");
    const reqK = eio(st(t, s.cues.request + 0.2, s.cues.paying));
    $("s4-req").style.transform = "translate(" + reqK * 500 + "px,0)";
    $("s4-req").style.opacity =
      t > s.cues.paying + 0.1 ? 0 : st(t, s.cues.request, s.cues.request + 0.4);
    const hit = s.cues.four;
    const gk = eo(st(t, s.cues.paying, hit));
    gate.style.filter = "brightness(" + (1 + 0.9 * gk) + ")";
    gate.style.transform =
      "scale(" +
      (1 + 0.02 * Math.sin((t - s.cues.paying) * 22)) +
      ")" +
      (t > hit ? " translateY(6px)" : "");
    // The gate keeps working while the payer decides: the scan sweeps and the ring breathes.
    const scan = gate.querySelector(".gate-scan");
    if (scan) scan.style.top = 24 + 52 * (0.5 + 0.5 * Math.sin(t * 0.8)) + "%";
    const core = gate.querySelector(".gate-core");
    if (core) core.style.transform = "scale(" + (1 + 0.07 * Math.sin(t * 2.1)) + ")";
    $("s4-agent").style.transform =
      "translate(" + Math.sin(t * 0.7) * 7 + "px," + (Math.cos(t * 0.9) * 5 - 4) + "px)";
    const bk = eo(st(t, hit, hit + 0.45));
    $("big402").style.opacity = bk * (0.9 + 0.06 * Math.sin(t * 1.1));
    $("big402").style.transform =
      "scale(" + (1.25 - 0.25 * bk) * (1 + 0.012 * Math.sin(t * 0.7)) + ")";
    $("big402").style.filter = "blur(" + (1 - bk) * 18 + "px)";
    const ck = eo(st(t, s.cues.required - 0.55, s.cues.required + 0.15));
    const card = $("s4-card");
    card.style.opacity = ck;
    card.style.transform = "translateY(" + (1 - ck) * 26 + "px) scale(" + (0.96 + 0.04 * ck) + ")";
    card.style.filter = "blur(" + (1 - ck) * 10 + "px)";
    for (let i = 0; i < 6; i++) {
      const kk = eo(st(t, s.cues.required - 0.35 + i * 0.11, s.cues.required + 0.1 + i * 0.11));
      const el = $("chr" + i);
      el.style.opacity = kk;
      el.style.transform = "translateX(" + (1 - kk) * 14 + "px)";
    }
    $("s4-note").style.opacity = st(t, s.cues.required + 0.2, s.cues.required + 0.8) * 0.9;
    cam("cam-challenge", s, t, 1 + 0.04 * st(t, s.start, s.end), -30 * st(t, s.start, s.end), 0);
  }

  function paid(t, s) {
    const sigK = eo(st(t, s.cues.signs, s.cues.verifies));
    $("s5-sig").style.strokeDashoffset = 1 - sigK;
    $("s5-gas").style.opacity = st(t, s.cues.gasless - 0.1, s.cues.gasless + 0.5);
    $("s5-gas").style.transform =
      "translateY(" + (1 - st(t, s.cues.gasless - 0.1, s.cues.gasless + 0.5)) * 10 + "px)";
    const ok = eo(st(t, s.cues.verifies + 0.1, s.cues.verifies + 0.5));
    $("s5-result").style.opacity = ok;
    $("s5-result").style.transform = "scale(" + (0.9 + 0.1 * spring(ok)) + ")";
    $("s5-stamp").style.transform = "scale(" + (1 + pop(t, s.cues.verifies + 0.15, 0.18)) + ")";
    const dk = eo(st(t, s.cues.serves, s.cues.serves + 0.5));
    $("s5-data").style.opacity = dk;
    $("s5-data").style.transform = "translateY(" + (1 - dk) * 18 + "px)";
    const rk = eo(st(t, s.cues.settles, s.cues.settles + 0.5));
    $("s5-receipt").style.opacity = rk;
    $("s5-receipt").style.transform = "translateY(" + (1 - rk) * 12 + "px)";
    const open = spring(st(t, s.cues.verifies + 0.05, s.cues.verifies + 0.7));
    $("s5-gl").style.transform = "translateX(" + -95 * open + "px)";
    $("s5-gr").style.transform = "translateX(" + 95 * open + "px)";
    cam("cam-paid", s, t, 1.01, -55 * st(t, s.start, s.end), 0);
  }

  function proof(t, s) {
    const k = eo(st(t, s.start + 0.15, s.start + 0.9));
    $("s6-card").style.opacity = k;
    $("s6-card").style.transform = "translateY(" + (1 - k) * 22 + "px)";
    const hk = eo(st(t, s.cues.real, s.cues.real + 0.7));
    $("s6-hash").style.letterSpacing = 0.12 - 0.12 * hk + "em";
    $("s6-hash").style.color = hk > 0.6 ? "#c9ff57" : "#f5f3ec";
    for (let i = 0; i < 6; i++) {
      const kk = eo(st(t, s.cues.real + 0.25 + i * 0.13, s.cues.real + 0.7 + i * 0.13));
      const el = $("txr" + i);
      el.style.opacity = kk;
      el.style.transform = "translateY(" + (1 - kk) * 8 + "px)";
    }
    $("s6-foot").style.opacity = st(t, s.cues.receipt - 0.2, s.cues.receipt + 0.5) * 0.95;
    $("s6-live").style.opacity = 0.6 + 0.4 * Math.abs(Math.sin(t * 2.2));
    cam("cam-proof", s, t, 1.015 + 0.03 * st(t, s.start, s.end), 0, -10);
  }

  function payout(t, s) {
    const k = eo(st(t, s.start + 0.1, s.start + 0.9));
    $("s7-ledger").style.opacity = k;
    $("s7-route").style.opacity = st(t, s.start + 0.35, s.start + 1.1);
    ["s7r0", "s7r1"].forEach((id, i) => {
      const kk = eo(st(t, s.start + 0.25 + i * 0.25, s.start + 0.8 + i * 0.25));
      const el = $(id);
      el.style.opacity = kk;
      el.style.transform = "translateY(" + (1 - kk) * 10 + "px)";
    });
    const dk = eo(st(t, s.cues.intents, s.cues.intents + 0.9));
    $("s7-path").style.strokeDashoffset = 1 - dk;
    $("ch-base").classList.toggle("on", t > s.cues.chain - 0.1);
    ["ch-eth", "ch-sol"].forEach((id, i) => {
      const kk = st(t, s.cues.chain + 0.15 + i * 0.1, s.cues.chain + 0.5 + i * 0.1);
      $(id).style.opacity = 0.35 + 0.4 * kk;
    });
    const mk = eo(st(t, s.cues.hash - 0.25, s.cues.hash + 0.35));
    $("s7-bracket").style.opacity = mk;
    $("s7-bracket").style.transform = "scaleY(" + (0.4 + 0.6 * mk) + ")";
    $("s7-match").style.opacity = mk;
    $("s7-match").style.transform = "translateY(" + (1 - mk) * 8 + "px)";
    if (t > s.cues.hash + 0.1) {
      $("s7r0").style.borderColor = "rgba(201,255,87,0.25)";
      $("s7r1").style.borderColor = "rgba(201,255,87,0.25)";
    }
    // The route keeps carrying money: the dashed legs run outward for the whole scene.
    const flow = (t * 26) % 11;
    ["s7-flow0", "s7-flow1", "s7-flow2"].forEach((id2, i) => {
      const e = $(id2);
      if (e) e.style.strokeDashoffset = (-(flow + i * 2.4)).toFixed(2);
    });
    $("s7-foot").style.opacity = st(t, s.cues.chain, s.cues.chain + 0.8) * 0.85;
    cam("cam-payout", s, t, 1.005 + 0.02 * st(t, s.start, s.end), -22 * st(t, s.start, s.end), 0);
  }

  function reconcile(t, s) {
    const k = eo(st(t, s.start + 0.1, s.start + 0.8));
    $("s8-ledger").style.opacity = k;
    $("s8-ledger").style.transform = "translateY(" + (1 - k) * 18 + "px)";
    const rk = st(t, s.cues.refunded - 0.1, s.cues.refunded + 0.4);
    const row = $("s8r1");
    row.style.background = "rgba(255,180,84," + 0.1 * rk + ")";
    row.style.borderColor = "rgba(255,180,84," + 0.4 * rk + ")";
    row.querySelector(".amt").style.color = rk > 0.4 ? "#ffb454" : "#f5f3ec";
    const ak = eo(st(t, s.cues.refunded, s.cues.refunded + 0.75));
    $("s8-alert").style.opacity = ak;
    $("s8-alert").style.transform =
      "translateY(" + (1 - ak) * 34 + "px) scale(" + (0.975 + 0.025 * ak) + ")";
    $("s8-alert").style.filter = "blur(" + (1 - ak) * 8 + "px)";
    const tk = eo(st(t, s.cues.english - 0.1, s.cues.english + 0.5));
    $("s8-text").style.opacity = 0.5 + 0.5 * tk;
    $("s8-act").style.opacity = st(t, s.cues.english, s.cues.english + 0.6);
    $("s8-act").style.transform =
      "translateY(" + (1 - st(t, s.cues.english, s.cues.english + 0.6)) * 12 + "px)";
    $("s8-btns").style.opacity = st(t, s.cues.next - 0.3, s.cues.next + 0.3);
    const press = st(t, s.cues.next + 0.35, s.cues.next + 0.55);
    $("s8-btn").style.transform = "scale(" + (press > 0 && press < 1 ? 0.96 : 1) + ")";
    $("s8-cursor").style.opacity = st(t, s.cues.next - 0.5, s.cues.next - 0.1);
    $("s8-cursor").style.transform =
      "translate(" +
      lerp(120, 0, eo(st(t, s.cues.next - 0.6, s.cues.next + 0.3))) +
      "px," +
      lerp(180, 0, eo(st(t, s.cues.next - 0.6, s.cues.next + 0.3))) +
      "px)";
    cam("cam-reconcile", s, t, 1.005 + 0.03 * st(t, s.start, s.end), 0, 0);
  }

  function guard(t, s) {
    const hit = s.cues.blocked;
    const pass1 = st(t, s.vo_start + 0.5, s.vo_start + 1.2);
    const pass2 = st(t, s.vo_start + 1.4, s.vo_start + 2.1);
    const r1 = $("s9-r1"),
      r2 = $("s9-r2"),
      r3 = $("s9-r3");
    r1.style.opacity = t > s.vo_start + 1.35 ? 0 : st(t, s.vo_start + 0.3, s.vo_start + 0.6);
    r1.style.transform = "translate(" + eo(pass1) * 560 + "px,0)";
    r2.style.opacity = t > s.vo_start + 2.25 ? 0 : st(t, s.vo_start + 1.2, s.vo_start + 1.5);
    r2.style.transform = "translate(" + eo(pass2) * 560 + "px,0)";
    const r3k = eio(st(t, s.vo_start + 1.95, hit));
    r3.style.opacity =
      st(t, s.vo_start + 1.9, s.vo_start + 2.15) * (1 - st(t, hit + 0.05, hit + 0.5));
    r3.style.transform = "translate(" + r3k * 452 + "px,0)";
    const s1k = spring(st(t, s.vo_start + 1.15, s.vo_start + 1.6));
    const s2k = spring(st(t, s.vo_start + 2.05, s.vo_start + 2.5));
    document.querySelectorAll(".strike").forEach((el, i) => {
      const kk = i === 2 ? st(t, hit + 0.15, hit + 0.55) : i === 0 ? s1k : s2k;
      el.style.opacity = clamp(kk);
      el.style.transform = "translateX(" + (1 - kk) * -22 + "px)";
    });
    const wall = $("s9-wall");
    const wallHit = spring(st(t, hit - 0.05, hit + 0.3));
    wall.style.transform = "scaleX(" + (1 + 2.2 * spring(st(t, hit - 0.35, hit - 0.02))) + ")";
    wall.style.boxShadow = kkGlow(t, hit);
    $("s9-wall-glow").style.opacity = t > hit - 0.1 ? 0.9 * Math.exp(-(t - hit) * 2.4) : 0;
    const bk = eo(st(t, hit, hit + 0.35));
    $("s9-block").style.opacity = bk;
    $("s9-block").style.transform = "translateX(" + (1 - bk) * 34 + "px)";
    $("s9-gas").style.opacity = st(t, s.cues.gas - 0.2, s.cues.gas + 0.35);
    const shake = t > hit && t < hit + 0.5 ? (1 - (t - hit) / 0.5) * 9 : 0;
    cam("cam-guard", s, t, 1.01, Math.sin(t * 120) * shake, Math.cos(t * 140) * shake * 0.6);
  }
  function kkGlow(t, hit) {
    return t > hit ? "0 0 " + 70 * Math.exp(-(t - hit) * 2) + "px rgba(255,111,97,.55)" : "none";
  }

  function close(t, s) {
    const mk = spring(st(t, s.cues.till, s.cues.till + 0.8));
    $("end-mark").style.opacity = clamp(mk);
    $("end-mark").style.transform =
      "scale(" + (0.4 + 0.6 * mk) + ") rotate(" + (1 - mk) * -20 + "deg)";
    const wk = eo(st(t, s.cues.till + 0.25, s.cues.till + 1.2));
    $("end-word").style.opacity = wk;
    $("end-word").style.letterSpacing = 0.5 - 0.28 * wk + "em";
    $("end-word").style.textIndent = 0.5 - 0.28 * wk + "em";
    $("end-word").style.filter = "blur(" + (1 - wk) * 12 + "px)";
    const l1 = eo(st(t, s.cues.charge, s.cues.charge + 0.6));
    const l2 = eo(st(t, s.cues.prove, s.cues.prove + 0.6));
    $("end-l1").style.opacity = l1;
    $("end-l1").style.transform = "translateY(" + (1 - l1) * 16 + "px)";
    $("end-l2").style.opacity = l2;
    $("end-l2").style.transform = "translateY(" + (1 - l2) * 16 + "px)";
    $("end-c1").style.opacity = st(t, s.cues.money - 0.1, s.cues.money + 0.4);
    $("end-c2").style.opacity = st(t, s.cues.money + 0.05, s.cues.money + 0.55);
    $("end-c3").style.opacity = st(t, s.cues.hackathon, s.cues.hackathon + 0.5);
    // The end card still drifts: a static last shot reads as a freeze-frame.
    ["end-c1", "end-c2", "end-c3"].forEach((id2, i) => {
      $(id2).style.transform =
        "translateY(" + (Math.sin(t * 0.62 + i * 1.2) * 3).toFixed(2) + "px)";
    });
    $("end-tech").style.opacity = st(t, s.cues.hackathon + 0.1, s.cues.hackathon + 0.7) * 0.9;
    $("end-url").style.opacity = st(t, s.cues.hackathon + 0.25, s.cues.hackathon + 0.9);
    cam("cam-close", s, t, 1.005 + 0.03 * st(t, s.start, s.end), 0, 0);
  }

  const runners = {
    hook: hook,
    problem: problem,
    reveal: reveal,
    setup: setup,
    challenge: challenge,
    paid: paid,
    proof: proof,
    payout: payout,
    reconcile: reconcile,
    guard: guard,
    close: close,
  };

  /* ---------------------------------------------------------- caption */
  let capText = "";
  function caption(t) {
    let chunk = null;
    for (const s of T.scenes) {
      for (const c of s.captions) {
        if (t >= c.start - 0.08 && t <= c.end + 0.12) {
          chunk = c;
          break;
        }
      }
      if (chunk) break;
    }
    const el = $("caption");
    if (!chunk) {
      el.style.opacity = 0;
      return;
    }
    if (chunk.text !== capText) {
      capText = chunk.text;
      $("cap-text").textContent = chunk.text;
    }
    const fi = st(t, chunk.start - 0.08, chunk.start + 0.14);
    const fo = 1 - st(t, chunk.end - 0.02, chunk.end + 0.12);
    el.style.opacity = Math.min(fi, fo);
    el.style.transform = "translateY(" + (1 - fi) * 6 + "px)";
  }

  /* ---------------------------------------------------------- master */
  function seek(t) {
    t = Math.max(0, Math.min(D, t));
    T.scenes.forEach((s, i) => {
      const v = sceneVis(t, s, i);
      const el = scEls[s.id];
      el.style.visibility = v < 0.003 ? "hidden" : "visible";
      el.style.opacity = v;
      el.style.filter = "blur(" + ((1 - v) * 9).toFixed(2) + "px)";
      el.style.transform = "translateY(" + ((1 - v) * 18).toFixed(1) + "px)";
    });
    $("glow").style.opacity = Math.max(0, 0.5 * Math.exp(-Math.abs(t - S.reveal.cues.till) * 1.8));
    for (const s of T.scenes) {
      if (t >= s.start - 0.02 && t <= s.end + 0.02) {
        runners[s.id](t, s);
        break;
      }
    }
    packet(t);
    caption(t);
    $("bar").style.width = ((100 * t) / D).toFixed(2) + "%";
    const tb = $("topbar");
    tb.style.opacity = t < 0.5 ? 0 : t > 90 ? Math.max(0.25, 1 - (t - 90) / 3) : 1;
  }

  document.fonts.ready.then(() => {
    seek(0);
    window.__seek = seek;
    window.__duration = D;
    window.__ready = true;
    const q = new URLSearchParams(location.search);
    if (q.get("t")) seek(Number.parseFloat(q.get("t")));
  });
})();
