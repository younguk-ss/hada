// 담벼락 — 학생이 짧은 글(포스트잇)을 올리고 함께 본다. 글 1개 = Response 1개(itemKey 'post_…'). (§6.4)
// 가정: payload = { text ≤200자, color 0..4, at: 처음 올린 시각(ms) } — 정렬은 at(없으면 updatedAt) 최신 순, 수정해도 자리 유지.
// 가정: 잠금 = activity.phase 'ended'(교사 [잠금]↔[잠금 해제]). 교사 바는 activityBar 대신 글 수·잠금·초기화만 둔다.
// 가정: 작성 시트는 ui.sheet({ title, body, actions }) 를 쓴다(styles.css 의 .sheet).
import * as ui from "../ui.js";
import * as store from "../store.js";
import { registerSlideType, injectCss, newId } from "./registry.js";

const { el } = ui;

const MAX_LEN = 200;
export const WALL_COLORS = ["#fff4c2", "#fde2e4", "#dbeafe", "#dcfce7", "#ede9fe"];

const CSS = `
.wl{position:relative;display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;padding:16px;box-sizing:border-box}
.wl-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}
.wl-prompt{margin:0;font-size:20px;font-weight:700;line-height:1.35;color:var(--ink);white-space:pre-wrap;word-break:keep-all;flex:1;min-width:0}
.wl-prompt:empty{display:none}
.wl-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wl-scroll{flex:1;min-height:0;overflow:auto;padding-bottom:72px}
.wl-teacher .wl-scroll{padding-bottom:8px}
.wl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;align-items:start}
.wl-stu .wl-grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
.wl-card{position:relative;display:flex;flex-direction:column;gap:8px;min-height:96px;padding:14px 14px 10px;border-radius:var(--radius-sm);
  box-shadow:var(--shadow-1);color:#1c1c22;animation:wl-in .22s ease}
@keyframes wl-in{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
.wl-card.mine{cursor:pointer;outline:2px solid rgba(79,70,229,.35);outline-offset:-2px}
.wl-text{flex:1;font-size:15px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.wl-foot{display:flex;align-items:center;gap:6px;min-height:20px;font-size:12px;color:rgba(28,28,34,.6)}
.wl-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.wl-del{border:0;background:rgba(255,255,255,.6);color:#b91c1c;border-radius:8px;height:28px;padding:0 10px;font-size:12px;font-weight:600;cursor:pointer}
.wl-del:hover{background:#fff}
.wl-empty{padding:40px 0}
.wl-fab{position:absolute;left:50%;bottom:calc(16px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:5;box-shadow:var(--shadow-2);min-width:160px}
.wl-compose{display:flex;flex-direction:column;gap:12px}
.wl-ta{min-height:120px;resize:vertical;font-size:16px;line-height:1.5}
.wl-sheet-row{display:flex;align-items:center;gap:10px}
.wl-count{margin-left:auto;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.wl-dots{display:flex;gap:10px}
.wl-dot{width:32px;height:32px;border-radius:50%;border:1.5px solid var(--line-strong);cursor:pointer;padding:0}
.wl-dot.on{box-shadow:0 0 0 3px var(--surface),0 0 0 5px var(--accent)}
.wl-editor{display:flex;flex-direction:column;gap:14px;width:100%;max-width:560px;margin:0 auto;padding:24px;box-sizing:border-box}
.wl-check{display:flex;align-items:center;gap:10px;min-height:40px;cursor:pointer}
.wl-check input{width:20px;height:20px;accent-color:var(--accent)}
.wl-sum .wl-scroll{overflow:visible;padding-bottom:0}
`;
function ensureCss(ctx) { (ctx?.injectCss || injectCss)("wall", CSS); }

function nameOf(ctx, id) {
  return ctx?.students?.()?.get?.(id)?.name || store.findStudent?.(id)?.name || "";
}
const postTime = (r) => r?.payload?.at || r?.updatedAt || 0;
function sortedPosts(list) {
  return (list || []).filter(r => r?.payload && typeof r.payload.text === "string" && r.itemKey)
    .sort((a, b) => postTime(b) - postTime(a));
}
const colorOf = (r, allowColor) => WALL_COLORS[allowColor ? ((r.payload.color | 0) % WALL_COLORS.length + WALL_COLORS.length) % WALL_COLORS.length : 0];

// itemKey 로 카드 DOM 보존하는 그리드
// opts: { showName(r)→string, mine(r)→bool, onOpen(r)?, onDelete(r)?, allowColor }
function createGrid(opts) {
  const grid = el("div", { class: "wl-grid" });
  const empty = el("div", { class: "empty wl-empty" }, "아직 글이 없어요");
  const wrap = el("div", { class: "wl-scroll" }, [grid, empty]);
  const cards = new Map();   // itemKey → { card, sig, r }

  function build(key) {
    const text = el("div", { class: "wl-text" });
    const name = el("span", { class: "wl-name" });
    const foot = el("div", { class: "wl-foot" }, [name]);
    const card = el("div", { class: "wl-card", "data-key": key }, [text, foot]);
    const entry = { card, text, name, sig: "", r: null };
    if (opts.onOpen) card.addEventListener("click", () => { if (entry.r && opts.mine(entry.r)) opts.onOpen(entry.r); });
    if (opts.onDelete) {
      foot.appendChild(el("button", { type: "button", class: "wl-del", onClick: (e) => { e.stopPropagation(); if (entry.r) opts.onDelete(entry.r); } }, "삭제"));
    }
    return entry;
  }

  function set(list) {
    const posts = sortedPosts(list);
    const keep = new Set(posts.map(r => r.itemKey));
    // 지워진 글을 먼저 빼야 남은 카드가 불필요하게 옮겨지지 않는다(옮기면 등장 애니메이션이 다시 돎)
    for (const [k, e] of cards) if (!keep.has(k)) { e.card.remove(); cards.delete(k); }
    posts.forEach((r, i) => {
      let e = cards.get(r.itemKey);
      if (!e) { e = build(r.itemKey); cards.set(r.itemKey, e); }
      e.r = r;
      const mine = opts.mine(r);
      const nm = opts.showName(r);
      const bg = colorOf(r, opts.allowColor);
      const sig = `${r.payload.text}|${bg}|${nm}|${mine}`;
      if (sig !== e.sig) {
        e.sig = sig;
        e.text.textContent = r.payload.text;
        e.name.textContent = nm;
        e.card.style.background = bg;
        e.card.classList.toggle("mine", mine);
        e.card.title = mine && opts.onOpen ? "눌러서 고치기" : "";
      }
      // 순서 맞추기 (필요할 때만 이동)
      if (grid.children[i] !== e.card) grid.insertBefore(e.card, grid.children[i] || null);
    });
    empty.style.display = posts.length ? "none" : "";
    return posts.length;
  }
  return { el: wrap, set };
}

// 작성/수정 시트 (ui.sheet) → close()
function openComposer({ title, text = "", color = 0, allowColor, onSave, onDelete, saveLabel }) {
  const ta = el("textarea", { class: "input wl-ta", maxlength: MAX_LEN, placeholder: "내용" });
  ta.value = text;
  const count = el("span", { class: "wl-count" });
  const upd = () => { count.textContent = `${Array.from(ta.value).length}/${MAX_LEN}`; };
  ta.addEventListener("input", upd); upd();

  let cur = color;
  const dots = el("div", { class: "wl-dots" });
  const drawDots = () => {
    dots.innerHTML = "";
    WALL_COLORS.forEach((c, i) => dots.appendChild(el("button", {
      type: "button", class: "wl-dot" + (i === cur ? " on" : ""), style: { background: c }, "aria-label": `색 ${i + 1}`,
      onClick: () => { cur = i; drawDots(); },
    })));
  };
  if (allowColor) drawDots();

  const body = el("div", { class: "wl-compose" }, [
    ta,
    el("div", { class: "wl-sheet-row" }, [allowColor ? dots : null, count]),
  ]);
  const actions = [];
  if (onDelete) actions.push({ label: "삭제", danger: true, onClick: async (close) => { if ((await onDelete()) !== false) close(); } });
  actions.push({ label: saveLabel || "올리기", primary: true, onClick: async (close) => {
    const v = ta.value.trim();
    if (!v) { ta.focus(); return; }
    const ok = await onSave(Array.from(v).slice(0, MAX_LEN).join(""), allowColor ? cur : 0);
    if (ok !== false) close();
  } });
  const sh = ui.sheet({ title, body, actions });
  return () => sh?.close?.();
}

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="6" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="11" width="8" height="10" rx="1.5"/></svg>`;

registerSlideType({
  type: "wall",
  category: "interact",
  label: "담벼락",
  desc: "학생들이 짧은 글을 붙여요",
  icon: ICON,

  create() {
    return { type: "wall", config: { prompt: "", allowColor: true, showNames: true } };
  },

  Editor({ slide, update, ctx }) {
    ensureCss(ctx);
    const cfg = () => slide.config || {};
    const prompt = el("textarea", { class: "input", rows: 3, placeholder: "주제 (예: 오늘 배운 점을 남겨 주세요)" });
    prompt.value = cfg().prompt || "";
    prompt.addEventListener("input", () => update({ config: { ...cfg(), prompt: prompt.value } }));
    const check = (key, label) => {
      const inp = el("input", { type: "checkbox" });
      inp.checked = cfg()[key] !== false;
      inp.addEventListener("change", () => update({ config: { ...cfg(), [key]: inp.checked } }));
      return el("label", { class: "wl-check" }, [inp, el("span", {}, label)]);
    };
    const root = el("div", { class: "wl-editor" }, [
      el("label", { class: "field" }, [el("span", {}, "주제"), prompt]),
      check("allowColor", "학생이 색 고르기"),
      check("showNames", "학생 화면에 이름 보이기"),
    ]);
    return { el: root };
  },

  Student({ slide, ctx }) {
    ensureCss(ctx);
    const cfg = slide.config || {};
    const allowColor = cfg.allowColor !== false;
    const showNames = cfg.showNames !== false;
    const myId = ctx.me?.id;
    let closeSheet = null;
    const locked = () => ctx.activity().phase === "ended";

    const grid = createGrid({
      allowColor,
      mine: (r) => r.studentId === myId,
      showName: (r) => r.studentId === myId ? "나" : showNames ? nameOf(ctx, r.studentId) : "",
      onOpen: (r) => openEdit(r),
    });
    const status = el("div");
    const fab = el("button", { type: "button", class: "btn btn-primary btn-lg wl-fab", onClick: () => openNew() }, "+ 글쓰기");
    const root = el("div", { class: "wl wl-stu" }, [
      el("div", { class: "wl-head" }, [el("h2", { class: "wl-prompt" }, cfg.prompt || ""), status]),
      grid.el, fab,
    ]);

    async function post(itemKey, payload) {
      if (locked()) { ctx.toast("잠겨 있어요"); return false; }
      try { await ctx.submit(payload, { itemKey }); return true; }
      catch (e) { return false; }   // ctx.submit 이 toast 처리
    }
    function openNew() {
      if (locked()) { ctx.toast("잠겨 있어요"); return; }
      closeSheet?.();
      closeSheet = openComposer({
        title: "글쓰기", allowColor, color: Math.floor(Math.random() * WALL_COLORS.length),
        onSave: (text, color) => post(newId("post"), { text, color, at: Date.now() }),
      });
    }
    function openEdit(r) {
      if (locked()) { ctx.toast("잠겨 있어요"); return; }
      closeSheet?.();
      closeSheet = openComposer({
        title: "내 글", text: r.payload.text, color: r.payload.color | 0, allowColor, saveLabel: "저장",
        onSave: (text, color) => post(r.itemKey, { ...r.payload, text, color, at: r.payload.at || postTime(r) || Date.now() }),
        onDelete: async () => {
          if (!(await ctx.confirm("글을 삭제할까요?", { ok: "삭제", danger: true }))) return false;
          try { await ctx.removeResponse(myId, r.itemKey); return true; }
          catch (e) { return false; }   // 실패 toast 는 host 가 처리
        },
      });
    }

    let lastLock = null;
    function renderLock() {
      const l = locked();
      if (l === lastLock) return;
      lastLock = l;
      fab.style.display = l ? "none" : "";
      status.innerHTML = "";
      if (l) { status.appendChild(el("span", { class: "pill pill-muted" }, "잠김")); closeSheet?.(); closeSheet = null; }
    }
    const refresh = () => grid.set(ctx.responses());
    renderLock(); refresh();

    return {
      el: root,
      onActivity: renderLock,
      onResponses: refresh,
      onSession: refresh,       // 이름 정보가 늦게 오면 갱신 (sig 비교라 싸다)
      destroy() { closeSheet?.(); },
    };
  },

  TeacherLive({ slide, ctx }) {
    ensureCss(ctx);
    const cfg = slide.config || {};
    const grid = createGrid({
      allowColor: cfg.allowColor !== false,
      mine: () => false,
      showName: (r) => nameOf(ctx, r.studentId) || "학생",
      onDelete: async (r) => {
        try { await ctx.removeResponse(r.studentId, r.itemKey); ctx.toast("삭제했어요"); }
        catch (e) { /* 실패 toast 는 host 가 처리 */ }
      },
    });
    const count = el("span", { class: "pill pill-muted" });
    const lockBtn = el("button", { type: "button", class: "btn btn-sm", onClick: () => {
      ctx.setActivity({ phase: ctx.activity().phase === "ended" ? "idle" : "ended" });
    } });
    const resetBtn = el("button", { type: "button", class: "btn btn-sm btn-ghost", onClick: async () => {
      if (!(await ctx.confirm("모든 글을 지울까요?", { ok: "초기화", danger: true }))) return;
      try { await ctx.clearResponses(); ctx.setActivity({ phase: "idle" }); }
      catch (e) { /* 실패 toast 는 host 가 처리 */ }
    } }, "초기화");
    const root = el("div", { class: "wl wl-teacher" }, [
      el("div", { class: "wl-head" }, [
        el("h2", { class: "wl-prompt" }, cfg.prompt || ""),
        el("div", { class: "wl-bar" }, [count, lockBtn, resetBtn]),
      ]),
      grid.el,
    ]);
    function renderBar() {
      const l = ctx.activity().phase === "ended";
      lockBtn.textContent = l ? "잠금 해제" : "잠금";
      lockBtn.className = l ? "btn btn-sm btn-dark" : "btn btn-sm";
    }
    const refresh = () => { count.textContent = `글 ${grid.set(ctx.responses())}개`; };
    renderBar(); refresh();
    return {
      el: root,
      onActivity: renderBar,
      onResponses: refresh,
      onSession: refresh,
    };
  },

  summary(slide, responses, session, ctx) {
    ensureCss(ctx);
    const cfg = slide.config || {};
    const grid = createGrid({
      allowColor: cfg.allowColor !== false,
      mine: () => false,
      showName: (r) => nameOf(ctx, r.studentId),
    });
    grid.set(responses);
    return el("div", { class: "wl wl-sum", style: { height: "auto" } }, [
      el("h3", { class: "wl-prompt" }, cfg.prompt || ""),
      grid.el,
    ]);
  },
});
