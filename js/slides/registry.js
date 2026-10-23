// 슬라이드 타입 레지스트리 — 코어(teacher.js / student.js / host.js)와 플러그인(js/slides/*.js)의 유일한 접점.
// 계약 전문은 docs/ARCHITECTURE.md §6. 플러그인은 모듈 로드 시 registerSlideType()으로 자기 등록한다.
//
// def = {
//   type: 'mcq',                 // 고유 키 (slide.type)
//   category: 'basic' | 'interact' | 'media' | 'game',
//   label: '객관식 퀴즈', desc: '한 줄 설명', icon: '<svg viewBox="0 0 24 24" …>',
//   create()                      → Slide { id, type, title, config, ... }
//   thumb(slide)                  → HTMLElement  (편집기 레일·자료 카드의 작은 미리보기)
//   Editor({ slide, lesson, update, ctx })          → { el, destroy? }
//   Student({ slide, session, me, ctx })             → { el, destroy?, onActivity?, onResponses?, onSession? }
//   TeacherLive({ slide, session, ctx })             → { el, destroy?, onActivity?, onResponses?, onSession?, panel? }
//   summary?(slide, responses, session)              → HTMLElement  (기록 화면·인쇄)
// }
//
// 훅 의미:
//   onActivity(state)   sessions.activity[slide.id] 가 바뀌었을 때 (phase/reveal/타입별 필드)
//   onResponses(list)   이 슬라이드의 응답 목록이 바뀌었을 때 (전체 목록을 다시 넘김)
//   onSession(session)  세션 객체가 교체됐을 때 (groups, participants, flow 등)
// 코어는 (slideId, role, scope) 키가 같으면 el 을 보존하고 훅만 호출한다. 키가 바뀌면 destroy() 후 재마운트.

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
