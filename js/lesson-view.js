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
// 가정(v2.6.1): 텍스트 블록은 텍스트 도구일 때만 편집 가능(contenteditable). 펜 도구일 때 편집 가능한 칸이 화면에 있으면
//       iPad의 Scribble(펜 손글씨 → 글자 입력)이 근처 필기를 가로채 글자 칸이 선택되는 일이 있어서 끈다.
// zoom: true → root(스테이지)가 확대·이동 뷰포트가 된다(js/zoom-view.js). 캔버스는 프레임 밖에서 뷰포트 전체를 덮고
//       보기 변환으로 그리며, 프레임(배경·텍스트)은 확대된 실제 크기로 배치된다. 호출 쪽은 fitFrame을 쓰지 않는다.
// 텍스트 상자(v2.8, 학생·교사 공통 — 텍스트 도구일 때): 글자 칸을 누르면 선택 테두리가 생기고
//       왼쪽 위 ✥ 끌기 = 옮기기, 오른쪽 아래 ↘ 끌기 = 칸 크기(폭 w · 최소 높이 h, 프레임 비율), 위 작은 막대 = 글자 작게·크게·지우기.
//       선택한 칸은 도구바의 색·S/M/L도 바로 따른다. 옮기기·크기는 손을 뗄 때 저장(ts 갱신 → 병합에서 최신이 이김).
//       w가 없으면 예전처럼 글자에 맞춰 늘어남(최대 70%). 미니·인쇄(canvas.js drawTextBox)도 같은 칸 폭으로 줄바꿈.
// 가정: 컨테이너 단위(cqw)를 모르는 구형 브라우저는 글자 크기를 프레임 폭 기준 px로 계산해 넣고 프레임 크기가 바뀌면 다시 맞춘다.

import { el } from "./ui.js";
import { InkCanvas, strokeKey } from "./canvas.js";
import { store } from "./store.js";
import { cloudWriteRecord } from "./cloud.js";
import { newId, injectCss } from "./slides/registry.js";
import { createZoomView } from "./zoom-view.js";

const BASE_CSS = `
:where(.slide-frame) { position:relative; aspect-ratio:16/10; background:#fff; overflow:hidden; }
.slide-frame > img.bg { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; pointer-events:none; user-select:none; -webkit-user-drag:none; }
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

export function renderSlide({ root, slide, session, scope, scopeId, readOnly, authorId, onChange, zoom = false }) {
  injectCss("lesson-view", BASE_CSS);
  const noScopeId = (scope === "individual" || scope === "group") && !scopeId;
  const writable = !readOnly && !noScopeId && scope !== "ppt" && scope !== "bg";
  const frame = el("div", { class: "slide-frame" + (writable ? "" : " readonly") });
  let img = null;
  const canvas = el("canvas", zoom ? { class: "ink-view" } : {});
  const textLayer = el("div", { class: "text-layer" });
  syncBg();
  if (!zoom) frame.appendChild(canvas);
  frame.appendChild(textLayer);
  root.replaceChildren(frame);
  if (zoom) { root.classList.add("zoom-view"); root.appendChild(canvas); }

  let textMode = false;
  let textSize = 18;
  let textTimer = 0;
  let pendingRefresh = false;
  let destroyed = false;
  let lastSig = null; // 마지막으로 그린 Rec 서명 (doRefresh 가 초기 렌더에서 쓰므로 먼저 선언)
  const textEls = new Map(); // key → node
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

  const zv = zoom ? createZoomView({ viewport: root, frame, canvas, ink, getImg: () => img, src: slide.thumb || slide.bg }) : null;
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
    const tb = el("div", { class: "text-block" });
    if (writable) {
      setEditable(tb, textMode);
      tb.addEventListener("input", () => {
        if (destroyed) return;
        const cur = findText(key);
        if (!cur) return;
        cur.value = tb.innerText.replace(/\n$/, "");
        cur.ts = Date.now();
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
    tb.textContent = t.value || "";
    placeText(tb, t);
    return tb;
  }
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
        node.textContent = t.value;
        textEls.set(key, node);
        textLayer.insertBefore(node, textLayer.firstChild);
      }
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
        if (document.activeElement !== node && node.textContent !== (t.value || "")) node.textContent = t.value || "";
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
      textMode = t === "text";
      for (const node of [...textEls.values()]) setEditable(node, textMode);
      frame.classList.toggle("tool-text", textMode && writable);
      ink.setTool(textMode ? "pen" : t);
      ink.setReadOnly(!writable || textMode);
      canvas.style.pointerEvents = textMode ? "none" : "";
      if (!textMode) select(null); else placeSel();
    },
    // 텍스트 도구에서 색·S/M/L을 바꾸면 선택한 글자 칸에도 바로 반영(값이 바뀔 때만 — 도구바는 누를 때마다 셋 다 다시 넘긴다)
    setColor(c) {
      if (textMode && c !== ink.color) setSelected({ color: c });
      ink.setColor(c);
    },
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
      zv?.destroy();
      ink.destroy();
      textEls.clear();
      frame.remove();
      if (zoom) { canvas.remove(); root.classList.remove("zoom-view"); }
    },
  };
}
