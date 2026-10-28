// 학습지(worksheet) 공용 — 교사·학생 화면이 함께 쓰는 헬퍼·CSS (docs/ARCHITECTURE.md §9.5)
// 학습지 = 수업 자료에 미리 올려 둔 PDF·이미지 페이지(ink 슬라이드 모양, lesson.worksheet / DB worksheet_pages).
// 수업(세션) 시작 때 스냅샷(session.worksheet, session_snapshots.worksheet)으로 고정되고, 학생은 수업 중 언제든
// 오른쪽 가장자리 📝 탭으로 열어 자기 칸(scope individual, records[studentId][pageId])에 쓴다.
// 교사는 같은 탭으로 학생들의 학습지 필기 갤러리를 보고(ink 플러그인 '개별' 갤러리 재사용), [학생 화면에 띄우기]로
// 모든 학생 화면을 학습지로 바꿀 수 있다(activity.__ws.force). 띄운 동안 학생은 닫을 수 없지만 쪽은 자유롭게 넘긴다.
// 가정: 학습지 페이지의 모드는 늘 '개별' — 플러그인에게는 activity[pageId].mode='individual'인 세션 보기(Proxy)를 넘긴다.
//       쓰기(필기 저장·setActivity)는 Proxy를 지나 진짜 세션 객체에 닿는다(복습 화면 sessionView와 같은 방식).
// 가정: '작성 중' = 그 학생이 최근 20초 안에 쓴 획·글자가 있음(교사 첨삭 by≠학생 제외). '작성함' = 학습지 어느 쪽에든 필기가 있음.
// 가정: activity.__ws 는 슬라이드 id와 겹치지 않는 예약 키(__snap과 같은 규칙). sessionHelloState·DB 행에 그대로 실린다.
import { el, icon } from "./ui.js";
import { injectCss } from "./slides/registry.js";
import { patchSession } from "./cloud.js";

export const WS_KEY = "__ws";
export const WRITING_MS = 20000;

const CSS = `
/* 오른쪽 가장자리 📝 탭 (학생 .stu / 교사 .live-body 안, 절대 배치) */
.ws-tab { position:absolute; right:0; top:50%; transform:translateY(-50%); z-index:7; display:flex; flex-direction:column; align-items:center;
  justify-content:center; gap:3px; width:46px; min-height:74px; padding:9px 0 7px; border:1px solid var(--line); border-right:0;
  border-radius:12px 0 0 12px; background:var(--surface); color:var(--ink-2); box-shadow:var(--shadow-1); cursor:pointer; font:inherit; }
.ws-tab .ws-emoji { font-size:22px; line-height:1; }
.ws-tab .ws-label { font-size:10px; font-weight:700; line-height:1; letter-spacing:-.01em; }
.ws-tab .ws-badge { position:absolute; top:-7px; left:-7px; min-width:20px; height:20px; padding:0 6px; border-radius:10px; background:var(--ok); color:#fff;
  font-size:11px; font-weight:800; display:grid; place-items:center; font-variant-numeric:tabular-nums; box-shadow:0 0 0 2px var(--bg); }
.ws-tab .ws-lock { position:absolute; right:4px; bottom:4px; display:none; line-height:0; }
.ws-tab .ws-lock svg { width:11px; height:11px; }
.ws-tab.open { background:var(--ink); color:#fff; border-color:var(--ink); }
.ws-tab.forced { background:var(--accent); color:#fff; border-color:var(--accent); }
.ws-tab.forced .ws-lock { display:block; }
@media (hover:hover) { .ws-tab:not(.open):not(.forced):hover { border-color:var(--line-strong); background:var(--surface-2); } }
/* 교사: 드로어가 흐름 배치(≥1025px)로 열려 있으면 탭을 드로어 왼쪽에 */
@media (min-width:1025px) { .live-body:has(> .drawer:not(.closed)) > .ws-tab { right:340px; } }
/* 학습지 화면(교사 갤러리 · 학생 필기) */
.ws-view { display:flex; flex-direction:column; gap:10px; min-height:0; min-width:0; }
.ws-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; flex:none; min-width:0; }
.ws-head .ws-title { display:inline-flex; align-items:center; gap:6px; font-weight:700; font-size:14px; white-space:nowrap; }
.ws-head .ws-stat { font-size:13px; color:var(--muted); font-variant-numeric:tabular-nums; white-space:nowrap; }
.ws-head .spacer { flex:1; min-width:4px; }
.ws-pages { --seg-h:34px; }
.ws-pages > button { position:relative; min-width:38px; overflow:visible; }
.ws-pages .ws-dot { position:absolute; top:-7px; right:-5px; min-width:16px; height:16px; padding:0 4px; border-radius:8px; background:var(--ok); color:#fff;
  font-size:10px; font-weight:800; display:grid; place-items:center; font-variant-numeric:tabular-nums; }
.ws-pages .ws-dot[hidden] { display:none; }
.ws-body { flex:1; min-height:0; min-width:0; display:flex; flex-direction:column; position:relative; }
.ws-body > .slide-host, .ws-body > .slide-host[data-type="ink"] { flex:1; min-height:0; height:auto; }
.ws-force.btn[aria-pressed="true"] { background:var(--accent); border-color:var(--accent); color:#fff; }
.ws-force.btn[aria-pressed="true"] .icon { color:inherit; }
/* 학생: 스테이지 전체가 학습지, 머리 줄은 얇게 */
.stu .ws-stage { padding:0 var(--sar) var(--sab) var(--sal); }
.stu .ws-view { gap:0; }
.stu .ws-head { height:42px; padding:0 8px 0 12px; gap:6px; flex-wrap:nowrap; border-bottom:1px solid var(--line); background:var(--surface); }
.stu .ws-head .btn { --btn-h:36px; font-size:14px; }
.stu .ws-head .slide-count { min-width:56px; font-size:14px; }
/* 교사 드로어 학습지 칸 */
.ws-pane { display:grid; gap:8px; padding-bottom:14px; border-bottom:1px solid var(--line); }
.ws-pane-head { display:flex; align-items:center; gap:6px; font-size:13px; color:var(--ink-2); min-width:0; flex-wrap:wrap; }
.ws-pane-head b { color:var(--ink); }
.ws-pane-row { display:flex; gap:6px; flex-wrap:wrap; }
/* 편집기 학습지 창 */
.ws-tools { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.ws-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:10px; }
.ws-card { position:relative; display:flex; flex-direction:column; gap:4px; padding:6px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); }
.ws-card .ws-thumb { position:relative; aspect-ratio:16/10; border-radius:6px; overflow:hidden; background:#fff; box-shadow:inset 0 0 0 1px var(--line); }
.ws-card .ws-thumb > * { position:absolute; inset:0; width:100%; height:100%; }
.ws-card .ws-row { display:flex; align-items:center; gap:0; }
.ws-card .ws-no { flex:1; font-size:12px; font-weight:700; color:var(--ink-2); padding-left:4px; }
.ws-card .ws-row .btn { --btn-h:30px; width:30px; }
.ws-empty { padding:28px 0; }
.ws-note { font-size:13px; color:var(--muted); line-height:1.5; }
.ws-cnt { display:inline-grid; place-items:center; min-width:18px; height:18px; padding:0 5px; border-radius:9px; background:var(--accent-soft); color:var(--accent-ink); font-size:11px; font-weight:800; }
`;
export function wsCss() { injectCss("worksheet", CSS); }

export function wsPages(session) { return session && Array.isArray(session.worksheet) ? session.worksheet : []; }
export function wsForced(session) { return !!(session && session.activity && session.activity[WS_KEY] && session.activity[WS_KEY].force); }
export function setWsForce(session, on) {
  if (!session) return Promise.resolve({ error: "세션이 없어요" });
  const act = session.activity || {};
  return patchSession(session, { activity: { ...act, [WS_KEY]: { ...(act[WS_KEY] || {}), force: !!on, at: Date.now() } } });
}
export function wsPageTitle(page, i) { return (page && page.title) || `학습지 ${i + 1}`; }
export function wsRecord(session, studentId, pageId) {
  const R = session && session.records;
  return (R && R[studentId] && R[studentId][pageId]) || null;
}

// 그 학생이 마지막으로 쓴 시각(ms). 교사 첨삭(by가 다른 사람)·지운 항목은 제외. 0 = 없음
export function wsLastTs(rec, studentId) {
  if (!rec) return 0;
  const rm = rec.removed && rec.removed.length ? new Set(rec.removed) : null;
  let t = 0;
  for (const s of rec.strokes || []) {
    if (!s || (rm && s.id && rm.has(s.id)) || (s.by && studentId && s.by !== studentId)) continue;
    if ((s.ts || 0) > t) t = s.ts || 0;
  }
  for (const x of rec.texts || []) {
    if (!x || !String(x.value || "").trim() || (rm && x.id && rm.has(x.id)) || (x.by && studentId && x.by !== studentId)) continue;
    if ((x.ts || 0) > t) t = x.ts || 0;
  }
  return t;
}

// 집계. studentIds = 참여자(∪ 접속). → { total, writing, written, perPage:[{writing, written}], byStudent: Map<id,{lastTs, page, writing, written}> }
export function wsStats(session, studentIds, now = Date.now()) {
  const pages = wsPages(session);
  const perPage = pages.map(() => ({ writing: 0, written: 0 }));
  const byStudent = new Map();
  let writing = 0, written = 0;
  const ids = studentIds || [];
  for (const sid of ids) {
    let last = 0, page = -1, any = false;
    pages.forEach((p, i) => {
      const t = p ? wsLastTs(wsRecord(session, sid, p.id), sid) : 0;
      if (t > 0) { any = true; perPage[i].written++; if (now - t < WRITING_MS) perPage[i].writing++; }
      if (t > last) { last = t; page = i; }
    });
    const w = last > 0 && now - last < WRITING_MS;
    if (any) written++;
    if (w) writing++;
    byStudent.set(sid, { lastTs: last, page, writing: w, written: any });
  }
  return { total: ids.length, writing, written, perPage, byStudent };
}

// 플러그인(ink)용 세션 보기: 학습지 페이지는 모두 '개별' 모드. 그 밖(응답·필기·참여자·모둠)은 진짜 세션 그대로.
// 반환 함수는 mountSlideHost({ sessionView }) 에 넘긴다. 같은 세션·activity·worksheet면 같은 Proxy를 돌려준다(host의 JSON 비교 안정).
export function makeWsSessionView() {
  let cache = null;
  return (real) => {
    if (!real) return real;
    const c = cache;
    if (c && c.real === real && c.act === real.activity && c.ws === real.worksheet) return c.view;
    const activity = { ...(real.activity || {}) };
    for (const p of wsPages(real)) if (p && p.id) activity[p.id] = { ...(activity[p.id] || {}), phase: "idle", mode: "individual" };
    const over = { activity };
    const view = new Proxy(real, { get: (t, k) => (Object.hasOwn(over, k) ? over[k] : Reflect.get(t, k)) });
    cache = { real, act: real.activity, ws: real.worksheet, view };
    return view;
  };
}

// 오른칽 가장자리 📝 탭. tab.set({ hidden, open, forced, badge, label })
export function wsTab({ onClick, title = "학습지" } = {}) {
  wsCss();
  const emoji = el("span", { class: "ws-emoji", "aria-hidden": "true" }, "📝");
  const badge = el("span", { class: "ws-badge", hidden: true, title: "작성 중" });
  const label = el("span", { class: "ws-label" }, title);
  const lock = el("span", { class: "ws-lock", "aria-hidden": "true" }, icon("lock", 11));
  const tab = el("button", { class: "ws-tab", type: "button", title, "aria-label": title, "aria-pressed": "false", onClick }, [badge, emoji, label, lock]);
  tab.set = ({ hidden = false, open = false, forced = false, badge: n = 0, label: text = null } = {}) => {
    tab.hidden = !!hidden;
    tab.classList.toggle("open", !!open && !forced);
    tab.classList.toggle("forced", !!forced);
    tab.setAttribute("aria-pressed", String(!!open));
    badge.hidden = !(n > 0);
    const bt = n > 0 ? String(n) : "";
    if (badge.textContent !== bt) badge.textContent = bt;
    const t = text || title;
    if (label.textContent !== t) label.textContent = t;
    const full = forced ? `${t} · 선생님이 띄움` : t;
    if (tab.title !== full) { tab.title = full; tab.setAttribute("aria-label", full); }
  };
  return tab;
}
