// 임베드(embed) 슬라이드 (§6.4) — 붙여넣은 코드에서 첫 <iframe> 의 src 만 뽑아 sandbox iframe 으로 띄운다
// 가정: 추출한 src 는 http(s) 만 허용(javascript:/data: 등 거부). '//host/…' 는 https: 로 보정.
// 가정: src 속성 매칭은 명세 정규식보다 약간 엄격하게(data-src 등 제외) 한다.
import { el } from "../ui.js";
import { registerSlideType, injectCss } from "./registry.js";

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 8 4 12l4.5 4"/><path d="M15.5 8 20 12l-4.5 4"/><path d="M13.5 5.5l-3 13"/></svg>`;

const CSS = `
.md-embed{position:relative;width:100%;height:100%;min-height:240px;background:var(--surface);overflow:hidden}
.md-embed iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}
.md-embed > .empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.md-embed-edit{height:100%;overflow:auto;padding:24px;display:flex;flex-direction:column;gap:14px;max-width:820px;margin:0 auto;width:100%;box-sizing:border-box}
.md-embed-edit textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;resize:vertical;min-height:88px}
.md-embed-warn{color:var(--danger);font-size:13px}
.md-embed-warn:empty{display:none}
.md-embed-preview{position:relative;flex:1 1 auto;min-height:320px;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
`;
const ensureCss = (ctx) => (ctx?.injectCss || injectCss)("media-embed", CSS);

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

// 붙여넣은 html/주소 → 안전한 http(s) src | ''
export function extractEmbedSrc(input) {
  const s = String(input ?? "").trim();
  if (!s) return "";
  const m = s.match(/<iframe\b[^>]*?\ssrc\s*=\s*["']([^"']+)/i);
  let src = m ? decodeEntities(m[1]).trim() : (/^https?:\/\/\S+$/i.test(s) ? s : "");
  if (src.startsWith("//")) src = `https:${src}`;
  if (!/^https?:\/\//i.test(src)) return ""; // javascript: 등 거부
  try {
    const u = new URL(src);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.href;
  } catch { return ""; }
}

function srcOf(cfg) {
  return extractEmbedSrc(cfg?.src) || extractEmbedSrc(cfg?.html);
}

// 임베드 화면
export function embedView(src) {
  ensureCss();
  const root = el("div", { class: "md-embed" });
  if (!src) {
    root.appendChild(el("div", { class: "empty" }, "임베드할 내용이 없어요"));
    return root;
  }
  // 가정: 앱과 같은 출처의 src 는 sandbox 탈출을 막기 위해 allow-same-origin 을 뺀다(그 외는 명세 그대로).
  let sandbox = "allow-scripts allow-same-origin allow-popups allow-forms allow-presentation";
  try { if (new URL(src).origin === location.origin) sandbox = sandbox.replace("allow-same-origin ", ""); } catch { /* 무시 */ }
  root.appendChild(el("iframe", {
    src,
    title: "임베드",
    sandbox,
    allow: "autoplay; fullscreen; clipboard-write",
    allowfullscreen: true,
    referrerpolicy: "no-referrer-when-downgrade",
  }));
  return root;
}

function Editor({ slide, update, ctx }) {
  ensureCss(ctx);
  let cfg = { html: "", src: "", ...(slide.config || {}) };
  cfg.src = srcOf(cfg); // 미리보기는 화면과 같은 규칙으로(저장은 입력 시)
  const ta = el("textarea", { class: "input", rows: "4", placeholder: "<iframe …> 코드 또는 주소", spellcheck: "false" });
  ta.value = cfg.html || "";
  const warn = el("div", { class: "md-embed-warn" });
  const box = el("div", { class: "md-embed-preview" });
  let shown = null, t = null;

  function paint() {
    const html = String(cfg.html || "").trim();
    warn.textContent = html && !cfg.src ? "임베드 코드를 확인해 주세요" : "";
    if (cfg.src === shown) return;
    shown = cfg.src;
    box.replaceChildren(embedView(cfg.src));
  }

  ta.addEventListener("input", () => {
    const html = ta.value;
    cfg = { ...cfg, html, src: extractEmbedSrc(html) };
    update({ config: cfg });
    clearTimeout(t);
    t = setTimeout(paint, 500);
  });
  paint();

  const root = el("div", { class: "md-embed-edit" }, [el("div", { class: "field" }, [ta]), warn, box]);
  return { el: root, destroy() { clearTimeout(t); } };
}

function liveView({ slide, ctx }) {
  ensureCss(ctx);
  return { el: embedView(srcOf(slide.config)) };
}

registerSlideType({
  type: "embed",
  category: "media",
  label: "임베드",
  desc: "iframe 임베드 코드 붙여넣기",
  icon: ICON,
  create() { return { type: "embed", config: { html: "", src: "" } }; },
  Editor,
  Student: liveView,
  TeacherLive: liveView,
  summary(slide) {
    const src = srcOf(slide.config);
    return el("div", { class: "md-sum" }, src
      ? [el("a", { href: src, target: "_blank", rel: "noopener noreferrer" }, src)]
      : [el("div", { class: "empty" }, "임베드할 내용이 없어요")]);
  },
  validate(slide) {
    const html = String(slide.config?.html || "").trim();
    if (!html && !slide.config?.src) return "임베드 코드나 주소를 넣으세요";
    if (!srcOf(slide.config)) return "임베드 코드를 확인해 주세요";
    return null;
  },
});
