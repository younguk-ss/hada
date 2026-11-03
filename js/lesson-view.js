// 슬라이드 프레임 렌더(필기 레이어) — 편집기·교사 진행·학생·기록 화면 공용.
//
// scope:
//   "edit"       — 편집기: slide.strokes/texts에 직접 기록, onChange 호출(편집기가 수업 저장)
//   "whole"      — 전체 공유 레이어 (records.__whole[slideId])
//   "individual" — 학생별 (records[studentId][slideId])
//   "group"      — 모둠별 (records.__groups[groupId][slideId])
//   "ppt"/"bg"   — 배경만(읽기 전용)
//
// Rec = { strokes, texts, removed } — removed는 지운 id(tombstone). 병합은 cloud.js applyRecord 담당.
// 가정: 지운 텍스트 id도 removed에 넣는다(병합 시 되살아나지 않게). 렌더 시 removed의 텍스트도 제외.
// 가정: 텍스트 글자 크기는 기준 폭 960px 대비 비율(cqw)로 그린다 → 화면 크기와 무관하게 같은 위치·비율.
// 가정: 텍스트 블록은 텍스트 도구일 때만 탭/편집 가능(펜일 때는 위에 필기 가능).
// 가정: 확대 중에 만든 텍스트는 배율만큼 작은 글자 크기로 저장(펜 획과 같은 규칙, canvas.js 7).
// 가정: edit 외 scope에서는 slide.strokes/texts(편집기 기본 필기, 스냅샷에 포함)를 바닥 레이어로 함께 그린다.
//       기본 획은 지우개로 지우면 그 scope의 removed에만 기록(원본 불변). 전체 지우기는 Rec만 비운다.
// 가정: id 없는 레거시 기본 획은 '#<i>'(i < 기본 획 수, 순서 불변)로 removed에 기록 가능. Rec 쪽 '#' 키는 불안정해 기록 안 함.
// 가정: individual/group인데 scopeId가 없으면(구버전 호출) 빈 읽기 전용으로 그린다.
// 텍스트 부분 색(v2.10): 글자 일부를 고르고 도구바 색을 누르면 그 부분만 그 색(Text.runs, canvas.js 11). 글 상자 안은 색 조각마다
//       <span data-c>이고, 입력할 때마다 DOM을 읽어 runs·value를 다시 만든다(줄바꿈은 글자 \n·<br>·<div> 모두 받음).
//       색 버튼은 pointerdown을 막아 선택이 풀리지 않게 하고, 혹시 풀려도 4초 안의 마지막 선택을 쓴다. 전부 한 색이면 runs 없이 color만.
// 도형(v2.10): 도구 'shape' + setShape(종류) → InkCanvas가 그림(canvas.js 10).
// 가정(v2.6.1): 텍스트 블록은 텍스트 도구일 때만 편집 가능(contenteditable). 펜 도구일 때 편집 가능한 칸이 화면에 있으면
//       iPad의 Scribble(펜 손글씨 → 글자 입력)이 근처 필기를 가로채 글자 칸이 선택되는 일이 있어서 끈다.
// zoom: true → root(스테이지)가 확대·이동 뷰포트가 된다(js/zoom-view.js). 캔버스는 프레임 밖에서 뷰포트 전체를 덮고
//       보기 변환으로 그리며, 프레임(배경·텍스트)은 확대된 실제 크기로 배치된다. 호출 쪽은 fitFrame을 쓰지 않는다.
// 텍스트 상자(v2.8, 학생·교사 공통 — 텍스트 도구일 때): 글자 칸을 누르면 선택 테두리가 생기고
//       왼쪽 위 ✥ 끌기 = 옮기기, 오른쪽 아래 ↘ 끌기 = 칸 크기(폭 w · 최소 높이 h, 프레임 비율), 위 작은 막대 = 글자 작게·크게·지우기.
//       선택한 칸은 도구바의 색·S/M/L도 바로 따른다. 옮기기·크기는 손을 뗄 때 저장(ts 갱신 → 병합에서 최신이 이김).
//       w가 없으면 예전처럼 글자에 맞춰 늘어남(최대 70%). 미니·인쇄(canvas.js drawTextBox)도 같은 칸 폭으로 줄바꿈.
// 가정: 컨테이너 단위(cqw)를 모르는 구형 브라우저는 글자 크기를 프레임 폭 기준 px로 계산해 넣고 프레임 크기가 바뀌면 다시 맞춘다.
// 놓인 이미지(v2.10, slide.config.images): 배경 위·필기 아래 레이어. Img = { id, url, path, x, y, w, ar } — x·y는 왼쪽 위(프레임 정규화),
//       w는 프레임 폭 비율, ar은 가로/세로(높이 = w × 1.6 / ar). 모든 scope에서 그리고, 편집기(edit)의 '이미지' 도구일 때만
//       끌어서 옮기기·모서리로 크기(비율 유지)·× 삭제·Delete 키. 이미지 파일은 지우지 않는다(지난 수업 스냅샷이 같은 URL을 참조).

import { el } from "./ui.js";
import { InkCanvas, strokeKey, textRuns } from "./canvas.js";
import { store } from "./store.js";
import { cloudWriteRecord } from "./cloud.js";
import { newId, injectCss } from "./slides/registry.js";
import { createZoomView } from "./zoom-view.js";

const BASE_CSS = `
:where(.slide-frame) { position:relative; aspect-ratio:16/10; background:#fff; overflow:hidden; }
.slide-frame > img.bg { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; pointer-events:none; user-select:none; -webkit-user-drag:none; }
.img-layer { position:absolute; inset:0; pointer-events:none; }
.img-layer > img.slide-img { position:absolute; display:block; max-width:none; object-fit:fill; pointer-events:none; user-select:none; -webkit-user-drag:none; }
.slide-frame.tool-image { cursor:default; }
.slide-frame.tool-image .img-layer > img.slide-img { pointer-events:auto; cursor:move; touch-action:none; }
@media (hover: hover) { .slide-frame.tool-image .img-layer > img.slide-img:hover { outline:2px dashed var(--accent); outline-offset:-1px; } }
.img-sel { position:absolute; z-index:3; pointer-events:none; box-shadow:0 0 0 2px var(--accent); }
.img-sel[hidden] { display:none; }
.img-sel > .img-h { position:absolute; width:22px; height:22px; margin:-11px 0 0 -11px; padding:0; border-radius:50%; background:#fff;
  border:2.5px solid var(--accent); box-shadow:0 1px 3px rgba(0,0,0,.25); pointer-events:auto; touch-action:none; }
.img-sel > .img-h::before { content:""; position:absolute; inset:-10px; } /* 손가락 닿는 곳 넓게 */
.img-sel > .img-h.nw { left:0; top:0; cursor:nwse-resize; } .img-sel > .img-h.ne { left:100%; top:0; cursor:nesw-resize; }
.img-sel > .img-h.sw { left:0; top:100%; cursor:nesw-resize; } .img-sel > .img-h.se { left:100%; top:100%; cursor:nwse-resize; }
.img-sel > .img-del { position:absolute; right:8px; top:8px; width:34px; height:34px; padding:0; border:0; border-radius:50%;
  display:grid; place-items:center; background:var(--danger); color:#fff; box-shadow:0 1px 4px rgba(0,0,0,.3); pointer-events:auto; cursor:pointer; }
.slide-frame > canvas { position:absolute; inset:0; width:100%; height:100%; touch-action:none; }
.slide-frame > .text-layer { position:absolute; inset:0; pointer-events:none; container-type:size; }
.slide-frame .text-block { position:absolute; pointer-events:none; min-width:4em; max-width:70%; padding:.3em .45em; line-height:1.3;
  white-space:pre-wrap; word-break:break-word; border:1px dashed transparent; border-radius:6px; outline:none; background:transparent; }
.slide-frame.tool-text { cursor:text; }
.slide-frame.tool-text .text-block { pointer-events:auto; }
.slide-frame.tool-text .text-block.is-base { pointer-events:none; }
.slide-frame.tool-text .text-block:hover, .slide-frame .text-block:focus { border-color:var(--accent); background:rgba(255,255,255,.65); }
.slide-frame.tool-text .text-block.is-sel { background:rgba(255,255,255,.65); }
/* 텍스트 상자 선택 테두리 · 옮기기/칸 크기 손잡이 · 글자 크기 막대 (화면 px 고정 — 프레임은 확대된 실제 크기로 배치됨) */
.slide-frame .tx-sel { position:absolute; z-index:3; pointer-events:none; border:2px solid var(--accent); border-radius:7px; }
.slide-frame .tx-sel[hidden] { display:none; }
.tx-sel .tx-h { position:absolute; width:32px; height:32px; margin:0; padding:0; border:2px solid #fff; border-radius:50%; background:var(--accent); color:#fff;
  display:grid; place-items:center; pointer-events:auto; touch-action:none; box-shadow:0 1px 5px rgba(0,0,0,.28); }
.tx-sel .tx-h svg { width:16px; height:16px; pointer-events:none; }
.tx-sel .tx-move { left:-17px; top:-17px; cursor:move; }
.tx-sel .tx-resize { right:-17px; bottom:-17px; cursor:nwse-resize; }
.tx-sel .tx-bar { position:absolute; left:20px; bottom:calc(100% + 10px); display:flex; align-items:center; gap:2px; padding:3px; border-radius:10px;
  background:var(--surface, #fff); border:1px solid var(--line, #e5e5e5); box-shadow:0 4px 16px rgba(20,20,30,.16); pointer-events:auto; white-space:nowrap; }
.tx-sel.bar-below .tx-bar { bottom:auto; top:calc(100% + 10px); }
.tx-sel .tx-bar button { min-width:36px; height:36px; padding:0 6px; border:0; border-radius:8px; background:transparent; color:var(--ink-2, #333);
  font:700 14px/1 var(--font, sans-serif); display:grid; place-items:center; cursor:pointer; touch-action:manipulation; }
.tx-sel .tx-bar button svg { width:18px; height:18px; pointer-events:none; }
.tx-sel .tx-bar .tx-small { font-size:12px; }
.tx-sel .tx-bar .tx-big { font-size:18px; }
.tx-sel .tx-bar .tx-del { color:var(--danger, #b91c1c); }
.tx-sel .tx-fs { min-width:28px; text-align:center; font:600 12px/1 var(--font, sans-serif); color:var(--muted, #888); font-variant-numeric:tabular-nums; }
.tx-sel .tx-sep { width:1px; height:20px; background:var(--line, #e5e5e5); margin:0 2px; }
@media (hover:hover) { .tx-sel .tx-bar button:hover { background:var(--surface-2, #f3f3f3); } }
.zoom-view { position:relative; overflow:hidden; display:block !important; padding:0 !important; touch-action:none; -webkit-user-select:none; user-select:none; }
.zoom-view, .zoom-view * { touch-action:none !important; }
.zoom-view > .slide-frame { position:absolute; margin:0 !important; max-width:none !important; transform-origin:0 0; }
.zoom-view > canvas.ink-view { position:absolute; left:0; top:0; width:100%; height:100%; transform-origin:0 0; z-index:1; }
`;

// ── 글 상자 안 색 조각(v2.10) ──
const textSig = (t) => String(t.value || "") + "\u0001" + (textRuns(t) ? JSON.stringify(t.runs) : "");
// 글 상자 DOM을 그 텍스트로(색 조각은 <span data-c>)
function fillTextEl(node, t) {
  node._sig = textSig(t);
  const runs = textRuns(t);
  if (!runs) { node.textContent = t.value || ""; return; }
  node.replaceChildren(...runs.map(r => (r.c ? el("span", { "data-c": r.c, style: { color: r.c } }, r.t) : document.createTextNode(r.t))));
}
function cssHex(v) {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v || "");
  return m ? "#" + m.slice(1, 4).map(n => (+n).toString(16).padStart(2, "0")).join("") : (v || null);
}
// DOM → { runs:[{t, c}], at:[points의 글자 위치] }. 마지막 줄바꿈 하나는 뺀다(contenteditable이 붙이는 것)
function scanText(root, points = []) {
  const runs = [], at = points.map(() => null);
  let len = 0;
  const push = (t, c) => {
    if (!t) return;
    const last = runs[runs.length - 1];
    if (last && last.c === c) last.t += t; else runs.push({ t, c });
    len += t.length;
  };
  const endsNL = () => { const last = runs[runs.length - 1]; return !last || last.t.endsWith("\n"); };
  const mark = (node, i) => points.forEach((p, k) => { if (at[k] == null && p.node === node && p.offset === i) at[k] = len; });
  const walk = (node, c) => {
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      mark(node, i);
      const ch = kids[i];
      if (ch.nodeType === 3) {
        points.forEach((p, k) => { if (at[k] == null && p.node === ch) at[k] = len + Math.min(p.offset, ch.data.length); });
        push(ch.data, c);
      } else if (ch.nodeName === "BR") push("\n", c);
      else if (ch.nodeType === 1) {
        if (/^(DIV|P|LI)$/.test(ch.nodeName) && !endsNL()) push("\n", c);
        const own = ch.getAttribute("data-c") || (ch.style && ch.style.color ? cssHex(ch.style.color) : null);
        walk(ch, own || c);
      }
    }
    mark(node, kids.length);
  };
  walk(root, null);
  const last = runs[runs.length - 1];
  if (last && last.t.endsWith("\n")) { last.t = last.t.slice(0, -1); if (!last.t) runs.pop(); }
  return { runs, at };
}
// 조각 → t.value·t.runs(정리: 같은 색 합치기, 글 상자 색과 같으면 null, 전부 한 색이면 color로)
function setTextRuns(t, runs) {
  const base = (t.color || "#1c1c22").toLowerCase();
  const out = [];
  for (const r of runs) {
    if (!r.t) continue;
    const c = r.c && r.c.toLowerCase() !== base ? r.c : null;
    const last = out[out.length - 1];
    if (last && last.c === c) last.t += r.t; else out.push({ t: r.t, c });
  }
  t.value = out.map(r => r.t).join("");
  if (out.length === 1 && out[0].c) { t.color = out[0].c; delete t.runs; }
  else if (out.some(r => r.c)) t.runs = out;
  else delete t.runs;
}
// 글자 위치 s..e를 선택(fillTextEl로 그린 DOM)
function selectTextRange(root, s, e) {
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0, a = null, b = null, n;
  while ((n = tw.nextNode())) {
    const L = n.data.length;
    if (!a && s <= pos + L) a = [n, s - pos];
    if (!b && e <= pos + L) { b = [n, e - pos]; break; }
    pos += L;
  }
  if (!a || !b) return;
  const sel = document.getSelection();
  const r = document.createRange();
  r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]);
  sel.removeAllRanges(); sel.addRange(r);
}

// 펜 굵기 → 글자 크기(기준 폭 960px)
function textSizeFor(size) { return size <= 2.5 ? 18 : size <= 4 ? 24 : 32; }

// 텍스트 상자(v2.8)
const CQ_OK = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("width", "1cqw");
const TX_MIN_W = 0.05, TX_MIN_H = 0.04; // 칸 최소 크기(프레임 비율)
const TX_MIN_FS = 2, TX_MAX_FS = 160;   // 글자 크기 범위(기준 폭 960px)
const r4 = (v) => Math.round(v * 10000) / 10000;
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const TX_ICON = {
  move: svg('<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>'),
  size: svg('<path d="M9 20h11V9"/><path d="M20 20L9 9"/>'),
  trash: svg('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>'),
};

const EMPTY = () => ({ strokes: [], texts: [], removed: [] });

const FRAME_A = 1.6; // 슬라이드 16:10

// 놓인 이미지 목록(그릴 수 있는 것만)
export function slideImages(slide) {
  const a = slide && slide.config && slide.config.images;
  return Array.isArray(a) ? a.filter(im => im && im.url && im.w > 0 && im.ar > 0) : [];
}
function placeImg(node, im) {
  node.style.left = (im.x * 100) + "%";
  node.style.top = (im.y * 100) + "%";
  node.style.width = (im.w * 100) + "%";
  node.style.height = (im.w * FRAME_A / im.ar * 100) + "%";
}
// 썸네일·미니 프레임용 이미지 레이어(16:10 상자 안에 넣음). 이미지가 없으면 null
export function imageLayer(slide, { lazy = false } = {}) {
  const list = slideImages(slide);
  if (!list.length) return null;
  injectCss("lesson-view", BASE_CSS);
  return el("div", { class: "img-layer" }, list.map(im => {
    const node = el("img", { class: "slide-img", src: im.url, alt: "", decoding: "async", draggable: "false", ...(lazy ? { loading: "lazy" } : {}) });
    placeImg(node, im);
    return node;
  }));
}

export function renderSlide({ root, slide, session, scope, scopeId, readOnly, authorId, onChange, zoom = false, zoomInclude = null }) {
  injectCss("lesson-view", BASE_CSS);
  const noScopeId = (scope === "individual" || scope === "group") && !scopeId;
  const writable = !readOnly && !noScopeId && scope !== "ppt" && scope !== "bg";
  const frame = el("div", { class: "slide-frame" + (writable ? "" : " readonly") });
  let img = null;
  const canvas = el("canvas", zoom ? { class: "ink-view" } : {});
  const imgLayer = el("div", { class: "img-layer" });
  const textLayer = el("div", { class: "text-layer" });
  frame.appendChild(imgLayer);
  syncBg();
  if (!zoom) frame.appendChild(canvas);
  frame.appendChild(textLayer);
  root.replaceChildren(frame);
  if (zoom) { root.classList.add("zoom-view"); root.appendChild(canvas); }

  let textMode = false;
  let curTool = "pen";
  let savedSel = null; // 글 상자에서 마지막으로 고른 부분 { key, s, e, at }
  let imgMode = false; // 편집기 '이미지' 도구
  let textSize = 18;
  let textTimer = 0;
  let pendingRefresh = false;
  let destroyed = false;
  let lastSig = null; // 마지막으로 그린 Rec 서명 (doRefresh 가 초기 렌더에서 쓰므로 먼저 선언)
  const textEls = new Map(); // key → node
  // 놓인 이미지 상태(초기 doRefresh가 쓰므로 먼저 선언)
  const editImgs = scope === "edit" && writable;
  const imgEls = new Map(); // id → <img>
  let selImg = null;        // 선택한 이미지 id(이미지 도구일 때만)
  let imgSelBox = null, imgDrag = null;
  // 바닥 레이어(편집기 기본 필기)
  const base = scope === "edit" ? { strokes: [], texts: [] }
    : { strokes: Array.isArray(slide.strokes) ? slide.strokes : [], texts: Array.isArray(slide.texts) ? slide.texts : [] };
  const baseN = base.strokes.length;

  const ink = new InkCanvas(canvas, {
    readOnly: !writable,
    authorId,
    onCommit: (ev) => commit(ev),
    onEnd: () => {
      if (pendingRefresh) { pendingRefresh = false; setTimeout(() => { if (!destroyed) doRefresh(); }, 16); }
    },
  });

  const zv = zoom ? createZoomView({ viewport: root, frame, canvas, ink, getImg: () => img, src: slide.thumb || slide.bg, include: zoomInclude }) : null;
  let zvSrc = slide.bg || null;

  // 텍스트 상자 선택(v2.8) — 쓸 수 있는 화면에서만
  let selKey = null;      // 선택한 텍스트 id
  let txDrag = null;      // 옮기기·칸 크기 끄는 중 { kind, id, key, sx, sy, kx, ky, x, y, w, h, moved }
  let barDown = false;    // 막대 버튼을 누르는 중(그 사이 blur로 빈 칸이 지워지지 않게)
  const selBox = writable ? makeSelBox() : null;
  if (selBox) textLayer.appendChild(selBox);
  const selRO = selBox ? new ResizeObserver(() => placeSel()) : null;
  if (selRO) selRO.observe(textLayer);
  // cqw를 모르는 브라우저: 프레임 크기가 바뀌면 글자 크기(px)를 다시 맞춤
  const fontRO = CQ_OK ? null : new ResizeObserver(() => {
    const rec = pathFor(false);
    const byKey = new Map();
    base.texts.forEach((t, i) => { if (t) byKey.set("b:" + (t.id || i), t); });
    (rec.texts || []).forEach((t, i) => { if (t) byKey.set(t.id || ("#t" + i), t); });
    for (const [k, node] of textEls) { const t = byKey.get(k); if (t) placeText(node, t); }
    placeSel();
  });
  if (fontRO) fontRO.observe(frame);

  doRefresh();

  // 클로저의 session 대신 store의 최신 객체
  function freshSession() {
    if (!session || !session.id) return session || null;
    return (store.state.sessions || []).find(s => s.id === session.id) || session;
  }

  // 현재 Rec. create=false면 없을 때 빈 Rec(저장 안 됨)
  function pathFor(create = false) {
    if (scope === "edit") {
      if (!Array.isArray(slide.strokes)) slide.strokes = [];
      if (!Array.isArray(slide.texts)) slide.texts = [];
      return slide;
    }
    if (scope === "ppt" || scope === "bg" || noScopeId) return EMPTY();
    const ss = freshSession();
    if (!ss) return EMPTY();
    let bucket;
    if (scope === "whole") bucket = create ? (ss.records ||= {}, ss.records.__whole ||= {}) : ss.records?.__whole;
    else if (scope === "individual") bucket = create ? (ss.records ||= {}, ss.records[scopeId] ||= {}) : ss.records?.[scopeId];
    else if (scope === "group") bucket = create ? (ss.records ||= {}, ss.records.__groups ||= {}, ss.records.__groups[scopeId] ||= {}) : ss.records?.__groups?.[scopeId];
    if (!bucket) return EMPTY();
    let rec = bucket[slide.id];
    if (!rec) {
      if (!create) return EMPTY();
      rec = bucket[slide.id] = EMPTY();
    }
    if (!Array.isArray(rec.strokes)) rec.strokes = [];
    if (!Array.isArray(rec.texts)) rec.texts = [];
    if (!Array.isArray(rec.removed)) rec.removed = [];
    return rec;
  }

  function addRemoved(rec, ids) {
    if (scope === "edit") return;
    const have = new Set(rec.removed);
    for (const id of ids) {
      if (!id || have.has(id)) continue;
      if (id[0] === "#" && !(+id.slice(1) < baseN)) continue; // Rec 쪽 레거시 인덱스 키는 제외
      rec.removed.push(id); have.add(id);
    }
  }

  function commit(ev) {
    if (destroyed || !writable) return;
    const rec = pathFor(true);
    if (ev.type === "add") {
      rec.strokes.push(ev.stroke);
    } else if (ev.type === "erase") {
      const ids = new Set(ev.ids || []);
      // 레거시(id 없음)는 (바닥+Rec) 합친 배열의 인덱스 키 '#i'
      for (let i = rec.strokes.length - 1; i >= 0; i--) {
        if (ids.has(strokeKey(rec.strokes[i], i + baseN))) rec.strokes.splice(i, 1);
      }
      addRemoved(rec, ev.ids || []);
    }
    persist();
    // 레거시 '#i' 키가 밀리지 않게 캔버스 키를 Rec 기준으로 다시 맞춤
    if (ev.type === "erase") doRefresh();
  }

  function persist() {
    const rec = pathFor(true);
    if (scope === "edit") { onChange && onChange(rec); return; }
    const ss = freshSession();
    if (!ss) return;
    // 저장 예약(레코드 버전 갱신) 후 store 알림 → 갤러리 등이 최신 버전을 본다
    try {
      const p = cloudWriteRecord(ss.id, slide.id, scope, scope === "whole" ? ss.id : scopeId, rec);
      if (p && typeof p.catch === "function") p.catch(e => console.warn("[ink] 저장 실패", e));
    } catch (e) { console.warn("[ink] 저장 실패", e); }
    store.set(s => s);
    onChange && onChange(rec);
  }

  function schedulePersist() {
    clearTimeout(textTimer);
    textTimer = setTimeout(() => { textTimer = 0; persist(); }, 300);
  }
  function flushPersist() {
    if (!textTimer) return;
    clearTimeout(textTimer);
    textTimer = 0;
    persist();
  }

  // 배경 이미지 동기화 (편집기에서 교체 시)
  function syncBg() {
    const url = slide.bg || null;
    if (!url) { if (img) { img.remove(); img = null; } return; }
    if (!img) {
      img = el("img", { class: "bg", alt: "", decoding: "async", draggable: "false" });
      frame.insertBefore(img, frame.firstChild);
    }
    if (img.getAttribute("src") !== url) img.src = url;
  }

  // ── 놓인 이미지 ──
  function imgList() {
    if (!editImgs) return slideImages(slide);
    slide.config ||= {};
    if (!Array.isArray(slide.config.images)) slide.config.images = [];
    return slide.config.images;
  }
  function findImg(id) { return imgList().find(im => im && im.id === id) || null; }
  function renderImages() {
    const list = slideImages(slide);
    const seen = new Set();
    list.forEach((im, i) => {
      if (!im.id && editImgs) im.id = newId("im");
      const key = im.id || "#i" + i;
      seen.add(key);
      let node = imgEls.get(key);
      if (!node) {
        node = el("img", { class: "slide-img", alt: "", decoding: "async", draggable: "false" });
        if (editImgs) bindImg(node, key);
        imgEls.set(key, node);
      }
      if (node.getAttribute("src") !== im.url) node.src = im.url;
      placeImg(node, im);
      if (imgLayer.children[i] !== node) imgLayer.insertBefore(node, imgLayer.children[i] || null);
    });
    for (const [key, node] of imgEls) if (!seen.has(key)) { node.remove(); imgEls.delete(key); }
    if (selImg && !seen.has(selImg)) selImg = null;
    syncSel();
  }
  function syncSel() {
    if (!editImgs) return;
    const im = imgMode && selImg ? findImg(selImg) : null;
    if (!im) { if (imgSelBox) imgSelBox.hidden = true; return; }
    if (!imgSelBox) {
      const handle = (k) => {
        const h = el("span", { class: "img-h zv-own " + k, "aria-hidden": "true" });
        h.addEventListener("pointerdown", (e) => { const cur = findImg(selImg); if (cur) startImgDrag(e, cur, k); });
        return h;
      };
      const del = el("button", { type: "button", class: "img-del zv-own", title: "이미지 삭제", "aria-label": "이미지 삭제", onClick: (e) => { e.stopPropagation(); removeImg(selImg); } },
        el("span", { html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>' }));
      imgSelBox = el("div", { class: "img-sel" }, [handle("nw"), handle("ne"), handle("sw"), handle("se"), del]);
      frame.appendChild(imgSelBox);
    }
    imgSelBox.hidden = false;
    placeImg(imgSelBox, im);
  }
  function selectImg(id) { selImg = id || null; syncSel(); }
  function bindImg(node, id) {
    node.classList.add("zv-own"); // 확대 보기가 끌기를 이동으로 가로채지 않게
    node.addEventListener("pointerdown", (e) => {
      if (!imgMode || destroyed) return;
      const im = findImg(id);
      if (!im) return;
      selectImg(id);
      startImgDrag(e, im, "move");
    });
  }
  // 끌기: move = 옮기기, nw·ne·sw·se = 그 모서리로 크기(맞은편 모서리 고정, 비율 유지)
  function startImgDrag(e, im, kind) {
    if (destroyed || !imgMode || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault(); e.stopPropagation();
    if (imgDrag) imgDrag.end(false);
    const r = frame.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const pid = e.pointerId, sx = e.clientX, sy = e.clientY;
    const o = { x: im.x, y: im.y, w: im.w, h: im.w * FRAME_A / im.ar };
    let moved = false;
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
      moved = true;
      if (ev.cancelable) ev.preventDefault();
      const dx = (ev.clientX - sx) / r.width, dy = (ev.clientY - sy) / r.height;
      if (kind === "move") {
        // 가장자리에 조금은 남게(완전히 밖으로 나가 잃어버리지 않게)
        im.x = r4(clampN(o.x + dx, 0.04 - o.w, 0.96));
        im.y = r4(clampN(o.y + dy, 0.04 - o.h, 0.96));
      } else {
        // 끈 만큼을 대각선(고정 모서리 → 잡은 모서리) 방향으로 투영 → 배율
        const ex = kind.includes("e") ? 1 : -1, ey = kind.includes("s") ? 1 : -1;
        const wp = o.w * r.width, hp = o.h * r.height;
        const k = 1 + (ex * (ev.clientX - sx) * wp + ey * (ev.clientY - sy) * hp) / (wp * wp + hp * hp);
        const w = clampN(o.w * k, 0.04, 2);
        const h = w * FRAME_A / im.ar;
        im.w = r4(w);
        im.x = r4(ex > 0 ? o.x : o.x + o.w - w);
        im.y = r4(ey > 0 ? o.y : o.y + o.h - h);
      }
      const node = imgEls.get(im.id);
      if (node) placeImg(node, im);
      syncSel();
    };
    const end = (save) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      imgDrag = null;
      if (save && moved && !destroyed) persist();
    };
    const up = (ev) => { if (ev.pointerId === pid) end(true); };
    const cancel = (ev) => { if (ev.pointerId === pid) end(true); };
    imgDrag = { end };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }
  function removeImg(id) {
    const list = imgList();
    const i = list.findIndex(im => im && im.id === id);
    if (i < 0) return;
    list.splice(i, 1);
    selImg = null;
    renderImages();
    persist();
  }
  function onImgKey(e) {
    if (!imgMode || !selImg || destroyed || e.defaultPrevented) return;
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.documentElement.classList.contains("has-layer")) return;
    e.preventDefault();
    removeImg(selImg);
  }
  if (editImgs) {
    document.addEventListener("keydown", onImgKey);
    // 빈 곳을 누르면 선택 해제
    frame.addEventListener("click", (e) => {
      if (!imgMode || e.target.closest(".slide-img, .img-sel")) return;
      selectImg(null);
    });
  }

  // ── 텍스트 ──
  function findText(id) {
    return pathFor(false).texts.find(t => t.id === id) || null;
  }
  function placeText(node, t) {
    node.style.left = (t.x * 100) + "%";
    node.style.top = (t.y * 100) + "%";
    node.style.fontSize = CQ_OK ? ((t.size || 18) / 9.6).toFixed(3) + "cqw"
      : ((t.size || 18) * (frame.clientWidth || 960) / 960).toFixed(2) + "px";
    node.style.color = t.color || "#1c1c22";
    // 칸 크기(v2.8): w = 칸 폭, h = 최소 높이(프레임 비율). 없으면 글자에 맞춰 늘어남(최대 70%)
    node.style.width = t.w > 0 ? (t.w * 100) + "%" : "";
    node.style.maxWidth = t.w > 0 ? "none" : "";
    node.style.minHeight = t.h > 0 ? (t.h * 100) + "%" : "";
  }

  // ── 텍스트 상자 선택·옮기기·칸 크기·글자 크기(v2.8) ──
  function makeSelBox() {
    // 막대 버튼: 누르는 동안 입력 중인 글자 칸의 포커스를 지키고(키보드가 내려가지 않게), click에서 실행
    const btn = (cls, label, html, run) => {
      const b = el("button", { type: "button", class: cls, title: label, "aria-label": label, html });
      b.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); barDown = true; });
      b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); try { run(); } finally { barDown = false; } });
      b.addEventListener("pointercancel", () => { barDown = false; });
      return b;
    };
    const fsEl = el("span", { class: "tx-fs", "aria-live": "polite" }, "");
    const bar = el("div", { class: "tx-bar" }, [
      btn("tx-small", "글자 작게", "가−", () => bumpSize(-1)),
      fsEl,
      btn("tx-big", "글자 크게", "가+", () => bumpSize(1)),
      el("span", { class: "tx-sep" }),
      btn("tx-del", "글자 칸 지우기", TX_ICON.trash, () => removeText(selKey)),
    ]);
    const moveH = el("button", { type: "button", class: "tx-h tx-move", title: "끌어서 옮기기", "aria-label": "글자 칸 옮기기", html: TX_ICON.move });
    const sizeH = el("button", { type: "button", class: "tx-h tx-resize", title: "끌어서 칸 크기 바꾸기", "aria-label": "글자 칸 크기", html: TX_ICON.size });
    bindDrag(moveH, "move");
    bindDrag(sizeH, "size");
    const box = el("div", { class: "tx-sel", hidden: true }, [bar, moveH, sizeH]);
    box.addEventListener("click", (e) => e.stopPropagation()); // 손잡이·막대를 눌러도 새 글자 칸이 생기지 않게
    box.fsEl = fsEl;
    return box;
  }
  function select(key) {
    if (!selBox) return;
    if (selKey !== key) {
      const prev = selKey ? textEls.get(selKey) : null;
      if (prev) { prev.classList.remove("is-sel"); try { selRO.unobserve(prev); } catch (_) {} }
      selKey = key || null;
      const node = selKey ? textEls.get(selKey) : null;
      if (node) { node.classList.add("is-sel"); try { selRO.observe(node); } catch (_) {} }
    }
    placeSel();
  }
  // 선택 테두리를 글자 칸에 맞춤 — 글자 칸처럼 프레임 비율(%)로 둔다: 확대·맞춤으로 프레임 크기가 바뀌어도
  // 글자 칸(위치 %·글자 cqw)과 함께 커지고 줄어 어긋나지 않는다. 내용이 바뀔 때(입력·크기)만 다시 잰다.
  function placeSel() {
    if (!selBox || destroyed) return;
    const node = selKey ? textEls.get(selKey) : null;
    const t = selKey ? findText(selKey) : null;
    if (!textMode || !node || !t || !node.isConnected) { if (!selBox.hidden) selBox.hidden = true; return; }
    selBox.hidden = false;
    const lw = textLayer.clientWidth || 1, lh = textLayer.clientHeight || 1;
    const pct = (v) => (v * 100).toFixed(4) + "%";
    Object.assign(selBox.style, {
      left: pct(t.x || 0), top: pct(t.y || 0),
      width: pct(node.offsetWidth / lw), height: pct(node.offsetHeight / lh),
    });
    selBox.classList.toggle("bar-below", (t.y || 0) * lh < 56); // 위쪽 끝이면 막대를 아래로(프레임 밖으로 잘리지 않게)
    const fs = String(Math.round((t.size || 18) * 10) / 10);
    if (selBox.fsEl.textContent !== fs) selBox.fsEl.textContent = fs;
  }
  function bindDrag(h, kind) {
    h.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault(); e.stopPropagation(); // 글자 칸 포커스 유지 · 확대/이동·필기로 넘어가지 않게
      const t = selKey ? findText(selKey) : null, node = selKey ? textEls.get(selKey) : null;
      if (!t || !node || !writable || destroyed) return;
      const lw = textLayer.clientWidth || 1, lh = textLayer.clientHeight || 1;
      const r = textLayer.getBoundingClientRect(); // 화면 1px = 프레임 비율 얼마(확대 미리보기 transform까지 반영)
      txDrag = {
        kind, id: e.pointerId, key: selKey, sx: e.clientX, sy: e.clientY, kx: 1 / (r.width || lw), ky: 1 / (r.height || lh),
        x: t.x, y: t.y, w: node.offsetWidth / lw, h: node.offsetHeight / lh, moved: false,
      };
      try { h.setPointerCapture(e.pointerId); } catch (_) {}
    });
    h.addEventListener("pointermove", (e) => {
      const d = txDrag;
      if (!d || d.id !== e.pointerId) return;
      e.stopPropagation();
      const t = findText(d.key), node = textEls.get(d.key);
      if (!t || !node) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 2) return;
      d.moved = true;
      const dx = (e.clientX - d.sx) * d.kx, dy = (e.clientY - d.sy) * d.ky;
      if (d.kind === "move") {
        // 칸 전체가 프레임 안에 남게(오른쪽 끝에서 글자에 맞춘 칸이 좁아지며 줄이 바뀌지 않게)
        t.x = r4(clampN(d.x + dx, 0, Math.max(0, 1 - d.w)));
        t.y = r4(clampN(d.y + dy, 0, Math.max(0, 1 - d.h)));
      } else {
        t.w = r4(clampN(d.w + dx, TX_MIN_W, Math.max(TX_MIN_W, 1 - t.x)));
        t.h = r4(clampN(d.h + dy, TX_MIN_H, Math.max(TX_MIN_H, 1 - t.y)));
      }
      placeText(node, t);
      placeSel();
    });
    const end = (e) => {
      const d = txDrag;
      if (!d || d.id !== e.pointerId) return;
      txDrag = null;
      try { h.releasePointerCapture(e.pointerId); } catch (_) {}
      const t = findText(d.key), node = textEls.get(d.key);
      if (!t || !d.moved) return;
      t.ts = Date.now();
      clearTimeout(textTimer); textTimer = 0;
      persist();
      // 빈 칸을 먼저 키운 경우: 바로 쓸 수 있게 다시 입력 상태로
      if (node && !String(t.value || "").trim() && document.activeElement !== node) setTimeout(() => { if (!destroyed && node.isConnected) node.focus(); }, 0);
    };
    h.addEventListener("pointerup", end);
    h.addEventListener("pointercancel", end);
    h.addEventListener("lostpointercapture", end);
  }
  // 선택한 칸 바꾸기(색·글자 크기) — 입력과 같은 300ms 묶음 저장
  function setSelected(patch) {
    const t = selKey ? findText(selKey) : null, node = selKey ? textEls.get(selKey) : null;
    if (!t || !node) return;
    Object.assign(t, patch, { ts: Date.now() });
    placeText(node, t);
    placeSel();
    schedulePersist();
  }
  function bumpSize(dir) {
    const t = selKey ? findText(selKey) : null;
    if (!t) return;
    const s = t.size || 18;
    setSelected({ size: Math.round(clampN(dir > 0 ? s * 1.2 : s / 1.2, TX_MIN_FS, TX_MAX_FS) * 100) / 100 });
  }
  function removeText(key) {
    if (!key || !writable || destroyed) return;
    const rec = pathFor(true);
    const i = rec.texts.findIndex(x => x.id === key);
    if (i >= 0) rec.texts.splice(i, 1);
    addRemoved(rec, [key]);
    if (selKey === key) select(null);
    const node = textEls.get(key);
    textEls.delete(key);
    if (node) node.remove();
    clearTimeout(textTimer); textTimer = 0;
    persist();
  }
  // 텍스트 도구일 때만 편집 가능(그 밖에는 iPad Scribble이 펜 필기를 가로채지 않게)
  function setEditable(node, on) {
    if (!writable || !node || node.classList.contains("is-base")) return;
    if (on) {
      try { node.contentEditable = "plaintext-only"; } catch (_) {}
      if (node.contentEditable !== "plaintext-only") node.contentEditable = "true";
    } else {
      if (document.activeElement === node) node.blur(); // 입력 중이던 글자 저장(blur 처리)
      node.contentEditable = "false";
    }
  }
  function makeTextEl(key, t) {
    const tb = el("div", { class: "text-block", "data-key": key });
    if (writable) {
      setEditable(tb, textMode);
      tb.addEventListener("input", () => {
        if (destroyed) return;
        const cur = findText(key);
        if (!cur) return;
        setTextRuns(cur, scanText(tb).runs);
        cur.ts = Date.now();
        tb._sig = textSig(cur);
        schedulePersist();
        if (selKey === key) placeSel();
      });
      // 텍스트 도구에서 칸을 누르거나 입력 상태가 되면 선택(옮기기·칸 크기·글자 크기)
      tb.addEventListener("pointerdown", () => { if (textMode && !destroyed) select(key); });
      tb.addEventListener("focus", () => { if (textMode && !destroyed) select(key); });
      tb.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); tb.blur(); select(null); } });
      tb.addEventListener("blur", () => {
        if (destroyed) return;
        const cur = findText(key);
        // 빈 칸은 지운다 — 단, 손잡이로 끌거나 막대를 누르는 중이면 그대로(먼저 칸을 키우고 나서 쓸 수 있게)
        if (cur && !String(cur.value || "").trim() && !txDrag && !barDown) { removeText(key); return; }
        flushPersist();
      });
    }
    fillTextEl(tb, t);
    placeText(tb, t);
    return tb;
  }
  // 글 상자 안에서 지금 고른 부분 → { key, s, e } | null
  function liveTextSel() {
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const rng = sel.getRangeAt(0);
    const n = rng.commonAncestorContainer;
    const tb = (n.nodeType === 1 ? n : n.parentElement)?.closest?.(".text-block");
    if (!tb || tb.classList.contains("is-base") || !textLayer.contains(tb)) return null;
    const { at } = scanText(tb, [{ node: rng.startContainer, offset: rng.startOffset }, { node: rng.endContainer, offset: rng.endOffset }]);
    if (at[0] == null || at[1] == null || at[0] === at[1]) return null;
    return { key: tb.dataset.key, s: Math.min(at[0], at[1]), e: Math.max(at[0], at[1]) };
  }
  function onSelChange() {
    if (!textMode || destroyed) return;
    const t = liveTextSel();
    if (t) savedSel = { ...t, at: Date.now() };
  }
  // 고른 부분만 색 c로. 칠했으면 true
  function paintText(c) {
    if (!writable || !textMode || destroyed || !c) return false;
    let tgt = liveTextSel();
    if (!tgt && savedSel && Date.now() - savedSel.at < 4000) tgt = savedSel;
    const tb = tgt && textEls.get(tgt.key);
    const cur = tgt && findText(tgt.key);
    if (!tb || !cur || !tb.isConnected) return false;
    const { runs } = scanText(tb);
    const cols = [];
    for (const r of runs) for (let i = 0; i < r.t.length; i++) cols.push(r.c);
    const value = runs.map(r => r.t).join("");
    const s0 = Math.max(0, Math.min(tgt.s, value.length)), e0 = Math.max(0, Math.min(tgt.e, value.length));
    if (e0 <= s0) return false;
    for (let i = s0; i < e0; i++) cols[i] = c;
    const next = [];
    for (let i = 0; i < value.length; i++) {
      const last = next[next.length - 1];
      if (last && last.c === cols[i]) last.t += value[i]; else next.push({ t: value[i], c: cols[i] });
    }
    setTextRuns(cur, next);
    cur.ts = Date.now();
    fillTextEl(tb, cur);
    placeText(tb, cur);
    selectTextRange(tb, s0, e0);
    savedSel = { key: tgt.key, s: s0, e: e0, at: Date.now() };
    ink.setColor(c); // 이어서 오는 setColor(c)가 칸 전체를 이 색으로 바꾸지 않게(고른 글자만)
    clearTimeout(textTimer); textTimer = 0;
    persist();
    return true;
  }
  if (writable) document.addEventListener("selectionchange", onSelChange);
  function renderTexts() {
    const rec = pathFor(false);
    const rm = rec.removed && rec.removed.length ? new Set(rec.removed) : null;
    const seen = new Set();
    // 바닥 텍스트: 읽기 전용
    base.texts.forEach((t, i) => {
      if (!t || !t.value) return;
      const key = "b:" + (t.id || i);
      if (rm && t.id && rm.has(t.id)) return;
      seen.add(key);
      let node = textEls.get(key);
      if (!node) {
        node = el("div", { class: "text-block is-base" });
        textEls.set(key, node);
        textLayer.insertBefore(node, textLayer.firstChild);
      }
      if (node._sig !== textSig(t)) fillTextEl(node, t);
      placeText(node, t);
    });
    (rec.texts || []).forEach((t, i) => {
      if (!t) return;
      if (!t.id && writable) t.id = newId("tx"); // 레거시 텍스트에 id 부여
      const key = t.id || ("#t" + i);
      if (rm && rm.has(key)) return;
      seen.add(key);
      let node = textEls.get(key);
      if (!node) {
        node = makeTextEl(key, t);
        textEls.set(key, node);
        textLayer.appendChild(node);
      } else {
        if (document.activeElement !== node && node._sig !== textSig(t)) fillTextEl(node, t);
        placeText(node, t);
      }
    });
    for (const [key, node] of textEls) {
      if (!seen.has(key)) {
        if (key === selKey) select(null);
        node.remove(); textEls.delete(key);
      }
    }
    placeSel();
  }

  // 텍스트 도구: 빈 곳 탭 → 새 텍스트
  frame.addEventListener("click", (e) => {
    if (!textMode || !writable || destroyed) return;
    if (e.target !== frame && e.target !== canvas && e.target !== img && e.target !== textLayer) return;
    const r = frame.getBoundingClientRect();
    const t = {
      id: newId("tx"),
      by: authorId || null,
      x: Math.round(Math.min(0.95, Math.max(0, (e.clientX - r.left) / r.width)) * 10000) / 10000,
      y: Math.round(Math.min(0.95, Math.max(0, (e.clientY - r.top) / r.height)) * 10000) / 10000,
      value: "",
      // 확대 중이면 배율만큼 작게(화면에서 보이는 글자 크기 유지, 굿노트 식)
      size: clampN(Math.round(textSize / ink.zoomFactor() * 100) / 100, TX_MIN_FS, TX_MAX_FS),
      color: ink.color,
      ts: Date.now(),
    };
    pathFor(true).texts.push(t);
    const node = makeTextEl(t.id, t);
    textEls.set(t.id, node);
    textLayer.appendChild(node);
    select(t.id);
    setTimeout(() => node.focus(), 10);
  });

  // ── 새로고침: 그리는 중이면 끝난 직후 1회 ──
  // 가정: cloud.js가 병합/쓰기마다 비열거 rec._v를 올린다. individual 원격 반영은 배열을 통째 교체하므로 배열 identity·길이도 본다.
  //       edit scope(slide 직접 수정, _v 없음)는 캐시하지 않는다.
  function recSig(rec) {
    if (scope === "edit") return null;
    const empty = !rec.strokes.length && !rec.texts.length && !(rec.removed || []).length;
    return empty ? ["empty", slide.bg || null]
      : [rec, rec._v, rec.strokes, rec.strokes.length, rec.texts, rec.texts.length, rec.removed, (rec.removed || []).length, slide.bg || null];
  }
  function sameSig(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function doRefresh() {
    if (destroyed) return;
    syncBg();
    if (zv && (slide.bg || null) !== zvSrc) { zvSrc = slide.bg || null; zv.setSource(slide.thumb || slide.bg); }
    const rec = pathFor(false);
    ink.setStrokes(baseN ? base.strokes.concat(rec.strokes) : rec.strokes, rec.removed || []);
    renderTexts();
    renderImages();
    lastSig = recSig(rec);
  }
  // 외부(스토어 변경) 새로고침: 내 Rec이 그대로면 O(획 수) 작업 생략. 지우기/되돌리기/로컬 커밋은 doRefresh 직접.
  function refresh() {
    if (destroyed) return;
    if (ink.isDrawing()) { pendingRefresh = true; return; }
    if (lastSig && sameSig(lastSig, recSig(pathFor(false)))) return;
    doRefresh();
  }

  return {
    ink,
    frame,
    zoom: zv,
    setTool(t) {
      const was = curTool;
      curTool = t;
      textMode = t === "text";
      imgMode = t === "image" && editImgs;
      // 같은 도구로 다시 부르면(색·굵기 바꿀 때) 글 상자를 건드리지 않음 — 고른 글자가 풀리지 않게
      if ((was === "text") !== textMode) for (const node of [...textEls.values()]) setEditable(node, textMode);
      frame.classList.toggle("tool-text", textMode && writable);
      frame.classList.toggle("tool-image", imgMode);
      ink.setTool(textMode || t === "image" ? "pen" : t);
      ink.setReadOnly(!writable || textMode || t === "image");
      canvas.style.pointerEvents = textMode || imgMode ? "none" : "";
      if (!textMode) select(null); else placeSel();
      if (!imgMode) { imgDrag?.end(true); selImg = null; }
      syncSel();
    },
    // 편집기: 이미지 넣기(선택된 채로) · 개수
    addImage(im) {
      if (!editImgs || destroyed || !im || !im.url) return;
      if (!im.id) im.id = newId("im");
      imgList().push(im);
      selImg = im.id;
      renderImages();
      persist();
    },
    imageCount: () => slideImages(slide).length,
    // 텍스트 도구에서 색·S/M/L을 바꾸면 선택한 글자 칸에도 바로 반영(값이 바뀔 때만 — 도구바는 누를 때마다 셋 다 다시 넘긴다)
    setColor(c) {
      if (textMode && c !== ink.color) setSelected({ color: c });
      ink.setColor(c);
    },
    setShape(k) { ink.setShape(k); },
    // 글 상자에서 고른 글자만 색 바꾸기(텍스트 도구일 때, 도구바가 setColor보다 먼저 부름). 칠했으면 true
    paintText: (c) => paintText(c),
    setSize(s) {
      const ts = textSizeFor(s);
      if (textMode && ts !== textSize) setSelected({ size: Math.max(TX_MIN_FS, Math.round(ts / ink.zoomFactor() * 100) / 100) });
      ink.setSize(s); textSize = ts;
    },
    refresh,
    isDrawing: () => ink.isDrawing(),
    undo() { return writable ? ink.undo() : false; },
    // 이 레이어 전체 지우기 (records는 removed에 모든 id 기록)
    clearAll() {
      if (!writable) return;
      const rec = pathFor(true);
      addRemoved(rec, rec.strokes.map((s, i) => strokeKey(s, i + baseN)).concat(rec.texts.map(t => t && t.id)));
      rec.strokes.length = 0;
      rec.texts.length = 0;
      clearTimeout(textTimer); textTimer = 0;
      doRefresh();
      persist();
    },
    destroy() {
      if (destroyed) return;
      if (textTimer) flushPersist(); // 입력 중이던 텍스트 저장
      destroyed = true;
      try { selRO?.disconnect(); fontRO?.disconnect(); } catch (_) {}
      txDrag = null;
      imgDrag?.end(false);
      if (editImgs) document.removeEventListener("keydown", onImgKey);
      if (writable) document.removeEventListener("selectionchange", onSelChange);
      zv?.destroy();
      ink.destroy();
      textEls.clear();
      imgEls.clear();
      frame.remove();
      if (zoom) { canvas.remove(); root.classList.remove("zoom-view"); }
    },
  };
}
