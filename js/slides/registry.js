// 슬라이드 타입 레지스트리 — 코어(teacher.js / student.js / host.js)와 플러그인(js/slides/*.js)의 유일한 접점.
// 계약 전문은 docs/ARCHITECTURE.md §6. 플러그인은 모듈 로드 시 registerSlideType()으로 자기 등록한다.
//
// def = {
//   type: 'mcq',                 // 고유 키 (slide.type)
//   category: 'basic' | 'interact' | 'media' | 'game',
//   label: '객관식', desc: '한 줄 설명(title 속성용)', icon: '<svg viewBox="0 0 24 24" …>',  // 24px stroke SVG
//   create()                      → Slide { config 기본값 ... }  (id·type·title 은 createSlide 가 채움)
//   thumb?(slide)                 → HTMLElement  (편집기 레일·자료 카드의 작은 미리보기, 없으면 아이콘+제목)
//   Editor({ slide, lesson, update, ctx })          → { el, destroy?, inspector?: HTMLElement }
//       update(patch): 코어가 Object.assign(slide, patch) 얕은 병합 + 300ms 디바운스 저장.
//       config 를 바꿀 땐 전체 객체로: update({ config: { ...slide.config, question } })
//       inspector: 코어 인스펙터(제목 아래)에 붙는 타입별 설정 영역 (선택)
//   Student({ slide, session, me, ctx })             → { el, destroy?, onActivity?, onResponses?, onSession? }
//   TeacherLive({ slide, session, ctx })             → { el, destroy?, onActivity?, onResponses?, onSession?, panel?, actions? }
//       panel: 수업 진행 오른쪽 '도구' 패널에 들어갈 조작(마감·정답 공개·타이머·응답자 등). 있을 때만 레일에 '도구'가 보인다.
//       actions: 코어 화면이 부르는 동작 { 이름: fn } (예: ink { groups } = 상단 바 [모둠] 버튼이 모둠 편성 창을 연다)
//   summary?(slide, responses, session, ctx)         → HTMLElement  (기록 화면·인쇄, 읽기 전용)
//   validate?(slide)                                 → string | null  (편집기 경고 문구, 시작 시에도 표시)
// }
//
// 훅 의미 (host.js 가 호출):
//   onActivity(state)   session.activity[slide.id] 가 바뀌었을 때 (JSON 비교. phase/reveal/endsAt/타입별 필드)
//   onResponses(list)   이 슬라이드의 응답 목록이 바뀌었을 때 (전체 목록을 다시 넘김)
//   onSession(session)  그 밖의 모든 세션 변경 (groups, participants, flow 등) — 싸고 멱등이어야 함
// 코어는 `${slide.id}|${role}` 키가 같으면 el 을 보존하고 훅만 호출한다. 키가 바뀌면 destroy() 후 재마운트.

export const CATEGORIES = [
  { id: "basic", label: "기본" },
  { id: "interact", label: "상호작용" },
  { id: "media", label: "미디어" },
  { id: "game", label: "게임" },
];

const registry = new Map();

export function registerSlideType(def) {
  if (!def || !def.type) throw new Error("registerSlideType: type 이 필요합니다");
  for (const k of ["create", "Editor", "Student", "TeacherLive"]) {
    if (typeof def[k] !== "function") throw new Error(`registerSlideType(${def.type}): ${k}() 누락`);
  }
  registry.set(def.type, { thumb: defaultThumb, summary: null, ...def });
}

export function getSlideType(type) {
  return registry.get(type) || registry.get("unknown") || UNKNOWN;
}

export function hasSlideType(type) { return registry.has(type); }

// 카테고리 순, 등록 순
export function listSlideTypes() {
  const order = Object.fromEntries(CATEGORIES.map((c, i) => [c.id, i]));
  return [...registry.values()].filter(d => d.type !== "unknown").sort((a, b) => (order[a.category] ?? 9) - (order[b.category] ?? 9));
}

// 새 슬라이드 생성 (id 는 코어 규칙: store.newId("slide") 와 동일 형식)
export function createSlide(type, extra = {}) {
  const def = getSlideType(type);
  const s = def.create();
  s.id ||= newId("slide");
  s.type ||= type;
  s.title ??= def.label;
  s.config ??= {};
  return Object.assign(s, extra);
}

export function newId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36)}`;
}

// 타입별 CSS 1회 주입 (ctx.injectCss 가 이걸 호출)
const injected = new Set();
export function injectCss(key, cssText) {
  if (injected.has(key)) return;
  injected.add(key);
  const st = document.createElement("style");
  st.dataset.slideType = key;
  st.textContent = cssText;
  document.head.appendChild(st);
}

// ── 공용 헬퍼 (플러그인 작성용) ──
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
export function fmtMs(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  const s = ms / 1000;
  return s >= 60 ? `${Math.floor(s / 60)}:${String((s % 60).toFixed(1)).padStart(4, "0")}` : `${s.toFixed(1)}초`;
}
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 필기 모드 읽기는 반드시 이 함수로 (수업 중 전환은 activity[slideId].mode, 스냅샷은 불변)
export function effectiveMode(slide, session) {
  if (!slide) return "none";
  return session?.activity?.[slide.id]?.mode ?? slide.mode ?? "none";
}

// 유튜브 주소 → 영상 id (watch?v=, youtu.be/, shorts/, embed/, live/, 11자 id 단독)
export function parseYouTubeId(url) {
  const s = String(url ?? "").trim();
  if (!s) return null;
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, "");
  const ok = id => (id && /^[\w-]{11}$/.test(id) ? id : null);
  if (host === "youtu.be") return ok(u.pathname.split("/")[1]);
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const v = u.searchParams.get("v");
    if (v) return ok(v);
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v|e)\/([\w-]{11})/);
    return m ? m[1] : null;
  }
  return null;
}

// 랜덤 조 편성: g = ceil(n/max), 앞 n%g 조는 floor(n/g)+1명
// 7→[4,3], 5→[3,2], 9→[3,3,3], 10→[4,3,3]
export function groupStudents(ids, maxSize = 4) {
  const list = shuffle([...new Set((ids || []).filter(Boolean))]);
  const n = list.length;
  if (!n) return [];
  const max = Math.max(1, Math.floor(maxSize) || 4);
  const g = Math.ceil(n / max);
  const base = Math.floor(n / g), extra = n % g;
  const out = [];
  let i = 0;
  for (let k = 0; k < g; k++) {
    const size = base + (k < extra ? 1 : 0);
    out.push(list.slice(i, i + size));
    i += size;
  }
  return out;
}

function defaultThumb(slide) {
  const def = getSlideType(slide.type);
  const d = document.createElement("div");
  d.className = "thumb-generic";
  d.innerHTML = `<span class="thumb-icon">${def.icon || ""}</span><span class="thumb-title"></span>`;
  d.querySelector(".thumb-title").textContent = slide.title || def.label;
  return d;
}

// 알 수 없는 타입 (구버전 데이터·미등록 모듈) — 코어가 절대 죽지 않도록
const UNKNOWN = {
  type: "unknown", category: "basic", label: "지원하지 않는 슬라이드", desc: "", icon: "",
  create() { return { type: "unknown", config: {} }; },
  thumb: defaultThumb,
  Editor() { return { el: msg("이 슬라이드 타입은 지원하지 않습니다.") }; },
  Student() { return { el: msg("선생님이 다음 슬라이드로 넘어갈 때까지 기다려 주세요.") }; },
  TeacherLive() { return { el: msg("이 슬라이드 타입은 지원하지 않습니다.") }; },
};
function msg(t) { const d = document.createElement("div"); d.className = "empty"; d.textContent = t; return d; }
