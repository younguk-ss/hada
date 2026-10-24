// 동영상 퀴즈(videoquiz) 슬라이드 (§6.4)
// questions [{ id, atSec, kind:'mcq'|'short'|'essay', question, options?, answerIds? }] — atSec 오름차순
// 진행 방식 = session.flow: 'teacher' → 교사 진행(칠판 영상이 멈추면 모두 같은 문제), 'student' → 자율(학생마다 플레이어).
// 가정: (자율) 학생 화면은 250ms 폴링으로 '미응답 & atSec <= 현재 시각' 중 가장 이른 문제를 띄운다(영상이 한 번이라도 재생된 뒤부터).
// 가정: (자율) 마감(phase 'ended')이면 새 문제를 띄우지 않고 열린 문제도 닫는다(영상은 계속 볼 수 있음).
// 가정: (자율) mcq 는 제출 후 0.9초 정오 표시 뒤 닫고 재생. 정답이 비어 있으면 채점하지 않음(correct/score null).
// 가정: 정답이 2개 이상인 mcq 만 여러 개 선택(편집기는 단일 정답).
// 가정: (교사 진행) activity 필드 — vq:{ state:'playing'|'question', qid?, askedAt? }, vqAsked:[qid], vqRevealed:[qid],
//       vqAuto:[qid](전원 응답으로 자동 공개한 문제 — 교사가 공개를 끄면 다시 켜지 않게). 재생 위치는 보내지 않는다.
// 가정: (교사 진행) 공개 = vqRevealed 에 있거나, 이미 물었고 지금 열려 있지 않음(계속 재생으로 닫힘).
// 가정: (교사 진행) 마감이면 새 문제에서 멈추지 않고, 열린 문제는 입력만 잠근다.
// 가정: (교사 진행) 학생 대기 화면에는 직전 객관식 결과 pill(정답!/정답: B)만 작게 남긴다(비대화형).
// 가정: panel [초기화] = 응답 삭제 + vq/vqAsked/vqRevealed/vqAuto 비움 + 교사 영상 처음으로
//       (activityBar 에 감싼 ctx 를 넘겨 clearResponses 성공 뒤 setActivity 패치에 덧붙인다).
// 가정: flow 를 바꿔도 activity.vq 는 그대로 둔다(교사 진행으로 돌아오면 열린 문제가 다시 보임). 교사 플레이어는 유지.
import { el, icon } from "../ui.js";
import * as storeMod from "../store.js";
import { registerSlideType, newId, injectCss } from "./registry.js";
import { activityBar, columnChart, whoSheet, optionColor, questionEditor, optionLetter } from "./common.js";
import { everyoneAnswered, letterKeys } from "./mcq.js";
import { createPlayer, createPreview, videoSource, videoThumb, ensureMediaCss, fmtSec, parseSec, VIDEO_UNSUPPORTED } from "./video.js";

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2.5"/><path d="M10 7.6v4.8l4-2.4z"/><path d="M7 20h10"/><circle cx="12" cy="20" r="1.2"/></svg>`;

const KINDS = [
  { value: "mcq", label: "객관식" },
  { value: "short", label: "단답" },
  { value: "essay", label: "서술" },
];
const kindLabel = (k) => KINDS.find(x => x.value === k)?.label || "객관식";

const CSS = `
.vq-root,.vq-paced,.vq-t{position:relative;height:100%;min-height:0;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}
.vq-root > *,.vq-paced > *,.vq-t > *{min-width:0;min-height:0}
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
.vq-pop .choice,.vq-ask .choice{min-height:56px;width:100%;text-align:left;display:flex;align-items:center;gap:12px;font-size:17px;padding:10px 14px;cursor:pointer}
.vq-pop .choice:disabled,.vq-ask .choice:disabled{cursor:default}
.vq-pop .choice.correct,.vq-ask .choice.correct{background:var(--highlight)}
.vq-pop .choice .choice-key.opt-key,.vq-ask .choice .choice-key.opt-key{background:var(--opt-color);border-color:var(--opt-color);color:#fff}
.vq-mark{margin-left:auto;font-weight:800;font-size:20px}
.choice.correct .vq-mark{color:var(--ok)}
.choice.wrong .vq-mark{color:var(--danger)}
.vq-pop textarea{min-height:120px;resize:vertical}
.vq-count{font-size:12px;color:var(--muted);text-align:right}
.vq-feedback{font-weight:700;text-align:center}
.vq-feedback.ok{color:var(--ok)}
.vq-feedback.bad{color:var(--danger)}
.vq-feedback:empty{display:none}
.vq-wait{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center}
.vq-wait-icon{width:64px;height:64px;border-radius:18px;background:var(--surface-2);color:var(--muted);display:grid;place-items:center}
.vq-wait-icon svg{width:30px;height:30px}
.vq-wait-text{font-size:20px;font-weight:600;color:var(--ink-2)}
.vq-ask{overflow:auto}
.vq-ask-in{display:flex;flex-direction:column;gap:14px;max-width:760px;margin:0 auto;width:100%;box-sizing:border-box;padding:20px 16px calc(24px + env(safe-area-inset-bottom))}
.vq-ask-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.vq-ask .vq-q{font-size:22px}
.vq-ask textarea{min-height:140px;resize:vertical}
.vq-submit{min-height:52px;font-size:17px}
.vq-tq{position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;background:rgba(20,20,30,.5);overflow:auto}
.vq-tq-card{width:min(1000px,100%);max-height:100%;overflow:auto;box-sizing:border-box;background:var(--surface);border-radius:var(--radius-lg);box-shadow:var(--shadow-2);padding:24px 28px;display:flex;flex-direction:column;gap:18px}
.vq-tq-head{display:flex;gap:6px;align-items:center}
.vq-tq-q{margin:0;font-size:clamp(20px,2.6vw,32px);font-weight:700;line-height:1.4;white-space:pre-wrap;word-break:keep-all;overflow-wrap:anywhere}
.vq-tq .cc{--cc-h:clamp(90px,24cqh,240px)}
.vq-tq .vq-cards{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.vq-tq .vq-card-text{font-size:17px}
.vq-tq-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.vq-tq-actions .btn.active{background:var(--accent-soft);color:var(--accent-ink);border-color:var(--accent)}
@media (max-width:720px){.vq-tq{padding:10px}.vq-tq-card{padding:16px;gap:14px}}
.vq-panel{display:grid;gap:14px}
.vq-results{display:grid;gap:10px}
.vq-r{display:grid;gap:8px;padding:12px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface)}
.vq-r.is-current{border-color:var(--accent);background:var(--accent-soft)}
.vq-r-head{display:flex;gap:6px;align-items:center}
.vq-r-kind{font-size:12px;color:var(--muted)}
.vq-r-sp{flex:1}
.vq-r-q{font-weight:600;white-space:pre-wrap;overflow-wrap:anywhere}
.vq-cards{display:grid;gap:8px}
.vq-cards > .empty{padding:12px}
.vq-card{padding:10px 12px;display:grid;gap:4px}
.vq-card-name{font-size:12px;color:var(--muted)}
.vq-card-text{white-space:pre-wrap;overflow-wrap:anywhere}
.vq-results.is-compact .cc{gap:6px}
.vq-results.is-compact .cc-count{font-size:14px;min-height:20px;gap:2px}
.vq-results.is-compact .cc-count svg{width:16px;height:16px}
.vq-results.is-compact .cc-bar,.vq-results.is-compact .cc-fill{border-radius:6px 6px 2px 2px}
.vq-results.is-compact .cc-tile{min-height:36px;padding:6px 4px;font-size:12px;border-radius:8px}
.vq-results.is-compact .cc-tile > span:first-child{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.vq-results.is-compact .cc-key{display:none}
.vq-results.is-compact .cc-tile .cc-tick{width:20px;height:20px;top:-6px;right:-4px}
.vq-results.is-compact .cc-tile .cc-tick svg{width:14px;height:14px}
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

// 진행 방식: 교사 진행('teacher', 기본) / 자율('student')
const flowOf = (ctx) => (ctx?.session?.()?.flow === "student" ? "student" : "teacher");

// 교사 진행 상태 읽기
function vqState(a) {
  const vq = a?.vq || {};
  const open = vq.state === "question" && vq.qid;
  const list = (x) => (Array.isArray(x) ? x : []);
  return {
    state: open ? "question" : "playing",
    qid: open ? vq.qid : null,
    asked: list(a?.vqAsked),
    revealed: list(a?.vqRevealed),
    auto: list(a?.vqAuto),
  };
}
// 공개: 정답 공개 목록에 있거나, 이미 물었고 지금 열려 있지 않음(계속 재생으로 닫힘)
const isRevealed = (v, qid) => v.revealed.includes(qid) || (v.asked.includes(qid) && v.qid !== qid);

// 학생별 최신 1개
function latestBy(rs) {
  const m = new Map();
  for (const r of rs || []) {
    const p = m.get(r.studentId);
    if (!p || (r.updatedAt || 0) >= (p.updatedAt || 0)) m.set(r.studentId, r);
  }
  return [...m.values()];
}

const lettersOf = (q) => (q.options || []).map((o, i) => ((q.answerIds || []).includes(o.id) ? optionLetter(i) : null)).filter(Boolean).join(", ");

// 객관식 결과 문구(채점 문제만): 정답! / 정답: B
function resultOf(q, mine) {
  if (!q || q.kind !== "mcq" || !(q.answerIds || []).length) return null;
  const ok = !!mine && sameSet(mine.payload?.answerIds || [], q.answerIds);
  return { ok, text: ok ? "정답!" : `정답: ${lettersOf(q)}` };
}
function paintResult(pill, res) {
  pill.hidden = !res;
  if (!res) return;
  pill.textContent = res.text;
  pill.className = `pill pill-lg ${res.ok ? "pill-ok" : "pill-muted"}`;
}

// 옵션별 선택 수 (여러 개 고르면 고른 옵션마다 1)
function countsFor(q, rs) {
  const counts = {};
  for (const o of q.options || []) counts[o.id] = 0;
  for (const r of rs) for (const id of new Set(r.payload?.answerIds || [])) if (id in counts) counts[id] += 1;
  return counts;
}

function chartFor(q, onBarClick) {
  const opts = (q.options || []).map((o, i) => ({ id: o.id, label: o.text || optionLetter(i) }));
  return letterKeys(columnChart(opts, onBarClick ? { onBarClick } : {}));
}

// 누가 골랐나 (선지별 + 미응답)
function openWho(ctx, q, rs, revealed) {
  if (typeof ctx?.modal !== "function") return;
  const ids = new Set(rs.map(r => r.studentId));
  const groups = (q.options || []).map((o, i) => ({
    label: `${optionLetter(i)}. ${o.text || ""}`.trim(),
    color: optionColor(i),
    correct: !!revealed && (q.answerIds || []).includes(o.id),
    studentIds: rs.filter(r => (r.payload?.answerIds || []).includes(o.id)).map(r => r.studentId),
  }));
  groups.push({ label: "미응답", studentIds: (ctx.participants?.() || []).filter(id => !ids.has(id)) });
  whoSheet(ctx, { title: "응답 보기", groups });
}

// 단답·서술 카드(이름 + 글, 최신 순) → { el, set(rs) }
function answerCards(ctx) {
  const root = el("div", { class: "vq-cards" });
  let sig = null;
  function set(rs) {
    const sorted = (rs || []).slice().sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
    const next = sorted.map(r => `${r.studentId}:${r.updatedAt || 0}:${r.payload?.text ?? ""}`).join("\n");
    if (next === sig) return; // 바뀐 게 없으면 DOM 보존
    sig = next;
    root.replaceChildren(...(sorted.length
      ? sorted.map(r => el("div", { class: "card vq-card" }, [
        el("div", { class: "vq-card-name" }, nameOf(ctx, r.studentId)),
        el("div", { class: "vq-card-text" }, String(r.payload?.text ?? "")),
      ]))
      : [el("div", { class: "empty" }, "아직 응답이 없어요")]));
  }
  set([]);
  return { el: root, set };
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

// ── 문제별 결과 (교사 panel · summary 공용) → { el, update(responses, { currentId, revealed(qid) }) } ──
// compact: 패널용 작은 막대(--cc-h 90px), who: 막대 누르면 응답자 보기
function resultsView(ctx, cfg, { compact = false, who = false } = {}) {
  const root = el("div", { class: `vq-results${compact ? " is-compact" : ""}` });
  if (!cfg.questions.length) {
    root.appendChild(el("div", { class: "empty" }, "문제가 없어요"));
    return { el: root, update() {} };
  }
  const blocks = cfg.questions.map((q, i) => {
    const b = { q, rs: [], rev: false, graded: q.kind === "mcq" && (q.answerIds || []).length > 0, count: el("span", { class: "pill pill-muted" }), chart: null, cards: null, sec: null };
    if (q.kind === "mcq") {
      b.chart = chartFor(q, who ? () => openWho(ctx, q, b.rs, b.rev) : null);
      if (compact) b.chart.style.setProperty("--cc-h", "90px");
    } else {
      b.cards = answerCards(ctx);
    }
    b.sec = el("section", { class: "vq-r" }, [
      el("div", { class: "vq-r-head" }, [
        el("span", { class: "pill" }, fmtSec(q.atSec)),
        el("span", { class: "vq-r-kind" }, kindLabel(q.kind)),
        el("span", { class: "vq-r-sp" }),
        b.count,
      ]),
      el("div", { class: "vq-r-q" }, q.question || `문제 ${i + 1}`),
      b.chart || b.cards.el,
    ]);
    root.appendChild(b.sec);
    return b;
  });

  function update(list, { currentId = null, revealed = () => true } = {}) {
    const byQ = new Map();
    for (const r of list || []) {
      const k = r.itemKey || "";
      if (!byQ.has(k)) byQ.set(k, []);
      byQ.get(k).push(r);
    }
    for (const b of blocks) {
      const rs = latestBy(byQ.get(b.q.id) || []);
      b.rs = rs;
      b.sec.classList.toggle("is-current", !!currentId && b.q.id === currentId);
      if (b.chart) {
        b.rev = b.graded && !!revealed(b.q.id);
        const ok = rs.filter(r => r.correct === true).length;
        b.count.textContent = b.rev ? `${rs.length}명 · 정답 ${ok}` : `${rs.length}명`;
        b.chart.update({ counts: countsFor(b.q, rs), correctIds: b.graded ? b.q.answerIds : [], revealed: b.rev });
      } else {
        b.count.textContent = `${rs.length}명`;
        b.cards.set(rs);
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
// flow 에 따라 자율(플레이어) / 교사 진행(문제만) 화면을 바꿔 끼운다
function Student({ slide, ctx }) {
  ensureCss(ctx);
  const cfg = cfgOf(slide);
  if (!videoSource(cfg.url)) return { el: el("div", { class: "empty" }, "동영상이 없어요") };

  const root = el("div", { class: "vq-root" });
  let mode = null, view = null;
  function setMode(m) {
    if (m === mode) return;
    try { view?.destroy?.(); } catch (e) { console.warn("[videoquiz] destroy", e); }
    mode = m;
    view = m === "teacher" ? pacedStudent(cfg, ctx) : selfStudent(cfg, ctx);
    root.replaceChildren(view.el);
  }
  setMode(flowOf(ctx));

  return {
    el: root,
    onActivity(s) { view?.onActivity?.(s); },
    onResponses(list) { view?.onResponses?.(list); },
    onSession() { setMode(flowOf(ctx)); },
    destroy() {
      try { view?.destroy?.(); } catch (e) { console.warn("[videoquiz] destroy", e); }
      view = null;
    },
  };
}

// 자율: 학생마다 플레이어, 시점마다 멈추고 문제
function selfStudent(cfg, ctx) {
  const qs = cfg.questions;
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
        } }, [
          el("span", { class: "choice-key opt-key", style: { "--opt-color": optionColor(i) } }, optionLetter(i)),
          el("span", { class: "choice-text" }, o.text || " "),
          mark,
        ]);
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
    if (input) later(ctx, () => input.focus(), 50);

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
        x.mark.textContent = isAns ? "✓" : picked ? "✗" : "";
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
      cancelFeedback = null;
      player.destroy();
    },
  };
}

// 교사 진행: 플레이어 없음. 대기 문구 ↔ 교사가 연 문제
function pacedStudent(cfg, ctx) {
  const qs = cfg.questions;
  const lastP = el("span", { class: "pill pill-lg", hidden: true });
  const wait = el("div", { class: "vq-wait" }, [
    el("span", { class: "vq-wait-icon" }, [icon("video", 30)]),
    el("div", { class: "vq-wait-text" }, "칠판의 영상을 봐주세요"),
    lastP,
  ]);
  const box = el("div", { class: "vq-ask", hidden: true });
  const root = el("div", { class: "vq-paced" }, [wait, box]);
  let cur = null; // 열린 문제 화면

  function sync() {
    const a = ctx.activity?.() || { phase: "idle" };
    const v = vqState(a);
    const q = v.qid ? qs.find(x => x.id === v.qid) || null : null;
    if (!q) {
      if (cur) { cur = null; box.replaceChildren(); }
      box.hidden = true;
      wait.hidden = false;
      // 직전에 닫힌 문제 결과(객관식만)
      const lastId = v.asked[v.asked.length - 1];
      const last = lastId ? qs.find(x => x.id === lastId) : null;
      paintResult(lastP, last ? resultOf(last, ctx.myResponse?.(last.id)) : null);
      return;
    }
    if (!cur || cur.q !== q) {
      cur = askView(ctx, q, qs);
      box.replaceChildren(cur.el);
      box.scrollTop = 0;
    }
    wait.hidden = true;
    box.hidden = false;
    cur.paint(a, v);
  }
  sync();

  return {
    el: root,
    onActivity() { sync(); },
    onResponses() { if (cur) cur.onResponses(); else sync(); },
    destroy() { cur = null; },
  };
}

// 교사 진행 문제 하나: 고르기/쓰기 + 제출, 계속 재생 전까지 바꿀 수 있음
function askView(ctx, q, qs) {
  const isMcq = q.kind === "mcq";
  const graded = isMcq && (q.answerIds || []).length > 0;
  const multi = (q.answerIds || []).length > 1;
  const max = q.kind === "short" ? 100 : 1000;
  let a = { phase: "idle" }, v = vqState(null);
  let mine = ctx.myResponse?.(q.id) || null;
  let sel = new Set(mine?.payload?.answerIds || []);
  let sending = false;
  const savedText = () => String(mine?.payload?.text ?? "");

  const resP = el("span", { class: "pill pill-lg", hidden: true });
  const subP = el("span", { class: "pill pill-ok", hidden: true }, "제출했어요");
  const endP = el("span", { class: "pill pill-muted", hidden: true }, "마감");
  const parts = [
    el("div", { class: "vq-ask-head" }, [el("span", { class: "pill" }, `${qs.indexOf(q) + 1} / ${qs.length}`), resP, subP, endP]),
    el("h2", { class: "vq-q" }, q.question || "문제"),
  ];
  let btns = [], input = null, cnt = null;
  if (isMcq) {
    btns = (q.options || []).map((o, i) => {
      const mark = el("span", { class: "vq-mark" });
      const b = el("button", { class: "choice", type: "button", onClick: () => pick(o.id) }, [
        el("span", { class: "choice-key opt-key", style: { "--opt-color": optionColor(i) } }, optionLetter(i)),
        el("span", { class: "choice-text" }, o.text || " "),
        mark,
      ]);
      return { b, mark, id: o.id };
    });
    parts.push(el("div", { class: "vq-choices" }, btns.map(x => x.b)));
  } else {
    cnt = el("div", { class: "vq-count" });
    input = q.kind === "short"
      ? el("input", { class: "input", type: "text", maxlength: String(max), placeholder: "답", autocomplete: "off", enterkeyhint: "send" })
      : el("textarea", { class: "input", maxlength: String(max), rows: "5", placeholder: "답" });
    input.value = savedText();
    input.addEventListener("input", () => paint());
    if (q.kind === "short") input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
    });
    parts.push(el("div", { class: "field" }, [input]), cnt);
  }
  const submitB = el("button", { class: "btn btn-primary btn-lg btn-block vq-submit", type: "button", onClick: submit }, "제출");
  parts.push(submitB);
  const root = el("div", { class: "vq-ask-in" }, parts);

  const dirty = () => (isMcq ? !sameSet([...sel], mine?.payload?.answerIds || []) : input.value.trim() !== savedText());
  const hasValue = () => (isMcq ? sel.size > 0 : !!input.value.trim());
  const locked = () => a.phase === "ended" || (isMcq && isRevealed(v, q.id));

  function pick(id) {
    if (locked() || sending) return;
    if (multi) { if (sel.has(id)) sel.delete(id); else sel.add(id); }
    else sel = new Set([id]);
    paint();
  }

  async function submit() {
    if (locked() || sending || !hasValue() || (mine && !dirty())) return;
    let payload, g;
    if (isMcq) {
      const picked = (q.options || []).map(o => o.id).filter(id => sel.has(id));
      payload = { answerIds: picked };
      g = grade(q, picked);
    } else {
      payload = { text: input.value.trim().slice(0, max) };
      g = { correct: null, score: null };
    }
    sending = true; paint();
    try {
      const saved = await ctx.submit(payload, { itemKey: q.id, correct: g.correct, score: g.score });
      if (saved) mine = saved;
    } catch { /* ctx.submit 이 toast 처리 */ }
    sending = false;
    paint();
  }

  function paint(nextA, nextV) {
    if (nextA) a = nextA;
    if (nextV) v = nextV;
    const lock = locked();
    const show = graded && isRevealed(v, q.id);
    // 잠기는 순간 제출 안 한 선택은 제출본으로 되돌림(✓/✗ 가 실제 제출과 일치)
    if (lock && isMcq && !sending && dirty()) sel = new Set(mine?.payload?.answerIds || []);
    const isDirty = dirty();
    paintResult(resP, show ? resultOf(q, mine) : null);
    subP.hidden = show || !mine || isDirty;
    endP.hidden = show || a.phase !== "ended";
    for (const x of btns) {
      const picked = sel.has(x.id);
      const isAns = (q.answerIds || []).includes(x.id);
      x.b.disabled = lock;
      x.b.classList.toggle("selected", picked && !show);
      x.b.classList.toggle("correct", show && isAns);
      x.b.classList.toggle("wrong", show && picked && !isAns);
      x.mark.textContent = show ? (isAns ? "✓" : picked ? "✗" : "") : "";
    }
    if (input) {
      input.disabled = lock;
      cnt.textContent = `${input.value.length}/${max}`;
    }
    submitB.hidden = lock || (!!mine && !isDirty && !sending);
    submitB.disabled = sending || !hasValue();
    submitB.textContent = sending ? "제출 중…" : (mine ? "다시 제출" : "제출");
  }

  return {
    q,
    el: root,
    paint,
    onResponses() {
      const wasDirty = dirty();
      mine = ctx.myResponse?.(q.id) || null;
      if (!wasDirty && !sending) {
        if (isMcq) sel = new Set(mine?.payload?.answerIds || []);
        else if (input.value.trim() !== savedText()) input.value = savedText();
      }
      paint();
    },
  };
}

// ── 교사 ──
function TeacherLive({ slide, ctx }) {
  ensureCss(ctx);
  const cfg = cfgOf(slide);
  const qs = cfg.questions;
  const player = videoSource(cfg.url) ? createPlayer(cfg.url) : null;
  const overlay = el("div", { class: "vq-tq", hidden: true });
  const root = el("div", { class: "vq-t" }, [
    el("div", { class: "md-stage" }, [
      player ? el("div", { class: "md-fit" }, [player.el]) : el("div", { class: "empty" }, "동영상이 없어요"),
    ]),
    overlay,
  ]);

  let mode = null;            // 'teacher'(교사 진행) | 'student'(자율)
  let v = vqState(ctx.activity());
  let card = null;            // 열린 문제 결과 카드
  let stopPoll = null, lastAsk = null, ticks = 0; // lastAsk = { qid, at } 기록 반영 전 같은 문제 중복 방지
  const autoBusy = new Set(); // 자동 공개 예약한 문제

  const rsFor = (qid) => latestBy((ctx.responses() || []).filter(r => (r.itemKey || "") === qid));
  const openQ = (s) => (s.qid ? qs.find(x => x.id === s.qid) || null : null);

  // [초기화] = 응답 삭제 + 교사 진행 상태도 비움 (activityBar 가 clearResponses 성공 뒤 부르는 setActivity 에 덧붙임)
  let resetting = false;
  const barCtx = Object.create(ctx, {
    clearResponses: { value: async () => { await ctx.clearResponses(); resetting = true; } },
    setActivity: { value: (patch) => {
      if (resetting) {
        resetting = false;
        autoBusy.clear();
        lastAsk = null;
        patch = { ...patch, vq: { state: "playing" }, vqAsked: [], vqRevealed: [], vqAuto: [] };
        player?.pause();
        player?.seek(0);
      }
      ctx.setActivity(patch);
    } },
  });
  const bar = activityBar(barCtx, { reveal: false, timer: false });
  const results = resultsView(ctx, cfg, { compact: true, who: true });
  const panel = el("div", { class: "vq-panel" }, [bar, results.el]);

  // 재생 위치 폴링(교사 진행): 안 물은 문제 시점에 닿으면 멈추고 문제 열기
  function tick() {
    if (mode !== "teacher" || !player) return;
    if (++ticks % 8 === 0) checkAuto(); // 접속 변화는 훅이 없어 2초마다
    const a = ctx.activity();
    const s = vqState(a);
    if (openQ(s) || a.phase === "ended" || !qs.length) return;
    const t = player.getTime();
    if (!player.started && t < 0.5) return;
    const q = qs.find(x => !s.asked.includes(x.id) && x.atSec <= t + 0.05);
    if (!q || (lastAsk && lastAsk.qid === q.id && Date.now() - lastAsk.at < 1500)) return;
    lastAsk = { qid: q.id, at: Date.now() };
    player.pause();
    player.exitFullscreen();
    ctx.setActivity({ vq: { state: "question", qid: q.id, askedAt: ctx.now() }, vqAsked: [...s.asked, q.id] });
  }

  function questionCard(q) {
    const isMcq = q.kind === "mcq";
    const graded = isMcq && (q.answerIds || []).length > 0;
    const countP = el("span", { class: "pill" });
    let chart = null, cards = null;
    if (isMcq) chart = chartFor(q, () => openWho(ctx, q, rsFor(q.id), graded && isRevealed(v, q.id)));
    else cards = answerCards(ctx);
    const revealB = graded ? el("button", { class: "btn", type: "button", onClick: () => toggleReveal(q) }, "정답 공개") : null;
    const goB = el("button", { class: "btn btn-primary", type: "button", onClick: () => resume(q) }, [icon("play", 18), el("span", {}, "계속 재생")]);
    const node = el("div", { class: "vq-tq-card", role: "dialog", "aria-label": q.question || "문제" }, [
      el("div", { class: "vq-tq-head" }, [
        el("span", { class: "pill pill-dark" }, `${qs.indexOf(q) + 1} / ${qs.length}`),
        el("span", { class: "pill pill-muted" }, fmtSec(q.atSec)),
        el("span", { class: "vq-r-sp" }),
        countP,
      ]),
      el("h2", { class: "vq-tq-q" }, q.question || "문제"),
      chart || cards.el,
      el("div", { class: "vq-tq-actions" }, [revealB, goB]),
    ]);
    function update() {
      const rs = rsFor(q.id);
      countP.textContent = `응답 ${rs.length}/${(ctx.participants() || []).length}`;
      const rev = graded && isRevealed(v, q.id);
      if (chart) chart.update({ counts: countsFor(q, rs), correctIds: graded ? q.answerIds : [], revealed: rev });
      else cards.set(rs);
      if (revealB) {
        revealB.classList.toggle("active", rev);
        revealB.setAttribute("aria-pressed", rev ? "true" : "false");
      }
    }
    return { q, el: node, update };
  }

  function toggleReveal(q) {
    const s = vqState(ctx.activity());
    const on = s.revealed.includes(q.id);
    ctx.setActivity({ vqRevealed: on ? s.revealed.filter(x => x !== q.id) : [...s.revealed, q.id] });
  }

  function resume(q) {
    if (vqState(ctx.activity()).qid === q.id) ctx.setActivity({ vq: { state: "playing" } });
    if (!player) return;
    if (player.getTime() + 1 < q.atSec) player.seek(q.atSec); // 재마운트로 처음에 있으면 그 시점부터
    player.play();
  }

  // 전원 응답(객관식) → 자동 정답 공개 1회 (교사 클라이언트)
  function checkAuto() {
    if (mode !== "teacher") return;
    const s = vqState(ctx.activity());
    const q = openQ(s);
    if (!q || q.kind !== "mcq" || !(q.answerIds || []).length) return;
    if (s.revealed.includes(q.id) || s.auto.includes(q.id) || autoBusy.has(q.id)) return;
    if (!everyoneAnswered(ctx, rsFor(q.id).map(r => r.studentId))) return;
    autoBusy.add(q.id);
    // 다음 틱에: 훅 안에서 setActivity 재진입 방지
    later(ctx, () => {
      const now = vqState(ctx.activity());
      if (now.qid !== q.id || now.revealed.includes(q.id) || now.auto.includes(q.id)) return;
      ctx.setActivity({ vqRevealed: [...now.revealed, q.id], vqAuto: [...now.auto, q.id] });
    }, 0);
  }

  // 열린 문제 카드(교사 진행에서만)
  function syncStage() {
    v = vqState(ctx.activity());
    const q = mode === "teacher" ? openQ(v) : null;
    if (!q) {
      if (card) { card = null; overlay.replaceChildren(); }
      overlay.hidden = true;
      return;
    }
    if (!card || card.q !== q) {
      card = questionCard(q);
      overlay.replaceChildren(card.el);
      if (player?.isPlaying()) player.pause();
      player?.exitFullscreen();
    }
    overlay.hidden = false;
    card.update();
  }

  function paintPanel() {
    bar.update?.();
    const s = vqState(ctx.activity());
    const paced = mode === "teacher";
    results.update(ctx.responses(), { currentId: paced ? s.qid : null, revealed: (id) => !paced || isRevealed(s, id) });
  }

  function setMode(m) {
    if (m === mode) return;
    mode = m;
    stopPoll?.(); stopPoll = null;
    if (m === "teacher" && player) stopPoll = every(ctx, tick, 250);
    syncStage();
    paintPanel();
  }

  const partSig = () => (ctx.participants() || []).join(",");
  let sSig = partSig();
  setMode(flowOf(ctx));
  checkAuto();

  return {
    el: root,
    panel,
    onActivity() { syncStage(); paintPanel(); checkAuto(); },
    onResponses() { card?.update(); paintPanel(); checkAuto(); },
    onSession() {
      setMode(flowOf(ctx));
      const k = partSig();
      if (k === sSig) return;
      sSig = k;
      card?.update(); paintPanel(); checkAuto();
    },
    destroy() {
      stopPoll?.(); stopPoll = null;
      bar.destroy?.();
      player?.destroy();
      card = null;
    },
  };
}

function summary(slide, responses = [], session, ctx) {
  ensureCss(ctx);
  const cfg = cfgOf(slide);
  const canWho = !!ctx?.isTeacher && typeof ctx?.modal === "function";
  const results = resultsView(ctx, cfg, { compact: true, who: canWho });
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
