// 학생별 답 매트릭스 + 보기 전환 (빈칸·분류하기 교사 화면 공용)
// answerMatrix(ctx, opts) → HTMLElement (.update())
//   opts.columns : [{ key, label, sub?, title? }] 또는 () => 같은 배열 (sub: 정답 등 보조 한 줄 — 비면 숨김)
//   opts.rowFor  : (studentId) → null(미제출) | { cells: { [key]: { ok: true|false|null, text?, hint? } }, score, total }
//                  ok null = '—'(회색), text = 칸에 작게, hint = 마우스를 올리면 보이는 말
//   opts.detail? : (studentId) → HTMLElement — 있으면 행 클릭 → 상세 모달(‹ › 로 제출한 학생 넘겨 보기)
//   opts.ids?    : () → studentId[] — 기본 matrixIds(ctx, ctx.responses())
//   opts.memoKey?: 정렬(번호순·점수순) 기억 키(보통 slide.id) · opts.wide?: 상세 모달 넓게
// 행은 studentId 키로 보존 — update() 는 내용이 바뀐 행만 다시 그리고 순서만 맞춘다.
// 그 밖: viewSeg('문항별|학생별', 슬라이드별 기억) · pickRows(막대 행 클릭) · openDetail · matrixIds · sortStudents
//        studentLabel · rosterSig · circled
// 가정: 기억은 페이지 수명 동안만(모듈 Map). 새로고침하면 기본값(문항별·번호순).
// 가정: 학생별 보기는 정답 공개 전에도 ✓/✗ 를 보여 준다(교사가 직접 고르는 보기). 열 머리의 정답(sub)은 플러그인이 공개 후에만 넘긴다.
// 가정: 모두 같은 학년·반이면 행 머리는 '번호 이름', 섞여 있으면 '학년-반-번호 이름'. 교사 id 는 행에서 뺀다.
// 가정: 점수순 = 맞힌 비율 높은 순(같으면 번호순), 미제출은 맨 아래.
import { el, icon } from "../ui.js";
import { injectCss } from "./registry.js";

injectCss("answer-matrix", `
.am{display:grid;gap:10px;min-width:0}
.am-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.am-view{flex:none}
.am-wrap{overflow:auto;max-width:100%;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface);overscroll-behavior:contain}
.am-table{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%;font-size:14px}
.am-table th,.am-table td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:center;vertical-align:middle;white-space:nowrap;background:var(--surface)}
.am-table thead th{position:sticky;top:0;z-index:2;background:var(--surface-2);color:var(--ink-2);font-size:13px;font-weight:600;vertical-align:bottom}
.am-table .am-name{position:sticky;left:0;z-index:1;text-align:left;font-weight:600;max-width:150px;overflow:hidden;text-overflow:ellipsis;border-right:1px solid var(--line)}
.am-table thead .am-name{z-index:3}
.am-table tbody tr:last-child>*{border-bottom:0}
.am-no{margin-right:6px;color:var(--muted);font-weight:500;font-variant-numeric:tabular-nums}
.am-h{display:grid;gap:2px;justify-items:center}
.am-h .l{max-width:8em;overflow:hidden;text-overflow:ellipsis}
.am-h .s{max-width:8em;overflow:hidden;text-overflow:ellipsis;padding:0 6px;border-radius:4px;background:var(--highlight);color:var(--ink);font-size:12px;font-weight:700}
.am-h .p{color:var(--muted);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}
.am-h .p.low{color:var(--danger)}
.am-c{display:inline-flex;align-items:baseline;gap:4px;max-width:9em}
.am-c .m{font-weight:800}
.am-c.ok .m{color:var(--ok)}
.am-c.bad .m{color:var(--danger)}
.am-c .t{min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:var(--ink-2)}
.am-c.none{color:var(--muted)}
.am-sc{font-weight:700;font-variant-numeric:tabular-nums}
.am-sc.full{color:var(--ok)}
tr.am-row.none>th{color:var(--muted);font-weight:500}
tr.am-row.clickable{cursor:pointer}
tr.am-row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
@media (hover:hover){tr.am-row.clickable:hover>*{background:var(--surface-2)}}
.am-box{display:flex;flex-direction:column;gap:14px;min-width:0}
.am-box.is-matrix{flex:1 1 auto;min-height:260px}
.am-box.is-matrix>.am{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.am-box.is-matrix .am-wrap{flex:0 1 auto;min-height:0}
.am-pickable>.bar-row{cursor:pointer;margin:0 -6px;padding:3px 6px;border-radius:8px}
.am-pickable>.bar-row:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
@media (hover:hover){.am-pickable>.bar-row:hover{background:var(--surface-2)}}
.am-detail{display:grid;gap:14px}
.am-nav{display:flex;align-items:center;justify-content:center;gap:10px}
.am-pos{min-width:64px;text-align:center;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
@media print{.am-wrap{overflow:visible;border:0}.am-table{width:100%}.am-table th,.am-table thead th,.am-table .am-name{position:static}}
`);

const memo = new Map(); // `${key}|view` · `${key}|sort` → 값 (페이지 수명 동안)

// ── 학생 정보 ──
function stuOf(ctx, id) {
  try { return ctx?.students?.()?.get?.(id) || null; } catch { return null; }
}
function teacherIdOf(ctx) {
  try { return ctx?.session?.()?.teacherId || null; } catch { return null; }
}
export function studentLabel(ctx, id) {
  if (id && id === teacherIdOf(ctx)) return "선생님";
  const s = stuOf(ctx, id);
  return s ? `${s.grade}-${s.classNum}-${s.num} ${s.name || ""}`.trim() : "학생";
}
// 학번순(학년·반·번호·이름), 모르는 학생은 뒤로
export function sortStudents(ctx, ids) {
  const key = (id) => { const s = stuOf(ctx, id); return s ? [+s.grade || 0, +s.classNum || 0, +s.num || 0, s.name || ""] : [99, 99, 999, String(id)]; };
  return [...new Set(ids)].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < 4; i++) { if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; }
    return 0;
  });
}
// 참가자 ∪ 응답자(itemKey '') — 교사 제외, 학번순
export function matrixIds(ctx, responses = []) {
  const tid = teacherIdOf(ctx);
  const ids = [...(ctx?.participants?.() || []), ...(responses || []).filter(r => (r.itemKey || "") === "").map(r => r.studentId)];
  return sortStudents(ctx, ids.filter(id => id && id !== tid));
}
// onSession 비교용: 참가자·학생 정보가 바뀐 때만 다시 그리기
export function rosterSig(ctx) {
  let n = 0;
  try { n = ctx?.students?.()?.size || 0; } catch { n = 0; }
  return `${(ctx?.participants?.() || []).join(",")}|${n}`;
}
export function circled(i) {
  const n = Math.max(0, i | 0);
  return n < 20 ? String.fromCharCode(0x2460 + n) : `(${n + 1})`;
}

// ── 세그먼트 토글 ──
function segOf(options, value, onPick, cls = "") {
  let cur = value;
  const root = el("div", { class: `seg ${cls}`.trim(), role: "group" });
  const btns = options.map(o => el("button", { type: "button", onClick: () => {
    if (o.value === cur) return;
    cur = o.value; paint(); onPick?.(cur);
  } }, o.label));
  function paint() {
    btns.forEach((b, i) => {
      const on = options[i].value === cur;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  root.append(...btns);
  paint();
  root.value = () => cur;
  return root;
}

// '문항별 | 학생별' — 슬라이드별로 마지막 선택 기억. 반환 el.value() → 'item'|'student'
export function viewSeg(slideId, onPick) {
  const k = `${slideId}|view`;
  return segOf([{ value: "item", label: "문항별" }, { value: "student", label: "학생별" }], memo.get(k) || "item", (v) => {
    memo.set(k, v);
    onPick?.(v);
  }, "am-view");
}

// choiceBars 의 행(.bar-row)을 누를 수 있게 — onPick(행 번호). 반환 sync() 는 bars.update() 뒤에 호출(새 행에 tabindex)
export function pickRows(bars, onPick) {
  bars.classList.add("am-pickable");
  const rowAt = (e) => {
    const row = e.target?.closest?.(".bar-row");
    return row && row.parentElement === bars ? [...bars.children].indexOf(row) : -1;
  };
  bars.addEventListener("click", (e) => { const i = rowAt(e); if (i >= 0) onPick(i); });
  bars.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const i = rowAt(e);
    if (i < 0) return;
    e.preventDefault();
    onPick(i);
  });
  return () => { for (const r of bars.children) if (r.tabIndex !== 0) r.tabIndex = 0; };
}

// ── 상세 모달: ids 를 ‹ › (또는 ←/→)로 넘겨 본다. render(id) → HTMLElement ──
export function openDetail(ctx, { ids = [], index = 0, title = (id) => studentLabel(ctx, id), render, wide = false } = {}) {
  if (typeof ctx?.modal !== "function" || !ids.length || typeof render !== "function") return null;
  let i = Math.min(Math.max(0, index | 0), ids.length - 1);
  const prev = el("button", { class: "btn btn-icon btn-ghost btn-sm", type: "button", "aria-label": "이전 학생", onClick: () => go(-1) }, icon("chevron-left", 18));
  const next = el("button", { class: "btn btn-icon btn-ghost btn-sm", type: "button", "aria-label": "다음 학생", onClick: () => go(1) }, icon("chevron-right", 18));
  const pos = el("span", { class: "am-pos" });
  const content = el("div", { class: "am-detail-body" });
  const body = el("div", { class: "am-detail" }, [ids.length > 1 ? el("div", { class: "am-nav" }, [prev, pos, next]) : null, content]);
  let h3 = null;
  function paint() {
    const id = ids[i];
    let node = null;
    try { node = render(id); } catch (e) { console.warn("[answer-matrix] detail", e); }
    content.replaceChildren(node instanceof Node ? node : el("div", { class: "empty" }, "불러오지 못했어요"));
    if (h3) h3.textContent = title(id);
    pos.textContent = `${i + 1} / ${ids.length}`;
    prev.disabled = i <= 0;
    next.disabled = i >= ids.length - 1;
  }
  function go(d) {
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    const f = document.activeElement;
    i = j;
    paint();
    // 끝에 닿아 버튼이 꺼지면 반대쪽으로 포커스(←/→ 계속 동작)
    if (f === prev && prev.disabled) next.focus();
    else if (f === next && next.disabled) prev.focus();
  }
  paint();
  const res = ctx.modal({ title: title(ids[i]), body, wide, actions: [{ label: "닫기", primary: true, onClick: (close) => close() }] });
  h3 = res?.root?.querySelector?.(".modal-head h3") || null;
  res?.root?.addEventListener?.("keydown", (e) => {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
  });
  return res;
}

// ── 매트릭스 ──
export function answerMatrix(ctx, opts = {}) {
  const { rowFor, detail = null, memoKey = "", wide = false } = opts;
  const colsOf = () => (typeof opts.columns === "function" ? opts.columns() : opts.columns) || [];
  const sortKey = memoKey ? `${memoKey}|sort` : "";
  let sort = (sortKey && memo.get(sortKey)) || "num";
  const sortSeg = segOf([{ value: "num", label: "번호순" }, { value: "score", label: "점수순" }], sort, (v) => {
    sort = v;
    if (sortKey) memo.set(sortKey, v);
    update();
  }, "seg-sm");

  const headRow = el("tr");
  const tbody = el("tbody");
  const wrap = el("div", { class: "am-wrap" }, [el("table", { class: "am-table" }, [el("thead", {}, [headRow]), tbody])]);
  const empty = el("div", { class: "empty" }, "아직 아무도 없어요");
  const root = el("div", { class: "am" }, [el("div", { class: "am-bar" }, [sortSeg]), wrap, empty]);
  const canOpen = typeof detail === "function" && typeof ctx?.modal === "function";

  const rows = new Map(); // studentId → { tr, sig }
  let heads = new Map();  // column key → { l, s, p }
  let colSig = null, avgEl = null;
  let order = [];         // 표시 순서(제출한 학생만) — 상세 모달 이전/다음

  const setText = (node, t) => { const s = String(t ?? ""); if (node.textContent !== s) node.textContent = s; };

  function buildHead(cols) {
    heads = new Map();
    avgEl = el("span", { class: "p" });
    headRow.replaceChildren(
      el("th", { class: "am-name", scope: "col" }, "학생"),
      ...cols.map(c => {
        const h = { l: el("span", { class: "l" }), s: el("span", { class: "s" }), p: el("span", { class: "p" }) };
        heads.set(c.key, h);
        return el("th", { scope: "col" }, el("div", { class: "am-h" }, [h.l, h.s, h.p]));
      }),
      el("th", { scope: "col" }, el("div", { class: "am-h" }, [el("span", { class: "l" }, "점수"), avgEl])),
    );
  }

  function safeRow(id) {
    try { return rowFor?.(id) || null; } catch (e) { console.warn("[answer-matrix] rowFor", e); return null; }
  }

  function sameClass(ids) {
    let k = null;
    for (const id of ids) {
      const s = stuOf(ctx, id);
      if (!s) continue;
      const x = `${s.grade}|${s.classNum}`;
      if (k === null) k = x; else if (k !== x) return false;
    }
    return true;
  }
  function labelOf(id, short) {
    const s = stuOf(ctx, id);
    if (!s) return { no: "", name: studentLabel(ctx, id) };
    return { no: short ? String(s.num ?? "") : `${s.grade}-${s.classNum}-${s.num}`, name: s.name || "" };
  }

  function cell(x) {
    if (!x || x.ok == null) return el("span", { class: "am-c none" }, "—");
    return el("span", { class: `am-c ${x.ok ? "ok" : "bad"}`, title: x.hint || x.text || null }, [
      el("span", { class: "m" }, x.ok ? "✓" : "✗"),
      x.text ? el("span", { class: "t" }, x.text) : null,
    ]);
  }

  function makeRow(id) {
    const tr = el("tr", { class: "am-row" });
    tr.addEventListener("click", () => { if (tr.classList.contains("clickable")) open(id); });
    tr.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && tr.classList.contains("clickable")) { e.preventDefault(); open(id); }
    });
    return { tr, sig: null };
  }

  function paintRow(r, id, row, cols, label) {
    const { tr } = r;
    const click = !!row && canOpen;
    tr.classList.toggle("none", !row);
    tr.classList.toggle("clickable", click);
    if (click) tr.tabIndex = 0; else tr.removeAttribute("tabindex");
    const full = row && row.total > 0 && row.score === row.total;
    tr.replaceChildren(
      el("th", { class: "am-name", scope: "row", title: studentLabel(ctx, id) }, [label.no ? el("span", { class: "am-no" }, label.no) : null, label.name]),
      ...cols.map(c => el("td", {}, cell(row ? row.cells?.[c.key] : null))),
      el("td", { class: `am-sc${full ? " full" : ""}` }, row ? `${row.score}/${row.total}` : "—"),
    );
  }

  function open(id) {
    const ids = order.slice();
    openDetail(ctx, { ids, index: Math.max(0, ids.indexOf(id)), render: detail, wide });
  }

  function update() {
    const cols = colsOf();
    const ks = cols.map(c => c.key).join("\u0001");
    if (ks !== colSig) { colSig = ks; buildHead(cols); for (const r of rows.values()) r.sig = null; }

    const ids = (opts.ids ? opts.ids() : matrixIds(ctx, ctx?.responses?.() || [])) || [];
    const data = ids.map(id => ({ id, row: safeRow(id) }));
    const done = data.filter(d => d.row);

    // 열 머리: 라벨 · 정답(sub) · 정답률
    for (const c of cols) {
      const h = heads.get(c.key);
      setText(h.l, c.label);
      h.l.title = c.title || String(c.label ?? "");
      setText(h.s, c.sub || "");
      h.s.hidden = !c.sub;
      const n = done.filter(d => d.row.cells?.[c.key]?.ok === true).length;
      const pct = done.length ? Math.round((n / done.length) * 100) : null;
      setText(h.p, pct == null ? "—" : `${pct}%`);
      h.p.classList.toggle("low", pct != null && pct < 50);
    }
    const ratio = (row) => (row ? (row.total ? row.score / row.total : 0) : -1);
    const avg = done.length ? Math.round((done.reduce((a, d) => a + ratio(d.row), 0) / done.length) * 100) : null;
    setText(avgEl, avg == null ? "—" : `평균 ${avg}%`);

    if (sort === "score") data.sort((a, b) => ratio(b.row) - ratio(a.row)); // 안정 정렬 → 같은 점수는 번호순

    const short = sameClass(ids);
    const seen = new Set();
    data.forEach((d, i) => {
      seen.add(d.id);
      let r = rows.get(d.id);
      if (!r) { r = makeRow(d.id); rows.set(d.id, r); }
      const label = labelOf(d.id, short);
      const sig = JSON.stringify([label.no, label.name, d.row
        ? [d.row.score, d.row.total, cols.map(c => { const x = d.row.cells?.[c.key]; return x ? [x.ok, x.text || "", x.hint || ""] : 0; })]
        : 0]);
      if (sig !== r.sig) { r.sig = sig; paintRow(r, d.id, d.row, cols, label); }
      if (tbody.children[i] !== r.tr) tbody.insertBefore(r.tr, tbody.children[i] || null);
    });
    for (const [id, r] of rows) if (!seen.has(id)) { r.tr.remove(); rows.delete(id); }
    order = data.filter(d => d.row).map(d => d.id);
    wrap.hidden = !data.length;
    empty.hidden = !!data.length;
  }

  root.update = update;
  return root;
}
