// 담벼락 — 패들렛 같은 보드: 글(포스트잇)·댓글·고정·교사 자리 옮기기. (§6.4)
// 글  = Response(itemKey 'post_…'), payload { text ≤200자, color 0..4, at: 처음 올린 시각(ms), author?: 'teacher' }
// 댓글 = Response(itemKey 'cmt_…'),  payload { postKey, text ≤200자, at, author?: 'teacher' }
// activity[slideId] = { phase ('ended' = 잠금), order: [postKey] (교사 배치), pinned: [postKey] (고정) }
// 보이는 순서(모두 같음): 고정(pinned 순) → order 에 없는 글(새 글, 최신 순) → order 순.
// 가정: itemKey 가 'cmt_' 로 시작하지 않고 payload.text 가 문자열이면 글로 본다(예전 'post_…' 글 호환).
// 가정: 교사 글·댓글 = studentId === session.teacherId (그 값을 모를 때만 payload.author === 'teacher').
// 가정: 잠금은 학생만 막는다 — 교사는 잠겨도 글·댓글을 쓸 수 있다.
// 가정: allowColor 는 '학생이 색 고르기' — 교사 글은 항상 고른 색을 쓴다.
// 가정: 교사 삭제(글·댓글)는 confirm 없이 toast '삭제했어요'. 학생은 글 삭제만 confirm, 댓글 삭제는 바로.
// 가정: 새로 고정한 글은 고정 목록 끝에 붙는다(먼저 고정한 글이 앞). 고정 글은 고정끼리만 끌어 옮긴다.
// 가정: 끌어 놓으면 그 구역(고정 / 나머지)의 지금 순서 전체를 pinned 또는 order 로 저장한다(새 글도 이때 배치에 들어감).
// 가정: 댓글이 0개면 버튼은 '댓글'만, 요약에서는 숨긴다. 댓글은 오래된 순.
// 가정: 작성 시트는 ui.sheet({ title, body, actions }) 를 쓴다(styles.css 의 .sheet).
import * as ui from "../ui.js";
import * as store from "../store.js";
import { registerSlideType, injectCss, newId } from "./registry.js";

const { el } = ui;

const MAX_LEN = 200;
export const WALL_COLORS = ["#fff4c2", "#fde2e4", "#dbeafe", "#dcfce7", "#ede9fe"];
const HOLD_MS = 300;     // 터치·펜: 길게 눌러 들기
const MOUSE_SLOP = 6;    // 마우스: 이만큼 움직이면 들기
const TOUCH_SLOP = 8;    // 길게 누르기 전에 이만큼 움직이면 스크롤로 본다
const EASE = "cubic-bezier(.2,.7,.2,1)";
const ENTER = [{ opacity: 0, transform: "translateY(6px) scale(.98)" }, { opacity: 1, transform: "none" }];

const CSS = `
.wl{position:relative;display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;padding:16px;box-sizing:border-box}
.wl-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}
.wl-prompt{margin:0;font-size:20px;font-weight:700;line-height:1.35;color:var(--ink);white-space:pre-wrap;word-break:keep-all;flex:1;min-width:0}
.wl-prompt:empty{display:none}
.wl-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wl-scroll{flex:1;min-height:0;overflow:auto;padding-bottom:80px;overscroll-behavior:contain}
.wl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;align-items:start}
.wl-stu .wl-grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
.wl-card{position:relative;display:flex;flex-direction:column;gap:4px;min-height:96px;padding:14px 14px 4px;border-radius:var(--radius-sm);
  box-shadow:var(--shadow-1);color:#1c1c22;box-sizing:border-box}
.wl-card.mine{outline:2px solid rgba(79,70,229,.3);outline-offset:-2px}
.wl-pin{position:absolute;top:9px;right:9px;display:flex;color:rgba(28,28,34,.5)}
.wl-card.is-pin .wl-text{padding-right:16px}
.wl-text{flex:1;font-size:15px;line-height:1.5;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.wl-text.tap{cursor:pointer}
.wl-foot{display:flex;align-items:center;min-height:36px;margin-right:-8px;font-size:12px;color:rgba(28,28,34,.6)}
.wl-stu .wl-foot{min-height:44px}
.wl-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.wl-name:empty{display:none}
.wl-tb{display:inline-flex;align-items:center;flex:none;height:20px;padding:0 8px;border-radius:999px;background:var(--accent-soft);color:var(--accent-ink);
  font-size:11px;font-weight:700;letter-spacing:-.01em}
.wl-cbtn{flex:none;display:inline-flex;align-items:center;min-height:36px;padding:0 6px;border:0;border-radius:8px;background:none;color:inherit;
  font:inherit;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent}
.wl-name:not(:empty)+.wl-cbtn::before{content:"·";margin-right:6px;font-weight:400}
.wl-name:empty+.wl-cbtn{margin-left:-6px}
.wl-stu .wl-cbtn{min-height:44px}
.wl-cbtn.on{color:#1c1c22}
span.wl-cbtn{min-height:0;cursor:default}
.wl-cbtn:empty{display:none}
.wl-more{flex:none;margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border:0;border-radius:10px;
  background:none;color:rgba(28,28,34,.55);cursor:pointer;-webkit-tap-highlight-color:transparent}
.wl-stu .wl-more{width:44px;height:44px}
.wl-cmts{display:flex;flex-direction:column;gap:6px;margin:0 -6px 8px;padding:6px 8px 8px;border-radius:8px;background:rgba(255,255,255,.55);
  cursor:auto;user-select:text;-webkit-user-select:text}
.wl-clist{display:flex;flex-direction:column}
.wl-clist:empty{display:none}
.wl-c{display:flex;align-items:flex-start;gap:2px;font-size:13px;line-height:1.45}
.wl-cbody{flex:1;min-width:0;padding:6px 0;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.wl-cname{font-weight:700;margin-right:6px}
.wl-cname:empty{display:none}
.wl-cname.wl-tb{height:18px;vertical-align:1px}
.wl-cdel{flex:none;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;margin:-2px -4px -2px 0;border:0;border-radius:8px;
  background:none;color:rgba(28,28,34,.45);cursor:pointer}
.wl-stu .wl-cdel{width:44px;height:44px;margin:-6px -6px -6px 0}
.wl-cform{display:flex;align-items:center;gap:6px}
.wl .wl-cin{flex:1;height:36px;min-height:36px;padding:0 10px;font-size:14px;background:rgba(255,255,255,.9)}
.wl-stu .wl-cin{height:44px;min-height:44px;font-size:16px}
.wl .wl-csend{--btn-h:36px;flex:none}
.wl-stu .wl-csend{--btn-h:44px}
@media (hover:hover){.wl-cbtn:hover,.wl-more:hover,.wl-cdel:hover{background:rgba(255,255,255,.6);color:#1c1c22}}
.wl-pin[hidden],.wl-more[hidden],.wl-cmts[hidden],.wl-cform[hidden],.wl-cdel[hidden]{display:none}
.wl-teacher .wl-card{cursor:grab;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
.wl-card.wl-ph{background:transparent!important;box-shadow:none;outline:2px dashed rgba(28,28,34,.2);outline-offset:-2px}
.wl-card.wl-ph>*{visibility:hidden}
.wl-dragging,.wl-dragging *{cursor:grabbing!important}
.wl-ghost{position:fixed;left:0;top:0;z-index:1000;margin:0;pointer-events:none;overflow:hidden;box-shadow:var(--shadow-2);will-change:transform;
  user-select:none;-webkit-user-select:none}
.wl-menu{position:fixed;z-index:300;min-width:132px}
.wl-menu-lg>button{height:44px}
.wl-menu .icon{display:inline-flex;color:var(--ink-2)}
.wl-menu .danger .icon{color:inherit}
.wl-empty{padding:40px 0}
.wl-fab{position:absolute;left:50%;bottom:calc(16px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:5;box-shadow:var(--shadow-2);min-width:160px}
.wl-fab:active:not(:disabled){transform:translateX(-50%) translateY(1px)}
.wl-teacher .wl-fab{left:auto;right:16px;transform:none;min-width:0}
.wl-teacher .wl-fab:active:not(:disabled){transform:translateY(1px)}
.wl-compose{display:flex;flex-direction:column;gap:12px}
.wl-ta{min-height:120px;resize:vertical;font-size:16px;line-height:1.5}
.wl-sheet-row{display:flex;align-items:center;gap:10px}
.wl-count{margin-left:auto;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.wl-dots{display:flex;gap:10px}
.wl-dot{width:32px;height:32px;border-radius:50%;border:1.5px solid var(--line-strong);cursor:pointer;padding:0}
.wl-dot.on{box-shadow:0 0 0 3px var(--surface),0 0 0 5px var(--accent)}
.wl-editor{display:flex;flex-direction:column;gap:14px;width:100%;max-width:560px;margin:0 auto;padding:24px;box-sizing:border-box}
.wl-check{display:flex;align-items:center;gap:10px;min-height:40px;cursor:pointer}
.wl-check input{width:20px;height:20px;accent-color:var(--accent)}
.wl-sum .wl-scroll{overflow:visible;padding-bottom:0}
.wl-sum .wl-card{break-inside:avoid}
.wl-sum .wl-foot{min-height:28px}
.wl-sum .wl-cmts{margin-bottom:10px}
.wl-sum .wl-c{font-size:12px}
.wl-sum .wl-cbody{padding:2px 0}
`;
function ensureCss(ctx) { (ctx?.injectCss || injectCss)("wall", CSS); }

const pinSvg = (size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;

function nameOf(ctx, id) {
  return ctx?.students?.()?.get?.(id)?.name || store.findStudent?.(id)?.name || "";
}
const timeOf = (r) => r?.payload?.at || r?.updatedAt || 0;
const clip = (s) => Array.from(String(s ?? "")).slice(0, MAX_LEN).join("");
const isCmtKey = (k) => typeof k === "string" && k.startsWith("cmt_");
const isPost = (r) => !!(r && r.itemKey && !isCmtKey(r.itemKey) && r.payload && typeof r.payload.text === "string");
const isCmt = (r) => !!(r && isCmtKey(r.itemKey) && r.payload && typeof r.payload.text === "string" && r.payload.postKey);
const colorOf = (r, allowColor) => {
  const n = WALL_COLORS.length;
  return WALL_COLORS[allowColor ? (((r.payload.color | 0) % n) + n) % n : 0];
};
const motionOk = () => !(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);

// 응답 → 글 목록 + 글별 댓글(오래된 순). 글이 없는 댓글은 그리지 않는다.
function splitResponses(list) {
  const posts = [], cmts = new Map();
  for (const r of list || []) {
    if (isPost(r)) posts.push(r);
    else if (isCmt(r)) {
      const k = r.payload.postKey;
      if (!cmts.has(k)) cmts.set(k, []);
      cmts.get(k).push(r);
    }
  }
  for (const a of cmts.values()) a.sort((x, y) => timeOf(x) - timeOf(y));
  return { posts, cmts };
}

// 보이는 순서: 고정 → 배치(order)에 없는 새 글(최신 순) → 배치 순
function arrange(posts, act) {
  const by = new Map(posts.map(r => [r.itemKey, r]));
  const seen = new Set();
  const take = (keys) => (Array.isArray(keys) ? keys : []).filter(k => by.has(k) && !seen.has(k) && !!seen.add(k));
  const pinned = take(act?.pinned);
  const ordered = take(act?.order);
  const fresh = posts.filter(r => !seen.has(r.itemKey)).sort((a, b) => timeOf(b) - timeOf(a));
  return { list: [...pinned.map(k => by.get(k)), ...fresh, ...ordered.map(k => by.get(k))], pinned: new Set(pinned) };
}

// FLIP: 옮기기 전 위치(r0)에서 지금 자리로 미끄러지게
function flipFrom(node, r0) {
  node._wlFlip?.cancel();
  const r1 = node.getBoundingClientRect();
  const dx = r0.left - r1.left, dy = r0.top - r1.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  node._wlFlip = node.animate?.([{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], { duration: 220, easing: EASE });
}

// 순서 맞추기 — pivot(포커스 든 카드)은 그대로 두고 나머지를 앞뒤로 붙인다(댓글 입력 중 포커스·키보드 유지)
function reorder(parent, nodes, pivot) {
  if (!nodes.length) return;
  let i0 = pivot ? nodes.indexOf(pivot) : -1;
  if (i0 < 0) { i0 = 0; if (parent.firstChild !== nodes[0]) parent.insertBefore(nodes[0], parent.firstChild); }
  for (let i = i0 - 1; i >= 0; i--) if (nodes[i].nextSibling !== nodes[i + 1]) parent.insertBefore(nodes[i], nodes[i + 1]);
  for (let i = i0 + 1; i < nodes.length; i++) if (nodes[i - 1].nextSibling !== nodes[i]) parent.insertBefore(nodes[i], nodes[i - 1].nextSibling);
}

// ── 보드: 글 카드는 postKey, 댓글 행은 studentId|itemKey 로 DOM 보존(깜빡임 없음) ──
// o: { mode: 'student'|'teacher'|'summary', ctx, allowColor, showNames, myId, teacherId()→id, locked()→bool,
//      source()→[responses, activity], onEdit(r), onDelete(r), onPin(r), onArrange(kind, keys),
//      onComment(postKey, text)→Promise<bool>, onDeleteComment(c) }
function createBoard(o) {
  const live = o.mode !== "summary";
  const isT = o.mode === "teacher";
  const grid = el("div", { class: "wl-grid" });
  const empty = el("div", { class: "empty wl-empty" }, "아직 글이 없어요");
  const scroll = el("div", { class: "wl-scroll" }, [grid, empty]);
  const cards = new Map();   // postKey → 카드
  let pinnedSet = new Set();
  let first = true, count = 0;
  let menu = null, press = null, drag = null, swallow = false;

  const locked = () => !!o.locked?.();
  const byTeacher = (r) => { const t = o.teacherId?.(); return t ? r.studentId === t : r.payload?.author === "teacher"; };
  const mineOf = (r) => !!o.myId && r.studentId === o.myId;
  // 고치기: 학생은 잠기기 전 내 글, 교사는 내(교사) 글
  const canEdit = (r) => live && mineOf(r) && (isT || !locked());
  const canComment = () => live && (isT || !locked());
  const canDelCmt = (c) => live && (isT || (mineOf(c) && !locked()));

  function who(r) {
    if (byTeacher(r)) return { s: "선생님", t: true };   // showNames 와 상관없이 항상
    if (!isT && mineOf(r)) return { s: "나", t: false };
    if (o.mode === "student" && !o.showNames) return { s: "", t: false };
    return { s: nameOf(o.ctx, r.studentId) || (o.mode === "student" ? "" : "학생"), t: false };
  }
  function setWho(node, w) {
    if (node.textContent !== w.s) node.textContent = w.s;
    node.classList.toggle("wl-tb", w.t);
  }

  function build(key) {
    const pin = el("span", { class: "wl-pin", html: pinSvg(15), hidden: true });
    const text = el("div", { class: "wl-text" });
    const name = el("span", { class: "wl-name" });
    const cbtn = live ? el("button", { type: "button", class: "wl-cbtn", "aria-expanded": "false" }) : el("span", { class: "wl-cbtn" });
    const more = live ? el("button", { type: "button", class: "wl-more", "aria-label": "더보기", "aria-haspopup": "menu", hidden: true }, ui.icon("more", 18)) : null;
    const clist = el("div", { class: "wl-clist" });
    const input = live ? el("input", { class: "input wl-cin", type: "text", maxlength: MAX_LEN, placeholder: "댓글", autocomplete: "off", enterkeyhint: "send" }) : null;
    const send = live ? el("button", { type: "button", class: "btn btn-sm wl-csend" }, "등록") : null;
    const cform = live ? el("div", { class: "wl-cform" }, [input, send]) : null;
    const cbox = el("div", { class: "wl-cmts", hidden: true }, [clist, cform]);
    const card = el("div", { class: "wl-card", "data-key": key }, [pin, text, el("div", { class: "wl-foot" }, [name, cbtn, more]), cbox]);
    const e = { key, card, pin, text, name, cbtn, more, clist, cform, cbox, input, open: !live, sig: "", r: null, cmts: [], rows: new Map(), fresh: false };
    if (!live) return e;
    cbtn.addEventListener("click", () => { e.open = !e.open; renderCmts(e); });
    more.addEventListener("click", (ev) => { ev.stopPropagation(); toggleMenu(e); });
    text.addEventListener("click", () => { if (!swallow && e.r && canEdit(e.r)) o.onEdit?.(e.r); });
    const submit = async () => {
      const v = clip(input.value.trim());
      if (!v || !canComment()) return;
      input.value = "";   // 바로 비우고, 실패하면 되돌린다
      const ok = await o.onComment?.(e.key, v);
      if (ok === false && !input.value) input.value = v;
    };
    send.addEventListener("click", submit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.isComposing && ev.keyCode !== 229) { ev.preventDefault(); submit(); }
    });
    return e;
  }

  function paint(e) {
    const r = e.r;
    const w = who(r);
    const pinned = pinnedSet.has(e.key);
    const edit = canEdit(r);
    const menuOn = live && (isT || edit);
    const bg = colorOf(r, o.allowColor || byTeacher(r));
    const sig = [r.payload.text, bg, w.s, w.t, pinned, edit, menuOn].join("\u0001");
    if (sig === e.sig) return;
    e.sig = sig;
    e.text.textContent = r.payload.text;
    setWho(e.name, w);
    e.card.style.background = bg;
    e.card.classList.toggle("mine", o.mode === "student" && mineOf(r));
    e.card.classList.toggle("is-pin", pinned);
    e.pin.hidden = !pinned;
    e.text.classList.toggle("tap", edit);
    if (e.more) e.more.hidden = !menuOn;
  }

  // 댓글: 버튼 숫자는 늘 갱신, 목록은 펼쳤을 때만(요약은 있으면 항상)
  const rowKey = (c) => `${c.studentId}|${c.itemKey}`;
  function buildCmt() {
    const x = { row: null, name: el("span", { class: "wl-cname" }), text: el("span", { class: "wl-ctext" }), del: null, sig: "", c: null };
    if (live) x.del = el("button", { type: "button", class: "wl-cdel", "aria-label": "댓글 삭제", hidden: true,
      onClick: () => { if (x.c) o.onDeleteComment?.(x.c); } }, ui.icon("x", 14));
    x.row = el("div", { class: "wl-c" }, [el("div", { class: "wl-cbody" }, [x.name, x.text]), x.del]);
    return x;
  }
  function renderCmts(e) {
    const list = e.cmts, n = list.length;
    const label = n ? `댓글 ${n}` : live ? "댓글" : "";
    if (e.cbtn.textContent !== label) e.cbtn.textContent = label;
    if (live) { e.cbtn.setAttribute("aria-expanded", e.open ? "true" : "false"); e.cbtn.classList.toggle("on", e.open); }
    const show = live ? e.open : n > 0;
    e.cbox.hidden = !show;
    if (!show) return;
    if (e.cform) e.cform.hidden = !canComment();
    const keep = new Set(list.map(rowKey));
    for (const [k, x] of e.rows) if (!keep.has(k)) { x.row.remove(); e.rows.delete(k); }
    list.forEach((c, i) => {
      const k = rowKey(c);
      let x = e.rows.get(k);
      if (!x) { x = buildCmt(); e.rows.set(k, x); }
      x.c = c;
      const w = who(c), del = canDelCmt(c);
      const sig = [c.payload.text, w.s, w.t, del].join("\u0001");
      if (sig !== x.sig) {
        x.sig = sig;
        setWho(x.name, w);
        x.text.textContent = c.payload.text;
        if (x.del) x.del.hidden = !del;
      }
      if (e.clist.children[i] !== x.row) e.clist.insertBefore(x.row, e.clist.children[i] || null);
    });
  }

  function measure() {
    const m = new Map();
    for (const c of grid.children) m.set(c, c.getBoundingClientRect());
    return m;
  }
  function place(entries, stale) {
    const kids = grid.children;
    let same = !stale.length && kids.length === entries.length;
    for (let i = 0; same && i < entries.length; i++) same = kids[i] === entries[i].card;
    if (same) return;
    const anim = !first && motionOk() && grid.isConnected && entries.length <= 200;
    const before = anim ? measure() : null;
    stale.forEach(e => e.card.remove());
    const fc = document.activeElement?.closest?.(".wl-card");
    reorder(grid, entries.map(e => e.card), fc && fc.parentNode === grid ? fc : null);
    for (const e of entries) {
      const r0 = before?.get(e.card);
      if (r0) flipFrom(e.card, r0);
      else if (anim && e.fresh) e.card.animate?.(ENTER, { duration: 220, easing: EASE });
      e.fresh = false;
    }
  }

  function refresh() {
    if (drag) return count;   // 드는 중엔 미뤘다가 놓을 때 반영
    const [list, act] = o.source();
    const { posts, cmts } = splitResponses(list);
    const { list: ordered, pinned } = arrange(posts, act || {});
    pinnedSet = pinned;
    const keep = new Set(ordered.map(r => r.itemKey));
    const stale = [];
    for (const [k, e] of cards) if (!keep.has(k)) { stale.push(e); cards.delete(k); if (menu?.e === e) closeMenu(); }
    const entries = ordered.map(r => {
      let e = cards.get(r.itemKey);
      if (!e) { e = build(r.itemKey); e.fresh = !first; cards.set(r.itemKey, e); }
      e.r = r;
      e.cmts = cmts.get(r.itemKey) || [];
      paint(e);
      renderCmts(e);
      return e;
    });
    place(entries, stale);
    first = false;
    count = ordered.length;
    empty.style.display = count ? "none" : "";
    return count;
  }

  // ── ⋯ 메뉴 (교사: 고정·수정·삭제 / 학생 내 글: 수정·삭제) ──
  function toggleMenu(e) {
    if (menu?.e === e) { closeMenu(); return; }
    closeMenu();
    const r = e.r;
    if (!r) return;
    const items = [];
    if (isT) items.push({ label: pinnedSet.has(e.key) ? "고정 해제" : "고정", ico: el("span", { class: "icon", html: pinSvg(18) }), fn: () => o.onPin?.(r) });
    if (canEdit(r)) items.push({ label: "수정", ico: ui.icon("edit", 18), fn: () => o.onEdit?.(r) });
    if (isT || canEdit(r)) items.push({ label: "삭제", ico: ui.icon("trash", 18), fn: () => o.onDelete?.(r), danger: true });
    if (!items.length) return;
    const node = el("div", { class: "popover menu wl-menu" + (isT ? "" : " wl-menu-lg"), role: "menu" }, items.map(it =>
      el("button", { type: "button", role: "menuitem", class: it.danger ? "danger" : null, onClick: () => { closeMenu(); it.fn(); } }, [it.ico, it.label])));
    document.body.appendChild(node);
    const a = e.more.getBoundingClientRect(), m = node.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - m.width - 8, a.right - m.width));
    let top = a.bottom + 4;
    if (top + m.height > window.innerHeight - 8) top = Math.max(8, a.top - m.height - 4);
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    const outside = (ev) => { if (!node.contains(ev.target) && !e.more.contains(ev.target)) closeMenu(); };
    const onKey = (ev) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault(); ev.stopPropagation();
      closeMenu();
      try { e.more.focus({ preventScroll: true }); } catch {}
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onKey, true);
    scroll.addEventListener("scroll", closeMenu, { passive: true });
    window.addEventListener("resize", closeMenu);
    e.more.setAttribute("aria-expanded", "true");
    menu = { e, close() {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", onKey, true);
      scroll.removeEventListener("scroll", closeMenu);
      window.removeEventListener("resize", closeMenu);
      e.more.setAttribute("aria-expanded", "false");
      node.remove();
    } };
    try { node.querySelector("button")?.focus({ preventScroll: true }); } catch {}
  }
  function closeMenu() { const m = menu; menu = null; m?.close(); }

  // ── 교사: 끌어서 자리 옮기기 (pointer 이벤트만, HTML5 drag API 금지) ──
  // 마우스는 6px 움직이면, 터치·펜은 300ms 길게 누르면 든다(그 전에 움직이면 스크롤).
  // 들린 카드 = 고스트(position:fixed), 원래 카드 = 점선 자리표시(.wl-ph)가 되어 grid 안에서 옮겨 다닌다.
  if (isT) {
    grid.addEventListener("pointerdown", onDown);
    // 든 동안 터치 스크롤 막기 — passive:false 라야 preventDefault 가 듣는다
    grid.addEventListener("touchmove", (ev) => { if (drag) ev.preventDefault(); }, { passive: false });
    grid.addEventListener("contextmenu", (ev) => { if (press || drag) ev.preventDefault(); });
  }
  const keysNow = () => [...grid.children].map(c => c.dataset.key);
  const colCount = () => {
    try { return getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length || 1; } catch { return 1; }
  };
  function bind() {
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
  }
  function unbind() {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
  }
  function onDown(ev) {
    if (press || drag || !ev.isPrimary || (ev.pointerType === "mouse" && ev.button !== 0)) return;
    const card = ev.target.closest?.(".wl-card");
    if (!card || card.parentNode !== grid) return;
    if (ev.target.closest("button, input, textarea, select, a, .wl-cmts")) return;
    const e = cards.get(card.dataset.key);
    if (!e) return;
    press = { e, pid: ev.pointerId, type: ev.pointerType, x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY, timer: 0 };
    if (ev.pointerType !== "mouse") press.timer = setTimeout(() => { if (press) lift(); }, HOLD_MS);
    bind();
  }
  function dropPress() {
    if (!press) return;
    clearTimeout(press.timer);
    press = null;
    if (!drag) unbind();
  }
  function onMove(ev) {
    if (press && ev.pointerId === press.pid) {
      press.x = ev.clientX; press.y = ev.clientY;
      const d = Math.hypot(ev.clientX - press.x0, ev.clientY - press.y0);
      if (press.type === "mouse") { if (d >= MOUSE_SLOP) lift(); }
      else if (d > TOUCH_SLOP) dropPress();
    }
    if (!drag || ev.pointerId !== drag.pid) return;
    ev.preventDefault();
    drag.x = ev.clientX; drag.y = ev.clientY;
    moveGhost();
    hover();
  }
  function onUp(ev) {
    if (press && ev.pointerId === press.pid) { dropPress(); return; }
    if (drag && ev.pointerId === drag.pid) finish(true);
  }
  function onCancel(ev) {
    if (press && ev.pointerId === press.pid) { dropPress(); return; }
    if (drag && ev.pointerId === drag.pid) finish(false);
  }
  function lift() {
    const p = press;
    clearTimeout(p.timer);
    press = null;
    const e = p.e;
    if (!e.card.isConnected || e.card.parentNode !== grid) { unbind(); return; }
    closeMenu();
    const rect = e.card.getBoundingClientRect();
    const ghost = e.card.cloneNode(true);
    ghost.classList.add("wl-ghost");
    ghost.removeAttribute("data-key");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.appendChild(ghost);
    e.card.classList.add("wl-ph");
    scroll.classList.add("wl-dragging");
    drag = { e, pid: p.pid, ox: p.x0 - rect.left, oy: p.y0 - rect.top, x: p.x, y: p.y, ghost,
      pinned: pinnedSet.has(e.key), cols: colCount(), keys0: keysNow(), raf: 0 };
    try { scroll.setPointerCapture(p.pid); } catch {}   // 카드는 DOM 에서 옮겨 다니니 움직이지 않는 곳에 잡는다
    if (p.type !== "mouse") { try { navigator.vibrate?.(8); } catch {} }
    moveGhost();
    drag.raf = requestAnimationFrame(autoScroll);
  }
  function moveGhost() {
    drag.ghost.style.transform = `translate(${drag.x - drag.ox}px,${drag.y - drag.oy}px) rotate(-1.5deg) scale(1.03)`;
  }
  // 손가락 아래 카드의 앞/뒤 절반으로 자리 결정(여러 열 = 가로 절반, 한 열 = 세로 절반). 고정 글은 고정끼리만.
  function hover() {
    const { x, y, e } = drag;
    const hit = document.elementFromPoint(x, y);
    if (!hit) return;
    let ref = null, after = false;
    const over = hit.closest?.(".wl-card");
    if (over && over.parentNode === grid) {
      if (over === e.card || pinnedSet.has(over.dataset.key) !== drag.pinned) return;
      const r = over.getBoundingClientRect();
      after = drag.cols > 1 ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
      ref = over;
    } else if (hit === grid || hit === scroll) {
      // 마지막 카드 뒤 빈 곳 → 같은 구역의 끝으로
      const region = [...grid.children].filter(c => pinnedSet.has(c.dataset.key) === drag.pinned);
      const last = region[region.length - 1];
      if (!last || last === e.card) return;
      const r = last.getBoundingClientRect();
      if (!(y > r.bottom || (y >= r.top && x > r.right))) return;
      ref = last; after = true;
    } else return;
    const target = after ? ref.nextSibling : ref;
    if (target === e.card || (target ? target.previousSibling === e.card : grid.lastChild === e.card)) return;
    const before = motionOk() ? measure() : null;
    grid.insertBefore(e.card, target);
    if (before) for (const c of grid.children) { const r0 = before.get(c); if (r0) flipFrom(c, r0); }
  }
  // 가장자리 가까이 들고 있으면 보드를 굴린다
  function autoScroll() {
    if (!drag) return;
    const r = scroll.getBoundingClientRect();
    const edge = Math.min(64, r.height / 4);
    let v = 0;
    if (drag.y < r.top + edge) v = -(r.top + edge - drag.y);
    else if (drag.y > r.bottom - edge) v = drag.y - (r.bottom - edge);
    if (v) {
      const top = scroll.scrollTop;
      scroll.scrollTop = top + Math.max(-18, Math.min(18, v / 3));
      if (scroll.scrollTop !== top) hover();
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }
  function finish(commit) {
    const d = drag;
    drag = null;
    unbind();
    cancelAnimationFrame(d.raf);
    try { if (scroll.hasPointerCapture?.(d.pid)) scroll.releasePointerCapture(d.pid); } catch {}
    const g = d.ghost.getBoundingClientRect();
    d.ghost.remove();
    d.e.card.classList.remove("wl-ph");
    scroll.classList.remove("wl-dragging");
    swallow = true;                       // 놓은 직후 click(글 열기) 무시
    setTimeout(() => { swallow = false; }, 0);
    const keys = keysNow();
    if (commit && keys.join("\u0001") !== d.keys0.join("\u0001")) {
      o.onArrange?.(d.pinned ? "pinned" : "order", keys.filter(k => pinnedSet.has(k) === d.pinned));
    }
    if (commit && motionOk()) flipFrom(d.e.card, g);   // 고스트 자리에서 내려앉기
    refresh();                                         // 든 동안 온 변경 반영(취소면 제자리로)
  }

  function destroy() {
    closeMenu();
    if (press) { clearTimeout(press.timer); press = null; }
    if (drag) { cancelAnimationFrame(drag.raf); drag.ghost.remove(); drag = null; }
    unbind();
  }

  return { el: scroll, refresh, destroy };
}

// 작성/수정 시트 (ui.sheet) → close()
function openComposer({ title, text = "", color = 0, allowColor, onSave, onDelete, saveLabel }) {
  const ta = el("textarea", { class: "input wl-ta", maxlength: MAX_LEN, placeholder: "내용" });
  ta.value = text;
  const count = el("span", { class: "wl-count" });
  const upd = () => { count.textContent = `${Array.from(ta.value).length}/${MAX_LEN}`; };
  ta.addEventListener("input", upd); upd();

  let cur = color;
  const dots = el("div", { class: "wl-dots" });
  const drawDots = () => {
    dots.innerHTML = "";
    WALL_COLORS.forEach((c, i) => dots.appendChild(el("button", {
      type: "button", class: "wl-dot" + (i === cur ? " on" : ""), style: { background: c }, "aria-label": `색 ${i + 1}`,
      onClick: () => { cur = i; drawDots(); },
    })));
  };
  if (allowColor) drawDots();

  const body = el("div", { class: "wl-compose" }, [
    ta,
    el("div", { class: "wl-sheet-row" }, [allowColor ? dots : null, count]),
  ]);
  const actions = [];
  if (onDelete) actions.push({ label: "삭제", danger: true, onClick: async (close) => { if ((await onDelete()) !== false) close(); } });
  actions.push({ label: saveLabel || "올리기", primary: true, onClick: async (close) => {
    const v = ta.value.trim();
    if (!v) { ta.focus(); return; }
    const ok = await onSave(clip(v), allowColor ? cur : 0);
    if (ok !== false) close();
  } });
  const sh = ui.sheet({ title, body, actions });
  return () => sh?.close?.();
}

// ── 쓰기 동작 (학생·교사 공용) ──
// 교사는 ctx.submit(..., { asTeacher: true }) — 행의 studentId = 교사 id
function makeActions(ctx, { teacher, allowColor, locked }) {
  const myId = ctx.me?.id;
  const colors = allowColor || teacher;
  const blocked = () => !teacher && locked();
  const stamp = (p) => (teacher ? { ...p, author: "teacher" } : p);
  let closeSheet = null;

  async function write(itemKey, payload) {
    if (blocked()) { ctx.toast("잠겨 있어요"); return false; }
    try { await ctx.submit(payload, teacher ? { itemKey, asTeacher: true } : { itemKey }); return true; }
    catch (e) { return false; }   // ctx.submit 이 toast 처리
  }
  function compose() {
    if (blocked()) { ctx.toast("잠겨 있어요"); return; }
    closeSheet?.();
    closeSheet = openComposer({
      title: "글쓰기", allowColor: colors, color: colors ? Math.floor(Math.random() * WALL_COLORS.length) : 0,
      onSave: (text, color) => write(newId("post"), stamp({ text, color, at: Date.now() })),
    });
  }
  function edit(r) {
    if (!r || r.studentId !== myId) return;
    if (blocked()) { ctx.toast("잠겨 있어요"); return; }
    closeSheet?.();
    closeSheet = openComposer({
      title: "내 글", text: r.payload.text, color: r.payload.color | 0, allowColor: colors, saveLabel: "저장",
      onSave: (text, color) => write(r.itemKey, { ...r.payload, text, color, at: r.payload.at || timeOf(r) || Date.now() }),
      onDelete: () => removePost(r),
    });
  }
  // 글 삭제 → 그 글의 댓글도 지운다(교사: 전부 / 학생: 내 것만 — 남은 남의 댓글은 글이 없어 안 보인다)
  async function removePost(r) {
    if (!r) return false;
    if (!teacher && r.studentId !== myId) return false;
    if (blocked()) { ctx.toast("잠겨 있어요"); return false; }
    if (!teacher && !(await ctx.confirm("글을 삭제할까요?", { ok: "삭제", danger: true }))) return false;
    const cmts = ctx.responses().filter(c => isCmt(c) && c.payload.postKey === r.itemKey && (teacher || c.studentId === myId));
    try { await ctx.removeResponse(r.studentId, r.itemKey); }
    catch (e) { return false; }   // 실패 toast 는 host 가 처리
    await Promise.allSettled(cmts.map(c => ctx.removeResponse(c.studentId, c.itemKey)));
    if (teacher) {
      const a = ctx.activity();
      const patch = {};
      if ((a.pinned || []).includes(r.itemKey)) patch.pinned = a.pinned.filter(k => k !== r.itemKey);
      if ((a.order || []).includes(r.itemKey)) patch.order = a.order.filter(k => k !== r.itemKey);
      if (Object.keys(patch).length) ctx.setActivity(patch);
      ctx.toast("삭제했어요");
    }
    return true;
  }
  async function comment(postKey, text) {
    const v = clip(String(text || "").trim());
    if (!v) return false;
    return write(newId("cmt"), stamp({ postKey, text: v, at: Date.now() }));
  }
  async function removeComment(c) {
    if (!c || (!teacher && (c.studentId !== myId || locked()))) return;
    try { await ctx.removeResponse(c.studentId, c.itemKey); if (teacher) ctx.toast("삭제했어요"); }
    catch (e) { /* 실패 toast 는 host 가 처리 */ }
  }
  function togglePin(r) {
    if (!teacher || !r) return;
    const have = new Set(ctx.responses().filter(isPost).map(p => p.itemKey));
    const cur = (ctx.activity().pinned || []).filter(k => have.has(k));
    ctx.setActivity({ pinned: cur.includes(r.itemKey) ? cur.filter(k => k !== r.itemKey) : [...cur, r.itemKey] });
  }
  function arrangeTo(kind, keys) {
    if (teacher && (kind === "order" || kind === "pinned")) ctx.setActivity({ [kind]: keys });
  }
  return {
    compose, edit, removePost, comment, removeComment, togglePin, arrange: arrangeTo,
    closeSheet() { closeSheet?.(); closeSheet = null; },
  };
}

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="6" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="11" width="8" height="10" rx="1.5"/></svg>`;

registerSlideType({
  type: "wall",
  category: "interact",
  label: "담벼락",
  desc: "함께 글을 붙이고 댓글을 달아요",
  icon: ICON,

  create() {
    return { type: "wall", config: { prompt: "", allowColor: true, showNames: true } };
  },

  Editor({ slide, update, ctx }) {
    ensureCss(ctx);
    const cfg = () => slide.config || {};
    const prompt = el("textarea", { class: "input", rows: 3, placeholder: "주제 (예: 오늘 배운 점을 남겨 주세요)" });
    prompt.value = cfg().prompt || "";
    prompt.addEventListener("input", () => update({ config: { ...cfg(), prompt: prompt.value } }));
    const check = (key, label) => {
      const inp = el("input", { type: "checkbox" });
      inp.checked = cfg()[key] !== false;
      inp.addEventListener("change", () => update({ config: { ...cfg(), [key]: inp.checked } }));
      return el("label", { class: "wl-check" }, [inp, el("span", {}, label)]);
    };
    const root = el("div", { class: "wl-editor" }, [
      el("label", { class: "field" }, [el("span", {}, "주제"), prompt]),
      check("allowColor", "학생이 색 고르기"),
      check("showNames", "학생 화면에 이름 보이기"),
    ]);
    return { el: root };
  },

  Student({ slide, ctx }) {
    ensureCss(ctx);
    const cfg = slide.config || {};
    const allowColor = cfg.allowColor !== false;
    const locked = () => ctx.activity().phase === "ended";
    const act = makeActions(ctx, { teacher: false, allowColor, locked });
    const board = createBoard({
      mode: "student", ctx, allowColor, showNames: cfg.showNames !== false,
      myId: ctx.me?.id, teacherId: () => ctx.session?.()?.teacherId || null, locked,
      source: () => [ctx.responses(), ctx.activity()],
      onEdit: act.edit, onDelete: act.removePost, onComment: act.comment, onDeleteComment: act.removeComment,
    });
    const status = el("div");
    const fab = el("button", { type: "button", class: "btn btn-primary btn-lg wl-fab", onClick: () => act.compose() }, "+ 글쓰기");
    const root = el("div", { class: "wl wl-stu" }, [
      el("div", { class: "wl-head" }, [el("h2", { class: "wl-prompt" }, cfg.prompt || ""), status]),
      board.el, fab,
    ]);

    let lastLock = null;
    function renderLock() {
      const l = locked();
      if (l === lastLock) return;
      lastLock = l;
      fab.style.display = l ? "none" : "";
      status.replaceChildren(...(l ? [el("span", { class: "pill pill-muted" }, "잠김")] : []));
      if (l) act.closeSheet();
    }
    const refresh = () => { board.refresh(); };
    renderLock(); refresh();

    return {
      el: root,
      onActivity() { renderLock(); refresh(); },   // 잠금·고정·배치
      onResponses: refresh,
      onSession: refresh,       // 이름 정보가 늦게 오면 갱신 (sig 비교라 싸다)
      destroy() { act.closeSheet(); board.destroy(); },
    };
  },

  TeacherLive({ slide, ctx }) {
    ensureCss(ctx);
    const cfg = slide.config || {};
    const allowColor = cfg.allowColor !== false;
    const locked = () => ctx.activity().phase === "ended";
    const act = makeActions(ctx, { teacher: true, allowColor, locked });
    const board = createBoard({
      mode: "teacher", ctx, allowColor, showNames: true,
      myId: ctx.me?.id, teacherId: () => ctx.session?.()?.teacherId || ctx.me?.id || null, locked,
      source: () => [ctx.responses(), ctx.activity()],
      onEdit: act.edit, onDelete: act.removePost, onPin: act.togglePin, onArrange: act.arrange,
      onComment: act.comment, onDeleteComment: act.removeComment,
    });
    const count = el("span", { class: "pill pill-muted" });
    const lockBtn = el("button", { type: "button", class: "btn btn-sm", onClick: () => {
      ctx.setActivity({ phase: locked() ? "idle" : "ended" });
    } });
    const resetBtn = el("button", { type: "button", class: "btn btn-sm btn-ghost", onClick: async () => {
      if (!(await ctx.confirm("모든 글을 지울까요?", { ok: "초기화", danger: true }))) return;
      try { await ctx.clearResponses(); ctx.setActivity({ phase: "idle", order: [], pinned: [] }); }
      catch (e) { /* 실패 toast 는 host 가 처리 */ }
    } }, "초기화");
    const fab = el("button", { type: "button", class: "btn btn-primary btn-lg wl-fab", onClick: () => act.compose() }, "+ 글쓰기");
    const root = el("div", { class: "wl wl-teacher" }, [
      el("div", { class: "wl-head" }, [
        el("h2", { class: "wl-prompt" }, cfg.prompt || ""),
        el("div", { class: "wl-bar" }, [count, lockBtn, resetBtn]),
      ]),
      board.el, fab,
    ]);
    function renderBar() {
      const l = locked();
      lockBtn.textContent = l ? "잠금 해제" : "잠금";
      lockBtn.className = l ? "btn btn-sm btn-dark" : "btn btn-sm";
    }
    const refresh = () => { count.textContent = `글 ${board.refresh()}개`; };   // 댓글은 세지 않는다
    renderBar(); refresh();
    return {
      el: root,
      onActivity() { renderBar(); refresh(); },
      onResponses: refresh,
      onSession: refresh,
      destroy() { act.closeSheet(); board.destroy(); },
    };
  },

  // 읽기 전용 보드: 최종 순서(고정 먼저)·고정 표시·댓글 수와 댓글 목록
  summary(slide, responses, session, ctx) {
    ensureCss(ctx);
    const cfg = slide.config || {};
    const state = session?.activity?.[slide.id] || ctx?.activity?.() || {};
    const board = createBoard({
      mode: "summary", ctx, allowColor: cfg.allowColor !== false, showNames: true,
      myId: ctx?.role === "student" ? ctx?.me?.id || null : null,
      teacherId: () => session?.teacherId || ctx?.session?.()?.teacherId || (ctx?.role === "teacher" ? ctx?.me?.id : null) || null,
      source: () => [responses || [], state],
    });
    board.refresh();
    return el("div", { class: "wl wl-sum", style: { height: "auto" } }, [
      el("h3", { class: "wl-prompt" }, cfg.prompt || ""),
      board.el,
    ]);
  },
});
