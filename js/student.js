// 학생 화면: 대기 · 수업 · 내 기록 (docs/ARCHITECTURE.md §8, §9.2)
// 가정: 'session:hello'는 realtime.js가 채널 구독 완료(재연결 포함)마다 자동 송신한다 → 여기서 따로 보내지 않는다.
// 가정: 모둠이 바뀌면 cloud.subscribeSession이 스스로 재구독한다(학생 role) → 여기서는 처음 groupId만 넘긴다.
// 가정: host.update()가 슬라이드 키가 바뀌면 내부에서 destroy 후 재마운트하지만, 명세대로 슬라이드 id가 바뀌면 host를 새로 만든다.
// 가정: '나가기'로 나온 세션은 sessionStorage 'hada:left'에 기억 → 대기 화면이 그 세션으로 바로 다시 끌고 가지 않고
//       '수업 들어가기' 버튼만 보여 준다(교사가 새 수업을 시작하면 자동 입장).
// 가정: 내 기록의 필기는 그 슬라이드의 최종 모드 scope를 먼저 보고, 비어 있으면 개별 → 모둠 → 전체 순으로 필기가 있는 것을 보여 준다.
// 가정: 화면 뷰는 동기 cleanup을 반환하고 비동기 작업은 dead 플래그로 중단한다(라우터가 바로 정리할 수 있게).
// 가정: 수업 화면은 host를 한 번 만들고 이후엔 host.update만 부른다(슬라이드가 바뀌면 host가 내부에서 재마운트).
// 가정: store의 세션이 이미 _full이면 바로 그리고, 구독 직후 서버에서 1회 다시 조회한다(낡은 캐시·구독 전 놓친 변경 보정).
// 가정: 세션 조회가 실패(null)하면 대기 화면으로 튕기지 않고 '다시 시도'를 보여 준다(대기↔수업 왕복 루프 방지). 3초 간격 자동 재시도 5회.
// 가정: 참여 등록(cloudAddParticipant)은 수업 화면 진입 시 1회(대기 화면·로그인 화면은 바로 이동만).
// 가정: 끝난 수업 재입장 방지 — 교사의 종료 브로드캐스트(rev↑)가 DB 저장보다 먼저 오거나 저장이 실패하면 DB는 아직 live.
//       수업 화면이 '끝남'을 본 세션은 sessionStorage 'hada:ended'에 {id, rev}로 기억하고, 대기 화면은
//       store가 그 세션을 live 아님 + 더 높은 rev로 들고 있거나 기억된 rev 이하인 live 알림을 무시한다(대기↔수업 왕복 루프 방지).
//       watchTeacherLive는 같은 id를 한 번만 알리므로, 무시한 뒤에는 15초 뒤 감시를 다시 시작해(재개된 수업은 rev가 올라감) 다시 확인한다.
// 가정: 학습지(js/worksheet.js) — 수업에 학습지가 있으면 오른쪽 가장자리 📝 탭. 누르면 슬라이드 스테이지를 숨기고(호스트는 유지) 학습지 스테이지를
//       보인다(내 개별 칸에 필기, 쪽은 ◀ ▶·←/→). 선생님이 띄우면(activity.__ws.force) 자동으로 열리고 닫을 수 없다(쪽 이동은 자유).
//       띄우기를 풀어도 열린 채 두고, 탭을 다시 눌러 닫는다. 마지막 쪽은 sessionStorage 'hada:ws:<세션>'.
// 가정(v2.9): 팝업 상호작용(js/popup.js) — 선생님이 핀을 누르면(activity.__pop) 화면 위에 팝업이 뜨고 선생님이 닫을 때까지 유지.
//       자유 이동·복습에서는 슬라이드의 핀을 눌러 스스로 열고 닫는다(내 화면에서만).
// 가정(공용 태블릿): 대기·수업·복습·내 기록 화면에 늘 '이름 | 로그아웃' 버튼(meChip)을 둔다. 로그아웃 = 기억된 학생을 지우고
//       입장 화면으로(코드는 이 탭에 남겨 다음 학생은 학년·반·번호·이름만). 수업 중에는 한 번 확인한다(필기·답은 이미 저장됨).
// 가정: 수업이 끝나면 대기 화면이 아니라 입장 화면(입력 폼 + '혹시 이 학생인가요?' 카드)으로 간다 — 대기 화면은 다음 수업에 자동으로 들어가므로,
//       다음 시간에 다른 반이 같은 태블릿을 쓰면 앞 학생 이름으로 들어가 버린다. 같은 학생은 카드 한 번이면 된다.
import { el, mount, icon, fmtDate, toast, confirmDialog } from "./ui.js";
import { store, findSession, findStudent, studentLabel, normCode } from "./store.js";
import { go } from "./router.js";
import {
  cloudEnabled, cloudFindTeacherByCode, cloudFetchLiveSession, cloudAddParticipant, ensureSession, cloudFetchSession,
  subscribeSession, watchTeacherLive, cloudListSessionsForStudent,
} from "./cloud.js";
import { joinSessionChannel } from "./realtime.js";
import { mountSlideHost } from "./slides/host.js";
import { getSlideType, effectiveMode, injectCss } from "./slides/registry.js";
import { renderSlide } from "./lesson-view.js";
import { wsPages, wsForced, wsPageTitle, makeWsSessionView, wsTab, wsPrefetch } from "./worksheet.js";
import { createPopupView, popOf, findPopSlide, hotspotsOf, popSlideFor } from "./popup.js";

const CSS = `
.stu-page { min-height:100vh; min-height:100dvh; max-width:760px; margin:0 auto; display:grid; gap:16px; align-content:start;
  padding: calc(16px + var(--sat)) max(16px, var(--sar)) calc(32px + var(--sab)) max(16px, var(--sal)); }
.stu-page > .btn-ghost { justify-self:start; }
.stu-wait { width:100%; max-width:400px; gap:14px; padding:32px 24px; }
.stu-wait .pill-code { font-size:14px; height:30px; padding:0 14px; }
.stu-wait .teacher { max-width:100%; }
.stu-wait-line { display:flex; align-items:center; justify-content:center; gap:10px; color:var(--ink-2); font-size:15px; }
.stu-wait .btn { width:100%; }
.stu-rec-head h2 { font-size:20px; font-weight:700; overflow-wrap:anywhere; }
.stu-rec-head .btn { justify-self:start; }
.stu-rec-slide { display:grid; gap:10px; }
.stu-rec-slide .slide-frame { width:100%; }
.stu-rec-no { font-size:13px; color:var(--muted); font-weight:600; }
.stu-top .pill { flex:none; }
.stu-top .slide-count { min-width:56px; }
@media (max-width: 420px) { .stu-top .brand { display:none; } .stu-review .pill-review { display:none; } }
.stu-review .stu-top > .btn-sm { flex:none; }
.stu-me { flex:none; display:inline-flex; align-items:stretch; height:44px; max-width:100%; padding:0; border:1px solid var(--line-strong);
  border-radius:999px; background:var(--surface); color:var(--ink); font:inherit; cursor:pointer; overflow:hidden; }
.stu-me-who { display:inline-flex; align-items:center; gap:6px; min-width:0; padding:0 10px 0 12px; font-size:14px; font-weight:650; }
.stu-me-who .icon { color:var(--muted); }
.stu-me-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:10em; }
.stu-me-out { display:inline-flex; align-items:center; gap:5px; flex:none; padding:0 14px 0 10px; border-left:1px solid var(--line);
  color:var(--danger); font-size:14px; font-weight:650; }
@media (hover: hover) { .stu-me:hover .stu-me-out { background:var(--danger-soft); } }
.stu-me:active .stu-me-out { background:var(--danger-soft); }
.stu-wait .stu-me { width:100%; justify-content:space-between; }
.stu-page-top { display:flex; align-items:center; justify-content:space-between; gap:8px; }
@media (max-width: 720px) { .stu-top .stu-me-lbl, .stu-top .stu-me-who .icon { display:none; } .stu-top .stu-me-out { padding:0 12px; } }
@media (max-width: 420px) { .stu-top .stu-me-who { display:none; } .stu-top .stu-me-out { border-left:0; } }
@media (max-width: 360px) { .stu-review .ans-label { display:none; } .stu-review .stu-top > .btn-sm { padding:0 8px; } }
@media (max-width: 520px) { .stu-review .stu-live-btn { font-size:13px; padding:0 10px; } }
@media (max-width: 420px) {
  .stu-review .stu-live-btn { font-size:12px; padding:0 8px; letter-spacing:-.02em; }
  .stu-review .slide-nav .btn-icon { --btn-h:38px; }
  .stu-review .slide-count { min-width:44px; font-size:14px; }
  .stu-review .stu-top > .btn-ghost { padding:0 8px; }
}
/* 복습 미리보기 띠(v2.12): 머리 줄 바로 아래. 띠를 접으면(display:none) 줄 번호가 밀리지 않게 칸을 정해 둔다 */
.stu-review { grid-template-rows:auto auto minmax(0, 1fr); }
.stu-review > .stu-top { grid-row:1; }
.stu-review > .rv-strip { grid-row:2; }
.stu-review > .stu-stage { grid-row:3; }
.rv-strip { position:relative; z-index:19; display:flex; align-items:center; gap:8px; min-width:0; overflow-x:auto; overflow-y:hidden;
  padding:8px max(12px, var(--sar)) 8px max(12px, var(--sal)); background:var(--surface); border-bottom:1px solid var(--line);
  overscroll-behavior-x:contain; touch-action:pan-x; scrollbar-width:thin; }
.rv-strip[hidden] { display:none; }
.rv-strip .rv-item { width:104px; touch-action:pan-x; }
.rv-thumb { position:absolute; inset:0; overflow:hidden; background:#fff; pointer-events:none; }
.rv-thumb > * { width:100%; height:100%; }
.rv-sep { flex:none; align-self:stretch; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px;
  margin-left:2px; padding:0 2px 0 10px; border-left:1px solid var(--line); color:var(--ink-2); font-size:11px; font-weight:700; white-space:nowrap; }
.rv-sep span:first-child { font-size:18px; line-height:1; }
.rv-count { gap:2px; cursor:pointer; }
.rv-count .icon { color:var(--muted); transition:transform .15s ease; }
.rv-count[aria-expanded="true"] .icon { transform:rotate(180deg); }
@media (max-width:520px), (max-height:560px) { .rv-strip { gap:6px; padding-top:6px; padding-bottom:6px; } .rv-strip .rv-item { width:88px; } }
@media (max-width:420px) { .rv-count .icon { display:none; } }
`;

const MODE_LABEL = { none: "발표", whole: "전체", individual: "개별", group: "모둠" };
const LEFT_KEY = "hada:left";
const ENDED_KEY = "hada:ended";
const ENDED_TTL = 3 * 60 * 60 * 1000; // 끝난 수업 기억 시간(새로고침 대비)
const RECHECK_MS = 15000;
const WS_POS = "hada:ws:"; // + sessionId → 마지막으로 본 학습지 쪽

function css() { injectCss("student-view", CSS); }
function ssGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function ssSet(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 끝난 수업 기억/조회 — DB가 아직 live여도(종료 저장 지연·실패) 다시 끌려 들어가지 않게
function rememberEnded(id, rev) {
  if (!id) return;
  ssSet(ENDED_KEY, JSON.stringify({ id, rev: Number(rev || 0), at: Date.now() }));
}
function isKnownEnded(meta) {
  if (!meta || !meta.id) return false;
  const rev = Number(meta.rev || 0);
  const s = findSession(meta.id);
  if (s && s.status !== "live" && Number(s.rev || 0) > rev) return true;
  let e = null;
  try { e = JSON.parse(ssGet(ENDED_KEY) || "null"); } catch { e = null; }
  if (!e || e.id !== meta.id) return false;
  if (!(Date.now() - (e.at || 0) < ENDED_TTL)) { ssSet(ENDED_KEY, null); return false; }
  return rev <= Number(e.rev || 0);
}
// 라우트 핸들러 안에서 동기 go(replace)를 부르면 라우터의 cleanup 기록이 꼬이므로 다음 틱에 이동
function redirect(path) { setTimeout(() => go(path, { replace: true }), 0); }

function brand() {
  return el("div", { class: "brand small", "aria-label": "(수업)하다" }, [
    el("span", { class: "paren" }, "("), el("span", { class: "brush" }, "수업"),
    el("span", { class: "paren" }, ")"), el("span", { class: "brush" }, "하다"),
  ]);
}

// 현재 학생: 기억된 프로필(우선) 또는 whoStudent
export function currentStudent() {
  const st = store.state;
  const p = st.studentProfile && st.studentProfile.id ? st.studentProfile : null;
  const w = st.whoStudent;
  const who = w && typeof w === "object" ? w.id : w;
  if (p && (!who || p.id === who)) return p;
  if (who) {
    const s = findStudent(who);
    if (s) return { ...s, lastCode: p && p.id === s.id ? p.lastCode : null };
  }
  return p;
}

// 로그아웃: 기억된 학생을 지우고 입장 화면으로. 코드는 이 탭에 남겨(hada:joinCode) 다음 학생은 학년·반·번호·이름만 입력
export function logoutStudent() {
  const code = normCode(currentStudent()?.lastCode || "");
  store.set(s => { s.studentProfile = null; s.whoStudent = null; });
  store.flush();
  ssSet(LEFT_KEY, null);
  try { Object.keys(sessionStorage).filter(k => k.startsWith(WS_POS)).forEach(k => sessionStorage.removeItem(k)); } catch {}
  ssSet("hada:joinCode", code || null);
  go("/student-login", { replace: true });
}

// 이름표 + 로그아웃 한 버튼 — 다른 학생 이름이 보이면 바로 눌러 바꾼다. confirm: 수업 중이면 한 번 확인
function meChip(me, { full = false, confirm = false } = {}) {
  const btn = el("button", { class: "stu-me", type: "button", title: "로그아웃", "aria-label": `${studentLabel(me)} 로그아웃` }, [
    el("span", { class: "stu-me-who" }, [icon("user", 18), el("span", { class: "stu-me-name" }, full ? studentLabel(me) : me.name)]),
    el("span", { class: "stu-me-out" }, [icon("logout", 18), el("span", { class: "stu-me-lbl" }, "로그아웃")]),
  ]);
  btn.onclick = async () => {
    if (confirm) {
      const ok = await confirmDialog({
        title: `${me.name} 학생, 로그아웃할까요?`,
        body: "지금까지 쓴 필기와 답은 저장돼 있어요. 로그아웃하면 다른 학생이 이 기기로 들어올 수 있어요.",
        ok: "로그아웃",
      });
      if (!ok || !btn.isConnected) return;
    }
    logoutStudent();
  };
  return btn;
}

function myGroupOf(session, studentId) {
  return (session?.groups || []).find(g => (g.memberIds || []).includes(studentId)) || null;
}

// ── 대기 (/student) ──
export function studentWaitView() {
  const me = currentStudent();
  if (!me) { redirect("/student-login"); return; }
  const code = normCode(me.lastCode);
  if (!code) { redirect("/student-login?form=1"); return; }
  css();

  let dead = false, stopWatch = null, retryT = null, recheckT = null, joining = false, teacherId = null;

  const teacherEl = el("div", { class: "teacher ellipsis" }, "");
  const lineText = el("span", {}, "선생님이 수업을 시작하면 자동으로 들어가요");
  const pulse = el("span", { class: "wait-pulse", "aria-hidden": "true" });
  const line = el("div", { class: "stu-wait-line" }, [pulse, lineText]);
  const rejoinBtn = el("button", { class: "btn btn-primary btn-lg", type: "button", hidden: true }, "수업 들어가기");
  const card = el("div", { class: "card wait-card stack stu-wait" }, [
    meChip(me, { full: true }),
    teacherEl,
    el("span", { class: "pill pill-code" }, code),
    line,
    rejoinBtn,
    el("button", { class: "btn btn-lg", type: "button", onClick: () => go("/student-login?form=1") }, "코드 바꾸기"),
    el("button", { class: "btn-link", type: "button", onClick: () => go("/student/records") }, "내 기록"),
  ]);
  mount(el("main", { class: "center-page" }, [card]));

  function enter(sessionId) {
    if (dead || joining) return;
    joining = true;
    ssSet(LEFT_KEY, null);
    // 참여 등록은 수업 화면이 진입 시 처리
    go("/student/live/" + sessionId);
  }

  function stopWatching() {
    try { stopWatch && stopWatch(); } catch (e) { console.warn(e); }
    stopWatch = null;
  }

  // 무시한 세션이 나중에 진짜로 재개될 수 있으므로 감시를 새로 시작해 다시 확인(같은 id는 한 감시에서 한 번만 알림)
  function scheduleRecheck() {
    if (dead || recheckT || !teacherId) return;
    recheckT = setTimeout(() => {
      recheckT = null;
      if (dead || joining) return;
      stopWatching();
      stopWatch = watchTeacherLive(teacherId, onLive);
    }, RECHECK_MS);
  }

  function onLive(meta) {
    const sessionId = meta && meta.id;
    if (dead || joining || !sessionId) return;
    if (isKnownEnded(meta)) { scheduleRecheck(); return; }
    if (ssGet(LEFT_KEY) === sessionId) {
      // 직접 나온 수업: 자동으로 다시 끌고 가지 않는다
      rejoinBtn.hidden = false;
      rejoinBtn.onclick = () => enter(sessionId);
      return;
    }
    enter(sessionId);
  }

  function startWatch(tid) {
    if (dead) return;
    teacherId = tid;
    stopWatch = watchTeacherLive(tid, onLive);
    cloudFetchLiveSession(tid, { forStudentId: me.id })
      .then(s => { if (s && s.status === "live") onLive(s); })
      .catch(e => console.warn("[student] 진행 중 수업 조회 실패", e));
  }

  async function lookup() {
    let t = null;
    try { t = await cloudFindTeacherByCode(code); }
    catch (e) {
      console.warn("[student] 선생님 조회 실패", e);
      if (!dead) retryT = setTimeout(lookup, 3000);
      return;
    }
    if (dead) return;
    if (!t) {
      pulse.hidden = true;
      lineText.textContent = "코드를 확인해 주세요";
      return;
    }
    teacherEl.textContent = t.name || "";
    startWatch(t.id);
  }
  lookup();

  return () => {
    dead = true;
    clearTimeout(retryT);
    clearTimeout(recheckT);
    stopWatching();
  };
}

// ── 수업 (/student/live/:id) ──
export function studentLiveView({ id } = {}) {
  const me = currentStudent();
  if (!me) { redirect("/student-login"); return; }
  if (!id) { redirect("/student"); return; }
  css();

  let dead = false, host = null, ch = null, unsub = null, offStore = null;
  let endTimer = null, ended = false, retried = false, started = false;
  let mounting = false, dirty = false, loadTimer = null, loadTries = 0;
  let localIdx = null, lastFlow = null, lastSnap = null;
  const shown = {}; // 상단 바 텍스트 캐시(바뀔 때만 DOM 갱신)

  const titleEl = el("div", { class: "topbar-title" }, "");
  const modePill = el("span", { class: "pill pill-accent", hidden: true });
  const prevBtn = el("button", { class: "btn btn-icon btn-ghost", type: "button", "aria-label": "이전", hidden: true, onClick: () => step(-1) }, icon("chevron-left"));
  const nextBtn = el("button", { class: "btn btn-icon btn-ghost", type: "button", "aria-label": "다음", hidden: true, onClick: () => step(1) }, icon("chevron-right"));
  const countEl = el("span", { class: "slide-count" }, "");
  const exitBtn = el("button", { class: "btn btn-ghost", type: "button", onClick: exit }, "나가기");
  const top = el("header", { class: "stu-top" }, [
    brand(), titleEl, modePill,
    el("div", { class: "slide-nav" }, [prevBtn, countEl, nextBtn]),
    exitBtn, meChip(me, { confirm: true }),
  ]);
  const stage = el("div", { class: "stu-stage" }, [el("div", { class: "center" }, el("span", { class: "spinner", "aria-label": "불러오는 중" }))]);
  // 학습지: 오른쪽 📝 탭으로 열고 닫음(선생님이 띄운 동안은 닫기 불가), 쪽은 자유롭게
  const wsView = makeWsSessionView();
  let wsOpen = false, wsIdx = parseInt(ssGet(WS_POS + id) || "0", 10) || 0, wsHost = null, wsHostPage = null, lastForced = false;
  const wsPrev = el("button", { class: "btn btn-icon btn-ghost", type: "button", "aria-label": "이전 쪽", onClick: () => wsGo(-1) }, icon("chevron-left"));
  const wsNext = el("button", { class: "btn btn-icon btn-ghost", type: "button", "aria-label": "다음 쪽", onClick: () => wsGo(1) }, icon("chevron-right"));
  const wsCount = el("span", { class: "slide-count" }, "");
  const wsBody = el("div", { class: "ws-body" });
  const wsStage = el("div", { class: "stu-stage ws-stage", hidden: true, "aria-label": "학습지" }, [el("div", { class: "ws-view" }, [
    el("div", { class: "ws-head" }, [
      el("span", { class: "ws-title" }, [el("span", { "aria-hidden": "true" }, "📝"), "학습지"]),
      el("span", { class: "spacer" }),
      el("div", { class: "slide-nav" }, [wsPrev, wsCount, wsNext]),
    ]),
    wsBody,
  ])]);
  const wsTabEl = wsTab({ onClick: toggleWs });
  const root = el("div", { class: "stu" }, [top, stage, wsStage, wsTabEl]);
  mount(root);
  // 팝업 상호작용: 선생님이 띄운 것(닫기 없음) > 내가 연 것(자유 이동일 때만)
  let localPop = null;
  const popView = createPopupView({ container: root, role: "student", me, onClose: () => { localPop = null; render(); } });
  const openLocalPop = (pid) => { localPop = pid; render(); };
  function syncPopup(s) {
    const p = popOf(s);
    const tps = p ? findPopSlide(s, p.id) : null;
    if (tps) { localPop = null; popView.show(s, tps, { closable: false, note: "선생님이 띄웠어요" }); return; }
    const lps = localPop && s.flow === "student" ? findPopSlide(s, localPop) : null;
    if (lps) popView.show(s, lps, { closable: true });
    else { localPop = null; popView.close(); }
  }

  function setText(node, key, text) {
    if (shown[key] === text) return;
    shown[key] = text;
    node.textContent = text;
  }

  function destroyHost() {
    if (host) { try { host.destroy(); } catch (e) { console.warn("[student] host.destroy", e); } }
    host = null;
  }

  // ── 학습지 ──
  function destroyWsHost() {
    if (wsHost) { try { wsHost.destroy(); } catch (e) { console.warn("[student] 학습지 host.destroy", e); } }
    wsHost = null; wsHostPage = null;
    wsBody.replaceChildren();
  }
  function toggleWs() {
    const s = findSession(id);
    if (!s || !wsPages(s).length) return;
    if (wsForced(s)) { toast("선생님이 학습지를 띄운 동안에는 닫을 수 없어요"); return; }
    wsOpen = !wsOpen;
    render();
  }
  function wsGo(d) {
    const s = findSession(id);
    const n = wsPages(s).length;
    if (!n) return;
    const next = clamp(wsIdx + d, 0, n - 1);
    if (next === wsIdx) return;
    wsIdx = next;
    ssSet(WS_POS + id, String(wsIdx));
    render();
  }
  // 학습지 스테이지 동기화. 열려 있으면 슬라이드 스테이지는 숨김(호스트는 그대로 두어 상태 유지)
  function syncWs(s) {
    const pages = wsPages(s);
    const forced = wsForced(s);
    if (!pages.length) {
      wsTabEl.set({ hidden: true });
      if (!wsStage.hidden) { wsStage.hidden = true; stage.hidden = false; }
      destroyWsHost();
      lastForced = false;
      return;
    }
    if (forced && !lastForced) { if (!wsOpen) toast("선생님이 학습지를 띄웠어요"); wsOpen = true; }
    lastForced = forced;
    const open = wsOpen;
    wsTabEl.set({ hidden: false, open, forced, label: open && !forced ? "슬라이드" : "학습지" });
    if (stage.hidden !== open) stage.hidden = open;
    if (wsStage.hidden !== !open) wsStage.hidden = !open;
    if (!open) { destroyWsHost(); return; }
    wsIdx = clamp(wsIdx, 0, pages.length - 1);
    setText(wsCount, "ws", `${wsIdx + 1} / ${pages.length}`);
    wsPrev.disabled = wsIdx <= 0;
    wsNext.disabled = wsIdx >= pages.length - 1;
    const page = pages[wsIdx];
    if (wsHost && wsHostPage === page.id) { wsHost.update({ slide: page, session: s }); return; }
    destroyWsHost();
    wsHostPage = page.id;
    mounting = true;
    try { wsHost = mountSlideHost({ role: "student", root: wsBody, slide: page, session: s, me, sessionView: wsView }); }
    catch (e) { console.error("[student] 학습지 표시 실패", e); wsHost = null; }
    finally { mounting = false; }
    if (!wsHost) wsBody.replaceChildren(el("div", { class: "empty" }, "학습지를 불러오지 못했어요"));
    else wsPrefetch(pages, wsIdx);
  }

  function showMsg(text) {
    destroyHost();
    if (shown.msg === text && stage.firstElementChild?.classList.contains("empty")) return;
    shown.msg = text;
    stage.replaceChildren(el("div", { class: "empty" }, text));
  }

  function updateBar(s, slide, idx, n) {
    const title = s.title || "";
    if (shown.title !== title) { titleEl.title = title; }
    setText(titleEl, "title", title);
    // 모드 pill: 필기 슬라이드만
    let mode = "";
    if (slide && slide.type === "ink") {
      const m = effectiveMode(slide, s);
      mode = MODE_LABEL[m] || "";
      if (m === "group") { const g = myGroupOf(s, me.id); if (g && g.name) mode += " · " + g.name; }
    }
    modePill.hidden = !mode;
    setText(modePill, "mode", mode);
    setText(countEl, "count", n ? `${idx + 1} / ${n}` : "");
    const free = s.flow === "student" && n > 1;
    prevBtn.hidden = !free; nextBtn.hidden = !free;
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx >= n - 1;
  }

  function showEnded() {
    if (ended) return;
    ended = true;
    popView.close();
    rememberEnded(id, findSession(id)?.rev);
    root.appendChild(el("div", { class: "stage-overlay" }, "수업이 끝났어요"));
    // 대기 화면(다음 수업 자동 입장)이 아니라 입장 화면 — 다음 시간 다른 반이 이 태블릿을 쓸 수 있음
    endTimer = setTimeout(() => { if (!dead) go("/student-login", { replace: true }); }, 2000);
  }

  function render() {
    if (dead || !started || ended) return;
    // 플러그인 마운트 중 store 변경 → 마운트가 끝난 뒤 한 번 더
    if (mounting) { dirty = true; return; }
    const s = findSession(id);
    if (!s) return;
    if (s.status !== "live") { showEnded(); return; }
    syncPopup(s);
    const slides = Array.isArray(s.slidesSnapshot) ? s.slidesSnapshot : [];
    const n = slides.length;
    if (!n) {
      updateBar(s, null, 0, 0);
      syncWs(s);
      showMsg("수업 자료를 불러오는 중이에요");
      if (!retried) {
        retried = true;
        cloudFetchSession(id, { forStudentId: me.id }).catch(e => console.warn("[student] 세션 다시 조회 실패", e));
      }
      return;
    }
    // 자유 이동으로 바뀌는 순간 로컬 인덱스 = 교사 현재 슬라이드
    if (s.flow === "student" && (lastFlow !== "student" || localIdx == null)) localIdx = s.currentSlide || 0;
    // 수업 중 슬라이드가 추가되면(스냅샷 교체) 자유 이동이어도 새 슬라이드로, 새 것이 없으면 보던 슬라이드 유지
    // (패치와 스냅샷의 도착 순서와 무관하게 id로 찾는다)
    if (lastSnap && slides !== lastSnap && s.flow === "student") {
      const old = new Set(lastSnap.map(x => x && x.id));
      const added = slides.findIndex(x => x && !old.has(x.id));
      const seen = slides.findIndex(x => x && x.id === lastSnap[localIdx ?? 0]?.id);
      if (added >= 0) localIdx = added;
      else if (seen >= 0) localIdx = seen;
    }
    lastSnap = slides;
    lastFlow = s.flow;
    const idx = clamp(s.flow === "student" ? localIdx : (s.currentSlide || 0), 0, n - 1);
    if (s.flow === "student") localIdx = idx;
    const slide = slides[idx];
    updateBar(s, slide, idx, n);
    syncWs(s);
    if (!slide) { showMsg("수업 자료를 불러오는 중이에요"); return; }
    // host는 유지: 같은 슬라이드면 훅만, 다른 슬라이드면 host가 내부에서 재마운트
    if (host) { host.update({ slide, session: s }); return; }
    shown.msg = null;
    stage.replaceChildren();
    mounting = true; dirty = false;
    try { host = mountSlideHost({ role: "student", root: stage, slide, session: s, me, onPopup: openLocalPop }); }
    catch (e) { console.error("[student] 슬라이드 표시 실패", e); host = null; }
    finally { mounting = false; }
    if (dead) { destroyHost(); return; }
    if (!host) { showMsg("이 슬라이드를 불러오지 못했어요"); return; }
    if (dirty) { dirty = false; render(); }
  }

  function showLoadFail() {
    destroyHost();
    shown.msg = null;
    const retry = el("button", { class: "btn", type: "button", onClick: () => { loadTries = 0; showSpinner(); load(); } }, "다시 시도");
    stage.replaceChildren(el("div", { class: "center stack" }, [el("div", { class: "empty" }, "수업을 불러오지 못했어요"), retry]));
  }
  function showSpinner() {
    destroyHost();
    shown.msg = null;
    stage.replaceChildren(el("div", { class: "center" }, el("span", { class: "spinner", "aria-label": "불러오는 중" })));
  }

  function step(d) {
    const s = findSession(id);
    if (!s || s.flow !== "student") return;
    const n = (s.slidesSnapshot || []).length;
    if (!n) return;
    localIdx = clamp((localIdx ?? s.currentSlide ?? 0) + d, 0, n - 1);
    localPop = null; // 내가 연 팝업은 슬라이드를 넘기면 닫힘
    render();
  }

  function onKey(e) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.defaultPrevented || e.isComposing || e.altKey || e.metaKey || e.ctrlKey) return;
    if (document.documentElement.classList.contains("has-layer")) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    // 학습지가 열려 있으면 ←/→는 학습지 쪽
    if (!wsStage.hidden) { e.preventDefault(); wsGo(e.key === "ArrowLeft" ? -1 : 1); return; }
    const s = findSession(id);
    if (!s || s.flow !== "student") return;
    e.preventDefault();
    step(e.key === "ArrowLeft" ? -1 : 1);
  }

  function exit() {
    ssSet(LEFT_KEY, id);
    if (ch) { try { ch.leave(); } catch (e) { console.warn(e); } ch = null; }
    go("/student");
  }

  async function load() {
    clearTimeout(loadTimer);
    if (dead || started) return;
    const cached = findSession(id);
    const fromCache = !!(cached && cached._full);
    let s = null;
    try { s = await ensureSession(id, { forStudentId: me.id }); }
    catch (e) { console.warn("[student] 세션 조회 실패", e); }
    if (dead || started) return;
    // store 의 객체가 낡았을 수 있음(재개된 수업 등) → live가 아니면 서버에서 한 번 더 확인
    if (s && s.status !== "live") {
      try { s = await cloudFetchSession(id, { forStudentId: me.id }); } catch (e) { console.warn("[student] 세션 다시 조회 실패", e); }
      if (dead || started) return;
    }
    if (!s) {
      // 조회 실패: 대기 화면으로 보내면 대기↔수업이 반복될 수 있어 여기서 재시도
      showLoadFail();
      if (++loadTries < 5) loadTimer = setTimeout(load, 3000);
      return;
    }
    if (s.status !== "live") { rememberEnded(id, s.rev); go("/student", { replace: true }); return; }
    if (ssGet(LEFT_KEY) === id) ssSet(LEFT_KEY, null);
    // 재접속(새로고침·QR) 대비 — 이미 있으면 서버가 무시
    cloudAddParticipant(id, me.id).then(r => { if (r && r.error) console.warn("[student] 참여 등록 실패", r.error); },
      e => console.warn("[student] 참여 등록 실패", e));
    ch = joinSessionChannel(id, { id: me.id, name: studentLabel(me), role: "student" });
    const g = myGroupOf(s, me.id);
    unsub = subscribeSession(id, { role: "student", studentId: me.id, groupId: g ? g.id : null });
    offStore = store.subscribe(render);
    document.addEventListener("keydown", onKey);
    started = true;
    render();
    // 캐시로 그렸으면 서버 상태로 1회 보정(끝난 수업·구독 전 놓친 변경) — 결과는 store 구독으로 반영
    if (fromCache && cloudEnabled()) {
      cloudFetchSession(id, { forStudentId: me.id }).catch(e => console.warn("[student] 세션 보정 조회 실패", e));
    }
  }
  load();

  return () => {
    dead = true;
    clearTimeout(endTimer);
    clearTimeout(loadTimer);
    document.removeEventListener("keydown", onKey);
    try { offStore && offStore(); } catch (e) { console.warn(e); }
    try { unsub && unsub(); } catch (e) { console.warn(e); }
    if (ch) { try { ch.leave(); } catch (e) { console.warn(e); } ch = null; }
    popView.close();
    destroyWsHost();
    destroyHost();
  };
}

// ── 복습 (/student/review/:id) — 학습지 QR로 들어와 내 페이스로 ──
// 가정: 수업 때 내 필기·답을 그대로 이어서 쓴다(같은 레코드·응답에 저장 → 교사 기록에도 반영). 실시간 구독은 하지 않는다.
// 가정: 필기는 모두 내 개별(individual) 칸에 쓴다 — 전체·모둠 칠판은 반 전체가 공유하므로 그 필기는 바닥 그림으로만 보여 준다.
// 가정: 응답형은 다시 받는 상태(phase idle, 정답 숨김). 수업에서 정답을 공개했던 슬라이드만 [정답 보기]로 확인(이때는 잠김).
// 가정: 게임(공룡·레이싱)은 다른 학생과 함께 하는 활동이라 결과만 보여 준다(phase ended).
// 가정(v2.8): 복습은 늘 학생 페이스·첫 슬라이드부터(결석생·다시 공부하는 학생이 처음부터 따라가게). 진행 중인 수업이어도 수업 화면으로
//       보내지 않고 위쪽에 [수업 들어가기]만 띄운다. 같은 탭에서 새로고침했을 때만 보던 슬라이드를 이어서 연다(sessionStorage).
//       수업 때 선생님·친구들이 쓴 기록(전체·모둠 칠판 필기, 담벼락·워드클라우드 등 응답)은 그대로 보이고, 문제는 복습하는 학생도 다시 푼다.
const REVIEW_POS = "hada:review:"; // + sessionId:studentId → 이 탭에서 마지막으로 본 슬라이드(새로고침용)
// 가정(v2.12): 복습 미리보기 띠 — 머리 줄 아래 번호 붙은 작은 그림(캔바·PPT처럼), 지금 슬라이드 강조, 누르면 이동. 학습지 쪽은 📝 구분선 뒤에.
//       [n / N]을 눌러 접고 펴며 기기마다 기억(localStorage). 처음에는 화면 높이가 넉넉할 때(560px 이상)만 편다.
//       그림은 띠에 보일 때 그리고(IntersectionObserver), 필기 슬라이드·학습지는 내가 쓴 필기까지 얹는다. 떠난 슬라이드는 다시 그린다.
//       학습지가 있으면 오른쪽 가장자리 📝 탭: 슬라이드 ↔ 학습지(마지막으로 본 쪽)를 바로 오간다.
const STRIP_KEY = "hada:reviewStrip";
function stripPref() {
  try { const v = localStorage.getItem(STRIP_KEY); if (v === "on" || v === "off") return v === "on"; } catch {}
  return (window.innerHeight || 800) >= 560;
}
const reduceMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
const ANSWER_TYPES = new Set(["mcq", "blank", "dragdrop", "short"]);
// 페이지를 새로고침해서 바로 이 복습 화면이 열렸는가(그때만 보던 곳 이어서) — 첫 화면에서 한 번만 쓴다
const LOAD_HASH = typeof location !== "undefined" ? location.hash : "";
let reviewReload = (() => { try { return performance.getEntriesByType("navigation")[0]?.type === "reload"; } catch { return false; } })();

// 수업에서 정답을 공개했던 슬라이드인가
function hadAnswer(slide, a) {
  if (!slide || !ANSWER_TYPES.has(slide.type) || !a) return false;
  return a.reveal === true || (slide.type === "mcq" && a.phase === "ended");
}
// 수업 때 공유 칠판(전체·모둠)의 필기 — 복습 화면의 바닥 그림
function sharedRec(s, slide, studentId) {
  const R = s.records || {};
  const m = effectiveMode(slide, s);
  if (m === "individual") return null;
  if (m === "group") { const g = myGroupOf(s, studentId); return g ? R.__groups?.[g.id]?.[slide.id] || null : null; }
  return R.__whole?.[slide.id] || null;
}
function reviewInkSlide(s, slide, studentId) {
  const rec = sharedRec(s, slide, studentId);
  const rm = new Set((rec && rec.removed) || []);
  const alive = (x, i) => !!x && !(x.id ? rm.has(x.id) : rm.has("#" + i));
  return {
    ...slide, mode: "individual",
    strokes: [...(slide.strokes || []).filter(alive), ...((rec && rec.strokes) || []).filter(x => x && !(x.id && rm.has(x.id)))],
    texts: [...(slide.texts || []).filter(x => x && !(x.id && rm.has(x.id))), ...((rec && rec.texts) || []).filter(x => x && !(x.id && rm.has(x.id)))],
  };
}
function reviewActivity(slide, a, showAnswer) {
  const base = a || { phase: "idle" };
  if (slide.type === "ink") return { ...base, mode: "individual" };
  if (getSlideType(slide.type).category === "game") return { ...base, phase: "ended" };
  if (showAnswer) return { ...base, phase: "ended", reveal: true };
  const { endsAt, startedAt, ...rest } = base;
  if (slide.type === "poll") return { ...rest, phase: "idle" }; // 설문: 수업에서 공개한 결과는 그대로 보여 줌(잠그지 않음)
  // autoRevealed: 객관식의 '전원 응답 → 자동 공개'를 끈다(혼자 복습하면 늘 전원 응답)
  return { ...rest, phase: "idle", reveal: false, autoRevealed: true };
}

export function studentReviewView({ id } = {}) {
  const me = currentStudent();
  if (!me) { redirect("/student-login"); return; }
  if (!id) { redirect("/student/records"); return; }
  css();

  let dead = false, host = null, offStore = null, started = false, mounting = false, dirty = false;
  let loadTimer = null, loadTries = 0, idx = 0;
  let slides = null, slidesSrc = null, slidesWs = null; // 복습용 슬라이드(필기는 바닥 그림 합침) + 학습지 쪽 — 스냅샷마다 1회
  const answers = new Set();             // [정답 보기]를 켠 슬라이드 id
  let ansVer = 0, viewCache = null;
  const shown = {};

  const titleEl = el("div", { class: "topbar-title" }, "");
  const answerLabel = el("span", { class: "ans-label" });
  const answerBtn = el("button", { class: "btn btn-sm", type: "button", hidden: true, onClick: toggleAnswer }, [icon("eye", 16), answerLabel]);
  const prevBtn = el("button", { class: "btn btn-icon btn-ghost", type: "button", "aria-label": "이전", onClick: () => step(-1) }, icon("chevron-left"));
  const nextBtn = el("button", { class: "btn btn-icon btn-ghost", type: "button", "aria-label": "다음", onClick: () => step(1) }, icon("chevron-right"));
  let stripOn = stripPref();
  const countText = el("span", {}, "");
  const countEl = el("button", { class: "slide-count rv-count", type: "button", "aria-controls": "rv-strip", onClick: () => setStrip(!stripOn, true) },
    [countText, icon("chevron-down", 14)]);
  const exitBtn = el("button", { class: "btn btn-ghost", type: "button", onClick: () => go("/student/records") }, "나가기");
  // 지금 진행 중인 수업이면 선생님 수업으로 들어가는 버튼(복습은 그대로 내 페이스)
  const liveBtn = el("button", { class: "btn btn-sm btn-primary stu-live-btn", type: "button", hidden: true,
    onClick: () => { ssSet(LEFT_KEY, null); go("/student/live/" + id); } }, "수업 들어가기");
  const top = el("header", { class: "stu-top" }, [
    brand(), titleEl, el("span", { class: "pill pill-accent pill-review" }, "복습"), answerBtn,
    el("div", { class: "slide-nav" }, [prevBtn, countEl, nextBtn]),
    liveBtn, exitBtn, meChip(me),
  ]);
  const posKey = `${REVIEW_POS}${id}:${me.id}`;
  const resume = reviewReload && location.hash === LOAD_HASH;
  reviewReload = false;
  const stage = el("div", { class: "stu-stage" }, [el("div", { class: "center" }, el("span", { class: "spinner", "aria-label": "불러오는 중" }))]);
  const strip = el("nav", { class: "rv-strip", id: "rv-strip", "aria-label": "슬라이드 미리보기", hidden: true });
  const wsTabEl = wsTab({ onClick: jumpWs });
  wsTabEl.set({ hidden: true });
  const rroot = el("div", { class: "stu stu-review" }, [top, strip, stage, wsTabEl]);
  mount(rroot);
  // 팝업 상호작용: 슬라이드의 핀을 눌러 스스로 열고 닫는다(복습용 세션 보기로)
  let localPop = null;
  const popView = createPopupView({ container: rroot, role: "student", me, sessionView, onClose: () => { localPop = null; render(); } });

  function setText(node, key, text) {
    if (shown[key] === text) return;
    shown[key] = text;
    node.textContent = text;
  }
  function destroyHost() {
    if (host) { try { host.destroy(); } catch (e) { console.warn("[review] host.destroy", e); } }
    host = null;
  }

  // ── 미리보기 띠 ──
  let stripList = null, stripItems = [], stripActive = -1, stripIO = null;
  const stripSeen = new Set(); // 띠에 보이는 칸 번호
  strip.addEventListener("click", (e) => {
    const b = e.target.closest(".rv-item");
    if (b && strip.contains(b)) goTo(Number(b.dataset.i));
  });
  // 마우스 휠(세로)로도 띠를 가로로 넘긴다
  strip.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || strip.scrollWidth <= strip.clientWidth) return;
    e.preventDefault();
    strip.scrollLeft += e.deltaY;
  }, { passive: false });
  // 필기 슬라이드·학습지 그림에는 내 필기(개별 칸)도 얹는다 — 복습 화면에 보이는 것과 같게
  function stripThumb(s, sl) {
    let view = sl;
    const rec = sl.type === "ink" ? s.records?.[me.id]?.[sl.id] : null;
    if (rec) {
      const rm = new Set(rec.removed || []);
      const fresh = (x) => !!x && !(x.id && rm.has(x.id));
      view = {
        ...sl,
        strokes: [...(sl.strokes || []).filter((x, i) => !!x && !(x.id ? rm.has(x.id) : rm.has("#" + i))), ...(rec.strokes || []).filter(fresh)],
        texts: [...(sl.texts || []).filter(fresh), ...(rec.texts || []).filter(fresh)],
      };
    }
    const def = getSlideType(sl.type);
    try {
      const n = typeof def.thumb === "function" ? def.thumb(view) : null;
      if (n instanceof Node) return n;
    } catch (e) { console.warn("[review] 미리보기 그림 실패", sl.type, e); }
    return el("div", { class: "thumb-generic" }, [el("span", { class: "thumb-icon", html: def.icon || "" }), el("span", { class: "thumb-title" }, sl.title || def.label || "")]);
  }
  function fillThumb(i) {
    const b = stripItems[i], s = findSession(id), sl = stripList && stripList[i];
    if (!b || !s || !sl) return;
    b._filled = true;
    b.firstChild.replaceChildren(stripThumb(s, sl));
  }
  function buildStrip(list, nSlides) {
    stripIO?.disconnect();
    stripSeen.clear();
    stripList = list; stripActive = -1;
    stripItems = list.map((sl, i) => {
      const label = i < nSlides ? `${i + 1}. ${sl.title || getSlideType(sl.type).label || ""}` : `${i + 1}. ${sl.title || "학습지"}`;
      return el("button", { class: "rail-item rv-item", type: "button", "data-i": String(i), title: label, "aria-label": label },
        [el("div", { class: "rv-thumb" }), el("span", { class: "rail-num" }, String(i + 1))]);
    });
    const kids = stripItems.slice();
    if (nSlides < list.length) kids.splice(nSlides, 0, el("div", { class: "rv-sep", "aria-hidden": "true" }, [el("span", {}, "📝"), el("span", {}, "학습지")]));
    strip.replaceChildren(...kids);
    if (typeof IntersectionObserver !== "function") { stripItems.forEach((_, i) => fillThumb(i)); return; }
    stripIO = new IntersectionObserver((ents) => {
      for (const en of ents) {
        const i = Number(en.target.dataset.i);
        if (!en.isIntersecting) { stripSeen.delete(i); continue; }
        stripSeen.add(i);
        if (!en.target._filled) fillThumb(i);
      }
    }, { root: strip, rootMargin: "0px 320px" });
    stripItems.forEach(b => stripIO.observe(b));
  }
  function syncStrip(list) {
    if (stripList !== list) buildStrip(list, slidesSrc ? slidesSrc.length : list.length);
    if (stripActive === idx) return;
    const old = stripItems[stripActive];
    if (old) {
      old.classList.remove("active");
      old.removeAttribute("aria-current");
      // 방금 떠난 슬라이드: 거기서 쓴 필기가 보이게 다시 그린다(보이지 않으면 보일 때)
      if (old._filled) { old._filled = false; if (stripSeen.has(stripActive)) fillThumb(stripActive); }
    }
    stripActive = idx;
    const b = stripItems[idx];
    if (b) { b.classList.add("active"); b.setAttribute("aria-current", "true"); }
    revealActive();
  }
  // 지금 슬라이드 칸이 띠 밖이면 가운데로(이미 보이면 그대로 — 누른 칸이 손가락 밑에서 달아나지 않게)
  function revealActive() {
    const b = stripItems[stripActive];
    if (!b || strip.hidden) return;
    const L = strip.scrollLeft, W = strip.clientWidth, x = b.offsetLeft, w = b.offsetWidth;
    if (x >= L + 12 && x + w <= L + W - 12) return;
    const left = Math.max(0, x - (W - w) / 2);
    try { strip.scrollTo({ left, behavior: reduceMotion() ? "auto" : "smooth" }); } catch { strip.scrollLeft = left; }
  }
  // 화면 크기·방향이 바뀌면 지금 칸이 띠 밖으로 밀려날 수 있다
  let revealTimer = 0;
  const onResize = () => { clearTimeout(revealTimer); revealTimer = setTimeout(revealActive, 150); };
  window.addEventListener("resize", onResize);
  function setStrip(on, user) {
    stripOn = !!on;
    strip.hidden = !stripOn || !stripList;
    countEl.setAttribute("aria-expanded", String(stripOn));
    countEl.title = stripOn ? "미리보기 접기" : "슬라이드 미리보기";
    if (user) { try { localStorage.setItem(STRIP_KEY, stripOn ? "on" : "off"); } catch {} }
    if (!strip.hidden) revealActive();
  }

  // ── 학습지 바로 가기(오른쪽 📝 탭): 슬라이드 ↔ 학습지 마지막으로 본 쪽 ──
  let backSlide = 0, backWs = -1;
  function jumpWs() {
    const nS = slidesSrc ? slidesSrc.length : 0;
    if (!slides || slides.length <= nS) return;
    if (idx >= nS) goTo(clamp(backSlide, 0, Math.max(0, nS - 1)));
    else goTo(backWs >= nS ? backWs : nS);
  }
  function syncWsTab() {
    const nS = slidesSrc ? slidesSrc.length : 0, nW = slidesWs ? slidesWs.length : 0;
    if (!nS || !nW) { wsTabEl.set({ hidden: true }); return; }
    const onWs = idx >= nS;
    if (onWs) backWs = idx; else backSlide = idx;
    wsTabEl.set({ hidden: false, open: onWs, label: onWs ? "슬라이드" : "학습지" });
  }

  function reviewSlides(s) {
    const snap = Array.isArray(s.slidesSnapshot) ? s.slidesSnapshot : [];
    const ws = wsPages(s);
    if (slidesSrc !== snap || slidesWs !== ws) {
      slidesSrc = snap; slidesWs = ws;
      slides = [
        ...snap.map(sl => (sl && sl.type === "ink" ? reviewInkSlide(s, sl, me.id) : sl)),
        // 학습지 쪽도 뒤에 이어서 복습(수업 때처럼 내 개별 칸에 저장)
        ...ws.map((p, i) => reviewInkSlide(s, { ...p, title: wsPageTitle(p, i), mode: "individual" }, me.id)),
      ];
    }
    return slides;
  }
  // 플러그인에게 보여 줄 세션: 활동 상태·모드·흐름만 복습용으로, 나머지(응답·필기·참여자)는 진짜 세션 그대로
  function sessionView(real) {
    const c = viewCache;
    if (c && c.real === real && c.act === real.activity && c.snap === real.slidesSnapshot && c.ws === real.worksheet && c.ans === ansVer) return c.view;
    const list = reviewSlides(real);
    const activity = {};
    for (const sl of list) if (sl) activity[sl.id] = reviewActivity(sl, real.activity?.[sl.id], answers.has(sl.id));
    const over = { activity, flow: "student", slidesSnapshot: list };
    const view = new Proxy(real, { get: (t, k) => (Object.prototype.hasOwnProperty.call(over, k) ? over[k] : Reflect.get(t, k)) });
    viewCache = { real, act: real.activity, snap: real.slidesSnapshot, ws: real.worksheet, ans: ansVer, view };
    return view;
  }

  function render() {
    if (dead || !started) return;
    if (mounting) { dirty = true; return; }
    const s = findSession(id);
    if (!s) return;
    const list = reviewSlides(s);
    const n = list.length;
    setText(titleEl, "title", s.title || "");
    titleEl.title = s.title || "";
    liveBtn.hidden = s.status !== "live";
    if (!n) {
      destroyHost(); strip.hidden = true; wsTabEl.set({ hidden: true });
      stage.replaceChildren(el("div", { class: "empty" }, "슬라이드가 없어요"));
      return;
    }
    idx = clamp(idx, 0, n - 1);
    const slide = list[idx];
    setText(countText, "count", `${idx + 1} / ${n}`);
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx >= n - 1;
    const firstStrip = !stripList;
    syncStrip(list);
    if (firstStrip) setStrip(stripOn);
    syncWsTab();
    wsPrefetch(list, idx); // 앞뒤 슬라이드·학습지 배경을 미리 받아 둔다
    const can = hadAnswer(slide, s.activity?.[slide.id]);
    answerBtn.hidden = !can;
    if (can) {
      const label = answers.has(slide.id) ? "다시 풀기" : "정답 보기";
      setText(answerLabel, "answer", label);
      answerBtn.title = label;
      answerBtn.setAttribute("aria-label", label);
    }
    const lps = localPop ? findPopSlide(s, localPop) : null;
    if (lps) popView.show(s, lps, { closable: true }); else { localPop = null; popView.close(); }
    if (host) { host.update({ slide, session: s }); return; }
    stage.replaceChildren();
    mounting = true; dirty = false;
    try { host = mountSlideHost({ role: "student", root: stage, slide, session: s, me, sessionView, onPopup: (pid) => { localPop = pid; render(); } }); }
    catch (e) { console.error("[review] 슬라이드 표시 실패", e); host = null; }
    finally { mounting = false; }
    if (dead) { destroyHost(); return; }
    if (!host) { stage.replaceChildren(el("div", { class: "empty" }, "이 슬라이드를 불러오지 못했어요")); return; }
    if (dirty) { dirty = false; render(); }
  }

  function goTo(i) {
    if (!slides || !slides.length) return;
    const next = clamp(i, 0, slides.length - 1);
    if (next === idx || !Number.isFinite(next)) return;
    idx = next;
    localPop = null;
    ssSet(posKey, String(idx));
    render();
  }
  const step = (d) => goTo(idx + d);
  function toggleAnswer() {
    const slide = slides && slides[idx];
    if (!slide) return;
    if (answers.has(slide.id)) answers.delete(slide.id); else answers.add(slide.id);
    ansVer++;
    render();
  }
  function onKey(e) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.defaultPrevented || e.isComposing || e.altKey || e.metaKey || e.ctrlKey) return;
    if (document.documentElement.classList.contains("has-layer")) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    step(e.key === "ArrowLeft" ? -1 : 1);
  }

  function showLoadFail() {
    destroyHost();
    const retry = el("button", { class: "btn", type: "button", onClick: () => { loadTries = 0; load(); } }, "다시 시도");
    stage.replaceChildren(el("div", { class: "center stack" }, [el("div", { class: "empty" }, "수업을 불러오지 못했어요"), retry]));
  }

  async function load() {
    clearTimeout(loadTimer);
    if (dead || started) return;
    // 복습은 낡은 캐시(끝난 줄 모르는 live 등)를 믿지 않고 항상 서버에서 한 번 읽는다
    let s = null;
    try { s = await cloudFetchSession(id, { forStudentId: me.id }); }
    catch (e) { console.warn("[review] 세션 조회 실패", e); }
    if (dead || started) return;
    if (!s) {
      showLoadFail();
      if (++loadTries < 5) loadTimer = setTimeout(load, 3000);
      return;
    }
    if (s.status === "live") toast("지금 진행 중인 수업이에요 · 위의 [수업 들어가기]로 함께할 수 있어요");
    // 수업에 없던 학생도 복습하면 참여자로 남아 교사 기록에 보인다(이미 있으면 서버가 무시)
    cloudAddParticipant(id, me.id).then(r => { if (r && r.error) console.warn("[review] 참여 등록 실패", r.error); },
      e => console.warn("[review] 참여 등록 실패", e));
    idx = resume ? (parseInt(ssGet(posKey) || "0", 10) || 0) : 0; // 복습은 첫 슬라이드부터
    ssSet(posKey, String(idx));
    offStore = store.subscribe(render);
    document.addEventListener("keydown", onKey);
    started = true;
    render();
  }
  load();

  return () => {
    dead = true;
    clearTimeout(loadTimer);
    document.removeEventListener("keydown", onKey);
    try { offStore && offStore(); } catch (e) { console.warn(e); }
    stripIO?.disconnect();
    window.removeEventListener("resize", onResize);
    clearTimeout(revealTimer);
    popView.close();
    destroyHost();
  };
}

// ── 내 기록 (/student/records) ──
export function studentRecordsView() {
  const me = currentStudent();
  if (!me) { redirect("/student-login"); return; }
  css();

  let dead = false, list = null, token = 0;
  let viewers = [];
  const timers = new Map(); // id → 'timeout'|'interval' (summary ctx 보조 타이머)

  const backBtn = el("button", { class: "btn btn-ghost", type: "button" }, [icon("chevron-left"), "돌아가기"]);
  const body = el("div", { class: "stack" });
  mount(el("main", { class: "stu-page" }, [el("div", { class: "stu-page-top" }, [backBtn, meChip(me)]), body]));

  const spinner = () => el("div", { class: "center", style: { padding: "48px 0" } }, el("span", { class: "spinner", "aria-label": "불러오는 중" }));

  function clearDetail() {
    viewers.forEach(v => { try { v.destroy(); } catch {} });
    viewers = [];
    for (const [tid, kind] of timers) kind === "interval" ? clearInterval(tid) : clearTimeout(tid);
    timers.clear();
  }

  function showList() {
    clearDetail();
    const my = ++token;
    backBtn.onclick = () => go("/student");
    if (!list) {
      body.replaceChildren(spinner());
      cloudListSessionsForStudent(me.id).then(rows => {
        if (dead || my !== token) return;
        list = rows || [];
        showList();
      }, e => {
        console.warn("[student] 기록 조회 실패", e);
        if (!dead && my === token) body.replaceChildren(el("div", { class: "empty" }, "기록을 불러오지 못했어요"));
      });
      return;
    }
    if (!list.length) { body.replaceChildren(el("div", { class: "empty" }, "끝난 수업이 여기 모여요")); return; }
    body.replaceChildren(el("div", { class: "list" }, list.map(s => el("button", {
      class: "list-row", type: "button", onClick: () => showDetail(s.id),
    }, [
      el("div", { class: "grow" }, [
        el("div", { class: "title" }, s.title || "수업"),
        el("div", { class: "meta" }, fmtDate(s.startedAt)),
      ]),
      s.status === "live" ? el("span", { class: "pill pill-live" }, "진행 중") : null,
      icon("chevron-right"),
    ]))));
  }

  // summary용 읽기 전용 ctx
  function summaryCtx(slide, s) {
    const ctx = {
      role: "student", isTeacher: false, me: { id: me.id }, slide,
      session: () => findSession(s.id) || s,
      students() {
        const map = new Map();
        for (const st of store.state.students || []) map.set(st.id, st);
        if (!map.has(me.id)) map.set(me.id, { id: me.id, grade: me.grade, classNum: me.classNum, num: me.num, name: me.name });
        return map;
      },
      participants: () => (s.participants || []).slice(),
      online: () => new Set(),
      activity: () => s.activity?.[slide.id] || { phase: "idle" },
      responses: () => (s.responses?.[slide.id] || []).filter(r => r.studentId === me.id),
      myResponse: (itemKey = "") => (s.responses?.[slide.id] || []).find(r => r.studentId === me.id && (r.itemKey || "") === (itemKey || "")) || null,
      groups: () => s.groups || [],
      myGroup: () => myGroupOf(s, me.id),
      setActivity() {}, async submit() { return null; }, async removeResponse() {}, async clearResponses() {},
      send() {}, on: () => () => {},
      toast: () => {}, confirm: async () => false, modal: () => null,
      injectCss,
      timeout(fn, ms) { const t = setTimeout(() => { timers.delete(t); if (!dead) fn(); }, ms); timers.set(t, "timeout"); return t; },
      interval(fn, ms) { const t = setInterval(() => { if (!dead) fn(); }, ms); timers.set(t, "interval"); return t; },
      clearTimer(t) { timers.get(t) === "interval" ? clearInterval(t) : clearTimeout(t); timers.delete(t); },
    };
    return ctx;
  }

  function hasInk(rec) { return !!rec && ((rec.strokes || []).length || (rec.texts || []).length); }
  function inkScope(slide, s) {
    const R = s.records || {};
    const g = myGroupOf(s, me.id);
    const cands = {
      individual: { scope: "individual", scopeId: me.id, rec: R[me.id]?.[slide.id] },
      group: g ? { scope: "group", scopeId: g.id, rec: R.__groups?.[g.id]?.[slide.id] } : null,
      whole: { scope: "whole", scopeId: s.id, rec: R.__whole?.[slide.id] },
    };
    const m = effectiveMode(slide, s);
    const first = m === "individual" ? cands.individual : m === "group" ? (cands.group || cands.whole) : cands.whole;
    if (hasInk(first.rec)) return first;
    return [cands.individual, cands.group, cands.whole].find(c => c && hasInk(c.rec)) || first;
  }

  function slideBlock(slide, i, s) {
    const def = getSlideType(slide.type);
    const box = el("section", { class: "card stu-rec-slide" }, [
      el("div", { class: "stu-rec-no" }, `${i + 1}. ${slide.title || def.label || ""}`),
    ]);
    if (slide.type === "ink") {
      const frameBox = el("div", {});
      box.appendChild(frameBox);
      try {
        const sc = inkScope(slide, s);
        viewers.push(renderSlide({ root: frameBox, slide, session: s, scope: sc.scope, scopeId: sc.scopeId, readOnly: true, authorId: me.id }));
      } catch (e) {
        console.warn("[student] 필기 기록 표시 실패", e);
        frameBox.replaceChildren(el("div", { class: "empty" }, "이 슬라이드를 불러오지 못했어요"));
      }
      return box;
    }
    if (typeof def.summary !== "function") return box;
    const mine = (s.responses?.[slide.id] || []).filter(r => r.studentId === me.id);
    let node = null;
    try { node = def.summary(slide, mine, s, summaryCtx(slide, s)); }
    catch (e) { console.warn(`[student] ${slide.type} 기록 표시 실패`, e); node = null; }
    box.appendChild(node instanceof Node ? node : el("div", { class: "empty" }, "이 슬라이드를 불러오지 못했어요"));
    return box;
  }

  function showDetail(sessionId) {
    clearDetail();
    const my = ++token;
    backBtn.onclick = () => showList();
    body.replaceChildren(spinner());
    cloudFetchSession(sessionId, { forStudentId: me.id }).then(s => {
      if (dead || my !== token) return;
      if (!s) { body.replaceChildren(el("div", { class: "empty" }, "기록을 불러오지 못했어요")); return; }
      const slides = Array.isArray(s.slidesSnapshot) ? s.slidesSnapshot : [];
      body.replaceChildren(
        el("div", { class: "stu-rec-head stack-sm" }, [
          el("h2", {}, s.title || "수업"),
          el("div", { class: "muted" }, fmtDate(s.startedAt)),
          s.status === "live"
            ? el("button", { class: "btn btn-primary", type: "button", onClick: () => go("/student/live/" + s.id) }, "수업 들어가기")
            : el("button", { class: "btn btn-primary", type: "button", onClick: () => go("/student/review/" + s.id) }, [icon("pen", 18), "복습하기"]),
        ]),
        ...(slides.length ? slides.flatMap((sl, i) => [slideBlock(sl, i, s), ...hotspotsOf(sl).map(h => slideBlock(popSlideFor(h, sl), i, s))])
          : [el("div", { class: "empty" }, "슬라이드가 없어요")]),
        // 학습지 쪽(내 개별 필기)
        ...wsPages(s).map((p, i) => slideBlock({ ...p, title: wsPageTitle(p, i), mode: "individual" }, slides.length + i, s)),
      );
    }, e => {
      console.warn("[student] 기록 상세 조회 실패", e);
      if (!dead && my === token) body.replaceChildren(el("div", { class: "empty" }, "기록을 불러오지 못했어요"));
    });
  }

  showList();

  return () => {
    dead = true;
    token++;
    clearDetail();
  };
}
