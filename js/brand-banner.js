// 상단 제작자 워터마크: 왼쪽 = 인스타그램 아이디, 오른쪽 = '영욱T 제작' + 로고.
// 자리: 모든 화면이 위쪽 여백에 --sat(= 기기 안전 영역 + --bb-h)를 쓰므로, 워터마크는 내용을 가리지 않는 빈 줄에 놓인다.
// 스크롤해서 내용이 그 줄 아래로 지나가면 유리처럼 반투명해져 아래 내용이 비치고, 몇 초 안에 위로 사라진다.
// 맨 위로 돌아오면 다시 제자리에 보인다.
// 학생이 보는 화면(학생 화면·첫 화면)에서는 인스타 아이디만 보여 주고 링크는 걸지 않는다(수업 중 이탈 방지).
// 가정: 링크 외에는 클릭을 통과시키고, 들어오는 모션은 같은 역할(교사/학생) 안에서 20초에 한 번만 재생한다.
import { el } from "./ui.js";

const IG_URL = "https://www.instagram.com/sun_sunseng/";
const IG_ID = "sun_sunseng";
const LOGO = "assets/print-mark.png";
const GLASS_MS = 2600;        // 스크롤 중 유리 상태로 머무는 시간
const ENTER_COOLDOWN_MS = 20000;
const TOP_EPS = 4;            // 이만큼 이하면 '맨 위'
const TEACHER_PATHS = ["/teacher", "/editor/", "/live/"];

const IG_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.4" cy="6.6" r="0.9" fill="currentColor" stroke="none"/></svg>';

const CSS = `
.bb{position:fixed;z-index:350;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;gap:12px;
  height:calc(var(--sat0,0px) + var(--bb-h,34px));
  padding:var(--sat0,0px) max(14px,calc(var(--sar,0px) + 14px)) 0 max(14px,calc(var(--sal,0px) + 14px));
  font:500 12px/1.2 var(--font);color:var(--muted);pointer-events:none;isolation:isolate;
  transition:transform .55s cubic-bezier(.2,.8,.2,1),opacity .45s ease}
.bb.glass .bb-ig b,.bb.glass .bb-made{color:var(--ink)}
.bb.gone{transform:translateY(-100%);opacity:0}
/* 유리: 아래 내용이 흐리게 비치는 반투명 판 + 위쪽 빛 반사 */
.bb::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;
  background:linear-gradient(180deg,rgba(255,255,255,.66),rgba(255,255,255,.34));
  -webkit-backdrop-filter:blur(16px) saturate(1.8);backdrop-filter:blur(16px) saturate(1.8);
  border-bottom:1px solid rgba(255,255,255,.6);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.85),inset 0 -1px 0 rgba(30,41,59,.07),0 10px 30px rgba(20,20,30,.08);
  opacity:0;transition:opacity .3s ease}
.bb.glass::before{opacity:1}
.bb::after{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;opacity:0;
  background:linear-gradient(100deg,transparent 35%,rgba(255,255,255,.7) 50%,transparent 65%);background-size:260% 100%}
.bb.glass::after{animation:bbSheen 1.3s .05s ease-out both}
.bb-ig{display:inline-flex;align-items:center;gap:6px;min-height:26px;color:inherit;text-decoration:none;border-radius:999px;padding:0 8px 0 4px;margin-left:-4px}
a.bb-ig{pointer-events:auto}
a.bb-ig:hover{background:var(--surface-2);color:var(--ink)}
a.bb-ig:focus-visible{outline:none;box-shadow:0 0 0 3px var(--accent-soft)}
.bb-ig b{color:var(--ink-2);font-weight:600;letter-spacing:.01em}
.bb-made{display:inline-flex;align-items:center;gap:8px;color:var(--ink-2);font-weight:600;letter-spacing:.04em}
.bb-made .bb-name{display:inline-block}
.bb-logo{width:24px;height:24px;border-radius:50%;background:#fff;border:1px solid var(--line);object-fit:cover;flex:none}
.bb-line{position:absolute;left:0;right:0;bottom:-1px;height:2px;background:var(--ink-brush,#1E293B);transform-origin:left;transform:scaleX(0);opacity:.6}
.bb.glass:not(.gone) .bb-line{animation:bbLine ${GLASS_MS}ms linear forwards}
.bb.enter .bb-ig{animation:bbRise .55s .1s cubic-bezier(.2,.8,.2,1) both}
.bb.enter .bb-name{animation:bbInk .8s .25s cubic-bezier(.2,.7,.2,1) both;
  -webkit-mask-image:linear-gradient(90deg,#000 45%,transparent 55%);mask-image:linear-gradient(90deg,#000 45%,transparent 55%);-webkit-mask-size:260% 100%;mask-size:260% 100%}
.bb.enter .bb-logo{animation:bbPop .6s .45s cubic-bezier(.3,1.4,.5,1) both}
@keyframes bbLine{from{transform:scaleX(1)}to{transform:scaleX(0)}}
@keyframes bbSheen{0%{opacity:1;background-position:120% 0}100%{opacity:0;background-position:-20% 0}}
@keyframes bbRise{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@keyframes bbInk{0%{opacity:0;filter:blur(4px);-webkit-mask-position:100% 0;mask-position:100% 0}35%{opacity:1}100%{opacity:1;filter:blur(0);-webkit-mask-position:0 0;mask-position:0 0}}
@keyframes bbPop{0%{opacity:0;transform:scale(.6) rotate(-12deg)}100%{opacity:1;transform:none}}
@media (max-width:420px){.bb{font-size:11.5px}.bb-ig .bb-label{display:none}.bb-logo{width:22px;height:22px}}
@media (prefers-reduced-motion:reduce){.bb.gone{transform:none}.bb.enter .bb-ig,.bb.enter .bb-name,.bb.enter .bb-logo,.bb.glass::after{animation:none}.bb.glass .bb-line{animation:none}}
@media print{.bb{display:none!important}}
`;

let root = null, hideTimer = null, lastPath = null, lastStudent = null, scrolled = false;
const lastEnter = { teacher: 0, student: 0 };
const lastY = new WeakMap();

function ensure() {
  if (root && root.isConnected) return root;
  if (!document.querySelector("style[data-bb]")) {
    const st = document.createElement("style");
    st.dataset.bb = "1";
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  root = el("div", { class: "bb", role: "note", "aria-label": "제작자 정보" });
  document.body.appendChild(root);
  // 유리 상태에서 링크에 마우스를 올리면 사라지지 않고 기다림
  root.addEventListener("pointerenter", () => { if (root.classList.contains("glass")) clearTimeout(hideTimer); });
  root.addEventListener("pointerleave", () => { if (root.classList.contains("glass") && !root.classList.contains("gone")) scheduleGone(1200); });
  return root;
}

function content(student) {
  const ig = student
    ? el("span", { class: "bb-ig", title: "인스타그램" }, [el("span", { html: IG_SVG }), el("b", {}, IG_ID)])
    : el("a", { class: "bb-ig", href: IG_URL, target: "_blank", rel: "noopener noreferrer", title: "인스타그램에서 보기" },
        [el("span", { html: IG_SVG }), el("b", {}, IG_ID), el("span", { class: "bb-label" }, "인스타그램")]);
  const made = el("span", { class: "bb-made" }, [
    el("span", { class: "bb-name" }, "영욱T 제작"),
    el("img", { class: "bb-logo", src: LOGO, alt: "", width: "24", height: "24", decoding: "async" }),
  ]);
  return [ig, made, el("span", { class: "bb-line" })];
}

function render(student, animate) {
  const r = ensure();
  r.replaceChildren(...content(student));
  r.classList.remove("enter");
  if (animate) { void r.offsetWidth; r.classList.add("enter"); }
}

function scheduleGone(ms) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => root && root.classList.add("gone"), ms);
}

// 내용이 워터마크 줄 아래로 들어가면 유리 → 몇 초 뒤 사라짐. 맨 위로 오면 제자리.
function setScrolled(on, force = false) {
  if (!root || (on === scrolled && !force)) return;
  scrolled = on;
  clearTimeout(hideTimer);
  if (on) {
    root.classList.remove("gone");
    root.classList.add("glass");
    scheduleGone(GLASS_MS);
  } else {
    root.classList.remove("glass", "gone");
  }
}

function onScroll(e) {
  if (!root) return;
  const t = e.target;
  let key, y;
  if (t === document || t === document.documentElement || t === document.body) {
    key = document; y = window.scrollY;
  } else if (t instanceof Element) {
    // 워터마크 줄보다 아래에서 시작하는 안쪽 스크롤(드로어·슬라이드 목록 등)은 그 줄과 겹치지 않으니 무시
    if (t.getBoundingClientRect().top >= root.offsetHeight) return;
    key = t; y = t.scrollTop;
  } else return;
  if (lastY.get(key) === y) return; // 가로 스크롤만 바뀐 경우
  lastY.set(key, y);
  setScrolled(y > TOP_EPS);
}

// 백그라운드 탭으로 열렸다면 화면에 보일 때 실행(안 보는 사이에 모션이 끝나지 않게)
function whenVisible(fn) {
  if (!document.hidden) return fn();
  document.addEventListener("visibilitychange", function once() {
    if (document.hidden) return;
    document.removeEventListener("visibilitychange", once);
    fn();
  });
}

function currentPath() {
  return ((location.hash || "#/").slice(1).split("?")[0]) || "/";
}

export function initBrandBanner() {
  const onRoute = () => {
    const p = currentPath();
    if (p === lastPath) return;
    lastPath = p;
    // 링크는 교사 전용 화면에서만. 첫 화면('/')처럼 학생도 보는 화면은 아이디만 보여 준다.
    const student = !TEACHER_PATHS.some(t => p.startsWith(t));
    const role = student ? "student" : "teacher";
    const now = Date.now();
    const animate = !lastEnter[role] || now - lastEnter[role] >= ENTER_COOLDOWN_MS;
    if (animate) {
      lastEnter[role] = now;
      lastStudent = student;
      ensure();
      whenVisible(() => { if (currentPath() === p) render(student, true); });
    } else if (student !== lastStudent) {
      lastStudent = student;
      render(student, false);
    }
    // 새 화면은 맨 위에서 시작
    ensure();
    setScrolled(window.scrollY > TOP_EPS, true);
  };
  window.addEventListener("hashchange", onRoute);
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", onRoute, { once: true });
  else onRoute();
}
