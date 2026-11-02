// 주관식·서술형(short) 슬라이드
// 가정: 채점 없음(score/correct = null). payload = { text }.
// 가정: reveal 시 학생은 교사가 고른(activity.pinned) 답만 본다 — 이름 없이 글만(학생 화면 최소화).
// 가정: maxLen 은 편집기에서 long 전환 시 2000/300 으로 맞춘다. 실제 한도 = min(maxLen, long?2000:300).
// 가정(v2.9): 교사 화면은 마감·공개·타이머 끝 전에는 응답 수만(답 카드·패널의 답 가림). 문제 그림 config.image.
import { el } from "../ui.js";
import { registerSlideType, injectCss } from "./registry.js";
import { activityBar, resultsOpen, resultsVeil, questionImage, imageField } from "./common.js";
import {
  ensureQuizCss, statusRow, rosterList, rosterIds, byStudent, nameOf,
  isLocked, clockNow, elapsedMs, actOf, seg, field, quizThumb, sessionSig,
} from "./mcq.js";

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9h10M7 13h10M7 17h6"/></svg>`;

const CSS = `
.sa-input { font-size: 17px; min-height: 52px; }
textarea.sa-input { min-height: 160px; resize: vertical; line-height: 1.5; }
.sa-count { font-size: 12px; color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; margin-top: -8px; }
.sa-count.over { color: var(--danger); }
.sa-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; align-content: start; }
.sa-card { text-align: left; display: grid; gap: 6px; align-content: start; padding: 14px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); box-shadow: var(--shadow-1); font: inherit; color: inherit; cursor: pointer; min-height: 72px; }
.sa-card .who { font-size: 12px; color: var(--muted); }
.sa-card .txt { font-size: 16px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.sa-card.pinned { background: var(--highlight); border-color: transparent; }
.qz-live .sa-card .txt { font-size: 18px; }
.sa-pinned { display: grid; gap: 10px; }
.sa-pinned .sa-card { cursor: default; }
.sa-label { font-size: 12px; color: var(--muted); }
`;

const defaults = () => ({ question: "", long: false, maxLen: 300, image: null });
const cfgOf = (slide) => ({ ...defaults(), ...(slide.config || {}) });
const limitOf = (cfg) => { const cap = cfg.long ? 2000 : 300; return Math.min(Number(cfg.maxLen) || cap, cap); };

function css(ctx) { ensureQuizCss(ctx); (ctx?.injectCss || injectCss)("short", CSS); }

function Editor({ slide, lesson, update, ctx }) {
  css(ctx);
  let cfg = cfgOf(slide);
  const set = (patch) => { cfg = { ...cfg, ...patch }; update({ config: cfg }); };
  const img = imageField({ value: cfg.image, lessonId: lesson?.id, slideId: slide.id, onChange: (v) => set({ image: v }) });
  const q = el("textarea", { class: "input qz-q-input", placeholder: "질문을 입력하세요", rows: 3 });
  q.value = cfg.question;
  q.addEventListener("input", () => set({ question: q.value }));
  const kind = seg([{ value: false, label: "한 줄" }, { value: true, label: "서술형" }], !!cfg.long,
    (v) => set({ long: v, maxLen: v ? 2000 : 300 }));
  return { el: el("div", { class: "qz-edit" }, [field("", q), img, field("답 형식", kind)]) };
}

function Student({ slide, ctx }) {
  css(ctx);
  const cfg = cfgOf(slide);
  const limit = limitOf(cfg);
  const shownAt = Date.now();
  let st = actOf(ctx);
  let mine = ctx.myResponse?.("") || null;
  let sending = false;

  const status = statusRow({ onExpire: () => paint(), ctx });
  const inp = cfg.long
    ? el("textarea", { class: "input sa-input", maxlength: limit, rows: 6, placeholder: "답을 쓰세요" })
    : el("input", { class: "input sa-input", maxlength: limit, placeholder: "답을 쓰세요", enterkeyhint: "send" });
  inp.value = mine?.payload?.text || "";
  const count = el("div", { class: "sa-count" });
  const submitB = el("button", { class: "btn btn-primary btn-lg btn-block qz-submit", type: "button", onClick: submit }, "제출");
  const pinnedBox = el("div", { class: "sa-pinned" });

  inp.addEventListener("input", paint);
  if (!cfg.long) inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); } });

  const root = el("div", { class: "qz-stu" }, [
    status.el,
    el("h2", { class: "qz-q" }, cfg.question || slide.title || ""),
    questionImage(cfg.image),
    inp, count, submitB, pinnedBox,
  ]);

  const savedText = () => mine?.payload?.text || "";
  const dirty = () => inp.value.trim() !== savedText().trim();

  async function submit() {
    const text = inp.value.trim().slice(0, limit);
    if (isLocked(st, clockNow(ctx)) || sending || !text || !dirty()) return;
    sending = true; paint();
    try {
      mine = await ctx.submit({ text }, { timeMs: elapsedMs(ctx, st, shownAt) });
    } catch (e) { /* ctx.submit 이 toast 처리 */ }
    sending = false;
    paint();
  }

  let pinnedSig = "";
  function paintPinned() {
    const ids = st.reveal ? (st.pinned || []) : [];
    const map = byStudent(ctx.responses() || []);
    const items = ids.map(id => map.get(id)).filter(Boolean);
    const sig = JSON.stringify(items.map(r => [r.studentId, r.payload?.text]));
    if (sig === pinnedSig) return;
    pinnedSig = sig;
    pinnedBox.replaceChildren(...(items.length ? [
      el("div", { class: "sa-label" }, "함께 보기"),
      ...items.map(r => el("div", { class: "sa-card pinned" }, [el("div", { class: "txt" }, r.payload?.text || "")])),
    ] : []));
  }

  function paint() {
    const lock = isLocked(st, clockNow(ctx));
    const len = inp.value.length;
    inp.disabled = lock;
    count.textContent = `${len}/${limit}`;
    count.classList.toggle("over", len >= limit);
    status.set({ state: st, submitted: !!mine && !dirty() });
    submitB.hidden = lock;
    submitB.disabled = lock || sending || !inp.value.trim() || !dirty();
    submitB.textContent = sending ? "제출 중…" : (mine && !dirty() ? "제출함" : (mine ? "다시 제출" : "제출"));
    paintPinned();
  }
  paint();

  return {
    el: root,
    onActivity(s) { st = actOf(ctx, s); paint(); },
    onResponses() {
      const wasDirty = dirty();
      mine = ctx.myResponse?.("") || null;
      // 입력 중이 아니면 서버 값으로 맞춤(교사 초기화 등)
      if (!wasDirty && document.activeElement !== inp) inp.value = savedText();
      paint();
    },
    destroy() { status.destroy(); },
  };
}

// 카드 그리드(학생 id 키로 DOM 보존)
function cardGrid({ onTap } = {}) {
  const root = el("div", { class: "sa-cards" });
  const cards = new Map();
  return {
    el: root,
    set(list, { pinned = [], showNames = true } = {}) {
      const keep = new Set();
      list.forEach((r, i) => {
        keep.add(r.studentId);
        let c = cards.get(r.studentId);
        if (!c) {
          const who = el("div", { class: "who" });
          const txt = el("div", { class: "txt" });
          const node = el(onTap ? "button" : "div", onTap ? { class: "sa-card", type: "button", onClick: () => onTap(r.studentId) } : { class: "sa-card" }, [who, txt]);
          c = { node, who, txt };
          cards.set(r.studentId, c);
        }
        const t = r.payload?.text || "";
        if (c.txt.textContent !== t) c.txt.textContent = t;
        c.who.textContent = showNames ? r.name : "";
        c.who.hidden = !showNames;
        c.node.classList.toggle("pinned", pinned.includes(r.studentId));
        if (root.children[i] !== c.node) root.insertBefore(c.node, root.children[i] || null);
      });
      for (const [k, c] of cards) if (!keep.has(k)) { c.node.remove(); cards.delete(k); }
    },
  };
}

function sorted(ctx, list) {
  return [...byStudent(list).values()]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(r => ({ ...r, name: nameOf(ctx, r.studentId) }));
}

function TeacherLive({ slide, ctx }) {
  css(ctx);
  const cfg = cfgOf(slide);
  let st = actOf(ctx);

  const status = statusRow({ ctx });
  const countP = el("span", { class: "pill" });
  const grid = cardGrid({
    onTap: (sid) => {
      // 초기화로 응답이 사라진 학생 id 는 함께 정리
      const has = byStudent(ctx.responses() || []);
      const cur = (actOf(ctx).pinned || []).filter(x => has.has(x));
      ctx.setActivity({ pinned: cur.includes(sid) ? cur.filter(x => x !== sid) : [...cur, sid] });
    },
  });
  const empty = el("div", { class: "empty" }, "아직 응답이 없어요");
  const veil = resultsVeil();
  const root = el("div", { class: "qz-live" }, [
    el("div", { class: "qz-live-head" }, [status.el, countP]),
    el("h2", { class: "qz-q" }, cfg.question || slide.title || ""),
    questionImage(cfg.image),
    veil, empty, grid.el,
  ]);

  const bar = activityBar(ctx, { reveal: true, timer: true });
  const roster = rosterList();
  const panel = el("div", { class: "qz-panel" }, [bar, roster.el]);

  let sSig = sessionSig(ctx);
  function paint() {
    const list = ctx.responses() || [];
    const items = sorted(ctx, list);
    const open = resultsOpen(st, clockNow(ctx)); // 마감 전에는 답을 가린다(v2.9)
    status.set({ state: st });
    countP.textContent = `응답 ${items.length}`;
    veil.hidden = open;
    veil.set(items.length, (ctx.participants() || []).length);
    empty.hidden = !open || items.length > 0;
    grid.el.hidden = !open;
    if (open) grid.set(items, { pinned: st.pinned || [] });
    const map = byStudent(list);
    roster.set(rosterIds(ctx, list).map(id => {
      const r = map.get(id);
      if (r && !open) return { id, name: nameOf(ctx, id), value: "제출", cls: "" };
      return r ? { id, name: nameOf(ctx, id), value: r.payload?.text || "", cls: "" } : { id, name: nameOf(ctx, id), value: "—", cls: "none" };
    }));
    bar.update();
  }
  paint();

  return {
    el: root,
    panel,
    onActivity(s) { st = actOf(ctx, s); paint(); },
    onResponses() { paint(); },
    onSession() {
      const k = sessionSig(ctx);
      if (k === sSig) return;
      sSig = k; paint();
    },
    destroy() { status.destroy(); bar.destroy?.(); },
  };
}

function summary(slide, responses = [], session, ctx) {
  css(ctx);
  const cfg = cfgOf(slide);
  const items = sorted(ctx, responses);
  const pinned = session?.activity?.[slide.id]?.pinned || [];
  const grid = cardGrid();
  grid.set(items, { pinned });
  return el("div", { class: "qz-sum" }, [
    el("div", { class: "qz-q" }, cfg.question || slide.title || ""),
    questionImage(cfg.image, { small: true }),
    el("div", { class: "qz-sum-meta" }, [el("span", { class: "pill pill-muted" }, `응답 ${items.length}`)]),
    items.length ? grid.el : null,
  ]);
}

registerSlideType({
  type: "short",
  category: "interact",
  label: "주관식·서술형",
  desc: "글로 답하기",
  icon: ICON,
  create() { return { type: "short", config: defaults() }; },
  thumb(slide) { return quizThumb(slide, ICON, slide.config?.question, "주관식·서술형"); },
  Editor,
  Student,
  TeacherLive,
  summary,
  validate(slide) {
    return cfgOf(slide).question.trim() ? null : "질문을 입력하세요";
  },
});
