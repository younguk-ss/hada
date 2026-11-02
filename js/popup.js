// 슬라이드 속 팝업 상호작용(v2.9) — 필기 슬라이드의 한 곳(핀)에 상호작용을 붙여 두면, 수업 중 교사가 그 핀을 누를 때
// 교사·학생 화면에 그 상호작용이 팝업으로 떠서 바로 진행된다(닫으면 슬라이드로 돌아옴).
// 데이터: ink slide.config.hotspots = [{ id:'pop_…', x, y, type, title, config }] — x,y = 16:10 프레임 비율(핀 가운데).
//   팝업 = 가상 슬라이드 { id: 핀 id, type, title, config } → 응답·활동 상태는 이 id로(responses[id], activity[id]) 저장되어
//   마감·정답 공개·기록·복습이 일반 슬라이드와 똑같이 동작한다.
// 세션: activity.__pop = { id, at } | null (__ws 와 같은 예약 키) — 교사가 열고 닫는다(patchSession → broadcast + DB).
//   학생 화면은 따라 열리고 닫힌다(닫기 버튼 없음). 교사가 다른 슬라이드로 넘어가면 닫힌다.
//   자유 이동(flow 'student')·복습에서는 학생이 핀을 눌러 자기 화면에서만 연다(닫기 가능).
// 가정: 핀은 프레임(확대된 실제 크기로 배치) 안 레이어에 둔다 → 확대·이동과 함께 움직이고 크기는 화면 px로 일정.
//       레이어는 z-index 2(필기 캔버스 1 위)라 펜 필기 중에도 핀을 누를 수 있다. 핀 밖은 pointer-events 없음(필기 그대로).
// 가정: 팝업에 넣을 수 있는 타입 = POP_TYPES(정답·의견 받는 상호작용과 미디어). 게임·동영상 퀴즈·필기는 제외.
import { el, icon, modal, toast } from "./ui.js";
import { patchSession } from "./cloud.js";
import { getSlideType, createSlide, newId, injectCss } from "./slides/registry.js";
import { mountSlideHost } from "./slides/host.js";

export const POP_KEY = "__pop";
export const POP_TYPES = ["mcq", "short", "poll", "blank", "wordcloud", "dragdrop", "wall", "link", "embed", "video"];

const CSS = `
/* 핀 레이어(프레임 안) */
.hs-layer { position:absolute; inset:0; z-index:2; pointer-events:none; }
.hs-pin { position:absolute; transform:translate(-50%,-50%); width:40px; height:40px; padding:0; border:2.5px solid #fff; border-radius:50%;
  background:var(--accent); color:#fff; display:grid; place-items:center; pointer-events:auto; cursor:pointer; touch-action:none;
  box-shadow:0 2px 10px rgba(30,27,75,.35); -webkit-user-select:none; user-select:none; }
.hs-pin svg { width:20px; height:20px; pointer-events:none; }
.hs-pin::after { content:""; position:absolute; inset:-7px; border-radius:50%; border:2px solid var(--accent); opacity:0; pointer-events:none; }
.hs-layer.is-open .hs-pin::after { animation:hsPulse 2.4s ease-out infinite; }
.hs-pin.active { background:var(--ink); }
.hs-pin.active::after { animation:none; }
.hs-pin .hs-lbl { position:absolute; top:calc(100% + 6px); left:50%; transform:translateX(-50%); padding:3px 8px; border-radius:999px; background:var(--ink);
  color:#fff; font:600 12px/1.2 var(--font, sans-serif); white-space:nowrap; opacity:0; pointer-events:none; transition:opacity .15s; }
.hs-layer.is-edit .hs-pin { cursor:grab; }
.hs-layer.is-edit .hs-pin.dragging { cursor:grabbing; box-shadow:0 8px 24px rgba(30,27,75,.45); }
.hs-layer.is-edit .hs-pin .hs-lbl, .hs-pin:focus-visible .hs-lbl { opacity:1; }
@media (hover:hover) { .hs-pin:hover .hs-lbl { opacity:1; } .hs-pin:hover { filter:brightness(1.08); } }
@keyframes hsPulse { 0% { opacity:.7; transform:scale(.85); } 70% { opacity:0; transform:scale(1.35); } 100% { opacity:0; } }
@media (prefers-reduced-motion:reduce) { .hs-layer.is-open .hs-pin::after { animation:none; } }
/* 갤러리(개별·모둠) 머리 줄의 팝업 버튼 */
.hs-chips { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
.hs-chip { display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 12px 0 8px; border:1px solid var(--accent); border-radius:999px;
  background:var(--accent-soft); color:var(--accent-ink); font:600 13px/1 var(--font, sans-serif); cursor:pointer; }
.hs-chip svg { width:16px; height:16px; }
.hs-chip.active { background:var(--ink); border-color:var(--ink); color:#fff; }
/* 편집기: 목록 */
.hs-list { display:grid; gap:6px; }
.hs-row { display:flex; align-items:center; gap:8px; min-height:40px; padding:4px 4px 4px 8px; border:1px solid var(--line); border-radius:10px; background:var(--surface); }
.hs-row .hs-ic { width:26px; height:26px; border-radius:50%; background:var(--accent); color:#fff; display:grid; place-items:center; flex:none; }
.hs-row .hs-ic svg { width:15px; height:15px; }
.hs-row .hs-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; }
.hs-hint { font-size:12px; color:var(--muted); line-height:1.5; }
.hs-types { display:grid; grid-template-columns:repeat(auto-fill, minmax(112px, 1fr)); gap:6px; }
.hs-type { display:flex; flex-direction:column; align-items:center; gap:6px; min-height:84px; padding:12px 6px 10px; border:1px solid var(--line); border-radius:12px;
  background:var(--surface); color:var(--ink); font:600 13px/1.25 var(--font, sans-serif); text-align:center; cursor:pointer; }
.hs-type .ic { color:var(--ink-2); line-height:0; }
.hs-type .ic svg { width:24px; height:24px; }
@media (hover:hover) { .hs-type:hover { border-color:var(--accent); background:var(--accent-soft); } }
.pop-editor { position:relative; min-height:240px; max-height:min(62vh, 560px); overflow:auto; margin:0 -4px; }
.pop-editor > .slide-host { height:auto; }
/* 팝업 보기(교사·학생) */
.pop-back { position:absolute; inset:0; z-index:45; display:grid; place-items:center; padding:clamp(8px, 2.4vw, 28px);
  background:rgba(24,22,30,.42); animation:fadeIn .16s ease; }
.pop-card { position:relative; width:min(1180px, 100%); height:min(100%, 880px); display:flex; flex-direction:column; min-height:0;
  background:var(--surface); border-radius:var(--radius-lg, 18px); box-shadow:var(--shadow-2); overflow:hidden; animation:rise .2s var(--ease, ease); }
.pop-head { display:flex; align-items:center; gap:10px; height:52px; padding:0 8px 0 16px; border-bottom:1px solid var(--line); flex:none; }
.pop-head .pop-ic { width:28px; height:28px; border-radius:50%; background:var(--accent); color:#fff; display:grid; place-items:center; flex:none; }
.pop-head .pop-ic svg { width:16px; height:16px; }
.pop-head .pop-title { flex:1; min-width:0; font-weight:700; font-size:15px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pop-head .pop-note { font-size:12px; color:var(--muted); white-space:nowrap; }
.pop-main { flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr); }
.pop-main.has-panel { grid-template-columns:minmax(0,1fr) 300px; }
.pop-main > .pop-stage { min-height:0; padding:0; }
.pop-panel { min-height:0; overflow:auto; padding:14px; border-left:1px solid var(--line); background:var(--surface); }
.pop-panel[hidden] { display:none; }
@media (max-width: 900px) {
  .pop-main.has-panel { grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(0,1fr) auto; }
  .pop-panel { border-left:0; border-top:1px solid var(--line); max-height:38%; }
}
.stu .pop-back { position:fixed; z-index:60; padding:max(8px, var(--sat0, 0px)) max(8px, var(--sar)) max(8px, var(--sab)) max(8px, var(--sal)); }
`;
function css() { injectCss("popup", CSS); }

// ── 데이터 ──
export function hotspotsOf(slide) {
  const list = slide && slide.config && Array.isArray(slide.config.hotspots) ? slide.config.hotspots : [];
  return list.filter(h => h && h.id && h.type);
}
// 핀 → 가상 슬라이드(같은 핀이면 같은 객체 — 호스트가 DOM을 보존하도록)
const psCache = new WeakMap();
export function popSlideFor(h, parent = null) {
  if (!h) return null;
  const c = psCache.get(h);
  if (c) return c;
  const ps = { id: h.id, type: h.type, title: h.title || getSlideType(h.type).label, config: h.config || {}, _parent: parent ? parent.id : null };
  psCache.set(h, ps);
  return ps;
}
export function popOf(session) {
  const p = session && session.activity && session.activity[POP_KEY];
  return p && p.id ? p : null;
}
// 세션 스냅샷에서 핀 찾기 → 가상 슬라이드 | null
export function findPopSlide(session, id) {
  if (!session || !id) return null;
  for (const sl of session.slidesSnapshot || []) {
    const h = hotspotsOf(sl).find(x => x.id === id);
    if (h) return popSlideFor(h, sl);
  }
  return null;
}
export function setPop(session, id) {
  if (!session) return Promise.resolve({ error: "세션이 없어요" });
  const act = session.activity || {};
  if (!id && !act[POP_KEY]) return Promise.resolve(null);
  return patchSession(session, { activity: { ...act, [POP_KEY]: id ? { id, at: Date.now() } : null } });
}
// 슬라이드 복제: 핀 id를 새로(같은 수업에서 응답이 섞이지 않게)
export function freshHotspotIds(slide) {
  const list = hotspotsOf(slide);
  if (!list.length) return slide;
  slide.config = { ...(slide.config || {}), hotspots: list.map(h => ({ ...h, id: newId("pop") })) };
  return slide;
}

function typeIcon(type) { return getSlideType(type).icon || ""; }
const DOT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/></svg>';

// ── 핀 레이어 ──
// mode: 'edit'(끌어 옮기기·눌러 고치기) | 'open'(눌러 팝업) | 'hidden'
// getSlide() → 지금 슬라이드(핀 목록), onOpen(h), onMove(h, x, y), onEdit(h), activeId() → 열린 팝업 id
export function hotspotLayer(frame, { getSlide, mode = "open", onOpen, onMove, onEdit, activeId } = {}) {
  css();
  const layer = el("div", { class: "hs-layer" });
  frame.appendChild(layer);
  let curMode = mode, sig = null;
  const pins = new Map(); // id → node

  function refresh() {
    const list = curMode === "hidden" ? [] : hotspotsOf(getSlide());
    layer.className = "hs-layer" + (curMode === "edit" ? " is-edit" : curMode === "open" ? " is-open" : "");
    layer.hidden = !list.length;
    const act = activeId ? activeId() : null;
    const next = JSON.stringify([curMode, act, list.map(h => [h.id, h.x, h.y, h.type, h.title])]);
    if (next === sig) return;
    sig = next;
    const keep = new Set();
    list.forEach((h, i) => {
      keep.add(h.id);
      let p = pins.get(h.id);
      if (!p) {
        p = el("button", { type: "button", class: "hs-pin" });
        bind(p, h.id);
        pins.set(h.id, p);
        layer.appendChild(p);
      }
      const def = getSlideType(h.type);
      const label = h.title && h.title !== def.label ? `${def.label} · ${h.title}` : def.label;
      const tip = curMode === "edit" ? `${label} — 끌어서 옮기기 · 눌러서 고치기` : `${label} — 눌러서 띄우기`;
      if (p.dataset.k !== `${h.type}|${label}`) {
        p.dataset.k = `${h.type}|${label}`;
        p.replaceChildren(el("span", { html: typeIcon(h.type) || DOT_ICON, style: { display: "contents" } }), el("span", { class: "hs-lbl" }, label));
      }
      p.title = tip;
      p.setAttribute("aria-label", tip);
      p.style.left = `${clamp01(h.x) * 100}%`;
      p.style.top = `${clamp01(h.y) * 100}%`;
      p.classList.toggle("active", act === h.id);
      p.dataset.n = String(i + 1);
    });
    for (const [id, p] of pins) if (!keep.has(id)) { p.remove(); pins.delete(id); }
  }

  function bind(p, id) {
    let d = null;
    p.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.stopPropagation(); // 필기·확대 이동으로 넘어가지 않게
      if (curMode !== "edit") return;
      e.preventDefault();
      const r = frame.getBoundingClientRect();
      d = { id: e.pointerId, sx: e.clientX, sy: e.clientY, r, moved: false };
      try { p.setPointerCapture(e.pointerId); } catch (_) {}
    });
    p.addEventListener("pointermove", (e) => {
      if (!d || d.id !== e.pointerId) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
      d.moved = true;
      p.classList.add("dragging");
      p.style.left = `${clamp01((e.clientX - d.r.left) / (d.r.width || 1)) * 100}%`;
      p.style.top = `${clamp01((e.clientY - d.r.top) / (d.r.height || 1)) * 100}%`;
    });
    const end = (e) => {
      if (!d || d.id !== e.pointerId) return;
      const was = d;
      d = null;
      p.classList.remove("dragging");
      try { p.releasePointerCapture(e.pointerId); } catch (_) {}
      const h = hotspotsOf(getSlide()).find(x => x.id === id);
      if (!h) return;
      if (was.moved && e.type === "pointerup") {
        const x = r4(clamp01((e.clientX - was.r.left) / (was.r.width || 1)));
        const y = r4(clamp01((e.clientY - was.r.top) / (was.r.height || 1)));
        sig = null;
        onMove?.(h, x, y);
      } else if (was.moved) { sig = null; refresh(); }
      p.dataset.dragged = was.moved ? "1" : "";
    };
    p.addEventListener("pointerup", end);
    p.addEventListener("pointercancel", end);
    p.addEventListener("click", (e) => {
      e.stopPropagation(); // 텍스트 도구의 '빈 곳 누르기'로 가지 않게
      if (p.dataset.dragged === "1") { p.dataset.dragged = ""; return; }
      const h = hotspotsOf(getSlide()).find(x => x.id === id);
      if (!h) return;
      if (curMode === "edit") onEdit?.(h);
      else if (curMode === "open") onOpen?.(h);
    });
  }

  refresh();
  return {
    el: layer,
    refresh() { refresh(); },
    setMode(m) { if (m !== curMode) { curMode = m; sig = null; refresh(); } },
    destroy() { layer.remove(); pins.clear(); },
  };
}

// 갤러리(개별·모둠 모드) 머리 줄용 팝업 버튼들. set() 으로 갱신
export function hotspotChips({ getSlide, onOpen, activeId } = {}) {
  css();
  const root = el("div", { class: "hs-chips" });
  let sig = null;
  root.set = () => {
    const list = hotspotsOf(getSlide());
    const act = activeId ? activeId() : null;
    const next = JSON.stringify([act, list.map(h => [h.id, h.type, h.title])]);
    if (next === sig) return;
    sig = next;
    root.hidden = !list.length;
    root.replaceChildren(...list.map(h => {
      const def = getSlideType(h.type);
      return el("button", {
        type: "button", class: "hs-chip" + (act === h.id ? " active" : ""), title: `${def.label} 띄우기`,
        onClick: () => onOpen?.(h),
      }, [el("span", { html: typeIcon(h.type) || DOT_ICON, style: { display: "contents" } }), h.title && h.title !== def.label ? h.title : def.label]);
    }));
  };
  root.set();
  return root;
}

// ── 편집기: 핀 넣기·고치기 ──
// hotspot 이 없으면 종류 고르기 → 그 타입 편집기. onSave(h), onDelete()
export function openHotspotEditor({ lesson = null, hotspot = null, at = null, onSave, onDelete } = {}) {
  css();
  if (hotspot) { openTypeEditor({ lesson, hotspot, onSave, onDelete }); return; }
  const grid = el("div", { class: "hs-types" }, POP_TYPES.map(t => getSlideType(t)).filter((d, i) => d && d.type === POP_TYPES[i]).map(d =>
    el("button", { type: "button", class: "hs-type", title: d.desc || d.label, onClick: () => openTypeEditor({ lesson, type: d.type, at, onSave }) },
      [el("span", { class: "ic", html: d.icon || "" }), d.label])));
  modal({
    title: "팝업 상호작용 넣기",
    body: el("div", { style: { display: "grid", gap: "12px" } }, [
      el("div", { class: "hs-hint" }, "수업 중 슬라이드의 핀을 누르면 교사·학생 화면에 함께 떠요."),
      grid,
    ]),
    wide: true,
    actions: [{ label: "취소" }],
  });
}
function openTypeEditor({ lesson, hotspot = null, type = null, at = null, onSave, onDelete }) {
  const t = hotspot ? hotspot.type : type;
  const def = getSlideType(t);
  let draft;
  try {
    draft = hotspot
      ? { id: hotspot.id, type: t, title: hotspot.title || def.label, config: JSON.parse(JSON.stringify(hotspot.config || {})) }
      : createSlide(t, { id: newId("pop") });
  } catch (e) { console.warn("[popup] 만들기 실패", e); toast("상호작용을 만들지 못했어요", { type: "error" }); return; }
  const box = el("div", { class: "pop-editor" });
  let ed = null;
  const save = (close) => {
    if (box.querySelector(".qi-busy")) { toast("그림을 올리는 중이에요. 잠시 뒤 다시 눌러 주세요"); return; }
    const msg = typeof def.validate === "function" ? def.validate(draft) : null;
    if (msg) { toast(msg); return; }
    const pos = hotspot ? { x: hotspot.x, y: hotspot.y } : (at || { x: 0.5, y: 0.5 });
    onSave?.({ id: draft.id, x: pos.x, y: pos.y, type: t, title: draft.title || def.label, config: draft.config || {} });
    close();
  };
  modal({
    title: `${def.label} · 팝업 상호작용`, body: box, wide: true,
    actions: [
      hotspot && onDelete ? { label: "빼기", danger: true, onClick: (close) => { onDelete(); close(); } } : null,
      { label: "취소" },
      { label: hotspot ? "저장" : "넣기", primary: true, onClick: save },
    ].filter(Boolean),
    onClose: () => { try { ed && ed.destroy(); } catch (_) {} },
  });
  try { ed = mountSlideHost({ role: "editor", root: box, slide: draft, lesson, onEditorUpdate: () => {} }); }
  catch (e) { console.warn("[popup] 편집기 표시 실패", e); box.replaceChildren(el("div", { class: "empty" }, "편집기를 불러오지 못했어요")); }
}

// 편집기 인스펙터: 핀 목록 + [+ 팝업 넣기]
export function hotspotInspector({ getSlide, onAdd, onEdit, onDelete } = {}) {
  css();
  const list = el("div", { class: "hs-list" });
  const addBtn = el("button", { type: "button", class: "btn btn-sm", onClick: () => onAdd?.() }, [icon("plus", 16), "팝업 상호작용 넣기"]);
  const hint = el("div", { class: "hs-hint" });
  const root = el("div", { class: "field" }, [el("label", {}, "팝업 상호작용"), list, el("div", {}, [addBtn]), hint]);
  root.refresh = () => {
    const hs = hotspotsOf(getSlide());
    list.hidden = !hs.length;
    hint.textContent = hs.length ? "슬라이드 위 핀을 끌어 위치를 정하고, 누르면 고칠 수 있어요." : "수업 중 슬라이드의 핀을 누르면 교사·학생 화면에 함께 떠요.";
    list.replaceChildren(...hs.map(h => {
      const def = getSlideType(h.type);
      return el("div", { class: "hs-row" }, [
        el("span", { class: "hs-ic", html: def.icon || DOT_ICON }),
        el("span", { class: "hs-name", title: h.title || def.label }, h.title && h.title !== def.label ? `${def.label} · ${h.title}` : def.label),
        el("button", { type: "button", class: "btn btn-sm btn-ghost", onClick: () => onEdit?.(h) }, "고치기"),
        el("button", { type: "button", class: "btn btn-icon btn-ghost btn-sm", "aria-label": "빼기", title: "빼기", onClick: () => onDelete?.(h) }, icon("x", 16)),
      ]);
    }));
  };
  root.refresh();
  return root;
}

// ── 팝업 보기(교사·학생) ──
// container 안에 겹쳐 띄운다. show(session, popSlide, { closable, note }) · update(session) · close()
// role 'teacher' 면 플러그인 panel(마감·정답 공개·타이머 등)을 오른쪽(좁으면 아래)에 붙인다.
export function createPopupView({ container, role = "student", me = null, sessionView = null, onClose = null } = {}) {
  css();
  let cur = null; // { id, host, back, panelBox, main }
  function close() {
    if (!cur) return;
    const c = cur;
    cur = null;
    try { c.host && c.host.destroy(); } catch (e) { console.warn("[popup] destroy", e); }
    c.back.remove();
  }
  function syncPanel() {
    if (!cur || role === "student") return;
    const p = cur.host ? cur.host.panel : null;
    if (p instanceof Node) { if (cur.panelBox.firstChild !== p) cur.panelBox.replaceChildren(p); }
    else if (cur.panelBox.firstChild) cur.panelBox.replaceChildren();
    const has = !!cur.panelBox.firstChild;
    cur.panelBox.hidden = !has;
    cur.main.classList.toggle("has-panel", has);
  }
  function show(session, ps, { closable = true, note = "" } = {}) {
    if (!ps) { close(); return; }
    if (cur && cur.id === ps.id) {
      cur.closeBtn.hidden = !closable;
      if (cur.noteEl.textContent !== note) cur.noteEl.textContent = note;
      try { cur.host && cur.host.update({ slide: ps, session }); } catch (e) { console.warn("[popup] update", e); }
      syncPanel();
      return;
    }
    close();
    const def = getSlideType(ps.type);
    const stage = el("section", { class: "stage pop-stage" });
    const panelBox = el("aside", { class: "pop-panel", hidden: true });
    const main = el("div", { class: "pop-main" }, [stage, panelBox]);
    const noteEl = el("span", { class: "pop-note" }, note);
    const closeBtn = el("button", { class: "btn btn-icon btn-ghost", type: "button", "aria-label": "닫기", title: "닫기", hidden: !closable, onClick: () => onClose?.() }, icon("x"));
    const card = el("div", { class: "pop-card", role: "dialog", "aria-modal": "true", "aria-label": ps.title || def.label }, [
      el("div", { class: "pop-head" }, [
        el("span", { class: "pop-ic", html: def.icon || DOT_ICON }),
        el("span", { class: "pop-title" }, ps.title && ps.title !== def.label ? `${def.label} · ${ps.title}` : def.label),
        noteEl, closeBtn,
      ]),
      main,
    ]);
    const back = el("div", { class: "pop-back" }, [card]);
    container.appendChild(back);
    cur = { id: ps.id, host: null, back, panelBox, main, closeBtn, noteEl };
    try { cur.host = mountSlideHost({ role, root: stage, slide: ps, session, me, sessionView }); }
    catch (e) { console.error("[popup] 표시 실패", e); stage.replaceChildren(el("div", { class: "empty" }, "상호작용을 불러오지 못했어요")); }
    syncPanel();
  }
  return {
    show, close,
    update(session) { if (cur && cur.host) { try { cur.host.update({ session }); } catch (e) { console.warn(e); } syncPanel(); } },
    get id() { return cur ? cur.id : null; },
  };
}

function clamp01(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5; }
function r4(v) { return Math.round(v * 10000) / 10000; }
