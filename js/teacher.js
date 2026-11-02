// 교사 화면 — 대시보드(수업 자료·수업 기록·학생·내 코드), 편집기, 수업 진행, 기록 상세 (docs/ARCHITECTURE.md §7.3, §8, §9.1)
// export: teacherDashboard(params), editorView({id}), liveView({id}), sessionDetailView({id}) — 모두 cleanup(또는 Promise<cleanup>) 반환.
// 가정: 'session:hello' 응답은 realtime.js 코어가 자동 처리(교사 채널이면 sessionHelloState로 'session:patch' 송신) → 여기서는 하지 않는다.
// 가정: 라우트 핸들러 안의 리다이렉트는 setTimeout으로 미룬다(동기 중첩 dispatch가 router의 cleanup 등록을 덮어쓰지 않게).
// 가정: 대시보드 탭 전환은 history.replaceState로 해시(?tab=)만 바꾼다(재-dispatch 없음).
// 가정: 로그아웃 = whoTeacher=null → '/'.
// 가정: 편집기 슬라이드 복제는 bgPath를 비운다(같은 이미지 파일을 두 슬라이드가 소유하면 한쪽 배경 교체 시 다른 쪽 이미지가 지워짐).
// 가정: 편집기에서 슬라이드를 삭제해도 Storage 이미지는 지우지 않는다(지난 수업 스냅샷이 같은 URL을 참조). 자료 삭제 시 cloud.js가 폴더 정리.
// 가정: 편집기 상단의 [미리보기]는 이번 범위에서 생략(명세 §9.1 흐름에 없음).
// 가정: /live/:id 의 세션이 live가 아니면 기록 상세로 보낸다. 다른 곳에서 끝나면 '수업이 끝났어요' 후 기록 상세.
// 가정: 기록 '학생별'의 필기는 최종 모드(effectiveMode) 우선으로 scope를 고르되, 그 scope에 필기가 없으면 필기가 있는 다른 scope(개별→모둠→전체)를 보여 준다.
// 가정: 수업 자료 삭제 시 DB cascade로 그 자료의 수업 기록도 지워지므로 확인 문구에 함께 적는다.
// 가정: 복습 코드(수업마다, 학습지 QR)는 수업 진행의 코드 창 아래 줄과 기록 상세의 [복습 코드]에서 본다. 코드는 처음 열 때 만들어진다.
// 가정: 수업 중 [상호작용 추가](패널 활동 탭 아래)는 정답 없는 상호작용·미디어만. 그 타입의 편집기를 창에 띄워 내용을 넣고
//       [추가하고 이동] → 이 수업 스냅샷의 현재 슬라이드 다음에 끼워 넣고 바로 그 슬라이드로(수업 자료에는 저장하지 않음).
//       맨 앞 [빈 슬라이드]는 채울 내용이 없어 창 없이 바로 — 흰 필기 슬라이드(모드 '전체', 수업 중 모드 seg로 바꿈).
// 가정: 학습지(js/worksheet.js) — 편집기 상단 [📝 학습지] 창에서 PDF·이미지를 올려 자료에 붙인다(lesson.worksheet, 저장은 cloudSaveLesson).
//       수업 진행에서는 레일 📝 학습지(작성 중 인원 배지) → 스테이지를 학습지 갤러리로 바꿈(ink '개별' 갤러리 재사용, 칸 탭 → 첨삭).
//       '학생 화면 고정' 스위치 = activity.__ws.force. 학습지 화면이 열려 있을 때 ←/→는 학습지 쪽을 넘긴다(슬라이드 호스트는 숨긴 채 유지).
// 가정(v2.7 수업 진행 화면 정리 — 한 기능은 한 자리): 상단 바는 수업 흐름만(코드·이동·모드(+모둠)·진행 방식·종료).
//       오른쪽은 이름표 달린 아이콘 레일(학습지·참여·추가·도구)만 두고, 누를 때 그 하나만 펼친다(패널은 한 번에 하나).
//       '도구' = 그 슬라이드 플러그인의 panel(마감·정답 공개·타이머·응답자 등) — 있을 때만 보이고, 넓은 화면(≥1100px)에서는
//       그런 슬라이드로 오면 저절로 펼친다(직접 닫으면 다시 열 때까지 자동으로 펼치지 않음). 필기 슬라이드는 패널이 없어 화면이 넓다.
//       '추가' = 지금 슬라이드 다음에 끼워 넣을 상호작용을 고르는 작은 창. 접속 수는 레일 '참여' 배지.
//       학습지 화면에서 상단 ◀ ▶·슬라이드 번호를 누르면 슬라이드 화면으로 돌아간다.
// 가정(v2.9): 상단 바는 세 구역 — 왼쪽(← 제목 · 코드) | 가운데(◀ n/N ▶) | 오른쪽(모드 · 진행 방식 · 종료). 넓은 화면은 가운데가
//       정확히 가운데라 모드 버튼이 생기고 없어져도 ◀ ▶ 자리가 그대로이고, 좁은 화면은 모드·모둠 자리를 비워 둔 채(보이지 않게) 둬 같은 효과.
// 가정(v2.9): 팝업 상호작용(js/popup.js) — 필기 슬라이드의 핀을 누르면 activity.__pop → 스테이지 위 팝업(오른쪽에 그 활동의 마감·공개 도구).
//       다시 누르거나 ×·Esc·다른 슬라이드로 이동하면 닫힌다(학생 화면도 함께). 기록에는 그 슬라이드 뒤에 '팝업'으로 이어 붙인다.
import { store, findLesson, findSession, findStudent, findTeacher, studentLabel, newId } from "./store.js";
import { go } from "./router.js";
import { el, mount, template, toast, confirmDialog, promptDialog, modal, sheet, icon, fmtDate, debounce, copyText, copyTextLater } from "./ui.js";
import {
  cloudReady, cloudCreateLesson, cloudSaveLesson, cloudDeleteLesson, cloudDuplicateLesson, cloudFetchLessonSlides,
  cloudStartSession, ensureSession, cloudFetchSession, patchSession, cloudEndSession, cloudResumeSession, cloudDeleteSession,
  subscribeSession, cloudEnsureReviewCode, cloudFetchReviewCodes, cloudInsertSessionSlide, cloudEnsureWorksheet,
} from "./cloud.js";
import { fileToSlides } from "./storage.js";
import { joinSessionChannel } from "./realtime.js";
import { getSlideType, listSlideTypes, createSlide, CATEGORIES, effectiveMode, injectCss, mountSlideHost } from "./slides/index.js";
import { renderSlide } from "./lesson-view.js";
import { openStudentPrint, openBlankPrint, printStudents, printRecordView, reviewUrl } from "./print.js";
import { wsPages, wsForced, setWsForce, wsPageTitle, wsStats, makeWsSessionView, wsCss } from "./worksheet.js";
import { createPopupView, popOf, findPopSlide, setPop, freshHotspotIds, hotspotsOf, popSlideFor } from "./popup.js";

const TABS = ["lessons", "records", "students", "code"];
// 수업 중 바로 추가할 수 있는 타입 (정답 없는 상호작용 · 미디어)
const QUICK_TYPES = ["wall", "short", "wordcloud", "poll", "link", "embed", "video"];
const BLANK_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/></svg>';
const TOOLS_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h9"/><path d="M19 6h1"/><circle cx="16" cy="6" r="2.5"/><path d="M4 12h3"/><path d="M13 12h7"/><circle cx="10" cy="12" r="2.5"/><path d="M4 18h11"/><circle cx="18" cy="18" r="2.5"/></svg>';
const MODES = [["none", "발표"], ["whole", "전체"], ["individual", "개별"], ["group", "모둠"]];
const STATUS = { live: ["진행 중", "pill-live"], completed: ["끝남", "pill-ok"], stopped: ["중단", "pill-warn"] };
const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp";

// 화면 전용 보조 CSS (styles.css 클래스 위에 최소한만)
const TEACHER_CSS = `
.t-paper { position:absolute; inset:0; background:#fff linear-gradient(transparent 23px, var(--line) 24px) 0 12px / 100% 24px; }
.t-thumb { position:absolute; inset:0; overflow:hidden; background:#fff; }
.t-thumb > * { width:100%; height:100%; }
.rail-item { -webkit-touch-callout:none; user-select:none; -webkit-user-select:none; }
.rail-ghost .rail-more { display:none; }
.t-menu-pop { padding:0; }
.menu-item:disabled { opacity:.4; cursor:default; }
.menu-item .icon { color:var(--muted); }
.menu-item.danger .icon { color:inherit; }
.t-strip-pop { padding:6px; }
.t-strip-pop .thumb-strip > .rail-item { width:128px; }
.t-warn-list { margin:0; padding-left:18px; display:grid; gap:4px; font-size:14px; color:var(--ink-2); max-height:40vh; overflow:auto; }
.editor-top .topbar-group { gap:6px; }
.live-top .topbar-title { flex:1 1 80px; }
.live-top .seg { flex:none; }
.live-top .slide-count { min-width:72px; }
/* 상단 바 세 구역(v2.9): ◀ n/N ▶ 는 늘 같은 자리 */
.live-top { display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr); gap:12px; }
.live-top .lt-side { display:flex; align-items:center; gap:8px; min-width:0; }
.live-top .lt-right { justify-content:flex-end; justify-content:safe flex-end; }
.live-top .lt-nav { justify-self:center; }
.live-top .is-off { display:none !important; }
@media (max-width: 1280px) { .live-top .lt-right .t-flow-label { display:none; } }
@media (max-width: 1100px) {
  .live-top { grid-template-columns:minmax(0,1fr) auto auto; }
  .live-top .is-off { display:inline-flex !important; visibility:hidden; pointer-events:none; }
}
.drawer-head { border-bottom:1px solid var(--line); }
.drawer-head .tabs { flex:1; min-width:0; border-bottom:0; padding:0; }
.t-pane { display:grid; gap:12px; align-content:start; min-width:0; }
.lr-add-pop { padding:8px; }
.lr-add { width:min(344px, calc(100vw - 32px)); }
.lr-add-head { font-size:12px; color:var(--muted); padding:2px 6px 8px; }
.lr-add-grid { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:2px; }
.lr-add-btn { display:flex; flex-direction:column; align-items:center; gap:5px; min-height:72px; padding:10px 2px 8px; border:0; border-radius:var(--radius-sm);
  background:transparent; color:var(--ink); font-size:12px; line-height:1.25; text-align:center; word-break:keep-all; cursor:pointer; }
.lr-add-btn .icon { display:inline-flex; color:var(--ink-2); }
.lr-add-btn .icon svg { width:22px; height:22px; }
@media (hover: hover) { .lr-add-btn:hover { background:var(--surface-2); } }
.t-group-btn .t-group-left { color:var(--warn); font-weight:600; }
.t-quick-editor { position:relative; min-height:220px; max-height:min(62vh, 560px); overflow:auto; margin:0 -4px; }
.t-quick-editor > .slide-host { height:auto; }
.person .pill { height:20px; padding:0 8px; font-size:11px; }
.t-meta { display:flex; flex-wrap:wrap; align-items:center; gap:6px 14px; margin:-12px 0 20px; color:var(--muted); font-size:13px; }
.t-detail-bar { margin-bottom:16px; }
.t-review-row { display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:8px; padding-top:16px; border-top:1px solid var(--line); width:100%; }
.t-review-row b { font-size:17px; letter-spacing:.08em; color:var(--ink); font-variant-numeric:tabular-nums; }
.t-review-note { font-size:13px; }
.t-meta .t-review-btn { height:28px; padding:0 10px; font-size:13px; letter-spacing:.04em; }
.t-meta .t-review-copy { height:28px; padding:0 10px; font-size:13px; }
.list-row .t-rv-copy { flex:none; white-space:nowrap; }
@media (max-width: 560px) { .list-row .t-rv-copy .t-rv-label { display:none; } .list-row .t-rv-copy { width:var(--btn-h); padding:0; justify-content:center; } }
.t-sum-head { display:flex; align-items:center; gap:10px; min-width:0; margin-bottom:14px; }
.t-sum-head h3 { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:16px; }
.t-sum-num { flex:none; min-width:26px; height:26px; padding:0 6px; border-radius:7px; background:var(--surface-2); display:grid; place-items:center; font-size:12px; font-weight:700; color:var(--ink-2); font-variant-numeric:tabular-nums; }
.t-mini { width:min(100%, 560px); }
.t-mini .slide-frame { width:100%; }
.t-sum-thumb { position:relative; width:min(100%, 240px); aspect-ratio:16/10; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
.t-loading { min-height:100vh; min-height:100dvh; display:grid; place-items:center; }
.t-print-only { display:none; }
@media print { .t-print-only { display:block; } .chips { display:none !important; } }
`;
function ensureCss() { injectCss("teacher-views", TEACHER_CSS); }

// ───────────────────────── 공용 헬퍼 ─────────────────────────
function teacherId() {
  const w = store.state.whoTeacher;
  return w && typeof w === "object" ? w.id : (w || null);
}
function currentTeacher() {
  const id = teacherId();
  return id ? findTeacher(id) : null;
}
// 가정: 리다이렉트는 history를 교체(replace) — 뒤로 가기 시 같은 리다이렉트로 되돌아오는 루프 방지.
function redirect(path) { setTimeout(() => go(path, { replace: true }), 0); }

let viewSeq = 0;
// 비동기 대기 후에도 같은 화면인지
function viewGuard() {
  const tok = ++viewSeq, hash = location.hash;
  return () => tok === viewSeq && location.hash === hash;
}

// 교사 확인 후 render(teacher). 부팅 조회 전이면 cloudReady까지 기다린다.
function withTeacher(render) {
  if (!teacherId()) { redirect("/teacher-login"); return () => {}; }
  const t = currentTeacher();
  if (t) return render(t);
  const alive = viewGuard();
  return cloudReady.then(() => {
    if (!alive()) return () => {};
    const tid = teacherId();
    // cloudBootTeacher가 없는 교사면 whoTeacher를 비운다 → 로그인으로
    if (!tid) { redirect("/teacher-login"); return () => {}; }
    // 가정: 부팅 조회가 네트워크 오류로 실패해 교사 행이 없으면 최소 객체로 계속(로그인↔대시보드 리다이렉트 루프 방지)
    return render(currentTeacher() || { id: tid, name: "", joinCode: "" });
  });
}

function logout() {
  store.set(s => { s.whoTeacher = null; });
  go("/");
}

function fmtDay(ts) { const s = fmtDate(ts); return s.length > 10 ? s.slice(0, 10) : s; }
function dateRange(s) {
  if (!s.startedAt) return "—";
  const a = fmtDate(s.startedAt);
  if (!s.endedAt) return a;
  const b = fmtDate(s.endedAt);
  return a.slice(0, 10) === b.slice(0, 10) ? `${a} – ${b.slice(11)}` : `${a} – ${b}`;
}
function statusPill(status) {
  const [label, cls] = STATUS[status] || STATUS.stopped;
  return el("span", { class: "pill " + cls }, label);
}
function joinUrl(code) {
  return `${location.origin}${location.pathname}#/student/join?c=${encodeURIComponent(code || "")}`;
}
function studentsMap() {
  return new Map((store.state.students || []).map(s => [s.id, s]));
}
function cmpStudent(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return (+a.grade || 0) - (+b.grade || 0) || (+a.classNum || 0) - (+b.classNum || 0) || (+a.num || 0) - (+b.num || 0)
    || String(a.name || "").localeCompare(String(b.name || ""), "ko");
}
function isTypingTarget(t) {
  if (!t || t.nodeType !== 1) return false;
  return !!(t.isContentEditable || t.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
}
function slideLabel(s) { return (s && s.title) || getSlideType(s?.type).label; }

// 타입별 썸네일 (실패해도 기본 썸네일)
function thumbOf(slide) {
  const def = getSlideType(slide.type);
  try {
    const n = typeof def.thumb === "function" ? def.thumb(slide) : null;
    if (n instanceof Node) return n;
  } catch (e) { console.warn("[teacher] thumb 실패", slide.type, e); }
  return el("div", { class: "thumb-generic" }, [
    el("span", { class: "thumb-icon", html: def.icon || "" }),
    el("span", { class: "thumb-title" }, slideLabel(slide)),
  ]);
}

function slideWarnings(slides) {
  const out = [];
  (slides || []).forEach((s, i) => {
    const def = getSlideType(s.type);
    let msg = null;
    try { msg = typeof def.validate === "function" ? def.validate(s) : null; } catch (e) { console.warn("[teacher] validate", e); }
    if (msg) out.push({ i, s, msg });
  });
  return out;
}

// ── 팝오버(메뉴·썸네일 스트립): 한 번에 하나 ──
let openPop = null;
function closePop() {
  const p = openPop;
  openPop = null;
  if (p) p.close();
}
// side: 'bottom'(기본, 아래 → 넘치면 위) | 'left'(앵커 왼쪽, 세로 가운데 — 오른쪽 레일용)
function popover(anchor, content, { className = "", align = "end", side = "bottom" } = {}) {
  closePop();
  const pop = el("div", { class: "popover " + className }, content);
  Object.assign(pop.style, { position: "fixed", left: "0px", top: "0px", visibility: "hidden" });
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  let left, top;
  if (side === "left") {
    left = r.left - pw - 8;
    if (left < 8) left = Math.max(8, Math.min(r.right + 8, vw - pw - 8));
    top = Math.min(Math.max(8, r.top + r.height / 2 - ph / 2), vh - ph - 8);
  } else {
    left = align === "center" ? r.left + r.width / 2 - pw / 2 : align === "start" ? r.left : r.right - pw;
    left = Math.max(8, Math.min(left, vw - pw - 8));
    top = r.bottom + 6;
    if (top + ph > vh - 8 && r.top - ph - 6 >= 8) top = r.top - ph - 6;
  }
  pop.style.left = left + "px";
  pop.style.top = Math.max(8, top) + "px";
  pop.style.visibility = "";
  const onDown = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closePop(); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); closePop(); } };
  const onScroll = (e) => { if (!pop.contains(e.target)) closePop(); };
  const onResize = () => closePop();
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
  const p = {
    anchor, el: pop,
    close() {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      pop.remove();
    },
  };
  openPop = p;
  return p;
}
// items: [{label, icon, danger, disabled, onClick} | {sep:true} | null]
function menuPop(anchor, items) {
  if (openPop && openPop.anchor === anchor) { closePop(); return; }
  const menu = el("div", { class: "menu", role: "menu" }, items.filter(Boolean).map(it => it.sep
    ? el("div", { class: "menu-sep" })
    : el("button", {
      class: "menu-item" + (it.danger ? " danger" : ""), type: "button", role: "menuitem", disabled: !!it.disabled,
      onClick: (e) => { e.stopPropagation(); closePop(); if (it.onClick) it.onClick(); },
    }, [it.icon ? icon(it.icon, 18) : null, it.label])));
  popover(anchor, menu, { className: "t-menu-pop" });
}

// ── QR ── (index.html이 qrcode를 defer로 불러오므로 준비될 때까지 잠시 재시도)
function drawQr(box, url) {
  let timer = 0, stopped = false, tries = 0;
  const canvas = el("canvas", { role: "img", "aria-label": "QR 코드" });
  box.replaceChildren(canvas);
  const fail = (t) => box.replaceChildren(el("div", { class: "muted" }, t));
  const run = () => {
    if (stopped) return;
    const Q = window.QRCode;
    if (Q && typeof Q.toCanvas === "function") {
      try {
        Q.toCanvas(canvas, url, { width: 480, margin: 1, errorCorrectionLevel: "M" }, (err) => {
          if (err) { fail("QR을 만들지 못했어요"); return; }
          canvas.style.width = ""; canvas.style.height = ""; // 크기는 CSS(.qr-box)가 정한다
        });
      } catch (e) { fail("QR을 만들지 못했어요"); }
      return;
    }
    if (++tries > 40) { fail("QR을 불러오지 못했어요"); return; }
    timer = setTimeout(run, 250);
  };
  run();
  return () => { stopped = true; clearTimeout(timer); };
}

// 참여 코드 창. sessionId가 있으면(수업 진행) 아래 줄에 이 수업의 복습 코드 + [복습 QR] [빈 학습지]
function openCodeModal(code, { sessionId = null, teacher = null } = {}) {
  const url = joinUrl(code);
  const qr = el("div", { class: "qr-box" });
  let review = null;
  if (sessionId) {
    const rc = el("b", {}, findSession(sessionId)?.reviewCode || "······");
    review = el("div", { class: "t-review-row" }, [
      el("span", { class: "muted" }, "복습 코드"), rc,
      el("button", { class: "btn btn-sm", type: "button", onClick: () => openReviewModal(sessionId, teacher) }, [icon("qr", 16), "복습 QR"]),
      reviewCopyBtn(sessionId, teacher, { label: "링크 복사" }),
      el("button", { class: "btn btn-sm", type: "button", onClick: () => { const s = findSession(sessionId); if (s) openBlankPrint({ session: s, teacher }); } }, [icon("print", 16), "빈 학습지"]),
    ]);
    cloudEnsureReviewCode(findSession(sessionId)).then(c => { rc.textContent = c || "——————"; });
  }
  const body = el("div", { class: "code-panel", style: { padding: "4px 0 0" } }, [
    el("div", { class: "code-big" }, code || "——————"),
    qr,
    el("div", { class: "code-url" }, url),
    review,
  ]);
  let stop = null;
  modal({
    title: "참여 코드", body,
    actions: [
      { label: "링크 복사", icon: "copy", onClick: () => { copyText(url, "링크를 복사했어요"); } },
      { label: "닫기", primary: true },
    ],
    onClose: () => { if (stop) stop(); },
  });
  stop = drawQr(qr, url);
}

// 복습 코드 창: 수업마다 다른 6자리 + QR(/r/CODE). 학습지를 인쇄하면 장마다 같은 QR이 들어간다.
function openReviewModal(sessionId, teacher) {
  const s0 = findSession(sessionId);
  if (!s0) return;
  const codeEl = el("div", { class: "code-big" }, s0.reviewCode || "······");
  const qr = el("div", { class: "qr-box" }, el("span", { class: "spinner", "aria-label": "불러오는 중" }));
  const urlEl = el("div", { class: "code-url" }, "");
  const body = el("div", { class: "code-panel", style: { padding: "4px 0 0" } }, [
    codeEl, qr, urlEl,
    el("div", { class: "muted t-review-note" }, "학습지에 장마다 함께 인쇄돼요"),
  ]);
  let stop = null, url = "", closed = false;
  modal({
    title: "복습 코드", body,
    actions: [
      { label: "링크 복사", icon: "copy", onClick: () => { if (url) copyText(url, "링크를 복사했어요"); } },
      { label: "빈 학습지 인쇄", icon: "print", onClick: (close) => { const s = findSession(sessionId); if (!s) return; close(); openBlankPrint({ session: s, teacher }); } },
      { label: "닫기", primary: true },
    ],
    onClose: () => { closed = true; if (stop) stop(); },
  });
  cloudEnsureReviewCode(s0).then(code => {
    if (closed) return;
    if (!code) { codeEl.textContent = "——————"; qr.replaceChildren(el("div", { class: "muted" }, "복습 코드를 만들지 못했어요")); return; }
    url = reviewUrl(code);
    codeEl.textContent = code;
    urlEl.textContent = url;
    stop = drawQr(qr, url);
  });
}

// 복습 링크 복사 — 결석했거나 다시 공부할 학생에게 보낼 주소(/r/CODE, 학생 페이스로 첫 슬라이드부터).
// 코드가 이미 있으면 누른 자리에서 바로 복사, 없으면 만들면서 복사(copyTextLater). 복사하지 못하면 복습 코드 창(코드·QR·주소)을 띄운다.
async function copyReviewLink(sessionId, teacher) {
  const s = findSession(sessionId);
  if (!s) return;
  const msg = "복습 링크를 복사했어요";
  const ok = s.reviewCode
    ? await copyText(reviewUrl(s.reviewCode), msg, { quiet: true })
    : await copyTextLater(cloudEnsureReviewCode(s).then(c => (c ? reviewUrl(c) : null)), msg, { quiet: true });
  if (!ok) openReviewModal(sessionId, teacher);
}
function reviewCopyBtn(sessionId, teacher, { cls = "btn btn-sm", label = "복습 링크" } = {}) {
  return el("button", {
    class: cls, type: "button", title: "복습 링크 복사 · 결석·복습 학생에게 보내기", "aria-label": "복습 링크 복사",
    onClick: (e) => { e.stopPropagation(); copyReviewLink(sessionId, teacher); },
    onKeydown: (e) => e.stopPropagation(),
  }, [icon("link", 16), el("span", { class: "t-rv-label" }, label)]);
}

// ── 수업 시작 (카드·편집기 공용) ──
const starting = new Set();
function setStarting(id, on) {
  if (on) starting.add(id); else starting.delete(id);
  document.querySelectorAll("[data-start]").forEach(b => {
    if (b.dataset.start !== id) return;
    b.classList.toggle("loading", on);
    b.disabled = on;
  });
}
async function startLesson(lessonId) {
  if (starting.has(lessonId)) return;
  setStarting(lessonId, true);
  try {
    let lesson = findLesson(lessonId);
    if (!lesson) { toast("수업 자료를 찾지 못했어요", { type: "error" }); return; }
    if (!Array.isArray(lesson.slides)) {
      try { await cloudFetchLessonSlides(lessonId); } catch (e) { toast("슬라이드를 불러오지 못했어요", { type: "error" }); return; }
      lesson = findLesson(lessonId);
      if (!lesson) return;
    }
    if (!(lesson.slides || []).length) { toast("슬라이드를 먼저 추가하세요"); return; }
    const warns = slideWarnings(lesson.slides);
    if (warns.length) {
      const list = el("ul", { class: "t-warn-list" }, warns.map(w => el("li", {}, `${w.i + 1}. ${slideLabel(w.s)} — ${w.msg}`)));
      const ok = await confirmDialog({ title: "확인이 필요한 슬라이드가 있어요", body: list, ok: "그래도 시작" });
      if (!ok) return;
    }
    // 수업(세션) 이름: 같은 자료로 여러 반을 수업해도 기록에서 구분되도록 (예: 임진왜란 3학년 2반)
    const prevName = mySessions(lesson.teacherId).find(x => x.lessonId === lessonId && x.title && x.title !== lesson.title)?.title;
    const name = await promptDialog({
      title: "수업 이름", value: prevName || lesson.title, placeholder: "예) 임진왜란 3학년 2반", ok: "시작", maxlength: 60,
    });
    if (name == null) return;
    const res = await cloudStartSession({ lesson: findLesson(lessonId) || lesson, teacher: currentTeacher(), title: name.trim() || lesson.title });
    if (!res || res.error) { toast((res && res.error) || "수업을 시작하지 못했어요", { type: "error" }); return; }
    go("/live/" + res.id);
  } catch (e) {
    console.warn("[teacher] 시작 실패", e);
    toast("수업을 시작하지 못했어요", { type: "error" });
  } finally {
    setStarting(lessonId, false);
  }
}

function liveSessionOf(tid) {
  return (store.state.sessions || []).filter(s => s.teacherId === tid && s.status === "live")
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] || null;
}
function mySessions(tid) {
  return (store.state.sessions || []).filter(s => s.teacherId === tid)
    .sort((a, b) => (a.status === "live" ? 0 : 1) - (b.status === "live" ? 0 : 1) || (b.startedAt || 0) - (a.startedAt || 0));
}

// ───────────────────────── 셸 (사이드바) ─────────────────────────
function mountShell(teacher, active, onTab) {
  ensureCss();
  const root = template("tpl-shell");
  mount(root);
  const who = root.querySelector("#t-who");
  if (who) who.textContent = teacher.name || "";
  root.querySelector("#t-logout")?.addEventListener("click", logout);
  const navs = [...root.querySelectorAll("[data-tab]")];
  const setActive = (tab) => navs.forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  navs.forEach(b => b.addEventListener("click", () => onTab(b.dataset.tab)));
  setActive(active);
  const content = root.querySelector("#tab-content");
  const banner = el("div", { class: "live-banner", hidden: true });
  content.before(banner);
  return { root, content, banner, setActive };
}

// 진행 중 배너: '진행 중 · 제목 [돌아가기]'
function bindBanner(banner, teacher) {
  let sig = null;
  const update = () => {
    const s = liveSessionOf(teacher.id);
    const nsig = s ? `${s.id}|${s.title}` : "";
    if (nsig === sig) return;
    sig = nsig;
    banner.hidden = !s;
    if (!s) { banner.replaceChildren(); return; }
    banner.replaceChildren(
      el("span", { class: "pill pill-live" }, "진행 중"),
      el("span", { class: "grow" }, s.title || "수업"),
      el("button", { class: "btn btn-sm btn-primary", type: "button", onClick: () => go("/live/" + s.id) }, "돌아가기"),
    );
  };
  update();
  return update;
}

// ───────────────────────── 대시보드 ─────────────────────────
export function teacherDashboard(params = {}) {
  return withTeacher((teacher) => {
    viewGuard();
    let tab = TABS.includes(params && params.tab) ? params.tab : "lessons";
    let ctl = null;
    const shell = mountShell(teacher, tab, (t) => switchTab(t));
    const updBanner = bindBanner(shell.banner, teacher);

    function switchTab(t) {
      if (!TABS.includes(t)) t = "lessons";
      if (ctl && t === tab) return;
      closePop();
      try { ctl && ctl.cleanup && ctl.cleanup(); } catch (e) { console.warn(e); }
      tab = t;
      shell.setActive(t);
      const h = t === "lessons" ? "#/teacher" : "#/teacher?tab=" + t;
      if (location.hash !== h) history.replaceState(null, "", h);
      shell.content.replaceChildren();
      ctl = TAB_VIEWS[t](shell.content, teacher) || {};
      window.scrollTo(0, 0);
    }
    switchTab(tab);

    const off = store.subscribe(() => {
      updBanner();
      try { ctl && ctl.onStore && ctl.onStore(); } catch (e) { console.error("[teacher] tab onStore", e); }
    });
    return () => {
      off();
      closePop();
      try { ctl && ctl.cleanup && ctl.cleanup(); } catch (e) { console.warn(e); }
      ctl = null;
    };
  });
}

// ── 수업 자료 탭 ──
function lessonsTab(box, teacher) {
  let disposed = false, busy = false, booted = false, sig = null;
  const fileIn = el("input", { type: "file", accept: ACCEPT, hidden: true });
  const progress = el("span", { class: "pill", hidden: true });
  const btnFile = el("button", { class: "btn", type: "button", onClick: () => fileIn.click() }, [icon("file", 18), "PDF·이미지로 만들기"]);
  const btnNew = el("button", { class: "btn btn-primary", type: "button", onClick: createBlank }, [icon("plus", 18), "새 수업"]);
  fileIn.addEventListener("change", onFile);
  const grid = el("div", { class: "card-grid" });
  box.append(
    el("div", { class: "page-head" }, [el("h1", {}, "수업 자료"), el("div", { class: "actions" }, [progress, btnFile, btnNew, fileIn])]),
    grid,
  );

  function myLessons() {
    return (store.state.lessons || []).filter(l => l.teacherId === teacher.id)
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  }
  function countOf(l) { return Array.isArray(l.slides) ? l.slides.length : (l.slideCount || 0); }
  function render() {
    if (disposed) return;
    const list = myLessons();
    const nsig = (booted ? "1" : "0") + list.map(l => [l.id, l.title, countOf(l), l.cover, l.updatedAt].join("|")).join("\n");
    if (nsig === sig) return;
    sig = nsig;
    if (!list.length) {
      grid.replaceChildren(el("div", { class: "empty empty-box", style: { gridColumn: "1 / -1" } }, booted ? "아직 자료가 없어요" : "불러오는 중…"));
      return;
    }
    grid.replaceChildren(...list.map(lessonCard));
  }
  function lessonCard(l) {
    const cover = el("div", { class: "cover" }, l.cover
      ? el("img", { src: l.cover, alt: "", loading: "lazy", decoding: "async", onError: (e) => e.target.replaceWith(el("div", { class: "t-paper" })) })
      : el("div", { class: "t-paper" }));
    const isStarting = starting.has(l.id);
    const btnStart = el("button", {
      class: "btn btn-sm btn-primary" + (isStarting ? " loading" : ""), type: "button", "data-start": l.id, disabled: isStarting,
      onClick: (e) => { e.stopPropagation(); startLesson(l.id); },
    }, [icon("play", 16), "시작"]);
    const btnMore = el("button", {
      class: "btn btn-sm btn-icon btn-ghost", type: "button", "aria-label": "더보기",
      onClick: (e) => { e.stopPropagation(); lessonMenu(btnMore, l.id); },
    }, icon("more", 18));
    const open = () => go("/editor/" + l.id);
    const card = el("div", {
      class: "card lesson-card", role: "button", tabindex: "0", "aria-label": l.title || "수업 자료",
      onClick: open,
      onKeydown: (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === card) { e.preventDefault(); open(); } },
    }, [
      cover,
      el("div", { class: "card-body" }, [
        el("div", { class: "card-title" }, l.title || "제목 없음"),
        el("div", { class: "card-meta" }, `${countOf(l)}장 · ${fmtDay(l.updatedAt || l.createdAt)}`),
        el("div", { class: "card-actions" }, [btnStart, el("span", { class: "spacer" }), btnMore]),
      ]),
    ]);
    return card;
  }
  function lessonMenu(anchor, lessonId) {
    menuPop(anchor, [
      { label: "편집", icon: "edit", onClick: () => go("/editor/" + lessonId) },
      typeof cloudDuplicateLesson === "function" ? { label: "복제", icon: "duplicate", onClick: () => duplicate(lessonId) } : null,
      { sep: true },
      { label: "삭제", icon: "trash", danger: true, onClick: () => remove(lessonId) },
    ]);
  }
  async function duplicate(lessonId) {
    const t = toast("복제하는 중…");
    let r;
    try { r = await cloudDuplicateLesson(lessonId); } catch (e) { r = { error: "복제하지 못했어요" }; }
    t.close();
    if (!r || r.error) toast((r && r.error) || "복제하지 못했어요", { type: "error" });
    else toast("복제했어요", { type: "ok" });
  }
  async function remove(lessonId) {
    const l = findLesson(lessonId);
    if (!l) return;
    // 가정: 진행 중 수업의 자료는 삭제 막음(cascade로 LIVE 세션이 사라져 학생 화면이 끊김)
    if ((store.state.sessions || []).some(s => s.lessonId === lessonId && s.status === "live")) {
      toast("진행 중인 수업을 먼저 종료하세요", { type: "warn" });
      return;
    }
    const nRec = (store.state.sessions || []).filter(s => s.lessonId === lessonId).length;
    const ok = await confirmDialog({
      title: "수업 자료를 삭제할까요?",
      body: nRec ? `${l.title || "제목 없음"} · 수업 기록 ${nRec}개도 함께 삭제돼요` : (l.title || "제목 없음"),
      ok: "삭제", danger: true,
    });
    if (!ok) return;
    let r;
    try { r = await cloudDeleteLesson(lessonId); } catch (e) { r = { error: "삭제하지 못했어요" }; }
    if (r && r.error) toast(r.error, { type: "error" });
    else toast("삭제했어요");
  }
  function setBusy(on) {
    busy = on;
    btnFile.disabled = on;
    btnNew.disabled = on;
  }
  async function createBlank() {
    if (busy) return;
    const title = await promptDialog({ title: "새 수업", placeholder: "수업 제목", ok: "만들기", maxlength: 80 });
    if (title == null || busy) return;
    setBusy(true);
    const lesson = { id: newId("lesson"), teacherId: teacher.id, title: title || "새 수업", slides: [createSlide("ink")] };
    let r;
    try { r = await cloudCreateLesson(lesson); } catch (e) { r = { error: "수업 자료를 만들지 못했어요" }; }
    setBusy(false);
    if (!r || r.error) { toast((r && r.error) || "수업 자료를 만들지 못했어요", { type: "error" }); return; }
    if (!disposed) go("/editor/" + lesson.id);
  }
  async function onFile() {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = "";
    if (!f || busy) return;
    setBusy(true);
    progress.hidden = false;
    progress.textContent = "준비 중…";
    const id = newId("lesson");
    try {
      const slides = await fileToSlides(f, id, (d, t) => { progress.textContent = t > 1 ? `만드는 중 ${d}/${t}` : "만드는 중…"; });
      if (!slides || !slides.length) throw new Error("빈 파일이에요");
      const title = String(f.name || "").replace(/\.[^.]+$/, "").trim() || "새 수업";
      const r = await cloudCreateLesson({ id, teacherId: teacher.id, title, slides });
      if (!r || r.error) throw new Error((r && r.error) || "수업 자료를 만들지 못했어요");
      if (!disposed) go("/editor/" + id);
      else toast("수업 자료를 만들었어요", { type: "ok" });
    } catch (e) {
      console.warn("[teacher] 파일 변환 실패", e);
      toast((e && e.message) || "파일을 불러오지 못했어요", { type: "error" });
    } finally {
      setBusy(false);
      progress.hidden = true;
    }
  }

  render();
  cloudReady.then(() => { booted = true; render(); });
  return { onStore: render, cleanup: () => { disposed = true; } };
}

// ── 수업 기록 탭 ──
function sessionRow(s, { onOpen, teacher = null } = {}) {
  const open = () => (onOpen ? onOpen(s.id) : go("/teacher/session/" + s.id));
  const row = el("div", {
    class: "list-row clickable", role: "button", tabindex: "0",
    onClick: open,
    onKeydown: (e) => { if (e.key === "Enter" && e.target === row) open(); },
  }, [
    el("div", { class: "grow" }, [
      el("div", { class: "title" }, s.title || "수업"),
      el("div", { class: "meta" }, `${fmtDate(s.startedAt)} · 참여 ${(s.participants || []).length}`),
    ]),
    statusPill(s.status),
    reviewCopyBtn(s.id, teacher, { cls: "btn btn-sm t-rv-copy" }),
    s.status === "live"
      ? el("button", { class: "btn btn-sm btn-primary", type: "button", onClick: (e) => { e.stopPropagation(); go("/live/" + s.id); } }, "돌아가기")
      : null,
  ]);
  return row;
}

function recordsTab(box, teacher) {
  const list = el("div", { class: "list" });
  const empty = el("div", { class: "empty empty-box" }, "끝난 수업이 여기 모여요");
  box.append(el("div", { class: "page-head" }, [el("h1", {}, "수업 기록")]), list, empty);
  let sig = null;
  function render() {
    const ss = mySessions(teacher.id);
    const nsig = ss.map(s => [s.id, s.title, s.status, s.startedAt, (s.participants || []).length].join("|")).join("\n");
    if (nsig === sig) return;
    sig = nsig;
    list.hidden = !ss.length;
    empty.hidden = !!ss.length;
    list.replaceChildren(...ss.map(s => sessionRow(s, { teacher })));
    // [복습 링크]가 누른 자리에서 바로 복사되게 이미 있는 복습 코드를 미리 읽어 둔다
    cloudFetchReviewCodes(ss.map(s => s.id)).catch(() => {});
  }
  render();
  return { onStore: render };
}

// ── 학생 탭 ──
function studentsTab(box, teacher) {
  const wrap = el("div", {});
  box.append(el("div", { class: "page-head" }, [el("h1", {}, "학생")]), wrap);
  let sig = null;
  function collect() {
    const by = new Map();
    for (const s of mySessions(teacher.id)) {
      for (const sid of s.participants || []) {
        if (!by.has(sid)) by.set(sid, []);
        by.get(sid).push(s.id);
      }
    }
    return [...by.entries()].map(([id, sessions]) => ({ id, st: findStudent(id), sessions }))
      .filter(r => r.st).sort((a, b) => cmpStudent(a.st, b.st));
  }
  function render() {
    const rows = collect();
    const nsig = rows.map(r => `${r.id}:${r.sessions.length}:${r.st.grade}-${r.st.classNum}-${r.st.num}-${r.st.name}`).join(",");
    if (nsig === sig) return;
    sig = nsig;
    if (!rows.length) { wrap.replaceChildren(el("div", { class: "empty empty-box" }, "아직 아무도 없어요")); return; }
    const head = el("tr", {}, [["학년", "num"], ["반", "num"], ["번호", "num"], ["이름", ""], ["참여", "num"]].map(([h, c]) => el("th", { class: c || null }, h)));
    const body = el("tbody", {}, rows.map(r => {
      const tr = el("tr", {
        class: "clickable", tabindex: "0",
        onClick: () => openStudent(r.id),
        onKeydown: (e) => { if (e.key === "Enter") openStudent(r.id); },
      }, [
        el("td", { class: "num" }, r.st.grade),
        el("td", { class: "num" }, r.st.classNum),
        el("td", { class: "num" }, r.st.num),
        el("td", {}, r.st.name),
        el("td", { class: "num" }, `${r.sessions.length}회`),
      ]);
      return tr;
    }));
    wrap.replaceChildren(el("div", { class: "table-wrap" }, el("table", { class: "table" }, [el("thead", {}, head), body])));
  }
  function openStudent(id) {
    const st = findStudent(id);
    const ss = mySessions(teacher.id).filter(s => (s.participants || []).includes(id));
    let sh = null;
    const body = ss.length
      ? el("div", { class: "list" }, ss.map(s => sessionRow(s, { teacher, onOpen: (sid) => { if (sh) sh.close(); go("/teacher/session/" + sid); } })))
      : el("div", { class: "empty" }, "끝난 수업이 여기 모여요");
    sh = sheet({ title: studentLabel(st), body });
  }
  render();
  return { onStore: render };
}

// ── 내 코드 탭 ──
function codeTab(box, teacher) {
  const t = currentTeacher() || teacher;
  const code = t.joinCode || "";
  const url = joinUrl(code);
  const qr = el("div", { class: "qr-box" });
  box.append(
    el("div", { class: "page-head" }, [el("h1", {}, "내 코드")]),
    el("div", { class: "card code-panel" }, [
      el("div", { class: "code-big" }, code || "——————"),
      qr,
      el("div", { class: "code-url" }, url),
      el("div", { class: "row" }, [
        el("button", { class: "btn", type: "button", disabled: !code, onClick: () => copyText(code, "코드를 복사했어요") }, [icon("copy", 18), "코드 복사"]),
        el("button", { class: "btn", type: "button", disabled: !code, onClick: () => copyText(url, "링크를 복사했어요") }, [icon("link", 18), "링크 복사"]),
      ]),
    ]),
  );
  const stop = code ? drawQr(qr, url) : null;
  return { cleanup: () => { if (stop) stop(); } };
}

const TAB_VIEWS = { lessons: lessonsTab, records: recordsTab, students: studentsTab, code: codeTab };

// ───────────────────────── 편집기 /editor/:id ─────────────────────────
export function editorView({ id } = {}) {
  return withTeacher((teacher) => {
    const alive = viewGuard();
    if (findLesson(id)) return buildEditor(id, teacher);
    return cloudReady.then(() => {
      if (!alive()) return () => {};
      if (!findLesson(id)) { toast("수업 자료를 찾지 못했어요"); redirect("/teacher"); return () => {}; }
      return buildEditor(id, teacher);
    });
  });
}

function buildEditor(lessonId, teacher) {
  ensureCss();
  wsCss();
  let disposed = false;
  let selId = null;
  let host = null;
  let saveSeq = 0;
  let fileBusy = false;
  let suppressClick = false;
  let dragActive = false;
  let dragAbort = null; // 진행 중 드래그 정리(화면 이탈 시 고스트·window 리스너 제거)
  let validateEl = null;
  const L = () => findLesson(lessonId);
  const slides = () => (L() && Array.isArray(L().slides) ? L().slides : []);
  const curSlide = () => slides().find(s => s.id === selId) || null;

  // ── 상단 바 ──
  const titleIn = el("input", { class: "title-input", type: "text", placeholder: "수업 제목", maxlength: "80", "aria-label": "수업 제목", autocomplete: "off" });
  titleIn.value = (L() && L().title) || "";
  const savePill = el("span", { class: "pill pill-muted" }, "저장됨");
  const retryBtn = el("button", { class: "btn btn-tiny", type: "button", hidden: true, onClick: () => doSave() }, "다시");
  const loadPill = el("span", { class: "pill", hidden: true });
  const btnStart = el("button", { class: "btn btn-primary", type: "button", "data-start": lessonId, onClick: onStart }, [icon("play", 18), "시작"]);
  const wsCnt = el("span", { class: "ws-cnt", hidden: true });
  const wsBtn = el("button", {
    class: "btn", type: "button", title: "학습지 — 수업 중 학생이 각자 필기하는 PDF·이미지", onClick: openWorksheet,
  }, [el("span", { "aria-hidden": "true" }, "📝"), el("span", { class: "hide-sm" }, "학습지"), wsCnt]);
  const top = el("header", { class: "topbar editor-top" }, [
    el("button", { class: "btn btn-icon btn-ghost", type: "button", "aria-label": "뒤로", onClick: () => go("/teacher") }, icon("chevron-left")),
    titleIn,
    el("span", { class: "topbar-group" }, [savePill, retryBtn, loadPill]),
    el("span", { class: "topbar-spacer" }),
    wsBtn,
    btnStart,
  ]);

  // ── 본문: 레일 | 스테이지 | 인스펙터 ──
  const railList = el("div", { class: "rail-list" });
  const fileIn = el("input", { type: "file", accept: ACCEPT, hidden: true });
  const btnAdd = el("button", { class: "rail-add", type: "button", onClick: openAddModal }, [icon("plus", 16), "슬라이드"]);
  const btnFile = el("button", { class: "rail-add", type: "button", onClick: () => fileIn.click() }, [icon("plus", 16), "파일"]);
  const rail = el("aside", { class: "rail", "aria-label": "슬라이드 목록" }, [railList, el("div", { class: "rail-foot" }, [btnAdd, btnFile, fileIn])]);
  const stage = el("section", { class: "stage editor-stage" });
  const insp = el("aside", { class: "inspector" });
  const root = el("div", { class: "editor" }, [top, el("div", { class: "editor-body" }, [rail, stage, insp])]);
  mount(root);

  // ── 저장 ──
  const saveSoon = debounce(() => doSave(), 300);
  function setSave(state) {
    savePill.className = "pill" + (state === "error" ? " pill-danger" : state === "saving" ? "" : " pill-muted");
    savePill.textContent = state === "error" ? "저장 실패" : state === "saving" ? "저장 중…" : "저장됨";
    retryBtn.hidden = state !== "error";
  }
  function markDirty() {
    const l = L();
    if (l) l.updatedAt = Date.now();
    if (!disposed) setSave("saving");
    saveSoon();
  }
  async function doSave() {
    saveSoon.cancel();
    const l = L();
    if (!l) return;
    const seq = ++saveSeq;
    if (!disposed) setSave("saving");
    let r;
    try { r = await cloudSaveLesson(l); } catch (e) { r = { error: e }; }
    if (seq !== saveSeq || saveSoon.pending()) return; // 더 최신 저장이 있음
    if (!disposed) setSave(r && r.error ? "error" : "saved");
    else if (r && r.error) toast("저장하지 못했어요", { type: "error" });
  }
  function showLoad(text) { loadPill.hidden = false; loadPill.textContent = text; }
  function hideLoad() { loadPill.hidden = true; }

  // 제목
  titleIn.addEventListener("input", () => { const l = L(); if (!l) return; l.title = titleIn.value; markDirty(); });
  titleIn.addEventListener("change", () => {
    const l = L();
    if (!l) return;
    const v = titleIn.value.trim();
    if (!v) { titleIn.value = l.title = "제목 없음"; markDirty(); }
    else if (v !== l.title) { l.title = v; markDirty(); }
  });
  titleIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) titleIn.blur(); });

  // ── 레일 ──
  const railMap = new Map(); // slideId → { item, thumb }
  function renderRail() {
    railMap.clear();
    railList.replaceChildren(...slides().map((s, i) => railItem(s, i)));
  }
  function railItem(s, i) {
    const thumb = el("div", { class: "t-thumb" }, thumbOf(s));
    const more = el("button", {
      class: "rail-more", type: "button", "aria-label": "슬라이드 메뉴",
      onClick: (e) => { e.stopPropagation(); slideMenu(more, s.id); },
    }, icon("more", 16));
    const item = el("div", {
      class: "rail-item" + (s.id === selId ? " active" : ""), role: "button", tabindex: "0", "data-id": s.id,
      "aria-label": `${i + 1}. ${slideLabel(s)}`,
      onClick: () => { if (!suppressClick) select(s.id); },
      onKeydown: (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === item) { e.preventDefault(); select(s.id); } },
      onContextmenu: (e) => { e.preventDefault(); if (!dragActive) slideMenu(more, s.id); },
    }, [thumb, el("span", { class: "rail-num" }, String(i + 1)), more]);
    bindDrag(item, s.id);
    railMap.set(s.id, { item, thumb });
    return item;
  }
  const thumbQ = new Set();
  const flushThumbs = debounce(() => {
    for (const id of thumbQ) {
      const r = railMap.get(id);
      const s = slides().find(x => x.id === id);
      if (r && s) r.thumb.replaceChildren(thumbOf(s));
    }
    thumbQ.clear();
  }, 300);
  function refreshThumb(id) { if (disposed) return; thumbQ.add(id); flushThumbs(); }

  // 포인터 드래그 정렬 (HTML5 DnD 금지). 마우스: 6px 이동 시 시작, 터치·펜: 380ms 누르고 있으면 시작
  function bindDrag(item, sid) {
    item.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".rail-more") || slides().length < 2) return;
      if (dragAbort) dragAbort();
      const pid = e.pointerId, mouse = e.pointerType === "mouse";
      const sx = e.clientX, sy = e.clientY;
      let lx = sx, ly = sy, dragging = false, ghost = null, offX = 0, offY = 0, before, hold = 0, moved = 0;
      const clearMarks = () => railList.querySelectorAll(".drop-above, .drop-below").forEach(n => n.classList.remove("drop-above", "drop-below"));
      const place = () => {
        if (!ghost) return;
        ghost.style.transform = `translate(${lx - offX}px, ${ly - offY}px) rotate(-1.5deg)`;
        const horiz = getComputedStyle(railList).flexDirection.startsWith("row");
        const others = [...railList.children].filter(n => n !== item);
        clearMarks();
        before = null;
        for (const n of others) {
          const r = n.getBoundingClientRect();
          const mid = horiz ? r.left + r.width / 2 : r.top + r.height / 2;
          if ((horiz ? lx : ly) < mid) { before = n; break; }
        }
        if (before) before.classList.add("drop-above");
        else if (others.length) others[others.length - 1].classList.add("drop-below");
      };
      const start = () => {
        if (dragging || disposed || !item.isConnected) return;
        dragging = dragActive = suppressClick = true;
        closePop();
        const r = item.getBoundingClientRect();
        offX = sx - r.left; offY = sy - r.top;
        ghost = item.cloneNode(true);
        ghost.classList.remove("active");
        ghost.classList.add("rail-ghost");
        Object.assign(ghost.style, { width: r.width + "px", height: r.height + "px", left: "0px", top: "0px", margin: "0" });
        document.body.appendChild(ghost);
        item.classList.add("dragging");
        try { item.setPointerCapture(pid); } catch (_) {}
        place();
      };
      const onMove = (ev) => {
        if (ev.pointerId !== pid) return;
        lx = ev.clientX; ly = ev.clientY;
        if (!dragging) {
          const d = Math.hypot(lx - sx, ly - sy);
          if (mouse && d > 6) start();
          else if (!mouse && d > 10) finish(false); // 스크롤 의도
          return;
        }
        if (ev.cancelable) ev.preventDefault();
        moved = Math.max(moved, Math.hypot(lx - sx, ly - sy));
        place();
      };
      const onTouch = (ev) => { if (dragging && ev.cancelable) ev.preventDefault(); };
      const onUp = (ev) => { if (ev.pointerId === pid) finish(true); };
      const onCancel = (ev) => { if (ev.pointerId === pid) finish(false); };
      function finish(commit) {
        if (dragAbort === abort) dragAbort = null;
        clearTimeout(hold);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        item.removeEventListener("touchmove", onTouch);
        if (!dragging) return;
        dragging = false;
        if (ghost) ghost.remove();
        ghost = null;
        item.classList.remove("dragging");
        clearMarks();
        try { item.releasePointerCapture(pid); } catch (_) {}
        setTimeout(() => { suppressClick = false; dragActive = false; }, 0);
        if (!commit || disposed) return;
        // 터치 길게 누르기만 하고 놓음 → 슬라이드 메뉴(명세 §9.1 '길게 누르기 = 메뉴')
        if (!mouse && moved < 8) {
          const more = item.querySelector(".rail-more");
          if (more && item.isConnected) slideMenu(more, sid);
          return;
        }
        if (before !== undefined) moveBefore(sid, before ? before.dataset.id : null);
      }
      const abort = () => finish(false);
      dragAbort = abort;
      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      item.addEventListener("touchmove", onTouch, { passive: false });
      if (!mouse) hold = setTimeout(start, 380);
    });
  }
  function moveBefore(sid, beforeId) {
    if (disposed) return;
    const list = slides();
    const from = list.findIndex(s => s.id === sid);
    if (from < 0) return;
    const order = list.map(s => s.id).join(",");
    const [s] = list.splice(from, 1);
    const to = beforeId ? list.findIndex(x => x.id === beforeId) : list.length;
    list.splice(to < 0 ? list.length : to, 0, s);
    if (list.map(x => x.id).join(",") === order) return;
    afterStructure(sid);
  }

  // ── 선택 · 스테이지 · 인스펙터 ──
  function select(id) {
    if (!slides().some(s => s.id === id)) id = (slides()[0] && slides()[0].id) || null;
    const changed = id !== selId || !host;
    selId = id;
    for (const [sid, r] of railMap) r.item.classList.toggle("active", sid === id);
    const r = railMap.get(id);
    if (r) r.item.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (changed) mountStage();
  }
  function mountStage() {
    closePop();
    if (host) { try { host.destroy(); } catch (e) { console.warn("[editor] host destroy", e); } host = null; }
    stage.replaceChildren();
    const s = curSlide();
    if (!s) {
      stage.appendChild(el("div", { class: "empty" }, "슬라이드를 추가하세요"));
      renderInspector();
      return;
    }
    const sid = s.id;
    host = mountSlideHost({
      role: "editor", root: stage, slide: s, lesson: L(), me: teacher,
      onEditorUpdate: (patch) => onSlidePatch(sid, patch),
    });
    renderInspector();
  }
  function onSlidePatch(slideId, patch) {
    const s = slides().find(x => x.id === slideId);
    if (s && patch && typeof patch === "object") Object.assign(s, patch);
    markDirty();
    refreshThumb(slideId);
    if (slideId === selId) updateValidate();
  }
  function renderInspector() {
    insp.replaceChildren();
    validateEl = null;
    const s = curSlide();
    if (!s) return;
    const def = getSlideType(s.type);
    const sid = s.id;
    const titleField = el("input", { type: "text", placeholder: def.label, maxlength: "80", autocomplete: "off" });
    titleField.value = s.title || "";
    titleField.addEventListener("input", () => {
      const cs = slides().find(x => x.id === sid);
      if (!cs) return;
      cs.title = titleField.value.trim() ? titleField.value : null;
      markDirty();
      refreshThumb(sid);
    });
    insp.append(
      el("div", { class: "inspector-title" }, def.label),
      el("label", { class: "field" }, [el("span", {}, "제목"), titleField]),
    );
    const extra = host && host.inspector;
    if (extra instanceof Node) insp.appendChild(extra);
    validateEl = el("div", { class: "validate", hidden: true, role: "status" });
    insp.appendChild(validateEl);
    updateValidate();
  }
  function updateValidate() {
    if (!validateEl) return;
    const s = curSlide();
    const def = s && getSlideType(s.type);
    let msg = null;
    try { msg = def && typeof def.validate === "function" ? def.validate(s) : null; } catch (e) { console.warn("[editor] validate", e); }
    validateEl.hidden = !msg;
    validateEl.textContent = msg || "";
  }

  // ── 구조 변경 ──
  function afterStructure(selectId) {
    const l = L();
    if (l) l.slideCount = slides().length;
    renderRail();
    select(selectId != null ? selectId : selId);
    markDirty();
  }
  function insertSlides(news) {
    const l = L();
    if (!l || !Array.isArray(l.slides) || !news || !news.length) return;
    const i = l.slides.findIndex(s => s.id === selId);
    l.slides.splice(i < 0 ? l.slides.length : i + 1, 0, ...news);
    afterStructure(news[0].id);
  }
  function slideMenu(anchor, sid) {
    const list = slides();
    const i = list.findIndex(s => s.id === sid);
    if (i < 0) return;
    menuPop(anchor, [
      { label: "복제", icon: "duplicate", onClick: () => duplicateSlide(sid) },
      { label: "위로", icon: "arrow-up", disabled: i === 0, onClick: () => moveSlide(sid, -1) },
      { label: "아래로", icon: "arrow-down", disabled: i === list.length - 1, onClick: () => moveSlide(sid, 1) },
      { sep: true },
      { label: "삭제", icon: "trash", danger: true, disabled: list.length <= 1, onClick: () => deleteSlide(sid) },
    ]);
  }
  function duplicateSlide(sid) {
    const list = slides();
    const i = list.findIndex(s => s.id === sid);
    if (i < 0) return;
    let copy;
    try { copy = JSON.parse(JSON.stringify(list[i])); } catch (e) { toast("복제하지 못했어요", { type: "error" }); return; }
    copy.id = newId("slide");
    if (copy.bgPath) copy.bgPath = null; // 가정: 이미지 파일 소유권은 원본에만
    freshHotspotIds(copy); // 팝업 상호작용 id 새로(같은 수업에서 응답이 섞이지 않게)
    list.splice(i + 1, 0, copy);
    afterStructure(copy.id);
  }
  function moveSlide(sid, d) {
    const list = slides();
    const i = list.findIndex(s => s.id === sid);
    const j = i + d;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    afterStructure(sid);
  }
  async function deleteSlide(sid) {
    if (slides().length <= 1) { toast("슬라이드가 하나뿐이에요"); return; }
    const ok = await confirmDialog({ title: "이 슬라이드를 삭제할까요?", ok: "삭제", danger: true });
    if (!ok || disposed) return;
    const list = slides();
    const i = list.findIndex(s => s.id === sid);
    if (i < 0 || list.length <= 1) return;
    list.splice(i, 1);
    const next = sid === selId ? (list[i] || list[i - 1]).id : selId;
    afterStructure(next);
  }

  // [+ 슬라이드] 타입 선택 모달
  function openAddModal() {
    const types = listSlideTypes();
    const groups = CATEGORIES.map(c => ({ label: c.label, list: types.filter(d => d.category === c.id) }));
    const rest = types.filter(d => !CATEGORIES.some(c => c.id === d.category));
    if (rest.length) groups.push({ label: "기타", list: rest });
    let m = null;
    const body = el("div", {}, groups.filter(g => g.list.length).map(g => el("section", { class: "type-section" }, [
      el("h4", {}, g.label),
      el("div", { class: "type-grid" }, g.list.map(d => el("button", {
        class: "type-card", type: "button", title: d.desc || d.label,
        onClick: () => {
          if (m) m.close();
          let s;
          try { s = createSlide(d.type); } catch (e) { console.warn("[editor] createSlide", e); toast("슬라이드를 만들지 못했어요", { type: "error" }); return; }
          insertSlides([s]);
        },
      }, [el("span", { class: "icon", html: d.icon || "" }), el("span", {}, d.label)]))),
    ])));
    m = modal({ title: "슬라이드 추가", body, wide: true });
  }

  // [+ 파일] PDF·이미지 → ink 여러 장
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = "";
    if (!f || fileBusy) return;
    fileBusy = true;
    btnFile.disabled = true;
    showLoad("올리는 중…");
    try {
      const news = await fileToSlides(f, lessonId, (d, t) => { if (!disposed) showLoad(t > 1 ? `올리는 중 ${d}/${t}` : "올리는 중…"); });
      if (!news || !news.length) throw new Error("빈 파일이에요");
      if (disposed) {
        // 화면을 떠났어도 올린 슬라이드는 자료 끝에 붙여 저장
        const l = L();
        if (l && Array.isArray(l.slides)) { l.slides.push(...news); cloudSaveLesson(l); }
        return;
      }
      insertSlides(news);
    } catch (e) {
      console.warn("[editor] 파일 추가 실패", e);
      toast((e && e.message) || "파일을 불러오지 못했어요", { type: "error" });
    } finally {
      fileBusy = false;
      btnFile.disabled = false;
      if (!disposed) hideLoad();
    }
  });

  async function onStart() {
    if (saveSoon.pending()) saveSoon.flush();
    await startLesson(lessonId);
  }

  // ── 학습지 관리 창: 쪽 목록(썸네일·순서·삭제) + [PDF·이미지 추가] → lesson.worksheet, 저장은 slides와 같은 디바운스 저장 ──
  let wsBusy = false;
  function syncWsBtn() {
    const n = (Array.isArray(L()?.worksheet) ? L().worksheet : []).length;
    wsCnt.hidden = !n;
    wsCnt.textContent = n ? String(n) : "";
  }
  async function openWorksheet() {
    const l0 = L();
    if (!l0) return;
    if (!Array.isArray(l0.worksheet)) {
      // 아직 안 불러온 자료(이 탭에서 만든 자료 등) → 서버에서 1회. 못 읽으면 저장이 DB 쪽을 지울 수 있어 열지 않는다
      wsBtn.classList.add("loading");
      let r = null;
      try { r = await cloudEnsureWorksheet(lessonId); } catch (e) { console.warn("[editor] 학습지 불러오기 실패", e); }
      wsBtn.classList.remove("loading");
      if (disposed) return;
      if (!Array.isArray(r)) { toast("학습지를 불러오지 못했어요", { type: "error" }); return; }
    }
    const pages = () => (Array.isArray(L()?.worksheet) ? L().worksheet : []);
    const grid = el("div", { class: "ws-grid" });
    const fileIn2 = el("input", { type: "file", accept: ACCEPT, multiple: true, hidden: true });
    const prog = el("span", { class: "pill", hidden: true });
    const addBtn = el("button", { class: "btn btn-primary", type: "button", disabled: wsBusy, onClick: () => fileIn2.click() }, [icon("plus", 18), "PDF·이미지 추가"]);
    const body = el("div", { class: "stack" }, [
      el("div", { class: "ws-tools" }, [addBtn, prog, fileIn2]),
      grid,
      el("div", { class: "ws-note" }, "수업 중 학생이 각자 필기하는 학습지예요. 학생은 화면 오른쪽 📝 탭으로 열어 쓰고, 교사는 같은 탭에서 학생들의 필기를 실시간으로 봐요. 수업 기록·인쇄에도 함께 들어가요."),
    ]);
    const m = modal({ title: "학습지", body, wide: true, actions: [{ label: "닫기", primary: true }] });
    function changed() { markDirty(); syncWsBtn(); renderGrid(); }
    function card(p, i, n) {
      const move = (d) => {
        const list = pages();
        const j = i + d;
        if (j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        changed();
      };
      const del = async () => {
        const ok = await confirmDialog({ title: `학습지 ${i + 1}쪽을 삭제할까요?`, ok: "삭제", danger: true });
        if (!ok || disposed) return;
        const list = pages();
        const k = list.findIndex(x => x.id === p.id);
        if (k >= 0) list.splice(k, 1);
        changed();
      };
      return el("div", { class: "ws-card" }, [
        el("div", { class: "ws-thumb" }, thumbOf(p)),
        el("div", { class: "ws-row" }, [
          el("span", { class: "ws-no" }, `${i + 1}쪽`),
          el("button", { class: "btn btn-icon btn-ghost", type: "button", "aria-label": "앞으로", title: "앞으로", disabled: i === 0, onClick: () => move(-1) }, icon("chevron-left", 16)),
          el("button", { class: "btn btn-icon btn-ghost", type: "button", "aria-label": "뒤로", title: "뒤로", disabled: i === n - 1, onClick: () => move(1) }, icon("chevron-right", 16)),
          el("button", { class: "btn btn-icon btn-ghost", type: "button", "aria-label": "삭제", title: "삭제", onClick: del }, icon("trash", 16)),
        ]),
      ]);
    }
    function renderGrid() {
      const list = pages();
      if (!list.length) {
        grid.replaceChildren(el("div", { class: "empty ws-empty", style: { gridColumn: "1 / -1" } }, "아직 학습지가 없어요 — PDF나 이미지를 올려 보세요"));
        return;
      }
      grid.replaceChildren(...list.map((p, i) => card(p, i, list.length)));
    }
    fileIn2.addEventListener("change", async () => {
      const files = [...(fileIn2.files || [])];
      fileIn2.value = "";
      if (!files.length || wsBusy) return;
      wsBusy = true;
      addBtn.disabled = true;
      prog.hidden = false;
      prog.textContent = "올리는 중…";
      try {
        for (const f of files) {
          const news = await fileToSlides(f, lessonId, (d, t) => { prog.textContent = t > 1 ? `올리는 중 ${d}/${t}` : "올리는 중…"; });
          const l = L();
          if (!l) return;
          if (!Array.isArray(l.worksheet)) l.worksheet = [];
          // 학습지 쪽은 늘 '개별' 모드의 ink 슬라이드 모양
          l.worksheet.push(...(news || []).map(s => ({ ...s, mode: "individual", title: null })));
        }
        changed();
      } catch (e) {
        console.warn("[editor] 학습지 추가 실패", e);
        toast((e && e.message) || "파일을 불러오지 못했어요", { type: "error" });
      } finally {
        wsBusy = false;
        addBtn.disabled = false;
        prog.hidden = true;
      }
    });
    renderGrid();
    return m;
  }

  // ── 불러오기 ──
  function setReady(on) {
    btnStart.disabled = !on || starting.has(lessonId);
    btnAdd.disabled = !on;
    btnFile.disabled = !on || fileBusy;
    wsBtn.disabled = !on;
  }
  async function load() {
    const l = L();
    if (!l) return;
    if (Array.isArray(l.slides)) { ready(); return; }
    setReady(false);
    stage.replaceChildren(el("div", { class: "empty" }, "불러오는 중…"));
    showLoad("불러오는 중…");
    try {
      await cloudFetchLessonSlides(lessonId, (d, t) => { if (!disposed) showLoad(t ? `불러오는 중 ${d}/${t}` : "불러오는 중…"); });
      if (disposed) return;
      hideLoad();
      ready();
    } catch (e) {
      if (disposed) return;
      console.warn("[editor] 슬라이드 불러오기 실패", e);
      hideLoad();
      stage.replaceChildren(el("div", { class: "empty" }, [
        el("div", {}, "슬라이드를 불러오지 못했어요"),
        el("button", { class: "btn btn-sm", type: "button", style: { marginTop: "12px" }, onClick: load }, [icon("refresh", 16), "다시"]),
      ]));
    }
  }
  function ready() {
    setReady(true);
    renderRail();
    select((slides()[0] && slides()[0].id) || null);
    syncWsBtn();
  }

  const onHide = () => saveSoon.flush();
  const onVis = () => { if (document.visibilityState === "hidden") saveSoon.flush(); };
  window.addEventListener("pagehide", onHide);
  document.addEventListener("visibilitychange", onVis);
  load();

  return () => {
    window.removeEventListener("pagehide", onHide);
    document.removeEventListener("visibilitychange", onVis);
    if (dragAbort) dragAbort();
    closePop();
    // host를 먼저 정리(입력 중이던 텍스트가 onEditorUpdate로 들어올 수 있음) → 그 뒤 저장 즉시 실행
    if (host) { try { host.destroy(); } catch (e) { console.warn(e); } host = null; }
    disposed = true;
    flushThumbs.cancel();
    saveSoon.flush();
  };
}

// ───────────────────────── 수업 진행 /live/:id ─────────────────────────
// 오른쪽 레일 칸: 아이콘(또는 이모지) + 이름표 + 배지 + 자물쇠. item.set({ hidden, active, hint, badge, tone, lock, title })
function railItem({ label, icon: ic, emoji, html, onClick }) {
  const badge = el("span", { class: "lr-badge", hidden: true });
  const lock = el("span", { class: "lr-lock", hidden: true, "aria-hidden": "true" }, icon("lock", 12));
  const glyph = emoji ? el("span", { class: "lr-ic lr-emoji", "aria-hidden": "true" }, emoji)
    : html ? el("span", { class: "lr-ic", "aria-hidden": "true", html })
    : el("span", { class: "lr-ic", "aria-hidden": "true" }, icon(ic, 22));
  const b = el("button", { class: "lr-item", type: "button", title: label, "aria-label": label, "aria-pressed": "false", onClick },
    [glyph, el("span", { class: "lr-label" }, label), badge, lock]);
  b.set = ({ hidden = false, active = false, hint = false, badge: n = 0, tone = "ok", lock: lk = false, title = null } = {}) => {
    b.hidden = !!hidden;
    b.classList.toggle("active", !!active);
    b.classList.toggle("hint", !!hint && !active);
    b.setAttribute("aria-pressed", String(!!active));
    const t = n > 0 ? String(n) : "";
    badge.hidden = !t;
    if (badge.textContent !== t) badge.textContent = t;
    badge.classList.toggle("muted", tone === "muted");
    lock.hidden = !lk;
    const tt = title || label;
    if (b.title !== tt) { b.title = tt; b.setAttribute("aria-label", tt); }
  };
  return b;
}

export function liveView({ id } = {}) {
  return withTeacher(async (teacher) => {
    ensureCss();
    const alive = viewGuard();
    mount(el("div", { class: "t-loading" }, el("span", { class: "spinner", "aria-label": "불러오는 중" })));
    let s0 = null;
    try { s0 = await ensureSession(id); } catch (e) { console.warn("[live] ensureSession", e); }
    if (!alive()) return () => {};
    if (!s0) { toast("수업을 찾지 못했어요"); redirect("/teacher"); return () => {}; }
    if (s0.status !== "live") { redirect("/teacher/session/" + id); return () => {}; }
    return buildLive(id, teacher);
  });
}

function buildLive(sessionId, teacher) {
  wsCss(); // 학습지 머리 줄·스위치 스타일(이 화면으로 바로 들어와도)
  let disposed = false, leaving = false, navBusy = false;
  let host = null, hostSlideId = null;
  // 오른쪽 패널: 레일에서 고른 하나만 — 'tools'(이 슬라이드 도구) | 'people'(참여) | null(닫힘)
  let panel = null;
  let autoTools = window.innerWidth >= 1100; // 넓은 화면: 도구가 있는 슬라이드로 오면 저절로 펼침(직접 닫으면 멈춤)
  let lastFlow = null, peopleSig = null, groupSig = null;
  const S = () => findSession(sessionId);
  const curSlide = (s = S()) => (s ? (s.slidesSnapshot || [])[s.currentSlide || 0] || null : null);

  const ch = joinSessionChannel(sessionId, { id: teacher.id, name: teacher.name, role: "teacher" });
  const unsub = subscribeSession(sessionId, { role: "teacher" });

  // ── 상단 바: 수업 흐름만 (코드 · 이동 · 모드(+모둠) · 진행 방식 · 종료) ──
  const code = (currentTeacher() || teacher).joinCode || "";
  const titleEl = el("div", { class: "topbar-title" });
  const codeBtn = el("button", { class: "code-pill", type: "button", title: "참여 코드", onClick: () => openCodeModal(code, { sessionId, teacher }) }, code || "코드");
  // 학습지 화면에서 슬라이드 이동을 누르면 슬라이드 화면으로 돌아간다
  const prevBtn = el("button", { class: "btn btn-icon btn-ghost", type: "button", "aria-label": "이전 슬라이드", onClick: () => { setWsOpen(false); step(-1); } }, icon("chevron-left"));
  const nextBtn = el("button", { class: "btn btn-icon btn-ghost", type: "button", "aria-label": "다음 슬라이드", onClick: () => { setWsOpen(false); step(1); } }, icon("chevron-right"));
  const countBtn = el("button", { class: "slide-count", type: "button", title: "슬라이드 이동", onClick: openStrip });
  const modeSeg = el("div", { class: "seg", role: "group", "aria-label": "모드" },
    MODES.map(([m, label]) => el("button", { type: "button", "data-mode": m, onClick: () => setMode(m) }, label)));
  const groupBtn = el("button", { class: "btn btn-sm btn-ghost t-group-btn", type: "button", hidden: true, onClick: openGroups });
  const flowBtn = el("button", { class: "btn btn-sm btn-ghost", type: "button", onClick: toggleFlow });
  const endBtn = el("button", { class: "btn btn-sm btn-danger", type: "button", onClick: endClass }, "종료");
  const savingPill = el("span", { class: "pill pill-warn", role: "status", hidden: true }, "저장 중…");
  const top = el("header", { class: "topbar live-top" }, [
    el("div", { class: "lt-side lt-left" }, [
      el("button", { class: "btn btn-icon btn-ghost", type: "button", "aria-label": "대시보드", title: "대시보드 (수업은 계속돼요)", onClick: () => go("/teacher") }, icon("arrow-left")),
      titleEl, savingPill, codeBtn,
    ]),
    el("div", { class: "slide-nav lt-nav" }, [prevBtn, countBtn, nextBtn]),
    el("div", { class: "lt-side lt-right" }, [modeSeg, groupBtn, flowBtn, endBtn]),
  ]);

  // ── 본문: 스테이지 | (패널) | 레일 ──
  const stage = el("section", { class: "stage live-stage" });
  // 학습지: 레일 📝 → 스테이지를 학생 필기 갤러리로(슬라이드 호스트는 숨긴 채 유지) · '학생 화면 고정' 스위치
  const wsView = makeWsSessionView();
  let wsOpen = false, wsIdx = 0, wsHost = null, wsHostPage = null, wsSegN = -1, wsTimer = null, wsForceBusy = false;
  const wsPrev = el("button", { class: "btn btn-icon btn-ghost btn-sm", type: "button", "aria-label": "이전 쪽", onClick: () => wsGo(wsIdx - 1) }, icon("chevron-left", 18));
  const wsNext = el("button", { class: "btn btn-icon btn-ghost btn-sm", type: "button", "aria-label": "다음 쪽", onClick: () => wsGo(wsIdx + 1) }, icon("chevron-right", 18));
  const wsPagesSeg = el("div", { class: "seg ws-pages", role: "group", "aria-label": "학습지 쪽" });
  const wsCount = el("span", { class: "slide-count", hidden: true });
  const wsStat = el("span", { class: "ws-stat" });
  const wsForceSw = el("button", { class: "ws-switch", type: "button", role: "switch", "aria-checked": "false", onClick: toggleWsForce }, [
    el("span", {}, "학생 화면 고정"),
    el("span", { class: "ws-switch-track", "aria-hidden": "true" }, el("span", { class: "ws-switch-knob" })),
  ]);
  const wsHead = el("div", { class: "ws-head" }, [
    el("span", { class: "ws-title" }, [el("span", { "aria-hidden": "true" }, "📝"), "학습지"]),
    wsPrev, wsPagesSeg, wsCount, wsNext, wsStat, el("span", { class: "spacer" }), wsForceSw,
  ]);
  const wsBody = el("div", { class: "ws-body" });
  const wsStage = el("section", { class: "stage live-stage ws-stage", hidden: true, "aria-label": "학습지" }, [el("div", { class: "ws-view" }, [wsHead, wsBody])]);
  // 오른쪽 레일: 학습지 · 참여 · 추가 · 도구 — 누를 때만 그 하나를 펼친다
  const railWs = railItem({ label: "학습지", emoji: "📝", onClick: () => setWsOpen(!wsOpen) });
  const railPeople = railItem({ label: "참여", icon: "users", onClick: () => togglePanel("people") });
  const railAdd = railItem({ label: "추가", icon: "plus", onClick: openAddPop });
  const railTools = railItem({ label: "도구", html: TOOLS_ICON, onClick: () => togglePanel("tools") });
  railWs.set({ hidden: true });
  railTools.set({ hidden: true });
  const rail = el("nav", { class: "live-rail", "aria-label": "수업 도구" }, [railWs, railPeople, railAdd, railTools]);
  // 패널(한 번에 하나): 도구 = 플러그인 panel, 참여 = 참가자 목록
  const drawerTitle = el("div", { class: "drawer-title" });
  const pluginBox = el("div", { class: "t-pane t-plugin-panel", hidden: true });
  const peopleHead = el("div", { class: "muted" });
  const peopleList = el("div", { class: "people" });
  const peopleBox = el("div", { class: "t-pane", hidden: true }, [peopleHead, peopleList]);
  const drawer = el("aside", { class: "drawer closed", "aria-label": "패널" }, [
    el("div", { class: "drawer-head" }, [
      drawerTitle,
      el("button", { class: "btn btn-icon btn-ghost btn-sm", type: "button", "aria-label": "닫기", onClick: () => setPanel(null, { user: true }) }, icon("x", 18)),
    ]),
    el("div", { class: "drawer-body" }, [pluginBox, peopleBox]),
  ]);
  const liveBody = el("div", { class: "live-body" }, [stage, wsStage, drawer, rail]);
  const root = el("div", { class: "live" }, [top, liveBody]);
  mount(root);

  // ── 팝업 상호작용(v2.9): 핀 → activity.__pop → 교사·학생 화면에 함께 ──
  const popView = createPopupView({ container: liveBody, role: "teacher", me: teacher, onClose: () => setPop(S(), null) });
  function togglePopup(id) {
    const s = S();
    if (!s || !id) return;
    const p = popOf(s);
    setPop(s, p && p.id === id ? null : id);
  }
  function syncPopup() {
    const s = S();
    const p = popOf(s);
    const ps = p ? findPopSlide(s, p.id) : null;
    // 다른 슬라이드로 넘어갔거나 핀이 사라졌으면 닫는다(학생 화면도 함께 닫힘)
    if (p && (!ps || (ps._parent && ps._parent !== (curSlide(s) || {}).id))) { popView.close(); setPop(s, null); return; }
    if (ps) popView.show(s, ps, { closable: true }); else popView.close();
  }

  // ── 동기화 ──
  function syncHost() {
    const s = S();
    const slide = curSlide(s);
    if (!slide) {
      if (host) { try { host.destroy(); } catch (e) { console.warn(e); } host = null; }
      hostSlideId = null;
      stage.replaceChildren(el("div", { class: "empty" }, "슬라이드가 없어요"));
      syncPanel(true);
      return;
    }
    // 같은 슬라이드: DOM 보존, 훅만 (플러그인이 panel을 바꿨을 수도 있어 패널만 가볍게 맞춤)
    if (host && hostSlideId === slide.id) { host.update({ slide, session: s }); syncPanel(false); return; }
    closePop();
    if (host) { try { host.destroy(); } catch (e) { console.warn("[live] host destroy", e); } host = null; }
    stage.replaceChildren();
    hostSlideId = slide.id;
    host = mountSlideHost({ role: "teacher", root: stage, slide, session: s, me: teacher, onPopup: togglePopup });
    syncPanel(true);
  }
  // 플러그인 panel → '도구'. changed = 슬라이드가 바뀜(넓은 화면이면 도구를 저절로 펼침)
  function syncPanel(changed) {
    const p = host ? host.panel : null;
    if (p instanceof Node) { if (pluginBox.firstChild !== p || pluginBox.childNodes.length !== 1) pluginBox.replaceChildren(p); }
    else if (pluginBox.firstChild) pluginBox.replaceChildren();
    const has = !!pluginBox.firstChild;
    if (!has && panel === "tools") setPanel(null);
    else if (changed && has && autoTools && panel !== "people" && !wsOpen) setPanel("tools");
    else syncDrawer();
  }
  // user = 교사가 직접 열고 닫음 → 도구 자동 펼침 켜고 끄기
  function setPanel(kind, { user = false } = {}) {
    if (kind === "tools" && !pluginBox.firstChild) kind = null;
    if (user) {
      if (kind === "tools") autoTools = true;
      else if (panel === "tools") autoTools = false;
    }
    panel = kind;
    syncDrawer();
  }
  function togglePanel(kind) { closePop(); setPanel(panel === kind ? null : kind, { user: true }); }
  function syncDrawer() {
    drawer.classList.toggle("closed", !panel);
    pluginBox.hidden = panel !== "tools";
    peopleBox.hidden = panel !== "people";
    const slide = curSlide();
    const t = panel === "people" ? "참여" : panel === "tools" ? `도구 · ${slide ? slideLabel(slide) : ""}` : "";
    if (drawerTitle.textContent !== t) drawerTitle.textContent = t;
    syncRail();
  }
  function syncRail() {
    const has = !!pluginBox.firstChild;
    const on = onlineSet().size;
    railPeople.set({ active: panel === "people", badge: on, tone: "muted", title: `참여 · 접속 ${on}명` });
    railAdd.set({ title: "추가 · 지금 슬라이드 다음에 끼워 넣기" });
    const slide = curSlide();
    railTools.set({
      hidden: !has, active: panel === "tools", hint: has && panel !== "tools",
      title: has && slide ? `도구 · ${getSlideType(slide.type).label} (마감·공개·응답)` : "도구",
    });
  }
  // 상단 바 [모둠]: 필기 슬라이드가 모둠 모드일 때만 — 모둠 편성 창(ink actions.groups)
  function openGroups() {
    const a = host && host.actions;
    if (a && typeof a.groups === "function") a.groups();
  }
  function syncTop() {
    const s = S();
    if (!s) return;
    const n = (s.slidesSnapshot || []).length;
    const i = s.currentSlide || 0;
    const slide = curSlide(s);
    titleEl.textContent = s.title || "수업";
    countBtn.textContent = n ? `${i + 1} / ${n}` : "0 / 0";
    prevBtn.disabled = i <= 0;
    nextBtn.disabled = i >= n - 1;
    const isInk = !!slide && slide.type === "ink";
    const m = isInk ? effectiveMode(slide, s) : null;
    modeSeg.classList.toggle("is-off", !isInk || wsOpen); // 학습지 화면에서는 숨김(가려진 슬라이드의 모드라 헷갈림). 자리는 상단 바 CSS가 정함
    if (isInk) {
      modeSeg.querySelectorAll("button").forEach(b => {
        const on = b.dataset.mode === m;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
    }
    groupBtn.hidden = false;
    groupBtn.classList.toggle("is-off", m !== "group" || wsOpen);
    if (m === "group") {
      const gs = s.groups || [];
      const assigned = new Set(gs.flatMap(g => g.memberIds || []));
      const left = [...new Set([...(s.participants || []), ...onlineSet()])].filter(id => !assigned.has(id)).length;
      const sig = `${gs.length}|${left}`;
      if (sig !== groupSig) {
        groupSig = sig;
        groupBtn.replaceChildren(...[icon("users", 16), el("span", {}, gs.length ? `${gs.length}모둠` : "모둠 편성"),
          gs.length && left ? el("span", { class: "t-group-left" }, `미배정 ${left}`) : null].filter(Boolean));
        groupBtn.title = gs.length ? `모둠 편성 · ${gs.length}모둠${left ? ` · 미배정 ${left}명` : ""}` : "모둠 편성";
      }
    }
    const flow = s.flow === "student" ? "student" : "teacher";
    if (flow !== lastFlow) {
      lastFlow = flow;
      const free = flow === "student";
      flowBtn.replaceChildren(icon(free ? "unlock" : "lock", 18), el("span", { class: "hide-sm t-flow-label" }, free ? "자유 이동" : "교사 진행"));
      flowBtn.title = free ? "자유 이동 (학생이 직접 넘김)" : "교사 진행";
      flowBtn.setAttribute("aria-pressed", String(free));
    }
  }
  function onlineSet() {
    try { return new Set(ch.online() || []); } catch (_) { return new Set(); }
  }
  function syncOnline() { syncRail(); }
  function syncPeople() {
    const s = S();
    if (!s) return;
    const slide = curSlide(s);
    const def = slide ? getSlideType(slide.type) : null;
    const interact = !!def && def.category === "interact";
    const online = onlineSet();
    const ids = [...new Set([...(s.participants || []), ...online])];
    const responded = new Set(interact ? ((s.responses || {})[slide.id] || []).map(r => r.studentId) : []);
    const groupOf = new Map();
    (s.groups || []).forEach(g => (g.memberIds || []).forEach(m => groupOf.set(m, g.name || "모둠")));
    const sig = JSON.stringify([ids, [...online], interact ? [...responded] : 0, [...groupOf], slide && slide.id,
      ids.map(id => (findStudent(id) ? 1 : 0)).join("")]);
    if (sig === peopleSig) return;
    peopleSig = sig;
    const onCount = ids.filter(x => online.has(x)).length;
    peopleHead.textContent = `참여 ${ids.length} · 접속 ${onCount}`;
    if (!ids.length) { peopleList.replaceChildren(el("div", { class: "empty" }, "아직 아무도 없어요")); return; }
    const rows = ids.map(id => ({ id, st: findStudent(id) })).sort((a, b) => cmpStudent(a.st, b.st));
    peopleList.replaceChildren(...rows.map(({ id, st }) => {
      const on = online.has(id);
      return el("div", { class: "person" + (on ? "" : " offline") }, [
        el("span", { class: "dot" + (on ? " on" : "") }),
        el("span", { class: "name" }, st ? studentLabel(st) : "학생"),
        interact && !responded.has(id) ? el("span", { class: "pending" }, "미제출") : null,
        groupOf.has(id) ? el("span", { class: "pill pill-muted" }, groupOf.get(id)) : null,
      ]);
    }));
  }

  // ── 학습지 ──
  function wsStudentIds(s) { return [...new Set([...(s.participants || []), ...onlineSet()])]; }
  function destroyWsHost() {
    if (wsHost) { try { wsHost.destroy(); } catch (e) { console.warn("[live] 학습지 host destroy", e); } }
    wsHost = null; wsHostPage = null;
    wsBody.replaceChildren();
  }
  function setWsOpen(on) {
    on = !!on && wsPages(S()).length > 0;
    if (on === wsOpen) return;
    wsOpen = on;
    closePop();
    stage.hidden = on;
    wsStage.hidden = !on;
    if (on && panel === "tools") setPanel(null);                 // 학습지 화면을 넓게(도구는 가려진 슬라이드 것)
    if (!on) { destroyWsHost(); if (autoTools && pluginBox.firstChild && !panel) setPanel("tools"); }
    syncTop();
    syncWs();
  }
  function wsGo(i) {
    const n = wsPages(S()).length;
    if (!n) return;
    i = Math.max(0, Math.min(n - 1, i));
    if (i === wsIdx) return;
    wsIdx = i;
    syncWs();
  }
  async function toggleWsForce() {
    const s = S();
    if (!s || wsForceBusy) return;
    wsForceBusy = true;
    const on = !wsForced(s);
    try {
      const r = await setWsForce(s, on);
      if (r && r.error) toast("저장하지 못했어요", { type: "error" });
      else toast(on ? "모든 학생 화면에 학습지를 띄웠어요" : "학생이 학습지를 닫을 수 있어요");
    } finally { wsForceBusy = false; }
  }
  // 쪽 버튼(12쪽까지: 번호 + 그 쪽을 지금 쓰는 인원 배지, 더 많으면 n / N)
  function buildWsSeg(n) {
    wsSegN = n;
    const many = n > 12;
    wsPagesSeg.hidden = many;
    wsCount.hidden = !many;
    wsPagesSeg.replaceChildren(...(many ? [] : Array.from({ length: n }, (_, i) => el("button", {
      type: "button", title: `${i + 1}쪽`, onClick: () => wsGo(i),
    }, [String(i + 1), el("i", { class: "ws-dot", hidden: true })]))));
  }
  function syncWs() {
    if (disposed) return;
    const s = S();
    if (!s) return;
    const pages = wsPages(s);
    const n = pages.length;
    if (!n) {
      railWs.set({ hidden: true });
      if (wsOpen) setWsOpen(false);
      return;
    }
    const st = wsStats(s, wsStudentIds(s));
    const forced = wsForced(s);
    const statTxt = `작성 중 ${st.writing} · 작성함 ${st.written}/${st.total}`;
    railWs.set({
      active: wsOpen, badge: st.writing, lock: forced,
      title: `${wsOpen ? "학습지 닫기" : "학습지"} · ${n}쪽 · ${statTxt}${forced ? " · 학생 화면 고정 중" : ""}`,
    });
    if (wsForceSw.getAttribute("aria-checked") !== String(forced)) wsForceSw.setAttribute("aria-checked", String(forced));
    const swTitle = forced ? "켜짐: 모든 학생 화면이 학습지로 고정돼요(쪽은 자유) · 끄면 학생이 닫을 수 있어요" : "켜면 모든 학생 화면이 학습지로 바뀌고 고정돼요(쪽은 자유)";
    if (wsForceSw.title !== swTitle) wsForceSw.title = swTitle;
    if (!wsOpen) return;
    wsIdx = Math.max(0, Math.min(n - 1, wsIdx));
    if (wsSegN !== n) buildWsSeg(n);
    if (n > 12) wsCount.textContent = `${wsIdx + 1} / ${n}`;
    else wsPagesSeg.querySelectorAll("button").forEach((b, i) => {
      b.classList.toggle("active", i === wsIdx);
      b.setAttribute("aria-pressed", String(i === wsIdx));
      const dot = b.querySelector(".ws-dot");
      const w = st.perPage[i] ? st.perPage[i].writing : 0;
      if (dot) { dot.hidden = !w; if (w && dot.textContent !== String(w)) dot.textContent = String(w); }
    });
    wsPrev.disabled = wsIdx <= 0;
    wsNext.disabled = wsIdx >= n - 1;
    wsStat.textContent = statTxt;
    const page = pages[wsIdx];
    if (wsHost && wsHostPage === page.id) { wsHost.update({ slide: page, session: s }); return; }
    destroyWsHost();
    wsHostPage = page.id;
    try { wsHost = mountSlideHost({ role: "teacher", root: wsBody, slide: page, session: s, me: teacher, sessionView: wsView }); }
    catch (e) {
      console.error("[live] 학습지 표시 실패", e);
      wsHost = null;
      wsBody.replaceChildren(el("div", { class: "empty" }, "학습지를 불러오지 못했어요"));
    }
  }

  // ── 이동 · 모드 · 흐름 · 종료 ──
  function step(d) { const s = S(); if (s) goTo((s.currentSlide || 0) + d); }
  async function goTo(idx) {
    if (navBusy || disposed) return;
    let s = S();
    if (!s) return;
    const n = (s.slidesSnapshot || []).length;
    if (!n) return;
    idx = Math.max(0, Math.min(n - 1, idx));
    if (idx === (s.currentSlide || 0)) return;
    const cur = curSlide(s);
    const patch = { currentSlide: idx };
    if (cur && getSlideType(cur.type).category === "game" && ((s.activity || {})[cur.id] || {}).phase === "running") {
      navBusy = true;
      const ok = await confirmDialog({ title: "게임을 종료하고 넘어갈까요?", ok: "종료하고 이동" });
      navBusy = false;
      if (!ok || disposed) return;
      s = S();
      if (!s) return;
      const act = s.activity || {};
      // 가정: 게임 강제 종료 시 endedAt 을 기록해 race 시뮬레이션이 그 시각에서 멈추게 한다(dino 는 endedAt 무시, endsAt 만 정리).
      patch.activity = { ...act, [cur.id]: { ...(act[cur.id] || {}), phase: "ended", endedAt: Date.now(), endsAt: null } };
    }
    patchSession(s, patch);
  }
  function setMode(m) {
    const s = S();
    const slide = curSlide(s);
    if (!s || !slide || effectiveMode(slide, s) === m) return;
    const act = s.activity || {};
    patchSession(s, { activity: { ...act, [slide.id]: { ...(act[slide.id] || {}), mode: m } } });
    // 모둠으로 바꿨는데 모둠이 없으면 바로 편성 창
    if (m === "group" && !(s.groups || []).length) setTimeout(() => { if (!disposed) openGroups(); }, 0);
  }
  function toggleFlow() {
    const s = S();
    if (s) patchSession(s, { flow: s.flow === "student" ? "teacher" : "student" });
  }
  async function endClass() {
    const ok = await confirmDialog({ title: "수업을 종료할까요?", ok: "종료", danger: true });
    if (!ok || disposed) return;
    const s = S();
    if (!s) return;
    leaving = true;
    endBtn.classList.add("loading");
    endBtn.disabled = true;
    let r;
    try { r = await cloudEndSession(s, "completed"); } catch (e) { r = { error: e }; }
    if (disposed) return;
    if (r && r.error) {
      // 실패: 조용히 떠나지 않고 진행 화면 유지 (cloud.js가 백오프 재시도 중이면 _statusPending → '저장 중…')
      leaving = false;
      endBtn.classList.remove("loading");
      endBtn.disabled = false;
      const cur = S();
      savingPill.hidden = !(cur && cur._statusPending);
      toast("수업 종료를 저장하지 못했어요. 다시 시도해 주세요", { type: "error" });
      return;
    }
    go("/teacher/session/" + sessionId, { replace: true });
  }

  // ── 수업 중 상호작용 추가: 현재 다음에 끼워 넣고 그 슬라이드로 → 성공 여부 ──
  async function insertNext(draft) {
    let s = S();
    if (!s || disposed) return false;
    setWsOpen(false); // 새 슬라이드가 보이게
    // 진행 중인 게임에서 떠날 때는 이동과 같은 확인
    const cur = curSlide(s);
    if (cur && getSlideType(cur.type).category === "game" && ((s.activity || {})[cur.id] || {}).phase === "running") {
      const ok = await confirmDialog({ title: "게임을 종료하고 넘어갈까요?", ok: "종료하고 이동" });
      if (!ok || disposed) return false;
      s = S();
      const act = s.activity || {};
      patchSession(s, { activity: { ...act, [cur.id]: { ...(act[cur.id] || {}), phase: "ended", endedAt: Date.now(), endsAt: null } } });
    }
    const r = await cloudInsertSessionSlide(s, draft, (s.currentSlide || 0) + 1);
    if (!r || r.error) { toast((r && r.error) || "슬라이드를 추가하지 못했어요", { type: "error" }); return false; }
    return true;
  }
  // 빈 슬라이드: 채울 내용이 없으니 창 없이 바로 (두 번 눌러도 한 장만 — 끝난 뒤 0.7초 더 잠금)
  let blankBusy = false;
  async function addBlank() {
    if (blankBusy) return;
    blankBusy = true;
    try { await insertNext(createSlide("ink", { title: "빈 슬라이드", mode: "whole" })); } // 수업 중 빈 칠판은 바로 함께 쓰게 '전체'
    catch (e) { console.warn("[live] 빈 슬라이드", e); toast("슬라이드를 추가하지 못했어요", { type: "error" }); }
    finally { setTimeout(() => { blankBusy = false; }, 700); }
  }
  // 편집기 창 → [추가하고 이동]
  function openQuickAdd(type) {
    const def = getSlideType(type);
    let draft;
    try { draft = createSlide(type); } catch (e) { console.warn("[live] createSlide", e); toast("슬라이드를 만들지 못했어요", { type: "error" }); return; }
    const box = el("div", { class: "t-quick-editor" });
    let ed = null;
    modal({
      title: `${def.label} 추가`, body: box, wide: true,
      actions: [
        { label: "취소" },
        { label: "추가하고 이동", primary: true, icon: "plus", onClick: async (close) => {
          if (box.querySelector(".qi-busy")) { toast("그림을 올리는 중이에요. 잠시 뒤 다시 눌러 주세요"); return; }
          const msg = typeof def.validate === "function" ? def.validate(draft) : null;
          if (msg) { toast(msg); return; }
          if (await insertNext(draft)) close();
        } },
      ],
      onClose: () => { try { ed && ed.destroy(); } catch (_) {} },
    });
    const lesson = findLesson(S()?.lessonId) || (S()?.lessonId ? { id: S().lessonId } : null); // 그림 올릴 폴더
    try { ed = mountSlideHost({ role: "editor", root: box, slide: draft, lesson, onEditorUpdate: () => {} }); }
    catch (e) { console.warn("[live] 편집기 표시 실패", e); box.replaceChildren(el("div", { class: "empty" }, "편집기를 불러오지 못했어요")); }
  }

  // 레일 [추가]: 지금 슬라이드 다음에 끼워 넣을 상호작용 고르기(작은 창, 고르면 닫힘)
  function openAddPop() {
    if (openPop && openPop.anchor === railAdd) { closePop(); return; }
    const item = (iconHtml, label, title, fn) => el("button", {
      class: "lr-add-btn", type: "button", title, onClick: () => { closePop(); fn(); },
    }, [el("span", { class: "icon", html: iconHtml }), el("span", {}, label)]);
    const box = el("div", { class: "lr-add" }, [
      el("div", { class: "lr-add-head" }, "지금 슬라이드 다음에 추가"),
      el("div", { class: "lr-add-grid" }, [
        item(BLANK_ICON, "빈 슬라이드", "흰 필기 슬라이드를 바로 추가", addBlank),
        ...QUICK_TYPES.map(t => getSlideType(t)).filter((d, i) => d && d.type === QUICK_TYPES[i])
          .map(d => item(d.icon || "", d.label, d.desc || d.label, () => openQuickAdd(d.type))),
      ]),
    ]);
    popover(railAdd, box, { className: "lr-add-pop", side: "left" });
  }

  // 썸네일 스트립으로 점프
  function openStrip() {
    if (openPop && openPop.anchor === countBtn) { closePop(); return; }
    const s = S();
    if (!s) return;
    const cur = s.currentSlide || 0;
    const strip = el("div", { class: "thumb-strip" }, (s.slidesSnapshot || []).map((sl, i) => el("button", {
      class: "rail-item" + (i === cur ? " active" : ""), type: "button", title: slideLabel(sl),
      onClick: () => { closePop(); setWsOpen(false); goTo(i); },
    }, [el("div", { class: "t-thumb" }, thumbOf(sl)), el("span", { class: "rail-num" }, String(i + 1))])));
    popover(countBtn, strip, { className: "t-strip-pop", align: "center" });
    const a = strip.querySelector(".active");
    if (a) strip.scrollLeft = Math.max(0, a.offsetLeft - strip.offsetLeft - strip.clientWidth / 2 + a.offsetWidth / 2);
  }

  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen?.().catch?.(() => {});
      else document.documentElement.requestFullscreen?.().catch?.(() => {});
    } catch (_) {}
  }
  const onKey = (e) => {
    if (disposed || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    if (isTypingTarget(e.target)) return;
    // 학습지 화면이 열려 있으면 ←/→는 학습지 쪽(보고 있는 것을 넘긴다)
    if (e.key === "ArrowLeft") { e.preventDefault(); if (wsOpen) wsGo(wsIdx - 1); else step(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); if (wsOpen) wsGo(wsIdx + 1); else step(1); }
    else if (e.code === "KeyF" || e.key === "f" || e.key === "F") { e.preventDefault(); toggleFullscreen(); }
    else if (e.key === "Escape") {
      if (openPop) closePop();
      else if (document.documentElement.classList.contains("has-layer")) return;
      else if (popView.id) setPop(S(), null);
      else if (wsOpen) setWsOpen(false);
      else if (panel) setPanel(null, { user: true });
    }
  };
  document.addEventListener("keydown", onKey);

  const offPres = ch.onPresence(() => { if (disposed) return; syncOnline(); syncPeople(); syncWs(); });
  const offStore = store.subscribe(() => {
    if (disposed) return;
    const s = S();
    savingPill.hidden = !(s && s._statusPending);
    if (leaving) return;
    // 다른 곳에서 삭제/종료됨 → 리스너 안에서 바로 dispatch하지 않게 다음 틱에 교체 이동
    if (!s) { leaving = true; toast("수업을 찾지 못했어요"); redirect("/teacher"); return; }
    // 종료 저장이 재시도 중(_statusPending)이면 아직 떠나지 않는다 — 성공해 플래그가 풀리면 다음 알림에서 이동
    if (s.status !== "live" && !s._statusPending) { leaving = true; toast("수업이 끝났어요"); redirect("/teacher/session/" + sessionId); return; }
    syncHost();
    syncTop();
    syncPeople();
    syncWs();
    syncPopup();
  });

  syncTop();
  syncHost();
  syncOnline();
  syncPeople();
  syncWs();
  syncPopup();
  // '작성 중'(최근 20초)은 시간이 지나면 저절로 풀리므로 주기적으로 배지만 다시 셈
  wsTimer = setInterval(() => { if (!disposed && wsPages(S()).length) syncWs(); }, 5000);

  return () => {
    disposed = true;
    clearInterval(wsTimer);
    document.removeEventListener("keydown", onKey);
    offStore();
    try { offPres(); } catch (_) {}
    closePop();
    popView.close();
    destroyWsHost();
    if (host) { try { host.destroy(); } catch (e) { console.warn(e); } host = null; }
    try { unsub(); } catch (_) {}
    try { ch.leave(); } catch (_) {}
  };
}

// ───────────────────────── 기록 상세 /teacher/session/:id ─────────────────────────
// summary용 ctx (읽기 전용 — 쓰기 함수는 no-op)
function recordCtx(session, teacher, slide, timers, extra = {}) {
  const sess = () => findSession(session.id) || session;
  return {
    role: "teacher", isTeacher: true, me: teacher, slide, lesson: null,
    session: sess,
    students: studentsMap,
    participants: () => (sess().participants || []).slice(),
    online: () => new Set(),
    activity: () => ((sess().activity || {})[slide.id]) || { phase: "idle" },
    setActivity() {},
    responses: () => ((sess().responses || {})[slide.id]) || [],
    myResponse: () => null,
    submit: async () => null,
    removeResponse: async () => {},
    clearResponses: async () => {},
    send() {},
    on: () => () => {},
    groups: () => sess().groups || [],
    myGroup: () => null,
    toast,
    confirm: (msg, { ok = "확인", danger = false } = {}) => confirmDialog({ title: msg, ok, danger }),
    modal,
    injectCss,
    timeout(fn, ms) { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.set(t, "t"); return t; },
    interval(fn, ms) { const t = setInterval(fn, ms); timers.set(t, "i"); return t; },
    clearTimer(t) { if (timers.get(t) === "i") clearInterval(t); else clearTimeout(t); timers.delete(t); },
    ...extra,
  };
}

function summaryEl(session, slide, responses, ctx) {
  const def = getSlideType(slide.type);
  if (typeof def.summary !== "function") return el("div", { class: "t-sum-thumb" }, el("div", { class: "t-thumb" }, thumbOf(slide)));
  try {
    const n = def.summary(slide, responses, session, ctx);
    if (n instanceof Node) return n;
  } catch (e) {
    console.warn("[detail] summary 실패", slide.type, e);
    return el("div", { class: "muted" }, "이 슬라이드를 불러오지 못했어요");
  }
  return el("div", { class: "muted" }, "기록이 없어요");
}

// tag: 타입 라벨 대신 보여 줄 표지(학습지 쪽은 '학습지')
function slideSection(slide, i, body, tag = null) {
  const def = getSlideType(slide.type);
  return el("section", { class: "card print-slide" }, [
    el("div", { class: "t-sum-head" }, [
      el("span", { class: "t-sum-num" }, String(i + 1)),
      el("h3", {}, slideLabel(slide)),
      el("span", { class: "pill " + (tag ? "pill-accent" : "pill-muted") }, tag || def.label),
    ]),
    body,
  ]);
}

export function sessionDetailView({ id } = {}) {
  return withTeacher((teacher) => {
    viewGuard();
    let disposed = false;
    let mode = "slides";
    let picked = null;
    let frames = [];
    const timers = new Map();
    const shell = mountShell(teacher, "records", (t) => go(t === "lessons" ? "/teacher" : "/teacher?tab=" + t));
    const updBanner = bindBanner(shell.banner, teacher);
    const offStore = store.subscribe(() => { if (!disposed) updBanner(); });
    const box = shell.content;
    const content = el("div", { class: "stack-lg" });
    const backBtn = () => el("button", { class: "btn btn-icon btn-ghost", type: "button", "aria-label": "수업 기록", onClick: () => go("/teacher?tab=records") }, icon("arrow-left"));
    box.replaceChildren(el("div", { class: "empty" }, "불러오는 중…"));

    function clearFrames() {
      frames.forEach(v => { try { v.destroy(); } catch (_) {} });
      frames = [];
      for (const [t, k] of timers) { if (k === "i") clearInterval(t); else clearTimeout(t); }
      timers.clear();
    }
    function participantsOf(s) {
      const responders = Object.values(s.responses || {}).flat().map(r => r && r.studentId).filter(Boolean);
      return [...new Set([...(s.participants || []), ...responders])]
        .map(sid => ({ id: sid, st: findStudent(sid) }))
        .sort((a, b) => cmpStudent(a.st, b.st));
    }
    function abtn(label, { cls = "btn", ic, onClick, title } = {}) {
      const b = el("button", { class: cls, type: "button", title: title || null }, [ic ? icon(ic, 18) : null, label]);
      b.addEventListener("click", async () => {
        if (b.classList.contains("loading")) return;
        b.classList.add("loading");
        try { await onClick(); } finally { if (b.isConnected) b.classList.remove("loading"); }
      });
      return b;
    }

    async function resume() {
      const s = findSession(id);
      if (!s) return;
      let r;
      try { r = await cloudResumeSession(s); } catch (e) { r = { error: "다시 시작하지 못했어요" }; }
      if (!r || r.error) { toast((r && r.error) || "다시 시작하지 못했어요", { type: "error" }); return; }
      if (!disposed) go("/live/" + id);
    }
    async function remove() {
      const cur = findSession(id);
      const ok = await confirmDialog({
        title: "이 기록을 삭제할까요?", body: cur && cur.status === "live" ? "진행 중인 수업도 함께 끝나요" : undefined,
        ok: "삭제", danger: true,
      });
      if (!ok || disposed) return;
      let r;
      try {
        // LIVE면 먼저 종료(학생 화면이 sessions 행 변경으로 '수업이 끝났어요' 처리) 후 삭제
        const live = findSession(id);
        if (live && live.status === "live") await cloudEndSession(live, "stopped");
        r = await cloudDeleteSession(id);
      } catch (e) { r = { error: "삭제하지 못했어요" }; }
      if (r && r.error) { toast(r.error, { type: "error" }); return; }
      toast("삭제했어요");
      if (!disposed) go("/teacher?tab=records", { replace: true });
    }

    async function rename() {
      const cur = findSession(id);
      if (!cur) return;
      const name = await promptDialog({ title: "수업 이름", value: cur.title || "", placeholder: "예) 임진왜란 3학년 2반", ok: "저장", maxlength: 60 });
      if (name == null || disposed) return;
      const v = name.trim();
      if (!v || v === cur.title) return;
      const r = await patchSession(cur, { title: v });
      if (r && r.error) { toast("이름을 바꾸지 못했어요", { type: "error" }); return; }
      if (!disposed) render();
    }
    // 학생별 보기에서는 그 학생 결과를 학습지처럼, 슬라이드별 보기는 화면 그대로 인쇄
    async function printView() {
      const cur = findSession(id);
      if (!cur) return;
      if (mode === "students" && picked) {
        await printStudents({ session: cur, studentIds: [picked], slideIds: (cur.slidesSnapshot || []).map(x => x.id), teacher });
      } else {
        await printRecordView();
      }
    }

    function render() {
      const s = findSession(id);
      if (!s || disposed) return;
      const slides = s.slidesSnapshot || [];
      const parts = participantsOf(s);
      const head = el("div", { class: "page-head" }, [
        backBtn(),
        el("h1", {}, s.title || "수업"),
        el("button", { class: "btn btn-icon btn-ghost no-print", type: "button", "aria-label": "수업 이름 바꾸기", title: "이름 바꾸기", onClick: rename }, icon("edit", 18)),
        el("div", { class: "actions" }, [
          s.status === "live"
            ? el("button", { class: "btn btn-primary", type: "button", onClick: () => go("/live/" + id) }, "돌아가기")
            : abtn("이어서", { cls: "btn btn-primary", ic: "play", onClick: resume }),
          abtn("인쇄", { ic: "print", onClick: printView }),
          el("button", { class: "btn", type: "button", onClick: () => { const cur = findSession(id); if (cur) openStudentPrint({ session: cur, teacher }); } }, [icon("users", 18), "학생 인쇄"]),
          el("button", { class: "btn", type: "button", onClick: () => { const cur = findSession(id); if (cur) openBlankPrint({ session: cur, teacher }); } }, [icon("file", 18), "빈 학습지"]),
          abtn("삭제", { cls: "btn btn-danger", ic: "trash", onClick: remove }),
        ]),
      ]);
      const reviewTxt = el("span", {}, s.reviewCode || "······");
      if (!s.reviewCode) cloudEnsureReviewCode(s).then(c => { reviewTxt.textContent = c || "——————"; });
      const meta = el("div", { class: "t-meta" }, [
        statusPill(s.status),
        el("span", {}, dateRange(s)),
        el("span", {}, `참여 ${parts.length}명`),
        el("span", {}, `슬라이드 ${slides.length}장`),
        wsPages(s).length ? el("span", {}, `학습지 ${wsPages(s).length}쪽`) : null,
        el("button", { class: "btn btn-sm t-review-btn no-print", type: "button", title: "복습 코드 · QR", onClick: () => openReviewModal(id, teacher) },
          [icon("qr", 16), "복습 ", reviewTxt]),
        reviewCopyBtn(id, teacher, { cls: "btn btn-sm t-review-copy no-print", label: "복습 링크 복사" }),
      ]);
      const segBtn = (m, label) => el("button", {
        type: "button", class: mode === m ? "active" : null, "aria-pressed": String(mode === m),
        onClick: (e) => {
          if (mode === m) return;
          mode = m;
          e.currentTarget.parentNode.querySelectorAll("button").forEach(b => {
            const on = b === e.currentTarget;
            b.classList.toggle("active", on);
            b.setAttribute("aria-pressed", String(on));
          });
          renderContent();
        },
      }, label);
      const seg = el("div", { class: "seg", role: "group" }, [segBtn("slides", "슬라이드별"), segBtn("students", "학생별")]);
      box.replaceChildren(head, meta, el("div", { class: "t-detail-bar" }, seg), content);
      renderContent();
    }

    function renderContent() {
      clearFrames();
      const s = findSession(id);
      if (!s) return;
      const slides = s.slidesSnapshot || [];
      if (!slides.length) { content.replaceChildren(el("div", { class: "empty empty-box" }, "슬라이드가 없어요")); return; }
      // 학습지 쪽은 슬라이드 뒤에 이어서(개별 필기 갤러리 / 그 학생 필기)
      const ws = wsPages(s).map((p, i) => ({ ...p, title: wsPageTitle(p, i), mode: "individual" }));
      // 팝업 상호작용(v2.9)은 그 슬라이드 바로 뒤에 '팝업' 표지로
      const popsOf = (sl) => hotspotsOf(sl).map(h => popSlideFor(h, sl));
      if (mode === "slides") {
        content.replaceChildren(
          ...slides.flatMap((sl, i) => [
            slideSection(sl, i, summaryEl(s, sl, (s.responses || {})[sl.id] || [], recordCtx(s, teacher, sl, timers))),
            ...popsOf(sl).map(ps => slideSection(ps, i, summaryEl(s, ps, (s.responses || {})[ps.id] || [], recordCtx(s, teacher, ps, timers)), "팝업")),
          ]),
          ...ws.map((p, i) => slideSection(p, slides.length + i, summaryEl(s, p, [], recordCtx(s, teacher, p, timers)), "학습지")),
        );
        return;
      }
      // 학생별
      const parts = participantsOf(s);
      if (!parts.length) { content.replaceChildren(el("div", { class: "empty empty-box" }, "아직 아무도 없어요")); return; }
      if (!picked || !parts.some(p => p.id === picked)) picked = parts[0].id;
      const chips = el("div", { class: "chips no-print" }, parts.map(p => el("button", {
        class: "chip" + (p.id === picked ? " active" : ""), type: "button",
        onClick: () => { if (picked !== p.id) { picked = p.id; renderContent(); } },
      }, p.st ? studentLabel(p.st) : "학생")));
      const st = findStudent(picked);
      // 가정: 학생별 보기는 학생 '내 기록'과 같은 계약(isTeacher:false, me=그 학생, 그 학생 응답만) → race 등은 개인 결과만 표시
      const mineOf = (sl) => {
        const rs = ((s.responses || {})[sl.id] || []).filter(r => r.studentId === picked);
        return summaryEl(s, sl, rs, recordCtx(s, teacher, sl, timers, {
          isTeacher: false, me: st || { id: picked }, studentId: picked,
          responses: () => rs,
          myResponse: (itemKey = "") => rs.find(r => (r.itemKey || "") === (itemKey || "")) || null,
          myGroup: () => (s.groups || []).find(g => (g.memberIds || []).includes(picked)) || null,
        }));
      };
      const sections = slides.flatMap((sl, i) => [
        slideSection(sl, i, sl.type === "ink" ? inkFor(s, sl, picked) : mineOf(sl)),
        ...popsOf(sl).map(ps => slideSection(ps, i, mineOf(ps), "팝업")),
      ]);
      const wsSections = ws.map((p, i) => slideSection(p, slides.length + i, inkFor(s, p, picked), "학습지"));
      content.replaceChildren(chips, el("h2", { class: "t-print-only" }, st ? studentLabel(st) : "학생"), ...sections, ...wsSections);
    }

    // 학생 한 명의 필기(읽기 전용)
    function inkFor(s, slide, studentId) {
      const R = s.records || {};
      const has = (rec) => !!rec && (((rec.strokes || []).length) || ((rec.texts || []).length));
      const g = (s.groups || []).find(x => (x.memberIds || []).includes(studentId));
      const ind = { scope: "individual", scopeId: studentId, rec: (R[studentId] || {})[slide.id] };
      const grp = g ? { scope: "group", scopeId: g.id, rec: ((R.__groups || {})[g.id] || {})[slide.id] } : null;
      const whole = { scope: "whole", scopeId: s.id, rec: (R.__whole || {})[slide.id] };
      const m = effectiveMode(slide, s);
      const order = (m === "individual" ? [ind, grp, whole] : m === "group" ? [grp, ind, whole] : [whole, ind, grp]).filter(Boolean);
      const pick = order.find(c => has(c.rec)) || order[0];
      const frame = el("div", { class: "t-mini" });
      try {
        const v = renderSlide({ root: frame, slide, session: s, scope: pick.scope, scopeId: pick.scopeId, readOnly: true });
        if (v) frames.push(v);
      } catch (e) {
        console.warn("[detail] 필기 표시 실패", e);
        frame.replaceChildren(el("div", { class: "muted" }, "이 슬라이드를 불러오지 못했어요"));
      }
      return frame;
    }

    (async () => {
      let s = null;
      try { s = await cloudFetchSession(id); } catch (e) { console.warn("[detail] fetch", e); }
      if (disposed) return;
      if (!s) {
        box.replaceChildren(
          el("div", { class: "page-head" }, [backBtn(), el("h1", {}, "수업 기록")]),
          el("div", { class: "empty empty-box" }, "기록을 찾지 못했어요"),
        );
        return;
      }
      render();
    })();

    return () => {
      disposed = true;
      offStore();
      closePop();
      clearFrames();
    };
  });
}
