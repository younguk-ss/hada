// 슬라이드 호스트 — 플러그인을 마운트하고 ctx 를 만들어 준다 (docs/ARCHITECTURE.md §6.2)
// 키 `${slide.id}|${role}` 가 같으면 DOM 보존 + 훅만 호출, 다르면 destroy 후 재마운트.
// 가정: cloud/realtime/ui/store 는 네임스페이스 import — 다른 에이전트 파일이 아직 덜 됐어도 모듈 링크가 깨지지 않게.
// 가정: ctx 에 명세 외 보조 함수 timeout(fn, ms)/interval(fn, ms)/clearTimer(id)/lesson/update 를 추가(destroy 시 자동 정리).
// 가정: sessionView(session) → 플러그인에게 보여 줄 세션(학생 복습: 활동 상태·모드를 바꾼 보기). 쓰기(응답·필기)는 store의 진짜 세션에 한다.
// 가정(v2.9): onPopup(id) → ctx.openPopup(id) — 필기 슬라이드의 팝업 핀을 눌렀을 때 코어 화면(교사·학생)이 팝업을 연다(js/popup.js).
//       ctx.popupId() = 지금 열린 팝업 id(교사가 띄운 activity.__pop).
import * as ui from "../ui.js";
import * as storeMod from "../store.js";
import * as cloud from "../cloud.js";
import * as realtime from "../realtime.js";
import { getSlideType, injectCss } from "./registry.js";

const { el } = ui;
let tmpSeq = 0; // 로컬 임시 응답 id (음수)
const latestSubmit = new Map(); // `${sessionId}|${slideId}|${respKey}` → 가장 최근 submit의 tmpId

// 학생 Map 캐시 — race 프레임·정렬 비교자 등 핫패스에서 매번 새 Map을 만들지 않게.
// 가정: store.state.students는 제자리 수정(upsertById는 객체 필드 갱신, 새 학생은 push, 삭제는 splice).
//       배열 identity·길이·처음/끝 원소가 같으면 캐시 재사용. 반환 Map은 읽기 전용(공유 인스턴스).
let stuCache = null, stuSrc = null, stuLen = -1, stuFirst = null, stuLast = null;
function studentMap() {
  const list = storeMod.store?.state?.students || [];
  const first = list[0] || null, last = list[list.length - 1] || null;
  if (stuCache && list === stuSrc && list.length === stuLen && first === stuFirst && last === stuLast) return stuCache;
  const map = new Map();
  for (const s of list) if (s) map.set(s.id, s);
  stuCache = map; stuSrc = list; stuLen = list.length; stuFirst = first; stuLast = last;
  return map;
}

function emptyEl(text = "이 슬라이드를 불러오지 못했어요") {
  return el("div", { class: "empty" }, text);
}
function respKey(r) { return `${r.studentId}|${r.itemKey || ""}`; }
// 가정: DB updated_at 이 upsert 때 안 바뀔 수도 있어 payload·score·correct 까지 비교(응답은 작아서 싸다)
function respSig(list) {
  if (!list || !list.length) return "0";
  try {
    return JSON.stringify(list.map(r => [r.id, r.updatedAt || 0, r.score ?? null, r.correct ?? null, r.payload ?? null]));
  } catch {
    return list.map(r => `${r.id}:${r.updatedAt || 0}`).join(",");
  }
}
function toast(msg) {
  if (typeof ui.toast === "function") ui.toast(msg);
  else console.log("[toast]", msg);
}

export function mountSlideHost({ role = "student", root, slide, session, me, lesson, onEditorUpdate, sessionView = null, onPopup = null } = {}) {
  let curSlide = slide;
  let curSession = session || null;
  let cur = null;          // { key, inst, ctx, wrap, listeners, timers, lastAct, lastSig }
  let destroyed = false;

  const sessionId = () => curSession?.id || null;
  // 항상 store 의 최신 세션 객체 (sessionView가 있으면 그 보기)
  function liveSession() {
    const id = sessionId();
    if (!id) return null;
    const st = storeMod.store?.state;
    const found = (typeof storeMod.findSession === "function" ? storeMod.findSession(id) : null)
      || st?.sessions?.find?.(s => s.id === id);
    if (found) curSession = found;
    return sessionView && curSession ? sessionView(curSession) : curSession;
  }

  function buildCtx(state) {
    const isEditor = role === "editor";
    const isTeacher = role !== "student";
    const sl = () => state.slide;

    const listeners = state.listeners; // [{ event, cb, ch, off }]
    const timers = state.timers;       // Map<id, 'timeout'|'interval'>

    // 실시간 리스너: 채널이 나중에 생기거나 바뀌어도 다시 붙인다
    function attach(l) {
      const ch = typeof realtime.currentChannel === "function" ? realtime.currentChannel() : null;
      if (l.ch === ch) return;
      try { l.off?.(); } catch {}
      l.ch = ch; l.off = null;
      if (ch && typeof ch.on === "function") {
        try { l.off = ch.on(l.event, l.cb); } catch (e) { console.warn("[host] ch.on", e); }
      }
    }
    state.reattach = () => { if (!isEditor) listeners.forEach(attach); };

    // 응답 배열을 새 배열로 교체(변경 감지용 identity 변경)
    function setResponses(fn) {
      const id = sessionId();
      if (!id) return;
      storeMod.store.set(st => {
        const s = st.sessions?.find(x => x.id === id) || curSession;
        if (!s) return;
        s.responses ||= {};
        s.responses[sl().id] = fn((s.responses[sl().id] || []).slice());
      });
    }

    const ctx = {
      role, isTeacher, me: me || null, slide: state.slide, lesson: lesson || null,
      session: () => (isEditor ? null : liveSession()),
      // 교사 시계 기준 현재 시각(학생·편집기는 realtime 의 오프셋 추정값 사용)
      now() {
        if (role === "teacher") return Date.now();
        const id = sessionId();
        if (id && typeof realtime.teacherNow === "function") {
          try { const t = realtime.teacherNow(id); if (Number.isFinite(t)) return t; } catch {}
        }
        return Date.now();
      },
      students() { return studentMap(); }, // 읽기 전용 공유 Map — 수정 금지
      participants() { return isEditor ? [] : (liveSession()?.participants || []).slice(); },
      online() {
        if (role !== "teacher") return new Set();
        const ch = typeof realtime.currentChannel === "function" ? realtime.currentChannel() : null;
        try { return new Set(ch?.online?.() || []); } catch { return new Set(); }
      },
      activity() {
        if (isEditor) return { phase: "idle" };
        return liveSession()?.activity?.[sl().id] || { phase: "idle" };
      },
      setActivity(patch) {
        if (role !== "teacher") { console.warn("[host] setActivity 는 교사 전용"); return; }
        const s = liveSession();
        if (!s) return;
        const prev = s.activity?.[sl().id] || { phase: "idle" };
        const activity = { ...(s.activity || {}), [sl().id]: { ...prev, ...patch } };
        if (typeof cloud.patchSession === "function") cloud.patchSession(s, { activity });
        else storeMod.store.set(() => { s.activity = activity; });
      },
      responses() {
        if (isEditor) return [];
        return liveSession()?.responses?.[sl().id] || [];
      },
      myResponse(itemKey = "") {
        if (isEditor || !me) return null;
        const k = itemKey || "";
        return ctx.responses().find(r => r.studentId === me.id && (r.itemKey || "") === k) || null;
      },
      // asTeacher: 교사도 응답 행을 쓸 수 있게 허용(담벼락 교사 글·댓글). studentId = 교사 id.
      async submit(payload, { itemKey = "", score = null, correct = null, timeMs = null, asTeacher = false } = {}) {
        if (!me || !sessionId()) return null;
        if (role !== "student" && !(role === "teacher" && asTeacher)) return null;
        const k = itemKey || "";
        const tmpId = -(++tmpSeq);
        const r = {
          id: tmpId, sessionId: sessionId(), slideId: sl().id, studentId: me.id, itemKey: k,
          payload, score, correct, timeMs, updatedAt: Date.now(),
        };
        const key = respKey(r);
        const subKey = `${r.sessionId}|${r.slideId}|${key}`;
        latestSubmit.set(subKey, tmpId);
        const prev = ctx.responses().find(x => respKey(x) === key) || null;
        const put = (item) => list => {
          const i = list.findIndex(x => respKey(x) === key);
          const out = list.filter(x => respKey(x) !== key);
          if (item) out.splice(i < 0 ? out.length : i, 0, item);
          return out;
        };
        setResponses(put(r)); // 즉시 반영
        try {
          if (typeof cloud.cloudSubmitResponse !== "function") return r;
          const { id: _omit, ...row } = r;
          const saved = await cloud.cloudSubmitResponse(row);
          if (saved && saved.error) throw saved.error;
          const final = saved && saved.id != null ? { ...r, ...saved } : r;
          // 아직 내 임시본(또는 그 이후 저장본)일 때만 치환
          const now = ctx.responses().find(x => respKey(x) === key);
          if (!now || now.id === tmpId || (now.updatedAt || 0) <= final.updatedAt) setResponses(put(final));
          if (latestSubmit.get(subKey) === tmpId) latestSubmit.delete(subKey);
          return final;
        } catch (e) {
          console.warn("[host] submit 실패", e);
          // cloudSubmitResponse도 자체 낙관적 행(다른 음수 id)을 넣었다가 실패 시 키째 지운다.
          // → 자리가 비었거나 아직 임시(음수 id)면 이전 저장본으로 되돌린다. 단, 그 사이 더 새 submit이 시작됐으면 건드리지 않음.
          const isLatest = latestSubmit.get(subKey) === tmpId;
          if (isLatest) latestSubmit.delete(subKey);
          const now = ctx.responses().find(x => respKey(x) === key);
          const pending = !now || (typeof now.id === "number" && now.id < 0);
          if (isLatest && pending) setResponses(put(prev)); // 되돌리기(prev 없으면 비움)
          toast("제출 실패, 다시 시도해 주세요");
          throw e;
        }
      },
      async removeResponse(studentId, itemKey = "") {
        if (isEditor || !sessionId()) return;
        if (role === "student" && studentId !== me?.id) { console.warn("[host] 내 응답만 지울 수 있어요"); return; }
        const key = `${studentId}|${itemKey || ""}`;
        const prev = ctx.responses().find(x => respKey(x) === key) || null;
        setResponses(list => list.filter(x => respKey(x) !== key));
        try {
          if (typeof cloud.cloudDeleteResponse === "function") {
            const res = await cloud.cloudDeleteResponse(sessionId(), sl().id, studentId, itemKey || "");
            if (res && res.error) throw res.error;
          }
        } catch (e) {
          console.warn("[host] removeResponse 실패", e);
          if (prev) setResponses(list => (list.some(x => respKey(x) === key) ? list : [...list, prev]));
          toast("삭제하지 못했어요");
          throw e;
        }
      },
      async clearResponses() {
        if (role !== "teacher" || !sessionId()) return;
        const before = ctx.responses().slice();
        setResponses(() => []);
        try {
          if (typeof cloud.cloudDeleteResponsesForSlide === "function") {
            const res = await cloud.cloudDeleteResponsesForSlide(sessionId(), sl().id);
            if (res && res.error) throw res.error;
          }
        } catch (e) {
          console.warn("[host] clearResponses 실패", e);
          setResponses(list => (list.length ? list : before)); // 되돌리기
          toast("초기화하지 못했어요");
          throw e;
        }
      },
      send(event, payload) {
        if (isEditor) return;
        const ch = typeof realtime.currentChannel === "function" ? realtime.currentChannel() : null;
        try { ch?.send?.(event, payload); } catch (e) { console.warn("[host] send", e); }
      },
      on(event, cb) {
        if (isEditor) return () => {};
        const l = { event, cb, ch: undefined, off: null };
        listeners.push(l);
        attach(l);
        return () => {
          try { l.off?.(); } catch {}
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      // 팝업 상호작용(v2.9): 핀 누르기 → 코어가 연다. 편집기·팝업 안에서는 없음
      openPopup: !isEditor && typeof onPopup === "function" ? (id) => { try { onPopup(id); } catch (e) { console.warn("[host] openPopup", e); } } : null,
      popupId() { const p = !isEditor ? liveSession()?.activity?.__pop : null; return p && p.id ? p.id : null; },
      groups() { return isEditor ? [] : (liveSession()?.groups || []); },
      myGroup() {
        if (role !== "student" || !me) return null;
        return ctx.groups().find(g => (g.memberIds || []).includes(me.id)) || null;
      },
      toast,
      confirm(msg, { ok = "확인", danger = false } = {}) {
        // ui.confirmDialog({ title, ok, danger }) → Promise<boolean>
        if (typeof ui.confirmDialog === "function") return Promise.resolve(ui.confirmDialog({ title: msg, ok, danger })).then(Boolean);
        console.warn("[host] confirmDialog 없음:", msg);
        return Promise.resolve(false);
      },
      modal(opts) { return typeof ui.modal === "function" ? ui.modal(opts) : null; },
      injectCss,
      // 보조: destroy 시 자동 정리되는 타이머
      timeout(fn, ms) {
        const id = setTimeout(() => { timers.delete(id); if (!state.dead) fn(); }, ms);
        timers.set(id, "timeout");
        return id;
      },
      interval(fn, ms) {
        const id = setInterval(() => { if (!state.dead) fn(); }, ms);
        timers.set(id, "interval");
        return id;
      },
      clearTimer(id) {
        const kind = timers.get(id);
        if (kind === "interval") clearInterval(id); else clearTimeout(id);
        timers.delete(id);
      },
    };
    if (isEditor) {
      // 에디터: 코어 규칙대로 얕은 병합 후 코어에 알림(코어도 병합해도 멱등)
      ctx.update = (patch) => {
        if (!patch) return;
        Object.assign(state.slide, patch);
        try { onEditorUpdate?.(patch); } catch (e) { console.error("[host] onEditorUpdate", e); }
      };
    }
    return ctx;
  }

  function mount() {
    if (!curSlide) return;
    const def = getSlideType(curSlide.type);
    const state = {
      key: `${curSlide.id}|${role}`, slide: curSlide, inst: null, ctx: null, wrap: null,
      listeners: [], timers: new Map(), dead: false, lastAct: "", lastSig: "", reattach: null,
      mounting: false, pending: false,
    };
    cur = state;
    const ctx = buildCtx(state);
    state.ctx = ctx;
    // 플러그인이 본 상태를 기준으로 기록(생성 중 바뀐 것은 마운트 직후 훅으로 전달)
    state.lastAct = JSON.stringify(ctx.activity());
    state.lastSig = respSig(ctx.responses());
    state.mounting = true;
    const wrap = el("div", { class: "slide-host", "data-type": curSlide.type, "data-role": role });
    state.wrap = wrap;
    root?.appendChild(wrap);

    let inst = null;
    try {
      if (role === "editor") inst = def.Editor({ slide: curSlide, lesson: lesson || null, update: ctx.update, ctx });
      else if (role === "teacher") inst = def.TeacherLive({ slide: curSlide, session: liveSession(), ctx });
      else inst = def.Student({ slide: curSlide, session: liveSession(), me, ctx });
    } catch (e) {
      console.error(`[host] ${curSlide.type} 마운트 실패`, e);
      inst = null;
    }
    if (!inst || !(inst.el instanceof Node)) inst = { el: emptyEl() };
    state.inst = inst;
    state.mounting = false;
    if (state.dead) { try { inst.destroy?.(); } catch {} return; } // 생성 중 destroy 됨
    wrap.appendChild(inst.el);
    // 플러그인 생성 중(예: setActivity) 들어온 update 를 이제 반영
    if (state.pending && cur === state) { state.pending = false; update(); }
  }

  function unmount() {
    const st = cur;
    cur = null;
    if (!st) return;
    st.dead = true;
    try { st.inst?.destroy?.(); } catch (e) { console.warn("[host] plugin destroy", e); }
    for (const l of st.listeners.splice(0)) { try { l.off?.(); } catch {} }
    for (const [id, kind] of st.timers) { if (kind === "interval") clearInterval(id); else clearTimeout(id); }
    st.timers.clear();
    st.wrap?.remove();
  }

  function call(fnName, arg) {
    const fn = cur?.inst?.[fnName];
    if (typeof fn !== "function") return;
    try { fn.call(cur.inst, arg); } catch (e) { console.error(`[host] ${fnName} 실패`, e); }
  }

  function update({ slide: s, session: ss } = {}) {
    if (destroyed) return;
    if (s) curSlide = s;
    if (ss) curSession = ss;
    if (!curSlide) { unmount(); return; }
    if (cur?.mounting) { cur.pending = true; return; } // 마운트 중 재진입 → 끝난 뒤 처리
    const key = `${curSlide.id}|${role}`;
    if (!cur || cur.key !== key) { unmount(); mount(); return; }
    // 같은 키: DOM 보존, 훅만
    cur.slide = curSlide;
    cur.ctx.slide = curSlide;
    if (role === "editor") return;
    cur.reattach?.();
    const ctx = cur.ctx;
    const actJson = JSON.stringify(ctx.activity());
    if (actJson !== cur.lastAct) { cur.lastAct = actJson; call("onActivity", ctx.activity()); }
    if (!cur) return;
    const list = ctx.responses();
    const sig = respSig(list);
    if (sig !== cur.lastSig) { cur.lastSig = sig; call("onResponses", list); }
    if (!cur) return;
    call("onSession", liveSession());
  }

  function destroy() {
    if (destroyed) return;
    unmount();
    destroyed = true;
  }

  mount();

  return {
    update,
    destroy,
    get panel() { return role === "teacher" ? (cur?.inst?.panel || null) : null; },
    // 플러그인이 코어 화면(상단 바 등)에 내주는 동작 { 이름: fn } — 예: ink { groups: 모둠 편성 창 }
    get actions() { return role === "teacher" ? (cur?.inst?.actions || null) : null; },
    get inspector() { return role === "editor" ? (cur?.inst?.inspector || null) : null; },
    get ctx() { return cur?.ctx || null; },
  };
}
