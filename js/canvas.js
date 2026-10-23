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
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * this.dpr));
    const h = Math.max(1, Math.round(r.height * this.dpr));
    this._k = this.dpr * Math.min(1.6, Math.max(0.7, (r.width || REF_W) / REF_W));
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

  _toNorm(ev) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left) / (r.width || 1),
      y: (ev.clientY - r.top) / (r.height || 1),
      p: ev.pressure && ev.pressure > 0 ? ev.pressure : 0.5,
    };
  }

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
      pid = e.pointerId;
      try { c.setPointerCapture(pid); } catch (_) {}
      const pt = this._toNorm(e);
      this.current = {
        tool: this.tool,
        color: this.color,
        // 형광펜은 굵게
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
      pid = null;
      if (s.tool === "eraser") {
        const ids = [];
        const keepS = [], keepK = [];
        this.strokes.forEach((stk, i) => {
          if (this._intersects(stk, s)) ids.push(this._keys[i]);
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

  _intersects(stroke, eraser) {
    const r = (eraser.size || 12) / 1000 + 0.012;
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
    if (this.current) drawStroke(ctx, this.current, canvas.width, canvas.height, this._k);
  }

  _rebuildCache() {
    const { cache, cacheCtx } = this;
    cacheCtx.clearRect(0, 0, cache.width, cache.height);
    for (const s of this.strokes) drawStroke(cacheCtx, s, cache.width, cache.height, this._k);
    this.cacheValid = true;
  }

  _appendToCache(stroke) {
    if (!this.cacheValid) return; // 다음 _render에서 통째로 rebuild
    drawStroke(this.cacheCtx, stroke, this.cache.width, this.cache.height, this._k);
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
export function paintStrokes(canvas, strokes, { removed = [], texts = [], width, height } = {}) {
  if (!canvas) return;
  if (width && canvas.width !== width) canvas.width = width;
  if (height && canvas.height !== height) canvas.height = height;
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  const rm = removed && removed.length ? new Set(removed) : null;
  const k = W / REF_W;
  (strokes || []).forEach((s, i) => {
    if (rm && rm.has(strokeKey(s, i))) return;
    drawStroke(ctx, s, W, H, k);
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
}
