// 로컬 상태 + 간단한 반응형 store (v2: 슬림 영속, 300ms 디바운스 저장)
// 가정: 클라우드 설정(window.HADA_SUPABASE_URL)이 있으면 로드 시점부터 클라우드 모드로 간주하고,
//       initCloud가 실패하면 cloud.js가 setCloudMode(false)로 되돌린다.
// 가정: 세션 객체의 `_full`(boolean)은 스냅샷·records·responses를 서버에서 다 불러왔는지 표시(클라우드 모드).
export const KEY = "hada:v1";
const LEGACY_KEY = "inkclass:v1"; // 이전 앱 이름(Inkclass) 시절 키 — 최초 1회 이전
const VERSION = 2;

const initial = {
  teachers: [],      // {id, name, passwordHash, joinCode}
  students: [],      // {id, grade, classNum, num, name}
  lessons: [],       // {id, teacherId, title, createdAt, updatedAt, slideCount, cover, subjectId, slides: Slide[]|null}
  subjects: [],      // {id, teacherId, name, position, color} — 교과(v2.15). 자료의 subjectId = null 이면 미분류
  sessions: [],      // §3.1 session
  whoTeacher: null,  // teacher id
  whoStudent: null,  // student id
  studentProfile: null, // {id, grade, classNum, num, name, lastCode}
};

function configuredCloud() {
  const url = typeof window !== "undefined" ? window.HADA_SUPABASE_URL : null;
  const key = typeof window !== "undefined" ? window.HADA_SUPABASE_ANON : null;
  return !!(url && key && !String(url).includes("YOUR_"));
}

let cloudMode = configuredCloud();

// 세션 객체 기본 형태 보정 (in-place)
export function ensureSessionShape(s) {
  if (!s) return s;
  s.records ||= {};
  s.records.__whole ||= {};
  s.records.__groups ||= {};
  s.responses ||= {};
  s.participants ||= [];
  s.slidesSnapshot ||= [];
  s.activity ||= {};
  s.groups ||= [];
  s.rev = Number(s.rev || 0);
  s.flow ||= "teacher";
  s.currentSlide ??= 0;
  return s;
}

function normalize(state, fromDisk) {
  state.teachers ||= [];
  state.students ||= [];
  state.lessons ||= [];
  state.subjects ||= [];
  state.sessions ||= [];
  // v1 데이터(버전 없음)를 클라우드 모드에서 읽으면 낡은 lessons/sessions는 버림 → 부팅 조회가 다시 채운다
  if (fromDisk && cloudMode && state._v !== VERSION) {
    state.lessons = [];
    state.sessions = [];
  }
  state.lessons.forEach(l => {
    if (!Array.isArray(l.slides) || cloudMode && fromDisk) l.slides = null;
    if (!Array.isArray(l.worksheet) || cloudMode && fromDisk) l.worksheet = null; // 학습지 페이지(slides와 함께 열 때 불러옴)
    if (l.slides) l.slideCount = l.slides.length;
    l.slideCount ??= 0;
    l.cover ??= null;
    l.updatedAt ??= l.createdAt || 0;
    l.subjectId ??= null;
  });
  state.sessions.forEach(s => {
    if (cloudMode && fromDisk) {
      delete s.records; delete s.responses; delete s.slidesSnapshot; delete s.worksheet;
      s._full = false;
    }
    ensureSessionShape(s);
  });
  state.studentProfile ??= null;
  delete state._v;
  return state;
}

function load() {
  try {
    let raw = localStorage.getItem(KEY);
    if (!raw) {
      raw = localStorage.getItem(LEGACY_KEY);
      if (raw) { try { localStorage.setItem(KEY, raw); } catch (_) {} localStorage.removeItem(LEGACY_KEY); }
    }
    if (!raw) return structuredClone(initial);
    return normalize({ ...structuredClone(initial), ...JSON.parse(raw) }, true);
  } catch (e) {
    console.warn("[store] load 실패:", e);
    return structuredClone(initial);
  }
}

// 클라우드 모드 영속 대상만 추림 (slides·records·responses·스냅샷 제외)
function slim(state) {
  return {
    _v: VERSION,
    whoTeacher: state.whoTeacher,
    whoStudent: state.whoStudent,
    studentProfile: state.studentProfile,
    teachers: state.teachers,
    students: state.students,
    lessons: (state.lessons || []).map(({ slides, worksheet, ...meta }) => meta),
    subjects: state.subjects,
    sessions: (state.sessions || []).map(({ records, responses, slidesSnapshot, worksheet, _full, ...meta }) => meta),
  };
}

function serialize(state) {
  if (cloudMode) return JSON.stringify(slim(state));
  return JSON.stringify({ ...state, _v: VERSION });
}

function saveNow(state) {
  try {
    localStorage.setItem(KEY, serialize(state));
  } catch (e) {
    // 한도 초과여도 bg를 지우지 않는다(v1 백지 버그). 저장만 생략.
    console.warn("[store] 저장 생략 (localStorage 한도/오류):", e && e.name);
  }
}

let saveTimer = null;

export const store = {
  state: load(),
  listeners: new Set(),
  // 리스너 즉시 호출, 저장은 300ms 디바운스
  set(updater) {
    if (typeof updater === "function") updater(this.state);
    else if (updater) Object.assign(this.state, updater);
    this.save();
    this.notify();
  },
  // 리스너만 호출 (저장 없음) — 다른 탭 병합 등
  notify() {
    this.listeners.forEach(fn => {
      try { fn(this.state); } catch (e) { console.error("[store] listener 오류:", e); }
    });
  },
  // 저장만 예약 (리스너 호출 없음)
  save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveNow(this.state); }, 300);
  },
  // 예약된 저장 즉시 실행
  flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    saveNow(this.state);
  },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  get cloudMode() { return cloudMode; },
  // helpers (v1 호환)
  newId(prefix = "id") { return newId(prefix); },
  newJoinCode() { return newJoinCode(); },
  findTeacherByCode(code) {
    const c = normCode(code);
    if (!c) return null;
    return (this.state.teachers || []).find(t => (t.joinCode || "").toUpperCase() === c) || null;
  },
};

// cloud.js가 initCloud 결과에 따라 호출
export function setCloudMode(on) {
  on = !!on;
  if (on === cloudMode) return;
  cloudMode = on;
  store.save();
}

// 페이지를 떠날 때 대기 중 저장 즉시 반영
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => store.flush());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") store.flush(); });
}

export function newId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36)}`;
}

// 교사 고유 6자리 코드 (0/O/1/I 제외)
const CODE_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newJoinCode() {
  const used = new Set((store.state.teachers || []).map(t => (t.joinCode || "").toUpperCase()).filter(Boolean));
  for (let tries = 0; tries < 100; tries++) {
    let c = "";
    const buf = new Uint32Array(6);
    crypto.getRandomValues(buf);
    for (let i = 0; i < 6; i++) c += CODE_ALPHA[buf[i] % CODE_ALPHA.length];
    if (!used.has(c)) return c;
  }
  return Date.now().toString(36).toUpperCase().slice(-6);
}

// 코드 정규화: 대문자, [A-Z0-9], 6자 (아니면 '')
export function normCode(code) {
  const c = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 6 ? c : "";
}

export function getActiveSession(state = store.state) {
  return (state.sessions || []).find(s => s.status === "live") || null;
}
export function findLesson(id, state = store.state) {
  return (state.lessons || []).find(l => l.id === id) || null;
}
export function findSession(id, state = store.state) {
  return (state.sessions || []).find(s => s.id === id) || null;
}
export function findStudent(id, state = store.state) {
  return (state.students || []).find(s => s.id === id) || null;
}
export function findSubject(id, state = store.state) {
  return id ? (state.subjects || []).find(s => s.id === id) || null : null;
}
export function findTeacher(id, state = store.state) {
  return (state.teachers || []).find(t => t.id === id) || null;
}
export function studentLabel(s) {
  if (!s) return "—";
  return `${s.grade}-${s.classNum}-${s.num} ${s.name}`;
}

// 디버깅용
window.__store = store;
