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
// 7) 확대·이동 화면에서 선 굵기는 화면 기준으로 고정 — 확대해도(쓸 때도, 볼 때도) 같은 펜은 같은 굵기로 보인다.
//    저장하는 굵기도 확대 배율과 무관(펜 S/M/L 값 그대로). 기록·썸네일·인쇄 같은 정적 그림은 기존대로 그림 폭 비례.

import { newId } from "./slides/registry.js";

const REF_W = 960; // 선 굵기·글자 크기 기준 프레임 폭(px)

const r4 = (v) => Math.round(v * 10000) / 10000;
const r2 = (v) => Math.round(v * 100) / 100;

// 획 키: id 우선, 없으면 인덱스
export function strokeKey(s, i) { return (s && s.id) || ("#" + i); }

export class InkCanvas {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
    this.dpr = window.devicePixelRatio || 1;
    this.tool = "pen";
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

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);

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
    this.dpr = window.devicePixelRatio || 1; // 모니터 이동 시 갱신
    // 레이아웃 크기(변환 무시) — 확대 중 CSS transform이 걸려 있어도 비트맵 크기가 흔들리지 않게
    const r = canvas.getBoundingClientRect();
    this._cssW = canvas.clientWidth || r.width;
    this._cssH = canvas.clientHeight || r.height;
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
  zoomFactor() { const v = this._v(); return (v.cw || 1) / (v.baseW || v.cw || 1); }

  _toNorm(ev) {
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    const sx = (c.clientWidth || r.width) / (r.width || 1), sy = (c.clientHeight || r.height) / (r.height || 1);
    const v = this._v();
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
      if (this.current) return; // 멀티터치: 첫 포인터만
      const pt = this._toNorm(e);
      if (!this._inside(pt)) return;
      pid = e.pointerId;
      this._pid = pid;
      try { c.setPointerCapture(pid); } catch (_) {}
      this.current = {
        tool: this.tool,
        color: this.color,
        // 형광펜은 굵게(확대 배율과 무관하게 같은 값으로 저장)
        size: this.tool === "highlight" ? this.size * 4 : this.size,
        points: [pt],
        ts: Date.now(),
      };
      this._scheduleDraw();
      e.preventDefault();
    }, { passive: false });

    on("pointermove", (e) => {
      if (!this.current || e.pointerId !== pid) return;
      // coalesced 이벤트로 중간 점 보충 → 부드러운 선
      const events = (typeof e.getCoalescedEvents === "function") ? e.getCoalescedEvents() : [e];
      const pts = this.current.points;
      for (const ev of (events.length ? events : [e])) {
        const pt = this._toNorm(ev);
        const last = pts[pts.length - 1];
        const dx = pt.x - last.x, dy = pt.y - last.y;
        if ((dx * dx + dy * dy) < 0.0000001) continue;
        pts.push(pt);
      }
      this._scheduleDraw();
      this._maybeBroadcastLive();
    }, { passive: true });

    const finish = (e) => {
      if (!this.current || e.pointerId !== pid) return;
      const s = this.current;
      this.current = null;
      try { c.releasePointerCapture(pid); } catch (_) {}
      pid = null; this._pid = null;
      if (s.tool === "eraser") {
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
        this._appendToCache(s);
        this.onCommit({ type: "add", stroke: s });
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
    // 화면에서 보이는 지우개 크기만큼 → 확대 배율만큼 슬라이드 위 반경을 줄임
    const r = ((eraser.size || 12) / 1000 + 0.012) / Math.max(1, zf);
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
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.cache, 0, 0);
    if (this.current) this._paint(ctx, [this.current]);
  }

  // 보기 변환을 적용해 획 그리기(슬라이드 영역 밖은 잘라냄)
  _paint(g, list) {
    if (!this.view) {
      for (const s of list) drawStroke(g, s, g.canvas.width, g.canvas.height, this._k);
      return;
    }
    const v = this.view, d = g.canvas.width / (this._cssW || 1);
    g.save();
    g.beginPath();
    g.rect(v.ox * d, v.oy * d, v.cw * d, v.ch * d);
    g.clip();
    g.translate(v.ox * d, v.oy * d);
    for (const s of list) drawStroke(g, s, v.cw * d, v.ch * d, this._k);
    g.restore();
  }

  _rebuildCache() {
    const { cache, cacheCtx } = this;
    cacheCtx.clearRect(0, 0, cache.width, cache.height);
    this._paint(cacheCtx, this.strokes);
    this.cacheValid = true;
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

// 획 하나 그리기. k = 굵기 배율(디바이스 px)
export function drawStroke(ctx, s, W, H, k = 1) {
  if (!s || !s.points || s.points.length === 0) return;
  const baseW = (s.size || 2) * k;
  ctx.save();
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
  for (let i = 0; i < pts.length - 1; i++) {
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
  ctx.restore();
}

// 미니 캔버스(갤러리·썸네일·기록)용 정적 렌더. 캔버스 크기는 그대로 쓰거나 width/height로 지정.
// texts도 함께 그림(글자 크기는 폭/960 비례). removed id는 제외.
// region({x0,y0,x1,y1}, 슬라이드 정규화) → 그 영역만 캔버스에 꽉 차게 확대해서 그림. lineK = 선 굵기 배율(기본 폭/960)
//   확대해도 선 굵기는 lineK 그대로(화면 기준 고정), 글자는 슬라이드와 함께 커짐.
export function paintStrokes(canvas, strokes, { removed = [], texts = [], width, height, region = null, lineK = null } = {}) {
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
  const k = W / REF_W, kl = lineK || k;
  (strokes || []).forEach((s, i) => {
    if (rm && rm.has(strokeKey(s, i))) return;
    drawStroke(ctx, s, W, H, kl);
  });
  for (const t of texts || []) {
    if (!t || !t.value || (rm && t.id && rm.has(t.id))) continue;
    const fs = Math.max(4, (t.size || 16) * k);
    ctx.save();
    ctx.fillStyle = t.color || "#1c1c22";
    ctx.font = `${fs}px Pretendard, -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = "top";
    String(t.value).split("\n").forEach((line, li) => {
      ctx.fillText(line, t.x * W + fs * 0.45, t.y * H + fs * 0.3 + li * fs * 1.3);
    });
    ctx.restore();
  }
  ctx.restore();
}
