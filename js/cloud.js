// Supabase 어댑터 v2 (docs/ARCHITECTURE.md §5)
// - 전체 pull 금지: 부팅 시 작은 행만, lesson slides는 열 때만, 세션은 그 세션만 + realtime 증분
// - 모든 쓰기에 last_writer: clientId() → 자기 echo 무시. 세션은 rev 비교.
// - 로컬 모드(Supabase 미설정/실패): store + BroadcastChannel(sync.js, realtime.js)로 동작
// 가정: clientId는 페이지 로드마다 새로 만든다(탭 복제 시 sessionStorage가 복사돼 echo 억제가 꼬이는 것 방지).
// 가정: 세션 객체 `_full`=true 는 스냅샷·records·responses를 불러온 상태. 부팅 meta는 false → 화면은 ensureSession()/cloudFetchSession() 사용.
// 가정: Rec 객체는 제자리 수정(ink가 잡고 있는 참조 유지). 변경 감지용 비열거 속성 rec._v(숫자)를 올린다.
// 가정: responses[slideId] 배열은 변경 때마다 새 배열로 교체(host가 참조 비교로도 감지 가능).
// 가정: whole/group 병합 후 로컬에만 있는 획이 있으면 다시 써서 DB를 수렴시킨다 — 내가 만든 항목이 빠졌으면 0.3~1.3초,
//       남의 항목만 빠졌으면 4~8초(보통 작성자가 먼저 다시 써서 취소됨). 수렴 쓰기는 마감을 늦추지 않는다(스로틀).
// 가정: patchSession의 DB 쓰기는 항상 세션 전체 meta(PATCH_KEYS)를 쓴다(실패 시 백오프 재시도).
// 가정: 세션 구독은 첫 SUBSCRIBED 포함 매번 resync(=cloudFetchSession) 한다.
import { store, setCloudMode, ensureSessionShape, findLesson, findSession, findStudent, findTeacher, newId, newJoinCode, normCode } from "./store.js";
import { sync } from "./sync.js";
import { currentChannel } from "./realtime.js";
import { uploadSlideImage, isDataUrl, removeLessonImages, copySlideImage } from "./storage.js";
import * as ui from "./ui.js";

export const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm";

let supa = null;
let isCloud = false;

const CLIENT_ID = "cli_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export function clientId() { return CLIENT_ID; }
export function cloudEnabled() { return isCloud; }
export function supaClient() { return supa; }

let readyResolve;
export const cloudReady = new Promise(r => { readyResolve = r; });
// 클라이언트 생성 완료(부팅 조회 전). realtime.js·지연 구독이 사용
let clientResolve;
export const clientReady = new Promise(r => { clientResolve = r; });
let initStarted = false;
// initCloud 진행 중이면 클라이언트 생성까지 대기 (부팅 직후 호출돼도 로컬로 잘못 동작하지 않게)
async function ready() {
  if (!isCloud && initStarted && store.cloudMode) await clientReady;
}
function pending() { return !isCloud && initStarted && store.cloudMode; }

// ── 공용 헬퍼 ──
const ms = v => (v ? +new Date(v) : null);
const iso = t => (t ? new Date(t).toISOString() : null);
const nowIso = () => new Date().toISOString();

function toast(msg) {
  try { ui.toast ? ui.toast(msg) : console.warn("[toast]", msg); } catch (_) { console.warn("[toast]", msg); }
}
const toasted = new Set();
function toastOnce(key, msg) {
  if (toasted.has(key)) return;
  toasted.add(key);
  toast(msg);
}

function warn(label, err) {
  if (err) console.warn(`[cloud] ${label} 실패:`, err.message || err, err);
}

// 페이지 숨김/종료 직후의 작은 요청은 keepalive로 보내 탭이 닫혀도 끝까지 가게 (브라우저 한도 64KB 합계)
let hiddenAt = 0, keepaliveBytes = 0;
const KEEPALIVE_MAX = 60 * 1024;
function hideAwareFetch(input, init) {
  const body = init && init.body;
  if (hiddenAt && Date.now() - hiddenAt < 3000 && typeof body === "string") {
    const n = new TextEncoder().encode(body).length;
    if (keepaliveBytes + n < KEEPALIVE_MAX) {
      keepaliveBytes += n;
      return fetch(input, { ...init, keepalive: true }).finally(() => { keepaliveBytes -= n; });
    }
  }
  return fetch(input, init);
}

function upsertById(list, obj) {
  const ex = list.find(x => x.id === obj.id);
  if (!ex) { list.push(obj); return obj; }
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) ex[k] = v;
  return ex;
}

// 1000행 한도 회피. build()는 매번 새 쿼리를 만들어야 한다(정렬 포함 권장)
export async function fetchAll(build, page = 1000) {
  const out = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build().range(from, from + page - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return out;
}

async function sha256(s) {
  const buf = new TextEncoder().encode(s);
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function sha(s) { return sha256(String(s ?? "")); }

// ── 행 ↔ 객체 매핑 (한 곳) ──
const TEACHER_COLS = "id,name,join_code,password_hash";
const STUDENT_COLS = "id,grade,class_num,num,name";
const LESSON_META_COLS = "id,teacher_id,title,created_at,updated_at,slide_count,cover";
const SLIDE_COLS = "id,lesson_id,position,type,title,config,bg_url,bg_path,thumb_url,gs_embed,mode,base_strokes,base_texts";
const SESSION_COLS = "id,lesson_id,teacher_id,title,status,flow,current_slide,groups,activity,rev,started_at,ended_at";
const RECORD_COLS = "id,session_id,slide_id,scope,scope_id,strokes,texts,removed,last_writer,updated_at";
const RESPONSE_COLS = "id,session_id,slide_id,student_id,item_key,payload,score,correct,time_ms,updated_at";
const WS_COLS = "id,lesson_id,position,title,bg_url,bg_path,thumb_url,base_strokes,base_texts"; // 학습지 페이지(005)

function toTeacher(r, withHash = true) {
  const t = { id: r.id, name: r.name, joinCode: r.join_code || null };
  if (withHash) t.passwordHash = r.password_hash || "";
  return t;
}
function toStudent(r) {
  return { id: r.id, grade: r.grade, classNum: r.class_num, num: r.num, name: r.name };
}
function fromStudent(s) {
  return { id: s.id, grade: s.grade, class_num: s.classNum, num: s.num, name: s.name };
}
function toLessonMeta(r) {
  return {
    id: r.id, teacherId: r.teacher_id, title: r.title,
    createdAt: ms(r.created_at), updatedAt: ms(r.updated_at) || ms(r.created_at),
    slideCount: Number(r.slide_count || 0), cover: r.cover || null,
  };
}
export function toSlide(r) {
  const s = {
    id: r.id, type: r.type || "ink", title: r.title ?? null, config: r.config || {},
    bg: r.bg_url || null, bgPath: r.bg_path || null, thumb: r.thumb_url || null,
    mode: r.mode || "none", strokes: r.base_strokes || [], texts: r.base_texts || [],
  };
  if (r.gs_embed) s.gsEmbed = r.gs_embed;
  return s;
}
export function fromSlide(s, lessonId, i) {
  return {
    id: s.id, lesson_id: lessonId, position: i, type: s.type || "ink", title: s.title ?? null, config: s.config || {},
    bg_url: s.bg || null, bg_path: s.bgPath || null, thumb_url: s.thumb || null,
    mode: ["none", "whole", "individual", "group"].includes(s.mode) ? s.mode : "none",
    base_strokes: s.strokes || [], base_texts: s.texts || [],
  };
}
// 스냅샷 slide 형태 보정
function normSlide(s) {
  const o = { type: "ink", title: null, config: {}, ...s };
  o.config ||= {};
  if (o.type === "ink") { o.strokes ||= []; o.texts ||= []; o.mode ||= "none"; o.bg ??= null; o.thumb ??= null; }
  return o;
}
// ── 학습지 페이지(worksheet_pages, 005) ↔ ink 슬라이드 모양 객체. 모드는 늘 '개별' ──
// 가정: 005 마이그레이션 전 DB에서도 앱이 죽지 않게 — 테이블/열이 없으면 플래그를 세우고 학습지 기능만 조용히 건너뛴다.
let wsTableMissing = false; // worksheet_pages 테이블 없음
let snapHasWs = true;       // session_snapshots.worksheet 열 있음
const isMissingRel = (e) => !!e && (e.code === "42P01" || e.code === "PGRST205" || /relation .* does not exist|could not find the table/i.test(e.message || ""));
const isMissingCol = (e) => !!e && (e.code === "42703" || e.code === "PGRST204" || /column .* does not exist|could not find the .* column/i.test(e.message || ""));
function toWsPage(r) {
  return {
    id: r.id, type: "ink", title: r.title ?? null, config: {},
    bg: r.bg_url || null, bgPath: r.bg_path || null, thumb: r.thumb_url || null,
    mode: "individual", strokes: r.base_strokes || [], texts: r.base_texts || [],
  };
}
function fromWsPage(p, lessonId, i) {
  return {
    id: p.id, lesson_id: lessonId, position: i, title: p.title ?? null,
    bg_url: p.bg || null, bg_path: p.bgPath || null, thumb_url: p.thumb || null,
    base_strokes: p.strokes || [], base_texts: p.texts || [],
  };
}
// 수업 자료의 학습지 페이지 → Slide[] | null(못 읽음·테이블 없음 — 호출 쪽은 null을 '모름'으로 두고 저장하지 않는다)
async function fetchWorksheetPages(lessonId) {
  if (!isCloud || wsTableMissing || !lessonId) return null;
  const { data, error } = await supa.from("worksheet_pages").select(WS_COLS).eq("lesson_id", lessonId).order("position", { ascending: true });
  if (error) {
    if (isMissingRel(error)) wsTableMissing = true;
    warn("fetchWorksheetPages", error);
    return null;
  }
  return (data || []).map(toWsPage);
}
// 세션 스냅샷 행(slides + worksheet). worksheet 열이 없는 DB면 slides만
async function fetchSnapRow(sessionId) {
  if (snapHasWs) {
    const r = await supa.from("session_snapshots").select("slides,worksheet").eq("session_id", sessionId).maybeSingle();
    if (!r.error || !isMissingCol(r.error)) return r;
    snapHasWs = false;
  }
  return await supa.from("session_snapshots").select("slides").eq("session_id", sessionId).maybeSingle();
}

function sessionMeta(r) {
  return {
    id: r.id, lessonId: r.lesson_id, teacherId: r.teacher_id, title: r.title,
    status: r.status, flow: r.flow || "teacher", currentSlide: r.current_slide ?? 0,
    rev: Number(r.rev || 0), groups: r.groups || [], activity: r.activity || {},
    startedAt: ms(r.started_at), endedAt: ms(r.ended_at),
  };
}
const PATCH_KEYS = ["currentSlide", "flow", "groups", "activity", "status", "endedAt", "title"];
function sessionPatchRow(p) {
  const row = {};
  if ("currentSlide" in p) row.current_slide = p.currentSlide;
  if ("flow" in p) row.flow = p.flow;
  if ("groups" in p) row.groups = p.groups || [];
  if ("activity" in p) row.activity = p.activity || {};
  if ("status" in p) row.status = p.status;
  if ("endedAt" in p) row.ended_at = iso(p.endedAt);
  if ("title" in p) row.title = p.title;
  return row;
}
export function toResponse(r) {
  return {
    id: r.id, sessionId: r.session_id, slideId: r.slide_id, studentId: r.student_id, itemKey: r.item_key || "",
    payload: r.payload || {}, score: r.score == null ? null : Number(r.score), correct: r.correct ?? null,
    timeMs: r.time_ms ?? null, updatedAt: ms(r.updated_at) || Date.now(),
  };
}
function toRec(r) {
  return { strokes: r.strokes || [], texts: r.texts || [], removed: r.removed || [] };
}

// 키 순서와 무관한 비교 (jsonb는 키를 재정렬해 돌려준다)
function stableStr(v) {
  if (v === undefined) return "undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(x => (x === undefined ? "null" : stableStr(x))).join(",") + "]";
  return "{" + Object.keys(v).filter(k => v[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ":" + stableStr(v[k])).join(",") + "}";
}
function sameVal(a, b) { return a === b || stableStr(a) === stableStr(b); }
// 내용이 같은 값(또는 객체의 하위 값)은 기존 참조를 유지 → host의 JSON 비교가 키 순서 때문에 흔들리지 않게
function keepSame(oldV, newV) {
  if (sameVal(oldV, newV)) return oldV;
  if (oldV && newV && typeof oldV === "object" && typeof newV === "object" && !Array.isArray(oldV) && !Array.isArray(newV)) {
    const out = {};
    for (const k of Object.keys(newV)) out[k] = (k in oldV && sameVal(oldV[k], newV[k])) ? oldV[k] : newV[k];
    return out;
  }
  return newV;
}

// 세션 meta를 store에 병합 (스냅샷·records·responses 보존, rev가 낮으면 meta 무시)
function mergeSessionMeta(meta) {
  let s = findSession(meta.id);
  if (!s) {
    s = ensureSessionShape({ ...meta, _full: false });
    store.state.sessions.push(s);
    return s;
  }
  ensureSessionShape(s);
  const { rev, ...rest } = meta;
  if (rev >= (s.rev || 0)) {
    for (const k of Object.keys(rest)) s[k] = keepSame(s[k], rest[k]);
    s.rev = rev;
  }
  else { s.lessonId ??= meta.lessonId; s.teacherId ??= meta.teacherId; s.startedAt ??= meta.startedAt; }
  return s;
}

function addStudentsToStore(rows) {
  for (const r of rows) if (r && r.id) upsertById(store.state.students, toStudent(r));
}

// ── 초기화 ──
let initPromise = null;
export function initCloud() {
  if (!initPromise) {
    initStarted = true;
    initPromise = doInit().then(ok => { clientResolve(isCloud); readyResolve(ok); return ok; },
      e => { console.warn(e); clientResolve(isCloud); readyResolve(false); return false; });
  }
  return initPromise;
}
async function doInit() {
  try { localStorage.removeItem("hada:lw_sessions"); localStorage.removeItem("hada:lw_records"); } catch (_) {}
  const url = window.HADA_SUPABASE_URL;
  const key = window.HADA_SUPABASE_ANON;
  if (!url || !key || String(url).includes("YOUR_")) { setCloudMode(false); clientResolve(false); return false; }
  try {
    const mod = await import(SUPABASE_JS);
    supa = mod.createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: hideAwareFetch },
      realtime: { params: { eventsPerSecond: 20 } },
    });
    isCloud = true;
    setCloudMode(true);
    clientResolve(true);
  } catch (e) {
    console.warn("[cloud] Supabase 초기화 실패 — 로컬 모드로 동작:", e);
    supa = null; isCloud = false; setCloudMode(false); clientResolve(false);
    return false;
  }
  if (store.state.whoTeacher) {
    try { await cloudBootTeacher(store.state.whoTeacher); } catch (e) { warn("bootTeacher", e); }
  }
  return true;
}

// ── 교사 ──
export async function cloudLoginTeacher(name, password) {
  await ready();
  name = String(name || "").trim();
  if (!name) return { error: "이름을 입력하세요" };
  const hash = await sha(password || "");
  if (!isCloud) {
    const t = store.state.teachers.find(x => x.name === name);
    if (t) {
      const ok = t.passwordHash ? t.passwordHash === hash : (t.password == null || t.password === password);
      if (!ok) return { error: "비밀번호가 맞지 않아요" };
      if (!t.passwordHash) { t.passwordHash = hash; delete t.password; }
      t.joinCode ||= newJoinCode();
      store.set(s => s);
      return { teacher: t };
    }
    const nt = { id: newId("t"), name, passwordHash: hash, joinCode: newJoinCode() };
    store.set(s => { s.teachers.push(nt); });
    return { teacher: nt };
  }
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const { data: row, error } = await supa.from("teachers").select(TEACHER_COLS).eq("name", name).maybeSingle();
      if (error) throw error;
      if (row) {
        if (row.password_hash && row.password_hash !== hash) return { error: "비밀번호가 맞지 않아요" };
        const patch = {};
        if (!row.password_hash) patch.password_hash = hash;
        if (!row.join_code) patch.join_code = newJoinCode();
        if (Object.keys(patch).length) {
          const { error: e2 } = await supa.from("teachers").update(patch).eq("id", row.id);
          if (e2 && e2.code === "23505") continue; // 코드 충돌 → 재시도
          if (e2) throw e2;
          Object.assign(row, patch);
        }
        const t = upsertById(store.state.teachers, toTeacher(row));
        store.set(s => s);
        return { teacher: t };
      }
      // 신규 생성
      const nt = { id: newId("t"), name, password_hash: hash, join_code: newJoinCode() };
      const { error: e3 } = await supa.from("teachers").insert(nt);
      if (!e3) {
        const t = upsertById(store.state.teachers, toTeacher(nt));
        store.set(s => s);
        return { teacher: t };
      }
      if (e3.code !== "23505") throw e3;
      // 이름 충돌(동시 생성) 또는 코드 충돌 → 다시 조회/재시도
    }
    return { error: "잠시 후 다시 시도해 주세요" };
  } catch (e) {
    warn("loginTeacher", e);
    return { error: "서버에 연결하지 못했어요" };
  }
}

export async function cloudFindTeacherByCode(code) {
  await ready();
  const c = normCode(code);
  if (!c) return null;
  if (!isCloud) return store.findTeacherByCode(c);
  const { data, error } = await supa.from("teachers").select("id,name,join_code").eq("join_code", c).maybeSingle();
  if (error) { warn("findTeacherByCode", error); throw error; }
  if (!data) return null;
  const t = upsertById(store.state.teachers, toTeacher(data, false));
  store.save();
  return t;
}

export async function cloudBootTeacher(teacherId) {
  if (!teacherId) return null;
  if (!isCloud) return store.state.teachers.find(t => t.id === teacherId) || null;
  const { data: trow, error: te } = await supa.from("teachers").select(TEACHER_COLS).eq("id", teacherId).maybeSingle();
  if (te) { warn("boot teachers", te); return null; }
  if (!trow) { store.set(s => { s.whoTeacher = null; }); return null; }
  const teacher = upsertById(store.state.teachers, toTeacher(trow));

  const [lr, sr] = await Promise.all([
    supa.from("lesson_meta").select(LESSON_META_COLS).eq("teacher_id", teacherId).order("updated_at", { ascending: false }),
    supa.from("sessions").select(SESSION_COLS).eq("teacher_id", teacherId).order("started_at", { ascending: false }).limit(200),
  ]);
  // 실패한 단계는 건너뛴다(빈 결과로 덮지 않음)
  if (lr.error) warn("boot lessons", lr.error);
  else {
    const metas = (lr.data || []).map(toLessonMeta);
    const keep = store.state.lessons.filter(l => l.teacherId !== teacherId);
    const mine = metas.map(m => {
      const ex = findLesson(m.id);
      if (ex) {
        // 편집 중(저장 대기)인 로컬 자료가 더 최신이면 제목은 유지
        const localNewer = (ex.updatedAt || 0) > (m.updatedAt || 0);
        Object.assign(ex, localNewer ? { ...m, title: ex.title, updatedAt: ex.updatedAt } : m);
        if (Array.isArray(ex.slides)) ex.slideCount = ex.slides.length;
        return ex;
      }
      return { ...m, slides: null };
    });
    store.state.lessons = [...mine, ...keep];
  }
  let sessionIds = [];
  if (sr.error) warn("boot sessions", sr.error);
  else {
    const rows = sr.data || [];
    const got = new Set(rows.map(r => r.id));
    rows.forEach(r => mergeSessionMeta(sessionMeta(r)));
    if (rows.length < 200) {
      store.state.sessions = store.state.sessions.filter(s => s.teacherId !== teacherId || got.has(s.id));
    }
    sessionIds = rows.map(r => r.id);
  }
  // 참여자 (200개씩)
  for (let i = 0; i < sessionIds.length; i += 200) {
    const chunk = sessionIds.slice(i, i + 200);
    try {
      const rows = await fetchAll(() => supa.from("session_participants")
        .select(`session_id,student_id,students(${STUDENT_COLS})`).in("session_id", chunk)
        .order("session_id").order("student_id"));
      const by = new Map();
      for (const r of rows) {
        if (!by.has(r.session_id)) by.set(r.session_id, []);
        by.get(r.session_id).push(r.student_id);
        if (r.students) addStudentsToStore([r.students]);
      }
      for (const id of chunk) {
        const s = findSession(id);
        if (!s) continue;
        const got = by.get(id) || [];
        // _full 세션은 cloudFetchSession·realtime이 관리 → 늦게 온 부팅 결과로 줄이지 않고 합집합
        if (s._full) { const add = got.filter(x => !s.participants.includes(x)); if (add.length) s.participants = [...s.participants, ...add]; }
        else s.participants = got;
      }
    } catch (e) { warn("boot participants", e); }
  }
  store.set(s => s);
  return teacher;
}

// ── 학생 ──
export async function cloudJoinStudent({ grade, classNum, num, name }) {
  await ready();
  const g = parseInt(grade, 10), c = parseInt(classNum, 10), n = parseInt(num, 10);
  const nm = String(name || "").trim();
  if (!isCloud) {
    let st = store.state.students.find(x => x.grade === g && x.classNum === c && x.num === n && x.name === nm);
    if (!st) { st = { id: newId("stu"), grade: g, classNum: c, num: n, name: nm }; store.state.students.push(st); }
    store.set(s => s);
    return st;
  }
  const prof = store.state.studentProfile;
  const candId = prof && prof.grade === g && prof.classNum === c && prof.num === n && prof.name === nm && prof.id ? prof.id : newId("stu");
  const body = { id: candId, grade: g, class_num: c, num: n, name: nm };
  // 기존 행이 있으면 id를 바꾸지 않도록 DO NOTHING 후 조회 → 서버 id 채택
  const { data, error } = await supa.from("students")
    .upsert(body, { onConflict: "grade,class_num,num,name", ignoreDuplicates: true }).select(STUDENT_COLS);
  if (error) { warn("joinStudent", error); throw error; }
  let row = data && data[0];
  if (!row) {
    const r2 = await supa.from("students").select(STUDENT_COLS)
      .eq("grade", g).eq("class_num", c).eq("num", n).eq("name", nm).maybeSingle();
    if (r2.error || !r2.data) { warn("joinStudent select", r2.error); throw r2.error || new Error("학생 정보를 찾지 못했어요"); }
    row = r2.data;
  }
  const st = upsertById(store.state.students, toStudent(row));
  store.set(s => s);
  return st;
}

// ── 수업 자료 ──
const upLimit = (() => {
  let active = 0; const q = [];
  const next = () => {
    if (active >= 3 || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
})();

// data: URL 배경을 Storage로 옮김(동시 ≤3). persist=true면 slides 행도 update
async function migrateDataUrls(lessonId, slides, persist) {
  const targets = slides.filter(s => isDataUrl(s.bg));
  if (!targets.length || !isCloud) return 0;
  await Promise.all(targets.map(s => upLimit(async () => {
    try {
      const img = await uploadSlideImage(lessonId, s.id, s.bg);
      s.bg = img.url; s.bgPath = img.path; s.thumb = img.thumb;
      if (persist) {
        const { error } = await supa.from("slides").update({ bg_url: img.url, bg_path: img.path, thumb_url: img.thumb }).eq("id", s.id);
        warn("migrate slide update", error);
      }
    } catch (e) { warn("migrate slide upload", e); }
  })));
  return targets.length;
}

function setLessonSlides(lesson, slides) {
  lesson.slides = slides;
  lesson.slideCount = slides.length;
  lesson.cover = slides[0] ? (slides[0].thumb || (isDataUrl(slides[0].bg) ? null : slides[0].bg) || null) : null;
}

export function cloudFetchLessonSlides(lessonId, onProgress) {
  return fetchLessonSlides(lessonId, onProgress, true);
}
// 학습지 페이지가 아직 안 불러와졌으면(lesson.worksheet === null) 읽어서 채움 → Slide[] | null(못 읽음)
export async function cloudEnsureWorksheet(lessonId) {
  await ready();
  const l = findLesson(lessonId);
  if (!l) return null;
  if (Array.isArray(l.worksheet)) return l.worksheet;
  if (!isCloud) { l.worksheet = []; return l.worksheet; }
  const pages = await fetchWorksheetPages(lessonId);
  if (!pages) return null;
  const cur = findLesson(lessonId);
  if (cur) { cur.worksheet = pages; store.save(); }
  return pages;
}
// persist=false: base64 이전 결과를 slides 행에 쓰지 않음(학생 기기의 스냅샷 대체 조회용)
async function fetchLessonSlides(lessonId, onProgress, persist) {
  await ready();
  const lesson = findLesson(lessonId);
  const report = (d, t) => { try { onProgress && onProgress(d, t); } catch (_) {} };
  if (!isCloud) {
    const slides = (lesson && Array.isArray(lesson.slides)) ? lesson.slides : [];
    if (lesson && !Array.isArray(lesson.worksheet)) lesson.worksheet = [];
    if (lesson && !Array.isArray(lesson.slides)) { lesson.slides = slides; store.set(s => s); }
    report(slides.length, slides.length);
    return slides;
  }
  const rows = [];
  let total = null;
  let page = 10;
  for (let from = 0; ;) {
    const { data, error, count } = await supa.from("slides").select(SLIDE_COLS, from === 0 ? { count: "exact" } : undefined)
      .eq("lesson_id", lessonId).order("position", { ascending: true }).range(from, from + page - 1);
    if (error) {
      // 큰 행(레거시 base64)으로 시간 초과 → 페이지를 줄여 재시도
      if (page > 1) { page = Math.max(1, Math.floor(page / 3)); continue; }
      warn("fetchLessonSlides", error);
      throw new Error("슬라이드를 불러오지 못했어요");
    }
    if (from === 0 && count != null) total = count;
    rows.push(...(data || []));
    from += (data || []).length;
    report(rows.length, total ?? rows.length);
    if (!data || data.length < page) break;
  }
  const slides = rows.map(toSlide);
  if (persist) {
    await migrateDataUrls(lessonId, slides, true);
    // 학습지 페이지도 함께(실패하면 null로 두어 저장이 DB 페이지를 지우지 않게)
    const pages = await fetchWorksheetPages(lessonId);
    const l = findLesson(lessonId);
    if (l) {
      setLessonSlides(l, slides);
      if (pages) l.worksheet = pages;
      store.set(s => s);
    }
  }
  return slides;
}

export async function cloudCreateLesson(lesson) {
  await ready();
  const now = Date.now();
  lesson.createdAt ||= now;
  lesson.updatedAt = now;
  if (!Array.isArray(lesson.slides)) lesson.slides = [];
  if (!Array.isArray(lesson.worksheet)) lesson.worksheet = []; // 새 자료: 학습지 없음(복제는 채워서 넘어옴)
  if (!isCloud) {
    setLessonSlides(lesson, lesson.slides);
    store.set(s => { upsertById(s.lessons, lesson); });
    return lesson;
  }
  try {
    await migrateDataUrls(lesson.id, lesson.slides, false);
    const { error } = await supa.from("lessons").insert({
      id: lesson.id, teacher_id: lesson.teacherId, title: lesson.title, created_at: iso(lesson.createdAt), updated_at: iso(now),
    });
    if (error) throw error;
    if (lesson.slides.length) {
      const { error: e2 } = await supa.from("slides").upsert(lesson.slides.map((s, i) => fromSlide(s, lesson.id, i)), { onConflict: "id" });
      if (e2) throw e2;
    }
    if (lesson.worksheet.length && !wsTableMissing) {
      // 학습지는 자료 생성을 막지 않는다(실패 시 경고만)
      const { error: e3 } = await supa.from("worksheet_pages").upsert(lesson.worksheet.map((p, i) => fromWsPage(p, lesson.id, i)), { onConflict: "id" });
      if (e3) { if (isMissingRel(e3)) wsTableMissing = true; warn("createLesson worksheet", e3); }
    }
    setLessonSlides(lesson, lesson.slides);
    const l = findLesson(lesson.id);
    if (l && l !== lesson) Object.assign(l, lesson);
    store.set(s => { if (!l) s.lessons.unshift(lesson); });
    return l || lesson;
  } catch (e) {
    warn("createLesson", e);
    return { error: "수업 자료를 만들지 못했어요" };
  }
}

// lesson별 직렬 큐. 대기 중 호출은 최신 인자로 합침
const saveQ = new Map();
const deletedLessons = new Set(); // 삭제 중·삭제된 자료 → 대기 중 저장이 행을 되살리지 않게
export function cloudSaveLesson(lesson) {
  if (deletedLessons.has(lesson.id)) return Promise.resolve({ ok: true, deleted: true });
  let q = saveQ.get(lesson.id);
  if (!q) { q = { busy: false, next: null, wait: null, current: null }; saveQ.set(lesson.id, q); }
  if (q.busy) {
    q.next = lesson;
    if (!q.wait) { let r; const p = new Promise(x => { r = x; }); q.wait = { p, r }; }
    return q.wait.p;
  }
  return runSave(q, lesson);
}
async function runSave(q, lesson) {
  q.busy = true;
  let res;
  const p = saveLessonNow(lesson);
  q.current = p.catch(() => {});
  try { res = await p; } catch (e) { warn("saveLesson", e); res = { error: "저장 실패" }; }
  q.busy = false;
  if (q.next) {
    const n = q.next, w = q.wait;
    q.next = null; q.wait = null;
    runSave(q, n).then(w.r);
  }
  return res;
}
async function saveLessonNow(lesson) {
  await ready();
  const gone = () => deletedLessons.has(lesson.id);
  if (gone()) return { ok: true, deleted: true };
  lesson.updatedAt = Date.now();
  const slides = Array.isArray(lesson.slides) ? lesson.slides : null;
  if (slides) setLessonSlides(lesson, slides);
  store.save(); // 편집 화면 재렌더 방지: 리스너 호출 없음
  if (!isCloud) return { ok: true };
  // ① lessons (FK 때문에 먼저 upsert)
  const { error: e0 } = await supa.from("lessons").upsert({
    id: lesson.id, teacher_id: lesson.teacherId, title: lesson.title, updated_at: iso(lesson.updatedAt),
  }, { onConflict: "id" });
  if (e0) { warn("saveLesson lessons", e0); return { error: "저장 실패" }; }
  if (!slides) return { ok: true }; // 슬라이드를 아직 안 불러왔으면 제목만
  await migrateDataUrls(lesson.id, slides, false);
  if (gone()) return { ok: true, deleted: true };
  // ② 빠진 슬라이드 먼저 삭제 — 남아 있으면 그 position이 upsert와 unique(lesson_id, position) 충돌
  // 가정: 명세(§5.1)의 ①upsert→②delete 순서를 바꿈. 중간 슬라이드 삭제 시 ①이 실패하기 때문.
  let del = supa.from("slides").delete().eq("lesson_id", lesson.id);
  if (slides.length) del = del.not("id", "in", `(${slides.map(s => `"${s.id}"`).join(",")})`);
  const { error: e2 } = await del;
  if (e2) { warn("saveLesson delete", e2); return { error: "저장 실패" }; }
  // ③ slides upsert (순서 교환은 deferrable unique라 한 번에 가능)
  if (slides.length) {
    const { error: e1 } = await supa.from("slides").upsert(slides.map((s, i) => fromSlide(s, lesson.id, i)), { onConflict: "id" });
    if (e1) { warn("saveLesson slides", e1); return { error: "저장 실패" }; }
  }
  // ④ 학습지 페이지 — 불러온 적이 있을 때만(null = 모름 → 건드리지 않음). 삭제 → upsert 순서는 slides와 같다
  const ws = Array.isArray(lesson.worksheet) ? lesson.worksheet : null;
  if (ws && !wsTableMissing) {
    if (gone()) return { ok: true, deleted: true };
    let delW = supa.from("worksheet_pages").delete().eq("lesson_id", lesson.id);
    if (ws.length) delW = delW.not("id", "in", `(${ws.map(p => `"${p.id}"`).join(",")})`);
    const { error: e3 } = await delW;
    if (e3) {
      if (isMissingRel(e3)) { wsTableMissing = true; return { ok: true }; }
      warn("saveLesson worksheet delete", e3); return { error: "저장 실패" };
    }
    if (ws.length) {
      const { error: e4 } = await supa.from("worksheet_pages").upsert(ws.map((p, i) => fromWsPage(p, lesson.id, i)), { onConflict: "id" });
      if (e4) { warn("saveLesson worksheet", e4); return { error: "저장 실패" }; }
    }
  }
  return { ok: true };
}

export async function cloudDeleteLesson(lessonId) {
  await ready();
  // 대기 중 저장은 건너뛰게 표시하고, 진행 중 저장이 끝난 뒤 삭제(늦은 upsert가 행을 되살리지 않게)
  deletedLessons.add(lessonId);
  const q = saveQ.get(lessonId);
  if (q) {
    q.next = null;
    if (q.wait) { q.wait.r({ ok: true, deleted: true }); q.wait = null; }
    for (let i = 0; q.busy && i < 20; i++) await q.current;
  }
  if (isCloud) {
    const { error } = await supa.from("lessons").delete().eq("id", lessonId);
    if (error) { deletedLessons.delete(lessonId); warn("deleteLesson", error); return { error: "삭제하지 못했어요" }; }
    removeLessonImages(lessonId); // best-effort, 기다리지 않음
  }
  saveQ.delete(lessonId);
  store.set(s => {
    s.lessons = s.lessons.filter(l => l.id !== lessonId);
    s.sessions = s.sessions.filter(x => x.lessonId !== lessonId); // DB cascade와 일치
  });
  return { ok: true };
}

export async function cloudDuplicateLesson(lessonId) {
  const src = findLesson(lessonId);
  if (!src) return { error: "수업 자료를 찾지 못했어요" };
  let slides = src.slides;
  if (!Array.isArray(slides)) {
    try { slides = await cloudFetchLessonSlides(lessonId); } catch (e) { return { error: e.message }; }
  }
  // 학습지도 함께 복제(아직 안 불러왔으면 읽음, 못 읽으면 없는 것으로)
  let ws = Array.isArray(src.worksheet) ? src.worksheet : null;
  if (!ws) {
    ws = isCloud ? await fetchWorksheetPages(lessonId) : [];
    if (ws) { const l = findLesson(lessonId); if (l) l.worksheet = ws; }
  }
  const nid = newId("lesson");
  const copy = structuredClone(slides).map(s => ({ ...s, id: newId("slide") }));
  const wsCopy = structuredClone(ws || []).map(p => ({ ...p, id: newId("slide") }));
  if (isCloud) {
    await Promise.all([...copy, ...wsCopy].map(s => upLimit(async () => {
      if (!s.bgPath) return;
      const img = await copySlideImage(s.bgPath, nid, s.id);
      if (img) { s.bg = img.url; s.bgPath = img.path; s.thumb = img.thumb; }
      else s.bgPath = null; // 복사 실패 시 URL만 공유(원본 삭제 시 함께 사라질 수 있음)
    })));
    // 문제 그림(config 속 image — 문제별·팝업 상호작용 속까지, v2.9)도 새 자료 폴더로
    await Promise.all(copy.map(s => upLimit(() => copyConfigImages(s.config, nid, s.id))));
  }
  const lesson = { id: nid, teacherId: src.teacherId, title: `${src.title} (복사본)`, createdAt: Date.now(), updatedAt: Date.now(), slides: copy, worksheet: wsCopy };
  const r = await cloudCreateLesson(lesson);
  return r;
}

// config 안의 모든 image({ url, path, thumb })를 lessonId 폴더로 복사해 제자리에서 바꾼다. 실패하면 path만 비움(URL 공유)
async function copyConfigImages(config, lessonId, slideId) {
  const refs = [];
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    for (const [k, v] of Object.entries(o)) {
      if (k === "image" && v && typeof v === "object" && v.path) refs.push(v);
      else walk(v);
    }
  };
  walk(config);
  for (const img of refs) {
    let c = null;
    try { c = await copySlideImage(img.path, lessonId, slideId); } catch (_) { c = null; }
    if (c) { img.url = c.url; img.path = c.path; img.thumb = c.thumb; } else img.path = null;
  }
}

// ── 세션 ──
const snapFallback = new Set(); // 스냅샷 대신 수업 자료 slides로 채운 세션 id

export async function cloudStartSession({ lesson, teacher, title }) {
  await ready();
  try {
    if (!lesson) return { error: "수업 자료를 찾지 못했어요" };
    if (!Array.isArray(lesson.slides)) {
      try { await cloudFetchLessonSlides(lesson.id); } catch (e) { return { error: "슬라이드를 불러오지 못했어요" }; }
      lesson = findLesson(lesson.id) || lesson;
    }
    const slides = lesson.slides || [];
    if (!slides.length) return { error: "슬라이드를 먼저 추가하세요" };
    await migrateDataUrls(lesson.id, slides, true);
    const snapshot = structuredClone(slides).map(normSlide);
    // 학습지 스냅샷(있으면) — 아직 안 불러왔으면 지금 읽는다. 못 읽으면 학습지 없는 수업으로 시작
    let ws = Array.isArray(lesson.worksheet) ? lesson.worksheet : null;
    if (!ws && isCloud) { ws = await fetchWorksheetPages(lesson.id); if (ws) { const l = findLesson(lesson.id); if (l) l.worksheet = ws; } }
    const wsSnap = structuredClone(ws || []).map(p => ({ ...normSlide(p), mode: "individual" }));
    const teacherId = teacher?.id || lesson.teacherId;
    const now = Date.now();
    // 기존 LIVE 정리
    const others = store.state.sessions.filter(s => s.teacherId === teacherId && s.status === "live");
    if (isCloud) {
      const { error } = await supa.from("sessions").update({ status: "stopped", ended_at: iso(now), rev: now, last_writer: CLIENT_ID })
        .eq("teacher_id", teacherId).eq("status", "live");
      warn("stop other live", error);
    }
    others.forEach(s => { s.status = "stopped"; s.endedAt = now; s.rev = Math.max(s.rev + 1, now); });
    const session = ensureSessionShape({
      id: newId("ses"), lessonId: lesson.id, teacherId, title: (String(title || "").trim() || lesson.title).slice(0, 60),
      status: "live", flow: "teacher", currentSlide: 0, rev: now, groups: [], activity: {},
      startedAt: now, endedAt: null, participants: [], slidesSnapshot: snapshot, worksheet: wsSnap,
      records: { __whole: {}, __groups: {} }, responses: {}, _full: true,
    });
    if (isCloud) {
      // 가정: status check 제약('live','completed','stopped') 때문에 'starting' 대신 'stopped'로 넣고,
      //       스냅샷 저장 후 'live'로 바꾼다 → 학생 자동 입장(watchTeacherLive)이 스냅샷 없는 세션을 보지 않음.
      const { error: e1 } = await supa.from("sessions").insert({
        id: session.id, lesson_id: lesson.id, teacher_id: teacherId, title: session.title, status: "stopped", flow: "teacher",
        current_slide: 0, groups: [], activity: {}, rev: now - 1, slides_snapshot: [], started_at: iso(now), ended_at: null,
        last_writer: CLIENT_ID,
      });
      if (e1) { warn("startSession insert", e1); return { error: "수업을 시작하지 못했어요" }; }
      const fail = async (label, err) => {
        warn(label, err);
        try { await supa.from("sessions").delete().eq("id", session.id); } catch (_) {}
        return { error: "수업을 시작하지 못했어요" };
      };
      let ins = snapHasWs ? await supa.from("session_snapshots").insert({ session_id: session.id, slides: snapshot, worksheet: wsSnap }) : null;
      if (!ins || (ins.error && isMissingCol(ins.error))) {
        snapHasWs = false; // worksheet 열이 없는 DB(005 전) → 슬라이드만
        ins = await supa.from("session_snapshots").insert({ session_id: session.id, slides: snapshot });
      }
      if (ins.error) return await fail("startSession snapshot", ins.error);
      const { error: e3 } = await supa.from("sessions").update({ status: "live", rev: now, last_writer: CLIENT_ID }).eq("id", session.id);
      if (e3) return await fail("startSession live", e3);
    }
    store.set(s => { s.sessions.unshift(session); });
    cloudEnsureReviewCode(session); // 복습 코드는 기다리지 않고 미리 만들어 둠(실패해도 수업은 진행)
    if (!isCloud) {
      // 다른 탭이 300ms 디바운스 저장을 기다리지 않고 바로 받도록 세션 전체를 실어 보냄
      let copy = null;
      try { copy = structuredClone(session); } catch (_) {}
      sync.emit({ type: "session:new", sessionId: session.id, session: copy, from: CLIENT_ID });
    }
    return session;
  } catch (e) {
    warn("startSession", e);
    return { error: "수업을 시작하지 못했어요" };
  }
}

function meStudentId() {
  const w = store.state.whoStudent;
  return w && typeof w === "object" ? w.id : w;
}

export async function cloudFetchLiveSession(teacherId, { forStudentId } = {}) {
  await ready();
  if (!teacherId) return null;
  const sid = forStudentId ?? meStudentId();
  if (!isCloud) {
    return store.state.sessions.filter(s => s.teacherId === teacherId && s.status === "live")
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] || null;
  }
  const { data, error } = await supa.from("sessions").select("id").eq("teacher_id", teacherId).eq("status", "live")
    .order("started_at", { ascending: false }).limit(1);
  if (error) { warn("fetchLiveSession", error); throw error; }
  if (!data || !data.length) return null;
  return await cloudFetchSession(data[0].id, { forStudentId: sid || undefined });
}

function myGroupId(session, studentId) {
  if (!studentId) return null;
  const g = (session.groups || []).find(g => (g.memberIds || []).includes(studentId));
  return g ? g.id : null;
}

export async function cloudFetchSession(sessionId, { forStudentId } = {}) {
  await ready();
  if (!sessionId) return null;
  if (!isCloud) {
    const s = findSession(sessionId);
    if (s) { ensureSessionShape(s); s._full = true; }
    return s || null;
  }
  const fetchStart = Date.now();
  try {
    const { data: row, error } = await supa.from("sessions").select(SESSION_COLS).eq("id", sessionId).maybeSingle();
    if (error) throw error;
    if (!row) return null;
    const meta = sessionMeta(row);
    const ex = findSession(sessionId);
    // 수업 중 슬라이드 추가로 스냅샷 버전(activity.__snap)이 바뀌었으면 다시 읽는다
    const verChanged = !!ex && snapVerOf(meta.activity) !== (ex._snapVer || 0);
    const needSnap = !ex || !(ex.slidesSnapshot && ex.slidesSnapshot.length) || !Array.isArray(ex.worksheet) || snapFallback.has(sessionId) || verChanged;
    // 학생이면 내 scope만
    const scopeIds = forStudentId ? [forStudentId, sessionId, myGroupId(meta, forStudentId)].filter(Boolean) : null;
    const [snapR, parts, recs, resps] = await Promise.all([
      needSnap ? fetchSnapRow(sessionId) : Promise.resolve({ data: null }),
      fetchAll(() => supa.from("session_participants").select(`student_id,joined_at,students(${STUDENT_COLS})`)
        .eq("session_id", sessionId).order("student_id")),
      fetchAll(() => {
        let q = supa.from("slide_records").select(RECORD_COLS).eq("session_id", sessionId);
        if (scopeIds) q = q.in("scope_id", scopeIds);
        return q.order("id");
      }),
      fetchAll(() => supa.from("responses").select(RESPONSE_COLS).eq("session_id", sessionId).order("id")),
    ]);
    // 스냅샷: session_snapshots → 레거시 slides_snapshot → lesson slides
    let snapshot = null, fromFallback = false, snapRow = null;
    if (needSnap) {
      if (snapR.error) warn("fetch snapshot", snapR.error);
      const snapOf = r => (r && r.data && Array.isArray(r.data.slides) ? r.data.slides : []);
      snapRow = snapR && snapR.data ? snapR.data : null;
      snapshot = snapOf(snapR);
      // 막 시작한 세션: 스냅샷 insert가 아직 안 끝났을 수 있음 → 잠깐 다시 읽기
      for (let i = 0; !snapshot.length && meta.startedAt && Date.now() - meta.startedAt < 15000 && i < 3; i++) {
        await new Promise(r => setTimeout(r, 500));
        const r2 = await fetchSnapRow(sessionId);
        if (r2 && r2.data) snapRow = r2.data;
        snapshot = snapOf(r2);
      }
      if (!snapshot.length) {
        const { data: legacy } = await supa.from("sessions").select("slides_snapshot").eq("id", sessionId).maybeSingle();
        snapshot = legacy && Array.isArray(legacy.slides_snapshot) ? legacy.slides_snapshot : [];
      }
      if (!snapshot.length && meta.lessonId) {
        // 최후 수단: 수업 자료 slides. 교사 본인만 base64 이전 결과를 slides 행에 기록
        const owner = store.state.whoTeacher && store.state.whoTeacher === meta.teacherId;
        try {
          snapshot = structuredClone(await fetchLessonSlides(meta.lessonId, null, !!owner));
          fromFallback = snapshot.length > 0;
        } catch (e) { warn("fallback lesson slides", e); }
      }
      snapshot = snapshot.map(normSlide);
    }
    // 반영 (in-place)
    const s = mergeSessionMeta(meta);
    if (snapshot && snapshot.length && (!s.slidesSnapshot || !s.slidesSnapshot.length || snapFallback.has(sessionId) || verChanged)) {
      s.slidesSnapshot = snapshot;
      setSnapVer(s, snapVerOf(meta.activity)); // 행을 먼저 읽고 스냅샷을 읽었으므로 스냅샷은 이 버전 이상
      // 대체 스냅샷이면 다음 조회 때 진짜 스냅샷을 다시 시도
      if (fromFallback) snapFallback.add(sessionId); else snapFallback.delete(sessionId);
    }
    // 학습지 스냅샷: 행을 읽었을 때(또는 아직 없을 때)만 — 읽기 실패로 있던 학습지를 비우지 않게
    if (needSnap && (snapRow || !Array.isArray(s.worksheet))) {
      s.worksheet = (snapRow && Array.isArray(snapRow.worksheet) ? snapRow.worksheet : []).map(p => ({ ...normSlide(p), mode: "individual" }));
    }
    addStudentsToStore(parts.map(p => p.students).filter(Boolean));
    // 조회 중 realtime으로 들어온 참여자를 잃지 않게 합집합(참여자 삭제는 앱에서 하지 않음)
    const fetchedIds = parts.map(p => p.student_id);
    s.participants = [...fetchedIds, ...(s.participants || []).filter(x => !fetchedIds.includes(x))];
    for (const r of recs) applyRecordRow(s, r, { fromFetch: true, fetchStart });
    // responses: 서버 목록 + 아직 서버 id가 없는 로컬 임시(음수 id)
    const grouped = {};
    for (const r of resps) (grouped[r.slide_id] ||= []).push(toResponse(r));
    for (const [slideId, list] of Object.entries(s.responses || {})) {
      const pend = (list || []).filter(x => typeof x.id === "number" && x.id < 0 &&
        !(grouped[slideId] || []).some(y => y.studentId === x.studentId && y.itemKey === x.itemKey));
      if (pend.length) grouped[slideId] = [...(grouped[slideId] || []), ...pend];
    }
    s.responses = grouped;
    s._full = true;
    store.set(st => st);
    return s;
  } catch (e) {
    warn("fetchSession", e);
    return findSession(sessionId) && findSession(sessionId)._full ? findSession(sessionId) : null;
  }
}

// ── 수업 중 슬라이드 추가 (스냅샷 버전) ──
// 가정: 스냅샷은 시작 후 불변이 원칙이지만 수업 중 '상호작용 추가'는 예외 — 슬라이드를 끼워 넣고 activity.__snap(버전, ms)을 올린다.
//       activity의 다른 키는 슬라이드 id라 겹치지 않는다. 버전은 세션 객체의 비열거 속성 _snapVer(저장·복사 안 됨).
// 가정: 교사는 스냅샷 DB 저장을 기다린 뒤 { activity(__snap), currentSlide } 패치 → 받는 쪽은 버전이 다르면 스냅샷을 다시 읽고 나서 패치 적용.
//       다시 읽기가 실패해도 패치는 적용한다(다음 이벤트·재연결 resync 때 다시 시도).
// 가정: 로컬 모드는 DB 대신 sync 'session:snapshot' 메시지로 받는다(패치와 채널이 달라 순서가 바뀔 수 있어 최대 3초 기다림).
const snapVerOf = (act) => Number((act && act.__snap) || 0);
function setSnapVer(s, v) {
  Object.defineProperty(s, "_snapVer", { value: v, writable: true, configurable: true, enumerable: false });
}
function needSnapshot(s, act) {
  const v = snapVerOf(act);
  return v > 0 && v !== (s._snapVer || 0) && !!(s.slidesSnapshot && s.slidesSnapshot.length);
}
const snapLoads = new Map();   // sessionId → Promise
const localSnaps = new Map();  // 로컬 모드: sessionId → { ver, slides }
const localSnapWaiters = new Map(); // sessionId → [resolve]
function refreshSnapshot(s, ver) {
  if (snapLoads.has(s.id)) return snapLoads.get(s.id);
  const p = (async () => {
    let slides = null;
    if (isCloud) {
      const { data, error } = await supa.from("session_snapshots").select("slides").eq("session_id", s.id).maybeSingle();
      if (error) throw error;
      slides = data && Array.isArray(data.slides) ? data.slides : null;
    } else {
      const hit = localSnaps.get(s.id);
      slides = hit && hit.ver >= ver ? hit.slides : await new Promise(res => {
        const list = localSnapWaiters.get(s.id) || [];
        list.push(res);
        localSnapWaiters.set(s.id, list);
        setTimeout(() => res(null), 3000);
      });
    }
    if (slides && slides.length) {
      s.slidesSnapshot = slides.map(normSlide);
      setSnapVer(s, ver);
    }
  })().catch(e => warn("refreshSnapshot", e)).finally(() => snapLoads.delete(s.id));
  snapLoads.set(s.id, p);
  return p;
}
function applyLocalSnapshot(msg) {
  if (!msg || !msg.sessionId || !Array.isArray(msg.slides)) return;
  localSnaps.set(msg.sessionId, { ver: Number(msg.ver || 0), slides: msg.slides });
  const waiters = localSnapWaiters.get(msg.sessionId) || [];
  localSnapWaiters.delete(msg.sessionId);
  if (waiters.length) { waiters.forEach(r => r(msg.slides)); return; } // 기다리던 패치가 반영
  const s = findSession(msg.sessionId);
  if (!s || (s._snapVer || 0) >= Number(msg.ver || 0)) return;
  s.slidesSnapshot = msg.slides.map(normSlide);
  setSnapVer(s, Number(msg.ver || 0));
  store.set(st => st);
}

// 교사: 진행 중인 수업에 슬라이드를 끼워 넣고 그 슬라이드로 이동 → { index } | { error }
export async function cloudInsertSessionSlide(session, slide, index) {
  await ready();
  const s = findSession(session && session.id) || session;
  if (!s || !slide) return { error: "슬라이드를 추가하지 못했어요" };
  const list = (s.slidesSnapshot || []).slice();
  const at = Math.max(0, Math.min(list.length, index ?? list.length));
  list.splice(at, 0, normSlide(structuredClone(slide)));
  if (isCloud) {
    const { error } = await supa.from("session_snapshots").upsert({ session_id: s.id, slides: list }, { onConflict: "session_id" });
    if (error) { warn("insertSessionSlide", error); return { error: "슬라이드를 추가하지 못했어요" }; }
  }
  const ver = Math.max(Date.now(), snapVerOf(s.activity) + 1);
  s.slidesSnapshot = list;
  setSnapVer(s, ver);
  if (!isCloud) sync.emit({ type: "session:snapshot", sessionId: s.id, ver, slides: list, from: CLIENT_ID });
  patchSession(s, { activity: { ...(s.activity || {}), __snap: ver }, currentSlide: at });
  return { index: at };
}

// 세션을 완전한 형태로 (store에 _full이 아니면 서버 조회)
export async function ensureSession(sessionId, opts = {}) {
  await ready();
  const s = findSession(sessionId);
  if (s && (s._full || !isCloud)) { ensureSessionShape(s); return s; }
  return await cloudFetchSession(sessionId, opts);
}

// ── 세션 패치 (교사 전용) ──
const patchQ = new Map(); // sessionId → { fields, rev, timer, waiters, chain }
// 가정: status를 바꾼 쓰기가 실패하면 성공할 때까지 1s,2s,4s,8s 뒤 이후 10초마다 재시도(페이지가 열려 있는 동안).
//       대기 중이면 session._statusPending = true (열거 안 됨 → 로컬 저장·복사에 안 섞임), 성공 시 false.
const STATUS_RETRY = [1000, 2000, 4000, 8000];
function setStatusPending(s, v) {
  if (!s || !!s._statusPending === v) return;
  Object.defineProperty(s, "_statusPending", { value: v, writable: true, configurable: true, enumerable: false });
  store.set(st => st);
}

export function patchSession(session, patch = {}) {
  if (!session) return Promise.resolve({ error: "세션이 없어요" });
  const s = findSession(session.id) || session;
  ensureSessionShape(s);
  const clean = {};
  for (const k of PATCH_KEYS) if (k in patch) clean[k] = patch[k];
  Object.assign(s, clean);
  s.rev = Math.max((s.rev || 0) + 1, Date.now());
  const rev = s.rev;
  store.set(st => { if (!st.sessions.includes(s)) st.sessions.unshift(s); });
  // broadcast 선반영 (sentAt: 교사 시계, 전송 전용 — 세션 객체에 저장하지 않음)
  const msg = { sessionId: s.id, rev, ...clean, sentAt: Date.now() };
  const ch = currentChannel();
  if (ch && ch.sessionId === s.id) ch.send("session:patch", msg);
  if (!isCloud) {
    sync.emit({ type: "session:patch", ...msg, from: CLIENT_ID });
    return Promise.resolve({ ok: true });
  }
  // DB: 150ms 디바운스 (status는 즉시)
  let q = patchQ.get(s.id);
  if (!q) { q = { rev: 0, timer: null, waiters: [], chain: Promise.resolve(), dirty: false, tries: 0, statusSeq: 0, statusOk: 0 }; patchQ.set(s.id, q); }
  q.rev = Math.max(q.rev, rev);
  q.dirty = true;
  q.tries = 0;
  if ("status" in clean) q.statusSeq++;
  const p = new Promise(r => q.waiters.push(r));
  clearTimeout(q.timer);
  if ("status" in clean) flushPatch(s.id);
  else q.timer = setTimeout(() => flushPatch(s.id), 150);
  return p;
}

// 가정: 패치 필드만이 아니라 세션의 전체 meta(PATCH_KEYS)를 매번 쓴다 → 'DB 행 = 그 rev의 전체 상태' 불변식 유지.
//       실패하면 q.dirty를 남기고 지수 백오프로 재시도(다음 패치가 성공해도 전체 상태라 누락 없음).
function flushPatch(sessionId) {
  const q = patchQ.get(sessionId);
  if (!q || !q.dirty) return;
  clearTimeout(q.timer);
  q.timer = null;
  q.dirty = false;
  const waiters = q.waiters;
  q.waiters = [];
  // 같은 세션의 쓰기는 순서대로 (lt('rev')로 인한 누락 방지)
  q.chain = q.chain.then(async () => {
    let res = { ok: true };
    const s = findSession(sessionId);
    if (!s) { waiters.forEach(w => w(res)); return; } // 삭제된 세션
    const rev = Math.max(q.rev, s.rev || 0);
    const seq = q.statusSeq; // 이 쓰기가 덮는 status 변경
    const full = {};
    for (const k of PATCH_KEYS) if (k in s) full[k] = s[k];
    try {
      const row = { ...sessionPatchRow(full), rev, last_writer: CLIENT_ID };
      const { error } = await supa.from("sessions").update(row).eq("id", sessionId).lt("rev", rev);
      if (error) { warn("patchSession", error); res = { error: "저장 실패" }; }
    } catch (e) { warn("patchSession", e); res = { error: "저장 실패" }; }
    if (res.error) {
      q.dirty = true;
      const statusPending = q.statusOk < q.statusSeq;
      if (statusPending) setStatusPending(findSession(sessionId), true);
      if (!q.timer) {
        if (statusPending) {
          // status 변경은 포기하지 않음: 1s,2s,4s,8s → 이후 10초마다
          const d = STATUS_RETRY[q.tries] || 10000;
          q.tries++;
          q.timer = setTimeout(() => { q.timer = null; flushPatch(sessionId); }, d);
        }
        else if (q.tries < 5) { q.tries++; q.timer = setTimeout(() => flushPatch(sessionId), 1000 * 2 ** q.tries); }
        else { q.tries = 0; q.dirty = false; toastOnce("patch-fail:" + sessionId, "수업 상태를 저장하지 못했어요"); }
      }
    } else {
      if (seq > q.statusOk) q.statusOk = seq;
      if (q.statusOk >= q.statusSeq) setStatusPending(findSession(sessionId), false);
      if (!q.dirty) q.tries = 0;
    }
    waiters.forEach(w => w(res));
  });
}

// 수신한 세션 패치 반영 (broadcast/BroadcastChannel). rev가 더 클 때만
export function applySessionPatch(sessionId, p, afterSnap = false) {
  if (!p) return false;
  const s = findSession(p.sessionId || sessionId);
  if (!s) return false;
  const rev = Number(p.rev || 0);
  if (!(rev > (s.rev || 0))) return false;
  // 슬라이드가 추가된 패치: 새 스냅샷을 받은 뒤에 적용(옛 스냅샷의 다른 슬라이드가 잠깐 보이지 않게)
  if (!afterSnap && "activity" in p && needSnapshot(s, p.activity)) {
    refreshSnapshot(s, snapVerOf(p.activity)).then(() => applySessionPatch(sessionId, p, true));
    return false;
  }
  for (const k of PATCH_KEYS) if (k in p) s[k] = p[k];
  s.rev = rev;
  store.set(st => st);
  return true;
}

// 'session:hello' 응답용 전체 상태
export function sessionHelloState(sessionId) {
  const s = findSession(sessionId);
  if (!s) return null;
  return {
    sessionId: s.id, rev: s.rev, currentSlide: s.currentSlide, flow: s.flow, groups: s.groups,
    activity: s.activity, status: s.status, endedAt: s.endedAt, title: s.title, sentAt: Date.now(),
  };
}

// DB sessions 행 이벤트
function applySessionRow(row, afterSnap = false) {
  if (!row || !row.id) return;
  if (row.last_writer && row.last_writer === CLIENT_ID) return;
  const s = findSession(row.id);
  if (!s) return;
  const meta = sessionMeta(row);
  const cur = s.rev || 0;
  if (meta.rev < cur) return;
  if (!afterSnap && needSnapshot(s, meta.activity)) {
    refreshSnapshot(s, snapVerOf(meta.activity)).then(() => applySessionRow(row, true));
    return;
  }
  const { id, lessonId, teacherId, startedAt, rev, ...rest } = meta;
  // 같은 rev: DB 행이 그 rev의 전체 상태 → 놓친 broadcast가 있으면 여기서 보정
  // 키 순서 무관 비교(jsonb 재정렬) + 같은 하위 값은 기존 참조 유지 → broadcast 후 DB echo로 onActivity가 두 번 불리지 않게
  const changed = Object.keys(rest).some(k => !sameVal(rest[k], s[k]));
  s.rev = rev;
  if (!changed) return;
  for (const k of Object.keys(rest)) s[k] = keepSame(s[k], rest[k]);
  store.set(st => st);
}

export async function cloudEndSession(session, status = "completed") {
  return await patchSession(session, { status, endedAt: Date.now() });
}

export async function cloudResumeSession(session) {
  await ready();
  const s = findSession(session.id) || session;
  const now = Date.now();
  if (isCloud) {
    const { error } = await supa.from("sessions").update({ status: "stopped", ended_at: iso(now), rev: now, last_writer: CLIENT_ID })
      .eq("teacher_id", s.teacherId).eq("status", "live").neq("id", s.id);
    warn("resume stop others", error);
  }
  store.state.sessions.forEach(x => {
    if (x !== s && x.teacherId === s.teacherId && x.status === "live") { x.status = "stopped"; x.endedAt = now; x.rev = Math.max(x.rev + 1, now); }
  });
  const res = await patchSession(s, { status: "live", endedAt: null });
  if (res && res.error) return res;
  return s;
}

export async function cloudDeleteSession(sessionId) {
  await ready();
  if (isCloud) {
    const { error } = await supa.from("sessions").delete().eq("id", sessionId);
    if (error) { warn("deleteSession", error); return { error: "삭제하지 못했어요" }; }
  }
  store.set(s => { s.sessions = s.sessions.filter(x => x.id !== sessionId); });
  return { ok: true };
}

export async function cloudListSessionsForStudent(studentId) {
  await ready();
  if (!studentId) return [];
  if (!isCloud) {
    return store.state.sessions.filter(s => (s.participants || []).includes(studentId))
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }
  try {
    const rows = await fetchAll(() => supa.from("session_participants").select(`session_id,sessions(${SESSION_COLS})`)
      .eq("student_id", studentId).order("session_id"));
    const list = rows.map(r => r.sessions).filter(Boolean).map(r => mergeSessionMeta(sessionMeta(r)));
    store.set(s => s);
    return list.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  } catch (e) {
    warn("listSessionsForStudent", e);
    return [];
  }
}

// ── 복습 코드 (세션마다 6자리 · 학습지 QR) ──
// 가정: review_code 열(004_review_code.sql)은 SESSION_COLS에 넣지 않고 따로 읽고 쓴다
//       → 열이 아직 없는 DB에서도 수업은 그대로 되고 복습 코드만 null(호출부가 안내).
// 가정: 학생 로그인의 코드 칸 하나로 교사 코드·복습 코드를 둘 다 받으므로 교사 코드와 겹치지 않게 만든다(겹치면 교사 코드 우선).
// 가정: 코드는 처음 필요할 때 채운다(수업 시작 직후·기록·인쇄). 이미 있으면 그대로 — 한 번 정해진 코드는 바뀌지 않는다.
const reviewCodeQ = new Map(); // sessionId → Promise<code|null> (중복 생성 방지)
export function cloudEnsureReviewCode(session) {
  const id = session && session.id;
  if (!id) return Promise.resolve(null);
  const s = findSession(id) || session;
  if (s.reviewCode) return Promise.resolve(s.reviewCode);
  if (!reviewCodeQ.has(id)) reviewCodeQ.set(id, ensureReviewCode(s).finally(() => reviewCodeQ.delete(id)));
  return reviewCodeQ.get(id);
}
function setReviewCode(s, code) {
  if (!code) return null;
  store.set(() => {
    s.reviewCode = code;
    const t = findSession(s.id);
    if (t) t.reviewCode = code;
  });
  return code;
}
async function ensureReviewCode(s) {
  await ready();
  const taken = (c) => (store.state.sessions || []).some(x => x.reviewCode === c) || !!store.findTeacherByCode(c);
  if (!isCloud) {
    for (let i = 0; i < 20; i++) { const c = newJoinCode(); if (!taken(c)) return setReviewCode(s, c); }
    return null;
  }
  try {
    const { data, error } = await supa.from("sessions").select("review_code").eq("id", s.id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (data.review_code) return setReviewCode(s, data.review_code);
    for (let i = 0; i < 6; i++) {
      const c = newJoinCode();
      if (taken(c)) continue;
      const { data: t, error: te } = await supa.from("teachers").select("id").eq("join_code", c).maybeSingle();
      if (te) throw te;
      if (t) continue;
      // 비어 있을 때만 채움 — 다른 기기가 먼저 채웠으면 그 값을 쓴다
      const { data: up, error: ue } = await supa.from("sessions").update({ review_code: c })
        .eq("id", s.id).is("review_code", null).select("review_code");
      if (ue) { if (ue.code === "23505") continue; throw ue; } // 다른 세션과 겹침 → 다시
      if (up && up.length) return setReviewCode(s, up[0].review_code);
      const { data: again } = await supa.from("sessions").select("review_code").eq("id", s.id).maybeSingle();
      return again && again.review_code ? setReviewCode(s, again.review_code) : null;
    }
    return null;
  } catch (e) {
    warn("ensureReviewCode", e);
    return null;
  }
}

// 기록 목록용: 여러 세션의 이미 있는 복습 코드를 한 번에 읽어 둔다(없는 코드는 만들지 않음 — [복습 링크]를 누를 때 만든다).
// → 목록에서 링크 복사가 누른 자리에서 바로(클립보드 사용자 동작 안에서) 된다. 세션마다 한 번만 묻는다.
const reviewAsked = new Set();
export async function cloudFetchReviewCodes(ids) {
  await ready();
  if (!isCloud) return;
  const want = [...new Set(ids || [])].filter(id => id && !reviewAsked.has(id) && !findSession(id)?.reviewCode);
  if (!want.length) return;
  want.forEach(id => reviewAsked.add(id));
  try {
    for (let i = 0; i < want.length; i += 100) {
      const { data, error } = await supa.from("sessions").select("id,review_code").in("id", want.slice(i, i + 100)).not("review_code", "is", null);
      if (error) { if (error.code !== "42703") throw error; return; } // 42703: review_code 열이 아직 없는 DB
      const rows = (data || []).filter(r => r && r.review_code);
      if (rows.length) store.set(() => { for (const r of rows) { const s = findSession(r.id); if (s && !s.reviewCode) s.reviewCode = r.review_code; } });
    }
  } catch (e) {
    warn("fetchReviewCodes", e);
    want.forEach(id => reviewAsked.delete(id));
  }
}

// 복습 코드 → { id, teacherId, status, title, teacher } | null
export async function cloudFindSessionByReviewCode(code) {
  await ready();
  const c = normCode(code);
  if (!c) return null;
  if (!isCloud) {
    const s = (store.state.sessions || []).find(x => x.reviewCode === c);
    return s ? { id: s.id, teacherId: s.teacherId, status: s.status, title: s.title, teacher: findTeacher(s.teacherId) } : null;
  }
  const { data, error } = await supa.from("sessions").select("id,teacher_id,status,title,teachers(id,name,join_code)")
    .eq("review_code", c).maybeSingle();
  if (error) {
    if (error.code === "42703") return null; // review_code 열이 아직 없는 DB
    warn("findSessionByReviewCode", error);
    throw error;
  }
  if (!data) return null;
  const teacher = data.teachers ? upsertById(store.state.teachers, toTeacher(data.teachers, false)) : null;
  const s = findSession(data.id);
  if (s && !s.reviewCode) s.reviewCode = c;
  store.save();
  return { id: data.id, teacherId: data.teacher_id, status: data.status, title: data.title, teacher };
}

// ── 참여 ──
export async function cloudAddParticipant(sessionId, studentId) {
  await ready();
  if (!sessionId || !studentId) return { error: "잘못된 요청" };
  const s = findSession(sessionId);
  if (s) {
    ensureSessionShape(s);
    if (!s.participants.includes(studentId)) { s.participants = [...s.participants, studentId]; store.set(st => st); }
  }
  if (!isCloud) {
    sync.emit({ type: "participant", sessionId, studentId, student: findStudent(studentId), from: CLIENT_ID });
    return { ok: true };
  }
  const { error } = await supa.from("session_participants")
    .upsert({ session_id: sessionId, student_id: studentId }, { onConflict: "session_id,student_id", ignoreDuplicates: true });
  if (error) { warn("addParticipant", error); return { error: "참여 등록 실패" }; }
  return { ok: true };
}

const studentFetching = new Map();
const studentMissing = new Set();
function ensureStudentLoaded(studentId) {
  if (!isCloud || findStudent(studentId) || studentFetching.has(studentId) || studentMissing.has(studentId)) return;
  const p = supa.from("students").select(STUDENT_COLS).eq("id", studentId).maybeSingle().then(({ data, error }) => {
    if (data) { addStudentsToStore([data]); store.set(s => s); }
    else if (!error) studentMissing.add(studentId); // 없는 id는 다시 조회하지 않음
  }, () => {}).finally(() => studentFetching.delete(studentId));
  studentFetching.set(studentId, p);
}
// 이름을 모르는 학생 id들(예: presence에만 있는 학생)을 1회 조회해 store.students에 넣음
export function ensureStudentsLoaded(ids) {
  if (!isCloud || !ids) return;
  for (const id of ids) if (id) ensureStudentLoaded(id);
}

// ── 필기 레코드 ──
const MAX_REC_BYTES = 700 * 1024;
const recKey = (sessionId, slideId, scope, scopeId) => `${sessionId}|${slideId}|${scope}|${scopeId}`;
const pendingRec = new Map(); // key → { timer, args, tries }

// 레코드 슬롯(슬라이드id → Rec 맵)
function recSlot(session, scope, scopeId, create = true) {
  ensureSessionShape(session);
  const R = session.records;
  if (scope === "whole") return R.__whole;
  if (scope === "group") return create ? (R.__groups[scopeId] ||= {}) : R.__groups[scopeId];
  return create ? (R[scopeId] ||= {}) : R[scopeId];
}

// 세션의 레코드 조회 (create=true면 빈 Rec 생성)
export function getRecord(session, slideId, scope, scopeId, create = false) {
  if (!session) return null;
  const slot = recSlot(session, scope, scopeId, create);
  if (!slot) return null;
  if (!slot[slideId] && create) slot[slideId] = { strokes: [], texts: [], removed: [] };
  return slot[slideId] || null;
}

function bumpRec(rec) {
  const v = (rec._v || 0) + 1;
  try { Object.defineProperty(rec, "_v", { value: v, writable: true, configurable: true, enumerable: false }); } catch (_) {}
}

const itemKey = x => x.id || `${x.ts || 0}:${(x.points || []).length}:${x.value || ""}`;

// whole/group 병합: stroke/text id 합집합 + removed 합집합(tombstone). a를 제자리 수정. 바뀌면 true
export function mergeRec(a, b) {
  a.strokes ||= []; a.texts ||= []; a.removed ||= [];
  const before = `${a.strokes.length}|${a.texts.length}|${a.removed.length}`;
  const removed = new Set([...a.removed, ...(b.removed || [])]);
  const sMap = new Map(a.strokes.map(x => [itemKey(x), x]));
  let added = false;
  for (const x of b.strokes || []) if (!sMap.has(itemKey(x))) { sMap.set(itemKey(x), x); added = true; }
  const tMap = new Map(a.texts.map(x => [itemKey(x), x]));
  let textChanged = false;
  for (const x of b.texts || []) {
    const k = itemKey(x), cur = tMap.get(k);
    if (!cur || (x.ts || 0) > (cur.ts || 0)) { tMap.set(k, x); textChanged = textChanged || cur !== x; }
  }
  let strokes = [...sMap.values()].filter(x => !removed.has(x.id));
  if (added) strokes = strokes.map((x, i) => [x, i]).sort((p, q) => ((p[0].ts || 0) - (q[0].ts || 0)) || (p[1] - q[1])).map(p => p[0]);
  a.strokes = strokes;
  a.texts = [...tMap.values()].filter(x => !removed.has(x.id));
  a.removed = [...removed];
  return added || textChanged || before !== `${a.strokes.length}|${a.texts.length}|${a.removed.length}`;
}

// 원격(또는 조회한) 레코드 행을 세션에 반영. 반환: 바뀌었는지
// whole/group 수렴용: 원격에서 본 항목 키 / 이 클라이언트가 만든 항목 키 ('r:'+id = 지운 표시)
const recRemoteSeen = new Map(); // recKey → Set
const recOwn = new Map();        // recKey → Set
const recTouched = new Map();    // recKey → 마지막 로컬 쓰기 시각(ms) — individual 조회가 로컬을 덮지 않게
const setOf = (m, k) => { let x = m.get(k); if (!x) { x = new Set(); m.set(k, x); } return x; };
function noteRemote(key, rec) {
  const seen = setOf(recRemoteSeen, key);
  for (const x of rec.strokes || []) seen.add(itemKey(x));
  for (const x of rec.texts || []) seen.add(itemKey(x));
  for (const id of rec.removed || []) seen.add("r:" + id);
}

function applyRecordRow(session, row, { fromFetch = false, fetchStart = 0 } = {}) {
  if (!session || !row) return false;
  if (!fromFetch && row.last_writer && row.last_writer === CLIENT_ID) return false;
  const scope = row.scope;
  const scopeId = scope === "whole" ? session.id : row.scope_id;
  const slot = recSlot(session, scope, scopeId);
  const incoming = toRec(row);
  const ex = slot[row.slide_id];
  const key = recKey(session.id, row.slide_id, scope, scopeId);
  if (scope !== "individual") noteRemote(key, incoming);
  if (!ex) { slot[row.slide_id] = incoming; bumpRec(incoming); return true; }
  if (scope === "individual") {
    if (pendingRec.has(key)) return false; // 내가 쓰는 중이면 로컬 유지
    // 조회 시작 뒤에 로컬에서 쓴 레코드는 (저장이 끝났어도) 조회 결과가 더 낡았다 → 로컬 유지
    if (fromFetch && (recTouched.get(key) || 0) >= fetchStart) return false;
    ex.strokes = incoming.strokes; ex.texts = incoming.texts; ex.removed = incoming.removed;
    bumpRec(ex);
    return true;
  }
  const changed = mergeRec(ex, incoming);
  if (changed) bumpRec(ex);
  // 로컬에만 있는 항목이 있으면 다시 써서 DB 수렴.
  // 내 항목이 빠졌으면 곧(0.3~1.3초), 남의 항목만 빠졌으면 늦게(4~8초: 보통 작성자가 먼저 다시 쓰고 그 행이 오면 취소)
  if (isCloud) {
    const ids = new Set([...(incoming.strokes || []), ...(incoming.texts || [])].map(itemKey));
    const incRemoved = new Set(incoming.removed || []);
    const own = recOwn.get(key);
    let anyExtra = false, ownExtra = false;
    for (const x of [...ex.strokes, ...ex.texts]) {
      const k = itemKey(x);
      if (ids.has(k)) continue;
      anyExtra = true;
      if (own && own.has(k)) { ownExtra = true; break; }
    }
    if (!ownExtra) for (const id of ex.removed) {
      if (incRemoved.has(id)) continue;
      anyExtra = true;
      if (own && own.has("r:" + id)) { ownExtra = true; break; }
    }
    const p = pendingRec.get(key);
    if (ownExtra) scheduleRecordWrite(session.id, row.slide_id, scope, scopeId, ex, 300 + Math.random() * 1000, "conv");
    else if (anyExtra) scheduleRecordWrite(session.id, row.slide_id, scope, scopeId, ex, 4000 + Math.random() * 4000, "conv");
    else if (p && p.conv && p.timer && !p.inflight) {
      // DB가 이미 내 상태를 다 가짐 → 예약된 수렴 쓰기 취소
      clearTimeout(p.timer); p.timer = null;
      pendingRec.delete(key);
    }
  }
  return changed;
}

// 외부용: 레코드 행(또는 {slideId, scope, scopeId, strokes, texts, removed}) 반영 + 리스너 호출
export function applyRecord(sessionId, row) {
  const s = findSession(sessionId);
  if (!s || !row) return false;
  const r = row.slide_id ? row : {
    slide_id: row.slideId, scope: row.scope, scope_id: row.scopeId,
    strokes: row.strokes, texts: row.texts, removed: row.removed, last_writer: row.lastWriter || row.last_writer,
  };
  const changed = applyRecordRow(s, r);
  if (changed) store.set(st => st);
  return changed;
}

// 250ms 디바운스(키별 최신만). whole이면 scopeId=sessionId
export function cloudWriteRecord(sessionId, slideId, scope, scopeId, rec) {
  if (!sessionId || !slideId || !rec) return;
  if (scope === "whole") scopeId = sessionId;
  const key = recKey(sessionId, slideId, scope, scopeId);
  recTouched.set(key, Date.now());
  // store의 레코드와 연결 (제자리)
  const s = findSession(sessionId);
  if (s) {
    const slot = recSlot(s, scope, scopeId);
    const ex = slot[slideId];
    if (!ex) slot[slideId] = rec;
    else if (ex !== rec) {
      if (scope === "individual") { ex.strokes = rec.strokes || []; ex.texts = rec.texts || []; ex.removed = rec.removed || []; }
      else mergeRec(ex, rec);
    }
    bumpRec(slot[slideId]);
    if (!isCloud) store.save();
  }
  const cur = s ? recSlot(s, scope, scopeId)[slideId] : rec;
  // 원격에서 본 적 없는 항목·지운 표시 = 이 클라이언트가 만든 것 (수렴 쓰기 판단용)
  if (scope !== "individual" && cur) {
    const seen = recRemoteSeen.get(key), own = setOf(recOwn, key);
    for (const x of [...(cur.strokes || []), ...(cur.texts || [])]) { const k = itemKey(x); if (!seen || !seen.has(k)) own.add(k); }
    for (const id of cur.removed || []) if (!seen || !seen.has("r:" + id)) own.add("r:" + id);
  }
  scheduleRecordWrite(sessionId, slideId, scope, scopeId, cur, 250, "own");
}

// kind 'own': 디바운스(최대 1초 대기). kind 'conv'(수렴): 이미 잡힌 마감을 늦추지 않음(스로틀), 원격 행이 덮으면 취소 가능.
// 가정: 진행 중(inflight)이면 끝난 뒤 again으로 한 번 더 쓴다(병합된 최신 Rec).
function scheduleRecordWrite(sessionId, slideId, scope, scopeId, rec, delay, kind = "own") {
  const key = recKey(sessionId, slideId, scope, scopeId);
  let p = pendingRec.get(key);
  if (!p) { p = { timer: null, tries: 0, seq: 0, inflight: false, again: false, due: 0, first: 0, conv: true }; pendingRec.set(key, p); }
  p.args = { sessionId, slideId, scope, scopeId, rec };
  p.seq++;
  const now = Date.now();
  if (kind === "own") {
    p.conv = false;
    if (!p.timer) p.first = now;
    const due = Math.min(now + delay, p.first + 1000);
    clearTimeout(p.timer);
    p.due = due;
    p.timer = setTimeout(() => flushRecord(key), Math.max(0, due - now));
    return;
  }
  // 수렴: 쓰는 중이면 끝난 뒤 다시(이미 대기 중인 쓰기가 병합본을 실어 감)
  if (p.inflight && !p.timer) { p.again = true; return; }
  const due = now + delay;
  if (p.timer && p.due <= due) return; // 더 이른 마감 유지
  clearTimeout(p.timer);
  if (!p.timer) p.first = now;
  p.due = due;
  p.timer = setTimeout(() => flushRecord(key), delay);
}

async function flushRecord(key) {
  const p = pendingRec.get(key);
  if (!p) return;
  clearTimeout(p.timer); // 직접 호출(again·숨김 flush) 시 남은 타이머가 중복 쓰기하지 않게
  p.timer = null;
  if (p.inflight) { p.again = true; return; } // 저장 중이면 끝난 뒤 다시
  const ownBatch = !p.conv;
  p.conv = true; // 지금 쓰는 내용에 내 변경이 다 담김 → 이후 예약은 다시 판단
  const seq = p.seq;
  const { sessionId, slideId, scope, scopeId, rec } = p.args;
  const body = { strokes: rec.strokes || [], texts: rec.texts || [], removed: rec.removed || [] };
  const json = JSON.stringify(body);
  if (json.length > MAX_REC_BYTES) {
    pendingRec.delete(key);
    toastOnce("rec-big:" + key, "이 슬라이드의 필기가 너무 많아요");
    return;
  }
  if (!isCloud) {
    pendingRec.delete(key);
    sync.emit({ type: "record", sessionId, slideId, scope, scopeId, rec: JSON.parse(json), from: CLIENT_ID });
    return;
  }
  p.inflight = true;
  let error = null;
  try {
    ({ error } = await supa.from("slide_records").upsert({
      session_id: sessionId, slide_id: slideId, scope, scope_id: scopeId, ...body,
      last_writer: CLIENT_ID, updated_at: nowIso(),
    }, { onConflict: "session_id,slide_id,scope,scope_id" }));
  } catch (e) { error = e; }
  p.inflight = false;
  if (error) {
    warn("writeRecord", error);
    if (ownBatch) p.conv = false; // 내 변경이 아직 저장 안 됨 → 취소 대상 아님
    if (p.tries < 3) {
      p.tries++;
      if (!p.timer) {
        const d = 1000 * 2 ** p.tries;
        p.first = Date.now(); p.due = Date.now() + d;
        p.timer = setTimeout(() => flushRecord(key), d);
      }
    } else {
      p.tries = 0;
      if (!p.timer) pendingRec.delete(key); // 그 사이 새 쓰기가 예약됐으면 유지
      toastOnce("rec-fail", "필기를 저장하지 못했어요");
    }
    return;
  }
  p.tries = 0;
  if (p.again) { p.again = false; flushRecord(key); return; }
  // 저장 중에 새 쓰기가 예약되지 않았으면 대기 해제
  if (p.seq === seq && !p.timer) pendingRec.delete(key);
}

// 크기 초과로 잘린 이벤트 → 행 직접 조회
async function refetchRecord(session, row) {
  const { data, error } = await supa.from("slide_records").select(RECORD_COLS)
    .eq("session_id", session.id).eq("slide_id", row.slide_id).eq("scope", row.scope).eq("scope_id", row.scope_id).maybeSingle();
  if (error || !data) return;
  if (applyRecordRow(session, data)) store.set(s => s);
}

// ── 응답 ──
function upsertLocalResponse(session, r) {
  ensureSessionShape(session);
  const list = session.responses[r.slideId] || [];
  const i = list.findIndex(x => x.studentId === r.studentId && (x.itemKey || "") === (r.itemKey || ""));
  if (i >= 0) {
    const cur = list[i];
    const curPending = typeof cur.id === "number" && cur.id < 0;
    if (!curPending && (cur.updatedAt || 0) > (r.updatedAt || 0)) return false; // 늦게 온 옛 이벤트
    const next = list.slice(); next[i] = r;
    session.responses[r.slideId] = next;
  } else {
    session.responses[r.slideId] = [...list, r];
  }
  return true;
}
function removeLocalResponse(session, pred) {
  ensureSessionShape(session);
  let changed = false;
  for (const [slideId, list] of Object.entries(session.responses)) {
    const next = (list || []).filter(x => !pred(x, slideId));
    if (next.length !== (list || []).length) { session.responses[slideId] = next; changed = true; }
  }
  return changed;
}

let tmpId = 0;
export async function cloudSubmitResponse(r) {
  await ready();
  const s = findSession(r.sessionId);
  const base = {
    sessionId: r.sessionId, slideId: r.slideId, studentId: r.studentId, itemKey: r.itemKey || "",
    payload: r.payload || {}, score: r.score ?? null, correct: r.correct ?? null, timeMs: r.timeMs ?? null,
    updatedAt: Date.now(),
  };
  // 낙관적 반영 (음수 임시 id)
  const optimistic = { ...base, id: -(Date.now() * 10 + (++tmpId % 10)) };
  if (s && upsertLocalResponse(s, optimistic)) store.set(st => st);
  if (!isCloud) {
    const done = { ...base, id: Date.now() * 100 + Math.floor(Math.random() * 100) };
    if (s) { upsertLocalResponse(s, done); store.set(st => st); }
    sync.emit({ type: "response", response: done, from: CLIENT_ID });
    return done;
  }
  const { data, error } = await supa.from("responses").upsert({
    session_id: base.sessionId, slide_id: base.slideId, student_id: base.studentId, item_key: base.itemKey,
    payload: base.payload, score: base.score, correct: base.correct, time_ms: base.timeMs,
    last_writer: CLIENT_ID, updated_at: iso(base.updatedAt),
  }, { onConflict: "session_id,slide_id,student_id,item_key" }).select(RESPONSE_COLS).single();
  if (error || !data) {
    warn("submitResponse", error);
    if (s && removeLocalResponse(s, x => x === optimistic || x.id === optimistic.id)) store.set(st => st);
    throw error || new Error("제출 실패");
  }
  const done = toResponse(data);
  if (s) { upsertLocalResponse(s, done); store.set(st => st); }
  return done;
}

function sendResponsesDel(payload) {
  const ch = currentChannel();
  if (ch && ch.sessionId === payload.sessionId) ch.send("responses:del", payload);
  if (!isCloud) sync.emit({ type: "responses:del", ...payload, from: CLIENT_ID });
}

// 수신한 응답 삭제 알림 반영 {sessionId, slideId, studentId?, itemKey?}
export function applyResponseDelete(p) {
  if (!p) return;
  const s = findSession(p.sessionId);
  if (!s) return;
  const pred = p.studentId != null
    ? (x, sid) => sid === p.slideId && x.studentId === p.studentId && (x.itemKey || "") === (p.itemKey || "")
    : (x, sid) => sid === p.slideId;
  if (removeLocalResponse(s, pred)) store.set(st => st);
}

export async function cloudDeleteResponse(sessionId, slideId, studentId, itemKey = "") {
  await ready();
  const payload = { sessionId, slideId, studentId, itemKey: itemKey || "" };
  applyResponseDelete(payload);
  if (isCloud) {
    const { error } = await supa.from("responses").delete()
      .eq("session_id", sessionId).eq("slide_id", slideId).eq("student_id", studentId).eq("item_key", itemKey || "");
    if (error) { warn("deleteResponse", error); throw error; }
  }
  sendResponsesDel(payload);
  return { ok: true };
}

export async function cloudDeleteResponsesForSlide(sessionId, slideId) {
  await ready();
  const payload = { sessionId, slideId };
  applyResponseDelete(payload);
  if (isCloud) {
    const { error } = await supa.from("responses").delete().eq("session_id", sessionId).eq("slide_id", slideId);
    if (error) { warn("deleteResponsesForSlide", error); throw error; }
  }
  sendResponsesDel(payload);
  return { ok: true };
}

export async function cloudFetchResponses(sessionId) {
  await ready();
  const s = findSession(sessionId);
  if (!isCloud) return s ? Object.values(s.responses || {}).flat() : [];
  const rows = await fetchAll(() => supa.from("responses").select(RESPONSE_COLS).eq("session_id", sessionId).order("id"));
  const list = rows.map(toResponse);
  if (s) {
    const grouped = {};
    for (const r of list) (grouped[r.slideId] ||= []).push(r);
    s.responses = grouped;
    store.set(st => st);
  }
  return list;
}

// ── 구독 ──
let subSeq = 0;
// initCloud 진행 중에 호출되면 클라이언트 준비 후 시작 (반환 stop은 그대로 유효)
function deferUntilReady(start) {
  let stopped = false, off = null;
  clientReady.then(() => { if (!stopped) off = start(); });
  return () => { stopped = true; off && off(); off = null; };
}

export function subscribeSession(sessionId, opts = {}) {
  if (!sessionId) return () => {};
  if (pending()) return deferUntilReady(() => subscribeSession(sessionId, opts));
  if (!isCloud) return () => {};
  const { role = "teacher", studentId = null, groupId = null } = opts || {};
  let ch = null;
  let stopped = false;
  const s0 = findSession(sessionId);
  let curGroup = groupId ?? (s0 ? myGroupId(s0, studentId) : null);
  let resyncTimer = null;
  const isStudent = role === "student";

  const resync = (delay = 0) => {
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => {
      if (stopped) return;
      cloudFetchSession(sessionId, isStudent ? { forStudentId: studentId } : {});
    }, delay);
  };

  const onSessionEv = (pl) => applySessionRow(pl.new);
  const onPartEv = (pl) => {
    const s = findSession(sessionId);
    if (!s) return;
    ensureSessionShape(s);
    if (pl.eventType === "DELETE") {
      const o = pl.old || {};
      if (o.session_id && o.session_id !== sessionId) return;
      if (o.student_id && s.participants.includes(o.student_id)) {
        s.participants = s.participants.filter(x => x !== o.student_id);
        store.set(st => st);
      }
      return;
    }
    const n = pl.new || {};
    if (n.session_id !== sessionId || !n.student_id) return;
    ensureStudentLoaded(n.student_id);
    if (!s.participants.includes(n.student_id)) { s.participants = [...s.participants, n.student_id]; store.set(st => st); }
  };
  const onRespEv = (pl) => {
    const s = findSession(sessionId);
    if (!s) return;
    if (pl.eventType === "DELETE") {
      const o = pl.old || {};
      if (o.session_id && o.session_id !== sessionId) return;
      if (o.id == null) return;
      if (removeLocalResponse(s, x => x.id === o.id)) store.set(st => st);
      return;
    }
    const n = pl.new;
    if (!n || n.session_id !== sessionId) return;
    if (n.last_writer && n.last_writer === CLIENT_ID) return; // 내 쓰기 echo (select 결과로 이미 반영)
    if (upsertLocalResponse(s, toResponse(n))) store.set(st => st);
  };
  const onRecEv = (pl) => {
    const s = findSession(sessionId);
    const n = pl.new;
    if (!s || !n || n.session_id !== sessionId || pl.eventType === "DELETE") return;
    if (n.last_writer && n.last_writer === CLIENT_ID) return;
    // 큰 행은 이벤트에서 잘릴 수 있음 → 직접 조회
    if (pl.errors || !Array.isArray(n.strokes)) { refetchRecord(s, n); return; }
    if (applyRecordRow(s, n)) store.set(st => st);
  };

  const build = () => {
    const topic = `db:session:${sessionId}:${++subSeq}`;
    const recFilter = isStudent
      ? `scope_id=in.(${[studentId, curGroup || "none", sessionId].filter(Boolean).join(",")})`
      : `session_id=eq.${sessionId}`;
    const c = supa.channel(topic)
      .on("postgres_changes", { event: "*", schema: "public", table: "sessions", filter: `id=eq.${sessionId}` }, onSessionEv)
      .on("postgres_changes", { event: "*", schema: "public", table: "session_participants", filter: `session_id=eq.${sessionId}` }, onPartEv)
      // 가정: 필터 없는 responses DELETE 구독은 두지 않는다(프로젝트 전체 삭제 행이 모든 클라이언트로 감).
      //       응답 삭제는 'responses:del' broadcast(cloudDeleteResponse*) + 재연결/visible resync로 반영.
      .on("postgres_changes", { event: "*", schema: "public", table: "responses", filter: `session_id=eq.${sessionId}` }, onRespEv)
      .on("postgres_changes", { event: "*", schema: "public", table: "slide_records", filter: recFilter }, onRecEv);
    c.subscribe((status) => {
      if (stopped || c !== ch) return;
      if (status === "SUBSCRIBED") {
        // 첫 구독 포함 매번 resync: 캐시로 연 화면·조회~구독 사이에 놓친 응답/참여/필기를 채움
        resync(0);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn("[cloud] 세션 구독 상태:", status);
      }
    });
    return c;
  };
  ch = build();

  const onVis = () => { if (document.visibilityState === "visible") resync(500); };
  const onOnline = () => resync(500);
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("online", onOnline);

  // 학생: 내 모둠이 바뀌면 레코드 필터를 다시 구독
  const offStore = isStudent ? store.subscribe(() => {
    if (stopped) return;
    const s = findSession(sessionId);
    if (!s) return;
    const g = myGroupId(s, studentId);
    if ((g || null) !== (curGroup || null)) {
      curGroup = g;
      const old = ch;
      ch = build();
      supa.removeChannel(old).catch(() => {});
      resync(300);
    }
  }) : null;

  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(resyncTimer);
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("online", onOnline);
    offStore && offStore();
    if (ch) supa.removeChannel(ch).catch(() => {});
    ch = null;
  };
}

// 학생 대기: 교사의 LIVE 세션이 생기면 onLive(sessionMeta). sessions 구독 + 5초 폴링
export function watchTeacherLive(teacherId, onLive) {
  if (pending()) return deferUntilReady(() => watchTeacherLive(teacherId, onLive));
  let stopped = false;
  let lastId = null, lastRev = 0;
  const fire = (meta) => {
    if (stopped || !meta || meta.status !== "live") return;
    const rev = Number(meta.rev || 0);
    // 같은 id는 rev가 올라갔을 때만 다시 알림
    if (meta.id === lastId && !(rev > lastRev)) return;
    // store가 이미 끝남(live 아님)으로 같거나 높은 rev를 들고 있으면 무시(끝난 수업으로 튕겨 들어가지 않게)
    const known = findSession(meta.id);
    if (known && known !== meta && known.status !== "live" && Number(known.rev || 0) >= rev) return;
    lastId = meta.id;
    lastRev = rev;
    try { onLive(meta); } catch (e) { console.error("[cloud] onLive 오류:", e); }
  };
  if (!isCloud) {
    const check = () => {
      const s = store.state.sessions.filter(x => x.teacherId === teacherId && x.status === "live")
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
      if (s) fire(s);
    };
    const offSync = sync.on(() => setTimeout(check, 50));
    const offStore = store.subscribe(check);
    const t = setInterval(check, 2000);
    check();
    return () => { stopped = true; offSync(); offStore(); clearInterval(t); };
  }
  const ch = supa.channel(`db:live:${teacherId}:${++subSeq}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "sessions", filter: `teacher_id=eq.${teacherId}` }, (pl) => {
      const n = pl.new;
      if (n && n.status === "live") fire(sessionMeta(n));
    })
    .subscribe();
  const poll = async () => {
    if (stopped) return;
    const { data, error } = await supa.from("sessions").select(SESSION_COLS).eq("teacher_id", teacherId).eq("status", "live")
      .order("started_at", { ascending: false }).limit(1);
    if (!error && data && data[0]) fire(sessionMeta(data[0]));
  };
  const t = setInterval(poll, 5000);
  poll();
  return () => {
    stopped = true;
    clearInterval(t);
    supa.removeChannel(ch).catch(() => {});
  };
}

// ── 페이지 숨김/종료: 디바운스 중인 세션 패치·필기 쓰기를 즉시 보냄 (best-effort) ──
function flushPendingWrites() {
  for (const [id, q] of patchQ) if (q.dirty && !q.tries) flushPatch(id);
  for (const [key, p] of pendingRec) if (p.timer && !p.inflight && !p.conv) flushRecord(key);
}
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { hiddenAt = Date.now(); flushPendingWrites(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { hiddenAt = Date.now(); flushPendingWrites(); }
    else hiddenAt = 0;
  });
}

// ── 로컬 모드: 다른 탭 메시지 반영 ──
sync.on((msg) => {
  if (isCloud || !msg || msg.from === CLIENT_ID) return;
  switch (msg.type) {
    case "session:patch": applySessionPatch(msg.sessionId, msg); break;
    case "session:snapshot": applyLocalSnapshot(msg); break;
    case "record": {
      const s = findSession(msg.sessionId);
      if (!s) return;
      const row = { slide_id: msg.slideId, scope: msg.scope, scope_id: msg.scopeId, ...msg.rec };
      if (applyRecordRow(s, row)) store.set(st => st);
      break;
    }
    case "response": {
      const r = msg.response;
      const s = r && findSession(r.sessionId);
      if (s && upsertLocalResponse(s, r)) store.set(st => st);
      break;
    }
    case "responses:del": applyResponseDelete(msg); break;
    case "session:new": {
      const inc = msg.session;
      if (!inc || !inc.id || findSession(inc.id)) break;
      // 같은 교사의 다른 LIVE는 시작한 탭에서 stopped 처리됨 → 여기서도 맞춤
      store.state.sessions.forEach(x => {
        if (x.teacherId === inc.teacherId && x.status === "live") { x.status = "stopped"; x.endedAt ??= inc.startedAt; }
      });
      store.set(st => { st.sessions.unshift(ensureSessionShape(inc)); });
      break;
    }
    case "participant": {
      const s = findSession(msg.sessionId);
      if (msg.student && !findStudent(msg.student.id)) store.state.students.push(msg.student);
      if (s) {
        ensureSessionShape(s);
        if (!s.participants.includes(msg.studentId)) s.participants = [...s.participants, msg.studentId];
        store.set(st => st);
      }
      break;
    }
  }
});

// ── v1 호환 (다른 모듈 전환 중 로드 실패 방지용, 새 코드에서 사용 금지) ──
export async function cloudFetchTeacherByName(name) {
  if (!isCloud) return store.state.teachers.find(t => t.name === name) || null;
  const { data } = await supa.from("teachers").select(TEACHER_COLS).eq("name", name).maybeSingle();
  return data ? toTeacher(data) : null;
}
export async function cloudUpsertTeacher(t) { return t; }
export async function cloudUpsertStudent(s) { return isCloud ? cloudJoinStudent(s) : s; }
export async function cloudInsertLesson(l) { return cloudCreateLesson(l); }
export async function cloudUpsertSession(ss) { console.warn("[cloud] cloudUpsertSession은 v2에서 patchSession으로 대체"); }

// 디버깅용
window.__cloud = {
  get supa() { return supa; },
  supaClient, clientId, cloudEnabled, cloudReady,
  cloudFetchSession, patchSession, cloudFetchLessonSlides, cloudBootTeacher, applyRecord, mergeRec, fromStudent,
};
