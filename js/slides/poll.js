// 설문(poll) — 교사가 던진 질문의 선택지 중에서 학생이 자기 의견을 고르기(정답 없음)
// 가정: 응답 payload { answerIds } 는 객관식과 같은 형태, score/correct 는 null(채점 안 함).
// 가정: 결과(선택지별 인원·%)는 교사가 [결과 공개]하면 학생에게도 보인다.
// 가정(v2.17): 한 번 제출하면 답을 바꿀 수 없다(수업 중 계속 바꾸지 않게). 교사가 [초기화]로 응답을 지우면 다시 고를 수 있다.
// 가정: 객관식과 달리 전원 응답해도 자동 마감·공개하지 않는다(교사가 결정).
// 가정: 누가 무엇을 골랐는지는 교사만 본다(막대·타일 탭 → 응답자, 패널 학생 목록). 학생 화면에는 이름이 없다.
import { el } from "../ui.js";
import { registerSlideType, newId, injectCss } from "./registry.js";
import { activityBar, columnChart, whoSheet, optionColor, questionEditor, optionLetter, choiceBars, questionImage } from "./common.js";
import {
  ensureQuizCss, statusRow, rosterList, rosterIds, sortIds, nameOf, byStudent, sessionSig, actOf,
  isLocked, clockNow, elapsedMs, quizThumb, seg, field, letterKeys,
} from "./mcq.js";

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/></svg>`;

const CSS = `
.poll-stu .choice .choice-key.opt-key { background: var(--opt-color); border-color: var(--opt-color); color: #fff; }
.poll-res { display: grid; gap: 10px; padding-top: 4px; }
.poll-res-head { font-size: 14px; font-weight: 600; color: var(--ink-2); }
.poll-res .bar-row.is-highlight .bar-label { font-weight: 700; }
.poll-live { gap: 22px; }
.poll-head { display: flex; align-items: flex-start; gap: 16px; }
.poll-head .qz-q { flex: 1; min-width: 0; font-size: clamp(24px, 3.2vw, 40px); }
.poll-meta { flex: none; display: flex; gap: 6px; align-items: center; padding-top: 8px; }
.poll-live .cc { --cc-h: clamp(110px, 34cqh, 380px); margin-top: auto; }
@media (max-width: 720px) { .poll-live .cc { --cc-h: 140px; } .poll-head { flex-direction: column-reverse; gap: 8px; } }
.poll-sum .cc { --cc-h: 120px; }
.poll-sum .cc-tile { min-height: 56px; font-size: 15px; padding: 10px 8px; }
`;
const ensureCss = (ctx) => { ensureQuizCss(ctx); (ctx?.injectCss || injectCss)("poll", CSS); };

const defaults = () => ({
  question: "",
  options: Array.from({ length: 4 }, () => ({ id: newId("opt"), text: "" })),
  multiple: false,
});

function cfgOf(slide) {
  const c = { ...defaults(), ...(slide.config || {}) };
  c.options = (c.options || []).map(o => ({ id: o.id || newId("opt"), text: o.text || "" }));
  return c;
}

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

// 선택지별 고른 학생 수 (여러 개 고르기면 고른 선택지마다 1)
function countsOf(cfg, map) {
  const counts = {};
  for (const o of cfg.options) counts[o.id] = 0;
  for (const r of map.values()) for (const id of new Set(r.payload?.answerIds || [])) if (id in counts) counts[id] += 1;
  return counts;
}
const optLabel = (o, i) => `${optionLetter(i)}. ${o.text || ""}`.trim();

function chartFor(cfg, onBarClick) {
  const opts = cfg.options.map((o, i) => ({ id: o.id, label: o.text || optionLetter(i) }));
  return letterKeys(columnChart(opts, onBarClick ? { onBarClick } : {}));
}

function openWho(ctx, cfg, list) {
  if (typeof ctx?.modal !== "function") return;
  const map = byStudent(list || []);
  const rs = [...map.values()];
  const groups = cfg.options.map((o, i) => ({
    label: optLabel(o, i), color: optionColor(i),
    studentIds: rs.filter(r => (r.payload?.answerIds || []).includes(o.id)).map(r => r.studentId),
  }));
  groups.push({ label: "미응답", studentIds: (ctx.participants?.() || []).filter(id => !map.has(id)) });
  whoSheet(ctx, { title: "응답 보기", groups });
}

function rosterRow(ctx, cfg, id, r) {
  if (!r) return { id, name: nameOf(ctx, id), value: "—", cls: "none" };
  const picks = cfg.options.map((o, i) => ((r.payload?.answerIds || []).includes(o.id) ? optionLetter(i) : "")).join("");
  return { id, name: nameOf(ctx, id), value: picks || "?" };
}

function Editor({ slide, lesson, update, ctx }) {
  ensureCss(ctx);
  let cfg = cfgOf(slide);
  const set = (patch) => { cfg = { ...cfg, ...patch }; update({ config: cfg }); };
  const q = questionEditor({
    question: cfg.question, options: cfg.options, answers: false,
    placeholder: "질문을 입력하세요", image: cfg.image, imageAt: { lessonId: lesson?.id, slideId: slide.id },
    onChange: ({ question, options, image }) => set({ question, options, image: image || null }),
  });
  const multiSeg = seg([{ value: false, label: "하나만" }, { value: true, label: "여러 개" }], !!cfg.multiple, (v) => set({ multiple: v }));
  return { el: el("div", { class: "qz-edit" }, [q, field("", multiSeg)]) };
}

function Student({ slide, ctx }) {
  ensureCss(ctx);
  const cfg = cfgOf(slide);
  const shownAt = Date.now();
  let st = actOf(ctx);
  let mine = ctx.myResponse?.("") || null;
  let sel = new Set(mine?.payload?.answerIds || []);
  let dirty = false, sending = false;

  const status = statusRow({ onExpire: () => paint(), ctx });
  const multiP = cfg.multiple ? el("span", { class: "pill pill-muted" }, "여러 개 선택") : null;
  if (multiP) status.el.appendChild(multiP);
  const btns = cfg.options.map((o, i) => {
    const b = el("button", { class: "choice", type: "button", onClick: () => pick(o.id) }, [
      el("span", { class: "choice-key opt-key", style: { "--opt-color": optionColor(i) } }, optionLetter(i)),
      el("span", { class: "choice-text" }, o.text || " "),
    ]);
    return { b, id: o.id };
  });
  const submitB = el("button", { class: "btn btn-primary btn-lg btn-block qz-submit", type: "button", onClick: submit }, "제출");
  const onceHint = el("p", { class: "hint qz-once" }, "제출하면 답을 바꿀 수 없어요");
  const bars = choiceBars([], 0, { revealed: true });
  const results = el("div", { class: "poll-res", hidden: true }, [el("div", { class: "poll-res-head" }, "결과"), bars]);
  const root = el("div", { class: "qz-stu poll-stu" }, [
    status.el,
    el("h2", { class: "qz-q" }, cfg.question || slide.title || ""),
    questionImage(cfg.image),
    el("div", { class: "qz-choices" }, btns.map(x => x.b)),
    submitB,
    onceHint,
    results,
  ]);

  const locked = () => isLocked(st, clockNow(ctx));

  function pick(id) {
    if (locked() || sending || mine) return; // 제출한 뒤에는 바꿀 수 없음
    if (cfg.multiple) { if (sel.has(id)) sel.delete(id); else sel.add(id); }
    else sel = new Set([id]);
    dirty = !sameSet([...sel], mine?.payload?.answerIds || []);
    paint();
  }

  async function submit() {
    if (locked() || sending || mine || !sel.size) return;
    const picked = cfg.options.map(o => o.id).filter(id => sel.has(id));
    sending = true; paint();
    try {
      mine = await ctx.submit({ answerIds: picked }, { score: null, correct: null, timeMs: elapsedMs(ctx, st, shownAt) });
      dirty = false;
    } catch (e) { /* ctx.submit 이 toast 처리 */ }
    sending = false;
    paint();
  }

  function paint() {
    const lock = locked();
    // 잠김·제출됨(다른 기기에서 낸 경우 포함) → 고르던 것은 버리고 제출본을 보여 준다
    if ((lock || mine) && dirty && !sending) { sel = new Set(mine?.payload?.answerIds || []); dirty = false; }
    const done = !!mine && !sending;
    status.set({ state: st, submitted: done });
    for (const x of btns) {
      x.b.disabled = lock || done;
      x.b.classList.toggle("selected", sel.has(x.id));
    }
    submitB.hidden = lock;
    submitB.disabled = sending || !sel.size || done;
    submitB.textContent = sending ? "제출 중…" : (done ? "제출함" : "제출");
    onceHint.hidden = lock || done;
    // 결과: 교사가 공개했을 때만 (내가 고른 선택지 강조)
    const show = st.reveal === true;
    results.hidden = !show;
    if (show) {
      const map = byStudent(ctx.responses?.() || []);
      const counts = countsOf(cfg, map);
      const mineIds = mine?.payload?.answerIds || [];
      bars.update(cfg.options.map((o, i) => ({ label: optLabel(o, i), count: counts[o.id], highlight: mineIds.includes(o.id) })), map.size, { revealed: true });
    }
  }
  paint();

  return {
    el: root,
    onActivity(s) { st = actOf(ctx, s); paint(); },
    onResponses() {
      mine = ctx.myResponse?.("") || null;
      if (!dirty) sel = new Set(mine?.payload?.answerIds || []);
      paint();
    },
    destroy() { status.destroy(); },
  };
}

function TeacherLive({ slide, ctx }) {
  ensureCss(ctx);
  const cfg = cfgOf(slide);
  let st = actOf(ctx);

  const status = statusRow({ ctx });
  const countP = el("span", { class: "pill" });
  const chart = chartFor(cfg, () => openWho(ctx, cfg, ctx.responses() || []));
  const root = el("div", { class: "qz-live poll-live" }, [
    el("div", { class: "poll-head" }, [
      el("h2", { class: "qz-q" }, cfg.question || slide.title || ""),
      el("div", { class: "poll-meta" }, [status.el, countP]),
    ]),
    questionImage(cfg.image),
    chart,
  ]);
  const bar = activityBar(ctx, { reveal: true, revealLabel: "결과 공개", timer: true });
  const roster = rosterList();
  const panel = el("div", { class: "qz-panel" }, [bar, roster.el]);

  let sSig = sessionSig(ctx);
  function paint() {
    const list = ctx.responses() || [];
    const map = byStudent(list);
    status.set({ state: st });
    countP.textContent = `응답 ${map.size}/${(ctx.participants() || []).length}`;
    chart.update({ counts: countsOf(cfg, map), correctIds: [], revealed: false });
    roster.set(rosterIds(ctx, list).map(id => rosterRow(ctx, cfg, id, map.get(id))));
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
  ensureCss(ctx);
  const cfg = cfgOf(slide);
  const map = byStudent(responses);
  const canWho = !!ctx?.isTeacher && typeof ctx?.modal === "function";
  const chart = chartFor(cfg, canWho ? () => openWho(ctx, cfg, responses) : null);
  chart.update({ counts: countsOf(cfg, map), correctIds: [], revealed: false });
  const roster = rosterList();
  roster.set(sortIds(ctx, [...map.keys()]).map(id => rosterRow(ctx, cfg, id, map.get(id))));
  return el("div", { class: "qz-sum poll-sum" }, [
    el("div", { class: "qz-q" }, cfg.question || slide.title || ""),
    questionImage(cfg.image, { small: true }),
    el("div", { class: "qz-sum-meta" }, [el("span", { class: "pill pill-muted" }, `응답 ${map.size}`)]),
    chart,
    map.size ? roster.el : null,
  ]);
}

registerSlideType({
  type: "poll",
  category: "interact",
  label: "설문",
  desc: "선택지 중에서 의견 고르기(정답 없음)",
  icon: ICON,
  create() { return { type: "poll", config: defaults() }; },
  thumb(slide) { return quizThumb(slide, ICON, slide.config?.question, "설문"); },
  Editor,
  Student,
  TeacherLive,
  summary,
  validate(slide) {
    const c = cfgOf(slide);
    if (!c.question.trim()) return "질문을 입력하세요";
    if (c.options.length < 2) return "선택지를 2개 이상 만드세요";
    if (c.options.some(o => !o.text.trim())) return "빈 선택지가 있어요";
    return null;
  },
});
