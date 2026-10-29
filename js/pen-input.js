// 펜·손바닥 입력 공용 (필기 화면) — iPad Safari(Apple Pencil) · Android Chrome/삼성 인터넷(S펜) · Chromebook 스타일러스
//
// 증상과 원인 → 대책
// 1) 손을 올려 두고 쓰면 필기가 안 되거나 화면이 끌림:
//    손바닥(터치)이 펜보다 먼저 닿으면 캔버스가 그 터치를 '첫 포인터'로 잡아 선을 긋고(펜은 무시),
//    손바닥 접점이 둘이면 두 손가락 확대·이동이 시작돼 화면이 끌리고 펜이 막혔다.
//    → 펜 우선: 펜이 닿는 순간 이미 닿아 있던 터치는 모두 '손바닥'(뗄 때까지 무시)으로 표시하고, 그 터치가 긋던 선은 취소하고
//      확대·이동은 그 자리에서 멈춘다(zoom-view). 펜이 닿아 있거나 막 떼거나 띄워 둔(호버) 동안 닿는 터치도 손바닥. 접촉면이 아주 큰 터치도 손바닥.
//      펜을 한 번 쓴 기기는 그 뒤로 손가락으로 필기하지 않는다(기기에 기억, 도구바 ✋로 다시 켤 수 있음).
// 2) 손바닥이 도구바 버튼을 누름: 펜을 쓰는 동안 닿아 있던 터치가 떼어질 때 생기는 click은 버린다.
// 3) 브라우저 기본 동작: 길게 누르기·S펜 옆 버튼·Chromebook 길게 누르기 = 오른쪽 클릭 메뉴(contextmenu),
//    펜으로 끌면 글자 선택(selectstart)·끌어 놓기(dragstart) → '다른 영역이 선택되고 화면이 끌림'.
//    → 필기 화면(.stu .live .editor .ink-wrap 등) 안에서 막는다(입력칸 제외). iPad Safari의 확대경·글자 선택·콜아웃은
//      캔버스 touchstart preventDefault(zoom-view)와 CSS(-webkit-user-select·-webkit-touch-callout)로 막는다.
// 가정: '손가락 필기' 설정은 기기(localStorage 'hada:penMode')에 기억 — 'pen'(펜만), 'touch'(손가락도), 없음 = 자동(아직 펜을 안 씀 → 손가락 필기).
// 가정: 호버(펜을 띄워 둠)는 손바닥 판정에만 쓰고, 도구바 click을 버리는 데는 쓰지 않는다(펜을 든 채 다른 손가락으로 버튼을 누를 수 있게).

const MODE_KEY = "hada:penMode";
export const PEN_GRACE_MS = 600; // 펜을 떼거나 띄워 둔 뒤 이 시간 안에 닿는 터치는 손바닥
export const PALM_PX = 90;       // 접촉면(가로·세로 중 큰 쪽, CSS px)이 이 이상이면 손바닥(펜을 쓰는 기기에서만)
const CLICK_MS = 800;            // 손바닥을 뗀 뒤 이 시간 안의 click은 버림

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

let mode = readMode();
const pensDown = new Set();
let lastPenAt = -1e9, lastPenUpAt = -1e9;
const touches = new Map(); // 터치 pointerId → { target, palm }
let palmClick = null;      // { target, t } 손바닥이 떼어진 곳·시각
const listeners = new Set();

function readMode() {
  try { const v = localStorage.getItem(MODE_KEY); return v === "pen" || v === "touch" ? v : null; } catch { return null; }
}
function setMode(v) {
  const prev = mode;
  mode = v;
  try { localStorage.setItem(MODE_KEY, v); } catch {}
  for (const fn of listeners) { try { fn(mode, prev); } catch (e) { console.warn("[pen]", e); } }
}

// 이 기기에서 펜을 쓴 적이 있는가
export function penKnown() { return mode !== null; }
// 손가락(한 손가락)으로 필기하는가
export function fingerDraws() { return mode !== "pen"; }
export function setFingerDraw(on) { setMode(on ? "touch" : "pen"); }
export function onPenModeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// 펜이 닿아 있음 / 닿아 있거나 막 떼거나 띄워 둠
export function penDown() { return pensDown.size > 0; }
export function penRecent(ms = PEN_GRACE_MS) { return pensDown.size > 0 || now() - lastPenAt < ms; }
export function bigContact(e) { return Math.max(+e.width || 0, +e.height || 0) >= PALM_PX; }
// 이 터치를 손바닥으로 볼지 (펜이 가까이 있음 · 펜이 닿을 때 이미 닿아 있었음 · 접촉면이 큼)
export function isPalmTouch(e) {
  if (!e || e.pointerType !== "touch") return false;
  const t = touches.get(e.pointerId);
  return !!(t && t.palm) || penRecent() || (penKnown() && bigContact(e));
}
export function markPalm(pointerId) { const t = touches.get(pointerId); if (t) t.palm = true; }

// ── 문서 전체 감시(앱 부팅 시 1회) ──
if (typeof window !== "undefined" && !window.__hadaPenInput) {
  window.__hadaPenInput = true;
  const cap = { capture: true, passive: true };
  window.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "pen") {
      pensDown.add(e.pointerId);
      lastPenAt = now();
      for (const t of touches.values()) t.palm = true; // 펜보다 먼저 닿아 있던 터치 = 손바닥
      if (mode === null) setMode("pen");
      return;
    }
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, { target: e.target, palm: penDown() || (penKnown() && bigContact(e)) });
    }
  }, cap);
  window.addEventListener("pointermove", (e) => { if (e.pointerType === "pen") lastPenAt = now(); }, cap); // 호버 포함
  const up = (e) => {
    if (e.pointerType === "pen") { pensDown.delete(e.pointerId); lastPenAt = lastPenUpAt = now(); return; }
    if (e.pointerType !== "touch") return;
    const t = touches.get(e.pointerId);
    touches.delete(e.pointerId);
    if (t && t.palm) palmClick = { target: t.target, t: now() };
  };
  window.addEventListener("pointerup", up, cap);
  window.addEventListener("pointercancel", up, cap);

  // 손바닥이 떼어질 때 생기는 click(도구바·버튼) 버리기. 펜 탭·마우스 클릭은 그대로.
  const related = (a, b) => !!a && !!b && (a === b || (a.contains && a.contains(b)) || (b.contains && b.contains(a)));
  window.addEventListener("click", (e) => {
    const p = palmClick;
    if (!p) return;
    if (now() - p.t > CLICK_MS || lastPenUpAt > p.t) { palmClick = null; return; }
    if (e.pointerType === "pen" || e.pointerType === "mouse") return;
    if (!related(p.target, e.target)) return;
    palmClick = null;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // 필기 화면 안: 오른쪽 클릭 메뉴(길게 누르기·S펜 버튼)·끌어 놓기 막기, 필기 면에서는 글자 선택도 막기 (입력칸 제외)
  const SCREENS = ".stu, .live, .editor, .ink-wrap, .zoom-view, .ws-view, .ws-tab";
  const SURFACES = ".zoom-view, .ink-wrap, .ink-toolbar, .ws-view, .ws-tab";
  const elOf = (t) => (t && t.nodeType === 1 ? t : (t && t.parentElement) || null);
  const editable = (el) => !!el && (el.isContentEditable || !!el.closest("input, textarea, select"));
  const block = (sel, allowLinks) => (e) => {
    const el = elOf(e.target);
    if (!el || !el.closest || !el.closest(sel) || editable(el)) return;
    if (allowLinks && el.closest("a[href]")) return;
    if (e.cancelable) e.preventDefault();
  };
  window.addEventListener("contextmenu", block(SCREENS, true), true);
  window.addEventListener("dragstart", block(SCREENS, false), true);
  window.addEventListener("selectstart", block(SURFACES, false), true);
}
