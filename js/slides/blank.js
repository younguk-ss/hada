// 빈칸 채우기(blank) 슬라이드
// 가정: payload = { answers: string[] } (빈칸 순서대로 학생 입력 원문). 채점은 제출 시 학생 측에서 계산.
// 가정: 입력칸 폭 계산 시 한글·전각 문자는 2ch 로 센다(명세의 max(4, 최장 대안+1)ch 를 한글에 맞게).
// 가정: reveal(정답 공개) 중에는 입력을 잠근다. 교사 스테이지는 reveal 전 빈칸 번호만, 후에 정답 표시.
// 가정: 잠기는 순간 제출하지 않은 입력은 제출본으로 되돌린다(공개 채점이 실제 제출과 일치하도록).
// 가정: 교사 스테이지 상단 '문항별 | 학생별'(answer-matrix.js). 문항별 = 빈칸별 정답률(행 클릭 → 답별 학생 명단),
//       학생별 = 학생 × 빈칸 표(행 클릭 → 그 학생 답을 문장 속에 채워 보기). 같은 답 묶음은 normalizeAnswer 기준.
// 가정: 기록 화면(summary)은 교사면 막대 + 표, 학생(자기 응답만 받음)이면 자기 답을 문장 속에 채워 보여 준다.
// 가정(v2.9): 교사 화면은 마감·정답 공개·타이머 끝 전에는 응답 수만(빈칸별 막대·학생별 표·패널의 점수 가림). 문제 그림 config.image.
import { el } from "../ui.js";
import { registerSlideType, injectCss } from "./registry.js";
import { activityBar, choiceBars, normalizeAnswer, whoSheet, resultsOpen, resultsVeil, questionImage, imageField } from "./common.js";
import {
  ensureQuizCss, statusRow, rosterList, rosterIds, byStudent, nameOf,
  isLocked, clockNow, elapsedMs, actOf, seg, field, quizThumb, sessionSig,
} from "./mcq.js";
import { answerMatrix, viewSeg, pickRows, matrixIds, circled } from "./answer-matrix.js";

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9h4M17 9h4M3 15h8"/><rect x="8.5" y="6" width="7" height="6" rx="1.5"/><path d="M14 18h7"/></svg>`;

const CSS = `
.bl-text { font-size: 20px; line-height: 2.3; word-break: keep-all; overflow-wrap: anywhere; margin: 0; }
.bl-input { display: inline-block; vertical-align: baseline; font: inherit; font-size: 19px; color: var(--ink); background: transparent; border: none; border-bottom: 2px solid var(--ink-2); border-radius: 0; padding: 2px 4px; margin: 0 4px; min-height: 44px; text-align: center; max-width: calc(100% - 8px); box-sizing: content-box; outline: none; }
.bl-input:focus { border-bottom-color: var(--accent); background: var(--accent-soft); }
.bl-input:disabled { color: var(--ink); opacity: 1; -webkit-text-fill-color: var(--ink); }
.bl-input.ok { border: 2px solid var(--ok); border-radius: 8px; background: var(--ok-soft); }
.bl-input.bad { border: 2px solid var(--danger); border-radius: 8px; background: var(--danger-soft); }
.bl-ans { background: var(--highlight); border-radius: 6px; padding: 2px 8px; font-weight: 700; margin-right: 4px; }
.bl-slot { display: inline-block; min-width: 3em; border-bottom: 2px solid var(--ink-2); text-align: center; margin: 0 4px; padding: 0 6px; line-height: 1.5; color: var(--muted); font-size: .8em; vertical-align: baseline; }
.bl-slot.shown { color: var(--ink); background: var(--highlight); border-bottom-color: transparent; border-radius: 6px; font-size: 1em; font-weight: 700; }
.qz-live .bl-text { font-size: clamp(22px, 2.8vw, 32px); line-height: 2; }
.bl-wrong { display: grid; gap: 6px; font-size: 14px; color: var(--ink-2); }
.bl-wrong .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; }
.bl-wrong .k { color: var(--muted); font-size: 12px; min-width: 44px; }
.bl-wrong .w { background: var(--danger-soft); color: var(--danger); border-radius: 999px; padding: 1px 10px; }
.bl-preview { padding: 14px 16px; border: 1px dashed var(--line-strong); border-radius: var(--radius-sm); background: var(--surface); }
.bl-preview .bl-text { font-size: 17px; line-height: 2; }
.qz-sum .bl-text { font-size: 16px; line-height: 1.9; }
.qz-live.is-matrix .bl-text { font-size: 18px; line-height: 1.9; }
.bl-wrong .row.pick { cursor: pointer; margin: 0 -6px; padding: 2px 6px; border-radius: 8px; }
@media (hover: hover) { .bl-wrong .row.pick:hover { background: var(--surface-2); } }
.bl-pick { display: inline-block; min-width: 2em; margin: 0 4px; padding: 0 10px; border: 2px solid; border-radius: 8px; line-height: 1.6; font-weight: 600; text-align: center; }
.bl-pick.ok { border-color: var(--ok); background: var(--ok-soft); color: var(--ok); }
.bl-pick.bad { border-color: var(--danger); background: var(--danger-soft); color: var(--danger); }
.bl-detail { display: grid; gap: 10px; justify-items: start; }
.bl-detail .bl-text { font-size: 18px; line-height: 2.2; }
`;

const defaults = () => ({ text: "", caseSensitive: false, image: null });
const cfgOf = (slide) => ({ ...defaults(), ...(slide.config || {}) });
function css(ctx) { ensureQuizCss(ctx); (ctx?.injectCss || injectCss)("blank", CSS); }

// [정답|대안] 파싱 → [{kind:'text', value} | {kind:'blank', idx, answers, display}]
export function parseBlanks(text = "") {
  const parts = [];
  const re = /\[([^\]]+)\]/g;
  let last = 0, m, idx = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ kind: "text", value: text.slice(last, m.index) });
    const answers = m[1].split("|").map(s => s.trim()).filter(Boolean);
    if (answers.length) parts.push({ kind: "blank", idx: idx++, answers, display: answers[0] });
    else parts.push({ kind: "text", value: m[0] });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
  return parts;
}

// 비교용 정규화(common.normalizeAnswer): 전각 숫자→반각, trim, 연속 공백 1개, (대소문자 무시 시) 소문자
const normBlank = (s, caseSensitive = false) => normalizeAnswer(s, { caseSensitive: !!caseSensitive });

const isRight = (b, val, cs) => { const v = normBlank(val, cs); return !!v && b.answers.some(a => normBlank(a, cs) === v); };

export function gradeBlanks(cfg, answers = []) {
  const blanks = parseBlanks(cfg.text).filter(p => p.kind === "blank");
  const n = blanks.length;
  const ok = blanks.filter(b => isRight(b, answers[b.idx], cfg.caseSensitive)).length;
  const score = n ? ok / n : 0;
  return { score, correct: n > 0 && ok === n, ok, n };
}

// 줄바꿈 → <br>
function textNodes(value) {
  const out = [];
  String(value).split("\n").forEach((line, i) => { if (i) out.push(el("br")); if (line) out.push(document.createTextNode(line)); });
  return out;
}

const vlen = (s) => [...String(s)].reduce((n, ch) => n + (/[ᄀ-ᇿ　-鿿가-힯＀-￯]/.test(ch) ? 2 : 1), 0);
const widthOf = (b) => `${Math.max(4, Math.max(...b.answers.map(vlen)) + 1)}ch`;

function Editor({ slide, lesson, update, ctx }) {
  css(ctx);
  let cfg = cfgOf(slide);
  const set = (patch) => { cfg = { ...cfg, ...patch }; update({ config: cfg }); renderPreview(); };
  const img = imageField({ value: cfg.image, lessonId: lesson?.id, slideId: slide.id, onChange: (v) => set({ image: v }) });
  const ta = el("textarea", { class: "input qz-q-input", rows: 5, placeholder: "대한민국의 수도는 [서울]입니다. 대안은 [서울|Seoul]" });
  ta.value = cfg.text;
  ta.addEventListener("input", () => set({ text: ta.value }));
  const preview = el("div", { class: "bl-preview" });
  function renderPreview() {
    const parts = parseBlanks(cfg.text);
    preview.hidden = !cfg.text.trim();
    preview.replaceChildren(el("p", { class: "bl-text" }, parts.flatMap(p => (p.kind === "text"
      ? textNodes(p.value)
      : [el("span", { class: "bl-slot shown", title: p.answers.join(" | ") }, p.display)]))));
  }
  renderPreview();
  const caseSeg = seg([{ value: false, label: "대소문자 무시" }, { value: true, label: "대소문자 구분" }], !!cfg.caseSensitive, (v) => set({ caseSensitive: v }));
  return { el: el("div", { class: "qz-edit" }, [field("", ta), img, preview, field("영문 채점", caseSeg)]) };
}

function Student({ slide, ctx }) {
  css(ctx);
  const cfg = cfgOf(slide);
  const parts = parseBlanks(cfg.text);
  const blanks = parts.filter(p => p.kind === "blank");
  const shownAt = Date.now();
  let st = actOf(ctx);
  let mine = ctx.myResponse?.("") || null;
  let sending = false;

  const status = statusRow({ onExpire: () => paint(), ctx });
  const inputs = [];
  const ansTags = [];
  const textEl = el("p", { class: "bl-text" }, parts.flatMap(p => {
    if (p.kind === "text") return textNodes(p.value);
    const inp = el("input", {
      class: "bl-input", style: { width: widthOf(p) }, autocomplete: "off", autocapitalize: "off", autocorrect: "off",
      spellcheck: "false", enterkeyhint: p.idx === blanks.length - 1 ? "send" : "next", "aria-label": `빈칸 ${p.idx + 1}`,
    });
    inp.addEventListener("input", paint);
    inp.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      const next = inputs[p.idx + 1];
      if (next) next.focus(); else submit();
    });
    const tag = el("span", { class: "bl-ans" }, p.display);
    tag.hidden = true;
    inputs[p.idx] = inp;
    ansTags[p.idx] = tag;
    return [inp, tag];
  }));
  const submitB = el("button", { class: "btn btn-primary btn-lg btn-block qz-submit", type: "button", onClick: submit }, "제출");
  const resultP = el("div", { class: "qz-status" });

  const root = el("div", { class: "qz-stu" }, [status.el, questionImage(cfg.image), textEl, submitB, resultP]);

  const saved = () => mine?.payload?.answers || [];
  const values = () => inputs.map(i => i.value);
  const fill = () => { const a = saved(); inputs.forEach((inp, i) => { inp.value = a[i] || ""; }); };
  const dirty = () => { const a = saved(); return inputs.some((inp, i) => inp.value.trim() !== String(a[i] || "").trim()); };
  const locked = () => isLocked(st, clockNow(ctx)) || !!st.reveal;
  fill();

  async function submit() {
    if (locked() || sending || !dirty() || !values().some(v => v.trim())) return;
    const answers = values().map(v => v.trim());
    const g = gradeBlanks(cfg, answers);
    sending = true; paint();
    try {
      mine = await ctx.submit({ answers }, { score: g.score, correct: g.correct, timeMs: elapsedMs(ctx, st, shownAt) });
    } catch (e) { /* ctx.submit 이 toast 처리 */ }
    sending = false;
    paint();
  }

  function paint() {
    const lock = locked();
    if (lock && !sending && dirty()) fill();
    const reveal = !!st.reveal;
    const isDirty = dirty();
    status.set({ state: st, submitted: !!mine && !isDirty });
    blanks.forEach(b => {
      const inp = inputs[b.idx];
      inp.disabled = lock;
      const right = isRight(b, inp.value, cfg.caseSensitive);
      inp.classList.toggle("ok", reveal && right);
      inp.classList.toggle("bad", reveal && !right);
      ansTags[b.idx].hidden = !(reveal && !right);
    });
    submitB.hidden = lock;
    submitB.disabled = lock || sending || !isDirty || !values().some(v => v.trim());
    submitB.textContent = sending ? "제출 중…" : (mine && !isDirty ? "제출함" : (mine ? "다시 제출" : "제출"));
    if (reveal && blanks.length) {
      const g = gradeBlanks(cfg, values());
      resultP.replaceChildren(el("span", { class: `pill ${g.correct ? "pill-ok" : "pill-warn"}` }, `${g.ok}/${g.n}`));
    } else resultP.replaceChildren();
  }
  paint();

  return {
    el: root,
    onActivity(s) { st = actOf(ctx, s); paint(); },
    onResponses() {
      const wasDirty = dirty();
      mine = ctx.myResponse?.("") || null;
      if (!wasDirty && !inputs.includes(document.activeElement)) fill();
      paint();
    },
    destroy() { status.destroy(); },
  };
}

// 빈칸별 정답 수·자주 틀린 답 상위 3
function blankStats(cfg, blanks, map) {
  const rs = [...map.values()];
  return blanks.map(b => {
    let ok = 0;
    const wrong = new Map();
    for (const r of rs) {
      const raw = r.payload?.answers?.[b.idx] ?? "";
      if (isRight(b, raw, cfg.caseSensitive)) { ok++; continue; }
      const k = normBlank(raw, cfg.caseSensitive);
      if (!k) continue;
      const w = wrong.get(k) || { text: String(raw).trim(), n: 0 };
      w.n++;
      wrong.set(k, w);
    }
    const top = [...wrong.values()].sort((a, c) => c.n - a.n).slice(0, 3);
    return { b, ok, total: rs.length, top };
  });
}

// 빈칸별 정답률 막대(common.choiceBars: count=맞은 수, total=응답 수) + 오답 상위 3
// onPick(빈칸 idx) 이 있으면 막대·오답 줄을 눌러 답별 학생 명단을 연다
function statsView({ onPick = null } = {}) {
  const bars = choiceBars([], 0, { revealed: true });
  const syncPick = onPick ? pickRows(bars, onPick) : null;
  const wrongBox = el("div", { class: "bl-wrong" });
  let wSig = null;
  return {
    el: el("div", { style: { display: "grid", gap: "14px" } }, [bars, wrongBox]),
    set(stats, reveal) {
      const total = stats[0]?.total || 0;
      bars.update(stats.map(s => ({
        label: reveal ? `${circled(s.b.idx)} ${s.b.display}` : circled(s.b.idx),
        count: s.ok,
        highlight: true,
      })), total, { revealed: true });
      syncPick?.();
      const next = JSON.stringify(stats.map(s => s.top.map(w => [w.text, w.n])));
      if (next === wSig) return;
      wSig = next;
      wrongBox.replaceChildren(...stats.filter(s => s.top.length).map(s => el("div", {
        class: onPick ? "row pick" : "row", onClick: onPick ? () => onPick(s.b.idx) : null,
      }, [
        el("span", { class: "k" }, circled(s.b.idx)),
        ...s.top.map(w => el("span", { class: "w" }, `${w.text} ${w.n}`)),
      ])));
    },
  };
}

// 빈칸 하나의 답별 학생 명단(정답 → 오답 많은 순 → 미입력 → 미응답)
// 가정: 정답 묶음은 대안(서울|Seoul)을 모두 합치고, 표시 정답과 다르게 쓴 학생은 이름 옆에 쓴 그대로 보인다.
function openWho(ctx, cfg, b, map, ids) {
  if (!b) return;
  const cs = cfg.caseSensitive;
  const right = { label: b.display, color: "var(--ok)", correct: true, studentIds: [], extra: {} };
  const wrong = new Map();
  const blankG = { label: "미입력", studentIds: [] };
  for (const [id, r] of map) {
    const raw = String(r.payload?.answers?.[b.idx] ?? "").trim();
    if (isRight(b, raw, cs)) {
      right.studentIds.push(id);
      if (normBlank(raw, cs) !== normBlank(b.display, cs)) right.extra[id] = raw;
      continue;
    }
    const k = normBlank(raw, cs);
    if (!k) { blankG.studentIds.push(id); continue; }
    let g = wrong.get(k);
    if (!g) wrong.set(k, g = { label: raw, color: "var(--danger)", studentIds: [] });
    g.studentIds.push(id);
  }
  const none = { label: "미응답", studentIds: ids.filter(id => !map.has(id)) };
  const rest = [...wrong.values()].sort((a, c) => c.studentIds.length - a.studentIds.length);
  whoSheet(ctx, { title: `빈칸 ${circled(b.idx)}`, groups: [right, ...[...rest, blankG, none].filter(g => g.studentIds.length)] });
}

// 학생별 표의 한 행: 맞으면 ✓, 틀리면 ✗ + 쓴 답
function rowOf(cfg, blanks, r) {
  if (!r) return null;
  const a = r.payload?.answers || [];
  const cells = {};
  let ok = 0;
  for (const b of blanks) {
    const raw = String(a[b.idx] ?? "").trim();
    const right = isRight(b, raw, cfg.caseSensitive);
    if (right) ok++;
    cells[String(b.idx)] = { ok: right, text: right ? "" : raw, hint: raw };
  }
  return { cells, score: ok, total: blanks.length };
}
const matrixCols = (blanks, reveal) => blanks.map(b => ({ key: String(b.idx), label: circled(b.idx), sub: reveal ? b.display : "", title: `빈칸 ${b.idx + 1}` }));

// 학생 답을 문장 속에 채워 보기: 맞음 ok · 틀림 danger + 정답 하이라이트
function filledText(cfg, parts, answers = []) {
  return el("p", { class: "bl-text" }, parts.flatMap(p => {
    if (p.kind === "text") return textNodes(p.value);
    const raw = String(answers[p.idx] ?? "").trim();
    const ok = isRight(p, raw, cfg.caseSensitive);
    const pick = el("span", { class: `bl-pick ${ok ? "ok" : "bad"}` }, raw || "　");
    return ok ? [pick] : [pick, el("span", { class: "bl-ans" }, p.display)];
  }));
}
function detailOf(cfg, parts, r) {
  const answers = r?.payload?.answers || [];
  const g = gradeBlanks(cfg, answers);
  return el("div", { class: "bl-detail" }, [
    el("span", { class: `pill ${g.correct ? "pill-ok" : "pill-warn"}` }, `${g.ok}/${g.n}`),
    filledText(cfg, parts, answers),
  ]);
}

function TeacherLive({ slide, ctx }) {
  css(ctx);
  const cfg = cfgOf(slide);
  const parts = parseBlanks(cfg.text);
  const blanks = parts.filter(p => p.kind === "blank");
  let st = actOf(ctx);
  let map = new Map(), ids = [];

  const status = statusRow({ ctx });
  const countP = el("span", { class: "pill" });
  const slots = [];
  const textEl = el("p", { class: "bl-text" }, parts.flatMap(p => {
    if (p.kind === "text") return textNodes(p.value);
    const s = el("span", { class: "bl-slot" });
    slots[p.idx] = s;
    return [s];
  }));
  const stats = statsView({ onPick: (i) => openWho(ctx, cfg, blanks[i], map, ids) });
  const matrix = answerMatrix(ctx, {
    memoKey: slide.id,
    columns: () => matrixCols(blanks, !!st.reveal),
    ids: () => ids,
    rowFor: (id) => rowOf(cfg, blanks, map.get(id)),
    detail: (id) => detailOf(cfg, parts, map.get(id)),
  });
  const view = viewSeg(slide.id, () => paint());
  const box = el("div", { class: "am-box" }, [stats.el, matrix]);
  const veil = resultsVeil();
  const root = el("div", { class: "qz-live" }, [
    el("div", { class: "qz-live-head" }, [view, el("span", { style: { flex: "1" } }), status.el, countP]),
    questionImage(cfg.image), textEl, veil, box,
  ]);

  const bar = activityBar(ctx, { reveal: true, timer: true });
  const roster = rosterList();
  const panel = el("div", { class: "qz-panel" }, [bar, roster.el]);

  let sSig = sessionSig(ctx);
  function paint() {
    const list = ctx.responses() || [];
    map = byStudent(list);
    ids = matrixIds(ctx, list);
    const reveal = !!st.reveal;
    const open = resultsOpen(st, clockNow(ctx)); // 마감 전에는 결과를 가린다(v2.9)
    const byStu = open && view.value() === "student";
    status.set({ state: st });
    countP.textContent = `응답 ${map.size}`;
    veil.hidden = open;
    veil.set(map.size, (ctx.participants() || []).length);
    view.hidden = !open;
    box.hidden = !open;
    blanks.forEach(b => {
      const s = slots[b.idx];
      s.textContent = reveal ? b.display : circled(b.idx);
      s.classList.toggle("shown", reveal);
    });
    root.classList.toggle("is-matrix", byStu);
    box.classList.toggle("is-matrix", byStu);
    stats.el.hidden = byStu;
    matrix.hidden = !byStu;
    if (!open) { /* 가림: 갱신 생략 */ }
    else if (byStu) matrix.update(); // 보이는 쪽만 갱신(전환 시 다시 그림)
    else stats.set(blankStats(cfg, blanks, map), reveal);
    roster.set(rosterIds(ctx, list).map(id => {
      const r = map.get(id);
      if (!r) return { id, name: nameOf(ctx, id), value: "—", cls: "none" };
      if (!open) return { id, name: nameOf(ctx, id), value: "제출", cls: "" };
      const g = gradeBlanks(cfg, r.payload?.answers || []);
      return { id, name: nameOf(ctx, id), value: `${g.ok}/${g.n}`, cls: g.correct ? "ok" : "bad" };
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
  const parts = parseBlanks(cfg.text);
  const blanks = parts.filter(p => p.kind === "blank");
  const map = byStudent(responses);
  const shownText = () => el("p", { class: "bl-text" }, parts.flatMap(p => (p.kind === "text"
    ? textNodes(p.value) : [el("span", { class: "bl-slot shown" }, p.display)])));
  // 학생 기록: 자기 답을 문장 속에 채워 보여 준다
  if (ctx?.role === "student") {
    const r = map.get(ctx.me?.id) || [...map.values()][0] || null;
    return el("div", { class: "qz-sum" }, r
      ? [detailOf(cfg, parts, r)]
      : [shownText(), el("div", { class: "muted" }, "제출하지 않았어요")]);
  }
  const ids = matrixIds(ctx, responses);
  const canOpen = typeof ctx?.modal === "function";
  const stats = statsView({ onPick: canOpen ? (i) => openWho(ctx, cfg, blanks[i], map, ids) : null });
  stats.set(blankStats(cfg, blanks, map), true);
  const graded = [...map.values()].map(r => gradeBlanks(cfg, r.payload?.answers || []));
  const avg = graded.length ? Math.round((graded.reduce((n, g) => n + g.score, 0) / graded.length) * 100) : null;
  let matrix = null;
  if (map.size) {
    matrix = answerMatrix(ctx, {
      memoKey: `sum|${slide.id}`,
      columns: matrixCols(blanks, true),
      ids: () => ids,
      rowFor: (id) => rowOf(cfg, blanks, map.get(id)),
      detail: canOpen ? (id) => detailOf(cfg, parts, map.get(id)) : null,
    });
    matrix.update();
  }
  return el("div", { class: "qz-sum" }, [
    questionImage(cfg.image, { small: true }),
    shownText(),
    el("div", { class: "qz-sum-meta" }, [
      el("span", { class: "pill pill-muted" }, `응답 ${map.size}`),
      avg !== null ? el("span", { class: "pill pill-ok" }, `평균 ${avg}%`) : null,
    ]),
    map.size ? stats.el : null,
    matrix,
  ]);
}

function thumbText(slide) {
  return parseBlanks(slide.config?.text || "").map(p => (p.kind === "text" ? p.value : "___")).join("").replace(/\s+/g, " ");
}

registerSlideType({
  type: "blank",
  category: "interact",
  label: "빈칸 채우기",
  desc: "문장 속 빈칸에 답 쓰기",
  icon: ICON,
  create() { return { type: "blank", config: defaults() }; },
  thumb(slide) { return quizThumb(slide, ICON, thumbText(slide), "빈칸 채우기"); },
  Editor,
  Student,
  TeacherLive,
  summary,
  validate(slide) {
    return parseBlanks(cfgOf(slide).text).some(p => p.kind === "blank") ? null : "[정답]처럼 대괄호로 빈칸을 만드세요";
  },
});
