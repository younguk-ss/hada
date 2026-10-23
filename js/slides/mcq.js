// 객관식(mcq) 슬라이드 + 응답형(mcq/short/blank) 공용 작은 헬퍼(export).
// 가정: reveal(정답 공개) 중에는 학생 입력을 잠근다(정답을 본 뒤 고치지 못하게). 마감(ended)도 잠금.
// 가정: answerIds 가 비어 있으면 설문처럼 채점하지 않는다(score/correct = null).
// 가정: config.timerSec 는 편집기에서 다루지 않는다(수업 중 activityBar 타이머 프리셋 사용). 값은 보존만.
// 가정: 타이머 만료 → phase 'ended' 전환은 common.activityBar 가 담당. 학생은 endsAt 에 로컬로도 잠근다.
// 가정: 잠기는 순간 제출하지 않은 변경은 버리고 제출본을 보여 준다(정답 공개 ✓/✗ 가 실제 제출과 일치하도록).
// 가정: endsAt·startedAt 은 교사 시계 기준. 코어가 ctx.now()(학생 기기의 교사 시계 추정)를 주면 그것으로 비교하고,
//       없으면 Date.now()(보정 없음). common.countdownPill/phasePill 은 Date.now() 를 쓰므로 toLocalTime 으로 바꿔 넘긴다.
import { el } from "../ui.js";
import { findStudent } from "../store.js";
import { registerSlideType, newId, injectCss } from "./registry.js";
import { activityBar, choiceBars, phasePill, questionEditor, optionLetter } from "./common.js";

// ── 공용 헬퍼 (short.js, blank.js 도 사용) ──

// 교사 시계 기준 현재 시각(ms). ctx.now() 가 없거나 이상하면 Date.now()
export function clockNow(ctx) {
  try {
    const t = typeof ctx?.now === "function" ? Number(ctx.now()) : NaN;
    if (Number.isFinite(t)) return t;
  } catch { /* 무시 */ }
  return Date.now();
}

// 교사 시계 시각 → 이 기기 시계 시각(Date.now() 기준 UI 에 넘길 때). 100ms 단위로 반올림해 pill 재생성 깜빡임 방지
export function toLocalTime(ctx, t) {
  if (!t) return t;
  const skew = Math.round((clockNow(ctx) - Date.now()) / 100) * 100;
  return t - skew;
}

// 마감 여부: ended 이거나 타이머가 끝남. now = 교사 시계 기준 현재(clockNow(ctx))
export function isLocked(st, now = Date.now()) {
  if (!st) return false;
  if (st.phase === "ended") return true;
  return st.phase === "running" && !!st.endsAt && now >= st.endsAt;
}

// 활동 기준 경과 시간(응답 timeMs): startedAt(교사 시계)이 있으면 그 기준, 없으면 화면에 보인 시각 기준
export function elapsedMs(ctx, st, shownAt) {
  const ms = st?.startedAt ? clockNow(ctx) - st.startedAt : Date.now() - shownAt;
  return Math.max(0, Math.round(ms));
}

export function actOf(ctx, st) {
  return st || ctx.activity?.() || { phase: "idle" };
}

function studentOf(ctx, id) {
  let s = null;
  try { s = ctx?.students?.()?.get?.(id) || null; } catch { s = null; }
  if (!s) { try { s = findStudent(id); } catch { s = null; } }
  return s;
}

export function nameOf(ctx, id) {
  return studentOf(ctx, id)?.name || "학생";
}

// id 목록 학번순 정렬
export function sortIds(ctx, ids) {
  const key = (id) => { const s = studentOf(ctx, id); return s ? [+s.grade || 0, +s.classNum || 0, +s.num || 0, s.name || ""] : [99, 99, 999, id]; };
  return [...new Set(ids)].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < 4; i++) { if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; }
    return 0;
  });
}

// 참여자 + 응답자 id 목록(학번순)
export function rosterIds(ctx, responses = []) {
  return sortIds(ctx, [...(ctx?.participants?.() || []), ...responses.map(r => r.studentId)]);
}

// onSession 은 자주 불린다 → 참여자·학생 정보가 바뀐 때만 다시 그리도록 비교용 키
export function sessionSig(ctx) {
  let n = 0;
  try { n = ctx?.students?.()?.size || 0; } catch { n = 0; }
  return `${(ctx?.participants?.() || []).join(",")}|${n}`;
}

// 학생별 최신 응답 (itemKey '')
export function byStudent(list = []) {
  const m = new Map();
  for (const r of list) {
    if ((r.itemKey || "") !== "") continue;
    const prev = m.get(r.studentId);
    if (!prev || (r.updatedAt || 0) >= (prev.updatedAt || 0)) m.set(r.studentId, r);
  }
  return m;
}

// 상태 pill 줄: common.phasePill(마감/카운트다운) + '제출함'. endsAt 도달 시 onExpire 1회(로컬 잠금용).
export function statusRow({ onExpire, ctx = null } = {}) {
  const phase = phasePill({ phase: "idle" });
  const subP = el("span", { class: "pill pill-ok" }, "제출함");
  const root = el("div", { class: "qz-status" }, [phase, subP]);
  let st = { phase: "idle" }, submitted = false, tm = null, tmFor = null;

  function paint() {
    const now = clockNow(ctx);
    const locked = isLocked(st, now);
    phase.update(locked ? { ...st, phase: "ended" } : (st.endsAt ? { ...st, endsAt: toLocalTime(ctx, st.endsAt) } : st));
    subP.hidden = !submitted;
    const want = st.phase === "running" && st.endsAt && !locked ? st.endsAt : null;
    if (want !== tmFor) {
      if (tm) clearTimeout(tm);
      tm = null; tmFor = want;
      if (want) tm = setTimeout(() => { tm = null; paint(); try { onExpire?.(); } catch (e) { console.warn(e); } }, Math.max(0, want - clockNow(ctx)) + 30);
    }
  }
  paint();
  return {
    el: root,
    set(next = {}) {
      if (next.state) st = next.state;
      if (next.submitted !== undefined) submitted = !!next.submitted;
      paint();
    },
    destroy() { if (tm) clearTimeout(tm); tm = null; phase.destroy?.(); },
  };
}

// 학생별 상태 목록(패널) rows: [{ id, name, value, cls }]
export function rosterList() {
  const root = el("div", { class: "qz-roster" });
  let sig = null;
  return {
    el: root,
    set(list) {
      const next = JSON.stringify(list.map(r => [r.name, r.value, r.cls || ""]));
      if (next === sig) return; // 같으면 DOM 유지
      sig = next;
      if (!list.length) { root.replaceChildren(el("div", { class: "empty" }, "아직 아무도 없어요")); return; }
      root.replaceChildren(...list.map(r => el("div", { class: "qz-roster-row" }, [
        el("span", { class: "n" }, r.name),
        el("span", { class: `v ${r.cls || ""}` }, r.value),
      ])));
    },
  };
}

export function seg(options, value, onPick) {
  const root = el("div", { class: "seg" });
  const paint = (v) => [...root.children].forEach((b, i) => b.classList.toggle("active", options[i].value === v));
  options.forEach(o => root.appendChild(el("button", { type: "button", onClick: () => { paint(o.value); onPick(o.value); } }, o.label)));
  paint(value);
  return root;
}

export function field(label, control) {
  return el("div", { class: "field" }, [label ? el("label", {}, label) : null, control]);
}

export function quizThumb(slide, icon, text, fallback) {
  return el("div", { class: "thumb-generic qz-thumb" }, [
    el("span", { class: "thumb-icon", html: icon }),
    el("span", { class: "thumb-title" }, (text || "").trim() || slide.title || fallback),
  ]);
}

export function ensureQuizCss(ctx) {
  (ctx?.injectCss || injectCss)("quiz", QUIZ_CSS);
}

const QUIZ_CSS = `
.qz-stu { height: 100%; overflow: auto; display: flex; flex-direction: column; gap: 16px; padding: 20px 16px calc(24px + env(safe-area-inset-bottom)); max-width: 760px; margin: 0 auto; width: 100%; box-sizing: border-box; }
.qz-status { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.qz-q { font-size: 22px; font-weight: 700; line-height: 1.45; margin: 0; white-space: pre-wrap; word-break: keep-all; overflow-wrap: anywhere; }
.qz-choices { display: grid; gap: 10px; }
.qz-stu .choice { min-height: 56px; width: 100%; text-align: left; display: flex; align-items: center; gap: 12px; font-size: 17px; padding: 10px 14px; cursor: pointer; }
.qz-stu .choice:disabled { cursor: default; }
.qz-stu .choice.correct { background: var(--highlight); }
.qz-mark { margin-left: auto; font-weight: 800; font-size: 20px; }
.choice.correct .qz-mark { color: var(--ok); }
.choice.wrong .qz-mark { color: var(--danger); }
.qz-submit { min-height: 52px; font-size: 17px; }
.qz-live { height: 100%; overflow: auto; padding: 28px 36px; display: flex; flex-direction: column; gap: 20px; box-sizing: border-box; }
.qz-live .qz-q { font-size: clamp(22px, 3vw, 34px); }
.qz-live-head { display: flex; gap: 8px; align-items: center; justify-content: flex-end; min-height: 24px; }
.qz-live .bars { gap: 12px; }
.qz-live .bar-row { font-size: 17px; }
.qz-live .bar-track { height: 26px; border-radius: 8px; }
.qz-bar-label { display: inline-flex; gap: 10px; align-items: center; max-width: 100%; vertical-align: middle; }
.qz-bar-label .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qz-key { width: 28px; height: 28px; border-radius: 50%; border: 1.5px solid var(--line-strong); display: inline-grid; place-items: center; font-weight: 700; font-size: 13px; flex: none; background: var(--surface); color: var(--ink-2); }
.qz-key.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.qz-panel { display: grid; gap: 14px; }
.qz-roster { display: grid; }
.qz-roster-row { display: flex; justify-content: space-between; gap: 8px; padding: 8px 2px; border-bottom: 1px solid var(--line); font-size: 14px; }
.qz-roster-row .n { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qz-roster-row .v { color: var(--ink-2); flex: none; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qz-roster-row .v.ok { color: var(--ok); }
.qz-roster-row .v.bad { color: var(--danger); }
.qz-roster-row .v.none { color: var(--muted); }
.qz-edit { padding: 24px; display: grid; gap: 14px; max-width: 760px; margin: 0 auto; width: 100%; box-sizing: border-box; overflow: auto; height: 100%; align-content: start; }
.qz-edit .qz-q-input, .qz-edit .q-editor textarea { font-size: 19px; font-weight: 600; min-height: 84px; resize: vertical; }
.qz-sum { display: grid; gap: 12px; }
.qz-sum .qz-q { font-size: 17px; }
.qz-sum-meta { display: flex; gap: 6px; flex-wrap: wrap; }
`;

// ── mcq ──

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="5" cy="18" r="2"/><path d="M10 6h10M10 12h10M10 18h10"/></svg>`;

const defaults = () => ({
  question: "",
  options: Array.from({ length: 4 }, () => ({ id: newId("opt"), text: "" })),
  answerIds: [],
  multiple: false,
  timerSec: null,
});

function cfgOf(slide) {
  const c = { ...defaults(), ...(slide.config || {}) };
  c.options = (c.options || []).map(o => ({ id: o.id || newId("opt"), text: o.text || "" }));
  c.answerIds = (c.answerIds || []).filter(id => c.options.some(o => o.id === id));
  return c;
}

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

function grade(cfg, picked) {
  if (!cfg.answerIds.length) return { score: null, correct: null };
  const ok = sameSet(picked, cfg.answerIds);
  return { score: ok ? 1 : 0, correct: ok };
}

// 막대 행: 옵션별 선택 학생 수
function barRows(cfg, map, { keyOn = false } = {}) {
  const rs = [...map.values()];
  return cfg.options.map((o, i) => ({
    label: el("span", { class: "qz-bar-label" }, [
      el("span", { class: `qz-key${keyOn && cfg.answerIds.includes(o.id) ? " on" : ""}` }, optionLetter(i)),
      el("span", { class: "t" }, o.text),
    ]),
    count: rs.filter(r => (r.payload?.answerIds || []).includes(o.id)).length,
    highlight: cfg.answerIds.includes(o.id),
  }));
}

// 정답 막대 강조: common 의 .is-accent 는 :where()(특이도 0)라 styles.css .bar-fill 에 진다
// → styles.css 가 아는 .bar-row.correct 를 직접 토글(reveal 전 회색, 후 정답 --accent)
function markCorrect(bars, cfg, on) {
  [...bars.children].forEach((row, i) => row.classList.toggle("correct", !!on && cfg.answerIds.includes(cfg.options[i]?.id)));
  return bars;
}

function rosterRow(ctx, cfg, id, r) {
  if (!r) return { id, name: nameOf(ctx, id), value: "—", cls: "none" };
  const picks = cfg.options.map((o, i) => ((r.payload?.answerIds || []).includes(o.id) ? optionLetter(i) : "")).join("");
  const mark = r.correct === true ? " ✓" : r.correct === false ? " ✗" : "";
  return { id, name: nameOf(ctx, id), value: (picks || "?") + mark, cls: r.correct === true ? "ok" : r.correct === false ? "bad" : "" };
}

function Editor({ slide, update, ctx }) {
  ensureQuizCss(ctx);
  let cfg = cfgOf(slide);
  const set = (patch) => { cfg = { ...cfg, ...patch }; update({ config: cfg }); };

  // 단일/복수 전환 시 라디오↔체크박스가 바뀌므로 편집기를 다시 만든다
  const box = el("div");
  function renderQ() {
    box.replaceChildren(questionEditor({
      question: cfg.question, options: cfg.options, answerIds: cfg.answerIds, multiple: !!cfg.multiple,
      placeholder: "질문을 입력하세요",
      onChange: ({ question, options, answerIds }) => set({ question, options, answerIds }),
    }));
  }
  renderQ();

  const multiSeg = seg([{ value: false, label: "정답 하나" }, { value: true, label: "정답 여러 개" }], !!cfg.multiple, (v) => {
    set({ multiple: v, answerIds: v ? cfg.answerIds : cfg.answerIds.slice(0, 1) });
    renderQ();
  });

  return { el: el("div", { class: "qz-edit" }, [box, field("", multiSeg)]) };
}

function Student({ slide, ctx }) {
  ensureQuizCss(ctx);
  const cfg = cfgOf(slide);
  const shownAt = Date.now();
  let st = actOf(ctx);
  let mine = ctx.myResponse?.("") || null;
  let sel = new Set(mine?.payload?.answerIds || []);
  let dirty = false, sending = false;

  const status = statusRow({ onExpire: () => paint(), ctx });
  if (cfg.multiple) status.el.appendChild(el("span", { class: "pill pill-muted" }, "여러 개 선택"));
  const btns = cfg.options.map((o, i) => {
    const mark = el("span", { class: "qz-mark" });
    const b = el("button", { class: "choice", type: "button", onClick: () => pick(o.id) }, [
      el("span", { class: "choice-key" }, optionLetter(i)),
      el("span", { class: "choice-text" }, o.text || " "),
      mark,
    ]);
    return { b, mark, id: o.id };
  });
  const submitB = el("button", { class: "btn btn-primary btn-lg btn-block qz-submit", type: "button", onClick: submit }, "제출");

  const root = el("div", { class: "qz-stu" }, [
    status.el,
    el("h2", { class: "qz-q" }, cfg.question || slide.title || ""),
    el("div", { class: "qz-choices" }, btns.map(x => x.b)),
    submitB,
  ]);

  const locked = () => isLocked(st, clockNow(ctx)) || !!st.reveal;

  function pick(id) {
    if (locked() || sending) return;
    if (cfg.multiple) { if (sel.has(id)) sel.delete(id); else sel.add(id); }
    else sel = new Set([id]);
    const saved = mine?.payload?.answerIds || [];
    dirty = !sameSet([...sel], saved);
    paint();
  }

  async function submit() {
    if (locked() || sending || !sel.size) return;
    const picked = cfg.options.map(o => o.id).filter(id => sel.has(id));
    sending = true; paint();
    try {
      mine = await ctx.submit({ answerIds: picked }, { ...grade(cfg, picked), timeMs: elapsedMs(ctx, st, shownAt) });
      dirty = false;
    } catch (e) { /* ctx.submit 이 toast 처리 */ }
    sending = false;
    paint();
  }

  function paint() {
    const lock = locked();
    if (lock && dirty && !sending) { sel = new Set(mine?.payload?.answerIds || []); dirty = false; }
    const reveal = !!st.reveal;
    const graded = cfg.answerIds.length > 0;
    status.set({ state: st, submitted: !!mine && !dirty });
    for (const x of btns) {
      const picked = sel.has(x.id);
      const isAns = cfg.answerIds.includes(x.id);
      x.b.disabled = lock;
      x.b.classList.toggle("selected", picked);
      x.b.classList.toggle("correct", reveal && isAns);
      x.b.classList.toggle("wrong", reveal && graded && picked && !isAns);
      x.mark.textContent = reveal && graded && picked ? (isAns ? "✓" : "✗") : "";
    }
    submitB.hidden = lock;
    submitB.disabled = sending || !sel.size || (!!mine && !dirty);
    submitB.textContent = sending ? "제출 중…" : (mine && !dirty ? "제출함" : (mine ? "다시 제출" : "제출"));
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
  ensureQuizCss(ctx);
  const cfg = cfgOf(slide);
  let st = actOf(ctx);

  const status = statusRow({ ctx });
  const countP = el("span", { class: "pill" });
  const bars = choiceBars([], 0, { revealed: false });
  const root = el("div", { class: "qz-live" }, [
    el("div", { class: "qz-live-head" }, [status.el, countP]),
    el("h2", { class: "qz-q" }, cfg.question || slide.title || ""),
    bars,
  ]);

  const bar = activityBar(ctx, { reveal: true, timer: true });
  const roster = rosterList();
  const panel = el("div", { class: "qz-panel" }, [bar, roster.el]);

  let sSig = sessionSig(ctx);
  function paint() {
    const list = ctx.responses() || [];
    const map = byStudent(list);
    status.set({ state: st });
    countP.textContent = `응답 ${map.size}`;
    bars.update(barRows(cfg, map), map.size, { revealed: !!st.reveal });
    markCorrect(bars, cfg, st.reveal);
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
  ensureQuizCss(ctx);
  const cfg = cfgOf(slide);
  const map = byStudent(responses);
  const graded = [...map.values()].filter(r => typeof r.correct === "boolean");
  const okN = graded.filter(r => r.correct).length;
  const roster = rosterList();
  roster.set(sortIds(ctx, [...map.keys()]).map(id => rosterRow(ctx, cfg, id, map.get(id))));
  return el("div", { class: "qz-sum" }, [
    el("div", { class: "qz-q" }, cfg.question || slide.title || ""),
    el("div", { class: "qz-sum-meta" }, [
      el("span", { class: "pill pill-muted" }, `응답 ${map.size}`),
      graded.length ? el("span", { class: "pill pill-ok" }, `정답률 ${Math.round((okN / graded.length) * 100)}%`) : null,
    ]),
    markCorrect(choiceBars(barRows(cfg, map, { keyOn: true }), map.size, { revealed: true }), cfg, true),
    map.size ? roster.el : null,
  ]);
}

registerSlideType({
  type: "mcq",
  category: "interact",
  label: "객관식",
  desc: "선택지 중에서 고르기",
  icon: ICON,
  create() { return { type: "mcq", config: defaults() }; },
  thumb(slide) { return quizThumb(slide, ICON, slide.config?.question, "객관식"); },
  Editor,
  Student,
  TeacherLive,
  summary,
  validate(slide) {
    const c = cfgOf(slide);
    if (!c.question.trim()) return "질문을 입력하세요";
    if (c.options.length < 2) return "선택지를 2개 이상 만드세요";
    if (c.options.some(o => !o.text.trim())) return "빈 선택지가 있어요";
    if (!c.answerIds.length) return "정답을 선택하세요";
    return null;
  },
});
