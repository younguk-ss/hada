// 작은 해시 라우터 — 라우트 핸들러는 cleanup 함수를 반환한다
const routes = {};
let currentCleanup = null;
let dispatchSeq = 0; // 비동기 핸들러가 늦게 끝났을 때 이미 다른 화면인지 판별

export function route(pattern, render) {
  routes[pattern] = render;
}

// 같은 해시로 이동해도 다시 그린다 (v1: 두 번째 '시작' 무반응 버그)
export function go(path, { replace = false } = {}) {
  const target = "#" + path;
  if (location.hash === target) { dispatch(); return; }
  if (replace) {
    history.replaceState(null, "", target);
    dispatch();
    return;
  }
  location.hash = target;
}

export function currentPath() {
  return parseHash().path;
}

function parseHash() {
  const raw = (location.hash || "#/").slice(1);
  const [path, qs] = raw.split("?");
  const params = {};
  if (qs) qs.split("&").forEach(p => {
    if (!p) return;
    const i = p.indexOf("=");
    const k = i < 0 ? p : p.slice(0, i), v = i < 0 ? "" : p.slice(i + 1);
    try { params[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " ")); } catch (_) { params[k] = v; }
  });
  return { path: path || "/", params };
}

// 가정: async 핸들러(Promise<cleanup>)도 허용. 끝나기 전에 화면이 바뀌었으면 받은 cleanup을 즉시 호출.
function run(handler, params) {
  const seq = dispatchSeq;
  try {
    const c = handler(params);
    if (c && typeof c.then === "function") {
      currentCleanup = null;
      c.then(fn => {
        if (typeof fn !== "function") return;
        if (seq === dispatchSeq) currentCleanup = fn;
        else try { fn(); } catch (e) { console.warn("[router] cleanup 오류:", e); }
      }, e => console.error("[router] 화면 오류:", e));
      return;
    }
    currentCleanup = typeof c === "function" ? c : null;
  } catch (e) {
    console.error("[router] 화면 오류:", e);
    currentCleanup = null;
  }
}

function dispatch() {
  const { path, params } = parseHash();
  dispatchSeq++;
  if (currentCleanup) try { currentCleanup(); } catch (e) { console.warn("[router] cleanup 오류:", e); }
  currentCleanup = null;

  // 정확히 일치
  const exact = routes[path];
  if (exact) { run(exact, params); return; }
  // `:id` 패턴
  for (const pattern of Object.keys(routes)) {
    if (!pattern.includes(":")) continue;
    const pParts = pattern.split("/");
    const aParts = path.split("/");
    if (pParts.length !== aParts.length) continue;
    const m = {};
    let ok = true;
    for (let i = 0; i < pParts.length; i++) {
      if (pParts[i].startsWith(":")) m[pParts[i].slice(1)] = decodeURIComponent(aParts[i]);
      else if (pParts[i] !== aParts[i]) { ok = false; break; }
    }
    if (ok) { run(routes[pattern], { ...m, ...params }); return; }
  }
  // 기본
  if (routes["/"]) run(routes["/"], {});
}

window.addEventListener("hashchange", dispatch);
export function start() { if (!location.hash) location.hash = "#/"; dispatch(); }
