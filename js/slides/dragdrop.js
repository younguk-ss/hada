// 분류하기 — 항목을 알맞은 분류(버킷)로 옮긴다. HTML5 drag API 대신 pointer 이벤트 + 고스트. (§6.4)
// 가정: payload = { placements: { [itemId]: bucketId } }. score = 맞은 수/전체(0..1), correct = score===1.
// 가정: reveal 중에는 입력을 잠그고, 표시는 제출한 배치 기준으로 한다.
// 가정: 타이머 만료 시 교사 측 phase 'ended' 처리는 common.js activityBar 가 맡는다(학생은 로컬로도 잠금).
// 가정: countdownPill(endsAt) 은 스스로 갱신되는 HTMLElement 를 반환한다(destroy 가 있으면 호출).
import { el } from "../ui.js";
import { registerSlideType, injectCss, newId, shuffle } from "./registry.js";
import { activityBar, countdownPill, choiceBars } from "./common.js";

const MIN_B = 2, MAX_B = 4, MIN_I = 2, MAX_I = 12;

const CSS = `
.dd{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;padding:16px;box-sizing:border-box;overflow:auto}
.dd-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.dd-prompt{margin:0;font-size:20px;font-weight:700;line-height:1.35;color:var(--ink);white-space:pre-wrap;word-break:keep-all}
.dd-prompt:empty{display:none}
.dd-status{flex:none}
.dd-tray{display:flex;flex-wrap:wrap;gap:8px;min-height:60px;padding:10px;border:1.5px dashed var(--line-strong);border-radius:var(--radius);background:var(--surface-2);align-content:flex-start}
.dd-tray:empty::after{content:"모두 옮겼어요";color:var(--muted);font-size:14px;margin:auto}
.dd-buckets{display:grid;gap:10px;flex:1;min-height:0}
.dd-bucket{display:flex;flex-direction:column;min-height:140px;border:1.5px solid var(--line);border-radius:var(--radius);background:var(--surface);transition:border-color .15s,background .15s;cursor:default}
.dd-bucket.armed{cursor:pointer;border-color:var(--accent)}
.dd-bucket.over{border-color:var(--accent);background:var(--accent-soft)}
.dd-bucket-label{padding:10px 12px;font-weight:700;border-bottom:1px solid var(--line);text-align:center}
.dd-bucket-body{display:flex;flex-wrap:wrap;gap:8px;padding:10px;align-content:flex-start;flex:1}
.dd-tray.over{border-color:var(--accent);background:var(--accent-soft)}
.dd-chip{position:relative;display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:8px 14px;box-sizing:border-box;border:1.5px solid var(--line-strong);border-radius:var(--radius-sm);
  background:var(--surface);color:var(--ink);font-size:16px;font-weight:600;line-height:1.3;touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab;box-shadow:var(--shadow-1)}
.dd-chip.selected{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.dd-chip.dragging{opacity:.3}
.dd-chip.locked{cursor:default}
.dd-chip.ok{border-color:var(--ok);background:var(--ok-soft)}
.dd-chip.bad{border-color:var(--danger);background:var(--danger-soft)}
.dd-mark{font-weight:800}
.dd-chip.ok .dd-mark{color:var(--ok)}
.dd-chip.bad .dd-mark{color:var(--danger)}
.dd-answer{font-size:12px;font-weight:600;padding:2px 6px;border-radius:6px;background:var(--highlight);color:var(--ink)}
.dd-ghost{position:fixed;left:0;top:0;z-index:1000;pointer-events:none;margin:0;opacity:.95;box-shadow:var(--shadow-2);cursor:grabbing;transform:rotate(-2deg)}
.dd-foot{display:flex;align-items:center;gap:10px}
.dd-foot .btn{margin-left:auto;min-width:120px}
.dd-score{font-weight:700}
@media (max-width:768px){.dd-buckets{grid-template-columns:1fr !important}.dd-bucket{min-height:96px}}
.dd-result{display:flex;flex-direction:column;gap:10px}
.dd-to{color:var(--muted);margin-left:6px;font-size:12px}
.dd-avg{color:var(--ink-2);font-size:14px}
.dd-editor{display:flex;flex-direction:column;gap:14px;width:100%;max-width:600px;margin:0 auto;padding:24px;box-sizing:border-box}
.dd-erow{display:flex;align-items:center;gap:8px}
.dd-erow .input{flex:1}
.dd-erow select.input{flex:none;width:130px}
.dd-elist{display:flex;flex-direction:column;gap:8px}
`;
function ensureCss(ctx) { (ctx?.injectCss || injectCss)("dragdrop", CSS); }

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

// 채점: { n: 맞은 수, total, score, correct }
export function gradePlacements(cfg, placements) {
  const items = cfg?.items || [];
  const total = items.length;
  const n = items.filter(i => placements?.[i.id] === i.bucketId).length;
  const score = total ? n / total : 0;
  return { n, total, score, correct: total > 0 && n === total };
}

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

// 아이템별 정답률 막대 (common.js choiceBars 재사용) → { el, update(responses) }
function itemBars(cfg) {
  const buckets = new Map((cfg.buckets || []).map(b => [b.id, b.label]));
  const avg = el("div", { class: "dd-avg" });
  const empty = el("div", { class: "empty" }, "아직 응답이 없어요");
  const bars = choiceBars([], 0, { revealed: true });
  const wrap = el("div", { class: "dd-result" }, [avg, bars, empty]);
  function update(responses) {
    const list = (responses || []).filter(r => r?.payload?.placements);
    empty.style.display = list.length ? "none" : "";
    bars.style.display = avg.style.display = list.length ? "" : "none";
    let sum = 0;
    for (const r of list) sum += gradePlacements(cfg, r.payload.placements).score;
    avg.textContent = list.length ? `평균 정답률 ${Math.round(sum / list.length * 100)}% · ${list.length}명` : "";
    const rows = (cfg.items || []).map(it => ({
      label: el("span", { title: it.text || "" }, [it.text || "—", el("small", { class: "dd-to" }, `→ ${buckets.get(it.bucketId) || "?"}`)]),
      count: list.filter(r => r.payload.placements[it.id] === it.bucketId).length,
      highlight: true,
    }));
    bars.update(rows, list.length, { revealed: true });
  }
  return { el: wrap, update };
}

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><rect x="8" y="3" width="8" height="5" rx="1.5"/><path d="M12 8v2.5M12 10.5l-4 2M12 10.5l4 2"/></svg>`;

registerSlideType({
  type: "dragdrop",
  category: "interact",
  label: "분류하기",
  desc: "항목을 알맞은 분류로 옮겨요",
  icon: ICON,

  create() {
    const a = { id: newId("b"), label: "A" }, b = { id: newId("b"), label: "B" };
    return {
      type: "dragdrop",
      config: {
        prompt: "",
        buckets: [a, b],
        items: [a, a, b, b].map(bk => ({ id: newId("it"), text: "", bucketId: bk.id })),
      },
    };
  },

  validate(slide) {
    const c = slide.config || {};
    const bs = c.buckets || [], its = c.items || [];
    if (bs.length < MIN_B) return "분류를 2개 이상 만드세요";
    if (bs.some(b => !(b.label || "").trim())) return "분류 이름을 입력하세요";
    if (its.length < MIN_I) return "항목을 2개 이상 만드세요";
    if (its.some(i => !(i.text || "").trim())) return "항목 내용을 입력하세요";
    const ids = new Set(bs.map(b => b.id));
    if (its.some(i => !ids.has(i.bucketId))) return "항목의 정답 분류를 선택하세요";
    return null;
  },

  Editor({ slide, update, ctx }) {
    ensureCss(ctx);
    const cfg = () => slide.config || {};
    const set = (patch) => update({ config: { ...cfg(), ...patch } });

    const prompt = el("textarea", { class: "input", rows: 2, placeholder: "안내 (예: 동물과 식물로 나누어 보세요)" });
    prompt.value = cfg().prompt || "";
    prompt.addEventListener("input", () => set({ prompt: prompt.value }));

    const bucketList = el("div", { class: "dd-elist" });
    const itemList = el("div", { class: "dd-elist" });
    const addBucket = el("button", { type: "button", class: "btn btn-sm", onClick: () => {
      const bs = cfg().buckets || [];
      if (bs.length >= MAX_B) return;
      set({ buckets: [...bs, { id: newId("b"), label: String.fromCharCode(65 + bs.length) }] });
      draw();
    } }, "+ 분류");
    const addItem = el("button", { type: "button", class: "btn btn-sm", onClick: () => {
      const its = cfg().items || [];
      if (its.length >= MAX_I) return;
      set({ items: [...its, { id: newId("it"), text: "", bucketId: cfg().buckets?.[0]?.id || null }] });
      draw();
      itemList.lastElementChild?.querySelector("input")?.focus();
    } }, "+ 항목");

    function draw() {
      const bs = cfg().buckets || [], its = cfg().items || [];
      bucketList.innerHTML = "";
      bs.forEach((b) => {
        const inp = el("input", { class: "input", maxlength: 20, placeholder: "분류 이름" });
        inp.value = b.label || "";
        inp.addEventListener("input", () => {
          set({ buckets: (cfg().buckets || []).map(x => x.id === b.id ? { ...x, label: inp.value } : x) });
          // 항목의 select 라벨만 갱신 (포커스 유지)
          itemList.querySelectorAll(`option[value="${b.id}"]`).forEach(o => { o.textContent = inp.value || "?"; });
        });
        bucketList.appendChild(el("div", { class: "dd-erow" }, [
          inp,
          el("button", { type: "button", class: "btn btn-icon btn-ghost", title: "삭제", disabled: bs.length <= MIN_B, onClick: () => {
            const rest = (cfg().buckets || []).filter(x => x.id !== b.id);
            if (rest.length < MIN_B) return;
            const items = (cfg().items || []).map(i => i.bucketId === b.id ? { ...i, bucketId: rest[0].id } : i);
            set({ buckets: rest, items });
            draw();
          } }, "✕"),
        ]));
      });
      addBucket.disabled = bs.length >= MAX_B;

      itemList.innerHTML = "";
      its.forEach((it) => {
        const inp = el("input", { class: "input", maxlength: 40, placeholder: "항목" });
        inp.value = it.text || "";
        inp.addEventListener("input", () => set({ items: (cfg().items || []).map(x => x.id === it.id ? { ...x, text: inp.value } : x) }));
        const sel = el("select", { class: "input" }, bs.map(b => el("option", { value: b.id }, b.label || "?")));
        sel.value = bs.some(b => b.id === it.bucketId) ? it.bucketId : (bs[0]?.id || "");
        sel.addEventListener("change", () => set({ items: (cfg().items || []).map(x => x.id === it.id ? { ...x, bucketId: sel.value } : x) }));
        itemList.appendChild(el("div", { class: "dd-erow" }, [
          inp, sel,
          el("button", { type: "button", class: "btn btn-icon btn-ghost", title: "삭제", disabled: its.length <= MIN_I, onClick: () => {
            const rest = (cfg().items || []).filter(x => x.id !== it.id);
            if (rest.length < MIN_I) return;
            set({ items: rest });
            draw();
          } }, "✕"),
        ]));
      });
      addItem.disabled = its.length >= MAX_I;
    }
    draw();

    const root = el("div", { class: "dd-editor" }, [
      el("label", { class: "field" }, [el("span", {}, "안내"), prompt]),
      el("div", { class: "field" }, [el("span", {}, "분류"), bucketList, el("div", {}, [addBucket])]),
      el("div", { class: "field" }, [el("span", {}, "항목 · 정답 분류"), itemList, el("div", {}, [addItem])]),
    ]);
    return { el: root };
  },

  Student({ slide, ctx }) {
    ensureCss(ctx);
    const cfg = slide.config || {};
    const buckets = cfg.buckets || [];
    const items = cfg.items || [];
    const bucketIds = new Set(buckets.map(b => b.id));
    const labelOf = (id) => buckets.find(b => b.id === id)?.label || "?";

    const place = {};
    const loadMine = () => {
      const p = ctx.myResponse()?.payload?.placements || {};
      for (const it of items) place[it.id] = bucketIds.has(p[it.id]) ? p[it.id] : null;
    };
    loadMine();
    const order = shuffle(items.map(i => i.id));   // 트레이 순서는 마운트 때 1회 섞음

    let selected = null, dirty = false, busy = false, timer = 0, drag = null, suppressClick = false;
    let wasReveal = !!ctx.activity().reveal;
    const pillState = {};
    const locked = () => isLocked(ctx.activity(), clockNow(ctx)) || !!ctx.activity().reveal;

    const status = el("div", { class: "dd-status" });
    const tray = el("div", { class: "dd-tray", "data-drop": "tray", onClick: () => {
      if (!locked() && selected && place[selected]) move(selected, null);
    } });
    const bodies = new Map();
    const bucketEls = new Map();
    const bucketWrap = el("div", { class: "dd-buckets", style: { gridTemplateColumns: `repeat(${Math.max(1, buckets.length)}, minmax(0,1fr))` } },
      buckets.map(b => {
        const body = el("div", { class: "dd-bucket-body" });
        bodies.set(b.id, body);
        const bel = el("div", { class: "dd-bucket", "data-drop": b.id, onClick: () => {
          if (!locked() && selected) move(selected, b.id);
        } }, [el("div", { class: "dd-bucket-label" }, b.label || ""), body]);
        bucketEls.set(b.id, bel);
        return bel;
      }));
    const scoreEl = el("span", { class: "dd-score" });
    const submitBtn = el("button", { type: "button", class: "btn btn-primary", onClick: () => submit() }, "제출");
    const root = el("div", { class: "dd dd-stu" }, [
      el("div", { class: "dd-head" }, [el("h2", { class: "dd-prompt" }, cfg.prompt || ""), status]),
      tray, bucketWrap,
      el("div", { class: "dd-foot" }, [scoreEl, submitBtn]),
    ]);

    // 칩 (DOM 보존, 위치만 이동)
    const chips = new Map();
    for (const it of items) {
      const chip = el("div", { class: "dd-chip", "data-id": it.id });
      chip.addEventListener("pointerdown", (e) => onDown(e, it.id, chip));
      chip.addEventListener("pointermove", onMove);
      chip.addEventListener("pointerup", onUp);
      chip.addEventListener("pointercancel", () => endDrag(false));
      chip.addEventListener("lostpointercapture", () => endDrag(false));
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        if (suppressClick) { suppressClick = false; return; }
        if (locked()) return;
        selected = selected === it.id ? null : it.id;
        render();
      });
      chips.set(it.id, chip);
    }

    // ── 드래그 (pointer + 고스트 + elementFromPoint) ──
    function onDown(e, id, chip) {
      if (locked() || (e.button != null && e.button > 0) || drag) return;
      drag = { id, chip, pid: e.pointerId, x0: e.clientX, y0: e.clientY, started: false, ghost: null, ox: 0, oy: 0, over: null };
      try { chip.setPointerCapture(e.pointerId); } catch {}
    }
    function onMove(e) {
      if (!drag || e.pointerId !== drag.pid) return;
      if (!drag.started) {
        if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
        const r = drag.chip.getBoundingClientRect();
        drag.ox = drag.x0 - r.left; drag.oy = drag.y0 - r.top;
        const g = drag.chip.cloneNode(true);
        g.classList.remove("selected", "dragging");
        g.classList.add("dd-ghost");
        g.style.width = r.width + "px";
        document.body.appendChild(g);
        drag.ghost = g;
        drag.started = true;
        drag.chip.classList.add("dragging");
        selected = null;
        render();
      }
      e.preventDefault();
      drag.ghost.style.transform = `translate(${e.clientX - drag.ox}px, ${e.clientY - drag.oy}px) rotate(-2deg)`;
      setOver(dropAt(e.clientX, e.clientY));
    }
    function onUp(e) {
      if (!drag || e.pointerId !== drag.pid) return;
      if (drag.started) {
        const target = dropAt(e.clientX, e.clientY);
        const id = drag.id;
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
        endDrag(true);
        if (target && !locked()) move(id, target === "tray" ? null : target);
      } else endDrag(false);
    }
    function endDrag() {
      if (!drag) return;
      const d = drag; drag = null;
      d.ghost?.remove();
      d.chip.classList.remove("dragging");
      try { if (d.chip.hasPointerCapture?.(d.pid)) d.chip.releasePointerCapture(d.pid); } catch {}
      setOver(null);
    }
    function dropAt(x, y) {
      const n = document.elementFromPoint(x, y);
      const z = n?.closest?.("[data-drop]");
      return z && root.contains(z) ? z.dataset.drop : null;
    }
    let overEl = null;
    function setOver(key) {
      const next = key === "tray" ? tray : key ? bucketEls.get(key) : null;
      if (next === overEl) return;
      overEl?.classList.remove("over");
      overEl = next;
      overEl?.classList.add("over");
    }

    function move(id, bucketId) {
      if (place[id] === bucketId) { selected = null; render(); return; }
      place[id] = bucketId;
      selected = null; dirty = true;
      render();
    }

    async function submit() {
      if (busy) return;
      if (locked()) { ctx.toast("마감됐어요"); render(); return; }
      if (items.some(i => !place[i.id])) { ctx.toast("모두 옮겨 주세요"); return; }
      const g = gradePlacements(cfg, place);
      busy = true; render();
      try {
        await ctx.submit({ placements: { ...place } }, { score: g.score, correct: g.correct });
        dirty = false;
      } catch (e) { /* ctx.submit 이 toast 처리 */ }
      busy = false; render();
    }

    function render() {
      const st = ctx.activity();
      const lock = locked();
      const reveal = !!st.reveal;
      const my = ctx.myResponse();
      if (lock && drag) endDrag(false);
      if (lock) selected = null;
      statusPill(status, st, !!my, pillState, ctx);

      // 칩 배치: 섞인 순서 유지. 필요한 칩만 옮긴다(드래그 중인 칩을 다시 붙이면 pointer capture 가 풀릴 수 있음)
      for (const box of [tray, ...bodies.values()]) {
        const want = order.filter(id => (place[id] ? bodies.get(place[id]) : tray) === box).map(id => chips.get(id));
        want.forEach((c, i) => { if (box.children[i] !== c) box.insertBefore(c, box.children[i] || null); });
      }
      for (const id of order) {
        const chip = chips.get(id);
        const it = items.find(i => i.id === id);
        chip.classList.toggle("selected", selected === id);
        chip.classList.toggle("locked", lock);
        // 정답 공개 표시
        const good = reveal && place[id] === it.bucketId;
        const bad = reveal && place[id] !== it.bucketId;
        chip.classList.toggle("ok", good);
        chip.classList.toggle("bad", bad);
        const sig = `${reveal ? (good ? 1 : 2) : 0}`;
        if (chip.dataset.sig === sig) continue;   // 내용이 같으면 다시 만들지 않음
        chip.dataset.sig = sig;
        chip.replaceChildren();
        if (reveal) chip.appendChild(el("span", { class: "dd-mark" }, good ? "✓" : "✗"));
        chip.appendChild(document.createTextNode(it.text || ""));
        if (bad) chip.appendChild(el("span", { class: "dd-answer" }, labelOf(it.bucketId)));
      }
      for (const b of bucketEls.values()) b.classList.toggle("armed", !!selected && !lock);

      const all = items.every(i => place[i.id]);
      if (reveal && my) {
        const g = gradePlacements(cfg, my.payload?.placements);
        scoreEl.textContent = `${g.n}/${g.total} 맞았어요`;
      } else scoreEl.textContent = "";
      submitBtn.style.display = lock ? "none" : "";
      submitBtn.disabled = busy || !all || (!!my && !dirty);
      submitBtn.textContent = my && !dirty ? "제출했어요" : my ? "다시 제출" : "제출";

      clearTimeout(timer);
      if (st.phase === "running" && st.endsAt && !isLocked(st, clockNow(ctx))) timer = setTimeout(render, Math.max(0, st.endsAt - clockNow(ctx)) + 50);
    }
    render();

    return {
      el: root,
      onActivity(st) {
        const rv = !!st?.reveal;
        if (rv && !wasReveal && ctx.myResponse()) { loadMine(); dirty = false; }  // 공개는 제출한 배치 기준
        wasReveal = rv;
        render();
      },
      onResponses() {
        if (!dirty && ctx.myResponse()) loadMine();   // 다른 기기·재동기화로 바뀐 내 응답 반영
        render();
      },
      destroy() { clearTimeout(timer); endDrag(false); pillState.node?.destroy?.(); },
    };
  },

  TeacherLive({ slide, ctx }) {
    ensureCss(ctx);
    const cfg = slide.config || {};
    const bar = activityBar(ctx, { reveal: true, timer: true });
    const result = itemBars(cfg);
    const root = el("div", { class: "dd dd-teacher" }, [
      el("div", { class: "dd-head" }, [el("h2", { class: "dd-prompt" }, cfg.prompt || "")]),
      bar, result.el,
    ]);
    const refresh = () => result.update(ctx.responses());
    refresh();
    return {
      el: root,
      onActivity() { bar.update?.(); },
      onResponses() { bar.update?.(); refresh(); },
      onSession() { bar.update?.(); },
      destroy() { bar.destroy?.(); },
    };
  },

  summary(slide, responses, session, ctx) {
    ensureCss(ctx);
    const cfg = slide.config || {};
    const result = itemBars(cfg);
    result.update(responses);
    return el("div", { class: "dd dd-sum", style: { height: "auto", overflow: "visible" } }, [
      el("h3", { class: "dd-prompt" }, cfg.prompt || ""),
      result.el,
    ]);
  },
});
