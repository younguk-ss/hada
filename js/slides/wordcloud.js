// 워드클라우드 — 학생이 단어 몇 개를 내면 빈도에 따라 크기가 다른 구름으로 모인다. (§6.4)
// 가정: payload = { words: string[] } (정리된 원문 표기). 집계 키 = 영문 소문자/한글 그대로(normKey).
// 가정: 같은 키의 표시 표기는 가장 먼저 나온 표기를 쓴다.
// 가정: 타이머 만료 시 교사 측 phase 'ended' 처리는 common.js activityBar 가 맡는다(학생은 로컬로도 잠금).
// 가정: countdownPill(endsAt) 은 스스로 갱신되는 HTMLElement 를 반환한다(destroy 가 있으면 호출).
import { el } from "../ui.js";
import { registerSlideType, injectCss } from "./registry.js";
import { activityBar, countdownPill } from "./common.js";

const MAX_LEN = 12, TOP_N = 60, MIN_PX = 14, MAX_PX = 64, PAD = 3;
const COLORS = ["var(--ink)", "var(--accent)", "var(--ok)", "var(--warn)"];

const CSS = `
.wc{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;padding:16px;box-sizing:border-box}
.wc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.wc-prompt{margin:0;font-size:22px;font-weight:700;line-height:1.35;color:var(--ink);white-space:pre-wrap;word-break:keep-all}
.wc-prompt:empty{display:none}
.wc-status{flex:none}
.wc-cloud{position:relative;flex:1;min-height:220px;overflow:hidden;border-radius:var(--radius);background:var(--surface);border:1px solid var(--line)}
.wc-word{position:absolute;white-space:nowrap;line-height:1.15;font-weight:700;user-select:none;-webkit-user-select:none;
  transition:left .35s ease,top .35s ease,font-size .35s ease,opacity .25s ease}
.wc-tap .wc-word{cursor:pointer}
.wc-tap .wc-word:hover{opacity:.55;text-decoration:line-through}
.wc-cloud>.empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.wc-form{display:flex;flex-direction:column;gap:10px;width:100%;max-width:420px;margin:auto}
.wc-mine{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.wc-chip{display:inline-flex;align-items:center;height:30px;padding:0 12px;border-radius:999px;background:var(--accent-soft);color:var(--accent-ink);font-weight:600;font-size:14px}
.wc-mine .btn{margin-left:auto}
.wc-panel{display:flex;flex-direction:column;gap:2px}
.wc-row{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 4px;border-bottom:1px solid var(--line)}
.wc-row-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wc-row-n{color:var(--muted);font-variant-numeric:tabular-nums}
.wc-row.off .wc-row-text{color:var(--muted);text-decoration:line-through}
.wc-editor{display:flex;flex-direction:column;gap:14px;width:100%;max-width:560px;margin:0 auto;padding:24px;box-sizing:border-box}
.wc-sum .wc-cloud{height:260px;flex:none}
`;
function ensureCss(ctx) { (ctx?.injectCss || injectCss)("wordcloud", CSS); }

// ── 단어 정리·집계 ──
export function cleanWord(w) {
  const s = String(w ?? "").trim().replace(/\s+/g, " ");
  return Array.from(s).slice(0, MAX_LEN).join("");
}
export function normKey(w) { return cleanWord(w).toLowerCase(); }

// responses → [{ key, text, n }] 빈도 내림차순 (hidden 키 제외)
export function countWords(responses, hidden = []) {
  const hid = new Set(hidden || []);
  const map = new Map();
  for (const r of responses || []) {
    const seen = new Set();
    for (const raw of r?.payload?.words || []) {
      const text = cleanWord(raw);
      const key = text.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const cur = map.get(key);
      if (cur) cur.n++;
      else map.set(key, { key, text, n: 1 });
    }
  }
  return [...map.values()].filter(w => !hid.has(w.key))
    .sort((a, b) => b.n - a.n || a.text.localeCompare(b.text, "ko"));
}

// 교사 시계 기준 현재 시각: 코어가 ctx.now()(학생 기기의 교사 시계 추정)를 주면 그것, 없으면 Date.now()
// 가정: endsAt 은 교사 시계 기준. common.countdownPill 은 Date.now() 를 쓰므로 이 기기 시각으로 바꿔 넘긴다(100ms 반올림).
function clockNow(ctx) {
  try {
    const t = typeof ctx?.now === "function" ? Number(ctx.now()) : NaN;
    if (Number.isFinite(t)) return t;
  } catch { /* 무시 */ }
  return Date.now();
}
function toLocalTime(ctx, t) {
  if (!t) return t;
  return t - Math.round((clockNow(ctx) - Date.now()) / 100) * 100;
}

function isLocked(st, now = Date.now()) {
  return st?.phase === "ended" || (st?.phase === "running" && st.endsAt && now >= st.endsAt);
}

// ── 클라우드 (아르키메데스 나선 + AABB 충돌) ──
let measureCtx = null;
function measure(text, size, family) {
  measureCtx ||= document.createElement("canvas").getContext("2d");
  measureCtx.font = `700 ${size}px ${family}`;
  return measureCtx.measureText(text).width;
}

function spiralPlace(items, W, H) {
  const placed = [];
  const cx = W / 2, cy = H / 2;
  const ax = Math.sqrt(W / H), ay = 1 / ax;            // 가로로 긴 영역이면 타원형 나선
  const maxR = Math.hypot(W, H) / 2 + 10;
  let ok = true;
  for (const it of items) {
    const w = it.w + PAD * 2, h = it.h + PAD * 2;
    let pos = null, last = null;
    for (let t = 0; ; t += 0.1) {
      const r = 1.6 * t;
      if (r > maxR) break;
      const x = cx + r * Math.cos(t) * ax - w / 2;
      const y = cy + r * Math.sin(t) * ay - h / 2;
      if (x < 0 || y < 0 || x + w > W || y + h > H) continue;
      const box = { x, y, w, h };
      if (last && hit(box, last)) continue;            // 직전 충돌 상자부터 빠르게 확인
      const c = placed.find(p => hit(box, p));
      if (c) { last = c; continue; }
      pos = box; break;
    }
    if (pos) { placed.push(pos); it.x = pos.x + PAD; it.y = pos.y + PAD; it.placed = true; }
    else { it.placed = false; ok = false; }
  }
  return ok;
}
function hit(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }

// { el, set(list), destroy() } — 같은 단어 span 은 재사용(위치만 이동, 깜빡임 없음)
function createCloud({ onTap } = {}) {
  const root = el("div", { class: "wc-cloud" + (onTap ? " wc-tap" : "") });
  const emptyEl = el("div", { class: "empty" }, "아직 응답이 없어요");
  const spans = new Map();
  const colorIdx = new Map();   // 키별 색 고정(순위가 바뀌어도 색이 튀지 않게, 처음 나온 순서로 4색 순환)
  let list = [], raf = 0, lastSig = "";

  function schedule() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(layout);
  }
  function layout() {
    const W = root.clientWidth, H = root.clientHeight;
    if (!W || !H) return;
    const top = list.slice(0, TOP_N);
    const sig = `${W}x${H}|` + top.map(w => `${w.key}:${w.n}`).join(",");
    if (sig === lastSig) return;
    lastSig = sig;
    if (!top.length) { if (!emptyEl.parentNode) root.appendChild(emptyEl); }
    else emptyEl.remove();

    const family = getComputedStyle(root).fontFamily || "sans-serif";
    const max = top.length ? top[0].n : 1, min = top.length ? top[top.length - 1].n : 1;
    const base = top.map((w, i) => ({
      ...w, i,
      size: max === min ? (top.length > 20 ? 28 : 40) : MIN_PX + (w.n - min) / (max - min) * (MAX_PX - MIN_PX),
    }));
    // 면적으로 시작 배율을 어림잡고(재시도 횟수 줄이기), 다 안 들어가면 더 줄여 다시 배치
    let area = 0;
    for (const w of base) area += (measure(w.text, w.size, family) + PAD * 2) * (w.size * 1.15 + PAD * 2);
    const start = Math.min(1, Math.sqrt((W * H * 0.5) / Math.max(1, area)));
    let items = [];
    for (const k of [1, 0.85, 0.72, 0.6, 0.5, 0.42]) {
      const scale = start * k;
      items = base.map(w => {
        const size = Math.max(10, Math.round(w.size * scale));
        return { ...w, size, w: measure(w.text, size, family), h: size * 1.15 };
      });
      if (spiralPlace(items, W, H)) break;
    }
    const keep = new Set();
    for (const it of items) {
      keep.add(it.key);
      let sp = spans.get(it.key);
      const fresh = !sp;
      if (fresh) {
        sp = el("span", { class: "wc-word", title: onTap ? "숨기기" : null });
        if (onTap) sp.addEventListener("click", () => onTap(it.key));
        sp.style.opacity = "0";
        spans.set(it.key, sp);
        root.appendChild(sp);
      }
      sp.textContent = it.text;
      if (!colorIdx.has(it.key)) colorIdx.set(it.key, colorIdx.size % COLORS.length);
      sp.style.color = COLORS[colorIdx.get(it.key)];
      sp.style.fontSize = it.size + "px";
      sp.style.display = it.placed ? "" : "none";
      if (fresh) {
        // 처음 나타나는 단어는 제자리에서 페이드 인
        sp.style.transition = "none";
        sp.style.left = it.x + "px"; sp.style.top = it.y + "px";
        sp.getBoundingClientRect();
        sp.style.transition = "";
      } else {
        sp.style.left = it.x + "px"; sp.style.top = it.y + "px";
      }
      sp.style.opacity = "1";
    }
    for (const [k, sp] of spans) if (!keep.has(k)) { sp.remove(); spans.delete(k); }
  }

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
  ro?.observe(root);
  root.appendChild(emptyEl);
  return {
    el: root,
    set(next) { list = next || []; schedule(); },
    destroy() { cancelAnimationFrame(raf); ro?.disconnect(); },
  };
}

// ── 학생 상태 pill (마감 / 남은 시간 / 제출함) ──
function statusPill(slot, st, submitted, prev, ctx) {
  const locked = isLocked(st, clockNow(ctx));
  const key = locked ? "ended" : st?.phase === "running" && st.endsAt ? `run:${st.endsAt}` : submitted ? "done" : "none";
  if (key === prev.key) return;
  prev.node?.destroy?.();
  slot.innerHTML = "";
  prev.key = key; prev.node = null;
  if (key === "ended") slot.appendChild(el("span", { class: "pill pill-muted" }, "마감"));
  else if (key.startsWith("run:")) {
    try { prev.node = countdownPill(toLocalTime(ctx, st.endsAt)); if (prev.node) slot.appendChild(prev.node); } catch (e) { console.warn(e); }
  } else if (key === "done") slot.appendChild(el("span", { class: "pill pill-ok" }, "제출함"));
}

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.5 4.5 0 0 0 7 18z"/><path d="M9 14h6M10.5 11.5h3"/></svg>`;

registerSlideType({
  type: "wordcloud",
  category: "interact",
  label: "워드클라우드",
  desc: "학생 단어를 모아 구름으로 보여줘요",
  icon: ICON,

  create() {
    return { type: "wordcloud", config: { prompt: "", maxWords: 3 } };
  },

  validate(slide) {
    return (slide.config?.prompt || "").trim() ? null : "질문을 입력하세요";
  },

  Editor({ slide, update, ctx }) {
    ensureCss(ctx);
    const cfg = () => slide.config || {};
    const prompt = el("textarea", { class: "input", rows: 3, placeholder: "질문 (예: 오늘 수업을 한 단어로?)" });
    prompt.value = cfg().prompt || "";
    prompt.addEventListener("input", () => update({ config: { ...cfg(), prompt: prompt.value } }));

    const seg = el("div", { class: "seg" });
    const drawSeg = () => {
      seg.innerHTML = "";
      for (let n = 1; n <= 5; n++) {
        seg.appendChild(el("button", {
          type: "button", class: (cfg().maxWords || 3) === n ? "active" : "",
          onClick: () => { update({ config: { ...cfg(), maxWords: n } }); drawSeg(); },
        }, String(n)));
      }
    };
    drawSeg();

    const root = el("div", { class: "wc-editor" }, [
      el("label", { class: "field" }, [el("span", {}, "질문"), prompt]),
      el("div", { class: "field" }, [el("span", {}, "학생당 단어 수"), seg]),
    ]);
    return { el: root };
  },

  Student({ slide, ctx }) {
    ensureCss(ctx);
    const cfg = slide.config || {};
    const maxWords = Math.min(10, Math.max(1, cfg.maxWords || 3));
    let editing = !ctx.myResponse();
    let busy = false, timer = 0, cloudTimer = 0, mineSig = null;
    const pillState = {};

    const status = el("div", { class: "wc-status" });
    const inputs = Array.from({ length: maxWords }, (_, i) => {
      const inp = el("input", { class: "input", maxlength: MAX_LEN, placeholder: `단어 ${i + 1}`, autocomplete: "off" });
      inp.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.isComposing) return;
        e.preventDefault();
        if (i < maxWords - 1) inputs[i + 1].focus(); else submit();
      });
      return inp;
    });
    const submitBtn = el("button", { type: "button", class: "btn btn-primary btn-block", onClick: () => submit() }, "제출");
    const form = el("div", { class: "wc-form" }, [...inputs, submitBtn]);

    const cloud = createCloud();
    const mine = el("div", { class: "wc-mine" });
    const view = el("div", { style: { display: "contents" } }, [cloud.el, mine]);

    const root = el("div", { class: "wc wc-stu" }, [
      el("div", { class: "wc-head" }, [el("h2", { class: "wc-prompt" }, cfg.prompt || ""), status]),
      form, view,
    ]);

    function fillInputs() {
      const words = ctx.myResponse()?.payload?.words || [];
      inputs.forEach((inp, i) => { inp.value = words[i] || ""; });
    }
    fillInputs();

    async function submit() {
      if (busy) return;
      if (isLocked(ctx.activity(), clockNow(ctx))) { ctx.toast("마감됐어요"); render(); return; }
      const seen = new Set(), words = [];
      for (const inp of inputs) {
        const w = cleanWord(inp.value), k = w.toLowerCase();
        if (!k || seen.has(k)) continue;
        seen.add(k); words.push(w);
      }
      if (!words.length) { ctx.toast("단어를 입력하세요"); return; }
      busy = true; submitBtn.disabled = true;
      try {
        await ctx.submit({ words });
        editing = false;
      } catch (e) { /* ctx.submit 이 toast 처리 */ }
      busy = false; submitBtn.disabled = false;
      render();
    }

    // 제출 후(또는 마감 후)에는 입력칸 대신 전체 학생의 라이브 클라우드(hidden 제외)를 보여 준다(참여 보상).
    // 응답이 몰려 들어올 때는 재배치를 ~200ms 모아서 한 번에(debounce). 같은 단어 span 은 재사용돼 DOM 이 유지된다.
    function updateCloud(debounce) {
      clearTimeout(cloudTimer);
      const run = () => { cloudTimer = 0; cloud.set(countWords(ctx.responses(), ctx.activity()?.hidden)); };
      if (debounce) cloudTimer = setTimeout(run, 200); else run();
    }

    function render(debounce = false) {
      const st = ctx.activity() || {};
      const locked = isLocked(st, clockNow(ctx));
      const my = ctx.myResponse();
      if (locked) editing = false;
      form.style.display = editing ? "" : "none";
      view.style.display = editing ? "none" : "contents";
      statusPill(status, st, !!my, pillState, ctx);

      // 내 단어 칩 + '수정' 버튼: 바뀐 때만 다시 그림(onResponses 마다 DOM 을 갈아엎지 않게)
      const words = my?.payload?.words || [];
      const showBtn = !locked && !editing;
      const sig = JSON.stringify([words, showBtn, !!my]);
      if (sig !== mineSig) {
        mineSig = sig;
        mine.innerHTML = "";
        if (words.length) words.forEach(w => mine.appendChild(el("span", { class: "wc-chip" }, w)));
        if (showBtn) {
          mine.appendChild(el("button", { type: "button", class: "btn btn-sm", onClick: () => { fillInputs(); editing = true; render(); inputs[0].focus(); } }, my ? "수정" : "쓰기"));
        }
      }
      updateCloud(debounce);

      // 타이머 만료 시 로컬 잠금
      clearTimeout(timer);
      if (st.phase === "running" && st.endsAt && !locked) timer = setTimeout(render, Math.max(0, st.endsAt - clockNow(ctx)) + 50);
    }
    render();

    return {
      el: root,
      onActivity: () => render(),
      onResponses: () => render(true),
      destroy() { clearTimeout(timer); clearTimeout(cloudTimer); cloud.destroy(); pillState.node?.destroy?.(); },
    };
  },

  TeacherLive({ slide, ctx }) {
    ensureCss(ctx);
    const cfg = slide.config || {};
    const bar = activityBar(ctx, { reveal: false, timer: false });
    const hide = (key) => {
      const hidden = ctx.activity().hidden || [];
      if (!hidden.includes(key)) ctx.setActivity({ hidden: [...hidden, key] });
    };
    const unhide = (key) => ctx.setActivity({ hidden: (ctx.activity().hidden || []).filter(k => k !== key) });
    const cloud = createCloud({ onTap: hide });

    const root = el("div", { class: "wc wc-teacher" }, [
      el("div", { class: "wc-head" }, [el("h2", { class: "wc-prompt" }, cfg.prompt || "")]),
      bar, cloud.el,
    ]);

    // 패널: 단어 목록 + 숨김/보임 토글
    const panel = el("div", { class: "wc-panel" });
    function drawPanel(all, hidden) {
      panel.innerHTML = "";
      if (!all.length) { panel.appendChild(el("div", { class: "empty" }, "아직 응답이 없어요")); return; }
      for (const w of all) {
        const off = hidden.has(w.key);
        panel.appendChild(el("div", { class: "wc-row" + (off ? " off" : "") }, [
          el("span", { class: "wc-row-text" }, w.text),
          el("span", { class: "wc-row-n" }, String(w.n)),
          el("button", { type: "button", class: "btn btn-sm btn-ghost", onClick: () => (off ? unhide(w.key) : hide(w.key)) }, off ? "보이기" : "숨기기"),
        ]));
      }
    }

    function refresh() {
      const st = ctx.activity();
      const hidden = new Set(st.hidden || []);
      const all = countWords(ctx.responses());
      cloud.set(all.filter(w => !hidden.has(w.key)));
      drawPanel(all, hidden);
    }
    refresh();

    return {
      el: root,
      panel,
      onActivity() { bar.update?.(); refresh(); },
      onResponses() { bar.update?.(); refresh(); },
      onSession() { bar.update?.(); },
      destroy() { cloud.destroy(); bar.destroy?.(); },
    };
  },

  summary(slide, responses, session, ctx) {
    ensureCss(ctx);
    const hidden = session?.activity?.[slide.id]?.hidden || [];
    const cloud = createCloud();
    cloud.set(countWords(responses, hidden));
    return el("div", { class: "wc wc-sum" }, [
      el("h3", { class: "wc-prompt" }, slide.config?.prompt || ""),
      cloud.el,
    ]);
  },
});
