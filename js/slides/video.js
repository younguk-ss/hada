// 동영상(video) 슬라이드 + 미디어 공용 헬퍼(플레이어·주소 보정·시간 표기) — videoquiz.js 도 사용 (§6.4)
// 가정: YouTube 가 아니면 경로 확장자가 mp4/webm/m4v/mov/ogv/ogg 인 http(s) 주소만 <video> 로 재생한다. 그 외는 미지원.
// 가정: 플레이어는 16:9 고정, 스테이지 안에서 contain(컨테이너 쿼리 단위) 로 맞춘다.
// 가정: YT.Player 는 el 이 문서에 붙은 뒤에 만든다(붙을 때까지 100ms 간격 대기, 최대 10초).
// 가정(v2.17): 재생 방식 = 수업 중 바꾼 값(activity.playMode) > 편집기 설정(config.playMode) > 기본 'teacher'.
//       'teacher'(교사 재생) → 학생 화면에는 플레이어 없이 '칠판의 영상을 봐주세요'. 'student'(학생 재생) → 학생도 각자 플레이어.
//       자유 이동(session.flow 'student')·복습에서는 교사가 화면을 이끌지 않으니 늘 학생 재생(videoquiz 와 같은 규칙).
//       교사 재생으로 바꾸면 학생 플레이어를 없애므로 학생 화면에서 돌던 영상도 멈춘다.
import { el, icon } from "../ui.js";
import { registerSlideType, parseYouTubeId, injectCss } from "./registry.js";
import { loadYouTubeApi } from "./common.js";
import { seg, field } from "./mcq.js";

export const VIDEO_UNSUPPORTED = "유튜브 또는 mp4 주소만 지원해요";

// ── 주소 헬퍼 ──
// 프로토콜 없으면 https:// 보정 (javascript:/mailto: 같은 스킴은 그대로 두고 호출부가 판단)
export function withProtocol(url) {
  const s = String(url ?? "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return `https:${s}`;
  if (/^(mailto|tel):/i.test(s)) return s; // tel:010… 은 숫자로 시작해도 스킴
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return s;
  return `https://${s}`;
}

export function isHttpUrl(s) {
  try {
    const u = new URL(String(s ?? ""));
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch { return false; }
}

// → { kind:'youtube', id } | { kind:'file', src } | null
export function videoSource(url) {
  const s = String(url ?? "").trim();
  if (!s) return null;
  const id = parseYouTubeId(s);
  if (id) return { kind: "youtube", id };
  const u = withProtocol(s);
  if (!isHttpUrl(u)) return null;
  try {
    if (/\.(mp4|webm|m4v|mov|ogv|ogg)$/i.test(new URL(u).pathname)) return { kind: "file", src: u };
  } catch { /* 무시 */ }
  return null;
}

// 초 → m:ss (1시간 이상 h:mm:ss)
export function fmtSec(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const p = n => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

// 'm:ss' | 'h:mm:ss' | '83' → 초, 형식 오류면 null
export function parseSec(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.floor(Number(t));
  const m = t.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]), c = m[3] != null ? Number(m[3]) : null;
  if (c == null) return b < 60 ? a * 60 + b : null;
  return b < 60 && c < 60 ? a * 3600 + b * 60 + c : null;
}

// ── CSS (미디어 공용) ──
const CSS = `
.md-stage{position:relative;height:100%;min-height:240px;width:100%;box-sizing:border-box;padding:12px;display:flex;align-items:center;justify-content:center;container-type:size}
.md-fit{width:100%;width:min(100cqw, calc(100cqh * 16 / 9))}
.md-player{position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:var(--radius-sm);overflow:hidden}
.md-player iframe,.md-player video,.md-player .md-yt{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:#000}
.md-player.is-empty{background:var(--surface-2);display:flex;align-items:center;justify-content:center}
.md-player-msg{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;padding:16px;text-align:center;background:rgba(20,20,30,.85);color:#fff;font-size:15px}
.md-player-msg a.btn{text-decoration:none}
.md-edit{height:100%;overflow:auto;padding:24px;display:flex;flex-direction:column;gap:14px;max-width:820px;margin:0 auto;width:100%;box-sizing:border-box}
.md-preview{width:100%}
.md-thumb{position:absolute;inset:0;overflow:hidden;background:#111;border-radius:inherit}
.md-thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.md-thumb-badge{position:absolute;right:6px;top:6px;width:22px;height:22px;display:grid;place-items:center;border-radius:6px;background:rgba(0,0,0,.55);color:#fff}
.md-thumb-badge svg{width:16px;height:16px}
.md-thumb-title{position:absolute;left:0;right:0;bottom:0;padding:4px 6px;font-size:11px;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.6));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.md-stu{height:100%}
.md-watch{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;box-sizing:border-box}
.md-watch-icon{width:64px;height:64px;border-radius:18px;background:var(--surface-2);color:var(--muted);display:grid;place-items:center}
.md-watch-icon svg{width:30px;height:30px}
.md-watch-text{font-size:20px;font-weight:600;color:var(--ink-2)}
.md-panel{display:grid;gap:10px}
.md-panel .hint,.md-edit .hint{margin:0}
`;
export function ensureMediaCss(ctx) { (ctx?.injectCss || injectCss)("media-video", CSS); }

// ── 플레이어 ──
// createPlayer(url, { onPlay }) → { el, kind, ready, started, getTime(), play(), pause(), seek(sec), isPlaying(), exitFullscreen(), destroy() }
export function createPlayer(url, { onPlay } = {}) {
  ensureMediaCss();
  const src = videoSource(url);
  const frame = el("div", { class: "md-player" });
  let yt = null, video = null, ready = false, started = false, dead = false, waitT = null;

  const api = {
    el: frame,
    kind: src?.kind || null,
    get ready() { return ready; },
    get started() { return started; },
    getTime() {
      try {
        if (yt && ready && typeof yt.getCurrentTime === "function") return Number(yt.getCurrentTime()) || 0;
        if (video) return Number(video.currentTime) || 0;
      } catch { /* 무시 */ }
      return 0;
    },
    play() {
      try {
        if (yt && ready) yt.playVideo?.();
        else if (video) { const p = video.play(); if (p && p.catch) p.catch(() => {}); }
      } catch { /* 무시 */ }
    },
    pause() {
      try {
        if (yt && ready) yt.pauseVideo?.();
        else if (video) video.pause();
      } catch { /* 무시 */ }
    },
    seek(sec) {
      const s = Math.max(0, Number(sec) || 0);
      try {
        if (yt && ready) yt.seekTo?.(s, true);
        else if (video) video.currentTime = s;
      } catch { /* 무시 */ }
    },
    isPlaying() {
      try {
        if (yt && ready) { const st = yt.getPlayerState?.(); return st === 1 || st === 3; }
        if (video) return !video.paused && !video.ended;
      } catch { /* 무시 */ }
      return false;
    },
    // 문제 오버레이가 보이도록 전체 화면 해제(best-effort)
    exitFullscreen() {
      try {
        if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
        if (video?.webkitDisplayingFullscreen) video.webkitExitFullscreen?.();
      } catch { /* 무시 */ }
    },
    destroy() {
      dead = true;
      if (waitT) { clearTimeout(waitT); waitT = null; }
      try { yt?.destroy?.(); } catch { /* 무시 */ }
      yt = null;
      if (video) {
        try { video.pause(); video.removeAttribute("src"); video.load(); } catch { /* 무시 */ }
        video = null;
      }
    },
  };

  function fail(msg, href) {
    if (dead) return;
    frame.querySelector(".md-player-msg")?.remove();
    frame.appendChild(el("div", { class: "md-player-msg" }, [
      el("div", {}, msg),
      href ? el("a", { class: "btn btn-sm", href, target: "_blank", rel: "noopener noreferrer" }, "새 탭에서 열기") : null,
    ]));
  }

  if (!src) {
    frame.classList.add("is-empty");
    frame.appendChild(el("div", { class: "empty" }, url ? VIDEO_UNSUPPORTED : "동영상이 없어요"));
    return api;
  }

  if (src.kind === "file") {
    video = el("video", { controls: true, playsinline: true, "webkit-playsinline": true, preload: "metadata", src: src.src });
    video.addEventListener("loadedmetadata", () => { ready = true; });
    video.addEventListener("play", () => { started = true; try { onPlay?.(); } catch (e) { console.warn(e); } });
    video.addEventListener("error", () => fail("동영상을 불러오지 못했어요", src.src));
    frame.appendChild(video);
    return api;
  }

  // YouTube
  const holder = el("div", { class: "md-yt" });
  frame.appendChild(holder);
  const watchUrl = `https://www.youtube.com/watch?v=${src.id}`;
  let tries = 0;
  function build(YT) {
    if (dead) return;
    if (!frame.isConnected) {
      if (++tries > 100) { waitT = null; fail("동영상을 불러오지 못했어요", watchUrl); return; }
      waitT = setTimeout(() => build(YT), 100);
      return;
    }
    waitT = null;
    const playerVars = { playsinline: 1, rel: 0, modestbranding: 1 };
    if (/^https?:$/.test(location.protocol)) playerVars.origin = location.origin;
    try {
      yt = new YT.Player(holder, {
        videoId: src.id,
        width: "100%",
        height: "100%",
        playerVars,
        events: {
          onReady: () => { if (!dead) ready = true; },
          onStateChange: (e) => {
            if (e?.data === 1) { started = true; try { onPlay?.(); } catch (er) { console.warn(er); } }
          },
          onError: () => fail("이 영상은 여기서 재생할 수 없어요", watchUrl),
        },
      });
    } catch (e) {
      console.warn("[video] YT.Player", e);
      fail("동영상을 불러오지 못했어요", watchUrl);
    }
  }
  loadYouTubeApi().then(build).catch((e) => {
    console.warn("[video] YouTube API", e);
    fail("동영상을 불러오지 못했어요", watchUrl);
  });
  return api;
}

// 플레이어 스테이지(가운데 맞춤) → { el, player, destroy }
export function playerStage(url) {
  ensureMediaCss();
  const player = createPlayer(url);
  const root = el("div", { class: "md-stage" }, [el("div", { class: "md-fit" }, [player.el])]);
  return { el: root, player, destroy() { player.destroy(); } };
}

// 편집기 미리보기: 같은 영상이면 플레이어 유지 → { set(url), player, destroy() }
export function createPreview(box, { emptyText = "" } = {}) {
  ensureMediaCss();
  let player = null, key = null;
  function set(url) {
    const u = String(url ?? "").trim();
    const src = videoSource(u);
    const k = src ? (src.kind === "youtube" ? `yt:${src.id}` : `f:${src.src}`) : `none:${u ? 1 : 0}`;
    if (k === key) return;
    key = k;
    player?.destroy();
    player = null;
    box.replaceChildren();
    if (!src) {
      const t = u ? VIDEO_UNSUPPORTED : emptyText;
      if (t) box.appendChild(el("div", { class: "empty" }, t));
      return;
    }
    player = createPlayer(u);
    box.appendChild(player.el);
  }
  return {
    set,
    get player() { return player; },
    destroy() { player?.destroy(); player = null; key = null; },
  };
}

// 썸네일: 유튜브면 영상 썸네일 이미지, 아니면 아이콘+제목
export function videoThumb(slide, icon, label) {
  ensureMediaCss();
  const src = videoSource(slide?.config?.url);
  const title = slide?.title || label;
  if (src?.kind === "youtube") {
    return el("div", { class: "md-thumb" }, [
      el("img", { src: `https://i.ytimg.com/vi/${src.id}/mqdefault.jpg`, alt: "", loading: "lazy", draggable: "false" }),
      el("span", { class: "md-thumb-badge", html: icon }),
      el("span", { class: "md-thumb-title" }, title),
    ]);
  }
  return el("div", { class: "thumb-generic" }, [
    el("span", { class: "thumb-icon", html: icon }),
    el("span", { class: "thumb-title" }, title),
  ]);
}

// ── 재생 방식(교사 재생 / 학생 재생) ──
const PLAY_MODES = [{ value: "teacher", label: "교사 재생" }, { value: "student", label: "학생 재생" }];
const PLAY_HINT = {
  teacher: "학생 화면에는 동영상 대신 '칠판의 영상을 봐주세요'가 떠요",
  student: "학생도 자기 화면에서 따로 재생할 수 있어요",
};

export function playModeOf(slide, act) {
  return (act?.playMode ?? slide?.config?.playMode) === "student" ? "student" : "teacher";
}

// 학생 화면에 플레이어를 둘지: 자유 이동·복습이면 늘 학생 재생
function studentPlays(slide, ctx, act) {
  if (ctx?.session?.()?.flow === "student") return true;
  return playModeOf(slide, act || ctx?.activity?.()) === "student";
}

function paintSeg(segEl, value) {
  [...segEl.children].forEach((b, i) => b.classList.toggle("active", PLAY_MODES[i]?.value === value));
}

// ── video 타입 ──
const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.2v5.6l4.8-2.8z"/></svg>`;

function Editor({ slide, update, ctx }) {
  ensureMediaCss(ctx);
  let cfg = { url: "", ...(slide.config || {}) };
  const input = el("input", { class: "input", type: "text", inputmode: "url", placeholder: "유튜브 또는 mp4 주소", autocomplete: "off", spellcheck: "false" });
  input.value = cfg.url || "";
  const box = el("div", { class: "md-preview" });
  const preview = createPreview(box);
  let t = null;
  input.addEventListener("input", () => {
    cfg = { ...cfg, url: input.value.trim() };
    update({ config: cfg });
    clearTimeout(t);
    t = setTimeout(() => preview.set(cfg.url), 600);
  });
  preview.set(cfg.url);
  const modeHint = el("p", { class: "hint" });
  const modeSeg = seg(PLAY_MODES, playModeOf(slide), (v) => {
    cfg = { ...cfg, playMode: v };
    update({ config: cfg });
    modeHint.textContent = PLAY_HINT[v];
  });
  modeHint.textContent = PLAY_HINT[playModeOf(slide)];
  const root = el("div", { class: "md-edit" }, [el("div", { class: "field" }, [input]), field("재생", modeSeg), modeHint, box]);
  return { el: root, destroy() { clearTimeout(t); preview.destroy(); } };
}

// 교사 화면: 늘 플레이어. 도구 패널에서 수업 중에 교사 재생 ↔ 학생 재생
function TeacherLive({ slide, ctx }) {
  ensureMediaCss(ctx);
  const st = playerStage(slide.config?.url);
  const modeSeg = seg(PLAY_MODES, playModeOf(slide, ctx.activity()), (v) => { ctx.setActivity({ playMode: v }); paint({ ...ctx.activity(), playMode: v }); });
  const note = el("p", { class: "hint" });
  const panel = el("div", { class: "md-panel" }, [field("학생 화면", modeSeg), note]);
  function paint(act) {
    const m = playModeOf(slide, act || ctx.activity());
    paintSeg(modeSeg, m);
    note.textContent = ctx.session?.()?.flow === "student" ? "자유 이동 중에는 학생이 각자 재생해요" : PLAY_HINT[m];
  }
  paint();
  return {
    el: st.el,
    panel,
    onActivity(a) { paint(a); },
    onSession() { paint(); },
    destroy() { st.destroy(); },
  };
}

// 학생 화면: 교사 재생이면 안내만, 학생 재생이면 플레이어
function Student({ slide, ctx }) {
  ensureMediaCss(ctx);
  const root = el("div", { class: "md-stu" });
  let stage = null, plays = null;
  function sync(act) {
    const next = studentPlays(slide, ctx, act);
    if (next === plays) return;
    plays = next;
    stage?.destroy();
    stage = null;
    if (plays) {
      stage = playerStage(slide.config?.url);
      root.replaceChildren(stage.el);
    } else {
      root.replaceChildren(el("div", { class: "md-watch" }, [
        el("span", { class: "md-watch-icon" }, [icon("video", 30)]),
        el("div", { class: "md-watch-text" }, "칠판의 영상을 봐주세요"),
      ]));
    }
  }
  sync();
  return {
    el: root,
    onActivity(a) { sync(a); },
    onSession() { sync(); },
    destroy() { stage?.destroy(); stage = null; },
  };
}

registerSlideType({
  type: "video",
  category: "media",
  label: "동영상",
  desc: "유튜브·mp4 동영상",
  icon: ICON,
  create() { return { type: "video", config: { url: "", playMode: "teacher" } }; },
  thumb(slide) { return videoThumb(slide, ICON, "동영상"); },
  Editor,
  Student,
  TeacherLive,
  summary(slide) {
    ensureMediaCss();
    const url = String(slide.config?.url || "").trim();
    const href = withProtocol(url);
    return el("div", { class: "md-sum" }, isHttpUrl(href)
      ? [el("a", { href, target: "_blank", rel: "noopener noreferrer" }, url)]
      : [el("div", { class: "empty" }, "동영상이 없어요")]);
  },
  validate(slide) {
    const url = String(slide.config?.url || "").trim();
    if (!url) return "동영상 주소를 입력하세요";
    if (!videoSource(url)) return VIDEO_UNSUPPORTED;
    return null;
  },
});
