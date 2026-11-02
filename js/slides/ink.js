// 필기(ink) 슬라이드 타입 — docs/ARCHITECTURE.md §6.4 "ink"
// 모드: none(발표·학생 읽기 전용, 교사 필기는 whole) / whole / individual / group
// 가정: cloud·storage·ui·realtime·store는 네임스페이스 import(다른 에이전트 파일의 export가 늦게 생겨도 링크가 깨지지 않게).
// 가정: ctx.modal(opts)는 ui.modal({ title, body, actions:[{label, primary, danger, onClick(close)}], wide, onClose })이고
//       { close } 를 반환한다. 닫힘은 onClose 외에 body가 DOM에서 빠지는 것으로도 감지한다.
// 가정: 프레임 크기는 스테이지 크기에 맞춰 JS로 contain(16:10) 맞춤(ResizeObserver).
// 가정: 도구 상태(도구·색·굵기)는 모듈 단위로 기억(슬라이드를 넘겨도 유지).
// 교사 갤러리: 학생 수와 화면 크기에 맞춰 칸 크기를 계산(한 명이면 화면 가득, 많으면 최소 200px 후 스크롤).
//       보기 '필기 부분'(기본): 칸마다 그 학생이 방금 쓰고 있는 곳(최근 20초·최대 12개 획/글자)을 가로 칸에 확대해서 보여 준다.
//       가정: 너무 좁게 확대하지 않도록 최소 범위는 학습지 폭의 절반(=최대 2배), 교사 첨삭 획은 따라가지 않는다,
//             범위가 조금 바뀐 정도(가운데 15%·크기 20% 미만)는 그대로 둬서 칸이 흔들리지 않게 한다. 필기가 없으면 학습지 전체.
//       보기 '전체': 학습지 내용 영역 전체(세로 칸). 필기는 칸 크기 × dpr 캔버스에 보이는 영역만 그린다(선명·메모리 일정).
//       선 굵기는 슬라이드 위 실제 굵기(canvas.js 7) — 확대해서 쓴 글씨는 가늘게, 크게 쓴 글씨는 굵게, 학생 화면과 같은 비율.
// 확대: 필기 화면(편집기·교사 전체·학생·학생 필기 크게 보기)은 renderSlide({ zoom:true }) — 두 손가락·휠·도구바 [− 100% +].
//       학생 화면은 스테이지 전체가 보기 영역이고, 도구바가 덮는 만큼만 맞춤에서 비운다(이동하면 도구바 뒤로도 보임).
//       가로로 남는 화면이면 도구바를 왼쪽 세로 2열로 옮겨 슬라이드를 키운다(어느 쪽이 더 크게 보이는지 계산해 선택).
// 가정: 갤러리 온라인 점은 realtime.currentChannel().onPresence로 갱신(없으면 onSession 때만).
// 팝업 상호작용(v2.9, js/popup.js): 편집기에서 슬라이드 위에 핀(상호작용)을 넣고 끌어 옮긴다. 수업 중 교사가 핀(개별·모둠이면 머리 줄 버튼)을
//       누르면 ctx.openPopup → 교사·학생 화면에 팝업. 학생 화면에는 자유 이동(flow 'student')·복습일 때만 핀이 보인다.
// 이미지(v2.10): 편집기 도구바 '이미지' 도구 — 슬라이드 위 이미지(config.images, 그리기는 lesson-view)를 끌어서 옮기고 모서리로 크기, × 삭제.
//       넣기: 이미지 도구를 누르면(이미지가 없을 때)·이미 고른 이미지 도구를 한 번 더 누르면·인스펙터 [이미지 넣기]·붙여넣기(⌘/Ctrl+V)·
//       스테이지에 끌어다 놓기. 넣은 이미지는 선택된 채로 이미지 도구가 켜진다. 이미지 도구는 편집기 도구바에만 있다(학생·교사 진행은 펜으로).
// 도형(v2.10): 도구바 '도형'(모든 화면) — 누르면 종류 창(직선·화살표·네모·동그라미·세모), 켜진 도형 도구를 다시 누르면 창을 다시 연다.
//       도구 상태에 종류(shape)도 기억. 그리기·저장은 canvas.js 10.
// 텍스트 부분 색(v2.10): 텍스트 도구에서 글자 일부를 고르고 색을 누르면 그 부분만(lesson-view paintText). 색 버튼은 pointerdown을 막아 선택 유지.
// 펜 기기(v2.6.1, js/pen-input.js): 펜을 처음 쓰면 그 기기에서는 손가락 필기를 끈다(손바닥 오인 방지). 도구바 끝 ✋ 버튼(펜 기기에서만 보임)으로
//       손가락 필기를 다시 켜고 끈다. 도구바는 두 번 탭 확대를 막고(touch-action: manipulation), 글자 선택이 생기지 않는다.
import * as ui from "../ui.js";
import { penKnown, fingerDraws, setFingerDraw, onPenModeChange } from "../pen-input.js";
import * as cloud from "../cloud.js";
import * as storage from "../storage.js";
import * as realtime from "../realtime.js";
import * as storeMod from "../store.js";
import { registerSlideType, effectiveMode, groupStudents, newId, injectCss } from "./registry.js";
import { renderSlide, imageLayer } from "../lesson-view.js";
import { paintStrokes } from "../canvas.js";
import { pageRectFor } from "../zoom-view.js";
import { hotspotLayer, hotspotInspector, hotspotChips, openHotspotEditor, hotspotsOf } from "../popup.js";

const { el } = ui;

const COLORS = ["#1c1c22", "#2563eb", "#dc2626", "#16a34a", "#f59e0b", "#7c3aed"];
const SIZES = [{ id: "S", v: 2 }, { id: "M", v: 3.5 }, { id: "L", v: 6 }];
const TOOLS = [
  { id: "pen", label: "펜" },
  { id: "highlight", label: "형광펜" },
  { id: "eraser", label: "지우개" },
  { id: "text", label: "텍스트 — 글자를 골라 색을 누르면 그 부분만 바뀌어요" },
  { id: "shape", label: "도형" },
];
const SHAPE_KINDS = [
  { id: "line", label: "직선" }, { id: "arrow", label: "화살표" }, { id: "rect", label: "네모" },
  { id: "ellipse", label: "동그라미" }, { id: "tri", label: "세모" },
];
const IMAGE_TOOL = { id: "image", label: "이미지 — 옮기기·크기" }; // 편집기 전용
const MODES = [["none", "발표"], ["whole", "전체"], ["individual", "개별"], ["group", "모둠"]];

// 24px stroke SVG (ui.icon 없을 때 대체)
const SVG = {
  pen: '<path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/><path d="M14 6l3 3"/>',
  highlight: '<path d="M9 15l-4 4h6l1-1"/><path d="M9 15l7-11 4 3-7 11z"/><path d="M8 14l5 3"/>',
  eraser: '<path d="M7 20h12"/><path d="M5 15l9-9 5 5-8 8H8z"/><path d="M10 10l5 5"/>',
  text: '<path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4"/><path d="M8.2 11h5.6M11 8.2v5.6"/>',
  zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4"/><path d="M8.2 11h5.6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0"/><path d="M16 4.5a3.5 3.5 0 010 7"/><path d="M18 14a6 6 0 013.5 6"/>',
  "sh-line": '<path d="M5 19 19 5"/>',
  "sh-arrow": '<path d="M5 19 19 5"/><path d="M10 5h9v9"/>',
  "sh-rect": '<rect x="4" y="6" width="16" height="12" rx="1.5"/>',
  "sh-ellipse": '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
  "sh-tri": '<path d="M12 5 20.5 19h-17z"/>',
  hand: '<path d="M18 11V6a2 2 0 00-4 0v5"/><path d="M14 10V4a2 2 0 00-4 0v6"/><path d="M10 10.5V6a2 2 0 00-4 0v8"/><path d="M18 8a2 2 0 114 0v6a8 8 0 01-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 012.83-2.82L7 15"/>',
};
const PEN_ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${SVG.pen}</svg>`;

const LOCAL_ICONS = new Set(["zoomIn", "zoomOut", "hand", "sh-line", "sh-arrow", "sh-rect", "sh-ellipse", "sh-tri"]); // 앱 공용 아이콘에 없는 것
function icon(name) {
  if (typeof ui.icon === "function" && !LOCAL_ICONS.has(name)) {
    try { const n = ui.icon(name); if (n) return n; } catch (_) {}
  }
  return el("span", { class: "ink-ic", html: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${SVG[name] || ""}</svg>` });
}

const CSS = `
.slide-host[data-type="ink"] { height:100%; min-height:0; display:flex; flex-direction:column; }
.ink-wrap { position:relative; display:flex; flex-direction:column; gap:10px; width:100%; height:100%; min-height:0; flex:1; }
.ink-stage { position:relative; flex:1; min-height:0; min-width:0; display:flex; align-items:center; justify-content:center; }
.ink-wrap .ink-stage > .slide-frame { flex:none; max-width:100%; margin:0 auto; }
.ink-wrap.has-float .ink-stage { padding-bottom:76px; }
.ink-toolbar { display:flex; align-items:center; gap:4px; padding:6px 8px; background:var(--surface); border:1px solid var(--line);
  border-radius:var(--radius); box-shadow:var(--shadow-1); flex-wrap:wrap; align-self:center; max-width:100%;
  touch-action:manipulation; -webkit-user-select:none; user-select:none; -webkit-touch-callout:none; }
.ink-hand { position:relative; }
.ink-hand:not(.active)::after { content:""; position:absolute; left:9px; right:9px; top:50%; height:2px; border-radius:2px;
  background:currentColor; transform:rotate(-45deg); opacity:.85; } /* 꺼짐 = 빗금 */
.ink-toolbar .ink-grp { display:flex; align-items:center; gap:2px; }
.ink-toolbar .ink-sep { width:1px; height:22px; background:var(--line); margin:0 4px; flex:none; }
.ink-tool, .ink-size { width:36px; height:36px; border:0; border-radius:var(--radius-sm); background:transparent; color:var(--ink-2);
  display:grid; place-items:center; cursor:pointer; flex:none; padding:0; }
.ink-tool:hover, .ink-size:hover { background:var(--surface-2); }
.ink-tool.active, .ink-size.active { background:var(--ink); color:#fff; }
.ink-tool svg { width:20px; height:20px; }
.ink-ic { display:inline-grid; place-items:center; }
.ink-shape-pop { position:fixed; z-index:300; display:flex; gap:2px; padding:5px; background:var(--surface); border:1px solid var(--line);
  border-radius:var(--radius); box-shadow:var(--shadow-2); touch-action:manipulation; -webkit-user-select:none; user-select:none; }
.ink-shape-pop .ink-tool { width:44px; height:44px; }
.ink-swatch { width:36px; height:36px; border:0; background:transparent; display:grid; place-items:center; cursor:pointer; padding:0; flex:none; }
.ink-swatch i { width:20px; height:20px; border-radius:50%; background:var(--c); box-shadow:inset 0 0 0 1px rgba(0,0,0,.12); }
.ink-swatch.active i { box-shadow:0 0 0 2px var(--surface), 0 0 0 4px var(--c); }
.ink-size i { display:block; border-radius:50%; background:currentColor; }
.ink-toolbar .btn { margin-left:4px; }
.ink-zlbl { min-width:52px; height:36px; padding:0 6px; border:0; border-radius:var(--radius-sm); background:transparent; color:var(--ink-2);
  font:600 12.5px/1 var(--font); font-variant-numeric:tabular-nums; cursor:pointer; flex:none; }
.ink-zlbl:hover { background:var(--surface-2); }
.ink-float .ink-zlbl { height:44px; min-width:48px; }
.ink-float .ink-swatch { width:40px; min-width:40px; } /* 아이패드 세로(810~834px)에서 한 줄에 다 들어가게 */
.ink-wrap.bar-side .ink-float .ink-swatch { width:44px; }
/* 낮은 가로 화면(노트북·가로 태블릿 일부): 40px 버튼으로 한 줄에 다 보이게 */
.ink-wrap.bar-side.bar-compact .ink-float { grid-template-columns:repeat(2, 40px); padding:4px; }
.ink-wrap.bar-side.bar-compact .ink-float .ink-tool, .ink-wrap.bar-side.bar-compact .ink-float .ink-size,
.ink-wrap.bar-side.bar-compact .ink-float .ink-swatch { width:40px; height:40px; min-width:40px; min-height:40px; }
.ink-wrap.bar-side.bar-compact .ink-float .ink-sep { margin:3px 4px; }
.ink-wrap.bar-side.bar-compact .ink-float .ink-zlbl { height:32px; }
.ink-wrap .ink-stage.zoom-view { padding:0; }
/* 학생: 넓은 화면이면 도구바를 왼쪽 세로 2열로(슬라이드가 더 커짐) */
.ink-wrap.bar-side .ink-float { left:max(8px, env(safe-area-inset-left)); top:50%; bottom:auto; transform:translateY(-50%);
  display:grid; grid-template-columns:repeat(2, 44px); align-content:start; max-width:none; max-height:calc(100% - 16px);
  overflow-x:hidden; overflow-y:auto; padding:6px; }
.ink-wrap.bar-side .ink-float .ink-grp { display:contents; }
.ink-wrap.bar-side .ink-float .ink-sep { grid-column:1 / -1; width:auto; height:1px; margin:4px 6px; }
.ink-wrap.bar-side .ink-float .ink-sep.sep-undo { display:none; }
.ink-wrap.bar-side .ink-float .ink-zlbl { grid-column:1 / -1; order:2; width:auto; }
/* 읽기 전용(발표): 확대 버튼만 오른쪽 아래에 작게 */
.ink-float.ink-zoombar { left:auto; right:max(8px, env(safe-area-inset-right)); transform:none; padding:4px; z-index:6;
  background:rgba(255,255,255,.82); -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); }
.ink-float { position:absolute; left:50%; bottom:calc(8px + env(safe-area-inset-bottom)); transform:translateX(-50%); z-index:5;
  flex-wrap:nowrap; overflow-x:auto; max-width:calc(100% - 16px); scrollbar-width:none; box-shadow:var(--shadow-2); }
.ink-float::-webkit-scrollbar { display:none; }
.ink-float .ink-tool, .ink-float .ink-size, .ink-float .ink-swatch { width:44px; height:44px; }
@media (max-width:520px) { .ink-float { overflow-x:auto; max-width:calc(100vw - 16px); }
  .ink-float .ink-tool, .ink-float .ink-size, .ink-float .ink-swatch { width:44px; height:44px; min-width:44px; min-height:44px; } }
/* 세로 태블릿(아이패드 744~834px, 갤럭시탭 800px): 아래 도구바가 한 줄에 다 들어가게 폭만 줄임(높이 44px 유지) */
@media (max-width:940px) {
  .ink-wrap:not(.bar-side) .ink-float { gap:2px; padding:4px 6px; }
  .ink-wrap:not(.bar-side) .ink-float .ink-tool, .ink-wrap:not(.bar-side) .ink-float .ink-size { width:40px; }
  .ink-wrap:not(.bar-side) .ink-float .ink-swatch { width:36px; min-width:36px; }
  .ink-wrap:not(.bar-side) .ink-float .ink-sep { margin:0 2px; }
  .ink-wrap:not(.bar-side) .ink-float .ink-zlbl { min-width:44px; padding:0 2px; }
}
@media (max-width:790px) {
  .ink-wrap:not(.bar-side) .ink-float .ink-tool, .ink-wrap:not(.bar-side) .ink-float .ink-size { width:37px; }
  .ink-wrap:not(.bar-side) .ink-float .ink-swatch { width:32px; min-width:32px; }
}
/* 세로 아이패드(744~834px)에서 도형 도구·✋까지 한 줄에(높이 44px 유지). 휴대폰은 그대로(가로 스크롤) */
@media (min-width:521px) and (max-width:860px) {
  .ink-wrap:not(.bar-side) .ink-float { gap:1px; padding:4px; }
  .ink-wrap:not(.bar-side) .ink-float .ink-swatch { width:30px; min-width:30px; }
  .ink-wrap:not(.bar-side) .ink-float .ink-size { width:34px; min-width:34px; }
  .ink-wrap:not(.bar-side) .ink-float .ink-sep { margin:0 1px; }
}
.ink-wait { flex:1; display:grid; place-items:center; }
.ink-gallery { flex:1; min-height:0; overflow:auto; padding:2px; display:flex; flex-direction:column; gap:12px; }
.ink-tiles { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:12px; }
.ink-tile { display:flex; flex-direction:column; gap:6px; padding:6px; border:1px solid var(--line); border-radius:var(--radius-sm);
  background:var(--surface); cursor:pointer; text-align:left; font:inherit; color:inherit; }
.ink-tile:hover { border-color:var(--line-strong); box-shadow:var(--shadow-1); }
.ink-tile.static { cursor:default; }
.ink-mini { position:relative; aspect-ratio:16/10; background:#fff; border-radius:6px; overflow:hidden; box-shadow:inset 0 0 0 1px var(--line); }
.ink-mini img, .ink-mini canvas { position:absolute; inset:0; width:100%; height:100%; }
.ink-mini img { object-fit:contain; pointer-events:none; }
/* 갤러리 칸: 내용 영역만 보이게 자름(안쪽 16:10 상자를 키워서 옮김) */
.ink-mini.crop { aspect-ratio:var(--pa, 1.6); }
.ink-mini-in { position:absolute; left:0; top:0; width:100%; height:100%; }
.ink-mini.crop > canvas { z-index:1; }
.ink-mini.moved { animation:inkMiniMove .32s ease; }
@keyframes inkMiniMove { from { opacity:.45; } to { opacity:1; } }
.ink-gal-head { display:flex; align-items:center; justify-content:flex-end; gap:8px; flex:none; }
.ink-gal-head .ink-note { margin-right:auto; }
.ink-gallery { scrollbar-gutter:stable; }
.ink-gallery .ink-tiles.fit { justify-content:center; }
.ink-tile-name { display:flex; align-items:center; gap:6px; font-size:13px; color:var(--ink-2); min-width:0; padding:0 2px; }
.ink-tile-name span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ink-tile-name .dot { flex:none; width:8px; height:8px; border-radius:50%; background:var(--line-strong); }
.ink-tile-name .dot.on { background:var(--ok); }
.ink-tile-name .ink-cnt { margin-left:auto; color:var(--muted); font-variant-numeric:tabular-nums; }
.ink-zoom { display:flex; flex-direction:column; gap:10px; height:min(72dvh, 640px); min-height:280px; }
.ink-insp-bg { position:relative; aspect-ratio:16/10; border:1px solid var(--line); border-radius:var(--radius-sm); background:#fff; overflow:hidden;
  display:grid; place-items:center; color:var(--muted); font-size:13px; }
.ink-insp-bg img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; }
.ink-insp-row { display:flex; gap:6px; margin-top:8px; }
.ink-inspector { display:grid; gap:18px; }
.ink-insp-img .ink-insp-row { margin-top:0; align-items:center; }
.ink-insp-img .ink-insp-n { color:var(--muted); font-size:13px; font-variant-numeric:tabular-nums; }
.ink-insp-hint { margin:6px 0 0; font-size:12px; line-height:1.5; color:var(--muted); font-weight:400; }
.ink-editor .ink-stage.drop-on { outline:3px dashed var(--accent); outline-offset:-6px; border-radius:var(--radius); }
.ink-thumb { position:relative; width:100%; height:100%; aspect-ratio:16/10; background:#fff; overflow:hidden; }
.ink-thumb.is-paper { background:#fff linear-gradient(transparent 23px, var(--line) 24px) 0 6px / 100% 24px; }
.ink-thumb img, .ink-thumb canvas { position:absolute; inset:0; width:100%; height:100%; }
.ink-thumb img { object-fit:contain; }
.ink-summary { display:flex; flex-direction:column; gap:12px; }
.ink-summary .ink-mini.big { max-width:640px; width:100%; }
.ink-sum-head { font-size:13px; color:var(--muted); }
.ink-gb { display:flex; flex-direction:column; gap:12px; }
.ink-gb-top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.ink-gb-groups { display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:10px; }
.ink-gb-box { border:1px solid var(--line); border-radius:var(--radius-sm); padding:8px; min-height:72px; background:var(--surface); cursor:pointer;
  display:flex; flex-direction:column; gap:6px; }
.ink-gb-box.is-pool { background:var(--surface-2); }
.ink-gb-box.can-drop { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
.ink-gb-title { font-size:12px; color:var(--muted); display:flex; justify-content:space-between; }
.ink-gb-chips { display:flex; flex-wrap:wrap; gap:6px; }
.ink-chip { height:32px; padding:0 10px; border:1px solid var(--line); border-radius:999px; background:var(--surface); font:inherit; font-size:13px;
  color:var(--ink); cursor:pointer; display:inline-flex; align-items:center; gap:6px; }
.ink-chip.sel { background:var(--accent); border-color:var(--accent); color:#fff; }
.ink-chip .dot { width:6px; height:6px; border-radius:50%; background:var(--line-strong); }
.ink-chip .dot.on { background:var(--ok); }
`;

// 모듈 단위 도구 상태
const toolState = { tool: "pen", color: COLORS[0], size: "M", shape: "rect" };
// 교사 갤러리 보기: "focus"(필기 부분, 기본) | "page"(전체) — 이 기기에 기억
const GAL_KEY = "hada:inkGallery";
let galleryView = (() => { try { return localStorage.getItem(GAL_KEY) === "page" ? "page" : "focus"; } catch { return "focus"; } })();
const FOCUS_ASPECT = 1.6; // 필기 부분 칸 비율(가로)
const sizeVal = (id) => (SIZES.find(s => s.id === id) || SIZES[1]).v;

const hasInk = (rec) => !!rec && (((rec.strokes || []).length) || ((rec.texts || []).length));
const seg = (items, cur, onPick, cls = "") => el("div", { class: "seg " + cls },
  items.map(([id, label]) => el("button", { type: "button", class: id === cur ? "active" : "", "data-id": id, onClick: () => onPick(id) }, label)));
function segSet(segEl, cur) { segEl.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.id === String(cur))); }

function studentName(id, ctx) {
  const s = ctx?.students?.()?.get?.(id)
    || (typeof storeMod.findStudent === "function" ? storeMod.findStudent(id) : null)
    || storeMod.store?.state?.students?.find?.(x => x.id === id);
  if (!s) return "학생";
  return s.num != null && s.num !== "" ? `${s.num}. ${s.name}` : s.name;
}
function studentSort(ctx) {
  const map = ctx?.students?.() || new Map();
  return (a, b) => {
    const x = map.get(a) || {}, y = map.get(b) || {};
    return (+x.grade || 0) - (+y.grade || 0) || (+x.classNum || 0) - (+y.classNum || 0) || (+x.num || 0) - (+y.num || 0)
      || String(x.name || "").localeCompare(String(y.name || ""), "ko");
  };
}

// 스테이지에 16:10 프레임을 contain으로 맞춤
function fitFrame(stage) {
  let raf = 0;
  const fit = () => {
    raf = 0;
    const f = stage.querySelector(":scope > .slide-frame");
    if (!f) return;
    const cs = getComputedStyle(stage);
    const w = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    // 높이가 정해지지 않은 컨테이너면 폭 기준
    const width = h > 80 ? Math.min(w, h * 1.6) : w;
    f.style.width = Math.max(0, Math.floor(width)) + "px";
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(fit); };
  const ro = new ResizeObserver(schedule);
  ro.observe(stage);
  schedule();
  return { fit: schedule, destroy() { ro.disconnect(); if (raf) cancelAnimationFrame(raf); } };
}

// 도구바: 펜·형광·지우개·텍스트 | 색 6 | S/M/L | 되돌리기 (+ extras)
// 확대 버튼 [− 100% +] — viewer.zoom이 있을 때. bindZoom(viewer)로 퍼센트 표시를 연결
function zoomGroup(getViewer) {
  const lbl = el("button", { type: "button", class: "ink-zlbl", title: "화면에 맞춤 / 폭 맞춤", "aria-label": "확대 비율 · 맞춤",
    onClick: () => getViewer()?.zoom?.toggleFit() }, "100%");
  const grp = el("div", { class: "ink-grp ink-zgrp" }, [
    el("button", { type: "button", class: "ink-tool", title: "축소", "aria-label": "축소", onClick: () => getViewer()?.zoom?.zoomOut() }, [icon("zoomOut")]),
    lbl,
    el("button", { type: "button", class: "ink-tool", title: "확대", "aria-label": "확대", onClick: () => getViewer()?.zoom?.zoomIn() }, [icon("zoomIn")]),
  ]);
  let off = null;
  grp.bindZoom = (viewer) => {
    try { off && off(); } catch (_) {}
    off = null;
    const z = viewer?.zoom;
    grp.hidden = !z;
    if (!z) return;
    const show = () => { const t = z.percent() + "%"; if (lbl.textContent !== t) lbl.textContent = t; };
    off = z.onChange(show);
    show();
  };
  return grp;
}

// 오른쪽 아래 작은 확대 버튼(교사 화면·학생 발표 모드) — 도구바가 두 줄로 늘어나지 않게 따로 띄운다
function zoomPill(getViewer) {
  const zg = zoomGroup(getViewer);
  const pill = el("div", { class: "ink-toolbar ink-float ink-zoombar" }, [zg]);
  pill.bindZoom = (v) => zg.bindZoom(v);
  return pill;
}

function makeToolbar(getViewer, { float = false, extras = [], zoom = false, tools = TOOLS, onTool = null } = {}) {
  const st = toolState;
  // 도구 상태는 모듈 공용 — 이 도구바에 없는 도구(편집기의 '이미지')면 펜으로
  const known = () => { if (!tools.some(t => t.id === st.tool)) st.tool = "pen"; };
  const apply = () => {
    const v = getViewer();
    if (!v) return;
    known();
    v.setTool(st.tool); v.setShape?.(st.shape); v.setColor(st.color); v.setSize(sizeVal(st.size));
  };
  const toolBtns = tools.map(t => {
    const b = el("button", {
      type: "button", class: "ink-tool", title: t.label, "aria-label": t.label.split(" — ")[0], "data-id": t.id,
      onClick: () => {
        const again = st.tool === t.id;
        st.tool = t.id; sync(); apply();
        if (t.id === "shape") again && shapePop ? closeShapePop() : openShapePop(b);
        else closeShapePop();
        onTool && onTool(t.id, again);
      },
    }, [icon(t.id === "shape" ? "sh-" + st.shape : t.id)]);
    return b;
  });
  // 도형 종류 창(화면에 고정 — 도구바는 가로 스크롤이라 그 안에 두면 잘림)
  let shapePop = null, popWatch = 0;
  function closeShapePop() {
    if (!shapePop) return;
    shapePop.remove(); shapePop = null;
    clearInterval(popWatch);
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onPopKey, true);
  }
  function onOutside(e) { if (shapePop && !shapePop.contains(e.target) && !e.target.closest?.('.ink-tool[data-id="shape"]')) closeShapePop(); }
  function onPopKey(e) { if (e.key === "Escape") { e.stopPropagation(); closeShapePop(); } }
  function openShapePop(anchor) {
    closeShapePop();
    shapePop = el("div", { class: "ink-shape-pop", role: "menu", "aria-label": "도형 종류" }, SHAPE_KINDS.map(k => el("button", {
      type: "button", class: "ink-tool" + (k.id === st.shape ? " active" : ""), title: k.label, "aria-label": k.label, role: "menuitemradio",
      onClick: () => { st.shape = k.id; st.tool = "shape"; sync(); apply(); closeShapePop(); },
    }, [icon("sh-" + k.id)])));
    document.body.appendChild(shapePop);
    const r = anchor.getBoundingClientRect(), pw = shapePop.offsetWidth, ph = shapePop.offsetHeight;
    const side = bar.closest(".bar-side") && bar.classList.contains("ink-float");
    let x = side ? r.right + 8 : r.left + r.width / 2 - pw / 2;
    let y = side ? r.top + r.height / 2 - ph / 2 : (r.top - ph - 8 >= 8 && bar.classList.contains("ink-float") ? r.top - ph - 8 : r.bottom + 8);
    x = Math.max(8, Math.min(innerWidth - pw - 8, x));
    y = Math.max(8, Math.min(innerHeight - ph - 8, y));
    Object.assign(shapePop.style, { left: x + "px", top: y + "px" });
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onPopKey, true);
    popWatch = setInterval(() => { if (!anchor.isConnected) closeShapePop(); }, 400); // 슬라이드가 바뀌어 도구바가 사라지면 함께
  }
  const colorBtns = COLORS.map(c => el("button", {
    type: "button", class: "ink-swatch", "aria-label": "색", "data-id": c, style: { "--c": c },
    // 누르는 순간 글 상자의 고른 글자가 풀리지 않게
    onPointerdown: (e) => e.preventDefault(),
    onClick: () => {
      getViewer()?.paintText?.(c); // 텍스트 도구에서 글자를 골라 두었으면 그 부분만
      st.color = c; if (st.tool === "eraser" || st.tool === "image") st.tool = "pen"; sync(); apply();
    },
  }, [el("i", {})]));
  const sizeBtns = SIZES.map((s, i) => el("button", {
    type: "button", class: "ink-size", title: s.id, "aria-label": "굵기 " + s.id, "data-id": s.id,
    onClick: () => { st.size = s.id; sync(); apply(); },
  }, [el("i", { style: { width: (5 + i * 4) + "px", height: (5 + i * 4) + "px" } })]));
  const undoBtn = el("button", { type: "button", class: "ink-tool", title: "되돌리기", "aria-label": "되돌리기", onClick: () => getViewer()?.undo() }, [icon("undo")]);
  // 색 칸에 style 객체의 커스텀 속성 반영(el()은 Object.assign이라 --c가 안 들어감)
  colorBtns.forEach(b => b.style.setProperty("--c", b.dataset.id));
  // ✋ 손가락 필기 켜기/끄기 — 펜을 쓴 기기에서만 보임
  const handBtn = el("button", {
    type: "button", class: "ink-tool ink-hand",
    onClick: () => {
      const on = !fingerDraws();
      setFingerDraw(on);
      ui.toast?.(on ? "손가락으로도 쓸 수 있어요" : "펜으로만 써요 · 손가락은 두 손가락 확대·이동");
    },
  }, [icon("hand")]);
  const handSep = el("span", { class: "ink-sep sep-hand" });
  syncHand(handBtn, handSep);

  const zg = zoom ? zoomGroup(getViewer) : null;
  const bar = el("div", { class: "ink-toolbar" + (float ? " ink-float" : "") }, [
    el("div", { class: "ink-grp" }, toolBtns),
    el("span", { class: "ink-sep" }),
    el("div", { class: "ink-grp" }, colorBtns),
    el("span", { class: "ink-sep" }),
    el("div", { class: "ink-grp" }, sizeBtns),
    el("span", { class: "ink-sep sep-undo" }),
    undoBtn,
    ...(zg ? [el("span", { class: "ink-sep" }), zg] : []),
    handSep, handBtn,
    ...extras,
  ]);
  function sync() {
    known();
    toolBtns.forEach(b => {
      b.classList.toggle("active", b.dataset.id === st.tool);
      if (b.dataset.id === "shape" && b.dataset.k !== st.shape) { b.dataset.k = st.shape; b.replaceChildren(icon("sh-" + st.shape)); }
    });
    colorBtns.forEach(b => b.classList.toggle("active", b.dataset.id === st.color));
    sizeBtns.forEach(b => b.classList.toggle("active", b.dataset.id === st.size));
  }
  sync();
  bar.sync = sync;
  bar.apply = apply;
  bar.bindZoom = (viewer) => zg?.bindZoom(viewer);
  bar.closePops = closeShapePop;
  return bar;
}

// ✋ 버튼 상태: 펜을 쓴 기기에서만 보이고, 손가락 필기가 켜져 있으면 active
function syncHand(btn, sep) {
  const show = penKnown();
  btn.hidden = !show;
  if (sep) sep.hidden = !show;
  const on = fingerDraws();
  btn.classList.toggle("active", show && on);
  btn.setAttribute("aria-pressed", String(on));
  const t = on ? "손가락 필기 켜짐 · 누르면 펜으로만" : "펜으로만 쓰는 중 · 누르면 손가락으로도 쓰기";
  btn.title = t;
  btn.setAttribute("aria-label", t);
}
// 펜을 처음 쓰거나 설정이 바뀌면 화면의 모든 도구바 ✋ 갱신(구독 해제가 필요 없게 DOM에서 찾음)
onPenModeChange((mode, prev) => {
  const btns = document.querySelectorAll(".ink-hand");
  btns.forEach(b => syncHand(b, b.previousElementSibling?.classList.contains("sep-hand") ? b.previousElementSibling : null));
  if (prev === null && mode === "pen" && btns.length) ui.toast?.("펜으로 쓰는 기기예요 · 손바닥 인식을 막으려고 손가락 필기를 껐어요(✋로 켜기)");
});

// 모달 열기 + 닫힘 감지
function openModal(ctx, { title, body, actions = [], onClose }) {
  let closed = false, handle = null;
  const done = () => {
    if (closed) return;
    closed = true;
    try { ro.disconnect(); mo.disconnect(); } catch (_) {}
    try { onClose && onClose(); } catch (e) { console.warn("[ink] modal onClose", e); }
  };
  const close = () => {
    if (typeof handle?.close === "function") handle.close();
    else if (typeof handle === "function") handle();
    else body.closest(".modal-back")?.remove();
    done();
  };
  const acts = actions.map(a => ({ ...a, onClick: () => a.onClick(close) }));
  handle = ctx.modal ? ctx.modal({ title, body, actions: acts, wide: true, onClose: done }) : null;
  if (!handle && !body.isConnected) {
    // 대체: 아주 단순한 오버레이
    const back = el("div", { class: "modal-back" }, [el("div", { class: "modal modal-wide" }, [
      el("h3", {}, title || ""), body,
      el("div", { class: "row-actions" }, acts.map(a => el("button", { type: "button", class: "btn" + (a.primary ? " btn-primary" : ""), onClick: a.onClick }, a.label))),
    ])]);
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    document.body.appendChild(back);
    handle = { close: () => back.remove() };
  }
  const check = () => { if (!body.isConnected) done(); };
  const ro = new ResizeObserver(check);
  ro.observe(body);
  const mo = new MutationObserver(check);
  mo.observe(document.body, { childList: true });
  return { close, isOpen: () => !closed };
}

// 미니 프레임(배경 + 필기). 반환 el에 .paint(rec) 메서드
// crop: true → setPage(영역)만 칸에 꽉 차게 보여 준다(배경은 안쪽 16:10 상자를 키워 옮기고, 필기는 칸 크기 캔버스에 그 영역만 그림).
//              setPx(칸 폭)로 캔버스 해상도를 칸 크기 × dpr에 맞춤
function miniFrame(slide, { big = false, crop = false } = {}) {
  injectCss("ink", CSS);
  const box = el("div", { class: "ink-mini" + (big ? " big" : "") + (crop ? " crop" : "") });
  const inner = crop ? el("div", { class: "ink-mini-in" }) : box;
  if (crop) box.appendChild(inner);
  if (slide.bg) inner.appendChild(el("img", { src: slide.bg, alt: "", loading: "lazy", decoding: "async" }));
  const il = imageLayer(slide, { lazy: true });
  if (il) inner.appendChild(il);
  const cv = el("canvas", { width: big ? 960 : 480, height: big ? 600 : 300 });
  box.appendChild(cv);
  let page = null, lastRec = null, sig = null, cssW = 0;
  box.region = () => page;
  box.setPage = (r, { animate = false } = {}) => {
    page = r;
    const pw = r.x1 - r.x0, ph = r.y1 - r.y0;
    box.style.setProperty("--pa", String((pw * 1.6) / ph));
    Object.assign(inner.style, { width: (100 / pw) + "%", height: (100 / ph) + "%", left: (-r.x0 / pw * 100) + "%", top: (-r.y0 / ph * 100) + "%" });
    if (cssW) sizeCanvas(true);
    if (animate) { box.classList.remove("moved"); void box.offsetWidth; box.classList.add("moved"); }
  };
  function sizeCanvas(force) {
    const dpr = window.devicePixelRatio || 1;
    const a = page ? (page.x1 - page.x0) * 1.6 / (page.y1 - page.y0) : 1.6;
    const W = Math.max(120, Math.min(1600, Math.round(cssW * dpr)));
    const H = Math.max(1, Math.round(W / a));
    if (!force && Math.abs(cv.width - W) < 8 && Math.abs(cv.height - H) < 8) return;
    cv.width = W; cv.height = H;
    sig = null;
    box.paint(lastRec);
  }
  box.setPx = (w) => { cssW = w; sizeCanvas(false); };
  const baseS = Array.isArray(slide.strokes) ? slide.strokes : [];
  const baseT = Array.isArray(slide.texts) ? slide.texts : [];
  box.paint = (rec) => {
    lastRec = rec;
    const r = rec || {};
    const st = r.strokes || [];
    // cloud.js가 레코드 변경마다 올리는 _v(비열거) + 개수·마지막 id (개별 원격 교체 시 개수가 같아도 감지)
    const s = `${r._v || 0}|${st.length}|${st[st.length - 1]?.id || ""}|${(r.removed || []).length}|${(r.texts || []).length}|${(r.texts || []).reduce((n, t) => n + String(t?.value || "").length, 0)}`;
    if (s === sig) return false;
    sig = s;
    const opts = { removed: r.removed || [], texts: baseT.concat(r.texts || []) };
    // 칸: 보이는 영역만(선 굵기는 슬라이드 위 실제 굵기 — 학생이 그 배율에서 본 모습과 같음)
    if (crop && page) Object.assign(opts, { region: page, minPx: (window.devicePixelRatio || 1) * 0.6 });
    paintStrokes(cv, baseS.concat(r.strokes || []), opts);
    return true;
  };
  return box;
}

// 학생이 지금 쓰고 있는 곳(슬라이드 정규화) — 최근 20초·최대 12개의 획/글자 범위를 aspect(가로/세로) 칸에 맞게 넓힘.
// page = 학습지 내용 영역. 필기가 없으면 null
function writingRegion(rec, page, aspect, ignoreBy) {
  if (!rec) return null;
  const rm = new Set(rec.removed || []);
  const items = [];
  for (const st of rec.strokes || []) {
    if (!st || !st.points || !st.points.length || (st.id && rm.has(st.id)) || (ignoreBy && st.by === ignoreBy)) continue;
    items.push({ ts: st.ts || 0, pts: st.points });
  }
  for (const t of rec.texts || []) {
    if (!t || !String(t.value || "").trim() || (t.id && rm.has(t.id)) || (ignoreBy && t.by === ignoreBy)) continue;
    // 칸 크기(t.w·t.h, v2.8)가 있으면 그 칸
    const fw = t.w > 0 ? t.w : String(t.value).length * (t.size || 18) / 960 * 0.6;
    const fh = Math.max(t.h > 0 ? t.h : 0, (t.size || 18) * 1.4 / 600);
    items.push({ ts: t.ts || 0, pts: [{ x: t.x, y: t.y }, { x: t.x + fw, y: t.y + fh }] });
  }
  if (!items.length) return null;
  items.sort((a, b) => a.ts - b.ts);
  const last = items[items.length - 1].ts;
  const recent = items.filter(it => it.ts >= last - 20000).slice(-12);
  // 가로 px 단위(슬라이드 높이 = 1, 폭 = 1.6)로 계산
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of recent) for (const p of it.pts) {
    const x = Math.min(1, Math.max(0, p.x)) * 1.6, y = Math.min(1, Math.max(0, p.y));
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const PAD = 0.05;
  const P = { x0: Math.min(page.x0 * 1.6, x0), x1: Math.max(page.x1 * 1.6, x1), y0: Math.min(page.y0, y0), y1: Math.max(page.y1, y1) };
  const pw = P.x1 - P.x0, ph = P.y1 - P.y0;
  let w = x1 - x0 + PAD * 2, h = y1 - y0 + PAD * 2;
  if (w / h < aspect) w = h * aspect; else h = w / aspect;
  const minW = Math.min(pw, ph * aspect) * 0.5;         // 최대 2배까지만 확대
  const maxW = Math.max(pw, ph * aspect);               // 학습지 전체가 보이는 크기
  if (w < minW) { w = minW; h = w / aspect; }
  if (w > maxW) { w = maxW; h = w / aspect; }
  const place = (c, len, a0, a1) => (len <= a1 - a0 ? Math.min(a1 - len, Math.max(a0, c - len / 2)) : (a0 + a1) / 2 - len / 2);
  // 가로: 줄의 시작(학습지 왼쪽)부터 필기 끝까지가 학습지 폭의 80% 안이면 왼쪽부터 보이게(문제 글이 함께 보이도록),
  //       더 오른쪽에서 쓰고 있으면 필기를 따라감
  let rx;
  const fromLeft = x1 + PAD - P.x0;
  if (w <= pw && fromLeft <= Math.max(w, pw * 0.8)) {
    if (fromLeft > w) { w = fromLeft; h = w / aspect; }
    rx = P.x0;
  } else rx = place((x0 + x1) / 2, w, P.x0, P.x1);
  const ry = place((y0 + y1) / 2, h, P.y0, P.y1);
  return { x0: rx / 1.6, x1: (rx + w) / 1.6, y0: ry, y1: ry + h };
}
// 학습지 전체(내용 영역)를 aspect 칸 가운데에 맞춘 영역
function wholeRegion(page, aspect) {
  const pw = (page.x1 - page.x0) * 1.6, ph = page.y1 - page.y0;
  let w = pw, h = ph;
  if (w / h < aspect) w = h * aspect; else h = w / aspect;
  const cx = (page.x0 + page.x1) / 2 * 1.6, cy = (page.y0 + page.y1) / 2;
  return { x0: (cx - w / 2) / 1.6, x1: (cx + w / 2) / 1.6, y0: cy - h / 2, y1: cy + h / 2 };
}
// 칸이 흔들리지 않게: 가운데가 15% 이상 옮겨졌거나 크기가 20% 이상 달라졌을 때만 바꿈
function regionMoved(a, b) {
  if (!a || !b) return true;
  const aw = a.x1 - a.x0, ah = a.y1 - a.y0, bw = b.x1 - b.x0;
  return Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2) > aw * 0.15
    || Math.abs((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2) > ah * 0.15
    || Math.abs(bw - aw) / aw > 0.2;
}

// ── 편집기 ──
function Editor({ slide, lesson, update, ctx }) {
  ctx?.injectCss ? ctx.injectCss("ink", CSS) : injectCss("ink", CSS);
  const wrap = el("div", { class: "ink-wrap ink-editor" });
  const stage = el("div", { class: "ink-stage" });
  const viewer = renderSlide({
    root: stage, slide, session: null, scope: "edit", readOnly: false, zoom: true,
    authorId: ctx?.me?.id || lesson?.teacherId || null,
    onChange: () => { update({ strokes: slide.strokes, texts: slide.texts, config: slide.config }); syncImgInsp(); },
  });
  const clearBtn = el("button", {
    type: "button", class: "btn btn-sm btn-ghost",
    onClick: async () => {
      if (!(slide.strokes || []).length && !(slide.texts || []).length) return;
      const ok = await ctx.confirm("이 슬라이드의 필기를 지울까요?", { ok: "지우기", danger: true });
      if (ok) viewer.clearAll();
    },
  }, "전체 지우기");
  // 팝업 상호작용: 핀 넣기 · 끌어 옮기기 · 눌러 고치기
  const saveHotspots = (list) => { update({ config: { ...(slide.config || {}), hotspots: list } }); hs.refresh(); hsInsp.refresh(); };
  const addHotspot = () => {
    const n = hotspotsOf(slide).length;
    openHotspotEditor({ lesson, at: { x: 0.5 + ((n % 5) - 2) * 0.06, y: 0.5 }, onSave: (h) => saveHotspots([...hotspotsOf(slide), h]) });
  };
  const editHotspot = (h) => openHotspotEditor({
    lesson, hotspot: h,
    onSave: (n) => saveHotspots(hotspotsOf(slide).map(o => (o.id === n.id ? n : o))),
    onDelete: () => saveHotspots(hotspotsOf(slide).filter(o => o.id !== h.id)),
  });
  const hs = hotspotLayer(viewer.frame, {
    getSlide: () => slide, mode: "edit",
    onMove: (h, x, y) => saveHotspots(hotspotsOf(slide).map(o => (o.id === h.id ? { ...o, x, y } : o))),
    onEdit: editHotspot,
  });
  const hsInsp = hotspotInspector({
    getSlide: () => slide, onAdd: addHotspot, onEdit: editHotspot,
    onDelete: async (h) => {
      const ok = await ctx.confirm("이 팝업 상호작용을 뺄까요?", { ok: "빼기", danger: true });
      if (ok) saveHotspots(hotspotsOf(slide).filter(o => o.id !== h.id));
    },
  });
  const popBtn = el("button", { type: "button", class: "btn btn-sm btn-ghost", title: "슬라이드 위에 팝업 상호작용(핀) 넣기", onClick: addHotspot },
    [ui.icon ? ui.icon("plus", 16) : null, "팝업"]);

  const bar = makeToolbar(() => viewer, {
    extras: [popBtn, clearBtn], tools: TOOLS.concat(IMAGE_TOOL),
    // 이미지 도구: 이미지가 없거나 이미 고른 도구를 한 번 더 누르면 파일 고르기
    onTool: (id, again) => { if (id === "image" && (again || !viewer.imageCount())) pickImage(); },
  });
  const zp = zoomPill(() => viewer);
  wrap.append(bar, stage, zp);
  bar.apply();
  zp.bindZoom(viewer);

  // 인스펙터: 배경 이미지 · 기본 모드
  const bgBox = el("div", { class: "ink-insp-bg" });
  const fileIn = el("input", { type: "file", accept: "image/*,application/pdf", style: { display: "none" } });
  const btnReplace = el("button", { type: "button", class: "btn btn-sm", onClick: () => fileIn.click() }, "교체");
  const btnRemove = el("button", { type: "button", class: "btn btn-sm btn-ghost", onClick: removeBg }, "제거");
  const modeSeg = seg(MODES, slide.mode || "none", (m) => { update({ mode: m }); segSet(modeSeg, m); });
  // 슬라이드 위 이미지(여러 장, 옮기기·크기)
  const imgIn = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", multiple: true, style: { display: "none" } });
  const btnImg = el("button", { type: "button", class: "btn btn-sm", onClick: () => pickImage() }, [icon("image"), el("span", { class: "ink-insp-lbl" }, "이미지 넣기")]);
  const imgN = el("span", { class: "ink-insp-n" });
  const inspector = el("div", { class: "ink-inspector" }, [
    el("div", { class: "field ink-insp-img" }, [
      el("label", {}, "이미지"),
      el("div", { class: "ink-insp-row" }, [btnImg, imgN]),
      el("p", { class: "ink-insp-hint" }, "도구바 이미지 도구로 끌어서 옮기고, 모서리를 끌어 크기를 바꿔요. 복사한 이미지를 붙여넣거나(⌘/Ctrl+V) 끌어다 놓아도 돼요."),
      imgIn,
    ]),
    el("div", { class: "field" }, [el("label", {}, "배경 이미지"), bgBox, el("div", { class: "ink-insp-row" }, [btnReplace, btnRemove]), fileIn]),
    el("div", { class: "field" }, [el("label", {}, "기본 모드"), modeSeg]),
    hsInsp,
  ]);

  // ── 이미지 넣기 ──
  let imgBusy = 0, dead = false;
  function syncImgInsp() {
    const n = viewer.imageCount();
    imgN.textContent = n ? `${n}개` : "";
    btnImg.disabled = imgBusy > 0;
    btnImg.lastChild.textContent = imgBusy ? "올리는 중…" : "이미지 넣기";
  }
  function pickImage() { if (!imgBusy) imgIn.click(); }
  const isImageFile = (f) => !!f && (/^image\//.test(f.type || "") || /\.(png|jpe?g|webp|gif)$/i.test(f.name || ""));
  // at: 놓을 곳 가운데(프레임 정규화). 여러 장이면 조금씩 비껴 놓는다
  async function insertImages(files, at = null) {
    const list = [...(files || [])].filter(isImageFile);
    if (!list.length) { if ((files || []).length) ctx.toast("이미지 파일만 넣을 수 있어요"); return; }
    imgBusy++; syncImgInsp();
    try {
      for (let i = 0; i < list.length; i++) {
        let res;
        try { res = await storage.uploadPlacedImage(lesson?.id, slide.id, list[i]); }
        catch (e) { console.warn("[ink] 이미지 올리기 실패", e); ctx.toast("이미지를 올리지 못했어요"); continue; }
        const ar = res.ar > 0 ? res.ar : 1;
        const w = Math.min(0.5, 0.6 * ar / 1.6); // 폭 50% · 높이 60% 안
        const h = w * 1.6 / ar;
        const cx = (at ? at.x : 0.5) + i * 0.03, cy = (at ? at.y : 0.5) + i * 0.03;
        const round = (v) => Math.round(v * 10000) / 10000;
        const im = {
          id: newId("im"), url: res.url, path: res.path || null, ar,
          w: round(w), x: round(Math.max(0, Math.min(1 - w, cx - w / 2))), y: round(Math.max(0, Math.min(1 - h, cy - h / 2))),
        };
        if (dead) {
          // 다른 슬라이드로 옮겨 갔어도 올린 이미지는 이 슬라이드에 저장
          slide.config ||= {};
          (slide.config.images ||= []).push(im);
          update({ config: slide.config });
          continue;
        }
        toolState.tool = "image"; bar.sync(); bar.apply();
        viewer.addImage(im);
      }
    } finally {
      imgBusy--;
      if (!dead) syncImgInsp();
    }
  }
  imgIn.addEventListener("change", () => {
    const files = [...(imgIn.files || [])];
    imgIn.value = "";
    insertImages(files);
  });
  // 붙여넣기: 입력칸·글자 편집 중이 아니고 다른 창이 없을 때
  function onPaste(e) {
    if (dead) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.documentElement.classList.contains("has-layer")) return;
    const files = [...(e.clipboardData?.files || [])].filter(isImageFile);
    if (!files.length) return;
    e.preventDefault();
    insertImages(files);
  }
  document.addEventListener("paste", onPaste);
  // 끌어다 놓기: 놓은 곳에
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  stage.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    stage.classList.add("drop-on");
  });
  stage.addEventListener("dragleave", (e) => { if (!stage.contains(e.relatedTarget)) stage.classList.remove("drop-on"); });
  stage.addEventListener("drop", (e) => {
    stage.classList.remove("drop-on");
    if (!hasFiles(e)) return;
    e.preventDefault();
    const r = viewer.frame.getBoundingClientRect();
    const at = r.width && r.height ? {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    } : null;
    insertImages(e.dataTransfer.files, at);
  });
  let busy = false;
  function syncInspector() {
    bgBox.replaceChildren();
    const src = slide.thumb || slide.bg;
    if (src) bgBox.appendChild(el("img", { src, alt: "", decoding: "async" }));
    else bgBox.appendChild(el("span", {}, "없음"));
    btnRemove.disabled = busy || !slide.bg;
    btnReplace.disabled = busy;
    btnReplace.textContent = busy ? "올리는 중…" : (slide.bg ? "교체" : "추가");
  }
  // 방금 올렸지만 쓰지 않는 이미지(PDF 2쪽 이후)만 지운다. removeSlideImage가 썸네일까지 함께 지움.
  // 가정: 배경 교체·제거 시 옛 이미지는 지우지 않는다(진행 중/지난 수업 스냅샷이 같은 URL을 참조, teacher.js 슬라이드 삭제 정책과 동일).
  //       정리는 자료 삭제 시 cloudDeleteLesson의 폴더 삭제(removeLessonImages)에 맡긴다.
  function removeQuiet(path) {
    if (!path || typeof storage.removeSlideImage !== "function") return;
    try { const r = storage.removeSlideImage(path); r && r.catch && r.catch(() => {}); } catch (_) {}
  }
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = "";
    if (!f || busy) return;
    busy = true; syncInspector();
    try {
      let res;
      const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name || "");
      if (isPdf) {
        // PDF는 첫 페이지만 사용
        const slides = await storage.fileToSlides(f, lesson?.id, () => {});
        const first = slides && slides[0];
        if (!first || !first.bg) throw new Error("빈 PDF");
        res = { url: first.bg, path: first.bgPath || null, thumb: first.thumb || first.bg };
        (slides || []).slice(1).forEach(s => removeQuiet(s.bgPath));
      } else {
        res = await storage.uploadSlideImage(lesson?.id, slide.id, f);
      }
      if (!res || !res.url) throw new Error("업로드 실패");
      update({ bg: res.url, bgPath: res.path || null, thumb: res.thumb || res.url }); // 옛 이미지는 보존(스냅샷 참조)
      viewer.refresh();
      hs.refresh();
    } catch (e) {
      console.warn("[ink] 배경 업로드 실패", e);
      ctx.toast("이미지를 올리지 못했어요");
    } finally {
      busy = false; syncInspector();
    }
  });
  function removeBg() {
    if (!slide.bg || busy) return;
    update({ bg: null, bgPath: null, thumb: null }); // 옛 이미지는 보존(스냅샷 참조)
    viewer.refresh();
    syncInspector();
  }
  syncInspector();
  syncImgInsp();

  return {
    el: wrap,
    inspector,
    destroy() {
      dead = true;
      document.removeEventListener("paste", onPaste);
      hs.destroy();
      viewer.destroy();
    },
  };
}

// ── 학생 ──
function Student({ slide, session, me, ctx }) {
  ctx.injectCss("ink", CSS);
  const wrap = el("div", { class: "ink-wrap ink-stu" });
  let viewer = null, bar = null, key = null, stage = null, offPage = null, hs = null;
  // 팝업 핀: 자유 이동·복습(flow 'student')일 때만 학생이 눌러 연다
  const pinMode = () => (ctx.openPopup && (ctx.session() || session)?.flow === "student" ? "open" : "hidden");

  function scopeFor() {
    const ss = ctx.session() || session;
    const mode = effectiveMode(slide, ss);
    if (mode === "individual") return { scope: "individual", scopeId: me?.id, readOnly: !me };
    if (mode === "group") {
      const g = ctx.myGroup();
      return g ? { scope: "group", scopeId: g.id, readOnly: false } : { scope: null };
    }
    if (mode === "whole") return { scope: "whole", scopeId: ss?.id, readOnly: false };
    return { scope: "whole", scopeId: ss?.id, readOnly: true }; // 발표
  }
  function teardown() {
    try { offPage && offPage(); } catch (_) {}
    offPage = null;
    hs?.destroy(); hs = null;
    viewer?.destroy(); viewer = null;
    bar?.remove(); bar = null;
    stage = null;
  }
  // 도구바 위치(아래 가로 / 왼쪽 세로) 중 맞춤 대상이 더 크게 보이는 쪽을 골라 그만큼만 맞춤에서 비운다
  function placeBar() {
    const z = viewer?.zoom;
    if (!z || !stage || !bar) return;
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) return;
    if (bar.classList.contains("ink-zoombar")) { z.setInsets({}); return; } // 작은 확대 버튼은 비우지 않음
    const pa = z.focusAspect() || 1.6;
    const page = (w, h) => Math.min(w / pa, h);           // 맞춤 대상의 화면 높이
    const bottomH = page(W - 20, H - 84 - 20);            // 도구바(56) + 아래 여백(8+틈)
    const sideH = page(W - 120 - 20, H - 20);             // 2열(100) + 왼쪽 여백(8+틈)
    const side = sideH > bottomH * 1.04 && H >= 280;
    wrap.classList.toggle("bar-side", side);
    wrap.classList.toggle("bar-compact", side && H < 540);
    const sr = stage.getBoundingClientRect(), br = bar.getBoundingClientRect();
    z.setInsets(side ? { left: Math.max(0, br.right - sr.left) + 2 } : { bottom: Math.max(0, sr.bottom - br.top) + 2 });
  }
  const ro = new ResizeObserver(() => placeBar());
  ro.observe(wrap);
  function mount(s) {
    teardown();
    wrap.classList.remove("has-float", "bar-side", "bar-compact");
    if (!s.scope) {
      wrap.replaceChildren(el("div", { class: "ink-wait" }, [el("div", { class: "empty" }, "모둠을 기다리고 있어요")]));
      return;
    }
    stage = el("div", { class: "ink-stage" });
    wrap.replaceChildren(stage);
    viewer = renderSlide({
      root: stage, slide, session: ctx.session() || session, zoom: true,
      scope: s.scope, scopeId: s.scopeId, readOnly: s.readOnly, authorId: me?.id || null,
    });
    if (!s.readOnly) {
      bar = makeToolbar(() => viewer, { float: true, zoom: true });
      bar.apply();
    } else {
      bar = zoomPill(() => viewer); // 발표(읽기 전용): 확대 버튼만
    }
    wrap.appendChild(bar);
    wrap.classList.add("has-float");
    bar.bindZoom(viewer);
    offPage = viewer.zoom?.onChange((kind) => { if (kind === "page") placeBar(); }) || null;
    placeBar();
    if (hotspotsOf(slide).length) hs = hotspotLayer(viewer.frame, { getSlide: () => slide, mode: pinMode(), onOpen: (h) => ctx.openPopup?.(h.id) });
  }
  function check() {
    const s = scopeFor();
    const k = `${s.scope}|${s.scopeId}|${!!s.readOnly}`;
    if (k !== key) { key = k; mount(s); }
    else viewer?.refresh();
    hs?.setMode(pinMode());
  }
  check();

  return {
    el: wrap,
    onActivity: check,
    onSession: check,
    destroy() { ro.disconnect(); teardown(); },
  };
}

// ── 교사 진행 ──
function TeacherLive({ slide, session, ctx }) {
  ctx.injectCss("ink", CSS);
  const wrap = el("div", { class: "ink-wrap ink-live" });
  const me = ctx.me || null;
  let bodyKey = null;
  let viewer = null, bar = null, fit = null;   // whole 캔버스
  let gal = null;                              // 갤러리
  let zoom = null;                             // 확대 모달 { viewer, fit, modal, kind, id }
  let presCh = null, presOff = null;
  let gbModal = null;
  let hs = null, hsChips = null;               // 팝업 핀(전체·발표) / 머리 줄 버튼(개별·모둠)
  const openPop = (h) => ctx.openPopup?.(h.id);
  const activePop = () => (ctx.popupId ? ctx.popupId() : null);

  const curMode = () => effectiveMode(slide, ctx.session() || session);

  function teardownBody() {
    fit?.destroy(); fit = null;
    hs?.destroy(); hs = null;
    hsChips = null;
    viewer?.destroy(); viewer = null;
    bar = null;
    gal?.destroy(); gal = null;
  }

  function mountBody() {
    teardownBody();
    const m = curMode();
    bodyKey = (m === "individual" || m === "group") ? m : "whole";
    if (bodyKey === "whole") {
      const stage = el("div", { class: "ink-stage" });
      const ss = ctx.session() || session;
      viewer = renderSlide({ root: stage, slide, session: ss, scope: "whole", scopeId: ss?.id, readOnly: false, authorId: me?.id || null, zoom: true });
      const clearBtn = el("button", {
        type: "button", class: "btn btn-sm btn-ghost",
        onClick: async () => {
          const ok = await ctx.confirm("전체 필기를 지울까요?", { ok: "지우기", danger: true });
          if (ok) viewer?.clearAll();
        },
      }, "전체 지우기");
      bar = makeToolbar(() => viewer, { extras: [clearBtn] });
      const zp = zoomPill(() => viewer);
      wrap.replaceChildren(bar, stage, zp);
      bar.apply();
      zp.bindZoom(viewer);
      if (hotspotsOf(slide).length) hs = hotspotLayer(viewer.frame, { getSlide: () => slide, mode: ctx.openPopup ? "open" : "hidden", onOpen: openPop, activeId: activePop });
    } else {
      gal = makeGallery(bodyKey);
      wrap.replaceChildren(gal.el);
    }
  }

  // 학생/모둠 갤러리
  function makeGallery(kind) {
    const root = el("div", { class: "ink-gallery" });
    const grid = el("div", { class: "ink-tiles fit" });
    const viewSeg = seg([["focus", "필기 부분"], ["page", "전체"]], galleryView, (v) => {
      galleryView = v; segSet(viewSeg, v);
      try { localStorage.setItem(GAL_KEY, v); } catch {}
      for (const t of tiles.values()) t.region = null;
      lastKey = ""; update();
    }, "seg-sm");
    const countNote = el("span", { class: "ink-note" });
    hsChips = hotspotsOf(slide).length && ctx.openPopup ? hotspotChips({ getSlide: () => slide, onOpen: openPop, activeId: activePop }) : null;
    const head = el("div", { class: "ink-gal-head" }, [hsChips, countNote, viewSeg]);
    const emptyBox = el("div", { class: "ink-stage" });
    let emptyViewer = null, emptyFit = null;
    const tiles = new Map(); // id → { node, mini, dot, name, cnt }
    let focus = { x0: 0, y0: 0, x1: 1, y1: 1 }, raf = 0, lastKey = "", curW = 0;
    pageRectFor(slide.thumb || slide.bg).then(p => {
      focus = p.focus;
      for (const t of tiles.values()) t.region = null;
      lastKey = ""; update();
    });
    // 칸에 보여 줄 영역: 필기 부분이면 최근에 쓴 곳, 아니면 학습지 전체
    function placeTile(t, rec) {
      const next = galleryView === "focus"
        ? (writingRegion(rec, focus, FOCUS_ASPECT, me?.id) || wholeRegion(focus, FOCUS_ASPECT))
        : focus;
      if (t.region && !regionMoved(t.region, next)) return;
      const animate = !!t.region && galleryView === "focus";
      t.region = next;
      t.mini.setPage(next, { animate });
    }

    // 칸 크기: 모두 한 화면에 들어오는 배치 중 가장 큰 칸. 최소 폭(200px)보다 작아지면 그 폭으로 두고 스크롤.
    const GAP = 12, EXTRA = 40, MIN_W = 200; // EXTRA = 칸 안쪽 여백 + 이름 줄
    function layout() {
      raf = 0;
      const n = grid.children.length;
      const W = root.clientWidth - 4, H = root.clientHeight - 4 - (head.isConnected ? head.offsetHeight + 12 : 0);
      if (!n || W <= 0 || H <= 0) return;
      const A = galleryView === "focus" ? FOCUS_ASPECT : (focus.x1 - focus.x0) * 1.6 / (focus.y1 - focus.y0); // 칸 그림 비율(가로/세로)
      let best = { cols: 1, w: 0 };
      for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const colW = (W - GAP * (cols - 1)) / cols;
        const w = Math.min(colW, ((H - GAP * (rows - 1)) / rows - EXTRA) * A + 12);
        if (w > best.w) best = { cols, w };
        if (colW < MIN_W) break;
      }
      if (best.w < MIN_W) {
        const cols = Math.max(1, Math.floor((W + GAP) / (MIN_W + GAP)));
        best = { cols, w: (W - GAP * (cols - 1)) / cols };
      }
      const w = Math.floor(best.w);
      const key = `${n}|${best.cols}|${w}|${galleryView}`;
      if (key === lastKey) return;
      lastKey = key; curW = w;
      grid.style.gridTemplateColumns = `repeat(${best.cols}, ${w}px)`;
      for (const t of tiles.values()) t.mini.setPx(w - 12);
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(layout); };
    const ro = new ResizeObserver(schedule);
    ro.observe(root);

    function items() {
      const ss = ctx.session() || session;
      if (kind === "group") {
        return (ctx.groups() || []).map(g => ({
          id: g.id, name: g.name || "모둠", members: g.memberIds || [],
          rec: ss?.records?.__groups?.[g.id]?.[slide.id] || null,
        }));
      }
      return (ctx.participants() || []).slice().sort(studentSort(ctx)).map(id => ({
        id, name: studentName(id, ctx), members: [id], rec: ss?.records?.[id]?.[slide.id] || null,
      }));
    }
    function showEmpty(on) {
      if (on) {
        if (!emptyViewer) {
          // 배경만 보이는 스테이지 + 한 줄
          emptyViewer = renderSlide({ root: emptyBox, slide, session: null, scope: "bg", readOnly: true });
          emptyFit = fitFrame(emptyBox);
        }
        const msg = kind === "group" ? "모둠을 편성해 주세요" : "아직 아무도 없어요";
        const btn = kind === "group" ? el("button", { type: "button", class: "btn btn-sm", onClick: openGroupBuilder }, "모둠 편성") : null;
        root.replaceChildren(el("div", { class: "empty" }, [msg, btn ? " " : null, btn]), emptyBox);
      } else if (emptyViewer) {
        emptyFit?.destroy(); emptyFit = null;
        emptyViewer.destroy(); emptyViewer = null;
        root.replaceChildren(head, grid);
      } else if (grid.parentNode !== root) {
        root.replaceChildren(head, grid);
      }
    }
    function update() {
      const list = items();
      showEmpty(list.length === 0);
      const online = ctx.online() || new Set();
      const seen = new Set();
      list.forEach((it, i) => {
        seen.add(it.id);
        let t = tiles.get(it.id);
        if (!t) {
          const mini = miniFrame(slide, { crop: true });
          if (curW) mini.setPx(curW - 12);
          const dot = el("i", { class: "dot" });
          const name = el("span", {});
          const cnt = el("em", { class: "ink-cnt" });
          const node = el("button", { type: "button", class: "ink-tile", onClick: () => openZoom(kind, it.id) },
            [mini, el("div", { class: "ink-tile-name" }, [dot, name, cnt])]);
          t = { node, mini, dot, name, cnt, region: null };
          tiles.set(it.id, t);
        }
        if (grid.children[i] !== t.node) grid.insertBefore(t.node, grid.children[i] || null);
        if (t.name.textContent !== it.name) t.name.textContent = it.name;
        t.dot.classList.toggle("on", it.members.some(id => online.has(id)));
        t.cnt.textContent = kind === "group" ? `${it.members.length}명` : "";
        placeTile(t, it.rec);
        t.mini.paint(it.rec); // 레코드 변경 시만 다시 그림
      });
      for (const [id, t] of tiles) if (!seen.has(id)) { t.node.remove(); tiles.delete(id); }
      countNote.textContent = kind === "group" ? `${list.length}모둠` : `${list.length}명`;
      schedule(); // 인원·보기가 바뀌었을 수 있음(같으면 layout이 바로 끝남)
    }
    function updateDots() {
      const online = ctx.online() || new Set();
      for (const it of items()) {
        const t = tiles.get(it.id);
        if (t) t.dot.classList.toggle("on", it.members.some(id => online.has(id)));
      }
    }
    update();
    return {
      el: root, update, updateDots,
      destroy() { ro.disconnect(); if (raf) cancelAnimationFrame(raf); emptyFit?.destroy(); emptyViewer?.destroy(); tiles.clear(); root.remove(); },
    };
  }

  // 타일 탭 → 크게 보기 (교사 첨삭 가능)
  function openZoom(kind, id) {
    closeZoom();
    const ss = ctx.session() || session;
    const title = kind === "group" ? ((ctx.groups() || []).find(g => g.id === id)?.name || "모둠") : studentName(id, ctx);
    const body = el("div", { class: "ink-wrap ink-zoom" });
    const stage = el("div", { class: "ink-stage" });
    const z = { kind, id, viewer: null, fit: null, modal: null };
    z.viewer = renderSlide({
      root: stage, slide, session: ss, scope: kind === "group" ? "group" : "individual", scopeId: id,
      readOnly: false, authorId: me?.id || null, zoom: true,
    });
    const zbar = makeToolbar(() => z.viewer);
    const zp = zoomPill(() => z.viewer);
    body.append(zbar, stage, zp);
    zbar.apply();
    zp.bindZoom(z.viewer);
    zoom = z;
    z.modal = openModal(ctx, {
      title, body,
      actions: [], // 닫기는 모달 X·바깥 탭
      onClose: () => { if (zoom === z) zoom = null; z.fit?.destroy(); z.viewer?.destroy(); },
    });
  }
  function closeZoom() {
    if (!zoom) return;
    const z = zoom;
    zoom = null;
    z.modal?.close();
    z.fit?.destroy(); z.viewer?.destroy();
  }

  // ── 모둠 편성 모달 ──
  function openGroupBuilder() {
    if (gbModal?.isOpen()) return;
    let size = 4;
    let selected = null;
    let draft = (ctx.groups() || []).map(g => ({ id: g.id, name: g.name, memberIds: (g.memberIds || []).slice() }));
    const poolIds = () => {
      const s = new Set([...(ctx.participants() || []), ...(ctx.online() || [])]);
      draft.forEach(g => g.memberIds.forEach(id => s.add(id)));
      return [...s];
    };
    const body = el("div", { class: "ink-gb" });
    const sizeSeg = seg([["2", "2"], ["3", "3"], ["4", "4"], ["5", "5"]], String(size), (v) => { size = +v; segSet(sizeSeg, v); });
    const top = el("div", { class: "ink-gb-top" }, [
      el("span", { class: "ink-gb-title" }, "조 크기"), sizeSeg,
      el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: randomize }, "랜덤 편성"),
      el("button", { type: "button", class: "btn btn-sm btn-ghost", onClick: addGroup }, "+ 모둠"),
    ]);
    const area = el("div", { class: "ink-gb-groups" });
    body.append(top, area);

    function randomize() {
      const parts = groupStudents(poolIds(), size);
      draft = parts.map((m, i) => ({ id: newId("grp"), name: `${i + 1}모둠`, memberIds: m }));
      selected = null;
      render();
    }
    function addGroup() {
      draft.push({ id: newId("grp"), name: `${draft.length + 1}모둠`, memberIds: [] });
      render();
    }
    function moveTo(gid) {
      if (!selected) return;
      draft.forEach(g => { g.memberIds = g.memberIds.filter(x => x !== selected); });
      if (gid) draft.find(g => g.id === gid)?.memberIds.push(selected);
      selected = null;
      render();
    }
    function chip(id, gid) {
      const online = ctx.online() || new Set();
      return el("button", {
        type: "button", class: "ink-chip" + (selected === id ? " sel" : ""),
        onClick: (e) => {
          e.stopPropagation();
          if (selected === id) { selected = null; render(); return; }
          if (selected) { moveTo(gid); return; } // 탭→탭: 이 칩의 모둠으로 이동
          selected = id; render();
        },
      }, [el("i", { class: "dot" + (online.has(id) ? " on" : "") }), studentName(id, ctx)]);
    }
    function box(title, ids, gid, isPool) {
      return el("div", {
        class: "ink-gb-box" + (isPool ? " is-pool" : "") + (selected ? " can-drop" : ""),
        onClick: () => moveTo(gid),
      }, [
        el("div", { class: "ink-gb-title" }, [el("span", {}, title), el("span", {}, `${ids.length}명`)]),
        el("div", { class: "ink-gb-chips" }, ids.slice().sort(studentSort(ctx)).map(id => chip(id, gid))),
      ]);
    }
    function render() {
      const assigned = new Set(draft.flatMap(g => g.memberIds));
      const pool = poolIds().filter(id => !assigned.has(id));
      area.replaceChildren(
        ...draft.map(g => box(g.name, g.memberIds, g.id, false)),
        box("미배정", pool, null, true),
      );
    }
    render();
    gbModal = openModal(ctx, {
      title: "모둠 편성", body,
      actions: [
        { label: "취소", onClick: (close) => close() },
        {
          label: "저장", primary: true,
          onClick: (close) => {
            const groups = draft.filter(g => g.memberIds.length)
              .map((g, i) => ({ id: g.id, name: `${i + 1}모둠`, memberIds: g.memberIds.slice() }));
            const ss = ctx.session();
            if (ss && typeof cloud.patchSession === "function") cloud.patchSession(ss, { groups });
            ctx.toast("모둠을 저장했어요");
            close();
          },
        },
      ],
      onClose: () => { gbModal = null; },
    });
  }

  // 가정(v2.7): 필기 슬라이드는 교사 패널을 두지 않는다 — 모드 전환은 수업 진행 상단 바에만 있고(중복 제거),
  //       모둠 편성은 상단 바의 [모둠] 버튼이 actions.groups()로 연다.

  // 온라인 점 (presence)
  function attachPresence() {
    const ch = typeof realtime.currentChannel === "function" ? realtime.currentChannel() : null;
    if (ch === presCh) return;
    try { presOff && presOff(); } catch (_) {}
    presCh = ch; presOff = null;
    if (ch && typeof ch.onPresence === "function") {
      try { presOff = ch.onPresence(() => gal?.updateDots()); } catch (_) {}
    }
  }

  function update() {
    const m = curMode();
    const k = (m === "individual" || m === "group") ? m : "whole";
    if (k !== bodyKey) mountBody();
    else if (viewer) viewer.refresh();
    else gal?.update();
    zoom?.viewer?.refresh();
    hs?.refresh();
    hsChips?.set();
    attachPresence();
  }

  mountBody();
  attachPresence();

  return {
    el: wrap,
    actions: { groups: openGroupBuilder }, // 코어(수업 진행 상단 바)가 부르는 동작
    onActivity: update,
    onSession: update,
    destroy() {
      closeZoom();
      gbModal?.close(); gbModal = null;
      try { presOff && presOff(); } catch (_) {}
      presOff = null;
      teardownBody();
    },
  };
}

// ── 썸네일 ──
function thumb(slide) {
  injectCss("ink", CSS);
  const src = slide.thumb || slide.bg;
  const d = el("div", { class: "ink-thumb" + (src ? "" : " is-paper") });
  if (src) d.appendChild(el("img", { src, alt: "", loading: "lazy", decoding: "async" }));
  const il = imageLayer(slide, { lazy: true });
  if (il) d.appendChild(il);
  if (hasInk(slide)) {
    const c = el("canvas", {});
    paintStrokes(c, slide.strokes || [], { texts: slide.texts || [], width: 320, height: 200 });
    d.appendChild(c);
  }
  return d;
}

// ── 기록(읽기 전용) ──
function summary(slide, responses, session, ctx) {
  injectCss("ink", CSS);
  const wrap = el("div", { class: "ink-summary" });
  const recs = session?.records || {};
  const whole = recs.__whole?.[slide.id];
  const indiv = Object.entries(recs)
    .filter(([k, v]) => !k.startsWith("__") && hasInk(v?.[slide.id]))
    .map(([k, v]) => ({ id: k, rec: v[slide.id] }))
    .sort((a, b) => studentSort(ctx)(a.id, b.id));
  const groupNames = new Map((session?.groups || []).map(g => [g.id, g.name]));
  const grp = Object.entries(recs.__groups || {})
    .filter(([, v]) => hasInk(v?.[slide.id]))
    .map(([k, v]) => ({ id: k, rec: v[slide.id] }));

  if (hasInk(whole) || (!indiv.length && !grp.length)) {
    const m = miniFrame(slide, { big: true });
    m.paint(whole || null);
    wrap.appendChild(m);
  }
  const gallery = (title, list, nameOf) => {
    if (!list.length) return;
    wrap.appendChild(el("div", { class: "ink-sum-head" }, title));
    wrap.appendChild(el("div", { class: "ink-tiles" }, list.map(it => {
      const m = miniFrame(slide);
      m.paint(it.rec);
      return el("div", { class: "ink-tile static" }, [m, el("div", { class: "ink-tile-name" }, [el("span", {}, nameOf(it.id))])]);
    })));
  };
  gallery(`개별 필기 ${indiv.length}명`, indiv, (id) => studentName(id, ctx));
  gallery(`모둠 필기 ${grp.length}개`, grp, (id) => groupNames.get(id) || "모둠");
  return wrap;
}

registerSlideType({
  type: "ink",
  category: "basic",
  label: "필기",
  desc: "배경 위에 함께 필기",
  icon: PEN_ICON,
  create() {
    // 새 필기 슬라이드의 기본 모드 = 발표(수업 중 상단 모드 seg로 전체·개별·모둠으로 바꿈)
    return { type: "ink", title: null, config: {}, bg: null, bgPath: null, thumb: null, mode: "none", strokes: [], texts: [] };
  },
  thumb,
  Editor,
  Student,
  TeacherLive,
  summary,
});
