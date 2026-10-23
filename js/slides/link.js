// 웹 링크(link) 슬라이드 (§6.4) — 전체 영역 iframe + 우상단 '새 탭에서 열기', 3초 내 load 없으면 큰 '열기' 버튼
// 가정: 외부 페이지가 앱 전체를 이동시키지 못하도록 iframe 에 sandbox(allow-top-navigation 제외)를 건다.
// 가정: http(s) 가 아닌 주소는 mailto:/tel: 만 '열기' 링크로 허용, 그 외(javascript: 등)는 '주소를 확인해 주세요'.
import { el } from "../ui.js";
import { registerSlideType, injectCss } from "./registry.js";
import { withProtocol, isHttpUrl } from "./video.js";

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/></svg>`;

const CSS = `
.md-link{position:relative;width:100%;height:100%;min-height:240px;background:var(--surface);overflow:hidden}
.md-link iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:var(--surface)}
.md-link a.btn{text-decoration:none}
.md-newtab{position:absolute;top:10px;right:10px;z-index:2;background:var(--surface);box-shadow:var(--shadow-1)}
.md-link-fallback{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center}
.md-link-fallback h2{margin:0;font-size:clamp(20px,3vw,30px);line-height:1.35;word-break:keep-all;overflow-wrap:anywhere}
.md-link-host{color:var(--muted);font-size:14px;overflow-wrap:anywhere}
.md-link-open{min-width:160px}
.md-link-preview{position:relative;flex:1 1 auto;min-height:320px;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
`;
const ensureCss = (ctx) => (ctx?.injectCss || injectCss)("media-link", CSS);

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}
// 가정: 앱과 같은 출처의 주소는 sandbox 탈출을 막기 위해 allow-same-origin 을 뺀다.
const SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-presentation";
function sandboxFor(url) {
  try { if (new URL(url).origin === location.origin) return SANDBOX.replace("allow-same-origin ", ""); } catch { /* 무시 */ }
  return SANDBOX;
}
// https 페이지에서 http 주소는 iframe 이 차단된다(mixed content) → 바로 '열기'
// 가정: 이 경우 3초를 기다리지 않고 즉시 열기 버튼을 보여 준다.
function blockedMixed(url) {
  try { return location.protocol === "https:" && /^http:/i.test(url); } catch { return false; }
}
function safeHref(url) {
  if (isHttpUrl(url)) return url;
  return /^(mailto|tel):/i.test(url) ? url : "";
}

// 링크 화면 → { el, setTitle(t), destroy() }
export function linkView(cfg = {}) {
  ensureCss();
  const url = withProtocol(cfg.url);
  const root = el("div", { class: "md-link" });
  let title = String(cfg.title || "").trim();
  let timer = null, frame = null, fbTitle = null;

  const shownTitle = () => title || hostOf(url) || "웹 링크";

  function fallback() {
    if (timer) { clearTimeout(timer); timer = null; }
    const href = safeHref(url);
    if (!href) { root.replaceChildren(el("div", { class: "md-link-fallback" }, [el("div", { class: "empty" }, "주소를 확인해 주세요")])); return; }
    fbTitle = el("h2", {}, shownTitle());
    root.replaceChildren(el("div", { class: "md-link-fallback" }, [
      fbTitle,
      hostOf(href) ? el("div", { class: "md-link-host" }, hostOf(href)) : null,
      el("a", { class: "btn btn-primary btn-lg md-link-open", href, target: "_blank", rel: "noopener noreferrer" }, "열기"),
    ]));
    frame = null;
  }

  if (!url) {
    root.appendChild(el("div", { class: "md-link-fallback" }, [el("div", { class: "empty" }, "링크가 없어요")]));
  } else if (!isHttpUrl(url) || blockedMixed(url)) {
    fallback();
  } else {
    let loaded = false;
    frame = el("iframe", {
      src: url,
      title: shownTitle(),
      sandbox: sandboxFor(url),
      allow: "autoplay; fullscreen; clipboard-write",
      allowfullscreen: true,
      referrerpolicy: "no-referrer-when-downgrade",
    });
    frame.addEventListener("load", () => { loaded = true; if (timer) { clearTimeout(timer); timer = null; } });
    root.append(
      frame,
      el("a", { class: "btn btn-sm md-newtab", href: url, target: "_blank", rel: "noopener noreferrer" }, "새 탭에서 열기"),
    );
    timer = setTimeout(() => { timer = null; if (!loaded) fallback(); }, 3000);
  }

  return {
    el: root,
    setTitle(t) {
      title = String(t || "").trim();
      if (fbTitle) fbTitle.textContent = shownTitle();
      if (frame) frame.title = shownTitle();
    },
    destroy() { if (timer) { clearTimeout(timer); timer = null; } },
  };
}

function Editor({ slide, update, ctx }) {
  ensureCss(ctx);
  let cfg = { url: "", title: "", ...(slide.config || {}) };
  const urlIn = el("input", { class: "input", type: "text", inputmode: "url", placeholder: "https://", autocomplete: "off", spellcheck: "false" });
  urlIn.value = cfg.url || "";
  const titleIn = el("input", { class: "input", type: "text", placeholder: "제목", maxlength: "80" });
  titleIn.value = cfg.title || "";
  const box = el("div", { class: "md-link-preview" });
  let view = null, shownUrl = null, t = null;

  function renderPreview() {
    const u = withProtocol(cfg.url);
    if (u === shownUrl) return;
    shownUrl = u;
    view?.destroy();
    view = linkView(cfg);
    box.replaceChildren(view.el);
  }
  const save = () => update({ config: cfg });

  urlIn.addEventListener("input", () => {
    cfg = { ...cfg, url: urlIn.value.trim() };
    save();
    clearTimeout(t);
    t = setTimeout(renderPreview, 700);
  });
  // 포커스가 빠지면 https:// 보정
  urlIn.addEventListener("change", () => {
    const fixed = withProtocol(urlIn.value);
    if (fixed !== cfg.url) { cfg = { ...cfg, url: fixed }; urlIn.value = fixed; save(); }
  });
  titleIn.addEventListener("input", () => {
    cfg = { ...cfg, title: titleIn.value };
    save();
    view?.setTitle(cfg.title);
  });
  renderPreview();

  const root = el("div", { class: "md-edit" }, [
    el("div", { class: "field" }, [urlIn]),
    el("div", { class: "field" }, [titleIn]),
    box,
  ]);
  return { el: root, destroy() { clearTimeout(t); view?.destroy(); } };
}

function liveView({ slide, ctx }) {
  ensureCss(ctx);
  const v = linkView(slide.config || {});
  return { el: v.el, destroy() { v.destroy(); } };
}

registerSlideType({
  type: "link",
  category: "media",
  label: "웹 링크",
  desc: "웹 페이지 띄우기",
  icon: ICON,
  create() { return { type: "link", config: { url: "", title: "" } }; },
  thumb(slide) {
    const url = withProtocol(slide.config?.url);
    return el("div", { class: "thumb-generic" }, [
      el("span", { class: "thumb-icon", html: ICON }),
      el("span", { class: "thumb-title" }, String(slide.config?.title || "").trim() || hostOf(url) || slide.title || "웹 링크"),
    ]);
  },
  Editor,
  Student: liveView,
  TeacherLive: liveView,
  summary(slide) {
    const url = withProtocol(slide.config?.url);
    const href = safeHref(url);
    const label = String(slide.config?.title || "").trim() || url;
    return el("div", { class: "md-sum" }, href
      ? [el("a", { href, target: "_blank", rel: "noopener noreferrer" }, label)]
      : [el("div", { class: "empty" }, "링크가 없어요")]);
  },
  validate(slide) {
    const raw = String(slide.config?.url || "").trim();
    if (!raw) return "주소를 입력하세요";
    if (!safeHref(withProtocol(raw))) return "주소를 확인해 주세요";
    return null;
  },
});
