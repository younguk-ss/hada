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
// 가정: edit 외 scope에서는 slide.strokes/texts(편집기 기본 필기, 스냅샷에 포함)를 바닥 레이어로 함께 그린다.
//       기본 획은 지우개로 지우면 그 scope의 removed에만 기록(원본 불변). 전체 지우기는 Rec만 비운다.
// 가정: id 없는 레거시 기본 획은 '#<i>'(i < 기본 획 수, 순서 불변)로 removed에 기록 가능. Rec 쪽 '#' 키는 불안정해 기록 안 함.
// 가정: individual/group인데 scopeId가 없으면(구버전 호출) 빈 읽기 전용으로 그린다.
// zoom: true → root(스테이지)가 확대·이동 뷰포트가 된다(js/zoom-view.js). 캔버스는 프레임 밖에서 뷰포트 전체를 덮고
//       보기 변환으로 그리며, 프레임(배경·텍스트)은 확대된 실제 크기로 배치된다. 호출 쪽은 fitFrame을 쓰지 않는다.

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
.zoom-view { position:relative; overflow:hidden; display:block !important; padding:0 !important; touch-action:none; -webkit-user-select:none; user-select:none; }
.zoom-view, .zoom-view * { touch-action:none !important; }
.zoom-view > .slide-frame { position:absolute; margin:0 !important; max-width:none !important; transform-origin:0 0; }
.zoom-view > canvas.ink-view { position:absolute; left:0; top:0; width:100%; height:100%; transform-origin:0 0; z-index:1; }
`;

// 펜 굵기 → 글자 크기(기준 폭 960px)
function textSizeFor(size) { return size <= 2.5 ? 18 : size <= 4 ? 24 : 32; }

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
    node.style.fontSize = ((t.size || 18) / 9.6).toFixed(3) + "cqw";
    node.style.color = t.color || "#1c1c22";
  }
  function makeTextEl(key, t) {
    const tb = el("div", { class: "text-block" });
    if (writable) {
      tb.contentEditable = "plaintext-only";
      if (tb.contentEditable !== "plaintext-only") tb.contentEditable = "true";
      tb.addEventListener("input", () => {
        if (destroyed) return;
        const cur = findText(key);
        if (!cur) return;
        cur.value = tb.innerText.replace(/\n$/, "");
        cur.ts = Date.now();
        schedulePersist();
      });
      tb.addEventListener("blur", () => {
        if (destroyed) return;
        const rec = pathFor(true);
        const i = rec.texts.findIndex(x => x.id === key);
        if (i >= 0 && !String(rec.texts[i].value || "").trim()) {
          rec.texts.splice(i, 1);
          addRemoved(rec, [key]);
          textEls.delete(key);
          tb.remove();
          clearTimeout(textTimer); textTimer = 0;
          persist();
          return;
        }
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
      if (!seen.has(key)) { node.remove(); textEls.delete(key); }
    }
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
      size: textSize,
      color: ink.color,
      ts: Date.now(),
    };
    pathFor(true).texts.push(t);
    const node = makeTextEl(t.id, t);
    textEls.set(t.id, node);
    textLayer.appendChild(node);
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
      frame.classList.toggle("tool-text", textMode && writable);
      ink.setTool(textMode ? "pen" : t);
      ink.setReadOnly(!writable || textMode);
      canvas.style.pointerEvents = textMode ? "none" : "";
    },
    setColor(c) { ink.setColor(c); },
    setSize(s) { ink.setSize(s); textSize = textSizeFor(s); },
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
      zv?.destroy();
      ink.destroy();
      textEls.clear();
      frame.remove();
      if (zoom) { canvas.remove(); root.classList.remove("zoom-view"); }
    },
  };
}
