// 부드러운 필기 캔버스 (Goodnotes 식)
//
// 핵심 설계:
// 1) 확정 획은 offscreen 캔버스에 캐시 → pointermove마다 전체 재렌더하지 않음.
// 2) 그리기는 rAF로 묶음(60Hz+).
// 3) Catmull-Rom 보간 + 압력 가변 굵기.
// 4) setStrokes()는 그리는 중인 획(current)을 보존 → 외부 동기화로 글씨가 사라지지 않음.
// 5) v2: stroke.id('st_…')·by, 좌표 소수 4자리, undo(), 지우개는 id 목록으로 commit, destroy().
//
// 가정: id 없는 레거시 획은 원래 배열 인덱스로 '#<i>' 키를 쓴다(지우개 commit의 ids에 그대로 실림).
// 가정: 압력 p는 소수 2자리로 반올림(x·y는 4자리).
// 가정: 실시간 캔버스 선 굵기 = size × dpr × clamp(프레임폭/960, 0.7, 1.6). 미니(paintStrokes)는 폭/960 비례.
// 6) 보기 변환(setView): 확대·이동 화면에서는 캔버스가 보이는 영역(뷰포트) 크기만큼만 비트맵을 갖고,
//    슬라이드(정규화 0..1)가 그 안에서 놓인 위치·크기 {ox, oy, cw, ch, baseW}(CSS px)로 그린다 → 확대해도 선이 선명하고 메모리 일정.
//    baseW = 확대 1배일 때 슬라이드 폭(선 굵기 기준). 보기가 없으면 캔버스 전체 = 슬라이드(기존 동작).
// 7) 선 굵기와 확대: 획은 쓸 때의 확대 배율 zw를 기억하고, size = 펜 값 ÷ zw(슬라이드 위 실제 굵기)로 저장한다.
//    확대·이동 화면에서는 size × min(보는 배율, zw)로 그린다 →
//      쓸 때와 같은 배율: 쓸 때 본 굵기 그대로 / 축소: 글씨와 함께 가늘어짐(굵어 보이지 않게) / 더 확대: 쓸 때보다 굵어지지 않음.
//    기록·썸네일·인쇄 같은 정적 그림은 size(실제 굵기) × 그림 폭/960. zw 없는 이전 획은 zw = 1.
// 8) 펜 입력(v2.6.1): 손바닥으로 본 터치는 받지 않는다(js/pen-input.js). 펜 지우개 끝·S펜 옆 버튼을 누른 채 쓰면 그 획은 지우개.
//    그리는 중인 펜 획은 확정된 구간(뒤 점 2개가 정해진 구간)을 캐시에 바로 그려 두고 매 프레임 끝부분만 다시 그린다
//    → 획이 길어져도 프레임 비용이 일정(저사양 크롬북·태블릿). 브라우저가 주는 예측 점(getPredictedEvents)으로 펜 끝을 조금 앞서 그려
//    지연을 줄이고(저장하지 않음), 화면에서 0.6px보다 가까운 점은 버려 저장 크기를 줄인다. 위치 계산은 이벤트 묶음마다 한 번만.
// 9) 구형·저사양 태블릿(v2.8, 갤럭시탭 S6 Lite 등): 저지연 캔버스(desynchronized)는 앞 버퍼에 바로 그리는 모드라
//    일부 안드로이드 GPU(Mali 등)에서 투명한 필기 캔버스가 검게 덮이거나(오버레이가 투명도를 섞지 못함) 지우고 다시 그리는 순간이
//    그대로 보여 빠르게 깜빡였다(학습지 화면이 검고 윤곽만 깜빡임) → 크롬북에서만 켠다(기기별 강제: localStorage 'hada:lowLatency' '1'|'0').
//    비트맵은 한 변 4096px·총 1200만 화소 이하로 줄이고(메모리 부족으로 GPU가 그리기를 포기하지 않게),
//    GPU 메모리 부족 등으로 캔버스 내용을 잃었다가 돌아오면(contextrestored) 다시 그린다.
// 10) 도형(v2.10, 도구 'shape'): 끌어서 그리는 직선·화살표·네모·동그라미·세모. 저장은 보통 획과 같은 Stroke에
//    shape(종류)·box([시작 x, y, 끝 x, y], 정규화)를 더한 것 — 그리기는 box로 정확한 도형, points는 윤곽을 기준 화면 8px 간격으로
//    채운 점(지우개 판정·필기 범위·이전 버전 화면에서도 비슷하게 보이게). Shift를 누르면 정사각형·정원·45° 직선.
//    거의 끌지 않은(4px 미만) 도형은 버린다. 굵기는 펜과 같은 규칙(7), 압력 없이 고르게.
// 11) 텍스트 부분 색(v2.10): Text.runs = [{ t, c }](t를 이으면 value, c = null이면 글 상자 색). 정적 그림은 drawTextBox가
//    글자별 색을 칸 폭 줄바꿈 뒤에도 그대로 칠한다.

import { newId } from "./slides/registry.js";
import { isPalmTouch } from "./pen-input.js";

const REF_W = 960; // 선 굵기·글자 크기 기준 프레임 폭(px)
const MAX_SIDE = 4096, MAX_PX = 12e6; // 캔버스 비트맵 한도(9)

// 저지연 캔버스를 써도 되는 기기인가(9)
const LOW_LATENCY = (() => {
  try { const v = localStorage.getItem("hada:lowLatency"); if (v === "1") return true; if (v === "0") return false; } catch (_) {}
  return typeof navigator !== "undefined" && /\bCrOS\b/.test(navigator.userAgent || "");
})();
// 화면 크기(CSS px) → 쓸 배율(기기 배율, 한도 안에서)
function bitmapScale(cssW, cssH) {
  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  const w = Math.max(1, cssW), h = Math.max(1, cssH);
  return Math.max(0.25, Math.min(dpr, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_PX / (w * h))));
}

const r4 = (v) => Math.round(v * 10000) / 10000;
const r2 = (v) => Math.round(v * 100) / 100;
const REF_H = REF_W / 1.6;
const SHAPE_STEP = 8; // 도형 윤곽 점 간격(기준 화면 px)

// 획 키: id 우선, 없으면 인덱스
export function strokeKey(s, i) { return (s && s.id) || ("#" + i); }

export class InkCanvas {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", LOW_LATENCY ? { alpha: true, desynchronized: true } : { alpha: true });
    this.dpr = window.devicePixelRatio || 1;
    this.tool = "pen";
    this.shape = "rect";        // 도형 도구의 종류(10)
    this.color = "#1c1c22";
    this.size = 2;
    this.strokes = [];           // 확정 획 (removed 제외)
    this._keys = [];             // strokes와 평행한 키 배열
    this.current = null;         // 그리는 중
    this.readOnly = !!opts.readOnly;
    this.authorId = opts.authorId || null;
    this.onCommit = opts.onCommit || (() => {});
    this.onLive = opts.onLive || (() => {});
    this.onEnd = opts.onEnd || (() => {});   // 제스처 종료(commit 여부 무관)
    this._mine = [];             // 이 인스턴스가 그린 획 id (undo용)
    this._destroyed = false;

    // 확정 획 캐시 (offscreen)
    this.cache = document.createElement("canvas");
    this.cacheCtx = this.cache.getContext("2d");
    this.cacheValid = false;
    this._raf = 0;
    this._k = this.dpr;
    this.view = null;            // 보기 변환 (없으면 캔버스 전체)
    this._cssW = 0; this._cssH = 0;
    this._ptype = null;          // 그리는 중인 포인터 종류(pen|touch|mouse)
    this._liveN = 0;             // 그리는 중인 펜 획에서 캐시에 이미 그린 구간 수(8)
    this._pred = null;           // 예측 점(그리기만, 저장 안 함)

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);
    // GPU가 캔버스를 잃었다가 돌려주면 다시 그림(9) — 화면 캔버스·캐시 둘 다
    this._onRestore = () => { this.cacheValid = false; this._scheduleDraw(); };
    canvas.addEventListener("contextrestored", this._onRestore);
    this.cache.addEventListener("contextrestored", this._onRestore);

    this._bind();
    this.resize();
  }

  // arr: Stroke[], removed: 지운 id 목록 → 제외하고 렌더
  setStrokes(arr, removed = []) {
    const src = arr || [];
    const rm = removed && removed.length ? new Set(removed) : null;
    const next = [], keys = [];
    src.forEach((s, i) => {
      if (!s || !s.points) return;
      const k = strokeKey(s, i);
      if (rm && rm.has(k)) return;
      next.push(s); keys.push(k);
    });
    // 같은 데이터면 캐시 무효화 생략 (동기화 폭주 시 jank 방지)
    if (sigOf(next, keys) === sigOf(this.strokes, this._keys)) return;
    this.strokes = next;
    this._keys = keys;
    this.cacheValid = false;
    this._scheduleDraw();
  }
  isDrawing() { return !!this.current; }
  pointerType() { return this.current ? this._ptype : null; }
  appendStroke(s) {
    this.strokes.push(s);
    this._keys.push(strokeKey(s, this.strokes.length - 1));
    this._appendToCache(s);
    this._scheduleDraw();
  }
  // 보기 변환 갱신 → 확정 획 다시 그림. v = { ox, oy, cw, ch, baseW } | null
  setView(v) {
    this.view = v ? { ox: v.ox, oy: v.oy, cw: v.cw, ch: v.ch, baseW: v.baseW || v.cw } : null;
    this._updateK();
    this.cacheValid = false;
    this._scheduleDraw();
  }
  // 그리던 획 버리기(두 손가락 확대가 시작될 때 등). 저장하지 않음.
  cancelStroke() {
    if (!this.current) return;
    const pid = this._pid;
    this._cancelCurrent();
    try { if (pid != null) this.canvas.releasePointerCapture(pid); } catch (_) {}
  }
  setTool(t) { this.tool = t; }
  setShape(k) { if (SHAPES.includes(k)) this.shape = k; }
  setColor(c) { this.color = c; }
  setSize(s) { this.size = s; }
  setReadOnly(v) {
    this.readOnly = !!v;
    // 읽기 전용이면 터치 스크롤 허용
    this.canvas.style.touchAction = this.readOnly ? "" : "none";
    if (v) this._cancelCurrent();
  }

  // 이 캔버스에서 그린 마지막 획 제거 → onCommit({type:'erase', ids:[id]})
  undo() {
    while (this._mine.length) {
      const id = this._mine.pop();
      const i = this._keys.indexOf(id);
      if (i < 0) continue; // 이미 지워짐
      this.strokes.splice(i, 1);
      this._keys.splice(i, 1);
      this.cacheValid = false;
      this._scheduleDraw();
      this.onCommit({ type: "erase", ids: [id] });
      return true;
    }
    return false;
  }

  resize() {
    if (this._destroyed) return;
    const { canvas } = this;
    // 레이아웃 크기(변환 무시) — 확대 중 CSS transform이 걸려 있어도 비트맵 크기가 흔들리지 않게
    const r = canvas.getBoundingClientRect();
    this._cssW = canvas.clientWidth || r.width;
    this._cssH = canvas.clientHeight || r.height;
    this.dpr = bitmapScale(this._cssW, this._cssH); // 모니터 이동 시 갱신, 큰 화면은 한도 안으로(9)
    const w = Math.max(1, Math.round(this._cssW * this.dpr));
    const h = Math.max(1, Math.round(this._cssH * this.dpr));
    this._updateK();
    if (canvas.width === w && canvas.height === h && this.cache.width === w) return;
    canvas.width = w; canvas.height = h;
    this.cache.width = w; this.cache.height = h;
    this.cacheValid = false;
    this._scheduleDraw();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    try { this._ro.disconnect(); } catch (_) {}
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    const c = this.canvas;
    for (const [ev, fn, o] of this._handlers || []) c.removeEventListener(ev, fn, o);
    this._handlers = [];
    c.removeEventListener("contextrestored", this._onRestore);
    this.cache.removeEventListener("contextrestored", this._onRestore);
    this.current = null;
    this.cache.width = this.cache.height = 0;
  }

  // 슬라이드가 캔버스 안에서 차지하는 영역(CSS px)
  _v() {
    return this.view || { ox: 0, oy: 0, cw: this._cssW || 1, ch: this._cssH || 1, baseW: this._cssW || REF_W };
  }
  _updateK() {
    const v = this._v();
    // 기존 규칙(확대 1배일 때 프레임폭/960, 0.7~1.6). 확대 배율은 곱하지 않음 → 화면에서 굵기 고정
    this._k = this.dpr * Math.min(1.6, Math.max(0.7, (v.baseW || REF_W) / REF_W));
  }
  // 확정 획의 점 개수 합(확대 중 실시간으로 다시 그릴지 판단용)
  pointCount() { let n = 0; for (const st of this.strokes) n += st.points ? st.points.length : 0; return n; }
  // 이 보기에서 화면 1px이 슬라이드 폭의 몇 배로 커 보이는지(1 = 확대 안 함)
  // 확대 보기는 늘 1배 이상 — 아직 크기를 못 잰 캔버스(숨김 화면에서 막 그려짐 등)가 1/960 같은 값을 내어
  // 그때 만든 글자·획이 수백 배로 커지지 않게 1 아래는 1로
  zoomFactor() { const v = this._v(); const z = (v.cw || 1) / (v.baseW || v.cw || 1); return Number.isFinite(z) && z > 1 ? z : 1; }

  // 좌표 변환 기준(이벤트 묶음마다 한 번만 레이아웃을 읽는다)
  _frame() {
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    return { r, sx: (c.clientWidth || r.width) / (r.width || 1), sy: (c.clientHeight || r.height) / (r.height || 1), v: this._v() };
  }
  _toNorm(ev, f = this._frame()) {
    const { r, sx, sy, v } = f;
    return {
      x: ((ev.clientX - r.left) * sx - v.ox) / (v.cw || 1),
      y: ((ev.clientY - r.top) * sy - v.oy) / (v.ch || 1),
      p: ev.pressure && ev.pressure > 0 ? ev.pressure : 0.5,
    };
  }
  // 보기 영역 밖(슬라이드 바깥 여백)에서 시작한 획은 받지 않는다
  _inside(pt) { return !this.view || (pt.x >= 0 && pt.x <= 1 && pt.y >= 0 && pt.y <= 1); }

  _cancelCurrent() {
    if (!this.current) return;
    this.current = null;
    this._pred = null;
    // 캐시에 미리 그려 둔 구간이 있으면 캐시를 다시 만든다(8)
    if (this._liveN > 0) { this._liveN = 0; this.cacheValid = false; }
    this._scheduleDraw();
  }

  _bind() {
    const c = this.canvas;
    let pid = null;
    c.style.touchAction = this.readOnly ? "" : "none"; // 쓰기 가능하면 스크롤 차단
    this._handlers = [];
    const on = (ev, fn, o) => { c.addEventListener(ev, fn, o); this._handlers.push([ev, fn, o]); };

    on("pointerdown", (e) => {
      if (this.readOnly || this._destroyed) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.pointerType === "touch" && isPalmTouch(e)) return; // 손바닥(8) — zoom-view가 먼저 거르지만 한 번 더
      if (this.current) return; // 멀티터치: 첫 포인터만 (펜이 닿으면 zoom-view가 손바닥 획을 먼저 취소)
      const pt = this._toNorm(e);
      if (!this._inside(pt)) return;
      pid = e.pointerId;
      this._pid = pid;
      this._ptype = e.pointerType || "mouse";
      this._liveN = 0;
      this._pred = null;
      try { c.setPointerCapture(pid); } catch (_) {}
      // 펜 지우개 끝(button 5 / buttons 32)·옆 버튼(S펜 등, button 2 / buttons 2)을 누른 채 쓰면 지우개
      const penErase = e.pointerType === "pen" && (e.button === 5 || e.button === 2 || (e.buttons & 34) !== 0);
      const shape = !penErase && this.tool === "shape" ? this.shape : null;
      const tool = penErase ? "eraser" : shape ? "pen" : this.tool;
      this.current = {
        tool,
        ...(shape ? { shape, box: [pt.x, pt.y, pt.x, pt.y] } : {}),
        color: this.color,
        // 형광펜은 굵게. 슬라이드 위 실제 굵기 = 펜 값 ÷ 쓰는 배율(7)
        size: Math.max(0.05, r2((tool === "highlight" ? this.size * 4 : this.size) / this.zoomFactor())),
        ...(this.zoomFactor() > 1.01 ? { zw: r2(this.zoomFactor()) } : {}),
        points: [pt],
        ts: Date.now(),
      };
      this._scheduleDraw();
      e.preventDefault();
    }, { passive: false });

    on("pointermove", (e) => {
      if (!this.current || e.pointerId !== pid) return;
      // 도형(10): 시작점 ~ 지금 점으로 다시 만든다
      if (this.current.shape) {
        const cur = this.current, f = this._frame();
        const b = this._toNorm(e, f);
        const [ax, ay] = cur.box;
        const end = e.shiftKey ? constrainShape(cur.shape, ax, ay, b.x, b.y) : b;
        cur.box = [ax, ay, end.x, end.y];
        cur.points = shapePoints(cur.shape, cur.box, cur.size);
        this._scheduleDraw();
        return;
      }
      // coalesced 이벤트로 중간 점 보충 → 부드러운 선. 위치 기준은 한 번만 읽는다(8)
      const events = (typeof e.getCoalescedEvents === "function") ? e.getCoalescedEvents() : [e];
      const f = this._frame();
      const cw = f.v.cw || 1, ch = f.v.ch || 1;
      const pts = this.current.points;
      for (const ev of (events.length ? events : [e])) {
        const pt = this._toNorm(ev, f);
        const last = pts[pts.length - 1];
        const dx = (pt.x - last.x) * cw, dy = (pt.y - last.y) * ch;
        if ((dx * dx + dy * dy) < 0.36) continue; // 화면에서 0.6px 안쪽 점은 버림
        pts.push(pt);
      }
      // 예측 점: 펜 끝을 조금 앞서 그려 지연을 줄인다(가까운 것만, 저장 안 함)
      this._pred = null;
      if (typeof e.getPredictedEvents === "function") {
        try {
          const pr = e.getPredictedEvents();
          if (pr && pr.length) {
            const q = this._toNorm(pr[pr.length - 1], f), last = pts[pts.length - 1];
            if (Math.hypot((q.x - last.x) * cw, (q.y - last.y) * ch) < 40) this._pred = [{ x: q.x, y: q.y, p: last.p }];
          }
        } catch (_) { this._pred = null; }
      }
      this._scheduleDraw();
      this._maybeBroadcastLive();
    }, { passive: true });

    const finish = (e) => {
      if (!this.current || e.pointerId !== pid) return;
      const s = this.current;
      const liveN = this._liveN;
      this.current = null;
      this._liveN = 0;
      this._pred = null;
      try { c.releasePointerCapture(pid); } catch (_) {}
      pid = null; this._pid = null;
      if (s.shape) {
        const [ax, ay, bx, by] = s.box;
        if (Math.max(Math.abs(bx - ax) * REF_W, Math.abs(by - ay) * REF_H) * this.zoomFactor() < 4) s.points = []; // 거의 안 끌면 버림
        else s.box = s.box.map(r4);
      }
      if (s.shape && !s.points.length) {
        // 버린 도형: 아무것도 저장하지 않음
      } else if (s.tool === "eraser") {
        const ids = [];
        const keepS = [], keepK = [];
        const zf = this.zoomFactor(); // 확대해서 지우면 화면에서 보이는 만큼만 지움
        this.strokes.forEach((stk, i) => {
          if (this._intersects(stk, s, zf)) ids.push(this._keys[i]);
          else { keepS.push(stk); keepK.push(this._keys[i]); }
        });
        if (ids.length) {
          this.strokes = keepS;
          this._keys = keepK;
          this.cacheValid = false;
          this.onCommit({ type: "erase", ids });
        }
      } else if (s.points.length >= 2 || s.tool === "pen") {
        // 확정: id·작성자·좌표 반올림
        s.id = newId("st");
        s.by = this.authorId;
        s.points = s.points.map(p => ({ x: r4(p.x), y: r4(p.y), p: r2(p.p ?? 0.5) }));
        this.strokes.push(s);
        this._keys.push(s.id);
        this._mine.push(s.id);
        // 앞 구간은 이미 캐시에 있음(8) → 남은 끝 구간만. 캐시가 무효면 다음 렌더가 통째로 다시 그림
        if (liveN > 0 && this.cacheValid) this._paint(this.cacheCtx, [s], { from: liveN, to: s.points.length - 1, pts: s.points });
        else this._appendToCache(s);
        this.onCommit({ type: "add", stroke: s });
      } else if (liveN > 0) {
        this.cacheValid = false;
      }
      this._scheduleDraw();
      try { this.onEnd(); } catch (_) {}
    };
    on("pointerup", finish);
    on("pointercancel", finish);
    on("pointerleave", finish);
  }

  _maybeBroadcastLive() {
    const now = performance.now();
    if (!this._lastLive || now - this._lastLive > 80) {
      this._lastLive = now;
      this.onLive && this.onLive({ type: "live", stroke: this.current });
    }
  }

  _intersects(stroke, eraser, zf = 1) {
    // 화면에서 보이는 지우개 크기만큼: 지우개 굵기는 이미 배율로 나뉘어 있고, 고정 여유분만 배율로 줄임
    const r = (eraser.size || 12) / 1000 + 0.012 / Math.max(1, zf);
    const r2_ = r * r;
    for (const ep of eraser.points) {
      for (const p of stroke.points) {
        const dx = p.x - ep.x, dy = p.y - ep.y;
        if (dx * dx + dy * dy < r2_) return true;
      }
    }
    return false;
  }

  // rAF로 묶어서 그림
  _scheduleDraw() {
    if (this._raf || this._destroyed) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._render();
    });
  }

  _render() {
    if (this._destroyed) return;
    const { ctx, canvas } = this;
    if (!this.cacheValid) this._rebuildCache();
    const cur = this.current;
    // 펜 획: 뒤 점 2개가 정해진 구간(i ≤ 점 수 - 3)은 모양이 바뀌지 않으므로 캐시에 바로 그려 둔다(8)
    const inc = !!cur && cur.tool === "pen" && !cur.shape && cur.points.length >= 4;
    if (inc) {
      const upto = cur.points.length - 2;
      if (upto > this._liveN) {
        this._paint(this.cacheCtx, [cur], { from: this._liveN, to: upto, pts: cur.points });
        this._liveN = upto;
      }
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.cache, 0, 0);
    if (cur) {
      const pts = this._pred ? cur.points.concat(this._pred) : cur.points;
      if (inc) this._paint(ctx, [cur], { from: this._liveN, to: pts.length - 1, pts });
      else this._paint(ctx, [pts === cur.points ? cur : { ...cur, points: pts }]);
    }
  }

  // 보기 변환을 적용해 획 그리기(슬라이드 영역 밖은 잘라냄). range = { from, to, pts } → 그 구간만(8)
  _paint(g, list, range = null) {
    const draw = (s, W, H, k) => (range ? drawStrokeRange(g, s, W, H, k, range.from, range.to, range.pts) : drawStroke(g, s, W, H, k));
    if (!this.view) {
      for (const s of list) draw(s, g.canvas.width, g.canvas.height, this._k);  // 보기 없음 = 배율 1(실제 굵기)
      return;
    }
    const v = this.view, d = g.canvas.width / (this._cssW || 1);
    g.save();
    g.beginPath();
    g.rect(v.ox * d, v.oy * d, v.cw * d, v.ch * d);
    g.clip();
    g.translate(v.ox * d, v.oy * d);
    const zv = (v.cw || 1) / (v.baseW || v.cw || 1);
    // 7) 쓸 때 배율까지만 함께 커짐 — 축소하면 가늘어지고, 더 확대해도 쓸 때보다 굵어지지 않음
    for (const s of list) draw(s, v.cw * d, v.ch * d, this._k * Math.min(zv, s.zw || 1));
    g.restore();
  }

  _rebuildCache() {
    const { cache, cacheCtx } = this;
    cacheCtx.clearRect(0, 0, cache.width, cache.height);
    this._paint(cacheCtx, this.strokes);
    this.cacheValid = true;
    this._liveN = 0; // 그리는 중인 획의 확정 구간은 다음 렌더에서 다시 캐시에 그린다
  }

  _appendToCache(stroke) {
    if (!this.cacheValid) return; // 다음 _render에서 통째로 rebuild
    this._paint(this.cacheCtx, [stroke]);
  }

  // 외부에서 강제로 다시 그리고 싶을 때
  redraw() { this.cacheValid = false; this._scheduleDraw(); }
}

function sigOf(list, keys) {
  let s = list.length + "|";
  for (let i = 0; i < list.length; i++) {
    const k = keys[i];
    s += k.charCodeAt(0) === 35 /* '#' */ ? `${k}:${list[i].ts || 0}:${list[i].points?.length || 0},` : k + ",";
  }
  return s;
}

// 획 종류별 선 모양
function strokeStyle(ctx, s) {
  if (s.tool === "highlight") {
    ctx.globalAlpha = 0.32;
    ctx.lineCap = "butt";
    ctx.globalCompositeOperation = "multiply";
    ctx.strokeStyle = s.color || "#1c1c22";
    ctx.fillStyle = s.color || "#1c1c22";
  } else if (s.tool === "eraser") {
    // 지우개 트레일 (실제 삭제는 pointerup)
    ctx.globalAlpha = 0.35;
    ctx.lineCap = "round";
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "#9a9a9a";
    ctx.fillStyle = "#9a9a9a";
  } else {
    ctx.globalAlpha = 1;
    ctx.lineCap = "round";
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = s.color || "#1c1c22";
    ctx.fillStyle = s.color || "#1c1c22";
  }
  ctx.lineJoin = "round";
}

// 구간 [from, to)를 압력 가변 굵기 + Catmull-Rom 보간으로 (이웃 점은 pts 전체에서)
function strokeSegments(ctx, pts, W, H, baseW, from, to) {
  const N = 8;
  for (let i = from; i < to; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const pr = ((p1.p || 0.5) + (p2.p || 0.5)) / 2;
    ctx.lineWidth = baseW * (0.55 + 0.9 * pr);
    ctx.beginPath();
    ctx.moveTo(p1.x * W, p1.y * H);
    for (let t = 1; t <= N; t++) {
      const u = t / N;
      const u2 = u * u, u3 = u2 * u;
      const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * u + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3);
      const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * u + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3);
      ctx.lineTo(x * W, y * H);
    }
    ctx.stroke();
  }
}

// 그리는 중인 펜 획의 일부 구간만 그리기(증분 렌더, canvas 8). pts = 이웃 점까지 포함한 점 목록(예측 점 포함 가능)
export function drawStrokeRange(ctx, s, W, H, k, from, to, pts = s.points) {
  if (!s || !pts || to <= from) return;
  ctx.save();
  strokeStyle(ctx, s);
  strokeSegments(ctx, pts, W, H, (s.size || 2) * k, Math.max(0, from), Math.min(to, pts.length - 1));
  ctx.restore();
}

// 획 하나 그리기. k = 굵기 배율(디바이스 px)
export function drawStroke(ctx, s, W, H, k = 1) {
  if (!s || !s.points || s.points.length === 0) return;
  const baseW = (s.size || 2) * k;
  ctx.save();
  strokeStyle(ctx, s);

  // 도형(10): box로 정확하게, 고른 굵기
  if (s.shape && Array.isArray(s.box) && SHAPES.includes(s.shape)) {
    ctx.lineWidth = baseW;
    ctx.beginPath();
    shapePath(ctx, s.shape, s.box, s.size, W, H);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const pts = s.points;

  // 점 하나: 동그라미
  if (pts.length === 1) {
    const p = pts[0];
    ctx.beginPath();
    ctx.arc(p.x * W, p.y * H, Math.max(0.5, baseW / 2), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // 두 점: 직선
  if (pts.length === 2) {
    ctx.lineWidth = baseW;
    ctx.beginPath();
    ctx.moveTo(pts[0].x * W, pts[0].y * H);
    ctx.lineTo(pts[1].x * W, pts[1].y * H);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // 형광펜: 고정 굵기 한 경로(반투명 겹침 얼룩 방지)
  const N = 8;
  if (s.tool === "highlight") {
    ctx.lineWidth = baseW;
    ctx.beginPath();
    ctx.moveTo(pts[0].x * W, pts[0].y * H);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      for (let t = 1; t <= N; t++) {
        const u = t / N, u2 = u * u, u3 = u2 * u;
        const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * u + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3);
        const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * u + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3);
        ctx.lineTo(x * W, y * H);
      }
    }
    ctx.stroke();
    ctx.restore();
    return;
  }

  // 구간별 가변 굵기 + Catmull-Rom 보간
  strokeSegments(ctx, pts, W, H, baseW, 0, pts.length - 1);
  ctx.restore();
}

// 미니 캔버스(갤러리·썸네일·기록)용 정적 렌더. 캔버스 크기는 그대로 쓰거나 width/height로 지정.
// texts도 함께 그림(글자 크기는 폭/960 비례). removed id는 제외.
// region({x0,y0,x1,y1}, 슬라이드 정규화) → 그 영역만 캔버스에 꽉 차게 확대해서 그림(선·글자 모두 슬라이드와 함께 커짐).
// minPx = 가장 가는 선의 최소 굵기(캔버스 px) — 작은 칸에서도 보이게
export function paintStrokes(canvas, strokes, { removed = [], texts = [], width, height, region = null, minPx = 0.7 } = {}) {
  if (!canvas) return;
  if (width && canvas.width !== width) canvas.width = width;
  if (height && canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const W = region ? canvas.width / (region.x1 - region.x0) : canvas.width;
  const H = region ? canvas.height / (region.y1 - region.y0) : canvas.height;
  ctx.save();
  if (region) ctx.translate(-region.x0 * W, -region.y0 * H);
  const rm = removed && removed.length ? new Set(removed) : null;
  const k = W / REF_W;
  (strokes || []).forEach((s, i) => {
    if (rm && rm.has(strokeKey(s, i))) return;
    drawStroke(ctx, s, W, H, Math.max(k, minPx / Math.max(0.05, s.size || 2)));
  });
  for (const t of texts || []) {
    if (!t || !t.value || (rm && t.id && rm.has(t.id))) continue;
    drawTextBox(ctx, t, W, H, Math.max(4, (t.size || 16) * k), "Pretendard, -apple-system, system-ui, sans-serif");
  }
  ctx.restore();
}

// 글자 칸 하나 그리기(미니·기록·인쇄 공용) — 화면의 .text-block과 같은 자리·여백·줄 간격·줄바꿈.
// 칸 폭 = t.w(v2.8 칸 크기), 없으면 글자에 맞춰 늘어나는 칸처럼 min(70%, 오른쪽 끝까지). fs = 캔버스 px 글자 크기
// 부분 색(11): 글자별 색으로 줄마다 같은 색끼리 이어 칠함
export function drawTextBox(ctx, t, W, H, fs, family) {
  const padX = fs * 0.45, padY = fs * 0.3, lh = fs * 1.3;
  const boxW = (t.w > 0 ? t.w : Math.min(0.7, Math.max(0.05, 1 - (t.x || 0)))) * W;
  const maxW = Math.max(fs, boxW - padX * 2);
  const base = t.color || "#1c1c22";
  const runs = textRuns(t);
  let cols = null;
  if (runs) { cols = []; for (const r of runs) for (let i = 0; i < r.t.length; i++) cols.push(r.c || base); }
  ctx.save();
  ctx.fillStyle = base;
  ctx.font = `${fs}px ${family}`;
  ctx.textBaseline = "top";
  let y = (t.y || 0) * H + padY, off = 0;
  const x = (t.x || 0) * W + padX;
  for (const para of String(t.value).split("\n")) {
    for (const [a, b] of wrapLine(ctx, para, maxW)) {
      if (!cols) ctx.fillText(para.slice(a, b), x, y);
      else {
        let cx = x;
        for (let i = a; i < b;) {
          let j = i + 1;
          while (j < b && cols[off + j] === cols[off + i]) j++;
          const seg = para.slice(i, j);
          ctx.fillStyle = cols[off + i] || base;
          ctx.fillText(seg, cx, y);
          cx += ctx.measureText(seg).width;
          i = j;
        }
      }
      y += lh;
    }
    off += para.length + 1;
  }
  ctx.restore();
}
// 한 줄을 칸 폭에 맞춰 나눔 → 줄마다 [시작, 끝) 글자 위치: 띄어쓰기 단위, 한 낱말이 칸보다 길면 글자 단위(화면 word-break: break-word와 같게)
function wrapLine(ctx, text, maxW) {
  const n = text ? text.length : 0;
  if (!n || ctx.measureText(text).width <= maxW) return [[0, n]];
  const out = [];
  let s = 0, e = 0; // 지금 줄 = text[s, e)
  const fits = (b) => ctx.measureText(text.slice(s, b)).width <= maxW;
  const flush = () => { if (e > s) out.push([s, e]); };
  for (const m of text.matchAll(/\s+|\S+/g)) {
    const a = m.index, b = a + m[0].length;
    if (e === s) s = e = a;
    if (fits(b)) { e = b; continue; }
    if (!m[0].trim()) { flush(); s = e = b; continue; } // 줄 끝 공백은 버림
    flush(); s = e = a;
    for (const ch of m[0]) {
      if (e > s && !fits(e + ch.length)) { out.push([s, e]); s = e; }
      e += ch.length;
    }
  }
  flush();
  return out.length ? out : [[0, 0]];
}

// ── 텍스트 부분 색(11) ──
// runs가 value와 맞으면 그 조각들, 아니면 null(한 색)
export function textRuns(t) {
  const r = t && t.runs;
  if (!Array.isArray(r) || !r.length) return null;
  return r.map(x => String((x && x.t) || "")).join("") === String(t.value || "") ? r : null;
}

// ── 도형(10) ──
export const SHAPES = ["line", "arrow", "rect", "ellipse", "tri"];
// 기준 화면 px 꼭짓점 목록(닫힌 도형은 첫 점 반복). 화살표는 [꼬리, 끝, 날개1, 끝, 날개2]
function shapeVerts(kind, box, size) {
  const [ax, ay, bx, by] = box;
  const x0 = Math.min(ax, bx) * REF_W, x1 = Math.max(ax, bx) * REF_W, y0 = Math.min(ay, by) * REF_H, y1 = Math.max(ay, by) * REF_H;
  const A = { x: ax * REF_W, y: ay * REF_H }, B = { x: bx * REF_W, y: by * REF_H };
  if (kind === "line") return [A, B];
  if (kind === "rect") return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }];
  if (kind === "tri") { const top = { x: (x0 + x1) / 2, y: y0 }; return [top, { x: x1, y: y1 }, { x: x0, y: y1 }, top]; }
  if (kind === "arrow") {
    const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
    const head = Math.min(len * 0.45, Math.max(12, 6 + (size || 2) * 3.2));
    const ang = Math.atan2(B.y - A.y, B.x - A.x), spread = 0.5;
    const w1 = { x: B.x - head * Math.cos(ang - spread), y: B.y - head * Math.sin(ang - spread) };
    const w2 = { x: B.x - head * Math.cos(ang + spread), y: B.y - head * Math.sin(ang + spread) };
    return [A, B, w1, B, w2];
  }
  return null;
}
// 캔버스 경로(W×H 그림 위)
function shapePath(ctx, kind, box, size, W, H) {
  const kx = W / REF_W, ky = H / REF_H;
  if (kind === "ellipse") {
    const [ax, ay, bx, by] = box;
    ctx.ellipse((ax + bx) / 2 * W, (ay + by) / 2 * H, Math.max(0.5, Math.abs(bx - ax) / 2 * W), Math.max(0.5, Math.abs(by - ay) / 2 * H), 0, 0, Math.PI * 2);
    return;
  }
  const v = shapeVerts(kind, box, size);
  if (!v) return;
  ctx.moveTo(v[0].x * kx, v[0].y * ky);
  for (let i = 1; i < v.length; i++) ctx.lineTo(v[i].x * kx, v[i].y * ky);
  if (kind === "rect" || kind === "tri") ctx.closePath();
}
// 윤곽을 SHAPE_STEP 간격 점으로(정규화, 압력 0.5)
export function shapePoints(kind, box, size) {
  const out = [];
  const add = (x, y) => out.push({ x: r4(x / REF_W), y: r4(y / REF_H), p: 0.5 });
  if (kind === "ellipse") {
    const [ax, ay, bx, by] = box;
    const cx = (ax + bx) / 2 * REF_W, cy = (ay + by) / 2 * REF_H, rx = Math.abs(bx - ax) / 2 * REF_W, ry = Math.abs(by - ay) / 2 * REF_H;
    const n = Math.max(12, Math.ceil(Math.PI * (rx + ry) / SHAPE_STEP));
    for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; add(cx + rx * Math.cos(a), cy + ry * Math.sin(a)); }
    return out;
  }
  const v = shapeVerts(kind, box, size) || [];
  v.forEach((p, i) => {
    if (!i) { add(p.x, p.y); return; }
    const q = v[i - 1], n = Math.max(1, Math.ceil(Math.hypot(p.x - q.x, p.y - q.y) / SHAPE_STEP));
    for (let j = 1; j <= n; j++) add(q.x + (p.x - q.x) * j / n, q.y + (p.y - q.y) * j / n);
  });
  return out;
}
// Shift: 네모·동그라미·세모는 정사각형, 직선·화살표는 45° 단위
function constrainShape(kind, ax, ay, bx, by) {
  const dx = (bx - ax) * REF_W, dy = (by - ay) * REF_H;
  if (kind === "line" || kind === "arrow") {
    const len = Math.hypot(dx, dy), a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return { x: ax + len * Math.cos(a) / REF_W, y: ay + len * Math.sin(a) / REF_H };
  }
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: ax + Math.sign(dx || 1) * m / REF_W, y: ay + Math.sign(dy || 1) * m / REF_H };
}
