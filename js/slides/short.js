// 주관식·서술형(short) 슬라이드
// 가정: 채점 없음(score/correct = null). payload = { text }.
// 가정: reveal 시 학생은 교사가 고른(activity.pinned) 답만 본다 — 이름 없이 글만(학생 화면 최소화).
// 가정: maxLen 은 편집기에서 long 전환 시 2000/300 으로 맞춘다. 실제 한도 = min(maxLen, long?2000:300).
// 가정(v2.9): 교사 화면은 마감·공개·타이머 끝 전에는 응답 수만(답 카드·패널의 답 가림). 문제 그림 config.image.
// 실시간 답안(v2.18): 학생이 쓰는 글(제출 전 포함)을 그 학생의 개별 레코드(slide_records, scope individual)에 쓴다 —
//   texts[0] = { id:'sa-draft', draft, at(교사 시계) }. cloudWriteRecord가 250ms(길어도 1초)마다 한 번만 쓰고,
//   학생 레코드는 교사에게만 실시간으로 가므로(학생 구독은 자기 칸만) 반 전체가 동시에 써도 다른 학생 화면에는 부담이 없다.
//   [제출]은 그대로 응답(responses)을 남긴다. 교사 [답안 공개](예전 '정답 공개') 또는 마감·타이머 끝이면 교사 화면 카드가
//   제출본 대신 지금 쓰는 글을 보여 준다(작성 중·고치는 중 표시). 카드를 누르면 크게 보기(◀ ▶·←/→로 다른 답, 학생 화면에 함께 보기 켜고 끄기).
//   [초기화]는 activity.clearedAt(교사 시계)을 남겨 그 전에 쓴 글은 버린다. 학생 화면은 그대로 '함께 보기'(교사가 고른 제출본, 이름 없이).
import { el, modal, icon } from "../ui.js";
import * as cloud from "../cloud.js";
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
.sa-pinned .sa-card { width: 100%; }
.sa-label { font-size: 12px; color: var(--muted); }
.sa-card .who { display: flex; align-items: center; gap: 6px; min-width: 0; }
.sa-card .who .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qz-live .sa-cards .sa-card .txt { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; } /* 수업 중 칸은 6줄까지 — 전체는 눌러서 크게 */
.sa-card.is-live { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.sa-tag { flex: none; display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border-radius: 999px;
  font-size: 11px; font-weight: 700; background: var(--surface-2); color: var(--ink-2); }
.sa-tag.live { background: var(--accent-soft); color: var(--accent-ink); }
.sa-tag.live::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: sa-blink 1.2s ease-in-out infinite; }
.sa-tag.pin { background: var(--highlight); color: var(--ink); }
@keyframes sa-blink { 50% { opacity: .25; } }
@media (prefers-reduced-motion: reduce) { .sa-tag.live::before { animation: none; } }
.sa-note { font-size: 13px; color: var(--accent-ink); background: var(--accent-soft); border-radius: var(--radius-sm); padding: 8px 12px; }
.sa-zoom-modal { width: min(920px, calc(100vw - 32px)); max-width: none; }
.sa-zoom { display: grid; gap: 14px; }
.sa-zoom-head { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 15px; font-weight: 700; }
.sa-zoom-head .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sa-zoom-txt { font-size: clamp(22px, 3vw, 36px); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: min(60vh, 560px); overflow-y: auto; min-height: 3em; }
.sa-zoom-txt.empty { color: var(--muted); }
.sa-zoom-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sa-zoom-foot .mid { display: flex; align-items: center; gap: 10px; min-width: 0; }
.sa-zoom-foot .sa-pos { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
`;
const DRAFT_ID = "sa-draft";
// 그 학생이 지금 쓰고 있는(제출 전 포함) 글 — 개별 레코드 texts의 sa-draft | null
function draftOf(session, studentId, slideId) {
  const rec = session?.records?.[studentId]?.[slideId];
  const t = (rec?.texts || []).find(x => x && x.id === DRAFT_ID);
  return t ? { text: String(t.draft ?? ""), at: Number(t.at) || 0 } : null;
}

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
  const note = el("div", { class: "sa-note", role: "status", hidden: true }, "답안 공개 중 · 쓰는 글이 선생님 화면에 바로 보여요");
  const pinnedBox = el("div", { class: "sa-pinned" });

  const savedText = () => mine?.payload?.text || "";
  const dirty = () => inp.value.trim() !== savedText().trim();

  // 쓰는 글을 내 개별 레코드에(교사 화면 실시간 답안). 같은 글은 다시 보내지 않음
  const meId = ctx.me?.id || null;
  const sessId = () => ctx.session?.()?.id || null;
  let draftSent = null;
  function sendDraft() {
    const sid = sessId();
    if (!sid || !meId || typeof cloud.cloudWriteRecord !== "function") return;
    const text = inp.value.slice(0, limit);
    if (text === draftSent) return;
    draftSent = text;
    try {
      cloud.cloudWriteRecord(sid, slide.id, "individual", meId, { strokes: [], texts: [{ id: DRAFT_ID, draft: text, at: clockNow(ctx) }], removed: [] });
    } catch (e) { console.warn("[short] draft", e); }
  }
  // 다시 들어오면(새로고침 등) 쓰던 글을 이어서 — 초기화 전에 쓴 글·제출본과 같은 글은 무시
  {
    const d = draftOf(ctx.session?.(), meId, slide.id);
    if (d) {
      draftSent = d.text;
      if (d.at > (st.clearedAt || 0) && d.text.trim() && d.text !== savedText() && !isLocked(st, clockNow(ctx))) inp.value = d.text.slice(0, limit);
    }
  }

  inp.addEventListener("input", () => { if (!isLocked(st, clockNow(ctx))) sendDraft(); paint(); });
  if (!cfg.long) inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); } });

  const root = el("div", { class: "qz-stu" }, [
    status.el,
    el("h2", { class: "qz-q" }, cfg.question || slide.title || ""),
    questionImage(cfg.image),
    inp, count, note, submitB, pinnedBox,
  ]);

  async function submit() {
    const text = inp.value.trim().slice(0, limit);
    if (isLocked(st, clockNow(ctx)) || sending || !text || !dirty()) return;
    sending = true; paint();
    sendDraft();
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
      el("div", { class: "sa-label" }, "함께 보기 · 누르면 크게"),
      ...items.map(r => el("button", { class: "sa-card pinned", type: "button", onClick: () => bigText(r.payload?.text || "") },
        [el("div", { class: "txt" }, r.payload?.text || "")])),
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
    note.hidden = !(st.reveal && !lock); // 공개 중에는 쓰는 글이 교사 화면에 바로 보인다는 것을 알려 줌
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

// 학생 화면 '함께 보기' 크게
function bigText(text) {
  modal({ title: "함께 보기", body: el("div", { class: "sa-zoom" }, [el("div", { class: "sa-zoom-txt" }, text)]), className: "sa-zoom-modal" });
}

const STATE_LABEL = { draft: "작성 중", edit: "고치는 중", done: "", unsent: "미제출" };
function tagOf(state) {
  const t = STATE_LABEL[state] || "";
  return { text: t, cls: state === "draft" || state === "edit" ? "sa-tag live" : "sa-tag" };
}

// 카드 그리드(학생 id 키로 DOM 보존). 항목 { studentId, name, text, state? }
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
          const nm = el("span", { class: "nm" });
          const tag = el("span", { class: "sa-tag", hidden: true });
          const pin = el("span", { class: "sa-tag pin", hidden: true }, "학생 화면");
          const who = el("div", { class: "who" }, [nm, tag, pin]);
          const txt = el("div", { class: "txt" });
          const id = r.studentId;
          const node = el(onTap ? "button" : "div", onTap ? { class: "sa-card", type: "button", onClick: () => onTap(id) } : { class: "sa-card" }, [who, txt]);
          c = { node, who, nm, tag, pin, txt };
          cards.set(r.studentId, c);
        }
        const t = r.text ?? r.payload?.text ?? "";
        if (c.txt.textContent !== t) c.txt.textContent = t;
        const nmT = showNames ? (r.name || "") : "";
        if (c.nm.textContent !== nmT) c.nm.textContent = nmT;
        const g = tagOf(r.state);
        c.tag.hidden = !g.text;
        if (c.tag.textContent !== g.text) c.tag.textContent = g.text;
        c.tag.className = g.cls;
        const isPin = pinned.includes(r.studentId);
        c.pin.hidden = !isPin || !onTap;
        c.who.hidden = !showNames && !g.text;
        c.node.classList.toggle("pinned", isPin);
        c.node.classList.toggle("is-live", r.state === "draft" || r.state === "edit");
        if (root.children[i] !== c.node) root.insertBefore(c.node, root.children[i] || null);
      });
      for (const [k, c] of cards) if (!keep.has(k)) { c.node.remove(); cards.delete(k); }
    },
  };
}

function sorted(ctx, list) {
  return [...byStudent(list).values()]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(r => ({ ...r, name: nameOf(ctx, r.studentId), text: r.payload?.text || "", state: "done" }));
}

// 수업 중 학생별 지금 글: 쓰는 글(제출본과 다르면 작성 중·고치는 중) → 없으면 제출본. 학번순(글을 쓰는 동안 칸이 자리를 바꾸지 않게)
function liveItems(ctx, slide, st) {
  const list = ctx.responses() || [];
  const map = byStudent(list);
  const ss = ctx.session?.();
  const cleared = Number(st?.clearedAt) || 0;
  const out = [];
  for (const id of rosterIds(ctx, list)) {
    const r = map.get(id);
    const sub = r ? (r.payload?.text || "") : null;
    const d = draftOf(ss, id, slide.id);
    const dt = d && d.at > cleared ? d.text : null;
    if (dt != null && dt.trim() && dt !== sub) out.push({ studentId: id, name: nameOf(ctx, id), text: dt, state: sub != null ? "edit" : "draft" });
    else if (sub != null) out.push({ studentId: id, name: nameOf(ctx, id), text: sub, state: "done" });
  }
  return out;
}

function TeacherLive({ slide, ctx }) {
  css(ctx);
  const cfg = cfgOf(slide);
  let st = actOf(ctx);

  const status = statusRow({ ctx });
  const countP = el("span", { class: "pill" });
  let items = [];
  const grid = cardGrid({ onTap: (sid) => openZoom(sid) });
  const empty = el("div", { class: "empty" }, "아직 쓴 학생이 없어요");
  const veil = resultsVeil({ note: "답안 공개 · 마감하면 학생들이 쓰는 글이 보여요" });
  const root = el("div", { class: "qz-live" }, [
    el("div", { class: "qz-live-head" }, [status.el, countP]),
    el("h2", { class: "qz-q" }, cfg.question || slide.title || ""),
    questionImage(cfg.image),
    veil, empty, grid.el,
  ]);

  const bar = activityBar(ctx, { reveal: true, timer: true, revealLabel: "답안 공개" });
  const roster = rosterList();
  const panel = el("div", { class: "qz-panel" }, [bar, roster.el]);

  // 함께 보기(학생 화면에 띄우기) 켜고 끄기 — 초기화로 응답이 사라진 학생 id 는 함께 정리
  function togglePin(sid) {
    const has = byStudent(ctx.responses() || []);
    const cur = (actOf(ctx).pinned || []).filter(x => has.has(x));
    ctx.setActivity({ pinned: cur.includes(sid) ? cur.filter(x => x !== sid) : [...cur, sid] });
  }

  // ── 크게 보기(카드 누르면) — 열려 있는 동안에도 글이 실시간으로 바뀜 ──
  let zoom = null; // { id, h, nm, tag, txt, pinB, pos, prevB, nextB }
  function onZoomKey(e) {
    if (!zoom || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault(); e.stopPropagation(); // 수업 화면의 ←/→(슬라이드 넘기기) 대신 다른 답으로
    moveZoom(e.key === "ArrowLeft" ? -1 : 1);
  }
  function closeZoom() {
    document.removeEventListener("keydown", onZoomKey, true);
    const z = zoom; zoom = null;
    if (z) { try { z.h.close(); } catch (_) {} }
  }
  function openZoom(id) {
    if (zoom) { zoom.id = id; paintZoom(); return; }
    const nm = el("span", { class: "nm" });
    const tag = el("span", { class: "sa-tag", hidden: true });
    const txt = el("div", { class: "sa-zoom-txt" });
    const pinB = el("button", { class: "btn btn-sm", type: "button", onClick: () => zoom && hasSub(zoom.id) && togglePin(zoom.id) });
    const pos = el("span", { class: "sa-pos" });
    const prevB = el("button", { class: "btn btn-icon btn-ghost", type: "button", "aria-label": "이전 답안", title: "이전 답안 (←)", onClick: () => moveZoom(-1) }, icon("chevron-left"));
    const nextB = el("button", { class: "btn btn-icon btn-ghost", type: "button", "aria-label": "다음 답안", title: "다음 답안 (→)", onClick: () => moveZoom(1) }, icon("chevron-right"));
    const body = el("div", { class: "sa-zoom" }, [
      el("div", { class: "sa-zoom-head" }, [nm, tag]),
      txt,
      el("div", { class: "sa-zoom-foot" }, [prevB, el("span", { class: "mid" }, [pos, pinB]), nextB]),
    ]);
    const z = { id, nm, tag, txt, pinB, pos, prevB, nextB, h: null };
    z.h = modal({ title: cfg.question || slide.title || "답안", body, className: "sa-zoom-modal", onClose: () => { if (zoom === z) { zoom = null; document.removeEventListener("keydown", onZoomKey, true); } } });
    zoom = z;
    document.addEventListener("keydown", onZoomKey, true);
    paintZoom();
  }
  const hasSub = (sid) => byStudent(ctx.responses() || []).has(sid);
  function moveZoom(d) {
    if (!zoom || !items.length) return;
    const i = items.findIndex(x => x.studentId === zoom.id);
    const j = Math.max(0, Math.min(items.length - 1, (i < 0 ? 0 : i) + d));
    if (items[j] && items[j].studentId !== zoom.id) { zoom.id = items[j].studentId; paintZoom(); }
  }
  function paintZoom() {
    if (!zoom) return;
    const i = items.findIndex(x => x.studentId === zoom.id);
    const it = items[i];
    if (!it) { closeZoom(); return; } // 초기화 등으로 사라짐
    const nmT = it.name || "";
    if (zoom.nm.textContent !== nmT) zoom.nm.textContent = nmT;
    const g = tagOf(it.state);
    zoom.tag.hidden = !g.text; zoom.tag.className = g.cls;
    if (zoom.tag.textContent !== g.text) zoom.tag.textContent = g.text;
    const t = it.text || "";
    if (zoom.txt.textContent !== t) {
      const atEnd = zoom.txt.scrollTop + zoom.txt.clientHeight >= zoom.txt.scrollHeight - 4;
      zoom.txt.textContent = t;
      if (atEnd && (it.state === "draft" || it.state === "edit")) zoom.txt.scrollTop = zoom.txt.scrollHeight; // 쓰는 중이면 끝을 따라감
    }
    zoom.pos.textContent = `${i + 1} / ${items.length}`;
    const pinned = (st.pinned || []).includes(it.studentId);
    const can = hasSub(it.studentId);
    zoom.pinB.disabled = !can;
    zoom.pinB.textContent = pinned ? "학생 화면에서 내리기" : "학생 화면에 함께 보기";
    zoom.pinB.title = can ? "학생들 화면 '함께 보기'에 이름 없이 띄워요(제출한 글)" : "제출한 글만 학생 화면에 띄울 수 있어요";
    zoom.pinB.classList.toggle("btn-primary", !pinned && can);
    zoom.prevB.disabled = i <= 0;
    zoom.nextB.disabled = i >= items.length - 1;
  }

  let sSig = sessionSig(ctx), dSig = draftSig();
  // 이 슬라이드 쓰는 글이 바뀌었나(레코드 변경은 onSession으로 온다)
  function draftSig() {
    const ss = ctx.session?.();
    const R = ss?.records || {};
    let k = "";
    for (const id in R) {
      if (id.startsWith("__")) continue;
      const d = draftOf(ss, id, slide.id);
      if (d) k += `${id}:${d.at}|`;
    }
    return k;
  }
  function paint() {
    const list = ctx.responses() || [];
    const submitted = byStudent(list).size;
    items = liveItems(ctx, slide, st);
    const writing = items.filter(x => x.state === "draft" || x.state === "edit").length;
    const open = resultsOpen(st, clockNow(ctx)); // 마감·답안 공개 전에는 글을 가린다(v2.9)
    status.set({ state: st });
    countP.textContent = writing ? `응답 ${submitted} · 작성 중 ${writing}` : `응답 ${submitted}`;
    veil.hidden = open;
    veil.set(submitted, (ctx.participants() || []).length);
    empty.hidden = !open || items.length > 0;
    grid.el.hidden = !open;
    if (open) grid.set(items, { pinned: st.pinned || [] });
    else closeZoom();
    const byId = new Map(items.map(x => [x.studentId, x]));
    roster.set(rosterIds(ctx, list).map(id => {
      const it = byId.get(id);
      if (!it) return { id, name: nameOf(ctx, id), value: "—", cls: "none" };
      if (!open) return { id, name: nameOf(ctx, id), value: it.state === "done" ? "제출" : it.state === "edit" ? "제출 · 고치는 중" : "작성 중", cls: "" };
      return { id, name: nameOf(ctx, id), value: it.text, cls: it.state === "done" ? "" : "none" };
    }));
    bar.update();
    paintZoom();
  }
  paint();

  return {
    el: root,
    panel,
    onActivity(s) { st = actOf(ctx, s); paint(); },
    onResponses() { paint(); },
    onSession() {
      const k = sessionSig(ctx), d = draftSig();
      if (k === sSig && d === dSig) return;
      sSig = k; dSig = d; paint();
    },
    destroy() { closeZoom(); status.destroy(); bar.destroy?.(); },
  };
}

function summary(slide, responses = [], session, ctx) {
  css(ctx);
  const cfg = cfgOf(slide);
  const items = sorted(ctx, responses);
  // 제출하지 않고 쓰던 글(실시간 답안, v2.18) — '미제출'로 뒤에
  const cleared = Number(session?.activity?.[slide.id]?.clearedAt) || 0;
  const has = new Set(items.map(r => r.studentId));
  for (const id of Object.keys(session?.records || {})) {
    if (id.startsWith("__") || has.has(id)) continue;
    const d = draftOf(session, id, slide.id);
    if (d && d.at > cleared && d.text.trim()) items.push({ studentId: id, name: nameOf(ctx, id), text: d.text, state: "unsent" });
  }
  const pinned = session?.activity?.[slide.id]?.pinned || [];
  const grid = cardGrid();
  grid.set(items, { pinned });
  return el("div", { class: "qz-sum" }, [
    el("div", { class: "qz-q" }, cfg.question || slide.title || ""),
    questionImage(cfg.image, { small: true }),
    el("div", { class: "qz-sum-meta" }, [el("span", { class: "pill pill-muted" }, `응답 ${items.filter(x => x.state !== "unsent").length}`)]),
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
