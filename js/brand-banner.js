// 상단 제작자 배너: 화면에 들어올 때 위에서 내려와 몇 초 뒤 사라진다.
// 왼쪽 = 인스타그램 아이디, 오른쪽 = '영욱T 제작' + 로고.
// 학생이 보는 화면(학생 화면·첫 화면)에서는 인스타 아이디만 보여 주고 링크는 걸지 않는다(수업 중 이탈 방지).
// 가정: 배너는 내용 위에 겹쳐 뜨되 링크 외에는 클릭을 통과시킨다(아래 상단 바 조작을 막지 않게).
//       자주 이동할 때 반복해서 뜨지 않도록 같은 역할(교사/학생) 안에서는 20초에 한 번만 보인다.
import { el } from "./ui.js";

const IG_URL = "https://www.instagram.com/sun_sunseng/";
const IG_ID = "sun_sunseng";
const LOGO = "assets/print-mark.png";
const SHOW_MS = 4200;
const COOLDOWN_MS = 20000;
const TEACHER_PATHS = ["/teacher", "/editor/", "/live/"];

const IG_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.4" cy="6.6" r="0.9" fill="currentColor" stroke="none"/></svg>';

const CSS = `
.bb{position:fixed;z-index:350;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;gap:12px;
  min-height:44px;padding:calc(var(--sat,0px) + 6px) max(16px,calc(var(--sar,0px) + 16px)) 6px max(16px,calc(var(--sal,0px) + 16px));
  background:rgba(255,255,255,.86);-webkit-backdrop-filter:saturate(1.4) blur(14px);backdrop-filter:saturate(1.4) blur(14px);
  border-bottom:1px solid var(--line);box-shadow:0 6px 24px rgba(20,20,30,.06);
  font:500 12.5px/1.2 var(--font);color:var(--ink-2);pointer-events:none;
  transform:translateY(-110%);opacity:0;transition:transform .6s cubic-bezier(.2,.8,.2,1),opacity .45s ease}
.bb.in{transform:none;opacity:1}
.bb.out{transform:translateY(-110%);opacity:0;transition-duration:.5s,.4s}
.bb-ig{display:inline-flex;align-items:center;gap:7px;min-height:32px;color:var(--ink-2);text-decoration:none;border-radius:999px;padding:0 10px 0 6px}
a.bb-ig{pointer-events:auto}
a.bb-ig:hover{background:var(--surface-2);color:var(--ink)}
a.bb-ig:focus-visible{outline:none;box-shadow:0 0 0 3px var(--accent-soft)}
.bb-ig b{color:var(--ink);font-weight:600;letter-spacing:.01em}
.bb-made{display:inline-flex;align-items:center;gap:9px;color:var(--ink);font-weight:600;letter-spacing:.04em}
.bb-made .bb-name{display:inline-block}
.bb-logo{width:30px;height:30px;border-radius:50%;background:#fff;border:1px solid var(--line);object-fit:cover;flex:none}
.bb-line{position:absolute;left:0;right:0;bottom:-1px;height:2px;background:var(--ink-brush,#1E293B);transform-origin:left;transform:scaleX(0);opacity:.75}
.bb.in .bb-line{animation:bbLine var(--bb-dur,4200ms) linear forwards}
.bb.in .bb-ig{animation:bbRise .55s .12s cubic-bezier(.2,.8,.2,1) both}
.bb.in .bb-name{animation:bbInk .8s .28s cubic-bezier(.2,.7,.2,1) both}
.bb.in .bb-logo{animation:bbPop .6s .45s cubic-bezier(.3,1.4,.5,1) both}
@keyframes bbLine{from{transform:scaleX(1)}to{transform:scaleX(0)}}
@keyframes bbRise{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@keyframes bbInk{0%{opacity:0;filter:blur(4px);-webkit-mask-position:100% 0;mask-position:100% 0}35%{opacity:1}100%{opacity:1;filter:blur(0);-webkit-mask-position:0 0;mask-position:0 0}}
.bb.in .bb-name{-webkit-mask-image:linear-gradient(90deg,#000 45%,transparent 55%);mask-image:linear-gradient(90deg,#000 45%,transparent 55%);-webkit-mask-size:260% 100%;mask-size:260% 100%}
@keyframes bbPop{0%{opacity:0;transform:scale(.6) rotate(-12deg)}100%{opacity:1;transform:none}}
@media (max-width:420px){.bb{font-size:12px}.bb-ig .bb-label{display:none}}
@media (prefers-reduced-motion:reduce){.bb,.bb.out{transform:none;transition:opacity .25s ease}.bb.in .bb-ig,.bb.in .bb-name,.bb.in .bb-logo{animation:none}.bb.in .bb-line{animation:none;transform:scaleX(0)}}
@media print{.bb{display:none!important}}
`;

let root = null, timer = null, hideTimer = null, lastPath = null;
const lastShown = { teacher: 0, student: 0 };

function ensure() {
  if (root && root.isConnected) return root;
  if (!document.querySelector("style[data-bb]")) {
    const st = document.createElement("style");
    st.dataset.bb = "1";
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  root = el("div", { class: "bb", role: "note", "aria-label": "제작자 정보" });
  root.style.setProperty("--bb-dur", SHOW_MS + "ms");
  document.body.appendChild(root);
  // 교사 화면: 마우스를 올리면 사라지지 않고 기다림
  root.addEventListener("pointerenter", () => { if (root.classList.contains("in")) clearTimeout(timer); });
  root.addEventListener("pointerleave", () => { if (root.classList.contains("in")) schedule(1500); });
  return root;
}

function content(student) {
  const ig = student
    ? el("span", { class: "bb-ig", title: "인스타그램" }, [el("span", { html: IG_SVG }), el("b", {}, IG_ID)])
    : el("a", { class: "bb-ig", href: IG_URL, target: "_blank", rel: "noopener noreferrer", title: "인스타그램에서 보기" },
        [el("span", { html: IG_SVG }), el("b", {}, IG_ID), el("span", { class: "bb-label" }, "인스타그램")]);
  const made = el("span", { class: "bb-made" }, [
    el("span", { class: "bb-name" }, "영욱T 제작"),
    el("img", { class: "bb-logo", src: LOGO, alt: "", width: "30", height: "30", decoding: "async" }),
  ]);
  return [ig, made, el("span", { class: "bb-line" })];
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(hide, ms);
}
function hide() {
  if (!root) return;
  root.classList.remove("in");
  root.classList.add("out");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (root) root.classList.remove("out"); }, 600);
}

export function showBrandBanner({ student = false } = {}) {
  const r = ensure();
  clearTimeout(timer); clearTimeout(hideTimer);
  r.classList.remove("in", "out");
  r.replaceChildren(...content(student));
  void r.offsetWidth; // 시작 위치를 먼저 반영해야 내려오는 전환이 보인다
  r.classList.add("in");
  schedule(SHOW_MS);
}

// 백그라운드 탭으로 열렸다면 화면에 보일 때 보여 준다(안 보는 사이에 사라지지 않게)
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

// 라우트가 바뀔 때마다(쿨다운 내 반복 제외) 잠깐 보여 준다
export function initBrandBanner() {
  const onRoute = () => {
    const p = currentPath();
    if (p === lastPath) return;
    lastPath = p;
    // 링크는 교사 전용 화면에서만. 첫 화면('/')처럼 학생도 보는 화면은 아이디만 보여 준다.
    const student = !TEACHER_PATHS.some(t => p.startsWith(t));
    const role = student ? "student" : "teacher";
    const now = Date.now();
    if (lastShown[role] && now - lastShown[role] < COOLDOWN_MS) {
      // 쿨다운 중이라도 역할이 바뀌어 링크 여부가 달라졌으면 떠 있는 배너 내용만 맞춘다
      if (root && root.classList.contains("in")) root.replaceChildren(...content(student));
      return;
    }
    lastShown[role] = now;
    whenVisible(() => { if (currentPath() === p) showBrandBanner({ student }); });
  };
  window.addEventListener("hashchange", onRoute);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", onRoute, { once: true });
  else onRoute();
}
