// 슬라이드 확대·이동 보기 (필기 화면 공용: 학생 · 교사 진행 · 편집기 · 학생 필기 크게 보기)
//
// 뷰포트(스테이지) 안에 16:10 슬라이드를 놓고 두 손가락 핀치 · 트랙패드/휠 · 버튼으로 확대·이동한다.
// - 배경·텍스트(.slide-frame)는 실제 레이아웃 크기를 바꿔 그린다 → 브라우저가 원본 해상도로 다시 그려 선명.
// - 필기 캔버스는 뷰포트 크기 비트맵 + 보기 변환(InkCanvas.setView) → 확대해도 선이 선명하고 메모리 일정.
// - 제스처 중 배경은 GPU transform으로 미리 보여 주고, 필기는 획이 많지 않으면 매 프레임 다시 그린다
//   (선 굵기가 화면 기준 고정이라 그림처럼 늘리면 굵어졌다 돌아옴). 손을 떼면 확정(선명하게 다시 그림).
// - 맞춤: 세로 학습지는 종이의 내용 영역(흰 여백 제외)이 화면에 꽉 차게, 가로 슬라이드는 슬라이드 전체.
//   이동은 종이(배경 이미지) 안에서만 — 16:10 바깥 빈 여백으로 끌려가지 않게.
// 입력: 펜·마우스 = 필기. 한 손가락 = 필기(펜을 한 번이라도 쓰면 손바닥 오인을 막으려고 한 손가락은 무시).
//       두 손가락 = 확대·이동. 읽기 전용·텍스트 도구일 때는 한 손가락/마우스 끌기 = 이동.
//       Ctrl(⌘)+휠·트랙패드 핀치 = 확대, 휠·두 손가락 스크롤 = 이동, 가운데 버튼 끌기 = 이동.
// 가정: 내용 영역 분석은 같은 주소의 썸네일(없으면 배경)을 작게 그려 흰색(밝기 ≥ 236)이 아닌 픽셀의 범위를 찾는다.
//       교차 출처로 읽을 수 없거나 내용이 종이의 25% 미만이면 종이 전체를 맞춤 대상으로 쓴다(제목만 있는 슬라이드 등).
// 펜·손바닥(v2.6.1, js/pen-input.js): 펜이 닿으면 먼저 닿아 있던 터치(손바닥)가 긋던 선은 버리고, 그 터치로 시작된 확대·이동은
//       그 자리에서 멈춘 뒤 펜으로 쓴다(보이는 곳에 써지게). 손바닥으로 본 터치는 뗄 때까지 무시한다. 펜을 쓰는 기기에서는 두 손가락 확대·이동이
//       10px 넘게 움직여야 시작된다(가만히 얹은 손바닥으로 화면이 흔들리지 않게). 캔버스의 touchstart·touchmove를 막아
//       iPad Safari의 길게 누르기 글자 선택·확대경·콜아웃과 두 번 탭 확대를 끈다(포인터 이벤트는 그대로 온다).
import { isPalmTouch, penKnown, fingerDraws } from "./pen-input.js";

const ASPECT = 1.6;          // 슬라이드 16:10
const MARGIN = 10;           // 맞춤 시 가장자리 여백(px)
const STEP = 1.25;           // 버튼 확대 배율
const PAD = 0.02;            // 내용 영역 둘레 여유(종이 크기 비율)
const LIVE_POINTS = 6000;    // 획 점이 이 이하면 확대 중에도 필기를 실제로 다시 그림(선 굵기가 출렁이지 않게)
const focusCache = new Map(); // 분석 주소 → 내용 영역(이미지 정규화) | null

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const FULL = { x0: 0, y0: 0, x1: 1, y1: 1 };
const rw = (r) => (r.x1 - r.x0), rh = (r) => (r.y1 - r.y0);
// 배경 비율(가로/세로) → 16:10 슬라이드 안의 종이 영역(contain)
function paperFor(a) {
  if (!a) return FULL;
  return a < ASPECT ? { x0: (1 - a / ASPECT) / 2, y0: 0, x1: (1 + a / ASPECT) / 2, y1: 1 }
    : { x0: 0, y0: (1 - ASPECT / a) / 2, x1: 1, y1: (1 + ASPECT / a) / 2 };
}
// 이미지 정규화 내용 영역 → 슬라이드 정규화
function mapFocus(paper, b) {
  return b ? { x0: paper.x0 + b.x0 * rw(paper), x1: paper.x0 + b.x1 * rw(paper), y0: paper.y0 + b.y0 * rh(paper), y1: paper.y0 + b.y1 * rh(paper) } : paper;
}

// 갤러리 등에서 쓰는 종이·내용 영역(슬라이드 정규화). 배경이 없거나 못 읽으면 전체.
const inspectCache = new Map(); // 주소 → Promise<{ a, b }>
export function pageRectFor(src) {
  if (!src) return Promise.resolve({ paper: FULL, focus: FULL });
  if (!inspectCache.has(src)) inspectCache.set(src, analyzeContent(src).then(r => { if (r.a <= 1.25) focusCache.set(src, r.b); return r; }));
  return inspectCache.get(src).then(({ a, b }) => {
    const paper = paperFor(a);
    return { paper, focus: a && a <= 1.25 ? mapFocus(paper, b) : paper };
  });
}

export function createZoomView({ viewport, frame, canvas, ink, getImg, src }) {
  let VW = 0, VH = 0;
  let insets = { top: 0, right: 0, bottom: 0, left: 0 };
  let baseW = 1;                       // 확대 1배(16:10 전체가 보임)일 때 슬라이드 폭
  let paper = FULL, focus = FULL;      // 슬라이드 정규화 좌표의 종이·내용 영역
  let cur = { z: 1, ox: 0, oy: 0 };    // 확정된 보기
  let live = { ...cur };               // 제스처 중 보기
  let fitMode = true;                  // 사용자가 직접 확대·이동하기 전까지는 크기가 바뀌면 다시 맞춤
  let laidOut = false, destroyed = false;
  let analyzeSrc = src || null;
  let commitTimer = 0, liveInk = false;
  const listeners = new Set();

  // ── 기하 ──
  function safe() {
    const x = insets.left + MARGIN, y = insets.top + MARGIN;
    return { x, y, w: Math.max(40, VW - x - insets.right - MARGIN), h: Math.max(40, VH - y - insets.bottom - MARGIN) };
  }
  const rectW = (r) => (r.x1 - r.x0), rectH = (r) => (r.y1 - r.y0);
  function fitZ(r = focus) {
    const s = safe();
    const w = rectW(r) * baseW, h = rectH(r) * baseW / ASPECT;
    return Math.max(1, Math.min(s.w / (w || 1), s.h / (h || 1)));
  }
  const zMax = () => Math.max(4, fitZ() * 4);
  function centerOn(r, z) {
    const s = safe(), cw = baseW * z, ch = cw / ASPECT;
    return { z, ox: s.x + (s.w - rectW(r) * cw) / 2 - r.x0 * cw, oy: s.y + (s.h - rectH(r) * ch) / 2 - r.y0 * ch };
  }
  // 종이가 화면보다 작으면 가운데, 크면 종이 가장자리가 안쪽으로 들어오지 않게
  function clampView(v) {
    const s = safe(), z = clamp(v.z, 1, zMax()), cw = baseW * z, ch = cw / ASPECT;
    const axis = (o, a0, a1, size, s0, sw) => {
      const len = (a1 - a0) * size;
      if (len <= sw) return s0 + (sw - len) / 2 - a0 * size;
      return clamp(o, s0 + sw - a1 * size, s0 - a0 * size);
    };
    return { z, ox: axis(v.ox, paper.x0, paper.x1, cw, s.x, s.w), oy: axis(v.oy, paper.y0, paper.y1, ch, s.y, s.h) };
  }

  // ── 그리기 ──
  function applyLive() {
    const k = live.z / cur.z;
    frame.style.transform = `translate(${live.ox - cur.ox}px, ${live.oy - cur.oy}px) scale(${k})`;
    if (liveInk) {
      const cw = baseW * live.z;
      ink.setView({ ox: live.ox, oy: live.oy, cw, ch: cw / ASPECT, baseW });
    } else {
      canvas.style.transform = `translate(${live.ox - cur.ox * k}px, ${live.oy - cur.oy * k}px) scale(${k})`;
    }
  }
  function commit(v = live) {
    if (destroyed) return;
    clearTimeout(commitTimer); commitTimer = 0;
    cur = { ...v }; live = { ...v };
    const cw = baseW * cur.z, ch = cw / ASPECT;
    Object.assign(frame.style, { left: cur.ox + "px", top: cur.oy + "px", width: cw + "px", height: ch + "px", transform: "", willChange: "" });
    canvas.style.transform = ""; canvas.style.willChange = "";
    ink.setView({ ox: cur.ox, oy: cur.oy, cw, ch, baseW });
    emit("view");
  }
  function setLive(v) {
    live = clampView(v);
    if (!frame.style.willChange) {
      liveInk = ink.pointCount() <= LIVE_POINTS;
      frame.style.willChange = "transform";
      if (!liveInk) canvas.style.willChange = "transform";
    }
    applyLive();
    emit("live");
  }
  function scheduleCommit(ms) { clearTimeout(commitTimer); commitTimer = setTimeout(() => commit(), ms); }
  function emit(kind) { for (const fn of listeners) { try { fn(kind); } catch (e) { console.warn("[zoom]", e); } } }

  function fit() {
    fitMode = true;
    commit(clampView(centerOn(focus, fitZ())));
  }
  function zoomAt(z, px, py, { now = true } = {}) {
    fitMode = false;
    const k = clamp(z, 1, zMax()) / live.z;
    const v = { z: live.z * k, ox: px - (px - live.ox) * k, oy: py - (py - live.oy) * k };
    if (now) commit(clampView(v)); else setLive(v);
  }
  function center() { const s = safe(); return [s.x + s.w / 2, s.y + s.h / 2]; }

  // 크기·여백이 바뀜 → 맞춤 상태면 다시 맞춤, 아니면 보던 곳(가운데)을 유지
  function relayout() {
    if (destroyed) return;
    const w = viewport.clientWidth, h = viewport.clientHeight;
    if (!w || !h) return;
    const sOld = safe(), cwOld = baseW * cur.z;
    const cx = laidOut ? (sOld.x + sOld.w / 2 - cur.ox) / cwOld : 0.5;
    const cy = laidOut ? (sOld.y + sOld.h / 2 - cur.oy) / (cwOld / ASPECT) : 0.5;
    VW = w; VH = h;
    const s = safe();
    baseW = Math.max(1, Math.min(s.w, s.h * ASPECT));
    if (fitMode || !laidOut) { laidOut = true; fit(); return; }
    const cw = baseW * cur.z;
    commit(clampView({ z: cur.z, ox: s.x + s.w / 2 - cx * cw, oy: s.y + s.h / 2 - cy * cw / ASPECT }));
  }

  // ── 종이·내용 영역 ──
  function updatePaper() {
    const img = getImg && getImg();
    const nw = img && img.naturalWidth, nh = img && img.naturalHeight;
    if (!nw || !nh) { paper = FULL; focus = FULL; return; }
    const a = nw / nh;
    paper = paperFor(a);
    const b = a <= 1.25 ? focusCache.get(analyzeSrc || img.currentSrc || img.src) : null;
    focus = mapFocus(paper, b);
  }
  function pageChanged() {
    updatePaper();
    emit("page");
    if (laidOut) fitMode ? fit() : commit(clampView(cur));
    const img = getImg && getImg();
    if (!img) return;
    const key = analyzeSrc || img.currentSrc || img.src;
    const a = img.naturalWidth / (img.naturalHeight || 1);
    if (key && img.naturalWidth && a <= 1.25 && !focusCache.has(key)) {
      pageRectFor(key).then(() => {
        if (!destroyed && focusCache.get(key)) pageChanged();
      });
    }
  }
  function onImgLoad() { pageChanged(); }
  let boundImg = null;
  function bindImg() {
    const img = getImg && getImg();
    if (img === boundImg) return;
    boundImg?.removeEventListener("load", onImgLoad);
    boundImg = img || null;
    boundImg?.addEventListener("load", onImgLoad);
  }

  // ── 입력 ──
  const pts = new Map();     // 확대·이동에 쓰는 터치 pointerId → {x, y}
  const ignored = new Set(); // 손바닥으로 본 터치(뗄 때까지 무시)
  let g = null;              // { kind:'pinch'|'pan', touch, ... }
  let suppressClick = false;
  const drawable = () => !ink.readOnly;
  function local(e) {
    const r = viewport.getBoundingClientRect();
    return { x: e.clientX - r.left - viewport.clientLeft, y: e.clientY - r.top - viewport.clientTop };
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) || 1;
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  function startPinch() {
    const [[ia, a], [ib, b]] = [...pts].slice(0, 2);
    g = { kind: "pinch", touch: true, ids: [ia, ib], d0: dist(a, b), m0: mid(a, b), v0: { ...live }, live: false };
  }
  function startPan(id, p, moved = false, touch = false) { g = { kind: "pan", touch, id, sx: p.x, sy: p.y, v0: { ...live }, moved }; }
  function endGesture() {
    const was = g;
    g = null;
    if (was && (was.kind === "pinch" || was.moved)) commit();
  }
  // 펜이 닿음: 손바닥(터치)이 시작한 확대·이동을 그 자리에서 멈춘다.
  // 가정: 되돌리지 않는다 — 사용자는 지금 보이는 화면을 보고 펜을 댔으므로, 되돌리면 펜 아래 내용이 바뀌어 엉뚱한 곳에 써진다.
  function abortTouchGesture() {
    const was = g;
    if (!was || !was.touch) return;
    g = null;
    if (was.live || was.moved) commit();
  }

  function onDown(e) {
    if (e.pointerType === "pen") {
      // 펜 우선: 먼저 닿아 있던 터치는 손바닥 — 그 선·확대·이동을 취소하고 펜을 받는다
      for (const id of pts.keys()) ignored.add(id);
      pts.clear();
      abortTouchGesture();
      if (ink.isDrawing() && ink.pointerType() !== "pen") ink.cancelStroke();
      if (g) e.stopPropagation(); // 마우스로 끄는 중이면 쓰지 않음
      return;
    }
    if (e.target.closest?.(".text-block:focus, button, input, textarea")) return;
    const p = local(e);
    if (e.pointerType === "mouse") {
      if (e.button === 1 || (e.button === 0 && !drawable())) {
        // 왼쪽 버튼은 실제로 끌 때만 포인터를 잡는다(그냥 클릭은 텍스트 만들기·선택으로 그대로 전달)
        startPan(e.pointerId, p);
        if (e.button === 1) {
          try { viewport.setPointerCapture(e.pointerId); } catch (_) {}
          e.preventDefault(); e.stopPropagation();
        }
      }
      return;
    }
    // 터치: 펜이 닿아 있거나 막 떼거나 띄워 둔 동안·접촉면이 큰 터치는 손바닥 → 뗄 때까지 무시
    if (isPalmTouch(e)) { ignored.add(e.pointerId); e.stopPropagation(); return; }
    pts.set(e.pointerId, p);
    if (pts.size >= 2) {
      ink.cancelStroke();                                    // 첫 손가락이 긋던 선은 버림
      startPinch();
      try { viewport.setPointerCapture(e.pointerId); } catch (_) {}
      e.stopPropagation(); e.preventDefault();
      return;
    }
    if (drawable()) {
      if (!fingerDraws()) e.stopPropagation();               // 펜 기기: 한 손가락은 쓰지 않음(손바닥 오인 방지)
      return;                                                 // 아니면 한 손가락 필기
    }
    startPan(e.pointerId, p, false, true);                    // 읽기 전용·텍스트: 한 손가락 이동
  }
  function onMove(e) {
    if (ignored.has(e.pointerId)) { e.stopPropagation(); return; }
    if (pts.has(e.pointerId)) pts.set(e.pointerId, local(e));
    if (!g) return;
    if (g.kind === "pinch") {
      if (!g.ids.includes(e.pointerId)) return;
      const a = pts.get(g.ids[0]), b = pts.get(g.ids[1]);
      if (!a || !b) return;
      const m = mid(a, b), d = dist(a, b);
      if (!g.live) {
        // 펜 기기: 10px 넘게 움직여야 확대·이동 시작(얹어 둔 손바닥이 화면을 흔들지 않게), 시작점은 지금 위치로
        const dead = penKnown() ? 10 : 3;
        if (Math.abs(d - g.d0) < dead && dist(m, g.m0) < dead) { e.stopPropagation(); return; }
        g.live = true; g.d0 = d; g.m0 = m; g.v0 = { ...live };
      }
      const k = clamp(g.v0.z * d / g.d0, 1, zMax()) / g.v0.z;
      fitMode = false;
      setLive({ z: g.v0.z * k, ox: m.x - (g.m0.x - g.v0.ox) * k, oy: m.y - (g.m0.y - g.v0.oy) * k });
      e.stopPropagation();
    } else if (g.kind === "pan" && e.pointerId === g.id) {
      const p = local(e), dx = p.x - g.sx, dy = p.y - g.sy;
      if (!g.moved && Math.hypot(dx, dy) < 6) return;
      if (!g.moved && e.pointerType === "mouse") { try { viewport.setPointerCapture(e.pointerId); } catch (_) {} }
      g.moved = true; fitMode = false;
      setLive({ z: g.v0.z, ox: g.v0.ox + dx, oy: g.v0.oy + dy });
      e.stopPropagation();
    }
  }
  function onUp(e) {
    if (e.pointerType === "pen") return;
    if (ignored.delete(e.pointerId)) { e.stopPropagation(); return; }
    const wasPt = pts.delete(e.pointerId);
    if (!g) return;
    if (g.kind === "pinch") {
      if (!g.ids.includes(e.pointerId) && wasPt) return;
      if (pts.size >= 2) { startPinch(); return; }
      if (pts.size === 1 && g.live) { const [[id, p]] = [...pts]; startPan(id, p, true, true); return; } // 남은 손가락으로 이어서 이동
      if (pts.size === 1) { g = null; return; } // 움직이지 않은 두 접점(얹은 손 등) → 아무 일 없음
      endGesture();
      e.stopPropagation();
    } else if (g.kind === "pan" && e.pointerId === g.id) {
      if (g.moved && e.pointerType === "mouse") suppressClick = true;
      endGesture();
    }
  }
  function onClick(e) {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation(); e.preventDefault();
  }
  function onWheel(e) {
    if (g) return;
    const p = local(e);
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const dy = clamp(e.deltaMode ? e.deltaY * 16 : e.deltaY, -60, 60);
      zoomAt(live.z * Math.exp(-dy * 0.01), p.x, p.y, { now: false });
      scheduleCommit(160);
      return;
    }
    const s = safe(), cw = baseW * live.z, ch = cw / ASPECT;
    const canX = rectW(paper) * cw > s.w + 1, canY = rectH(paper) * ch > s.h + 1;
    if (!canX && !canY) return;
    e.preventDefault();
    const k = e.deltaMode ? 16 : 1;
    fitMode = false;
    setLive({ z: live.z, ox: live.ox - e.deltaX * k, oy: live.oy - e.deltaY * k });
    scheduleCommit(160);
  }
  // Safari: 페이지 자체 확대 막기. 데스크톱 Safari 트랙패드 핀치(터치 포인터 없음)는 확대로 받는다.
  let gz = null;
  function onGestureStart(e) { e.preventDefault(); gz = pts.size ? null : { z: live.z, p: local(e) }; }
  function onGestureChange(e) {
    e.preventDefault();
    if (!gz || pts.size) return;
    zoomAt(gz.z * (e.scale || 1), gz.p.x, gz.p.y, { now: false });
  }
  function onGestureEnd(e) { e.preventDefault(); if (gz) { gz = null; commit(); } }
  // iPad Safari: 캔버스에서 시작한 터치(펜 포함)는 브라우저 기본 동작(길게 누르기 글자 선택·확대경·콜아웃·두 번 탭 확대·스크롤)을 끈다.
  // 포인터 이벤트는 그대로 오므로 필기·확대·이동은 영향 없음. 텍스트 도구일 때는 캔버스가 포인터를 받지 않아(대상이 프레임) 탭·편집이 그대로 동작.
  function onTouch(e) { if (e.target === canvas && e.cancelable) e.preventDefault(); }

  const opt = { capture: true, passive: false };
  viewport.addEventListener("pointerdown", onDown, opt);
  viewport.addEventListener("pointermove", onMove, opt);
  viewport.addEventListener("pointerup", onUp, opt);
  viewport.addEventListener("pointercancel", onUp, opt);
  viewport.addEventListener("touchstart", onTouch, { passive: false });
  viewport.addEventListener("touchmove", onTouch, { passive: false });
  viewport.addEventListener("click", onClick, true);
  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("gesturestart", onGestureStart, { passive: false });
  viewport.addEventListener("gesturechange", onGestureChange, { passive: false });
  viewport.addEventListener("gestureend", onGestureEnd, { passive: false });
  const ro = new ResizeObserver(relayout);
  ro.observe(viewport);

  bindImg();
  updatePaper();
  relayout();
  if (getImg?.()?.complete) pageChanged();

  return {
    fit,
    zoomIn() { const [x, y] = center(); zoomAt(live.z * STEP, x, y); },
    zoomOut() { const [x, y] = center(); zoomAt(live.z / STEP, x, y); },
    // 맞춤 ↔ 폭 맞춤(세로 학습지를 가로 화면에서 볼 때 글씨를 크게)
    toggleFit() {
      const s = safe();
      const zw = clamp(s.w / (rectW(focus) * baseW || 1), 1, zMax());
      const atFit = Math.abs(live.z - fitZ()) < 0.02;
      if (atFit && zw > fitZ() * 1.1) {
        fitMode = false;
        const cw = baseW * zw, ch = cw / ASPECT;
        commit(clampView({ z: zw, ox: s.x + (s.w - rectW(focus) * cw) / 2 - focus.x0 * cw, oy: s.y - focus.y0 * ch }));
      } else fit();
    },
    percent: () => Math.round(live.z / fitZ() * 100),
    isFit: () => fitMode,
    // 맞춤 대상의 화면 비율(가로/세로) — 도구바 배치 판단용
    focusAspect: () => rectW(focus) * ASPECT / (rectH(focus) || 1),
    setInsets(ins) {
      const n = { top: 0, right: 0, bottom: 0, left: 0, ...ins };
      if (n.top === insets.top && n.right === insets.right && n.bottom === insets.bottom && n.left === insets.left) return;
      insets = n;
      relayout();
    },
    // 배경이 바뀌었을 때(편집기 교체)
    setSource(nextSrc) { analyzeSrc = nextSrc || null; bindImg(); pageChanged(); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(commitTimer);
      ro.disconnect();
      boundImg?.removeEventListener("load", onImgLoad);
      viewport.removeEventListener("pointerdown", onDown, opt);
      viewport.removeEventListener("pointermove", onMove, opt);
      viewport.removeEventListener("pointerup", onUp, opt);
      viewport.removeEventListener("pointercancel", onUp, opt);
      viewport.removeEventListener("touchstart", onTouch, { passive: false });
      viewport.removeEventListener("touchmove", onTouch, { passive: false });
      viewport.removeEventListener("click", onClick, true);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("gesturestart", onGestureStart);
      viewport.removeEventListener("gesturechange", onGestureChange);
      viewport.removeEventListener("gestureend", onGestureEnd);
      listeners.clear();
    },
  };
}

// { a: 이미지 비율(가로/세로) | 0, b: 흰 여백을 뺀 내용 영역(이미지 정규화 0..1) | null(읽을 수 없거나 너무 작음) }
function analyzeContent(url) {
  return new Promise((done) => {
    const im = new Image();
    let a = 0;
    const resolve = (b) => done({ a, b });
    im.crossOrigin = "anonymous";
    im.decoding = "async";
    im.onerror = () => resolve(null);
    im.onload = () => {
      a = im.naturalWidth / (im.naturalHeight || 1);
      try {
        const W = 160, H = Math.max(1, Math.round(W * im.naturalHeight / (im.naturalWidth || 1)));
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
        g.drawImage(im, 0, 0, W, H);
        const d = g.getImageData(0, 0, W, H).data;
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < 236) {
              if (x < x0) x0 = x; if (x > x1) x1 = x;
              if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
          }
        }
        if (x1 < 0) return resolve(null);
        const b = {
          x0: Math.max(0, x0 / W - PAD), y0: Math.max(0, y0 / H - PAD),
          x1: Math.min(1, (x1 + 1) / W + PAD), y1: Math.min(1, (y1 + 1) / H + PAD),
        };
        resolve((b.x1 - b.x0) * (b.y1 - b.y0) >= 0.25 ? b : null);
      } catch (_) { resolve(null); }
    };
    // 프레임 <img>가 CORS 없이 받아 둔 캐시와 섞이지 않게 별도 주소로 받는다
    im.src = /^(data|blob):/.test(url) ? url : url + (url.includes("?") ? "&" : "?") + "zv=1";
  });
}
