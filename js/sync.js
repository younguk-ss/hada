// 로컬 모드 탭 간 동기화 (BroadcastChannel + localStorage storage 이벤트)
// 클라우드 모드에서는 storage 병합을 하지 않는다(각 탭이 realtime으로 동기화, 영속 상태는 슬림).
// 가정: 세밀한 변경(필기·응답·세션 패치·참여)은 cloud.js가 sync.emit 메시지로 보내고 받아 반영한다.
//       storage 병합은 새 항목 추가·삭제 반영·rev/updatedAt이 더 큰 메타 반영만 한다(되돌림 방지).
import { store, KEY, ensureSessionShape } from "./store.js";

const ch = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("hada-sync") : null;
const listeners = new Set();

if (ch) {
  ch.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || !msg.type) return;
    listeners.forEach(fn => { try { fn(msg); } catch (e) { console.error("[sync] listener 오류:", e); } });
  };
}

const SESSION_META = ["title", "status", "flow", "currentSlide", "groups", "activity", "endedAt", "rev"];

// 배열을 id 기준으로 제자리 병합. 이전 저장본엔 있었는데 새 저장본에 없으면 = 다른 탭이 삭제.
function mergeList(cur, inc, oldIds, mergeOne) {
  let changed = false;
  const incIds = new Set(inc.map(x => x && x.id));
  for (const item of inc) {
    if (!item || !item.id) continue;
    const ex = cur.find(x => x.id === item.id);
    if (!ex) { cur.push(item); changed = true; }
    else if (mergeOne(ex, item)) changed = true;
  }
  for (let i = cur.length - 1; i >= 0; i--) {
    const id = cur[i] && cur[i].id;
    if (oldIds.has(id) && !incIds.has(id)) { cur.splice(i, 1); changed = true; }
  }
  return changed;
}

function mergeSession(ex, inc) {
  let changed = false;
  ensureSessionShape(ex);
  if (Number(inc.rev || 0) > Number(ex.rev || 0)) {
    for (const k of SESSION_META) if (k in inc) ex[k] = inc[k];
    changed = true;
  }
  for (const id of inc.participants || []) {
    if (!ex.participants.includes(id)) { ex.participants.push(id); changed = true; }
  }
  if (inc.reviewCode && !ex.reviewCode) { ex.reviewCode = inc.reviewCode; changed = true; } // 복습 코드는 한 번 정해지면 불변
  if (!ex.slidesSnapshot.length && inc.slidesSnapshot?.length) { ex.slidesSnapshot = inc.slidesSnapshot; changed = true; }
  // records: 없는 슬라이드 레코드만 추가 (병합은 메시지 경로가 담당)
  const ir = inc.records || {};
  for (const [k, v] of Object.entries(ir)) {
    if (!v || typeof v !== "object") continue;
    if (k === "__groups") {
      for (const [gid, m] of Object.entries(v)) {
        const slot = (ex.records.__groups[gid] ||= {});
        for (const [sid, rec] of Object.entries(m || {})) if (!slot[sid]) { slot[sid] = rec; changed = true; }
      }
    } else {
      const slot = (ex.records[k] ||= {});
      for (const [sid, rec] of Object.entries(v)) if (!slot[sid]) { slot[sid] = rec; changed = true; }
    }
  }
  // responses: 없는 (studentId,itemKey)만 추가
  for (const [slideId, list] of Object.entries(inc.responses || {})) {
    const cur = ex.responses[slideId] || [];
    const add = (list || []).filter(r => !cur.some(c => c.studentId === r.studentId && (c.itemKey || "") === (r.itemKey || "")));
    if (add.length) { ex.responses[slideId] = [...cur, ...add]; changed = true; }
  }
  return changed;
}

function mergeLesson(ex, inc) {
  if ((inc.updatedAt || 0) > (ex.updatedAt || 0)) { Object.assign(ex, inc); return true; }
  return false;
}

function mergeSimple(ex, inc) {
  const before = JSON.stringify(ex);
  Object.assign(ex, inc);
  return before !== JSON.stringify(ex);
}

function idsOf(raw, key) {
  try { return new Set((JSON.parse(raw || "{}")[key] || []).map(x => x && x.id)); } catch (_) { return new Set(); }
}

window.addEventListener("storage", (e) => {
  if (e.key !== KEY || !e.newValue || store.cloudMode) return;
  let inc;
  try { inc = JSON.parse(e.newValue); } catch (_) { return; }
  const st = store.state;
  let changed = false;
  changed = mergeList(st.teachers, inc.teachers || [], idsOf(e.oldValue, "teachers"), mergeSimple) || changed;
  changed = mergeList(st.students, inc.students || [], idsOf(e.oldValue, "students"), mergeSimple) || changed;
  changed = mergeList(st.lessons, inc.lessons || [], idsOf(e.oldValue, "lessons"), mergeLesson) || changed;
  const incSessions = (inc.sessions || []).map(s => ensureSessionShape(s));
  changed = mergeList(st.sessions, incSessions, idsOf(e.oldValue, "sessions"), mergeSession) || changed;
  // whoTeacher/whoStudent/studentProfile은 탭마다 다를 수 있으므로 병합하지 않는다
  if (changed) store.notify();
});

export const sync = {
  emit(msg) { try { ch && ch.postMessage(msg); } catch (e) { console.warn("[sync] emit 실패:", e); } },
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
