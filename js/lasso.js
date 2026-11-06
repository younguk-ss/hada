// 올가미(v2.19) — Goodnotes처럼 필기를 둘러싸 고르고 끌어서 옮기기 (교사·학생 공통, lesson-view가 씀)
//
// 쓰는 법: 도구바 '올가미' → 옮길 획·글 상자를 한 번에 둘러싸 그린다 → 점선 상자 안을 끌면 옮겨지고, 놓으면 저장.
//   상자 위 막대: [색 바꾸기는 도구바 색] · 🗑 지우기 · ✕ 선택 해제. 상자 밖을 누르면 다시 고르기. Delete·Backspace = 지우기, Esc = 해제.
//   되돌리기는 옮기기·지우기·색 바꾸기도 한 번에 되돌린다(InkCanvas 기록 스택).
// 입력 규칙은 펜과 같다(js/zoom-view.js·pen-input.js): 펜·마우스는 언제나, 손가락은 '손가락 필기'가 켜졌을 때만, 두 손가락 = 확대·이동.
// 고르는 기준: 획은 점(최대 24개)의 절반 이상이 올가미 안, 글 상자는 가운데가 안. 편집기 기본 필기(바닥 레이어)는 고르지 않는다(지우개처럼 원본 보호).
// 최적화: 고르는 순간 고른 획을 InkCanvas '떠 있는 층'(비트맵 한 장)으로 — 끄는 동안 프레임마다 그림 2장, 놓아도·풀어도 쪽 전체를
//   다시 그리지 않는다(풀 때 비트맵을 캐시에 찍음). 저장은 지운 표시 + 새 획 한 번(cloud.js가 오래된 지운 표시는 묶음 행으로 옮김).
// 가정: 획은 바뀌지 않는 값(병합·묶음 행이 id로 합침) → 옮기기·색 바꾸기는 '옛 id 지움 + 새 id 획'. 글 상자는 같은 id에 x·y·ts만 고침.
// 가정: 끄는 동안 다른 기기 변경은 손을 뗀 뒤 반영(InkCanvas.isDrawing이 참). 고른 획이 다른 기기에서 지워지면 선택에서 뺀다.
import { el } from "./ui.js";
import { injectCss } from "./slides/registry.js";
import { strokeBounds, inPolygon } from "./canvas.js";

const CSS = `
.lasso-bar { position:absolute; z-index:4; display:flex; align-items:center; gap:2px; padding:3px; border-radius:999px;
  background:var(--surface, #fff); box-shadow:0 2px 10px rgba(0,0,0,.18), 0 0 0 1px var(--line, #e4e2dc); transform:translate(-50%, -100%);
  pointer-events:auto; touch-action:manipulation; -webkit-user-select:none; user-select:none; white-space:nowrap; }
.lasso-bar[hidden] { display:none; }
.lasso-bar.below { transform:translate(-50%, 0); }
.lasso-bar .lasso-n { font-size:12px; color:var(--muted, #6b6b6b); padding:0 6px 0 8px; font-variant-numeric:tabular-nums; }
.lasso-bar button { width:34px; height:34px; border:0; border-radius:50%; background:transparent; color:var(--ink, #1c1c22);
  display:grid; place-items:center; padding:0; cursor:pointer; }
.lasso-bar button:hover { background:var(--surface-2, #f1f0ec); }
.lasso-bar button.danger { color:var(--danger, #dc2626); }
`;
const ICON = {
  trash: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
};
const ACCENT = "#4f46e5";

// hooks = {
//   selectable(key, stroke) → bool          고를 수 있는 획인가(바닥 레이어 제외)
//   texts() → [{ key, x, y, w, h }]         고를 수 있는 글 상자(정규화 사각형)
//   apply({ keys, texts, dx, dy, color }) → { keys, texts, undo } | null   옮기기·색 바꾸기 저장(새 획 id 돌려줌)
//   remove({ keys, texts }) → { undo } | null                              지우기 저장
//   previewTexts(texts, dx, dy)              끄는 동안 글 상자 미리 옮기기(0,0 = 원래 자리)
// }
export function createLasso({ ink, canvas, hooks }) {
  injectCss("lasso", CSS);
  let active = false, destroyed = false;
  let path = null;   // 그리는 중인 올가미 [{x,y}]
  let sel = null;    // { keys:[], texts:[], box:{x0,y0,x1,y1} }
  let drag = null;   // { sx, sy, dx, dy, moved }
  let busy = false;  // 저장(hooks.apply/remove) 중 — 그 사이 lesson-view가 곧바로 부르는 refresh가 선택을 건드리지 않게
  const host = canvas.parentElement;

  const count = el("span", { class: "lasso-n" }, "");
  const btn = (cls, label, html, run) => {
    const b = el("button", { type: "button", class: cls, title: label, "aria-label": label, html });
    b.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); });
    b.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); run(); });
    return b;
  };
  const bar = el("div", { class: "lasso-bar zv-own", hidden: true, role: "toolbar", "aria-label": "고른 필기" }, [
    count,
    btn("danger", "고른 필기 지우기", ICON.trash, () => removeSel()),
    btn("", "선택 해제", ICON.close, () => clear()),
  ]);
  bar.addEventListener("pointerdown", (e) => e.stopPropagation());
  if (host) host.appendChild(bar);

  const m = () => ink.mapper();
  // 끌기 시작으로 볼 상자 둘레 여유(화면 14px)
  function inBox(pt) {
    if (!sel) return false;
    const { v } = m();
    const mx = 14 / (v.cw || 1), my = 14 / (v.ch || 1);
    const b = sel.box;
    return pt.x >= b.x0 - mx && pt.x <= b.x1 + mx && pt.y >= b.y0 - my && pt.y <= b.y1 + my;
  }
  function boxOf(keys, texts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of keys) {
      const s = ink.strokeOf(k);
      if (!s) continue;
      const b = strokeBounds(s); // 점 범위 + 굵기 여유(캐시됨)
      if (b.x0 < x0) x0 = b.x0; if (b.y0 < y0) y0 = b.y0; if (b.x1 > x1) x1 = b.x1; if (b.y1 > y1) y1 = b.y1;
    }
    for (const t of texts) { if (t.x < x0) x0 = t.x; if (t.y < y0) y0 = t.y; if (t.x + t.w > x1) x1 = t.x + t.w; if (t.y + t.h > y1) y1 = t.y + t.h; }
    if (!isFinite(x0)) return null;
    const p = 0.004;
    return { x0: x0 - p, y0: y0 - p * 1.6, x1: x1 + p, y1: y1 + p * 1.6 };
  }
  function setSel(keys, texts) {
    const box = boxOf(keys, texts);
    sel = box && (keys.length || texts.length) ? { keys, texts, box } : null;
    // 고르는 순간 떠 있는 층으로(끌기를 바로 시작해도 쪽 전체를 다시 그리지 않게) — 같은 획이면 그대로
    if (sel && sel.keys.length) ink.floatStart(sel.keys); else ink.floatEnd();
    placeBar();
    ink.requestDraw();
  }
  function clear() {
    if (drag) cancel();
    path = null;
    ink.floatEnd();
    if (!sel) { placeBar(); ink.requestDraw(); return; }
    sel = null;
    placeBar();
    ink.requestDraw();
  }
  function placeBar() {
    if (!sel || drag || !active || destroyed) { bar.hidden = true; return; }
    const n = sel.keys.length + sel.texts.length;
    count.textContent = n + "개";
    const mm = m(), b = sel.box;
    const ox = canvas.offsetLeft || 0, oy = canvas.offsetTop || 0;
    const cx = ox + mm.cssX((b.x0 + b.x1) / 2);
    const top = oy + mm.cssY(b.y0), bottom = oy + mm.cssY(b.y1);
    const below = top < 56;
    const hw = host ? host.clientWidth : 9999;
    bar.hidden = false;
    bar.classList.toggle("below", below);
    bar.style.left = Math.max(60, Math.min(hw - 60, cx)) + "px";
    bar.style.top = (below ? bottom + 8 : top - 8) + "px";
  }

  // ── 포인터(InkCanvas가 넘겨줌) ──
  const handler = {
    down(pt) {
      if (!active) return;
      if (sel && inBox(pt)) { drag = { sx: pt.x, sy: pt.y, dx: 0, dy: 0, moved: false }; placeBar(); return; }
      sel = null; ink.floatEnd(); placeBar();
      path = [pt];
      ink.requestDraw();
    },
    move(list) {
      if (!list.length) return;
      if (drag) {
        const pt = list[list.length - 1], b = sel.box;
        // 상자가 종이 밖으로 나가지 않게(상자가 종이보다 크면 그대로)
        let dx = pt.x - drag.sx, dy = pt.y - drag.sy;
        const w = b.x1 - b.x0, h = b.y1 - b.y0;
        dx = w >= 1 ? 0 : Math.max(-b.x0, Math.min(1 - b.x1, dx));
        dy = h >= 1 ? 0 : Math.max(-b.y0, Math.min(1 - b.y1, dy));
        const { v } = m();
        if (!drag.moved && Math.hypot(dx * v.cw, dy * v.ch) < 3) return;
        drag.moved = true;
        drag.dx = dx; drag.dy = dy;
        ink.floatMove(dx, dy);
        hooks.previewTexts(sel.texts, dx, dy);
        ink.requestDraw();
        return;
      }
      if (!path) return;
      const { v } = m();
      for (const p of list) {
        const q = path[path.length - 1];
        if (Math.hypot((p.x - q.x) * v.cw, (p.y - q.y) * v.ch) >= 2) path.push(p);
      }
      ink.requestDraw();
    },
    up(pt) {
      if (drag) {
        const d = drag;
        drag = null;
        if (d.moved && (d.dx || d.dy)) commitMove(d.dx, d.dy);
        else { ink.floatMove(0, 0); hooks.previewTexts(sel ? sel.texts : [], 0, 0); }
        placeBar();
        ink.requestDraw();
        return;
      }
      if (!path) return;
      path.push(pt);
      const poly = simplify(path);
      path = null;
      const { v } = m();
      const span = polySpan(poly);
      if (poly.length < 3 || span.w * v.cw + span.h * v.ch < 16) { clear(); return; } // 톡 누르기 = 해제
      const keys = ink.selectInPolygon(poly, hooks.selectable);
      const texts = (hooks.texts() || []).filter(t => inPolygon(t.x + t.w / 2, t.y + t.h / 2, poly));
      setSel(keys, texts);
    },
    cancel() { cancel(); },
  };
  function cancel() {
    if (drag) {
      drag = null;
      ink.floatMove(0, 0);
      hooks.previewTexts(sel ? sel.texts : [], 0, 0);
    }
    path = null;
    placeBar();
    ink.requestDraw();
  }
  function textKeys() { return sel ? sel.texts.map(t => t.key) : []; }
  function commitMove(dx, dy) {
    const cur = sel;
    if (!cur) return;
    let res = null;
    busy = true;
    try { res = hooks.apply({ keys: cur.keys, texts: textKeys(), dx, dy }); } finally { busy = false; }
    hooks.previewTexts(cur.texts, 0, 0);
    if (!res) { ink.floatMove(0, 0); return; }
    if (res.undo) ink.pushUndo(() => { const ok = res.undo(); clear(); return ok; });
    refreshSel(res.keys, res.texts);
  }
  function refreshSel(keys, textKeysNow) {
    const all = hooks.texts() || [];
    const texts = (textKeysNow || []).map(k => all.find(t => t.key === k)).filter(Boolean);
    const alive = new Set(ink.keys());
    setSel((keys || []).filter(k => alive.has(k)), texts);
  }
  function removeSel() {
    if (!sel) return;
    let res = null;
    busy = true;
    try { res = hooks.remove({ keys: sel.keys, texts: textKeys() }); } finally { busy = false; }
    sel = null;
    placeBar();
    ink.requestDraw();
    if (res && res.undo) ink.pushUndo(() => res.undo());
  }
  // 도구바 색: 고른 것이 있으면 그 색으로. 바꿨으면 true
  function recolor(c) {
    if (!sel || !c || drag) return false;
    let res = null;
    busy = true;
    try { res = hooks.apply({ keys: sel.keys, texts: textKeys(), dx: 0, dy: 0, color: c }); } finally { busy = false; }
    if (!res) return false;
    if (res.undo) ink.pushUndo(() => { const ok = res.undo(); clear(); return ok; });
    refreshSel(res.keys, res.texts);
    return true;
  }

  // ── 그리기(InkCanvas 매 프레임 마지막) ──
  function overlay(ctx, mm) {
    if (!active) return;
    const d = mm.d;
    ctx.save();
    ctx.lineWidth = 1.5 * d;
    ctx.strokeStyle = ACCENT;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    if (path && path.length > 1) {
      ctx.setLineDash([6 * d, 5 * d]);
      ctx.beginPath();
      ctx.moveTo(mm.x(path[0].x), mm.y(path[0].y));
      for (let i = 1; i < path.length; i++) ctx.lineTo(mm.x(path[i].x), mm.y(path[i].y));
      ctx.stroke();
      ctx.globalAlpha = 0.06; ctx.fillStyle = ACCENT; ctx.fill();
    }
    if (sel) {
      const b = sel.box, dx = drag ? drag.dx : 0, dy = drag ? drag.dy : 0;
      const x = mm.x(b.x0 + dx), y = mm.y(b.y0 + dy), w = mm.x(b.x1 + dx) - x, h = mm.y(b.y1 + dy) - y;
      ctx.globalAlpha = 0.07; ctx.fillStyle = ACCENT; ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1; ctx.setLineDash([7 * d, 5 * d]);
      ctx.strokeRect(x, y, w, h);
    }
    ctx.restore();
  }
  ink.setOverlay(overlay);
  ink.setToolHandler(handler);
  const prevOnView = ink.onView;
  ink.onView = () => { try { prevOnView && prevOnView(); } catch (_) {} placeBar(); };

  function onKey(e) {
    if (!active || !sel || destroyed || e.defaultPrevented) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.documentElement.classList.contains("has-layer")) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeSel(); }
    else if (e.key === "Escape") { e.preventDefault(); clear(); }
  }
  document.addEventListener("keydown", onKey);

  return {
    setActive(on) {
      on = !!on;
      if (on === active) return;
      active = on;
      if (!on) clear(); else ink.requestDraw();
    },
    get active() { return active; },
    hasSelection: () => !!sel,
    recolor,
    clear,
    // 다른 기기 변경 반영 뒤(lesson-view doRefresh): 사라진 획·글은 선택에서 빼고 상자 다시 계산
    refresh() {
      if (!sel || drag || busy) return;
      const alive = new Set(ink.keys());
      const keys = sel.keys.filter(k => alive.has(k));
      const all = hooks.texts() || [];
      const texts = sel.texts.map(t => all.find(x => x.key === t.key)).filter(Boolean);
      if (keys.length === sel.keys.length && texts.length === sel.texts.length && texts.every((t, i) => t.x === sel.texts[i].x && t.y === sel.texts[i].y)) return;
      setSel(keys, texts);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      document.removeEventListener("keydown", onKey);
      try { ink.setToolHandler(null); ink.setOverlay(null); ink.floatEnd(); } catch (_) {}
      ink.onView = prevOnView || null;
      bar.remove();
    },
  };
}

// 올가미 점 줄이기(최대 160개) — 고르기 계산이 가볍게
function simplify(pts) {
  if (pts.length <= 160) return pts.slice();
  const step = pts.length / 160, out = [];
  for (let i = 0; i < 160; i++) out.push(pts[Math.floor(i * step)]);
  out.push(pts[pts.length - 1]);
  return out;
}
function polySpan(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  return { w: x1 - x0, h: y1 - y0 };
}
