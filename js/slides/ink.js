// 필기(ink) 슬라이드 타입 — docs/ARCHITECTURE.md §6.4 "ink"
// 모드: none(발표·학생 읽기 전용, 교사 필기는 whole) / whole / individual / group
// 가정: cloud·storage·ui·realtime·store는 네임스페이스 import(다른 에이전트 파일의 export가 늦게 생겨도 링크가 깨지지 않게).
// 가정: ctx.modal(opts)는 ui.modal({ title, body, actions:[{label, primary, danger, onClick(close)}], wide, onClose })이고
//       { close } 를 반환한다. 닫힘은 onClose 외에 body가 DOM에서 빠지는 것으로도 감지한다.
// 가정: 프레임 크기는 스테이지 크기에 맞춰 JS로 contain(16:10) 맞춤(ResizeObserver).
// 가정: 도구 상태(도구·색·굵기)는 모듈 단위로 기억(슬라이드를 넘겨도 유지).
// 가정: 갤러리 온라인 점은 realtime.currentChannel().onPresence로 갱신(없으면 onSession 때만).
import * as ui from "../ui.js";
import * as cloud from "../cloud.js";
import * as storage from "../storage.js";
import * as realtime from "../realtime.js";
import * as storeMod from "../store.js";
import { registerSlideType, effectiveMode, groupStudents, newId, injectCss } from "./registry.js";
import { renderSlide } from "../lesson-view.js";
import { paintStrokes } from "../canvas.js";

const { el } = ui;

const COLORS = ["#1c1c22", "#2563eb", "#dc2626", "#16a34a", "#f59e0b", "#7c3aed"];
const SIZES = [{ id: "S", v: 2 }, { id: "M", v: 3.5 }, { id: "L", v: 6 }];
const TOOLS = [
  { id: "pen", label: "펜" },
  { id: "highlight", label: "형광펜" },
  { id: "eraser", label: "지우개" },
  { id: "text", label: "텍스트" },
];
const MODES = [["none", "발표"], ["whole", "전체"], ["individual", "개별"], ["group", "모둠"]];

// 24px stroke SVG (ui.icon 없을 때 대체)
const SVG = {
  pen: '<path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/><path d="M14 6l3 3"/>',
  highlight: '<path d="M9 15l-4 4h6l1-1"/><path d="M9 15l7-11 4 3-7 11z"/><path d="M8 14l5 3"/>',
  eraser: '<path d="M7 20h12"/><path d="M5 15l9-9 5 5-8 8H8z"/><path d="M10 10l5 5"/>',
  text: '<path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0"/><path d="M16 4.5a3.5 3.5 0 010 7"/><path d="M18 14a6 6 0 013.5 6"/>',
};
const PEN_ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${SVG.pen}</svg>`;

function icon(name) {
  if (typeof ui.icon === "function") {
    try { const n = ui.icon(name); if (n) return n; } catch (_) {}
  }
  return el("span", { class: "ink-ic", html: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${SVG[name] || ""}</svg>` });
}

const CSS = `
.slide-host[data-type="ink"] { height:100%; min-height:0; display:flex; flex-direction:column; }
.ink-wrap { position:relative; display:flex; flex-direction:column; gap:10px; width:100%; height:100%; min-height:0; flex:1; }
.ink-stage { position:relative; flex:1; min-height:0; min-width:0; display:flex; align-items:center; justify-content:center; }
.ink-wrap .ink-stage > .slide-frame { flex:none; max-width:100%; margin:0 auto; }
.ink-wrap.has-float .ink-stage { padding-bottom:76px; }
.ink-toolbar { display:flex; align-items:center; gap:4px; padding:6px 8px; background:var(--surface); border:1px solid var(--line);
  border-radius:var(--radius); box-shadow:var(--shadow-1); flex-wrap:wrap; align-self:center; max-width:100%; }
.ink-toolbar .ink-grp { display:flex; align-items:center; gap:2px; }
.ink-toolbar .ink-sep { width:1px; height:22px; background:var(--line); margin:0 4px; flex:none; }
.ink-tool, .ink-size { width:36px; height:36px; border:0; border-radius:var(--radius-sm); background:transparent; color:var(--ink-2);
  display:grid; place-items:center; cursor:pointer; flex:none; padding:0; }
.ink-tool:hover, .ink-size:hover { background:var(--surface-2); }
.ink-tool.active, .ink-size.active { background:var(--ink); color:#fff; }
.ink-tool svg { width:20px; height:20px; }
.ink-ic { display:inline-grid; place-items:center; }
.ink-swatch { width:36px; height:36px; border:0; background:transparent; display:grid; place-items:center; cursor:pointer; padding:0; flex:none; }
.ink-swatch i { width:20px; height:20px; border-radius:50%; background:var(--c); box-shadow:inset 0 0 0 1px rgba(0,0,0,.12); }
.ink-swatch.active i { box-shadow:0 0 0 2px var(--surface), 0 0 0 4px var(--c); }
.ink-size i { display:block; border-radius:50%; background:currentColor; }
.ink-toolbar .btn { margin-left:4px; }
.ink-float { position:absolute; left:50%; bottom:calc(8px + env(safe-area-inset-bottom)); transform:translateX(-50%); z-index:5;
  flex-wrap:nowrap; overflow-x:auto; max-width:calc(100% - 16px); scrollbar-width:none; box-shadow:var(--shadow-2); }
.ink-float::-webkit-scrollbar { display:none; }
.ink-float .ink-tool, .ink-float .ink-size, .ink-float .ink-swatch { width:44px; height:44px; }
@media (max-width:520px) { .ink-float { overflow-x:auto; max-width:calc(100vw - 16px); }
  .ink-float .ink-tool, .ink-float .ink-size, .ink-float .ink-swatch { width:44px; height:44px; min-width:44px; min-height:44px; } }
.ink-wait { flex:1; display:grid; place-items:center; }
.ink-gallery { flex:1; min-height:0; overflow:auto; padding:2px; display:flex; flex-direction:column; gap:12px; }
.ink-tiles { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:12px; }
.ink-tile { display:flex; flex-direction:column; gap:6px; padding:6px; border:1px solid var(--line); border-radius:var(--radius-sm);
  background:var(--surface); cursor:pointer; text-align:left; font:inherit; color:inherit; }
.ink-tile:hover { border-color:var(--line-strong); box-shadow:var(--shadow-1); }
.ink-tile.static { cursor:default; }
.ink-mini { position:relative; aspect-ratio:16/10; background:#fff; border-radius:6px; overflow:hidden; box-shadow:inset 0 0 0 1px var(--line); }
.ink-mini img, .ink-mini canvas { position:absolute; inset:0; width:100%; height:100%; }
.ink-mini img { object-fit:contain; pointer-events:none; }
.ink-tile-name { display:flex; align-items:center; gap:6px; font-size:13px; color:var(--ink-2); min-width:0; padding:0 2px; }
.ink-tile-name span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ink-tile-name .dot { flex:none; width:8px; height:8px; border-radius:50%; background:var(--line-strong); }
.ink-tile-name .dot.on { background:var(--ok); }
.ink-tile-name .ink-cnt { margin-left:auto; color:var(--muted); font-variant-numeric:tabular-nums; }
.ink-zoom { display:flex; flex-direction:column; gap:10px; height:min(72dvh, 640px); min-height:280px; }
.ink-panel { display:flex; flex-direction:column; gap:14px; }
.ink-panel .ink-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.ink-panel .ink-note { font-size:13px; color:var(--muted); }
.ink-insp-bg { position:relative; aspect-ratio:16/10; border:1px solid var(--line); border-radius:var(--radius-sm); background:#fff; overflow:hidden;
  display:grid; place-items:center; color:var(--muted); font-size:13px; }
.ink-insp-bg img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; }
.ink-insp-row { display:flex; gap:6px; margin-top:8px; }
.ink-thumb { position:relative; width:100%; height:100%; aspect-ratio:16/10; background:#fff; overflow:hidden; }
.ink-thumb.is-paper { background:#fff linear-gradient(transparent 23px, var(--line) 24px) 0 6px / 100% 24px; }
.ink-thumb img, .ink-thumb canvas { position:absolute; inset:0; width:100%; height:100%; }
.ink-thumb img { object-fit:contain; }
.ink-summary { display:flex; flex-direction:column; gap:12px; }
.ink-summary .ink-mini.big { max-width:640px; width:100%; }
.ink-sum-head { font-size:13px; color:var(--muted); }
.ink-gb { display:flex; flex-direction:column; gap:12px; }
.ink-gb-top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.ink-gb-groups { display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:10px; }
.ink-gb-box { border:1px solid var(--line); border-radius:var(--radius-sm); padding:8px; min-height:72px; background:var(--surface); cursor:pointer;
  display:flex; flex-direction:column; gap:6px; }
.ink-gb-box.is-pool { background:var(--surface-2); }
.ink-gb-box.can-drop { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
.ink-gb-title { font-size:12px; color:var(--muted); display:flex; justify-content:space-between; }
.ink-gb-chips { display:flex; flex-wrap:wrap; gap:6px; }
.ink-chip { height:32px; padding:0 10px; border:1px solid var(--line); border-radius:999px; background:var(--surface); font:inherit; font-size:13px;
  color:var(--ink); cursor:pointer; display:inline-flex; align-items:center; gap:6px; }
.ink-chip.sel { background:var(--accent); border-color:var(--accent); color:#fff; }
.ink-chip .dot { width:6px; height:6px; border-radius:50%; background:var(--line-strong); }
.ink-chip .dot.on { background:var(--ok); }
`;

// 모듈 단위 도구 상태
const toolState = { tool: "pen", color: COLORS[0], size: "M" };
const sizeVal = (id) => (SIZES.find(s => s.id === id) || SIZES[1]).v;

const hasInk = (rec) => !!rec && (((rec.strokes || []).length) || ((rec.texts || []).length));
const seg = (items, cur, onPick, cls = "") => el("div", { class: "seg " + cls },
  items.map(([id, label]) => el("button", { type: "button", class: id === cur ? "active" : "", "data-id": id, onClick: () => onPick(id) }, label)));
function segSet(segEl, cur) { segEl.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.id === String(cur))); }

function studentName(id, ctx) {
  const s = ctx?.students?.()?.get?.(id)
    || (typeof storeMod.findStudent === "function" ? storeMod.findStudent(id) : null)
    || storeMod.store?.state?.students?.find?.(x => x.id === id);
  if (!s) return "학생";
  return s.num != null && s.num !== "" ? `${s.num}. ${s.name}` : s.name;
}
function studentSort(ctx) {
  const map = ctx?.students?.() || new Map();
  return (a, b) => {
    const x = map.get(a) || {}, y = map.get(b) || {};
    return (+x.grade || 0) - (+y.grade || 0) || (+x.classNum || 0) - (+y.classNum || 0) || (+x.num || 0) - (+y.num || 0)
      || String(x.name || "").localeCompare(String(y.name || ""), "ko");
  };
}

// 스테이지에 16:10 프레임을 contain으로 맞춤
function fitFrame(stage) {
  let raf = 0;
  const fit = () => {
    raf = 0;
    const f = stage.querySelector(":scope > .slide-frame");
    if (!f) return;
    const cs = getComputedStyle(stage);
    const w = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    // 높이가 정해지지 않은 컨테이너면 폭 기준
    const width = h > 80 ? Math.min(w, h * 1.6) : w;
    f.style.width = Math.max(0, Math.floor(width)) + "px";
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(fit); };
  const ro = new ResizeObserver(schedule);
  ro.observe(stage);
  schedule();
  return { fit: schedule, destroy() { ro.disconnect(); if (raf) cancelAnimationFrame(raf); } };
}

// 도구바: 펜·형광·지우개·텍스트 | 색 6 | S/M/L | 되돌리기 (+ extras)
function makeToolbar(getViewer, { float = false, extras = [] } = {}) {
  const st = toolState;
  const apply = () => {
    const v = getViewer();
    if (!v) return;
    v.setTool(st.tool); v.setColor(st.color); v.setSize(sizeVal(st.size));
  };
  const toolBtns = TOOLS.map(t => el("button", {
    type: "button", class: "ink-tool", title: t.label, "aria-label": t.label, "data-id": t.id,
    onClick: () => { st.tool = t.id; sync(); apply(); },
  }, [icon(t.id)]));
  const colorBtns = COLORS.map(c => el("button", {
    type: "button", class: "ink-swatch", "aria-label": "색", "data-id": c, style: { "--c": c },
    onClick: () => { st.color = c; if (st.tool === "eraser") st.tool = "pen"; sync(); apply(); },
  }, [el("i", {})]));
  const sizeBtns = SIZES.map((s, i) => el("button", {
    type: "button", class: "ink-size", title: s.id, "aria-label": "굵기 " + s.id, "data-id": s.id,
    onClick: () => { st.size = s.id; sync(); apply(); },
  }, [el("i", { style: { width: (5 + i * 4) + "px", height: (5 + i * 4) + "px" } })]));
  const undoBtn = el("button", { type: "button", class: "ink-tool", title: "되돌리기", "aria-label": "되돌리기", onClick: () => getViewer()?.undo() }, [icon("undo")]);
  // 색 칸에 style 객체의 커스텀 속성 반영(el()은 Object.assign이라 --c가 안 들어감)
  colorBtns.forEach(b => b.style.setProperty("--c", b.dataset.id));

  const bar = el("div", { class: "ink-toolbar" + (float ? " ink-float" : "") }, [
    el("div", { class: "ink-grp" }, toolBtns),
    el("span", { class: "ink-sep" }),
    el("div", { class: "ink-grp" }, colorBtns),
    el("span", { class: "ink-sep" }),
    el("div", { class: "ink-grp" }, sizeBtns),
    el("span", { class: "ink-sep" }),
    undoBtn,
    ...extras,
  ]);
  function sync() {
    toolBtns.forEach(b => b.classList.toggle("active", b.dataset.id === st.tool));
    colorBtns.forEach(b => b.classList.toggle("active", b.dataset.id === st.color));
    sizeBtns.forEach(b => b.classList.toggle("active", b.dataset.id === st.size));
  }
  sync();
  bar.sync = sync;
  bar.apply = apply;
  return bar;
}

// 모달 열기 + 닫힘 감지
function openModal(ctx, { title, body, actions = [], onClose }) {
  let closed = false, handle = null;
  const done = () => {
    if (closed) return;
    closed = true;
    try { ro.disconnect(); mo.disconnect(); } catch (_) {}
    try { onClose && onClose(); } catch (e) { console.warn("[ink] modal onClose", e); }
  };
  const close = () => {
    if (typeof handle?.close === "function") handle.close();
    else if (typeof handle === "function") handle();
    else body.closest(".modal-back")?.remove();
    done();
  };
  const acts = actions.map(a => ({ ...a, onClick: () => a.onClick(close) }));
  handle = ctx.modal ? ctx.modal({ title, body, actions: acts, wide: true, onClose: done }) : null;
  if (!handle && !body.isConnected) {
    // 대체: 아주 단순한 오버레이
    const back = el("div", { class: "modal-back" }, [el("div", { class: "modal modal-wide" }, [
      el("h3", {}, title || ""), body,
      el("div", { class: "row-actions" }, acts.map(a => el("button", { type: "button", class: "btn" + (a.primary ? " btn-primary" : ""), onClick: a.onClick }, a.label))),
    ])]);
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    document.body.appendChild(back);
    handle = { close: () => back.remove() };
  }
  const check = () => { if (!body.isConnected) done(); };
  const ro = new ResizeObserver(check);
  ro.observe(body);
  const mo = new MutationObserver(check);
  mo.observe(document.body, { childList: true });
  return { close, isOpen: () => !closed };
}

// 미니 프레임(배경 + 필기). 반환 el에 .paint(rec) 메서드
function miniFrame(slide, { big = false } = {}) {
  injectCss("ink", CSS);
  const box = el("div", { class: "ink-mini" + (big ? " big" : "") });
  if (slide.bg) box.appendChild(el("img", { src: slide.bg, alt: "", loading: "lazy", decoding: "async" }));
  const cv = el("canvas", { width: big ? 960 : 480, height: big ? 600 : 300 });
  box.appendChild(cv);
  const baseS = Array.isArray(slide.strokes) ? slide.strokes : [];
  const baseT = Array.isArray(slide.texts) ? slide.texts : [];
  let sig = null;
  box.paint = (rec) => {
    const r = rec || {};
    const st = r.strokes || [];
    // cloud.js가 레코드 변경마다 올리는 _v(비열거) + 개수·마지막 id (개별 원격 교체 시 개수가 같아도 감지)
    const s = `${r._v || 0}|${st.length}|${st[st.length - 1]?.id || ""}|${(r.removed || []).length}|${(r.texts || []).length}|${(r.texts || []).reduce((n, t) => n + String(t?.value || "").length, 0)}`;
    if (s === sig) return false;
    sig = s;
    paintStrokes(cv, baseS.concat(r.strokes || []), { removed: r.removed || [], texts: baseT.concat(r.texts || []) });
    return true;
  };
  return box;
}

// ── 편집기 ──
function Editor({ slide, lesson, update, ctx }) {
  ctx?.injectCss ? ctx.injectCss("ink", CSS) : injectCss("ink", CSS);
  const wrap = el("div", { class: "ink-wrap ink-editor" });
  const stage = el("div", { class: "ink-stage" });
  const viewer = renderSlide({
    root: stage, slide, session: null, scope: "edit", readOnly: false,
    authorId: ctx?.me?.id || lesson?.teacherId || null,
    onChange: () => update({ strokes: slide.strokes, texts: slide.texts }),
  });
  const clearBtn = el("button", {
    type: "button", class: "btn btn-sm btn-ghost",
    onClick: async () => {
      if (!(slide.strokes || []).length && !(slide.texts || []).length) return;
      const ok = await ctx.confirm("이 슬라이드의 필기를 지울까요?", { ok: "지우기", danger: true });
      if (ok) viewer.clearAll();
    },
  }, "전체 지우기");
  const bar = makeToolbar(() => viewer, { extras: [clearBtn] });
  wrap.append(bar, stage);
  bar.apply();
  const fit = fitFrame(stage);

  // 인스펙터: 배경 이미지 · 기본 모드
  const bgBox = el("div", { class: "ink-insp-bg" });
  const fileIn = el("input", { type: "file", accept: "image/*,application/pdf", style: { display: "none" } });
  const btnReplace = el("button", { type: "button", class: "btn btn-sm", onClick: () => fileIn.click() }, "교체");
  const btnRemove = el("button", { type: "button", class: "btn btn-sm btn-ghost", onClick: removeBg }, "제거");
  const modeSeg = seg(MODES, slide.mode || "whole", (m) => { update({ mode: m }); segSet(modeSeg, m); });
  const inspector = el("div", { class: "ink-inspector" }, [
    el("div", { class: "field" }, [el("label", {}, "배경 이미지"), bgBox, el("div", { class: "ink-insp-row" }, [btnReplace, btnRemove]), fileIn]),
    el("div", { class: "field" }, [el("label", {}, "기본 모드"), modeSeg]),
  ]);
  let busy = false;
  function syncInspector() {
    bgBox.replaceChildren();
    const src = slide.thumb || slide.bg;
    if (src) bgBox.appendChild(el("img", { src, alt: "", decoding: "async" }));
    else bgBox.appendChild(el("span", {}, "없음"));
    btnRemove.disabled = busy || !slide.bg;
    btnReplace.disabled = busy;
    btnReplace.textContent = busy ? "올리는 중…" : (slide.bg ? "교체" : "추가");
  }
  // 방금 올렸지만 쓰지 않는 이미지(PDF 2쪽 이후)만 지운다. removeSlideImage가 썸네일까지 함께 지움.
  // 가정: 배경 교체·제거 시 옛 이미지는 지우지 않는다(진행 중/지난 수업 스냅샷이 같은 URL을 참조, teacher.js 슬라이드 삭제 정책과 동일).
  //       정리는 자료 삭제 시 cloudDeleteLesson의 폴더 삭제(removeLessonImages)에 맡긴다.
  function removeQuiet(path) {
    if (!path || typeof storage.removeSlideImage !== "function") return;
    try { const r = storage.removeSlideImage(path); r && r.catch && r.catch(() => {}); } catch (_) {}
  }
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = "";
    if (!f || busy) return;
    busy = true; syncInspector();
    try {
      let res;
      const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name || "");
      if (isPdf) {
        // PDF는 첫 페이지만 사용
        const slides = await storage.fileToSlides(f, lesson?.id, () => {});
        const first = slides && slides[0];
        if (!first || !first.bg) throw new Error("빈 PDF");
        res = { url: first.bg, path: first.bgPath || null, thumb: first.thumb || first.bg };
        (slides || []).slice(1).forEach(s => removeQuiet(s.bgPath));
      } else {
        res = await storage.uploadSlideImage(lesson?.id, slide.id, f);
      }
      if (!res || !res.url) throw new Error("업로드 실패");
      update({ bg: res.url, bgPath: res.path || null, thumb: res.thumb || res.url }); // 옛 이미지는 보존(스냅샷 참조)
      viewer.refresh();
    } catch (e) {
      console.warn("[ink] 배경 업로드 실패", e);
      ctx.toast("이미지를 올리지 못했어요");
    } finally {
      busy = false; syncInspector();
    }
  });
  function removeBg() {
    if (!slide.bg || busy) return;
    update({ bg: null, bgPath: null, thumb: null }); // 옛 이미지는 보존(스냅샷 참조)
    viewer.refresh();
    syncInspector();
  }
  syncInspector();

  return {
    el: wrap,
    inspector,
    destroy() { fit.destroy(); viewer.destroy(); },
  };
}

// ── 학생 ──
function Student({ slide, session, me, ctx }) {
  ctx.injectCss("ink", CSS);
  const wrap = el("div", { class: "ink-wrap ink-stu" });
  let viewer = null, bar = null, fit = null, key = null;

  function scopeFor() {
    const ss = ctx.session() || session;
    const mode = effectiveMode(slide, ss);
    if (mode === "individual") return { scope: "individual", scopeId: me?.id, readOnly: !me };
    if (mode === "group") {
      const g = ctx.myGroup();
      return g ? { scope: "group", scopeId: g.id, readOnly: false } : { scope: null };
    }
    if (mode === "whole") return { scope: "whole", scopeId: ss?.id, readOnly: false };
    return { scope: "whole", scopeId: ss?.id, readOnly: true }; // 발표
  }
  function teardown() {
    fit?.destroy(); fit = null;
    viewer?.destroy(); viewer = null;
    bar?.remove(); bar = null;
  }
  function mount(s) {
    teardown();
    wrap.classList.remove("has-float");
    if (!s.scope) {
      wrap.replaceChildren(el("div", { class: "ink-wait" }, [el("div", { class: "empty" }, "모둠을 기다리고 있어요")]));
      return;
    }
    const stage = el("div", { class: "ink-stage" });
    wrap.replaceChildren(stage);
    viewer = renderSlide({
      root: stage, slide, session: ctx.session() || session,
      scope: s.scope, scopeId: s.scopeId, readOnly: s.readOnly, authorId: me?.id || null,
    });
    if (!s.readOnly) {
      bar = makeToolbar(() => viewer, { float: true });
      wrap.appendChild(bar);
      wrap.classList.add("has-float");
      bar.apply();
    }
    fit = fitFrame(stage);
  }
  function check() {
    const s = scopeFor();
    const k = `${s.scope}|${s.scopeId}|${!!s.readOnly}`;
    if (k !== key) { key = k; mount(s); }
    else viewer?.refresh();
  }
  check();

  return {
    el: wrap,
    onActivity: check,
    onSession: check,
    destroy() { teardown(); },
  };
}

// ── 교사 진행 ──
function TeacherLive({ slide, session, ctx }) {
  ctx.injectCss("ink", CSS);
  const wrap = el("div", { class: "ink-wrap ink-live" });
  const me = ctx.me || null;
  let bodyKey = null;
  let viewer = null, bar = null, fit = null;   // whole 캔버스
  let gal = null;                              // 갤러리
  let zoom = null;                             // 확대 모달 { viewer, fit, modal, kind, id }
  let presCh = null, presOff = null;
  let gbModal = null;

  const curMode = () => effectiveMode(slide, ctx.session() || session);

  function teardownBody() {
    fit?.destroy(); fit = null;
    viewer?.destroy(); viewer = null;
    bar = null;
    gal?.destroy(); gal = null;
  }

  function mountBody() {
    teardownBody();
    const m = curMode();
    bodyKey = (m === "individual" || m === "group") ? m : "whole";
    if (bodyKey === "whole") {
      const stage = el("div", { class: "ink-stage" });
      const ss = ctx.session() || session;
      viewer = renderSlide({ root: stage, slide, session: ss, scope: "whole", scopeId: ss?.id, readOnly: false, authorId: me?.id || null });
      const clearBtn = el("button", {
        type: "button", class: "btn btn-sm btn-ghost",
        onClick: async () => {
          const ok = await ctx.confirm("전체 필기를 지울까요?", { ok: "지우기", danger: true });
          if (ok) viewer?.clearAll();
        },
      }, "전체 지우기");
      bar = makeToolbar(() => viewer, { extras: [clearBtn] });
      wrap.replaceChildren(bar, stage);
      bar.apply();
      fit = fitFrame(stage);
    } else {
      gal = makeGallery(bodyKey);
      wrap.replaceChildren(gal.el);
    }
  }

  // 학생/모둠 갤러리
  function makeGallery(kind) {
    const root = el("div", { class: "ink-gallery" });
    const grid = el("div", { class: "ink-tiles" });
    const emptyBox = el("div", { class: "ink-stage" });
    let emptyViewer = null, emptyFit = null;
    const tiles = new Map(); // id → { node, mini, dot, name, cnt }

    function items() {
      const ss = ctx.session() || session;
      if (kind === "group") {
        return (ctx.groups() || []).map(g => ({
          id: g.id, name: g.name || "모둠", members: g.memberIds || [],
          rec: ss?.records?.__groups?.[g.id]?.[slide.id] || null,
        }));
      }
      return (ctx.participants() || []).slice().sort(studentSort(ctx)).map(id => ({
        id, name: studentName(id, ctx), members: [id], rec: ss?.records?.[id]?.[slide.id] || null,
      }));
    }
    function showEmpty(on) {
      if (on) {
        if (!emptyViewer) {
          // 배경만 보이는 스테이지 + 한 줄
          emptyViewer = renderSlide({ root: emptyBox, slide, session: null, scope: "bg", readOnly: true });
          emptyFit = fitFrame(emptyBox);
        }
        const msg = kind === "group" ? "모둠을 편성해 주세요" : "아직 아무도 없어요";
        const btn = kind === "group" ? el("button", { type: "button", class: "btn btn-sm", onClick: openGroupBuilder }, "모둠 편성") : null;
        root.replaceChildren(el("div", { class: "empty" }, [msg, btn ? " " : null, btn]), emptyBox);
      } else if (emptyViewer) {
        emptyFit?.destroy(); emptyFit = null;
        emptyViewer.destroy(); emptyViewer = null;
        root.replaceChildren(grid);
      } else if (grid.parentNode !== root) {
        root.replaceChildren(grid);
      }
    }
    function update() {
      const list = items();
      showEmpty(list.length === 0);
      const online = ctx.online() || new Set();
      const seen = new Set();
      list.forEach((it, i) => {
        seen.add(it.id);
        let t = tiles.get(it.id);
        if (!t) {
          const mini = miniFrame(slide);
          const dot = el("i", { class: "dot" });
          const name = el("span", {});
          const cnt = el("em", { class: "ink-cnt" });
          const node = el("button", { type: "button", class: "ink-tile", onClick: () => openZoom(kind, it.id) },
            [mini, el("div", { class: "ink-tile-name" }, [dot, name, cnt])]);
          t = { node, mini, dot, name, cnt };
          tiles.set(it.id, t);
        }
        if (grid.children[i] !== t.node) grid.insertBefore(t.node, grid.children[i] || null);
        if (t.name.textContent !== it.name) t.name.textContent = it.name;
        t.dot.classList.toggle("on", it.members.some(id => online.has(id)));
        t.cnt.textContent = kind === "group" ? `${it.members.length}명` : "";
        t.mini.paint(it.rec); // 레코드 변경 시만 다시 그림
      });
      for (const [id, t] of tiles) if (!seen.has(id)) { t.node.remove(); tiles.delete(id); }
    }
    function updateDots() {
      const online = ctx.online() || new Set();
      for (const it of items()) {
        const t = tiles.get(it.id);
        if (t) t.dot.classList.toggle("on", it.members.some(id => online.has(id)));
      }
    }
    update();
    return {
      el: root, update, updateDots,
      destroy() { emptyFit?.destroy(); emptyViewer?.destroy(); tiles.clear(); root.remove(); },
    };
  }

  // 타일 탭 → 크게 보기 (교사 첨삭 가능)
  function openZoom(kind, id) {
    closeZoom();
    const ss = ctx.session() || session;
    const title = kind === "group" ? ((ctx.groups() || []).find(g => g.id === id)?.name || "모둠") : studentName(id, ctx);
    const body = el("div", { class: "ink-wrap ink-zoom" });
    const stage = el("div", { class: "ink-stage" });
    const z = { kind, id, viewer: null, fit: null, modal: null };
    z.viewer = renderSlide({
      root: stage, slide, session: ss, scope: kind === "group" ? "group" : "individual", scopeId: id,
      readOnly: false, authorId: me?.id || null,
    });
    const zbar = makeToolbar(() => z.viewer);
    body.append(zbar, stage);
    zbar.apply();
    z.fit = fitFrame(stage);
    zoom = z;
    z.modal = openModal(ctx, {
      title, body,
      actions: [], // 닫기는 모달 X·바깥 탭
      onClose: () => { if (zoom === z) zoom = null; z.fit?.destroy(); z.viewer?.destroy(); },
    });
    setTimeout(() => z.fit?.fit(), 30);
  }
  function closeZoom() {
    if (!zoom) return;
    const z = zoom;
    zoom = null;
    z.modal?.close();
    z.fit?.destroy(); z.viewer?.destroy();
  }

  // ── 모둠 편성 모달 ──
  function openGroupBuilder() {
    if (gbModal?.isOpen()) return;
    let size = 4;
    let selected = null;
    let draft = (ctx.groups() || []).map(g => ({ id: g.id, name: g.name, memberIds: (g.memberIds || []).slice() }));
    const poolIds = () => {
      const s = new Set([...(ctx.participants() || []), ...(ctx.online() || [])]);
      draft.forEach(g => g.memberIds.forEach(id => s.add(id)));
      return [...s];
    };
    const body = el("div", { class: "ink-gb" });
    const sizeSeg = seg([["2", "2"], ["3", "3"], ["4", "4"], ["5", "5"]], String(size), (v) => { size = +v; segSet(sizeSeg, v); });
    const top = el("div", { class: "ink-gb-top" }, [
      el("span", { class: "ink-gb-title" }, "조 크기"), sizeSeg,
      el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: randomize }, "랜덤 편성"),
      el("button", { type: "button", class: "btn btn-sm btn-ghost", onClick: addGroup }, "+ 모둠"),
    ]);
    const area = el("div", { class: "ink-gb-groups" });
    body.append(top, area);

    function randomize() {
      const parts = groupStudents(poolIds(), size);
      draft = parts.map((m, i) => ({ id: newId("grp"), name: `${i + 1}모둠`, memberIds: m }));
      selected = null;
      render();
    }
    function addGroup() {
      draft.push({ id: newId("grp"), name: `${draft.length + 1}모둠`, memberIds: [] });
      render();
    }
    function moveTo(gid) {
      if (!selected) return;
      draft.forEach(g => { g.memberIds = g.memberIds.filter(x => x !== selected); });
      if (gid) draft.find(g => g.id === gid)?.memberIds.push(selected);
      selected = null;
      render();
    }
    function chip(id, gid) {
      const online = ctx.online() || new Set();
      return el("button", {
        type: "button", class: "ink-chip" + (selected === id ? " sel" : ""),
        onClick: (e) => {
          e.stopPropagation();
          if (selected === id) { selected = null; render(); return; }
          if (selected) { moveTo(gid); return; } // 탭→탭: 이 칩의 모둠으로 이동
          selected = id; render();
        },
      }, [el("i", { class: "dot" + (online.has(id) ? " on" : "") }), studentName(id, ctx)]);
    }
    function box(title, ids, gid, isPool) {
      return el("div", {
        class: "ink-gb-box" + (isPool ? " is-pool" : "") + (selected ? " can-drop" : ""),
        onClick: () => moveTo(gid),
      }, [
        el("div", { class: "ink-gb-title" }, [el("span", {}, title), el("span", {}, `${ids.length}명`)]),
        el("div", { class: "ink-gb-chips" }, ids.slice().sort(studentSort(ctx)).map(id => chip(id, gid))),
      ]);
    }
    function render() {
      const assigned = new Set(draft.flatMap(g => g.memberIds));
      const pool = poolIds().filter(id => !assigned.has(id));
      area.replaceChildren(
        ...draft.map(g => box(g.name, g.memberIds, g.id, false)),
        box("미배정", pool, null, true),
      );
    }
    render();
    gbModal = openModal(ctx, {
      title: "모둠 편성", body,
      actions: [
        { label: "취소", onClick: (close) => close() },
        {
          label: "저장", primary: true,
          onClick: (close) => {
            const groups = draft.filter(g => g.memberIds.length)
              .map((g, i) => ({ id: g.id, name: `${i + 1}모둠`, memberIds: g.memberIds.slice() }));
            const ss = ctx.session();
            if (ss && typeof cloud.patchSession === "function") cloud.patchSession(ss, { groups });
            ctx.toast("모둠을 저장했어요");
            close();
          },
        },
      ],
      onClose: () => { gbModal = null; },
    });
  }

  // ── 패널: 모드 seg + 모둠 편성 ──
  const modeSeg = seg(MODES, curMode(), (m) => { ctx.setActivity({ mode: m }); segSet(modeSeg, m); });
  const groupNote = el("span", { class: "ink-note" });
  const groupRow = el("div", { class: "ink-row" }, [
    el("button", { type: "button", class: "btn btn-sm", onClick: openGroupBuilder }, [icon("users"), " 모둠 편성"]),
    groupNote,
  ]);
  const panel = el("div", { class: "ink-panel" }, [
    el("div", { class: "field" }, [el("label", {}, "모드"), modeSeg]),
    groupRow,
  ]);
  function syncPanel() {
    const m = curMode();
    segSet(modeSeg, m);
    groupRow.style.display = m === "group" ? "" : "none";
    if (m === "group") {
      const gs = ctx.groups() || [];
      const assigned = new Set(gs.flatMap(g => g.memberIds || []));
      const left = (ctx.participants() || []).filter(id => !assigned.has(id)).length;
      groupNote.textContent = gs.length ? `${gs.length}모둠${left ? ` · 미배정 ${left}명` : ""}` : "";
    }
  }

  // 온라인 점 (presence)
  function attachPresence() {
    const ch = typeof realtime.currentChannel === "function" ? realtime.currentChannel() : null;
    if (ch === presCh) return;
    try { presOff && presOff(); } catch (_) {}
    presCh = ch; presOff = null;
    if (ch && typeof ch.onPresence === "function") {
      try { presOff = ch.onPresence(() => gal?.updateDots()); } catch (_) {}
    }
  }

  function update() {
    const m = curMode();
    const k = (m === "individual" || m === "group") ? m : "whole";
    if (k !== bodyKey) mountBody();
    else if (viewer) viewer.refresh();
    else gal?.update();
    zoom?.viewer?.refresh();
    syncPanel();
    attachPresence();
  }

  mountBody();
  syncPanel();
  attachPresence();

  return {
    el: wrap,
    panel,
    onActivity: update,
    onSession: update,
    destroy() {
      closeZoom();
      gbModal?.close(); gbModal = null;
      try { presOff && presOff(); } catch (_) {}
      presOff = null;
      teardownBody();
    },
  };
}

// ── 썸네일 ──
function thumb(slide) {
  injectCss("ink", CSS);
  const src = slide.thumb || slide.bg;
  const d = el("div", { class: "ink-thumb" + (src ? "" : " is-paper") });
  if (src) d.appendChild(el("img", { src, alt: "", loading: "lazy", decoding: "async" }));
  if (hasInk(slide)) {
    const c = el("canvas", {});
    paintStrokes(c, slide.strokes || [], { texts: slide.texts || [], width: 320, height: 200 });
    d.appendChild(c);
  }
  return d;
}

// ── 기록(읽기 전용) ──
function summary(slide, responses, session, ctx) {
  injectCss("ink", CSS);
  const wrap = el("div", { class: "ink-summary" });
  const recs = session?.records || {};
  const whole = recs.__whole?.[slide.id];
  const indiv = Object.entries(recs)
    .filter(([k, v]) => !k.startsWith("__") && hasInk(v?.[slide.id]))
    .map(([k, v]) => ({ id: k, rec: v[slide.id] }))
    .sort((a, b) => studentSort(ctx)(a.id, b.id));
  const groupNames = new Map((session?.groups || []).map(g => [g.id, g.name]));
  const grp = Object.entries(recs.__groups || {})
    .filter(([, v]) => hasInk(v?.[slide.id]))
    .map(([k, v]) => ({ id: k, rec: v[slide.id] }));

  if (hasInk(whole) || (!indiv.length && !grp.length)) {
    const m = miniFrame(slide, { big: true });
    m.paint(whole || null);
    wrap.appendChild(m);
  }
  const gallery = (title, list, nameOf) => {
    if (!list.length) return;
    wrap.appendChild(el("div", { class: "ink-sum-head" }, title));
    wrap.appendChild(el("div", { class: "ink-tiles" }, list.map(it => {
      const m = miniFrame(slide);
      m.paint(it.rec);
      return el("div", { class: "ink-tile static" }, [m, el("div", { class: "ink-tile-name" }, [el("span", {}, nameOf(it.id))])]);
    })));
  };
  gallery(`개별 필기 ${indiv.length}명`, indiv, (id) => studentName(id, ctx));
  gallery(`모둠 필기 ${grp.length}개`, grp, (id) => groupNames.get(id) || "모둠");
  return wrap;
}

registerSlideType({
  type: "ink",
  category: "basic",
  label: "필기",
  desc: "배경 위에 함께 필기",
  icon: PEN_ICON,
  create() {
    return { type: "ink", title: null, config: {}, bg: null, bgPath: null, thumb: null, mode: "whole", strokes: [], texts: [] };
  },
  thumb,
  Editor,
  Student,
  TeacherLive,
  summary,
});
