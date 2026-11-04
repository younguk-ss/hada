// PowerPoint(.pptx) → 슬라이드 그림(캔버스). 서버 없이 브라우저에서 직접 그린다 — storage.fileToSlides 가 PDF 쪽처럼 장마다 올린다.
// 가정: 압축 풀기는 fflate(jsDelivr ESM), XML 은 DOMParser. DrawingML 중 수업 자료에 흔한 것만 그린다:
//       배경(단색·그라데이션·그림), 그림(자르기·투명도), 도형(사각·둥근 사각·원·삼각형·화살표 등 + 자유형), 선·연결선(화살촉),
//       글자(크기·굵게·기울임·밑줄·취소선·위첨자·색·글꼴, 정렬·줄 간격·문단 간격·글머리·번호, 자동 맞춤·세로 맞춤·여백),
//       표(파일에 든 표 스타일), 그룹, SmartArt(파일에 저장된 그림 모양).
//       차트는 옅은 '차트' 상자, 동영상은 표지 그림만. 그림자·3D·애니메이션·EMF/WMF 그림은 그리지 않는다.
// 가정: 개체 틀(placeholder)은 레이아웃 → 마스터 순으로 위치·글자 모양을 물려받는다(idx 먼저, 없으면 종류로 찾음).
//       마스터·레이아웃의 개체 틀 자체(안내 글)는 그리지 않는다. 숨긴 슬라이드는 건너뛴다(PowerPoint PDF 저장과 같게).
// 가정: 글꼴은 PowerPoint 지정 글꼴 → 동아시아 글꼴 → Pretendard 순. 없는 글꼴이면 줄바꿈이 조금 다를 수 있다.
//       한글은 어절(띄어쓰기) 단위로 줄을 바꾸고, 한 어절이 칸보다 길면 글자 단위로 자른다.
const FFLATE = "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";
const FALLBACK = '"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
const LVL = ["lvl1pPr", "lvl2pPr", "lvl3pPr", "lvl4pPr", "lvl5pPr", "lvl6pPr", "lvl7pPr", "lvl8pPr", "lvl9pPr"];
const COLOR_TAGS = new Set(["srgbClr", "schemeClr", "sysClr", "prstClr", "scrgbClr", "hslClr"]);
const FILL_TAGS = new Set(["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"]);
const PRST_COLORS = { black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", gray: "808080", grey: "808080", orange: "FFA500", purple: "800080" };

let fflateP = null;
const loadFflate = () => (fflateP ||= import(FFLATE).catch(e => { fflateP = null; throw e; }));

// ── XML 도우미(이름공간은 무시하고 localName 으로) ──
const dec = new TextDecoder();
function parseXml(bytes) {
  const d = new DOMParser().parseFromString(dec.decode(bytes), "application/xml");
  return d.getElementsByTagName("parsererror").length ? null : d;
}
function ch(n, name) {
  if (!n) return null;
  for (let c = n.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) return c;
  return null;
}
function chs(n, name) {
  const out = [];
  if (!n) return out;
  for (let c = n.firstElementChild; c; c = c.nextElementSibling) if (!name || c.localName === name) out.push(c);
  return out;
}
function q(n, ...names) { for (const nm of names) { n = ch(n, nm); if (!n) return null; } return n; }
const attr = (n, a) => (n ? n.getAttribute(a) : null);
const num = (v, d = 0) => { if (v == null || v === "") return d; const x = Number(v); return Number.isFinite(x) ? x : d; };
const on = v => v === "1" || v === "true" || v === "on";
// 노드 목록에서 처음으로 값이 있는 속성
function first(nodes, a) { for (const n of nodes) { const v = attr(n, a); if (v != null) return v; } return null; }
function firstCh(nodes, name) { for (const n of nodes) { const c = ch(n, name); if (c) return c; } return null; }

// ── 패키지(zip 안 파일·관계·그림) ──
function joinPath(base, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (base + target).split("/");
  const out = [];
  for (const p of parts) { if (p === "..") out.pop(); else if (p !== "." && p !== "") out.push(p); }
  return out.join("/");
}
const dirOf = p => p.replace(/[^/]*$/, "");
class Pkg {
  constructor(files) { this.files = files; this.xmls = new Map(); this.relMap = new Map(); this.imgs = new Map(); }
  xml(path) {
    if (!path) return null;
    if (!this.xmls.has(path)) { const b = this.files[path]; this.xmls.set(path, b ? parseXml(b) : null); }
    return this.xmls.get(path);
  }
  // 관계 → Map(id → 전체 경로)
  rels(path) {
    if (!this.relMap.has(path)) {
      const m = new Map();
      const doc = this.xml(path.replace(/([^/]*)$/, "_rels/$1.rels"));
      for (const r of doc ? chs(doc.documentElement, "Relationship") : []) {
        if (attr(r, "TargetMode") === "External") continue;
        let t = attr(r, "Target") || "";
        try { t = decodeURIComponent(t); } catch (_) { /* 그대로 */ }
        m.set(attr(r, "Id"), { path: joinPath(dirOf(path), t), type: attr(r, "Type") || "" });
      }
      this.relMap.set(path, m);
    }
    return this.relMap.get(path);
  }
  relOfType(path, re) { for (const v of this.rels(path).values()) if (re.test(v.type)) return v.path; return null; }
  // 그림 → ImageBitmap | HTMLImageElement | null(못 읽는 형식: emf·wmf·tiff …)
  image(path) {
    if (!path) return Promise.resolve(null);
    if (!this.imgs.has(path)) this.imgs.set(path, decodeImage(path, this.files[path]));
    return this.imgs.get(path);
  }
  close() { for (const p of this.imgs.values()) p.then(b => b?.close?.()).catch(() => {}); this.imgs.clear(); }
}
async function decodeImage(path, bytes) {
  if (!bytes) return null;
  const ext = (path.split(".").pop() || "").toLowerCase();
  const type = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml" }[ext];
  if (!type) return null;
  const blob = new Blob([bytes], { type });
  if (type !== "image/svg+xml" && typeof createImageBitmap === "function") {
    try { return await createImageBitmap(blob); } catch (_) { /* 아래 <img> */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch (_) { return null; } finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
}

// ── 테마 ──
function readTheme(doc) {
  const te = doc ? q(doc.documentElement, "themeElements") : null;
  const colors = {};
  for (const c of chs(ch(te, "clrScheme"))) {
    const v = ch(c, "srgbClr") ? attr(ch(c, "srgbClr"), "val") : ch(c, "sysClr") ? (attr(ch(c, "sysClr"), "lastClr") || "000000") : null;
    if (v) colors[c.localName] = v;
  }
  const fontOf = f => {
    const hang = chs(f, "font").find(x => attr(x, "script") === "Hang");
    return { latin: attr(ch(f, "latin"), "typeface") || "", ea: attr(ch(f, "ea"), "typeface") || attr(hang, "typeface") || "" };
  };
  const fs = ch(te, "fontScheme"), fmt = ch(te, "fmtScheme");
  return {
    colors,
    major: fontOf(ch(fs, "majorFont")), minor: fontOf(ch(fs, "minorFont")),
    fills: chs(ch(fmt, "fillStyleLst")), lines: chs(ch(fmt, "lnStyleLst")), bgFills: chs(ch(fmt, "bgFillStyleLst")),
  };
}

// ── 색 ──
function hexRgb(h) {
  const v = parseInt(String(h || "000000").slice(0, 6), 16) || 0;
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 1 };
}
function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return { h: 0, s: 0, l };
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h / 6, s, l };
}
function hslToRgb({ h, s, l }) {
  if (!s) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const f = (p, q2, t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q2 - p) * 6 * t : t < 1 / 2 ? q2 : t < 2 / 3 ? p + (q2 - p) * (2 / 3 - t) * 6 : p; };
  const q2 = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q2;
  return { r: Math.round(f(p, q2, h + 1 / 3) * 255), g: Math.round(f(p, q2, h) * 255), b: Math.round(f(p, q2, h - 1 / 3) * 255) };
}
const clamp01 = v => Math.max(0, Math.min(1, v));
// node = 색 요소 자체이거나 색 요소를 자식으로 가진 요소. phClr = 스타일 참조 색
function colorOf(node, cx, phClr = null) {
  if (!node) return null;
  const c = COLOR_TAGS.has(node.localName) ? node : chs(node).find(x => COLOR_TAGS.has(x.localName));
  if (!c) return null;
  let col;
  const val = attr(c, "val");
  switch (c.localName) {
    case "srgbClr": col = hexRgb(val); break;
    case "sysClr": col = hexRgb(attr(c, "lastClr") || (val === "window" ? "FFFFFF" : "000000")); break;
    case "prstClr": col = hexRgb(PRST_COLORS[val] || "000000"); break;
    case "scrgbClr": col = { r: Math.round(num(attr(c, "r")) / 1000 * 2.55), g: Math.round(num(attr(c, "g")) / 1000 * 2.55), b: Math.round(num(attr(c, "b")) / 1000 * 2.55), a: 1 }; break;
    case "hslClr": col = { ...hslToRgb({ h: num(attr(c, "hue")) / 21600000, s: num(attr(c, "sat")) / 100000, l: num(attr(c, "lum")) / 100000 }), a: 1 }; break;
    case "schemeClr": {
      if (val === "phClr") { col = phClr ? { ...phClr } : hexRgb("000000"); break; }
      const name = cx.clrMap[val] || val;
      col = hexRgb(cx.theme.colors[name] || (name === "lt1" || name === "bg1" ? "FFFFFF" : "000000"));
      break;
    }
    default: return null;
  }
  for (const m of chs(c)) {
    const v = num(attr(m, "val")) / 100000;
    switch (m.localName) {
      case "alpha": col.a = clamp01(v); break;
      case "alphaMod": col.a = clamp01(col.a * v); break;
      case "lumMod": case "lumOff": case "satMod": case "satOff": case "hueOff": case "hueMod": {
        const h = rgbToHsl(col);
        if (m.localName === "lumMod") h.l = clamp01(h.l * v);
        else if (m.localName === "lumOff") h.l = clamp01(h.l + v);
        else if (m.localName === "satMod") h.s = clamp01(h.s * v);
        else if (m.localName === "satOff") h.s = clamp01(h.s + v);
        else if (m.localName === "hueOff") h.h = (h.h + num(attr(m, "val")) / 21600000 + 1) % 1;
        else h.h = (h.h * v) % 1;
        Object.assign(col, hslToRgb(h));
        break;
      }
      case "tint": for (const k of ["r", "g", "b"]) col[k] = Math.round(col[k] * v + 255 * (1 - v)); break;
      case "shade": for (const k of ["r", "g", "b"]) col[k] = Math.round(col[k] * v); break;
      case "inv": for (const k of ["r", "g", "b"]) col[k] = 255 - col[k]; break;
      case "gray": { const y = Math.round(col.r * 0.3 + col.g * 0.59 + col.b * 0.11); col.r = col.g = col.b = y; break; }
      default: break;
    }
  }
  return col;
}
const css = c => (c ? `rgba(${c.r},${c.g},${c.b},${c.a ?? 1})` : null);

// ── 채우기·선 ──
// 채우기 요소 하나 → { kind: none | solid | grad | img | grp } | null
function fillFrom(n, cx, phClr) {
  if (!n) return null;
  switch (n.localName) {
    case "noFill": return { kind: "none" };
    case "solidFill": { const c = colorOf(n, cx, phClr); return c ? { kind: "solid", color: c } : null; }
    case "pattFill": { const c = colorOf(ch(n, "fgClr"), cx, phClr); return c ? { kind: "solid", color: c } : null; }
    case "gradFill": {
      const stops = chs(ch(n, "gsLst"), "gs").map(gs => ({ pos: num(attr(gs, "pos")) / 100000, color: colorOf(gs, cx, phClr) })).filter(s => s.color).sort((a, b) => a.pos - b.pos);
      if (!stops.length) return null;
      const lin = ch(n, "lin");
      return { kind: "grad", stops, ang: lin ? num(attr(lin, "ang")) / 60000 : 90, radial: !lin && !!ch(n, "path") };
    }
    case "blipFill": return { kind: "img", blip: ch(n, "blip"), src: ch(n, "srcRect"), tile: ch(n, "tile"), part: cx.part, ph: phClr };
    case "grpFill": return cx.grpFill || null;
    default: return null;
  }
}
function fillOf(spPr, cx, phClr = null) {
  if (!spPr) return null;
  for (const c of chs(spPr)) if (FILL_TAGS.has(c.localName)) return fillFrom(c, cx, phClr);
  return null;
}
// 스타일 참조(p:style fillRef idx) → 테마 채우기
function refFill(ref, cx) {
  if (!ref) return null;
  const idx = num(attr(ref, "idx"));
  if (!idx) return null;
  const ph = colorOf(ref, cx);
  const list = idx >= 1001 ? cx.theme.bgFills : cx.theme.fills;
  const n = list[(idx >= 1001 ? idx - 1001 : idx - 1)] || list[list.length - 1];
  const f = n ? fillFrom(n, cx, ph) : (ph ? { kind: "solid", color: ph } : null);
  if (f && f.kind === "img") f.part = cx.themePath; // 테마 채우기의 그림은 테마 파일 기준
  return f;
}
// a:ln → { color, w(EMU), dash, head, tail } | { none: true } | null
function lineFrom(ln, cx, phClr = null, base = null) {
  if (!ln) return base;
  const out = base && !base.none ? { ...base } : { color: null, w: 12700, dash: null, head: null, tail: null };
  if (attr(ln, "w") != null) out.w = num(attr(ln, "w"));
  if (ch(ln, "noFill")) return { none: true };
  const sf = ch(ln, "solidFill") || ch(ln, "gradFill");
  if (sf) {
    const c = sf.localName === "gradFill" ? colorOf(q(sf, "gsLst", "gs"), cx, phClr) : colorOf(sf, cx, phClr);
    if (c) out.color = c;
  }
  const dash = attr(ch(ln, "prstDash"), "val");
  if (dash) out.dash = dash;
  const he = ch(ln, "headEnd"), te = ch(ln, "tailEnd");
  if (he && attr(he, "type") && attr(he, "type") !== "none") out.head = { type: attr(he, "type"), w: attr(he, "w"), len: attr(he, "len") };
  if (te && attr(te, "type") && attr(te, "type") !== "none") out.tail = { type: attr(te, "type"), w: attr(te, "w"), len: attr(te, "len") };
  return out.color || base ? out : (out.head || out.tail ? { ...out, color: { r: 0, g: 0, b: 0, a: 1 } } : out);
}
function refLine(ref, cx) {
  if (!ref) return null;
  const idx = num(attr(ref, "idx"));
  if (!idx) return null;
  const ph = colorOf(ref, cx);
  const n = cx.theme.lines[idx - 1];
  const l = lineFrom(n, cx, ph, null) || { w: 12700 };
  if (!l.none && !l.color) l.color = ph;
  return l;
}

function paint(g, fill, w, h, cx) {
  if (!fill || fill.kind === "none") return;
  if (fill.kind === "solid") { g.fillStyle = css(fill.color); g.fill(); return; }
  if (fill.kind === "grad") {
    let gr;
    if (fill.radial) gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
    else {
      const a = (fill.ang * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      const L = (Math.abs(w * c) + Math.abs(h * s)) / 2;
      gr = g.createLinearGradient(w / 2 - L * c, h / 2 - L * s, w / 2 + L * c, h / 2 + L * s);
    }
    for (const st of fill.stops) gr.addColorStop(clamp01(st.pos), css(st.color));
    g.fillStyle = gr;
    g.fill();
    return;
  }
  if (fill.kind === "img" && fill.bmp) {
    g.save();
    g.clip();
    if (fill.tile) {
      // 바둑판 채우기: 그림 원래 크기(96dpi) × 배율
      const sx = num(attr(fill.tile, "sx"), 100000) / 100000, sy = num(attr(fill.tile, "sy"), 100000) / 100000;
      const pat = g.createPattern(fill.bmp, "repeat");
      const kk = 9525 * cx.k;
      if (pat && pat.setTransform) pat.setTransform(new DOMMatrix([kk * sx, 0, 0, kk * sy, num(attr(fill.tile, "tx")) * cx.k, num(attr(fill.tile, "ty")) * cx.k]));
      g.globalAlpha *= alphaOf(fill.blip);
      g.fillStyle = pat || "#ffffff";
      g.fillRect(0, 0, w, h);
    } else drawBitmap(g, fill.bmp, fill.src, 0, 0, w, h, alphaOf(fill.blip));
    g.restore();
  }
}
function alphaOf(blip) { const a = ch(blip, "alphaModFix"); return a ? clamp01(num(attr(a, "amt"), 100000) / 100000) : 1; }
function drawBitmap(g, bmp, src, x, y, w, h, alpha = 1) {
  const iw = bmp.width || bmp.naturalWidth, ih = bmp.height || bmp.naturalHeight;
  if (!iw || !ih) return;
  const l = num(attr(src, "l")) / 100000, t = num(attr(src, "t")) / 100000, r = num(attr(src, "r")) / 100000, b = num(attr(src, "b")) / 100000;
  const sx = iw * l, sy = ih * t, sw = iw * (1 - l - r), sh = ih * (1 - t - b);
  if (sw <= 0 || sh <= 0) return;
  g.save();
  g.globalAlpha *= alpha;
  // 음수 자르기(바깥 여백)는 그 비율만큼 그림을 안쪽으로
  const cx0 = Math.max(0, sx), cy0 = Math.max(0, sy), cx1 = Math.min(iw, sx + sw), cy1 = Math.min(ih, sy + sh);
  const kx = w / sw, ky = h / sh;
  g.drawImage(bmp, cx0, cy0, cx1 - cx0, cy1 - cy0, x + (cx0 - sx) * kx, y + (cy0 - sy) * ky, (cx1 - cx0) * kx, (cy1 - cy0) * ky);
  g.restore();
}
async function loadFill(fill, cx) {
  if (fill && fill.kind === "img" && fill.blip) {
    const rel = cx.pkg.rels(fill.part).get(attr(fill.blip, "r:embed"));
    fill.bmp = rel ? await cx.pkg.image(rel.path) : null;
    if (!fill.bmp) return null;
    const duo = ch(fill.blip, "duotone");
    if (duo) fill.bmp = duotone(fill.bmp, chs(duo).map(c => colorOf(c, cx, fill.ph)).filter(Boolean));
  }
  return fill;
}
// 두 색 효과(duotone): 밝기에 따라 첫 색 → 둘째 색
function duotone(bmp, cols) {
  if (cols.length < 2) return bmp;
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  if (!w || !h) return bmp;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, w, h), px = d.data, [a, b] = cols;
  for (let i = 0; i < px.length; i += 4) {
    const t = (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) / 255;
    px[i] = a.r + (b.r - a.r) * t; px[i + 1] = a.g + (b.g - a.g) * t; px[i + 2] = a.b + (b.b - a.b) * t;
  }
  g.putImageData(d, 0, 0);
  return c;
}
function strokeLine(g, line, cx) {
  if (!line || line.none || !line.color) return;
  const w = Math.max(0.6, line.w * cx.k);
  g.lineWidth = w;
  g.strokeStyle = css(line.color);
  g.lineJoin = "round";
  const d = { dash: [4, 3], sysDash: [3, 1], dot: [1, 1], sysDot: [1, 1], lgDash: [8, 3], dashDot: [4, 3, 1, 3], lgDashDot: [8, 3, 1, 3], sysDashDot: [3, 1, 1, 1] }[line.dash];
  g.setLineDash(d ? d.map(x => x * w) : []);
  g.stroke();
  g.setLineDash([]);
}

// ── 도형 모양 ──
const OPEN = new Set(["line", "straightConnector1", "bentConnector2", "bentConnector3", "bentConnector4", "bentConnector5", "curvedConnector2", "curvedConnector3", "curvedConnector4", "curvedConnector5", "arc"]);
function adj(geom, name, d) {
  const gd = chs(ch(geom, "avLst"), "gd").find(x => attr(x, "name") === name) || (name === "adj" ? chs(ch(geom, "avLst"), "gd").find(x => attr(x, "name") === "adj1") : null);
  const m = /val\s+(-?\d+)/.exec(attr(gd, "fmla") || "");
  return m ? Number(m[1]) : d;
}
// 지금 경로를 만든다(0..w, 0..h). 열린 선이면 false
function shapePath(g, geom, w, h) {
  g.beginPath();
  if (geom && geom.localName === "custGeom") return customPath(g, geom, w, h);
  const prst = attr(geom, "prst") || "rect";
  const ss = Math.min(w, h);
  const poly = pts => { pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); };
  switch (prst) {
    case "line": case "straightConnector1": g.moveTo(0, 0); g.lineTo(w, h); return false;
    case "bentConnector2": g.moveTo(0, 0); g.lineTo(w, 0); g.lineTo(w, h); return false;
    case "bentConnector3": case "bentConnector4": case "bentConnector5": {
      const x = (w * adj(geom, "adj1", 50000)) / 100000;
      g.moveTo(0, 0); g.lineTo(x, 0); g.lineTo(x, h); g.lineTo(w, h); return false;
    }
    case "curvedConnector2": case "curvedConnector3": case "curvedConnector4": case "curvedConnector5":
      g.moveTo(0, 0); g.bezierCurveTo(w / 2, 0, w / 2, h, w, h); return false;
    case "arc": g.ellipse(w / 2, h / 2, w / 2, h / 2, 0, -Math.PI / 2, 0); return false;
    case "ellipse": case "flowChartConnector": case "flowChartOnlineStorage": case "cloud": case "cloudCallout": case "wedgeEllipseCallout":
    case "smileyFace": case "donut": case "pie": case "chord": case "blockArc": case "flowChartSummingJunction": case "flowChartOr":
      g.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); return true;
    case "roundRect": case "flowChartAlternateProcess": case "wedgeRoundRectCallout": case "round2SameRect": case "round1Rect": case "snipRoundRect": {
      const r = Math.min(ss / 2, (ss * adj(geom, "adj", prst === "flowChartAlternateProcess" ? 16667 : 16667)) / 100000);
      roundRect(g, 0, 0, w, h, r); return true;
    }
    case "flowChartTerminator": roundRect(g, 0, 0, w, h, Math.min(w, h) / 2); return true;
    case "triangle": case "flowChartExtract": { const x = (w * adj(geom, "adj", 50000)) / 100000; poly([[x, 0], [w, h], [0, h]]); return true; }
    case "flowChartMerge": poly([[0, 0], [w, 0], [w / 2, h]]); return true;
    case "rtTriangle": poly([[0, 0], [w, h], [0, h]]); return true;
    case "diamond": case "flowChartDecision": poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]); return true;
    case "parallelogram": case "flowChartInputOutput": { const a = prst === "parallelogram" ? (ss * adj(geom, "adj", 25000)) / 100000 : w / 5; poly([[a, 0], [w, 0], [w - a, h], [0, h]]); return true; }
    case "trapezoid": case "flowChartManualOperation": { const a = prst === "trapezoid" ? (ss * adj(geom, "adj", 25000)) / 100000 : w / 5; poly([[a, 0], [w - a, 0], [w, h], [0, h]]); return true; }
    case "pentagon": case "homePlate": { const a = Math.min(w, (ss * adj(geom, "adj", 50000)) / 100000); poly([[0, 0], [w - a, 0], [w, h / 2], [w - a, h], [0, h]]); return true; }
    case "chevron": { const a = Math.min(w, (ss * adj(geom, "adj", 50000)) / 100000); poly([[0, 0], [w - a, 0], [w, h / 2], [w - a, h], [0, h], [a, h / 2]]); return true; }
    case "hexagon": { const a = (ss * adj(geom, "adj", 25000)) / 100000; poly([[a, 0], [w - a, 0], [w, h / 2], [w - a, h], [a, h], [0, h / 2]]); return true; }
    case "octagon": { const a = (ss * adj(geom, "adj", 29289)) / 100000; poly([[a, 0], [w - a, 0], [w, a], [w, h - a], [w - a, h], [a, h], [0, h - a], [0, a]]); return true; }
    case "plus": case "flowChartPredefinedProcess": {
      if (prst !== "plus") { g.rect(0, 0, w, h); return true; }
      const a = (ss * adj(geom, "adj", 25000)) / 100000;
      poly([[a, 0], [w - a, 0], [w - a, a], [w, a], [w, h - a], [w - a, h - a], [w - a, h], [a, h], [a, h - a], [0, h - a], [0, a], [a, a]]); return true;
    }
    case "rightArrow": case "leftArrow": case "upArrow": case "downArrow": case "notchedRightArrow": {
      const vert = prst === "upArrow" || prst === "downArrow";
      const L = vert ? h : w, T = vert ? w : h;
      const shaft = (T * adj(geom, "adj1", 50000)) / 100000, head = Math.min(L, (Math.min(w, h) * adj(geom, "adj2", 50000)) / 100000);
      const y0 = (T - shaft) / 2, y1 = (T + shaft) / 2;
      let pts = [[0, y0], [L - head, y0], [L - head, 0], [L, T / 2], [L - head, T], [L - head, y1], [0, y1]];
      if (prst === "leftArrow" || prst === "upArrow") pts = pts.map(([x, y]) => [L - x, y]);
      if (vert) pts = pts.map(([x, y]) => [y, x]);
      poly(pts); return true;
    }
    case "leftRightArrow": {
      const shaft = (h * adj(geom, "adj1", 50000)) / 100000, head = Math.min(w / 2, (ss * adj(geom, "adj2", 50000)) / 100000);
      const y0 = (h - shaft) / 2, y1 = (h + shaft) / 2;
      poly([[0, h / 2], [head, 0], [head, y0], [w - head, y0], [w - head, 0], [w, h / 2], [w - head, h], [w - head, y1], [head, y1], [head, h]]); return true;
    }
    case "star5": case "star4": case "star6": case "star8": case "star10": case "star12": case "irregularSeal1": case "irregularSeal2": {
      const n = { star4: 4, star6: 6, star8: 8, star10: 10, star12: 12 }[prst] || 5;
      const pts = [];
      for (let i = 0; i < n * 2; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / n, r = i % 2 ? 0.4 : 1;
        pts.push([w / 2 + (Math.cos(a) * w * r) / 2, h / 2 + (Math.sin(a) * h * r) / 2]);
      }
      poly(pts); return true;
    }
    case "heart": {
      g.moveTo(w / 2, h * 0.25);
      g.bezierCurveTo(w * 0.5, 0, 0, 0, 0, h * 0.3);
      g.bezierCurveTo(0, h * 0.6, w * 0.4, h * 0.75, w / 2, h);
      g.bezierCurveTo(w * 0.6, h * 0.75, w, h * 0.6, w, h * 0.3);
      g.bezierCurveTo(w, 0, w * 0.5, 0, w / 2, h * 0.25);
      g.closePath(); return true;
    }
    default: g.rect(0, 0, w, h); return true;
  }
}
function roundRect(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
// 자유형(custGeom): moveTo·lnTo·cubicBezTo·quadBezTo·arcTo·close. 하나라도 닫히면 채울 수 있는 모양
function customPath(g, geom, w, h) {
  let closed = false;
  for (const p of chs(ch(geom, "pathLst"), "path")) {
    const pw = num(attr(p, "w"), 0) || w, ph = num(attr(p, "h"), 0) || h;
    const sx = pw ? w / pw : 1, sy = ph ? h / ph : 1;
    const P = n => [num(attr(n, "x")) * sx, num(attr(n, "y")) * sy];
    let cur = [0, 0];
    for (const c of chs(p)) {
      const pts = chs(c, "pt").map(P);
      switch (c.localName) {
        case "moveTo": if (pts[0]) { g.moveTo(...pts[0]); cur = pts[0]; } break;
        case "lnTo": if (pts[0]) { g.lineTo(...pts[0]); cur = pts[0]; } break;
        case "cubicBezTo": if (pts.length === 3) { g.bezierCurveTo(...pts[0], ...pts[1], ...pts[2]); cur = pts[2]; } break;
        case "quadBezTo": if (pts.length === 2) { g.quadraticCurveTo(...pts[0], ...pts[1]); cur = pts[1]; } break;
        case "arcTo": {
          const wr = num(attr(c, "wR")) * sx, hr = num(attr(c, "hR")) * sy;
          const st = (num(attr(c, "stAng")) / 60000) * Math.PI / 180, sw = (num(attr(c, "swAng")) / 60000) * Math.PI / 180;
          if (!wr || !hr) break;
          const ccx = cur[0] - wr * Math.cos(st), ccy = cur[1] - hr * Math.sin(st);
          g.ellipse(ccx, ccy, wr, hr, 0, st, st + sw, sw < 0);
          cur = [ccx + wr * Math.cos(st + sw), ccy + hr * Math.sin(st + sw)];
          break;
        }
        case "close": g.closePath(); if (attr(p, "fill") !== "none") closed = true; break;
        default: break;
      }
    }
  }
  return closed;
}
// 화살촉(선의 끝점 p, 들어오는 방향 from)
function arrowHead(g, end, p, from, line, cx) {
  const lw = Math.max(0.6, line.w * cx.k);
  const size = { sm: 2, med: 3, lg: 5 };
  const len = lw * (size[end.len] || 3), wid = lw * (size[end.w] || 3);
  const a = Math.atan2(p[1] - from[1], p[0] - from[0]);
  g.save();
  g.translate(p[0], p[1]);
  g.rotate(a);
  g.beginPath();
  if (end.type === "oval") g.ellipse(0, 0, len / 2, wid / 2, 0, 0, Math.PI * 2);
  else if (end.type === "diamond") { g.moveTo(len / 2, 0); g.lineTo(0, wid / 2); g.lineTo(-len / 2, 0); g.lineTo(0, -wid / 2); g.closePath(); }
  else if (end.type === "arrow") { g.moveTo(-len, -wid / 2); g.lineTo(0, 0); g.lineTo(-len, wid / 2); g.lineWidth = lw; g.strokeStyle = css(line.color); g.stroke(); g.restore(); return; }
  else { g.moveTo(0, 0); g.lineTo(-len, -wid / 2); g.lineTo(-len * (end.type === "stealth" ? 0.6 : 1), 0); g.lineTo(-len, wid / 2); g.closePath(); }
  g.fillStyle = css(line.color);
  g.fill();
  g.restore();
}

// ── 위치(xfrm) ──
function xfrmOf(x) {
  if (!x) return null;
  const off = ch(x, "off"), ext = ch(x, "ext");
  if (!off || !ext) return null;
  const o = {
    x: num(attr(off, "x")), y: num(attr(off, "y")), w: num(attr(ext, "cx")), h: num(attr(ext, "cy")),
    rot: num(attr(x, "rot")) / 60000, flipH: on(attr(x, "flipH")), flipV: on(attr(x, "flipV")),
  };
  const co = ch(x, "chOff"), ce = ch(x, "chExt");
  if (co && ce) o.ch = { x: num(attr(co, "x")), y: num(attr(co, "y")), w: num(attr(ce, "cx")), h: num(attr(ce, "cy")) };
  return o;
}
// EMU 상자 → 캔버스(px). 그룹 안이면 map 이 부모 좌표로 옮겨 준다
function withFrame(g, box, cx, draw) {
  const x = box.x * cx.k, y = box.y * cx.k, w = box.w * cx.k, h = box.h * cx.k;
  g.save();
  g.translate(x + w / 2, y + h / 2);
  if (box.rot) g.rotate((box.rot * Math.PI) / 180);
  g.scale(box.flipH ? -1 : 1, box.flipV ? -1 : 1);
  g.translate(-w / 2, -h / 2);
  try { draw(w, h); } finally { g.restore(); }
}

// ── 개체 틀(placeholder) 물려받기 ──
const phKind = t => (t === "title" || t === "ctrTitle" ? "title" : !t || t === "body" || t === "subTitle" || t === "obj" ? "body" : "other");
function phOf(node) {
  const nv = chs(node).find(c => /^nv/.test(c.localName));
  const ph = q(nv, "nvPr", "ph");
  return ph ? { type: attr(ph, "type") || null, idx: attr(ph, "idx") } : null;
}
function treeOf(doc) { return doc ? q(doc.documentElement, "cSld", "spTree") : null; }
function findPh(doc, ph, byIdx) {
  const nodes = chs(treeOf(doc)).filter(n => n.localName === "sp" || n.localName === "pic");
  const list = nodes.map(n => ({ n, p: phOf(n) })).filter(x => x.p);
  if (byIdx && ph.idx != null) { const hit = list.find(x => x.p.idx === ph.idx); if (hit) return hit.n; }
  const t = ph.type || "body";
  const exact = list.find(x => (x.p.type || "body") === t || (t === "obj" && !x.p.type));
  if (exact) return exact.n;
  const kind = phKind(ph.type);
  if (kind === "other") return null;
  return (list.find(x => phKind(x.p.type) === kind && (kind === "title" ? true : x.p.type !== "title")) || {}).n || null;
}
function inheritOf(node, cx) {
  const ph = phOf(node);
  if (!ph || cx.level !== "slide") return { ph, chain: [] };
  const lay = findPh(cx.layout, ph, true);
  const mas = findPh(cx.master, ph, false) || (lay ? findPh(cx.master, phOf(lay) || ph, false) : null);
  return { ph, chain: [lay, mas].filter(Boolean) };
}

// ── 글자 ──
const isHanzi = ch2 => /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff]/.test(ch2); // 한자·가나는 글자마다 끊어도 됨
function fontFace(face, cx, kind) {
  if (!face) return null;
  const t = cx.theme;
  if (face === "+mj-lt") return t.major.latin; if (face === "+mn-lt") return t.minor.latin;
  if (face === "+mj-ea") return t.major.ea; if (face === "+mn-ea") return t.minor.ea;
  if (face.startsWith("+")) return kind === "title" ? t.major.latin : t.minor.latin;
  return face;
}
const quoteFont = f => `"${String(f).replace(/["\\]/g, "")}"`;
function autoNum(type, n) {
  const roman = x => { const r = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]]; let s = ""; for (const [v, k] of r) while (x >= v) { s += k; x -= v; } return s; };
  const alpha = x => { let s = ""; while (x > 0) { x--; s = String.fromCharCode(97 + (x % 26)) + s; x = Math.floor(x / 26); } return s; };
  const t = type || "arabicPeriod";
  let core = String(n);
  if (/^alphaLc/.test(t)) core = alpha(n); else if (/^alphaUc/.test(t)) core = alpha(n).toUpperCase();
  else if (/^romanLc/.test(t)) core = roman(n); else if (/^romanUc/.test(t)) core = roman(n).toUpperCase();
  else if (/^circleNum/.test(t)) return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `(${n})`;
  else if (/^ea1Chs|^hebrew|^thai|^hindi|^arabicDb/.test(t)) core = String(n);
  if (/ParenBoth$/.test(t)) return `(${core})`;
  if (/ParenR$/.test(t)) return `${core})`;
  if (/Plain$/.test(t)) return core;
  return `${core}.`;
}

// 글자 그리기: (0..w, 0..h) 안. info = { kind, chain:[개체 틀 노드…], fontColor, bold, slideNo, bodyPrs:[…] }
function drawText(g, txBody, w, h, cx, info) {
  if (!txBody) return;
  const paras = chs(txBody, "p");
  if (!paras.some(p => chs(p).some(c => (c.localName === "r" || c.localName === "fld") && (q(c, "t")?.textContent || "")))) return;
  // 본문 설정: 마스터 → 레이아웃 → 자기 순으로 덮어씀
  const bodyPrs = [...(info.bodyPrs || []), ch(txBody, "bodyPr")].filter(Boolean);
  const bp = name => { for (let i = bodyPrs.length - 1; i >= 0; i--) { const v = attr(bodyPrs[i], name); if (v != null) return v; } return null; };
  const bpCh = name => { for (let i = bodyPrs.length - 1; i >= 0; i--) { const c = ch(bodyPrs[i], name); if (c) return c; } return null; };
  const k = cx.k;
  const lIns = num(bp("lIns"), 91440) * k, rIns = num(bp("rIns"), 91440) * k, tIns = num(bp("tIns"), 45720) * k, bIns = num(bp("bIns"), 45720) * k;
  const vert = bp("vert");
  g.save();
  if (vert === "vert" || vert === "eaVert" || vert === "wordArtVert") { g.translate(w, 0); g.rotate(Math.PI / 2); [w, h] = [h, w]; }
  else if (vert === "vert270") { g.translate(0, h); g.rotate(-Math.PI / 2); [w, h] = [h, w]; }
  const W = Math.max(1, w - lIns - rIns), H = Math.max(1, h - tIns - bIns);
  const wrap = bp("wrap") !== "none";
  const anchor = bp("anchor") || "t";
  const autofit = bpCh("normAutofit");
  const fs0 = autofit ? num(attr(autofit, "fontScale"), 100000) / 100000 : 1;
  const lnRed = autofit ? num(attr(autofit, "lnSpcReduction"), 0) / 100000 : 0;
  // 글자 모양 사슬: 자기 lstStyle | (스타일 색) | 레이아웃·마스터 개체 틀 lstStyle, 마스터 글자 스타일, 기본 글자 스타일
  const own = [ch(txBody, "lstStyle")].filter(Boolean);
  const inh = [...(info.chain || []).map(n => q(n, "txBody", "lstStyle")), cx.masterStyle(info.kind), cx.defaultStyle].filter(Boolean);
  const lay = scale => layoutParas(g, paras, W, wrap, cx, info, own, inh, scale, lnRed);
  let scale = fs0, L = lay(scale);
  // 자동 맞춤인데 넘치면 저장된 비율이 없을 때처럼 줄여 맞춘다
  for (let i = 0; autofit && L.height > H * 1.02 && i < 8; i++) { scale *= 0.9; L = lay(scale); }
  let y = tIns + (anchor === "ctr" ? (H - L.height) / 2 : anchor === "b" ? H - L.height : 0);
  for (const ln of L.lines) {
    const base = y + ln.top + ln.ascent;
    let x = lIns + ln.x0;
    const free = ln.avail - ln.width;
    if (ln.align === "ctr") x += free / 2;
    else if (ln.align === "r") x += free;
    if (ln.bullet) {
      g.font = ln.bullet.font;
      g.fillStyle = ln.bullet.color;
      g.fillText(ln.bullet.text, lIns + ln.bullet.x, base);
    }
    for (const it of ln.items) {
      if (!it.text) continue;
      g.font = it.font;
      g.fillStyle = it.color;
      const yy = base + it.shift;
      g.fillText(it.text, x, yy);
      if (it.u || it.strike) {
        const tw = it.w - (it.trail || 0);
        g.fillRect(x, it.strike ? yy - it.size * 0.3 : yy + it.size * 0.12, tw, Math.max(1, it.size * 0.06));
      }
      x += it.w;
    }
  }
  g.restore();
}

function layoutParas(g, paras, W, wrap, cx, info, own, inh, scale, lnRed) {
  const k = cx.k;
  const lines = [];
  let y = 0;
  const counters = [];
  paras.forEach((p, pi) => {
    const pPr = ch(p, "pPr");
    const lvl = Math.max(0, Math.min(8, num(attr(pPr, "lvl"))));
    const lvlNodes = ls => [ch(ls, LVL[lvl]), ch(ls, "defPPr")].filter(Boolean);
    const pNodes = [pPr, ...own.flatMap(lvlNodes), ...inh.flatMap(lvlNodes)].filter(Boolean);
    const pa = name => first(pNodes, name);
    const pc = name => firstCh(pNodes, name);
    const defR = [ch(pPr, "defRPr"), ...own.flatMap(ls => lvlNodes(ls).map(n => ch(n, "defRPr")))].filter(Boolean);
    const defRInh = inh.flatMap(ls => lvlNodes(ls).map(n => ch(n, "defRPr"))).filter(Boolean);
    // 글자 하나(run)의 모양
    const runStyle = (rPr) => {
      const nodes = [rPr, ...defR, ...defRInh].filter(Boolean);
      const sz = num(first(nodes, "sz"), 1800) / 100;
      const b = first([rPr, ...defR].filter(Boolean), "b") ?? (info.bold != null ? (info.bold ? "1" : "0") : first(defRInh, "b"));
      const i = first(nodes, "i");
      const u = first(nodes, "u");
      const strike = first(nodes, "strike");
      const base = num(first(nodes, "baseline"), 0);
      const cap = first(nodes, "cap");
      // 색: 자기 지정 → 도형 스타일 글자 색 → 물려받은 색 → tx1
      const fillOwn = firstCh([rPr, ...defR].filter(Boolean), "solidFill");
      let color = fillOwn ? colorOf(fillOwn, cx) : null;
      if (!color && info.fontColor) color = info.fontColor;
      if (!color) { const f = firstCh(defRInh, "solidFill"); color = f ? colorOf(f, cx) : null; }
      if (!color) color = colorOf({ localName: "schemeClr", getAttribute: () => "tx1", firstElementChild: null }, cx) || { r: 0, g: 0, b: 0, a: 1 };
      const latin = fontFace(attr(firstCh(nodes, "latin"), "typeface"), cx, info.kind) || (info.kind === "title" ? cx.theme.major.latin : cx.theme.minor.latin);
      const ea = fontFace(attr(firstCh(nodes, "ea"), "typeface"), cx, info.kind) || (info.kind === "title" ? cx.theme.major.ea : cx.theme.minor.ea);
      const fam = [latin, ea].filter(Boolean).map(quoteFont).join(", ");
      let px = sz * 12700 * k * scale;
      const shift = base ? -px * (base / 100000) * 1.0 : 0;
      if (base) px *= 0.66;
      return {
        size: px, color: css(color), u: !!u && u !== "none", strike: !!strike && strike !== "noStrike", shift, cap,
        font: `${on(i) ? "italic " : ""}${on(b) ? "700" : "400"} ${px.toFixed(2)}px ${fam ? fam + ", " : ""}${FALLBACK}`,
      };
    };
    // 글자 조각
    const spans = [];
    for (const c of chs(p)) {
      if (c.localName === "r" || c.localName === "fld") {
        let t = (q(c, "t")?.textContent || "").replace(/\t/g, "    ");
        if (c.localName === "fld" && /slidenum/i.test(attr(c, "type") || "")) t = String(info.slideNo || t);
        const st = runStyle(ch(c, "rPr"));
        if (st.cap === "all") t = t.toUpperCase();
        if (t) spans.push({ ...st, text: t });
      } else if (c.localName === "br") spans.push({ ...runStyle(ch(c, "rPr")), text: "\n" });
    }
    const endSt = runStyle(ch(p, "endParaRPr"));
    const maxSz = spans.length ? Math.max(...spans.map(s => s.size)) : endSt.size;
    // 문단 설정
    const algn = pa("algn") || "l";
    const marL = num(pa("marL"), 0) * k, indent = num(pa("indent"), 0) * k;
    const lnSpc = pc("lnSpc"), spcB = pc("spcBef"), spcA = pc("spcAft");
    const spacing = (n, fontPx) => {
      if (!n) return 0;
      const pts = ch(n, "spcPts"), pct = ch(n, "spcPct");
      if (pts) return num(attr(pts, "val")) / 100 * 12700 * k * scale;
      if (pct) return (num(attr(pct, "val")) / 100000) * fontPx * 1.2;
      return 0;
    };
    const lineH = (px) => {
      const pts = ch(lnSpc, "spcPts"), pct = ch(lnSpc, "spcPct");
      if (pts) return Math.max(px * 0.8, num(attr(pts, "val")) / 100 * 12700 * k * scale);
      const f = pct ? num(attr(pct, "val"), 100000) / 100000 : 1;
      return px * 1.2 * Math.max(0.5, f - lnRed);
    };
    // 글머리
    let bullet = null;
    const hasText = spans.some(s => s.text.trim());
    if (hasText && !pc("buNone")) {
      const bc = pc("buChar"), bn = pc("buAutoNum");
      if (bn) {
        const start = num(attr(bn, "startAt"), 1);
        const prev = counters[lvl];
        const n = prev && prev.type === attr(bn, "type") && prev.pi === pi - 1 ? prev.n + 1 : start;
        counters[lvl] = { type: attr(bn, "type"), n, pi };
        bullet = { text: autoNum(attr(bn, "type"), n) };
      } else if (bc) bullet = { text: attr(bc, "char") || "•" };
      if (bullet) {
        const first0 = spans.find(s => s.text.trim()) || endSt;
        const szPct = pc("buSzPct"), buClr = pc("buClr"), buFont = attr(pc("buFont"), "typeface");
        const bpx = first0.size * (szPct ? num(attr(szPct, "val"), 100000) / 100000 : 1);
        const face = buFont && !/^\+/.test(buFont) && !/wingdings|symbol/i.test(buFont) ? quoteFont(buFont) + ", " : "";
        let btxt = bullet.text;
        if (/wingdings/i.test(buFont || "")) btxt = { "§": "■", "Ø": "➢", "ü": "✓", "q": "❑", "v": "❖", "n": "■", "l": "●", "Ü": "➢", "à": "→" }[btxt] || "•";
        bullet = {
          text: btxt, x: marL + indent,
          font: `400 ${bpx.toFixed(2)}px ${face}${FALLBACK}`,
          color: buClr ? css(colorOf(buClr, cx)) : first0.color,
        };
      }
    } else counters[lvl] = null;
    // 줄 나누기
    if (pi > 0) y += spacing(spcB, maxSz);
    const startX = bullet ? marL : marL + indent;
    const avail0 = Math.max(4, W - startX), availN = Math.max(4, W - marL);
    const pieces = [];
    for (const s of spans) {
      if (s.text === "\n") { pieces.push({ s, text: "\n" }); continue; }
      let cur = "";
      for (const c of s.text) {
        if (c === " " || c === "\u00a0") { cur += c; pieces.push({ s, text: cur }); cur = ""; continue; }
        if (isHanzi(c)) { if (cur) pieces.push({ s, text: cur }); pieces.push({ s, text: c }); cur = ""; continue; }
        cur += c;
      }
      if (cur) pieces.push({ s, text: cur });
    }
    const pLines = [];
    let line = null;
    const newLine = () => { line = { items: [], width: 0, x0: pLines.length ? marL : startX, avail: pLines.length ? availN : avail0 }; pLines.push(line); };
    newLine();
    const measure = (s, t) => { g.font = s.font; return g.measureText(t).width; };
    const push = (s, t) => {
      const tw = measure(s, t);
      const trail = t.endsWith(" ") ? measure(s, " ") * (t.length - t.trimEnd().length) : 0;
      const last = line.items[line.items.length - 1];
      if (last && last.s === s) { last.text += t; last.w += tw; last.trail = trail; }
      else line.items.push({ s, text: t, w: tw, trail, font: s.font, color: s.color, size: s.size, u: s.u, strike: s.strike, shift: s.shift });
      line.width += tw;
    };
    const trailOf = () => (line.items.length ? line.items[line.items.length - 1].trail || 0 : 0);
    for (const pc2 of pieces) {
      if (pc2.text === "\n") { newLine(); continue; }
      let t = pc2.text;
      if (!line.items.length && pLines.length > 1) t = t.replace(/^ +/, "");
      if (!t) continue;
      const tw = measure(pc2.s, t.trimEnd());
      if (wrap && line.items.length && line.width - trailOf() + tw > line.avail + 0.5) {
        newLine();
        t = t.replace(/^ +/, "");
        if (!t) continue;
      }
      // 한 조각이 줄보다 길면 글자 단위로
      if (wrap && measure(pc2.s, t.trimEnd()) > line.avail + 0.5) {
        for (const c of t) {
          const cw = measure(pc2.s, c);
          if (line.items.length && line.width + cw > line.avail + 0.5 && c !== " ") newLine();
          push(pc2.s, c);
        }
        continue;
      }
      push(pc2.s, t);
    }
    pLines.forEach((ln, li) => {
      const mx = ln.items.length ? Math.max(...ln.items.map(it => it.size)) : (spans.length ? maxSz : endSt.size);
      ln.width -= ln.items.length ? ln.items[ln.items.length - 1].trail || 0 : 0;
      ln.align = algn === "just" || algn === "dist" || algn === "justLow" ? "l" : algn;
      ln.h = lineH(mx);
      ln.ascent = ln.h - mx * 0.25;
      ln.top = y;
      ln.bullet = li === 0 ? bullet : null;
      y += ln.h;
      lines.push(ln);
    });
    if (pi < paras.length - 1) y += spacing(spcA, maxSz);
  });
  return { lines, height: y };
}

// ── 그리기: 도형·그림·그룹·표·SmartArt ──
async function drawNode(g, n, cx, map) {
  switch (n.localName) {
    case "sp": case "cxnSp": return drawShape(g, n, cx, map);
    case "pic": return drawPic(g, n, cx, map);
    case "grpSp": return drawGroup(g, n, cx, map);
    case "graphicFrame": return drawFrame(g, n, cx, map);
    case "AlternateContent": {
      const pick = ch(n, "Fallback") || ch(n, "Choice");
      for (const c of chs(pick)) await drawNode(g, c, cx, map);
      return undefined;
    }
    default: return undefined;
  }
}
const ident = b => b;
async function drawTree(g, tree, cx, map = ident) {
  for (const n of chs(tree)) {
    // 마스터·레이아웃의 개체 틀(안내 글)은 슬라이드에 나오지 않는다
    if (cx.level !== "slide" && phOf(n)) continue;
    try { await drawNode(g, n, cx, map); } catch (e) { console.warn("[pptx] 개체를 그리지 못함", n.localName, e); }
  }
}

async function drawShape(g, sp, cx, map) {
  const spPr = ch(sp, "spPr");
  const { ph, chain } = inheritOf(sp, cx);
  let xf = xfrmOf(ch(spPr, "xfrm"));
  for (const c of chain) if (!xf) xf = xfrmOf(q(c, "spPr", "xfrm"));
  if (!xf) return;
  const box = map(xf);
  const style = ch(sp, "style");
  let fill = fillOf(spPr, cx);
  for (const c of chain) if (!fill) fill = fillOf(ch(c, "spPr"), cx);
  if (!fill) fill = refFill(ch(style, "fillRef"), cx);
  if (on(attr(sp, "useBgFill"))) fill = cx.bgFill || { kind: "solid", color: { r: 255, g: 255, b: 255, a: 1 } };
  fill = await loadFill(fill, cx);
  let line = refLine(ch(style, "lnRef"), cx);
  for (let i = chain.length - 1; i >= 0; i--) line = lineFrom(q(chain[i], "spPr", "ln"), cx, null, line);
  line = lineFrom(ch(spPr, "ln"), cx, null, line);
  let geom = ch(spPr, "prstGeom") || ch(spPr, "custGeom");
  for (const c of chain) if (!geom) geom = q(c, "spPr", "prstGeom") || q(c, "spPr", "custGeom");
  const fontColor = colorOf(ch(style, "fontRef"), cx);
  const txBody = ch(sp, "txBody");
  const txXfrm = ch(sp, "txXfrm"); // SmartArt 그림의 글자 상자
  withFrame(g, box, cx, (w, h) => {
    const closed = shapePath(g, geom, w, h);
    if (closed) paint(g, fill, w, h, cx);
    strokeLine(g, line, cx);
    if (!closed && line && !line.none && line.color && (line.head || line.tail) && geom && geom.localName === "prstGeom") {
      const prst = attr(geom, "prst");
      const pts = prst === "bentConnector3" ? [[0, 0], [w / 2, 0], [w / 2, h], [w, h]] : prst === "bentConnector2" ? [[0, 0], [w, 0], [w, h]] : [[0, 0], [w, h]];
      if (line.head) arrowHead(g, line.head, pts[0], pts[1], line, cx);
      if (line.tail) arrowHead(g, line.tail, pts[pts.length - 1], pts[pts.length - 2], line, cx);
    }
  });
  // 글자는 도형을 뒤집어도 거울 글자가 되지 않는다(회전만 따름)
  if (txBody && !txXfrm) {
    withFrame(g, { ...box, flipH: false, flipV: false }, cx, (w, h) => drawText(g, txBody, w, h, cx, {
      kind: ph ? phKind(ph.type) : "other", chain, fontColor, slideNo: cx.slideNo,
      bodyPrs: chain.slice().reverse().map(c => q(c, "txBody", "bodyPr")),
    }));
  }
  if (txBody && txXfrm) {
    // SmartArt 글자는 거꾸로 서지 않게(PowerPoint 처럼 90°~270° 돌아가 있으면 반 바퀴 되돌림)
    const tb = map(xfrmOf(txXfrm) || xf);
    const r = (((tb.rot || 0) % 360) + 360) % 360;
    withFrame(g, { ...tb, rot: r > 90 && r < 270 ? r - 180 : r, flipH: false, flipV: false }, cx, (w, h) => drawText(g, txBody, w, h, cx, { kind: "other", chain: [], fontColor, slideNo: cx.slideNo }));
  }
}

async function drawPic(g, pic, cx, map) {
  const spPr = ch(pic, "spPr");
  const { chain } = inheritOf(pic, cx);
  let xf = xfrmOf(ch(spPr, "xfrm"));
  for (const c of chain) if (!xf) xf = xfrmOf(q(c, "spPr", "xfrm"));
  if (!xf) return;
  const bf = ch(pic, "blipFill");
  const blip = ch(bf, "blip");
  const rel = cx.pkg.rels(cx.part).get(attr(blip, "r:embed"));
  const bmp = rel ? await cx.pkg.image(rel.path) : null;
  const line = lineFrom(ch(spPr, "ln"), cx, null, refLine(q(pic, "style", "lnRef"), cx));
  const geom = ch(spPr, "prstGeom") || ch(spPr, "custGeom");
  withFrame(g, map(xf), cx, (w, h) => {
    if (bmp) {
      g.save();
      const prst = attr(geom, "prst");
      if (geom && prst !== "rect") { shapePath(g, geom, w, h); g.clip(); }
      drawBitmap(g, bmp, ch(bf, "srcRect"), 0, 0, w, h, alphaOf(blip));
      g.restore();
    }
    if (line && !line.none && line.color) { shapePath(g, geom, w, h); strokeLine(g, line, cx); }
  });
}

async function drawGroup(g, grp, cx, map) {
  const xf = xfrmOf(q(grp, "grpSpPr", "xfrm"));
  if (!xf) { await drawTree(g, grp, cx, map); return; }
  const box = map(xf);
  const c0 = xf.ch || { x: xf.x, y: xf.y, w: xf.w, h: xf.h };
  const sx = c0.w ? box.w / c0.w : 1, sy = c0.h ? box.h / c0.h : 1;
  const inner = b => ({ ...b, x: box.x + (b.x - c0.x) * sx, y: box.y + (b.y - c0.y) * sy, w: b.w * sx, h: b.h * sy });
  const grpFill = await loadFill(fillOf(ch(grp, "grpSpPr"), cx), cx);
  const sub = { ...cx, grpFill: grpFill || cx.grpFill };
  g.save();
  // 그룹 회전·뒤집기: 그룹 가운데를 기준으로 캔버스를 돌리고 자식은 돌지 않은 상자에 그린다
  if (box.rot || box.flipH || box.flipV) {
    const ccx = (box.x + box.w / 2) * cx.k, ccy = (box.y + box.h / 2) * cx.k;
    g.translate(ccx, ccy);
    if (box.rot) g.rotate((box.rot * Math.PI) / 180);
    g.scale(box.flipH ? -1 : 1, box.flipV ? -1 : 1);
    g.translate(-ccx, -ccy);
  }
  for (const n of chs(grp)) {
    if (n.localName === "nvGrpSpPr" || n.localName === "grpSpPr") continue;
    try { await drawNode(g, n, sub, inner); } catch (e) { console.warn("[pptx] 그룹 안 개체", e); }
  }
  g.restore();
}

async function drawFrame(g, gf, cx, map) {
  const xf = xfrmOf(ch(gf, "xfrm"));
  if (!xf) return;
  const gd = q(gf, "graphic", "graphicData");
  const uri = attr(gd, "uri") || "";
  if (/table/.test(uri)) return drawTable(g, ch(gd, "tbl"), map(xf), cx);
  if (/diagram/.test(uri)) {
    // SmartArt: 파일에 저장된 그림(drawing*.xml)을 그 자리에 그린다
    const ids = ch(gd, "relIds");
    const rels = cx.pkg.rels(cx.part);
    const dm = rels.get(attr(ids, "r:dm"));
    let drawPath = null;
    const dmDoc = dm ? cx.pkg.xml(dm.path) : null;
    const ext = dmDoc ? [...dmDoc.getElementsByTagName("*")].find(e => e.localName === "dataModelExt") : null;
    if (ext && rels.get(attr(ext, "relId"))) drawPath = rels.get(attr(ext, "relId")).path;
    if (!drawPath) for (const v of rels.values()) if (/diagramDrawing/.test(v.type)) { drawPath = v.path; break; }
    const ddoc = drawPath ? cx.pkg.xml(drawPath) : null;
    const tree = ddoc ? [...ddoc.documentElement.children].find(e => e.localName === "spTree") : null;
    if (!tree) return frameNote(g, map(xf), cx, "SmartArt");
    const sub = { ...cx, part: drawPath, level: "drawing" };
    const inner = b => map({ ...b, x: xf.x + b.x, y: xf.y + b.y });
    for (const n of chs(tree)) { try { await drawNode(g, n, sub, inner); } catch (e) { console.warn("[pptx] SmartArt", e); } }
    return undefined;
  }
  if (/chart/.test(uri)) return frameNote(g, map(xf), cx, "차트");
  // OLE 개체 등: 안에 든 그림이 있으면 그 그림
  const pic = [...gd.getElementsByTagName("*")].find(e => e.localName === "pic");
  if (pic) {
    const spPr = ch(pic, "spPr");
    if (!xfrmOf(ch(spPr, "xfrm"))) {
      const bf = ch(pic, "blipFill");
      const rel = cx.pkg.rels(cx.part).get(attr(ch(bf, "blip"), "r:embed"));
      const bmp = rel ? await cx.pkg.image(rel.path) : null;
      if (bmp) withFrame(g, map(xf), cx, (w, h) => drawBitmap(g, bmp, null, 0, 0, w, h));
      return undefined;
    }
    return drawPic(g, pic, cx, map);
  }
  return undefined;
}
function frameNote(g, box, cx, label) {
  withFrame(g, box, cx, (w, h) => {
    g.fillStyle = "rgba(120,120,130,.08)";
    g.strokeStyle = "rgba(120,120,130,.35)";
    g.lineWidth = Math.max(1, 1.5 * cx.k * 12700);
    g.setLineDash([6, 4]);
    g.fillRect(0, 0, w, h);
    g.strokeRect(0, 0, w, h);
    g.setLineDash([]);
    g.fillStyle = "rgba(90,90,100,.7)";
    g.font = `600 ${Math.max(12, Math.min(w, h) / 10).toFixed(1)}px ${FALLBACK}`;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(`${label} (PDF로 저장하면 보여요)`, w / 2, h / 2, w * 0.9);
    g.textAlign = "start"; g.textBaseline = "alphabetic";
  });
}

// 표: 파일에 든 표 스타일(tableStyles.xml)을 읽고, 없으면 PowerPoint 기본(보통 스타일 2 - 강조 1)처럼
function tableStyle(cx, id) {
  const doc = cx.pkg.xml("ppt/tableStyles.xml");
  const st = doc ? chs(doc.documentElement, "tblStyle").find(s => attr(s, "styleId") === id) : null;
  if (st) return st;
  if (id === "{2D5ABB26-0587-4C30-8999-92F81FD0307C}") return "none";
  if (id === "{5940675A-B579-460E-94D1-54222C63F5DA}") return "grid";
  return "default";
}
function partStyle(cx, st, partName) {
  if (!st || typeof st === "string") return null;
  const part = ch(st, partName);
  if (!part) return null;
  const tc = ch(part, "tcStyle"), tx = ch(part, "tcTxStyle");
  const fillN = ch(tc, "fill");
  const fill = fillN ? fillOf(fillN, cx) : (ch(tc, "fillRef") ? refFill(ch(tc, "fillRef"), cx) : null);
  const bdr = ch(tc, "tcBdr");
  const border = {};
  for (const side of ["left", "right", "top", "bottom", "insideH", "insideV"]) {
    const s = ch(bdr, side);
    if (s) border[side] = lineFrom(ch(s, "ln"), cx) || (ch(s, "lnRef") ? refLine(ch(s, "lnRef"), cx) : null);
  }
  return { fill, border, color: tx ? colorOf(tx, cx) || colorOf(ch(tx, "fontRef"), cx) : null, bold: tx ? attr(tx, "b") === "on" : null };
}
function drawTable(g, tbl, box, cx) {
  if (!tbl) return;
  const cols = chs(ch(tbl, "tblGrid"), "gridCol").map(c => num(attr(c, "w")));
  const rows = chs(tbl, "tr");
  if (!cols.length || !rows.length) return;
  const k = cx.k;
  const sumW = cols.reduce((a, b) => a + b, 0) || 1;
  const sx = (box.w || sumW) / sumW;
  const tblPr = ch(tbl, "tblPr");
  const firstRow = on(attr(tblPr, "firstRow")), bandRow = on(attr(tblPr, "bandRow"));
  const sid = q(tblPr, "tableStyleId")?.textContent?.trim() || "";
  const st = tableStyle(cx, sid);
  const P = name => partStyle(cx, st, name);
  const whole = P("wholeTbl"), band1 = bandRow ? P("band1H") : null, band2 = bandRow ? P("band2H") : null, head = firstRow ? P("firstRow") : null;
  const accent = colorOf({ localName: "schemeClr", getAttribute: () => "accent1", firstElementChild: null }, cx);
  const tint = (c, t) => ({ r: Math.round(c.r * t + 255 * (1 - t)), g: Math.round(c.g * t + 255 * (1 - t)), b: Math.round(c.b * t + 255 * (1 - t)), a: 1 });
  const white = { r: 255, g: 255, b: 255, a: 1 };
  // 열 x (px)
  const xs = [0]; for (const w of cols) xs.push(xs[xs.length - 1] + w * sx * k);
  // 행 높이: 지정 높이와 글자 높이 중 큰 쪽
  const off = document.createElement("canvas").getContext("2d");
  const cellInfo = (r, ri) => {
    let bodyIdx = firstRow ? ri - 1 : ri;
    const isHead = firstRow && ri === 0;
    let fill = null, color = null, bold = null, border = {};
    const apply = s => { if (!s) return; if (s.fill) fill = s.fill; if (s.color) color = s.color; if (s.bold != null) bold = s.bold; Object.assign(border, s.border); };
    if (st === "default") {
      if (isHead) { fill = { kind: "solid", color: accent }; color = white; bold = true; }
      else fill = { kind: "solid", color: tint(accent, bandRow && bodyIdx % 2 === 0 ? 0.4 : 0.2) };
      const wl = { color: white, w: 12700 };
      border = { left: wl, right: wl, top: wl, bottom: wl, insideH: wl, insideV: wl };
    } else if (st === "grid") {
      const bl = { color: { r: 0, g: 0, b: 0, a: 1 }, w: 12700 };
      border = { left: bl, right: bl, top: bl, bottom: bl, insideH: bl, insideV: bl };
    } else if (st !== "none") {
      apply(whole);
      if (!isHead && bodyIdx >= 0 && bandRow) apply(bodyIdx % 2 === 0 ? band1 : band2);
      if (isHead) apply(head);
    }
    return { fill, color, bold, border };
  };
  const tcs = rows.map(r => chs(r, "tc"));
  const hs = rows.map((r, ri) => {
    let hgt = num(attr(r, "h")) * k;
    tcs[ri].forEach((tc, ci) => {
      if (on(attr(tc, "hMerge")) || on(attr(tc, "vMerge")) || num(attr(tc, "rowSpan"), 1) > 1) return;
      const span = num(attr(tc, "gridSpan"), 1);
      const tcPr = ch(tc, "tcPr");
      const w = xs[Math.min(xs.length - 1, ci + span)] - xs[ci];
      const lI = num(attr(tcPr, "marL"), 91440) * k, rI = num(attr(tcPr, "marR"), 91440) * k, tI = num(attr(tcPr, "marT"), 45720) * k, bI = num(attr(tcPr, "marB"), 45720) * k;
      const txBody = ch(tc, "txBody");
      if (!txBody) return;
      const info = cellInfo(r, ri);
      const L = layoutParas(off, chs(txBody, "p"), Math.max(4, w - lI - rI), true, cx, { kind: "other", fontColor: info.color, bold: info.bold }, [ch(txBody, "lstStyle")].filter(Boolean), [cx.masterStyle("other"), cx.defaultStyle].filter(Boolean), 1, 0);
      hgt = Math.max(hgt, L.height + tI + bI);
    });
    return hgt;
  });
  const ys = [0]; for (const h of hs) ys.push(ys[ys.length - 1] + h);
  g.save();
  g.translate(box.x * k, box.y * k);
  // 채우기 → 글자 → 테두리
  const borders = [];
  rows.forEach((r, ri) => {
    tcs[ri].forEach((tc, ci) => {
      if (on(attr(tc, "hMerge")) || on(attr(tc, "vMerge"))) return;
      const span = num(attr(tc, "gridSpan"), 1), rspan = num(attr(tc, "rowSpan"), 1);
      const x0 = xs[ci], x1 = xs[Math.min(xs.length - 1, ci + span)], y0 = ys[ri], y1 = ys[Math.min(ys.length - 1, ri + rspan)];
      const tcPr = ch(tc, "tcPr");
      const info = cellInfo(r, ri);
      const own = fillOf(tcPr, cx);
      const fill = own || info.fill;
      if (fill && fill.kind !== "none") { g.beginPath(); g.rect(x0, y0, x1 - x0, y1 - y0); g.save(); g.translate(x0, y0); paint(g, fill, x1 - x0, y1 - y0, cx); g.restore(); }
      const txBody = ch(tc, "txBody");
      if (txBody) {
        const lI = num(attr(tcPr, "marL"), 91440), rI = num(attr(tcPr, "marR"), 91440), tI = num(attr(tcPr, "marT"), 45720), bI = num(attr(tcPr, "marB"), 45720);
        const fake = { getAttribute: n => ({ lIns: lI, rIns: rI, tIns: tI, bIns: bI, anchor: attr(tcPr, "anchor") || "t" })[n] ?? null, firstElementChild: null, localName: "bodyPr" };
        g.save(); g.translate(x0, y0);
        drawText(g, txBody, x1 - x0, y1 - y0, cx, { kind: "other", chain: [], fontColor: info.color, bold: info.bold, bodyPrs: [fake] });
        g.restore();
      }
      const side = (name, fallback) => lineFrom(ch(tcPr, name), cx, null, info.border[fallback[0]] || info.border[fallback[1]] || null);
      borders.push([side("lnL", [ci === 0 ? "left" : "insideV"]), x0, y0, x0, y1]);
      borders.push([side("lnR", [ci + span >= cols.length ? "right" : "insideV"]), x1, y0, x1, y1]);
      borders.push([side("lnT", [ri === 0 ? "top" : "insideH"]), x0, y0, x1, y0]);
      borders.push([side("lnB", [ri + rspan >= rows.length ? "bottom" : "insideH"]), x0, y1, x1, y1]);
    });
  });
  for (const [ln, a, b, c, d] of borders) {
    if (!ln || ln.none || !ln.color) continue;
    g.beginPath(); g.moveTo(a, b); g.lineTo(c, d);
    strokeLine(g, ln, cx);
  }
  g.restore();
}

// ── 배경 ──
async function drawBackground(g, cx, docs, W, H) {
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, W, H);
  for (const { doc, part } of docs) {
    const bg = doc ? q(doc.documentElement, "cSld", "bg") : null;
    if (!bg) continue;
    const sub = { ...cx, part };
    const bgPr = ch(bg, "bgPr");
    let fill = bgPr ? fillOf(bgPr, sub) : refFill(ch(bg, "bgRef"), sub);
    fill = await loadFill(fill, sub);
    if (!fill) continue;
    cx.bgFill = fill;
    g.beginPath(); g.rect(0, 0, W, H);
    paint(g, fill, W, H, sub);
    return;
  }
}

// ── 공개 API ──
// openPptx(ArrayBuffer) → { count, aspect, render(i, widthPx) → canvas, close() }
export async function openPptx(buf) {
  const { unzipSync } = await loadFflate();
  let files;
  try { files = unzipSync(new Uint8Array(buf)); } catch (_) { throw new Error("PowerPoint 파일을 열지 못했어요"); }
  const pkg = new Pkg(files);
  const presPath = "ppt/presentation.xml";
  const pres = pkg.xml(presPath);
  if (!pres) throw new Error("PowerPoint(.pptx) 파일이 아니에요");
  const root = pres.documentElement;
  const sz = ch(root, "sldSz");
  const cxE = num(attr(sz, "cx"), 12192000), cyE = num(attr(sz, "cy"), 6858000);
  const prels = pkg.rels(presPath);
  const slidePaths = chs(ch(root, "sldIdLst"), "sldId").map(s => prels.get(attr(s, "r:id"))?.path).filter(Boolean)
    .filter(p => attr(pkg.xml(p)?.documentElement, "show") !== "0"); // 숨긴 슬라이드 빼기
  const defaultStyle = ch(root, "defaultTextStyle");
  return {
    count: slidePaths.length,
    aspect: cxE / cyE,
    async render(i, width = 2400) {
      const part = slidePaths[i];
      const slide = pkg.xml(part);
      if (!slide) throw new Error(`${i + 1}번 슬라이드를 읽지 못했어요`);
      const layoutPath = pkg.relOfType(part, /slideLayout$/);
      const layout = pkg.xml(layoutPath);
      const masterPath = layoutPath ? pkg.relOfType(layoutPath, /slideMaster$/) : null;
      const master = pkg.xml(masterPath);
      const themePath = masterPath ? pkg.relOfType(masterPath, /theme$/) : null;
      const theme = readTheme(pkg.xml(themePath));
      // 색 대응: 마스터 clrMap, 레이아웃·슬라이드가 덮어쓰면 그쪽
      const mapOf = n => { const m = {}; if (n) for (const a of n.attributes) m[a.localName] = a.value; return m; };
      let clrMap = mapOf(q(master?.documentElement, "clrMap"));
      for (const d of [layout, slide]) { const o = q(d?.documentElement, "clrMapOvr", "overrideClrMapping"); if (o) clrMap = mapOf(o); }
      const txStyles = q(master?.documentElement, "txStyles");
      const W = Math.round(width), H = Math.round((width * cyE) / cxE);
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      const g = cv.getContext("2d");
      const cx = {
        pkg, theme, clrMap, k: W / cxE, slideNo: i + 1, layout, master, part, level: "slide", grpFill: null, bgFill: null, themePath,
        defaultStyle,
        masterStyle: kind => ch(txStyles, kind === "title" ? "titleStyle" : kind === "body" ? "bodyStyle" : "otherStyle"),
      };
      // 글꼴(Pretendard 하위 묶음)을 먼저 받아 둔다 — 캔버스는 글꼴을 스스로 내려받지 않는다
      try {
        const text = [slide, layout, master].filter(Boolean).map(d => d.documentElement.textContent || "").join(" ").slice(0, 4000);
        if (document.fonts?.load) await Promise.all(["400", "700"].map(wt => document.fonts.load(`${wt} 20px "Pretendard Variable"`, text || "가A")));
      } catch (_) { /* 글꼴 없이도 그린다 */ }
      await drawBackground(g, cx, [{ doc: slide, part }, { doc: layout, part: layoutPath }, { doc: master, part: masterPath }], W, H);
      const showMaster = attr(slide.documentElement, "showMasterSp") !== "0";
      if (showMaster && master && attr(layout?.documentElement, "showMasterSp") !== "0") await drawTree(g, treeOf(master), { ...cx, part: masterPath, level: "master" });
      if (showMaster && layout) await drawTree(g, treeOf(layout), { ...cx, part: layoutPath, level: "layout" });
      await drawTree(g, treeOf(slide), cx);
      return cv;
    },
    close() { pkg.close(); },
  };
}
