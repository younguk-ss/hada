// 플러그인 공용 UI·헬퍼 (docs/ARCHITECTURE.md §6.3)
// activityBar · choiceBars · columnChart · whoSheet · OPTION_COLORS/optionColor · countdownPill · phasePill
// questionEditor · loadYouTubeApi · normalizeAnswer · optionLetter
// resultsOpen · resultsVeil(v2.9 결과 가리기) · imageField · questionImage(v2.9 문제 그림)
// 가정: 스타일은 styles.css(.btn/.pill/.bars/.bar-row/.bar-fill/.field)가 기본. 여기서는 구조용 보조 CSS만
//       :where() 로 주입해 styles.css 규칙이 항상 이기도록 한다.
// 가정(v2.9): 정답이 있는 활동(객관식·빈칸·분류·주관식·동영상 퀴즈)의 교사 화면은 칠판에 띄워지므로, 학생이 답하는 동안에는
//       응답 수만 보이고 결과(막대·답·학생별 표)는 교사가 [마감]하거나 [정답 공개]·타이머가 끝난 뒤에 보인다(미리 보기 방지).
//       '전원 응답 → 자동 공개'는 쓰지 않는다(결과는 늘 교사가 연다).
// 가정(v2.9): 문제 그림 = config.image(문제가 여럿이면 문제마다 q.image) = { url, path, thumb }. 수업 자료 폴더에 올리고
//       자료 복제 때 함께 복사(cloud.js), 자료 삭제 때 폴더째 지워진다.
import { el, toast } from "../ui.js";
import { injectCss, newId } from "./registry.js";
import * as storage from "../storage.js";

injectCss("slides-common", `
:where(.activity-bar){display:flex;align-items:center;gap:8px;flex-wrap:wrap}
:where(.activity-bar .ab-count){font-variant-numeric:tabular-nums}
:where(.activity-bar .ab-spacer){flex:1}
:where(.activity-bar .btn.active){background:var(--accent-soft);color:var(--accent-ink);border-color:var(--accent)}
:where(.ab-timer-wrap){position:relative;display:inline-flex}
:where(.ab-pop){position:absolute;top:calc(100% + 6px);right:0;z-index:50;display:flex;gap:6px;padding:8px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);box-shadow:var(--shadow-2);white-space:nowrap}
:where(.countdown-pill){font-variant-numeric:tabular-nums}
:where(.countdown-pill.is-urgent){color:var(--danger);background:var(--danger-soft);border-color:var(--danger)}
:where(.bars){display:flex;flex-direction:column;gap:8px}
:where(.bar-row){display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr) auto;align-items:center;gap:10px}
:where(.bar-label){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:where(.bar-track){height:14px;border-radius:999px;background:var(--surface-2);overflow:hidden}
:where(.bar-fill){height:100%;width:0;border-radius:inherit;background:var(--line-strong);transition:width .35s ease}
:where(.bar-fill.is-accent){background:var(--accent)}
:where(.bar-row.is-highlight .bar-label){font-weight:600}
:where(.bar-value){font-variant-numeric:tabular-nums;color:var(--ink-2);min-width:64px;text-align:right}
:where(.phase-pill:empty){display:none}
:where(.q-editor){display:flex;flex-direction:column;gap:10px}
:where(.q-opts){display:flex;flex-direction:column;gap:6px}
:where(.q-opt){display:flex;align-items:center;gap:8px}
:where(.q-opt .q-key){width:22px;text-align:center;color:var(--muted);font-weight:600}
:where(.q-opt input[type=text]){flex:1;min-width:0}
:where(.q-opt input[type=radio],.q-opt input[type=checkbox]){width:20px;height:20px;accent-color:var(--ok);flex:none}
.cc{--cc-h:200px;display:grid;grid-template-columns:repeat(var(--cc-n,4),minmax(0,1fr));gap:14px;align-items:end}
.cc-col{display:flex;flex-direction:column;align-items:stretch;gap:8px;min-width:0}
.cc-count{display:flex;align-items:center;justify-content:center;gap:6px;font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--ink);min-height:30px}
.cc-count .cc-check{color:var(--ok);display:none}
.cc-col.is-correct.is-revealed .cc-count .cc-check{display:inline-flex}
.cc-bar{appearance:none;border:0;padding:0;margin:0;background:transparent;height:var(--cc-h);display:flex;align-items:flex-end;cursor:pointer;border-radius:12px}
.cc-bar:focus-visible{outline:none;box-shadow:0 0 0 3px var(--accent-soft)}
.cc-bar:disabled{cursor:default}
.cc-fill{width:100%;min-height:4px;height:0;border-radius:12px 12px 4px 4px;background:var(--cc-color);transition:height .4s cubic-bezier(.2,.7,.2,1),opacity .3s ease}
.cc-bar:hover:not(:disabled) .cc-fill{filter:brightness(1.06)}
.cc-tile{position:relative;display:flex;align-items:center;justify-content:center;min-height:96px;padding:14px 12px;border-radius:14px;background:var(--cc-color);color:#fff;font-weight:700;font-size:18px;line-height:1.3;text-align:center;overflow-wrap:anywhere;transition:opacity .3s ease}
.cc-key{position:absolute;top:8px;right:12px;font-size:15px;font-weight:800;opacity:.55}
.cc-tile .cc-tick{position:absolute;top:6px;right:8px;width:30px;height:30px;border-radius:50%;background:#fff;color:var(--ok);display:none;align-items:center;justify-content:center;box-shadow:var(--shadow-1)}
.cc-col.is-correct.is-revealed .cc-tile .cc-tick{display:inline-flex}
.cc-col.is-correct.is-revealed .cc-key{display:none}
.cc.is-revealed .cc-col:not(.is-correct) .cc-fill,.cc.is-revealed .cc-col:not(.is-correct) .cc-tile{opacity:.32}
@media (max-width:720px){.cc{--cc-h:140px;gap:8px}.cc-tile{min-height:64px;font-size:15px;padding:10px 8px}.cc-count{font-size:17px}}
.who-group{display:flex;flex-direction:column;gap:8px;padding:12px 0;border-top:1px solid var(--line)}
.who-group:first-child{border-top:0;padding-top:0}
.who-head{display:flex;align-items:center;gap:8px;font-weight:600}
.who-dot{width:12px;height:12px;border-radius:4px;background:var(--who-color,var(--line-strong));flex:none}
.who-head .who-n{margin-left:auto;color:var(--muted);font-weight:500;font-variant-numeric:tabular-nums}
.who-names{display:flex;flex-wrap:wrap;gap:6px}
.who-name{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:var(--surface-2);font-size:14px}
.who-name .who-extra{color:var(--muted)}
.who-empty{color:var(--muted);font-size:14px}
/* 결과 가리기(v2.9): 마감 전 교사 화면 — 응답 수와 진행 막대만 */
.cc.is-veiled .cc-count,.cc.is-veiled .cc-bar{display:none}
.cc.is-veiled{align-items:stretch}
.rv-veil{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:26px 16px;min-height:150px;
  border:1px dashed var(--line-strong);border-radius:16px;background:var(--surface);text-align:center}
.rv-veil .rv-n{font-size:clamp(30px,4.4vw,52px);font-weight:800;line-height:1;color:var(--ink);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.rv-veil .rv-n small{font-size:.42em;font-weight:700;color:var(--muted);margin-left:6px;letter-spacing:0}
.rv-veil .rv-track{width:min(340px,80%);height:8px;border-radius:999px;background:var(--surface-2);overflow:hidden}
.rv-veil .rv-fill{height:100%;width:0;border-radius:inherit;background:var(--accent);transition:width .35s ease}
.rv-veil .rv-s{display:inline-flex;align-items:center;gap:6px;font-size:14px;font-weight:600;color:var(--muted)}
.rv-veil .rv-s svg{width:15px;height:15px;flex:none}
.rv-veil.is-compact{min-height:0;padding:14px 12px;gap:8px;border-radius:12px}
.rv-veil.is-compact .rv-n{font-size:22px}
/* 문제 그림(v2.9) */
.qi{display:block;max-width:100%;max-height:min(38vh,420px);width:auto;height:auto;margin:0 auto;border-radius:12px;object-fit:contain;
  background:var(--surface-2);box-shadow:inset 0 0 0 1px var(--line);cursor:zoom-in}
.qi.is-sm{max-height:120px;border-radius:8px}
.wl .qi,.wc .qi,.dd .qi{max-height:min(24vh,260px)}
.dn-qcard .qi,.race-quiz-card .qi,.vq-tq-card .qi,.vq-pop .qi{max-height:min(24vh,230px)}
.qi-wrap{display:flex;justify-content:center;min-width:0}
.qi-zoom{position:fixed;inset:0;z-index:600;display:grid;place-items:center;padding:20px;background:rgba(15,15,20,.82);cursor:zoom-out;animation:fadeIn .15s ease}
.qi-zoom img{max-width:100%;max-height:100%;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.4);background:#fff}
.qi-field{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.qi-field .qi-thumb{width:96px;height:64px;border-radius:8px;object-fit:cover;background:var(--surface-2);box-shadow:inset 0 0 0 1px var(--line);flex:none}
.qi-field .btn svg{width:16px;height:16px}
.qi-field .qi-busy{font-size:13px;color:var(--muted)}
`);

// ── 선지 색상 (미니멀 톤의 4~6색, 객관식·동영상 퀴즈 교사 화면 공용) ──
export const OPTION_COLORS = ["#0f9fa6", "#2f4f8f", "#b07a3c", "#a3384f", "#3f8f5f", "#6b5b9a"];
export function optionColor(i) { return OPTION_COLORS[(Math.max(0, i | 0)) % OPTION_COLORS.length]; }

// ── 세로 막대 + 가로 선지 타일 (교사 화면) ──
// options: [{ id, label }]. update({ counts: {optId:n}, correctIds: [], revealed })
// onBarClick(optId) — 막대나 타일을 누르면 호출(누가 골랐는지 보기)
export function columnChart(options, { onBarClick } = {}) {
  const root = el("div", { class: "cc" });
  let cols = [];
  let last = { counts: {}, correctIds: [], revealed: false };
  function build(opts) {
    root.style.setProperty("--cc-n", String(Math.max(1, opts.length)));
    cols = opts.map((o, i) => {
      const color = o.color || optionColor(i);
      const num = el("span", {}, "0명");
      const count = el("div", { class: "cc-count" }, [el("span", { class: "cc-check", html: CHECK_SVG }), num]);
      const fill = el("span", { class: "cc-fill" });
      const bar = el("button", { class: "cc-bar", type: "button", "aria-label": `${optionLetter(i)} 응답자 보기`, onClick: () => onBarClick?.(o.id) }, [fill]);
      const label = el("span", {}, o.label || optionLetter(i));
      const tile = el("div", { class: "cc-tile", role: onBarClick ? "button" : null, tabindex: onBarClick ? "0" : null,
        onClick: () => { if (!last.veiled) onBarClick?.(o.id); },
        onKeydown: (e) => { if (onBarClick && !last.veiled && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onBarClick(o.id); } },
      }, [label, el("span", { class: "cc-key" }, optionLetter(i)), el("span", { class: "cc-tick", html: CHECK_SVG })]);
      const col = el("div", { class: "cc-col" }, [count, bar, tile]);
      col.style.setProperty("--cc-color", color);
      root.appendChild(col);
      return { id: o.id, col, num, fill, bar, label };
    });
  }
  function setOptions(opts) {
    const same = opts.length === cols.length && opts.every((o, i) => cols[i].id === o.id);
    if (!same) { root.replaceChildren(); build(opts); }
    else opts.forEach((o, i) => { const t = o.label || optionLetter(i); if (cols[i].label.textContent !== t) cols[i].label.textContent = t; });
    update(last);
  }
  // veiled: 결과 가리기(v2.9) — 막대·인원은 숨기고 선지 타일만
  function update({ counts = {}, correctIds = [], revealed = false, veiled = false } = {}) {
    last = { counts, correctIds, revealed, veiled };
    const max = Math.max(1, ...cols.map(c => Number(counts[c.id]) || 0));
    root.classList.toggle("is-veiled", !!veiled);
    if (veiled) { revealed = false; correctIds = []; }
    root.classList.toggle("is-revealed", !!revealed);
    for (const c of cols) {
      const n = Number(counts[c.id]) || 0;
      c.num.textContent = `${n}명`;
      c.fill.style.height = `${Math.max(2, Math.round((n / max) * 100))}%`;
      c.col.classList.toggle("is-correct", correctIds.includes(c.id));
      c.col.classList.toggle("is-revealed", !!revealed);
      c.bar.disabled = !onBarClick || !!veiled;
    }
  }
  root.update = update;
  root.setOptions = setOptions;
  build(options || []);
  update(last);
  return root;
}
const CHECK_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

// ── 누가 답했는지 보기 (교사) ──
// groups: [{ label, color?, correct?, studentIds: [], extra?: { [studentId]: '부가 텍스트' } }]
// 이름은 ctx.students() → '6-2-14 홍길동' 형식, 교사 id 는 '선생님'
export function whoSheet(ctx, { title = "응답한 학생", groups = [], empty = "아직 아무도 없어요" } = {}) {
  const map = (ctx.students && ctx.students()) || new Map();
  const teacherId = ctx.session?.()?.teacherId;
  const nameOf = (id) => {
    if (id && id === teacherId) return "선생님";
    const s = map.get ? map.get(id) : null;
    return s ? `${s.grade}-${s.classNum}-${s.num} ${s.name}` : "알 수 없음";
  };
  const body = el("div", { class: "who" }, groups.map(g => {
    const ids = (g.studentIds || []).slice().sort((a, b) => nameOf(a).localeCompare(nameOf(b), "ko", { numeric: true }));
    const head = el("div", { class: "who-head" }, [
      el("span", { class: "who-dot" }), el("span", {}, g.label || ""),
      g.correct ? el("span", { class: "pill pill-ok" }, "정답") : null,
      el("span", { class: "who-n" }, `${ids.length}명`),
    ]);
    if (g.color) head.firstChild.style.setProperty("--who-color", g.color);
    const names = ids.length
      ? el("div", { class: "who-names" }, ids.map(id => el("span", { class: "who-name" }, [
          el("span", {}, nameOf(id)),
          g.extra && g.extra[id] ? el("span", { class: "who-extra" }, g.extra[id]) : null,
        ])))
      : el("div", { class: "who-empty" }, empty);
    return el("div", { class: "who-group" }, [head, names]);
  }));
  const open = ctx.modal || null;
  if (typeof open === "function") return open({ title, body, actions: [{ label: "닫기", primary: true, onClick: (close) => close() }] });
  return null;
}

// ── 작은 헬퍼 ──
export function optionLetter(i) {
  const n = Math.max(0, Math.floor(i) || 0);
  return n < 26 ? String.fromCharCode(65 + n) : String(n + 1);
}

// 답 비교용 정규화: trim · 연속 공백 1개 · 전각 숫자→반각 · (caseSensitive 아니면) 소문자
export function normalizeAnswer(s, { caseSensitive = false } = {}) {
  let t = String(s ?? "")
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 48))
    .replace(/[\s　]+/g, " ")
    .trim();
  if (!caseSensitive) t = t.toLowerCase();
  return t;
}

function fmtLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ── 카운트다운 pill: 250ms 갱신, 10초 이하 빨강, DOM 에서 빠지면 스스로 정리 ──
export function countdownPill(endsAt) {
  const node = el("span", { class: "pill countdown-pill" });
  let end = Number(endsAt) || 0;
  let seen = false, timer = null;
  function tick() {
    if (node.isConnected) seen = true;
    else if (seen) return stop(); // 붙었다가 떨어짐 → 정리
    const left = end - Date.now();
    node.textContent = fmtLeft(left);
    node.classList.toggle("is-urgent", left <= 10000);
    if (left <= 0) stop();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function start() { stop(); tick(); if (end - Date.now() > 0) timer = setInterval(tick, 250); }
  node.destroy = stop;
  node.setEndsAt = (t) => { end = Number(t) || 0; start(); };
  node.left = () => Math.max(0, end - Date.now());
  start();
  return node;
}

// ── 단계 pill: ended → '마감', running(+endsAt) → 카운트다운, 그 외 비움 ──
export function phasePill(state) {
  const wrap = el("span", { class: "phase-pill" });
  let cd = null, lastKey = null;
  function update(st) {
    const s = st || { phase: "idle" };
    const key = `${s.phase}|${s.endsAt || ""}`;
    if (key === lastKey) return;
    lastKey = key;
    if (cd) { cd.destroy(); cd = null; }
    wrap.replaceChildren();
    if (s.phase === "ended") wrap.appendChild(el("span", { class: "pill pill-muted" }, "마감"));
    else if (s.phase === "running" && s.endsAt) { cd = countdownPill(s.endsAt); wrap.appendChild(cd); }
    else if (s.phase === "running") wrap.appendChild(el("span", { class: "pill pill-live" }, "진행 중"));
  }
  wrap.update = update;
  wrap.destroy = () => { if (cd) cd.destroy(); cd = null; };
  update(state);
  return wrap;
}

// ── 선택지별 가로 막대: rows [{label, count, highlight}] ──
// revealed 전에는 모두 회색, 후에는 highlight 행이 accent
export function choiceBars(rows, total, { revealed = false } = {}) {
  const root = el("div", { class: "bars" });
  let rev = !!revealed;
  let rowEls = [];
  function makeRow() {
    const label = el("span", { class: "bar-label" });
    const fill = el("div", { class: "bar-fill" });
    const value = el("span", { class: "bar-value" });
    const row = el("div", { class: "bar-row" }, [label, el("div", { class: "bar-track" }, [fill]), value]);
    return { row, label, fill, value };
  }
  function update(nextRows, nextTotal, opts) {
    if (opts && "revealed" in opts) rev = !!opts.revealed;
    const list = nextRows || [];
    const sum = list.reduce((a, r) => a + (Number(r.count) || 0), 0);
    const tot = Math.max(Number(nextTotal) || 0, 0);
    const denom = tot || sum;
    while (rowEls.length < list.length) { const r = makeRow(); rowEls.push(r); root.appendChild(r.row); }
    while (rowEls.length > list.length) rowEls.pop().row.remove();
    list.forEach((r, i) => {
      const x = rowEls[i];
      const n = Number(r.count) || 0;
      const pct = denom ? Math.round((n / denom) * 100) : 0;
      if (typeof r.label === "string" || typeof r.label === "number") {
        if (x.label.textContent !== String(r.label)) x.label.textContent = String(r.label);
      } else if (r.label instanceof Node) {
        x.label.replaceChildren(r.label);
      }
      x.fill.style.width = `${pct}%`;
      x.fill.classList.toggle("is-accent", rev && !!r.highlight);
      x.row.classList.toggle("is-highlight", rev && !!r.highlight);
      x.value.textContent = `${n} · ${pct}%`;
    });
  }
  root.update = update;
  update(rows, total);
  return root;
}

// ── 교사 공통 활동 바 (§6.3) ──
// 응답 n/m · [마감]↔[다시 받기] · [정답 공개](reveal) · [타이머](timer, 30/60/90/120초) · [초기화]
// 가정: 응답 수 = 이 슬라이드에 응답한 서로 다른 학생 수, m = 참가자 수.
//       opts.countFn(responses) 로 바꿀 수 있다(예: 문항별 집계).
// 가정: 타이머 만료 → 교사 클라이언트가 phase 'ended' 로 바꾸는 일은 이 바가 담당(ctx.timeout 로 예약).
export function activityBar(ctx, { reveal = false, timer = false, countFn = null, revealLabel = "정답 공개" } = {}) {
  const count = el("span", { class: "pill ab-count" });
  const pill = phasePill(ctx.activity());
  const btnPhase = el("button", { class: "btn btn-sm", type: "button", onClick: onPhase });
  const btnReveal = reveal ? el("button", { class: "btn btn-sm", type: "button", onClick: onReveal }, revealLabel) : null;
  const btnReset = el("button", { class: "btn btn-sm btn-ghost", type: "button", onClick: onReset }, "초기화");

  // 타이머 팝오버
  let pop = null;
  const timerWrap = timer ? el("span", { class: "ab-timer-wrap" }) : null;
  const btnTimer = timer ? el("button", { class: "btn btn-sm", type: "button", onClick: togglePop }, "타이머") : null;
  if (timerWrap) timerWrap.appendChild(btnTimer);

  const bar = el("div", { class: "activity-bar" }, [
    count, pill, el("span", { class: "ab-spacer" }), btnPhase, btnReveal, timerWrap, btnReset,
  ]);

  const later = (fn, ms) => (ctx.timeout ? ctx.timeout(fn, ms) : setTimeout(fn, ms));
  const cancel = (id) => (ctx.clearTimer ? ctx.clearTimer(id) : clearTimeout(id));
  let endTimer = null, endFor = null;

  function onPhase() {
    const a = ctx.activity();
    // 다시 받기: 마감·전원 응답으로 자동 공개된 정답도 다시 숨긴다
    if (a.phase === "ended") ctx.setActivity({ phase: "idle", reveal: false, startedAt: null, endsAt: null });
    else ctx.setActivity({ phase: "ended", endsAt: null });
  }
  function onReveal() { ctx.setActivity({ reveal: !ctx.activity().reveal }); }
  async function onReset() {
    closePop();
    const ok = await ctx.confirm("응답을 모두 지울까요?", { ok: "초기화", danger: true });
    if (!ok) return;
    try { await ctx.clearResponses(); } catch (e) { console.warn("[activityBar] clearResponses", e); }
    ctx.setActivity({ phase: "idle", reveal: false, startedAt: null, endsAt: null });
  }
  function startTimer(sec) {
    closePop();
    const now = Date.now();
    ctx.setActivity({ phase: "running", startedAt: now, endsAt: now + sec * 1000 });
  }
  function togglePop(e) {
    e?.stopPropagation();
    if (pop) return closePop();
    pop = el("div", { class: "ab-pop", onClick: ev => ev.stopPropagation() },
      [30, 60, 90, 120].map(s => el("button", { class: "btn btn-sm", type: "button", onClick: () => startTimer(s) }, `${s}초`)));
    timerWrap.appendChild(pop);
    // click 은 pointerdown 이후라 바로 붙여도 지금 탭에 닫히지 않는다(지연 등록 시 누수 위험)
    document.addEventListener("pointerdown", outside, true);
  }
  function outside(ev) { if (pop && !timerWrap.contains(ev.target)) closePop(); }
  function closePop() {
    document.removeEventListener("pointerdown", outside, true);
    if (pop) { pop.remove(); pop = null; }
  }

  // 타이머 만료 → 마감 (교사 클라이언트)
  function scheduleEnd(a) {
    const want = a.phase === "running" && a.endsAt ? a.endsAt : null;
    if (want === endFor) return;
    if (endTimer != null) { cancel(endTimer); endTimer = null; }
    endFor = want;
    if (!want) return;
    const fire = () => {
      endTimer = null;
      const cur = ctx.activity();
      if (cur.phase === "running" && cur.endsAt === want) ctx.setActivity({ phase: "ended", endsAt: null });
    };
    // 이미 지났어도 다음 틱에 — 플러그인 생성/update 도중 setActivity 재진입 방지
    endTimer = later(fire, Math.max(0, want - Date.now()) + 50);
  }

  function update() {
    const a = ctx.activity() || { phase: "idle" };
    const list = ctx.responses() || [];
    const n = countFn ? countFn(list) : new Set(list.map(r => r.studentId)).size;
    const m = (ctx.participants() || []).length;
    count.textContent = `응답 ${n}/${m}`;
    pill.update(a);
    const ended = a.phase === "ended";
    btnPhase.textContent = ended ? "다시 받기" : "마감";
    btnPhase.classList.toggle("btn-primary", !ended);
    if (btnReveal) {
      btnReveal.classList.toggle("active", !!a.reveal);
      btnReveal.setAttribute("aria-pressed", a.reveal ? "true" : "false");
    }
    if (btnTimer) btnTimer.disabled = ended;
    if (ended) closePop();
    scheduleEnd(a);
  }

  bar.update = update;
  bar.destroy = () => {
    closePop();
    pill.destroy();
    if (endTimer != null) { cancel(endTimer); endTimer = null; }
    endFor = null;
  };
  update();
  return bar;
}

// ── 결과 가리기(v2.9) ──
// 교사 화면에 결과를 보여도 되나: 마감 · 정답 공개 · 타이머 끝. now = 교사 시계(교사 화면은 Date.now())
export function resultsOpen(st, now = Date.now()) {
  const a = st || {};
  if (a.phase === "ended" || a.reveal === true) return true;
  return a.phase === "running" && !!a.endsAt && now >= a.endsAt;
}
const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>';
// 마감 전 자리표시: 큰 응답 수 + 진행 막대 + '마감하면 결과가 보여요'. set(n, m)
export function resultsVeil({ compact = false, note = "마감하면 결과가 보여요" } = {}) {
  const n = el("span", {}, "0");
  const m = el("small", {}, "");
  const fill = el("div", { class: "rv-fill" });
  const node = el("div", { class: "rv-veil" + (compact ? " is-compact" : ""), role: "status" }, [
    el("div", { class: "rv-n" }, [n, m]),
    el("div", { class: "rv-track" }, [fill]),
    el("div", { class: "rv-s" }, [el("span", { html: LOCK_SVG }), note]),
  ]);
  node.set = (count, total) => {
    const c = Math.max(0, Number(count) || 0), t = Math.max(0, Number(total) || 0);
    const ct = String(c), tt = t ? `/ ${t}명 응답` : "명 응답";
    if (n.textContent !== ct) n.textContent = ct;
    if (m.textContent !== tt) m.textContent = tt;
    fill.style.width = `${t ? Math.min(100, Math.round((c / t) * 100)) : 0}%`;
  };
  return node;
}

// ── 문제 그림(v2.9) ──
const IMG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 9"/></svg>';
// 화면 표시(학생·교사·기록). 누르면 크게. 그림이 없으면 null
export function questionImage(img, { small = false } = {}) {
  const url = img && (img.url || img.thumb);
  if (!url) return null;
  const im = el("img", { class: "qi" + (small ? " is-sm" : ""), src: small && img.thumb ? img.thumb : url, alt: "문제 그림", loading: "lazy", decoding: "async", draggable: "false" });
  im.addEventListener("click", (e) => {
    e.stopPropagation();
    const big = el("img", { src: img.url || url, alt: "문제 그림" });
    const back = el("div", { class: "qi-zoom", role: "dialog", "aria-label": "그림 크게 보기" }, [big]);
    const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } };
    back.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(back);
  });
  return el("div", { class: "qi-wrap" }, [im]);
}
// 편집기: [그림 넣기] / 작은 미리보기 · [바꾸기] [빼기]. onChange(image|null). lessonId·slideId = 올릴 폴더
export function imageField({ value = null, lessonId = null, slideId = null, onChange, label = "그림 넣기" } = {}) {
  let cur = value && value.url ? value : null, busy = false;
  const input = el("input", { type: "file", accept: "image/*", hidden: true });
  const root = el("div", { class: "qi-field" });
  function paint() {
    const pick = (text, ghost = false) => el("button", { class: "btn btn-sm" + (ghost ? " btn-ghost" : ""), type: "button", disabled: busy, onClick: () => input.click() },
      [el("span", { html: IMG_SVG }), text]);
    if (busy) { root.replaceChildren(el("span", { class: "spinner" }), el("span", { class: "qi-busy" }, "그림 올리는 중…"), input); return; }
    if (!cur) { root.replaceChildren(pick(label, true), input); return; }
    root.replaceChildren(
      el("img", { class: "qi-thumb", src: cur.thumb || cur.url, alt: "" }),
      pick("바꾸기"),
      el("button", { class: "btn btn-sm btn-ghost", type: "button", onClick: () => { cur = null; paint(); onChange?.(null); } }, "빼기"),
      input,
    );
  }
  input.addEventListener("change", async () => {
    const f = input.files && input.files[0];
    input.value = "";
    if (!f || busy) return;
    if (!/^image\//.test(f.type || "")) return;
    busy = true; paint();
    try {
      const r = await storage.uploadSlideImage(lessonId || "media", slideId || newId("img"), f);
      if (!r || !r.url) throw new Error("업로드 실패");
      cur = { url: r.url, path: r.path || null, thumb: r.thumb || r.url };
      onChange?.(cur);
    } catch (e) {
      console.warn("[imageField] 업로드 실패", e);
      toast("그림을 올리지 못했어요", { type: "error" });
    } finally { busy = false; paint(); }
  });
  paint();
  root.value = () => cur;
  return root;
}

// ── 유튜브 IFrame API 1회 로드 ──
let ytPromise = null;
export function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (ytPromise) return ytPromise;
  ytPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    const to = setTimeout(() => { ytPromise = null; reject(new Error("YouTube API 로드 시간 초과")); }, 15000);
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(to);
      try { if (typeof prev === "function") prev(); } catch (e) { console.warn(e); }
      resolve(window.YT);
    };
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.async = true;
      s.onerror = () => { clearTimeout(to); ytPromise = null; s.remove(); reject(new Error("YouTube API 로드 실패")); };
      document.head.appendChild(s);
    }
  });
  return ytPromise;
}

// ── 문제 편집기 (mcq / videoquiz / dino / race 편집기 공용) ──
// onChange({ question, options, answerIds, image }) — 입력마다 호출(저장 디바운스는 코어 담당)
// answers:false → 정답 표시 칸 없이(설문)
// imageAt: { lessonId, slideId } 를 주면 질문 아래에 [그림 넣기](v2.9). image = 처음 그림
export function questionEditor({
  question = "", options = [], answerIds = [], multiple = false,
  maxOptions = 6, minOptions = 2, placeholder = "질문", onChange, answers: withAnswers = true,
  image = null, imageAt = null,
} = {}) {
  let q = String(question ?? "");
  let opts = (options || []).map(o => ({ id: o.id || newId("opt"), text: o.text ?? "" }));
  while (opts.length < minOptions) opts.push({ id: newId("opt"), text: "" });
  let answers = (answerIds || []).filter(id => opts.some(o => o.id === id));
  let img = image && image.url ? image : null;
  const name = newId("qe");

  const emit = () => onChange?.({ question: q, options: opts.map(o => ({ ...o })), answerIds: answers.slice(), image: img });

  const ta = el("textarea", { rows: "2", placeholder, onInput: () => { q = ta.value; emit(); } });
  ta.value = q;
  const list = el("div", { class: "q-opts" });
  const addBtn = el("button", { class: "btn btn-sm", type: "button", onClick: () => {
    if (opts.length >= maxOptions) return;
    opts.push({ id: newId("opt"), text: "" });
    render(); emit();
    list.querySelector(".q-opt:last-child input[type=text]")?.focus();
  } }, "+ 선택지");

  function render() {
    list.replaceChildren(...opts.map((o, i) => {
      const mark = el("input", {
        type: multiple ? "checkbox" : "radio", name, title: "정답",
        onChange: () => {
          if (multiple) answers = mark.checked ? [...new Set([...answers, o.id])] : answers.filter(x => x !== o.id);
          else answers = [o.id];
          emit();
        },
      });
      mark.checked = answers.includes(o.id);
      const input = el("input", { type: "text", class: "input", placeholder: `선택지 ${optionLetter(i)}`,
        onInput: () => { o.text = input.value; emit(); } });
      input.value = o.text;
      const del = el("button", { class: "btn btn-icon btn-ghost", type: "button", title: "삭제",
        disabled: opts.length <= minOptions, onClick: () => {
          if (opts.length <= minOptions) return;
          opts = opts.filter(x => x !== o);
          answers = answers.filter(x => x !== o.id);
          render(); emit();
        } }, "×");
      return el("div", { class: "q-opt" }, [withAnswers ? mark : null, el("span", { class: "q-key" }, optionLetter(i)), input, del]);
    }));
    addBtn.disabled = opts.length >= maxOptions;
  }
  render();

  const imgField = imageAt ? imageField({ value: img, lessonId: imageAt.lessonId, slideId: imageAt.slideId, onChange: (v) => { img = v; emit(); } }) : null;
  const root = el("div", { class: "q-editor" }, [
    el("label", { class: "field" }, [ta]),
    imgField,
    list,
    el("div", {}, [addBtn]),
  ]);
  root.value = () => ({ question: q, options: opts.map(o => ({ ...o })), answerIds: answers.slice(), image: img });
  return root;
}
