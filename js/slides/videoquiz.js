// 동영상 퀴즈(videoquiz) 슬라이드 (§6.4)
// questions [{ id, atSec, kind:'mcq'|'short'|'essay', question, options?, answerIds? }] — atSec 오름차순
// 가정: 학생 화면은 250ms 폴링으로 '미응답 & atSec <= 현재 시각' 중 가장 이른 문제를 띄운다(영상이 한 번이라도 재생된 뒤부터).
// 가정: 마감(phase 'ended')이면 새 문제를 띄우지 않고 열린 문제도 닫는다(영상은 계속 볼 수 있음).
// 가정: mcq 는 제출 후 0.9초 정오 표시 뒤 닫고 재생. 정답이 비어 있으면 채점하지 않음(correct/score null).
// 가정: 정답이 2개 이상인 mcq 만 여러 개 선택(편집기는 단일 정답).
// 가정: 교사 스테이지는 같은 플레이어(문제로 멈추지 않음), panel = activityBar(마감·초기화) + 문제별 결과.
import { el } from "../ui.js";
import * as storeMod from "../store.js";
import { registerSlideType, newId, injectCss } from "./registry.js";
import { activityBar, choiceBars, questionEditor, optionLetter } from "./common.js";
import { createPlayer, createPreview, videoSource, videoThumb, ensureMediaCss, fmtSec, parseSec, VIDEO_UNSUPPORTED } from "./video.js";

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2.5"/><path d="M10 7.6v4.8l4-2.4z"/><path d="M7 20h10"/><circle cx="12" cy="20" r="1.2"/></svg>`;

const KINDS = [
  { value: "mcq", label: "객관식" },
  { value: "short", label: "단답" },
  { value: "essay", label: "서술" },
];
const kindLabel = (k) => KINDS.find(x => x.value === k)?.label || "객관식";

const CSS = `
.vq-stu{position:relative;height:100%;min-height:0;display:flex;flex-direction:column}
.vq-stu > .md-stage{flex:1 1 auto;height:auto;min-height:200px}
.vq-bar{display:flex;gap:6px;justify-content:center;align-items:center;padding:0 12px calc(10px + env(safe-area-inset-bottom));min-height:24px}
.vq-bar .pill[hidden]{display:none}
.vq-layer{position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:rgba(20,20,30,.45);overflow:auto}
.vq-layer[hidden]{display:none}
.vq-pop{background:var(--surface);border-radius:var(--radius-lg);box-shadow:var(--shadow-2);padding:20px;width:min(560px,100%);max-height:100%;overflow:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:12px}
.vq-pop-head{display:flex;gap:6px;align-items:center}
.vq-q{margin:0;font-size:20px;font-weight:700;line-height:1.45;white-space:pre-wrap;word-break:keep-all;overflow-wrap:anywhere}
.vq-choices{display:grid;gap:10px}
.vq-pop .choice{min-height:56px;width:100%;text-align:left;display:flex;align-items:center;gap:12px;font-size:17px;padding:10px 14px;cursor:pointer}
.vq-pop .choice:disabled{cursor:default}
.vq-pop .choice.correct{background:var(--highlight)}
.vq-mark{margin-left:auto;font-weight:800;font-size:20px}
.choice.correct .vq-mark{color:var(--ok)}
.choice.wrong .vq-mark{color:var(--danger)}
.vq-pop textarea{min-height:120px;resize:vertical}
.vq-count{font-size:12px;color:var(--muted);text-align:right}
.vq-feedback{font-weight:700;text-align:center}
.vq-feedback.ok{color:var(--ok)}
.vq-feedback.bad{color:var(--danger)}
.vq-feedback:empty{display:none}
.vq-panel{display:grid;gap:14px}
.vq-results{display:grid;gap:18px}
.vq-r{display:grid;gap:8px;padding-bottom:14px;border-bottom:1px solid var(--line)}
.vq-r:last-child{border-bottom:0}
.vq-r-head{display:flex;gap:6px;align-items:center}
.vq-r-kind{font-size:12px;color:var(--muted)}
.vq-r-sp{flex:1}
.vq-r-q{font-weight:600;white-space:pre-wrap;overflow-wrap:anywhere}
.vq-cards{display:grid;gap:8px}
.vq-card{padding:10px 12px;display:grid;gap:4px}
.vq-card-name{font-size:12px;color:var(--muted)}
.vq-card-text{white-space:pre-wrap;overflow-wrap:anywhere}
.vq-edit-actions{display:flex;gap:8px;flex-wrap:wrap}
.vq-elist{display:grid;gap:12px}
.vq-eitem{border:1px solid var(--line);border-radius:var(--radius);padding:12px;display:grid;gap:10px;background:var(--surface)}
.vq-ehead{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.vq-time{width:84px !important;flex:none;text-align:center;font-variant-numeric:tabular-nums}
.vq-ehead .vq-r-sp{flex:1}
`;
const ensureCss = (ctx) => { ensureMediaCss(ctx); (ctx?.injectCss || injectCss)("media-videoquiz", CSS); };

// ── 데이터 ──
const blankOptions = () => Array.from({ length: 4 }, () => ({ id: newId("opt"), text: "" }));

function normQ(q) {
  const kind = KINDS.some(k => k.value === q?.kind) ? q.kind : "mcq";
  const out = { ...(q || {}), id: q?.id || newId("vq"), atSec: Math.max(0, Math.floor(Number(q?.atSec) || 0)), kind, question: String(q?.question ?? "") };
  if (kind === "mcq" || Array.isArray(q?.options)) {
    const options = (q?.options || []).map(o => ({ id: o.id || newId("opt"), text: String(o.text ?? "") }));
    out.options = options.length ? options : blankOptions();
    out.answerIds = (q?.answerIds || []).filter(id => out.options.some(o => o.id === id));
  }
  return out;
}
const sortQs = (list) => list.slice().sort((a, b) => a.atSec - b.atSec);

function cfgOf(slide) {
  const c = slide?.config || {};
  return { url: String(c.url || ""), questions: sortQs((c.questions || []).map(normQ)) };
}

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
function grade(q, picked) {
  if (q.kind !== "mcq" || !(q.answerIds || []).length) return { correct: null, score: null };
  const ok = sameSet(picked, q.answerIds);
  return { correct: ok, score: ok ? 1 : 0 };
}

function nameOf(ctx, id) {
  let s = null;
  try { s = ctx?.students?.()?.get?.(id) || null; } catch { s = null; }
  if (!s && typeof storeMod.findStudent === "function") { try { s = storeMod.findStudent(id); } catch { s = null; } }
  return s?.name || "학생";
}

// ctx.interval 이 있으면 쓰고(호스트가 정리), 없으면 직접
function every(ctx, fn, ms) {
  if (typeof ctx?.interval === "function") {
    const id = ctx.interval(fn, ms);
    return () => ctx.clearTimer?.(id);
  }
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
}
function later(ctx, fn, ms) {
  if (typeof ctx?.timeout === "function") {
    const id = ctx.timeout(fn, ms);
    return () => ctx.clearTimer?.(id);
  }
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

function seg(options, value, onPick) {
  const root = el("div", { class: "seg" });
  const paint = (v) => [...root.children].forEach((b, i) => b.classList.toggle("active", options[i].value === v));
  options.forEach(o => root.appendChild(el("button", { type: "button", onClick: () => { paint(o.value); onPick(o.value); } }, o.label)));
  paint(value);
  return root;
}

// ── 문제별 결과 (교사 panel · summary 공용) → { el, update(responses) } ──
function resultsView(ctx, cfg) {
  const root = el("div", { class: "vq-results" });
  if (!cfg.questions.length) {
    root.appendChild(el("div", { class: "empty" }, "문제가 없어요"));
    return { el: root, update() {} };
  }
  const rowsFor = (q, rs) => (q.options || []).map((o, i) => ({
    label: `${optionLetter(i)}. ${o.text || ""}`,
    count: rs.filter(r => (r.payload?.answerIds || []).includes(o.id)).length,
    highlight: (q.answerIds || []).includes(o.id),
  }));
  const blocks = cfg.questions.map((q, i) => {
    const count = el("span", { class: "pill pill-muted" });
    const bars = q.kind === "mcq" ? choiceBars(rowsFor(q, []), 0, { revealed: true }) : null;
    const cards = q.kind === "mcq" ? null : el("div", { class: "vq-cards" });
    root.appendChild(el("section", { class: "vq-r" }, [
      el("div", { class: "vq-r-head" }, [
        el("span", { class: "pill" }, fmtSec(q.atSec)),
        el("span", { class: "vq-r-kind" }, kindLabel(q.kind)),
        el("span", { class: "vq-r-sp" }),
        count,
      ]),
      el("div", { class: "vq-r-q" }, q.question || `문제 ${i + 1}`),
      bars || cards,
    ]));
    return { q, count, bars, cards, sig: null };
  });

  function update(list) {
    const byQ = new Map();
    for (const r of list || []) {
      const k = r.itemKey || "";
      if (!byQ.has(k)) byQ.set(k, []);
      byQ.get(k).push(r);
    }
    for (const b of blocks) {
      const rs = byQ.get(b.q.id) || [];
      if (b.bars) {
        const ok = rs.filter(r => r.correct === true).length;
        b.count.textContent = (b.q.answerIds || []).length ? `${rs.length}명 · 정답 ${ok}` : `${rs.length}명`;
        b.bars.update(rowsFor(b.q, rs), rs.length, { revealed: true });
      } else {
        b.count.textContent = `${rs.length}명`;
        const sorted = rs.slice().sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
        const sig = sorted.map(r => `${r.studentId}:${r.updatedAt || 0}`).join(",");
        if (sig === b.sig) continue; // 바뀐 게 없으면 DOM 보존
        b.sig = sig;
        b.cards.replaceChildren(...(sorted.length
          ? sorted.map(r => el("div", { class: "card vq-card" }, [
            el("div", { class: "vq-card-name" }, nameOf(ctx, r.studentId)),
            el("div", { class: "vq-card-text" }, String(r.payload?.text ?? "")),
          ]))
          : [el("div", { class: "empty" }, "아직 응답이 없어요")]));
      }
    }
  }
  update([]);
  return { el: root, update };
}

// ── 편집기 ──
function Editor({ slide, update, ctx }) {
  ensureCss(ctx);
  const init = cfgOf(slide);
  let url = init.url;
  let qs = init.questions; // 로컬 가변 상태
  let openId = null, t = null;

  const save = () => update({ config: { ...(slide.config || {}), url, questions: qs.map(q => JSON.parse(JSON.stringify(q))) } });

  const urlIn = el("input", { class: "input", type: "text", inputmode: "url", placeholder: "유튜브 또는 mp4 주소", autocomplete: "off", spellcheck: "false" });
  urlIn.value = url;
  const box = el("div", { class: "md-preview" });
  const preview = createPreview(box);
  urlIn.addEventListener("input", () => {
    url = urlIn.value.trim();
    save();
    clearTimeout(t);
    t = setTimeout(() => preview.set(url), 600);
  });
  preview.set(url);

  const addBtn = el("button", { class: "btn btn-primary", type: "button", onClick: addQuestion }, "현재 시점에 문제 추가");
  const list = el("div", { class: "vq-elist" });

  function addQuestion() {
    if (!videoSource(url)) { ctx.toast?.(url ? VIDEO_UNSUPPORTED : "동영상 주소를 먼저 넣으세요"); return; }
    clearTimeout(t);
    preview.set(url); // 디바운스 대기 중이면 지금 반영(같은 영상이면 유지)
    const p = preview.player;
    const at = p ? Math.floor(p.getTime()) : 0;
    p?.pause();
    const q = { id: newId("vq"), atSec: at, kind: "mcq", question: "", options: blankOptions(), answerIds: [] };
    qs = sortQs([...qs, q]);
    openId = q.id;
    renderList();
    save();
    list.querySelector(`[data-qid="${q.id}"] textarea`)?.focus();
  }

  function renderList() {
    if (!qs.length) { list.replaceChildren(el("div", { class: "empty" }, "아직 문제가 없어요")); return; }
    list.replaceChildren(...qs.map((q, i) => itemFor(q, i)));
  }

  function itemFor(q, i) {
    // inputmode numeric 키패드엔 ':' 가 없어 일반 텍스트로
    const time = el("input", { class: "input vq-time", type: "text", title: "시점", "aria-label": "시점", autocomplete: "off" });
    time.value = fmtSec(q.atSec);
    time.addEventListener("change", () => {
      const s = parseSec(time.value);
      if (s == null) { time.value = fmtSec(q.atSec); ctx.toast?.("시간은 1:23 처럼 써 주세요"); return; }
      q.atSec = s;
      qs = sortQs(qs);
      openId = q.id;
      renderList();
      save();
    });
    time.addEventListener("keydown", (e) => { if (e.key === "Enter") time.blur(); });
    const go = el("button", { class: "btn btn-icon btn-ghost", type: "button", title: "이 시점으로", onClick: () => preview.player?.seek(q.atSec) }, "▶");
    const kindSeg = seg(KINDS, q.kind, (v) => {
      if (q.kind === v) return;
      q.kind = v;
      if (v === "mcq" && !(q.options || []).length) { q.options = blankOptions(); q.answerIds = []; }
      renderBody();
      save();
    });
    const del = el("button", { class: "btn btn-icon btn-ghost", type: "button", title: "삭제", onClick: async () => {
      if (q.question.trim() && !(await ctx.confirm?.("이 문제를 지울까요?", { ok: "삭제", danger: true }))) return;
      qs = qs.filter(x => x !== q);
      renderList();
      save();
    } }, "×");
    const body = el("div", { class: "vq-ebody" });
    function renderBody() {
      if (q.kind === "mcq") {
        body.replaceChildren(questionEditor({
          question: q.question, options: q.options, answerIds: q.answerIds, multiple: false,
          maxOptions: 6, minOptions: 2, placeholder: "질문",
          onChange: (v) => { q.question = v.question; q.options = v.options; q.answerIds = v.answerIds; save(); },
        }));
      } else {
        const ta = el("textarea", { class: "input", rows: "2", placeholder: q.kind === "short" ? "질문 (단답)" : "질문 (서술)" });
        ta.value = q.question;
        ta.addEventListener("input", () => { q.question = ta.value; save(); });
        body.replaceChildren(el("div", { class: "field" }, [ta]));
      }
    }
    renderBody();
    const item = el("div", { class: "vq-eitem", "data-qid": q.id }, [
      el("div", { class: "vq-ehead" }, [
        el("span", { class: "pill pill-muted" }, String(i + 1)), time, go, kindSeg, el("span", { class: "vq-r-sp" }), del,
      ]),
      body,
    ]);
    if (openId === q.id) { openId = null; setTimeout(() => item.scrollIntoView?.({ block: "nearest" }), 0); }
    return item;
  }
  renderList();

  const root = el("div", { class: "md-edit" }, [
    el("div", { class: "field" }, [urlIn]),
    box,
    el("div", { class: "vq-edit-actions" }, [addBtn]),
    list,
  ]);
  return { el: root, destroy() { clearTimeout(t); preview.destroy(); } };
}

// ── 학생 ──
function Student({ slide, ctx }) {
  ensureCss(ctx);
  const cfg = cfgOf(slide);
  const qs = cfg.questions;
  if (!videoSource(cfg.url)) return { el: el("div", { class: "empty" }, "동영상이 없어요") };

  let st = ctx.activity?.() || { phase: "idle" };
  const pending = new Set();           // 제출 중인 문제 id
  let open = null;                     // 열린 문제 { q }
  let cancelFeedback = null;

  const player = createPlayer(cfg.url);
  const prog = el("span", { class: "pill pill-muted" });
  const endP = el("span", { class: "pill pill-muted" }, "마감");
  const layer = el("div", { class: "vq-layer", hidden: true });
  const root = el("div", { class: "vq-stu" }, [
    el("div", { class: "md-stage" }, [el("div", { class: "md-fit" }, [player.el])]),
    el("div", { class: "vq-bar" }, [prog, endP]),
    layer,
  ]);

  const locked = () => st?.phase === "ended";
  const answered = (q) => pending.has(q.id) || !!ctx.myResponse?.(q.id);

  function paint() {
    const done = qs.filter(answered).length;
    prog.textContent = `문제 ${done}/${qs.length}`;
    prog.hidden = !qs.length;
    endP.hidden = !locked();
  }

  function close(resume) {
    cancelFeedback?.(); cancelFeedback = null;
    open = null;
    layer.hidden = true;
    layer.replaceChildren();
    if (resume && !locked()) player.play();
  }

  function show(q) {
    player.pause();
    player.exitFullscreen();
    open = { q };
    const idx = qs.indexOf(q);
    const multi = (q.answerIds || []).length > 1;
    const sel = new Set();
    let input = null;
    const feedback = el("div", { class: "vq-feedback" });
    const submitB = el("button", { class: "btn btn-primary btn-lg btn-block", type: "button", disabled: true, onClick: submit }, "제출");
    const parts = [
      el("div", { class: "vq-pop-head" }, [el("span", { class: "pill" }, `${idx + 1} / ${qs.length}`)]),
      el("h2", { class: "vq-q" }, q.question || "문제"),
    ];
    let btns = [];
    if (q.kind === "mcq") {
      btns = (q.options || []).map((o, i) => {
        const mark = el("span", { class: "vq-mark" });
        const b = el("button", { class: "choice", type: "button", onClick: () => {
          if (b.disabled) return;
          if (multi) { sel.has(o.id) ? sel.delete(o.id) : sel.add(o.id); }
          else { sel.clear(); sel.add(o.id); }
          btns.forEach(x => x.b.classList.toggle("selected", sel.has(x.id)));
          submitB.disabled = !sel.size;
        } }, [el("span", { class: "choice-key" }, optionLetter(i)), el("span", { class: "choice-text" }, o.text || " "), mark]);
        return { b, mark, id: o.id };
      });
      parts.push(el("div", { class: "vq-choices" }, btns.map(x => x.b)));
    } else {
      const max = q.kind === "short" ? 100 : 1000;
      const cnt = el("div", { class: "vq-count" }, `0/${max}`);
      input = q.kind === "short"
        ? el("input", { class: "input", type: "text", maxlength: String(max), placeholder: "답", autocomplete: "off" })
        : el("textarea", { class: "input", maxlength: String(max), rows: "5", placeholder: "답" });
      input.addEventListener("input", () => {
        cnt.textContent = `${input.value.length}/${max}`;
        submitB.disabled = !input.value.trim();
      });
      if (q.kind === "short") input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); } });
      parts.push(el("div", { class: "field" }, [input]), cnt);
    }
    parts.push(feedback, submitB);
    layer.replaceChildren(el("div", { class: "vq-pop", role: "dialog", "aria-modal": "true" }, parts));
    layer.hidden = false;
    if (input) setTimeout(() => input.focus(), 50);

    async function submit() {
      if (submitB.disabled || open?.q !== q || locked()) return;
      let payload, g;
      if (q.kind === "mcq") {
        const picked = (q.options || []).map(o => o.id).filter(id => sel.has(id));
        if (!picked.length) return;
        payload = { answerIds: picked };
        g = grade(q, picked);
      } else {
        const text = input.value.trim().slice(0, q.kind === "short" ? 100 : 1000);
        if (!text) return;
        payload = { text };
        g = { correct: null, score: null };
      }
      submitB.disabled = true;
      submitB.textContent = "제출 중…";
      btns.forEach(x => { x.b.disabled = true; });
      if (input) input.disabled = true;
      pending.add(q.id);
      try {
        await ctx.submit(payload, { itemKey: q.id, correct: g.correct, score: g.score });
      } catch {
        // ctx.submit 이 toast 처리 — 다시 시도 가능하게
        pending.delete(q.id);
        if (open?.q === q) {
          submitB.disabled = false;
          submitB.textContent = "제출";
          btns.forEach(x => { x.b.disabled = false; });
          if (input) input.disabled = false;
        }
        paint();
        return;
      }
      pending.delete(q.id);
      paint();
      if (open?.q !== q) return;
      if (g.correct === null) { close(true); return; }
      // mcq 정오 잠깐 표시
      for (const x of btns) {
        const isAns = q.answerIds.includes(x.id);
        const picked = sel.has(x.id);
        x.b.classList.toggle("correct", isAns);
        x.b.classList.toggle("wrong", picked && !isAns);
        x.mark.textContent = picked ? (isAns ? "✓" : "✗") : "";
      }
      feedback.textContent = g.correct ? "정답이에요" : "아쉬워요";
      feedback.className = `vq-feedback ${g.correct ? "ok" : "bad"}`;
      submitB.hidden = true;
      cancelFeedback = later(ctx, () => { cancelFeedback = null; if (open?.q === q) close(true); }, 900);
    }
  }

  function tick() {
    if (open) { if (player.isPlaying()) player.pause(); return; }
    if (locked() || !qs.length) return;
    const now = player.getTime();
    if (!player.started && now < 0.5) return;
    const q = qs.find(x => !answered(x) && x.atSec <= now + 0.05);
    if (q) show(q);
  }
  const stopPoll = every(ctx, tick, 250);
  paint();

  return {
    el: root,
    onActivity(s) {
      st = s || { phase: "idle" };
      if (locked() && open) close(false);
      paint();
    },
    onResponses() { paint(); },
    destroy() {
      stopPoll();
      cancelFeedback?.();
      player.destroy();
    },
  };
}

// ── 교사 ──
function TeacherLive({ slide, ctx }) {
  ensureCss(ctx);
  const cfg = cfgOf(slide);
  const player = videoSource(cfg.url) ? createPlayer(cfg.url) : null;
  const stage = el("div", { class: "md-stage" }, [
    player ? el("div", { class: "md-fit" }, [player.el]) : el("div", { class: "empty" }, "동영상이 없어요"),
  ]);
  const bar = activityBar(ctx, { reveal: false, timer: false });
  const results = resultsView(ctx, cfg);
  const panel = el("div", { class: "vq-panel" }, [bar, results.el]);

  function paint() {
    bar.update?.();
    results.update(ctx.responses());
  }
  paint();

  return {
    el: stage,
    panel,
    onActivity() { bar.update?.(); },
    onResponses() { paint(); },
    onSession() { bar.update?.(); },
    destroy() { bar.destroy?.(); player?.destroy(); },
  };
}

function summary(slide, responses = [], session, ctx) {
  ensureCss(ctx);
  const cfg = cfgOf(slide);
  const results = resultsView(ctx, cfg);
  results.update(responses);
  return el("div", { class: "vq-sum" }, [results.el]);
}

registerSlideType({
  type: "videoquiz",
  category: "media",
  label: "동영상 퀴즈",
  desc: "동영상 중간에 문제 넣기",
  icon: ICON,
  create() { return { type: "videoquiz", config: { url: "", questions: [] } }; },
  thumb(slide) { return videoThumb(slide, ICON, "동영상 퀴즈"); },
  Editor,
  Student,
  TeacherLive,
  summary,
  validate(slide) {
    const c = cfgOf(slide);
    if (!c.url.trim()) return "동영상 주소를 입력하세요";
    if (!videoSource(c.url)) return VIDEO_UNSUPPORTED;
    if (!c.questions.length) return "문제를 추가하세요";
    if (c.questions.some(q => !q.question.trim())) return "빈 문제가 있어요";
    for (const q of c.questions) {
      if (q.kind !== "mcq") continue;
      if ((q.options || []).some(o => !String(o.text || "").trim())) return "빈 선택지가 있어요";
      if (!(q.answerIds || []).length) return "정답을 선택하세요";
    }
    return null;
  },
});
