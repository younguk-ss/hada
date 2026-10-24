// 인쇄: 학생 개별 결과(슬라이드·학생 선택) + 기록 화면 인쇄
// - A4 세로, 여백 최소. 학습지 이미지(특히 A4 세로 PDF)는 16:10 틀의 여백을 잘라 종이 한 장을 꽉 채운다.
// - 종이마다 오른쪽 위에 작은 워터마크(assets/print-mark.png), 머리글(수업 이름·학생)은 작게.
// 가정: 필기 좌표는 16:10 프레임 기준(0..1), 배경은 object-fit: contain → 이미지 영역을 계산해 잘라낸다.
import { el, modal, toast, icon } from "./ui.js";
import { findStudent, studentLabel } from "./store.js";
import { drawStroke, strokeKey } from "./canvas.js";
import { getSlideType, effectiveMode, injectCss } from "./slides/index.js";

const MARK = "assets/print-mark.png";
const FRAME = 16 / 10;        // 슬라이드 프레임 비율
const REF_W = 960;            // canvas.js 의 선 굵기 기준 폭
const PAGE_W = 196;           // A4 210mm - 좌우 7mm
const BODY_H = 270;           // A4 297mm - 위 5 - 머리 12 - 아래 7 - 여유 3
const GAP = 4;                // 슬라이드 사이(mm)
const PX_W = 1600;            // 출력 이미지 폭(px) ≈ 200dpi

injectCss("print", `
#print-root{display:none}
@media print{
  html.pp-printing body>*:not(#print-root){display:none!important}
  html.pp-printing #print-root{display:block}
  html.pp-printing body{background:#fff!important;margin:0}
  html.pp-record .pp-fixed-mark{display:block}
}
#print-root,#print-root *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pp-sheet{width:210mm;height:296.5mm;box-sizing:border-box;padding:5mm 7mm 7mm;display:flex;flex-direction:column;break-after:page;page-break-after:always;overflow:hidden;background:#fff;color:#1c1c22}
.pp-sheet:last-child{break-after:auto;page-break-after:auto}
.pp-sheet.flow{height:auto;overflow:visible}
.pp-head{flex:none;height:12mm;display:flex;align-items:center;gap:3mm;font:500 8.5pt/1.25 "Pretendard Variable",Pretendard,sans-serif;color:#6b6b72}
.pp-head .pp-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-head .pp-page{font-variant-numeric:tabular-nums}
.pp-mark{width:11mm;height:11mm;object-fit:contain;flex:none}
.pp-body{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;gap:${GAP}mm}
.pp-img{display:block}
.pp-img.framed{outline:.25mm solid #d6d2c8}
.pp-html{width:100%;font-size:10.5pt}
.pp-html .btn,.pp-html button{display:none!important}
.pp-fixed-mark{display:none;position:fixed;top:0;right:0;width:11mm;height:11mm;object-fit:contain}
/* 선택 창 */
.pp-wiz{display:flex;flex-direction:column;gap:14px}
.pp-step{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.pp-step b{color:var(--ink)}
.pp-tools{display:flex;gap:8px;align-items:center}
.pp-tools .grow{flex:1}
.pp-slides{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;max-height:52vh;overflow:auto;padding:2px}
.pp-slide{position:relative;display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface);cursor:pointer;text-align:left}
.pp-slide.on{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.pp-slide .pp-thumb{position:relative;aspect-ratio:16/10;border-radius:6px;overflow:hidden;background:var(--surface-2)}
.pp-slide .pp-thumb>*{position:absolute;inset:0;width:100%;height:100%}
.pp-slide .pp-thumb img{object-fit:contain;background:#fff}
.pp-slide .pp-cap{display:flex;gap:6px;align-items:center;font-size:13px;min-width:0}
.pp-slide .pp-cap span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pp-check{position:absolute;top:12px;left:12px;width:22px;height:22px;border-radius:50%;background:#fff;border:1.5px solid var(--line-strong);display:flex;align-items:center;justify-content:center;z-index:1}
.pp-slide.on .pp-check,.pp-stu.on .pp-check{background:var(--accent);border-color:var(--accent);color:#fff}
.pp-students{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;max-height:52vh;overflow:auto;padding:2px}
.pp-stu{position:relative;display:flex;align-items:center;gap:10px;min-height:44px;padding:8px 12px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface);cursor:pointer;text-align:left;font-size:14px}
.pp-stu .pp-check{position:static}
.pp-stu.on{border-color:var(--accent);background:var(--accent-soft)}
.pp-foot{display:flex;gap:8px;justify-content:flex-end;align-items:center}
.pp-foot .grow{flex:1;color:var(--muted);font-size:13px}
`);

const CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

// ── 학생 목록 (참가자 + 응답자, 교사 제외, 학번순) ──
export function sessionStudents(session) {
  const ids = new Set(session.participants || []);
  for (const list of Object.values(session.responses || {})) for (const r of list || []) if (r && r.studentId) ids.add(r.studentId);
  ids.delete(session.teacherId);
  const cmp = (a, b) => (a.grade - b.grade) || (a.classNum - b.classNum) || (a.num - b.num) || String(a.name).localeCompare(String(b.name), "ko");
  return [...ids].map(id => ({ id, st: findStudent(id) }))
    .sort((a, b) => (a.st && b.st ? cmp(a.st, b.st) : a.st ? -1 : b.st ? 1 : 0));
}

// ── 이미지 로드 (CORS 허용 → 캔버스를 JPEG로 변환 가능) ──
const imgCache = new Map();
function loadImg(src) {
  if (!src) return Promise.resolve(null);
  if (!imgCache.has(src)) {
    imgCache.set(src, new Promise((res) => {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.decoding = "async";
      im.onload = () => res(im);
      im.onerror = () => { imgCache.delete(src); res(null); };
      im.src = src;
    }));
  }
  return imgCache.get(src);
}

// 학생 한 명이 그 슬라이드에서 본 필기 레코드 (teacher.js 학생별 보기와 같은 우선순위)
function recordFor(session, slide, studentId) {
  const R = session.records || {};
  const has = (rec) => !!rec && ((rec.strokes || []).length || (rec.texts || []).length);
  const g = (session.groups || []).find(x => (x.memberIds || []).includes(studentId));
  const ind = (R[studentId] || {})[slide.id];
  const grp = g ? ((R.__groups || {})[g.id] || {})[slide.id] : null;
  const whole = (R.__whole || {})[slide.id];
  const m = effectiveMode(slide, session);
  const order = m === "individual" ? [ind, grp, whole] : m === "group" ? [grp, ind, whole] : [whole, ind, grp];
  return order.find(has) || null;
}

// ── 필기 슬라이드 한 장 → { src(objectURL|dataURL), aspect, framed } ──
async function renderInk(session, slide, studentId) {
  const rec = recordFor(session, slide, studentId);
  const strokes = [...(slide.strokes || []), ...((rec && rec.strokes) || [])];
  const texts = [...(slide.texts || []), ...((rec && rec.texts) || [])];
  const removed = new Set((rec && rec.removed) || []);
  const img = await loadImg(slide.bg);
  // 이미지가 프레임에서 차지하는 영역
  let r = { x: 0, y: 0, w: 1, h: 1 };
  if (img && img.naturalWidth && img.naturalHeight) {
    const ra = img.naturalWidth / img.naturalHeight;
    if (ra < FRAME) { const w = ra / FRAME; r = { x: (1 - w) / 2, y: 0, w, h: 1 }; }
    else { const h = FRAME / ra; r = { x: 0, y: (1 - h) / 2, w: 1, h }; }
  }
  // 자를 영역 = 학습지 이미지 영역 그대로 (종이 학습지처럼 A4 한 장을 꽉 채움).
  // 가정: 학습지 바깥 여백에 쓴 필기는 인쇄하지 않는다(기록 화면 '학생별'에서는 보임).
  const cx0 = r.x, cy0 = r.y, cx1 = r.x + r.w, cy1 = r.y + r.h;
  const cw = cx1 - cx0, ch = cy1 - cy0;
  // 프레임 전체 픽셀 크기: 잘라낸 폭이 PX_W 가 되도록 (세로가 너무 길면 줄임)
  let FW = PX_W / cw;
  const maxH = 2300;
  if (ch * (FW / FRAME) > maxH) FW = maxH / ch * FRAME;
  const FH = FW / FRAME;
  const W = Math.max(1, Math.round(cw * FW)), H = Math.max(1, Math.round(ch * FH));
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(-cx0 * FW, -cy0 * FH);
  if (img) ctx.drawImage(img, r.x * FW, r.y * FH, r.w * FW, r.h * FH);
  const k = FW / REF_W;
  strokes.forEach((s, i) => { if (!removed.has(strokeKey(s, i))) drawStroke(ctx, s, FW, FH, k); });
  for (const t of texts) {
    if (!t || !t.value || (t.id && removed.has(t.id))) continue;
    const fs = Math.max(4, (t.size || 18) * k);
    ctx.save();
    ctx.fillStyle = t.color || "#1c1c22";
    ctx.font = `${fs}px "Pretendard Variable", Pretendard, -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = "top";
    String(t.value).split("\n").forEach((line, li) => ctx.fillText(line, t.x * FW + fs * 0.45, t.y * FH + fs * 0.3 + li * fs * 1.3));
    ctx.restore();
  }
  ctx.restore();
  const aspect = W / H;
  let src;
  try {
    const blob = await new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error("toBlob"))), "image/jpeg", 0.9));
    src = URL.createObjectURL(blob);
  } catch (_) {
    try { src = cv.toDataURL("image/jpeg", 0.9); } catch (e) { src = null; }
  }
  cv.width = cv.height = 1; // 메모리 해제
  return { src, aspect, framed: aspect >= 1 };
}

// 활동 슬라이드 → 그 학생 결과(HTML)
function renderSummary(session, slide, studentId, teacher) {
  const def = getSlideType(slide.type);
  const rs = ((session.responses || {})[slide.id] || []).filter(r => r.studentId === studentId);
  const st = findStudent(studentId);
  const box = el("div", { class: "pp-html" });
  if (typeof def.summary !== "function") return null;
  try {
    const students = new Map((session.participants || []).map(id => [id, findStudent(id)]).filter(([, s]) => s));
    const ctx = {
      role: "student", isTeacher: false, me: st || { id: studentId }, studentId, slide,
      session: () => session, students: () => students, participants: () => session.participants || [],
      online: () => new Set(), activity: () => (session.activity || {})[slide.id] || { phase: "ended" },
      responses: () => rs, myResponse: (k = "") => rs.find(r => (r.itemKey || "") === (k || "")) || null,
      groups: () => session.groups || [], myGroup: () => (session.groups || []).find(g => (g.memberIds || []).includes(studentId)) || null,
      setActivity() {}, submit() {}, removeResponse() {}, clearResponses() {}, send() {}, on() { return () => {}; },
      toast() {}, confirm: async () => false, modal: null, injectCss, now: () => Date.now(), teacher,
    };
    const node = def.summary(slide, rs, session, ctx);
    if (!node) return null;
    box.appendChild(el("div", { style: { fontWeight: "600", marginBottom: "3mm", fontSize: "11pt" } }, slide.title || def.label));
    box.appendChild(node);
    return box;
  } catch (e) {
    console.warn("[print] summary 실패", slide.type, e);
    return null;
  }
}

// ── 인쇄 실행 공통 ──
let pageStyle = null;
function runPrint({ pageCss, htmlClass }) {
  pageStyle?.remove();
  pageStyle = el("style", { "data-print": "page" });
  pageStyle.textContent = pageCss;
  document.head.appendChild(pageStyle);
  document.documentElement.classList.add(htmlClass);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener("afterprint", finish);
      document.documentElement.classList.remove(htmlClass);
      pageStyle?.remove(); pageStyle = null;
      resolve();
    };
    window.addEventListener("afterprint", finish);
    // 이미지 디코딩 한 프레임 기다린 뒤 인쇄
    requestAnimationFrame(() => setTimeout(() => {
      try { window.print(); } catch (e) { console.warn("[print]", e); }
      setTimeout(finish, 1500); // afterprint 가 없는 브라우저 대비
    }, 60));
  });
}

// ── 학생 개별 결과 인쇄 ──
// slideIds 순서는 세션 슬라이드 순서를 따른다.
export async function printStudents({ session, studentIds, slideIds, teacher }) {
  const slides = (session.slidesSnapshot || []).filter(s => slideIds.includes(s.id));
  if (!slides.length || !studentIds.length) { toast("인쇄할 슬라이드와 학생을 고르세요"); return; }
  const total = slides.length * studentIds.length;
  const t = toast(total > 6 ? `인쇄 준비 중… (${total}장)` : "인쇄 준비 중…", { duration: 120000 });
  document.getElementById("print-root")?.remove();
  const root = el("div", { id: "print-root" });
  const urls = [];
  let done = 0;
  const title = session.title || "수업";
  for (const sid of studentIds) {
    const st = findStudent(sid);
    const who = st ? studentLabel(st) : "학생";
    const sheets = [];
    let cur = null, used = 0;
    const newSheet = (flow = false) => {
      const body = el("div", { class: "pp-body" });
      const pageNo = el("span", { class: "pp-page" });
      const sheet = el("section", { class: "pp-sheet" + (flow ? " flow" : "") }, [
        el("header", { class: "pp-head" }, [
          el("span", { class: "pp-title" }, `${title} · ${who}`),
          pageNo,
          el("img", { class: "pp-mark", src: MARK, alt: "" }),
        ]),
        body,
      ]);
      sheet._body = body; sheet._no = pageNo;
      sheets.push(sheet);
      return sheet;
    };
    for (const sl of slides) {
      if (sl.type === "ink") {
        const out = await renderInk(session, sl, sid);
        done++;
        if (!out.src) continue;
        if (out.src.startsWith("blob:")) urls.push(out.src);
        // 크기(mm): 폭 196 기준, 높이가 넘치면 높이 기준
        let w = PAGE_W, h = PAGE_W / out.aspect;
        if (h > BODY_H) { h = BODY_H; w = BODY_H * out.aspect; }
        if (!cur || cur.classList.contains("flow") || used + (used ? GAP : 0) + h > BODY_H) { cur = newSheet(); used = 0; }
        used += (used ? GAP : 0) + h;
        cur._body.appendChild(el("img", {
          class: "pp-img" + (out.framed ? " framed" : ""), src: out.src, alt: "",
          style: { width: `${w.toFixed(1)}mm`, height: `${h.toFixed(1)}mm` },
        }));
      } else {
        const node = renderSummary(session, sl, sid, teacher);
        done++;
        if (!node) continue;
        cur = newSheet(true); used = BODY_H; // 활동 결과는 자기 장에서 흐르게
        cur._body.appendChild(node);
      }
      await new Promise(r => setTimeout(r, 0)); // UI 숨 돌리기
    }
    sheets.forEach((s, i) => { s._no.textContent = sheets.length > 1 ? `${i + 1}/${sheets.length}` : ""; });
    root.append(...sheets);
  }
  if (!root.children.length) { t?.close?.(); toast("인쇄할 내용이 없어요"); return; }
  document.body.appendChild(root);
  // 이미지 로드 대기
  await Promise.all([...root.querySelectorAll("img")].map(im => (im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; }))));
  if (t && t.close) t.close();
  await runPrint({ pageCss: "@page { size: A4 portrait; margin: 0; }", htmlClass: "pp-printing" });
  root.remove();
  urls.forEach(u => URL.revokeObjectURL(u));
}

// ── 기록 화면 그대로 인쇄 (글씨 작게, 여백 작게, 워터마크) ──
export async function printRecordView() {
  let mark = document.querySelector(".pp-fixed-mark");
  if (!mark) { mark = el("img", { class: "pp-fixed-mark", src: MARK, alt: "" }); document.body.appendChild(mark); }
  const css = `@page { size: A4 portrait; margin: 8mm 8mm 8mm 8mm; }
@media print {
  html.pp-record .main { padding: 0 14mm 0 0 !important; }
  html.pp-record .page-head h1 { font-size: 12pt !important; margin: 0 !important; }
  html.pp-record .page-head, html.pp-record .t-meta { font-size: 8.5pt !important; gap: 3mm !important; margin: 0 0 2mm !important; }
  html.pp-record h2, html.pp-record h3 { font-size: 10pt !important; margin: 2mm 0 !important; }
  html.pp-record .stack-lg { gap: 4mm !important; }
}`;
  await runPrint({ pageCss: css, htmlClass: "pp-record" });
  mark.remove();
}

// ── 학생 인쇄 선택 창: 1) 슬라이드 2) 학생 ──
export function openStudentPrint({ session, teacher, studentIds: preset } = {}) {
  const slides = session.slidesSnapshot || [];
  const students = sessionStudents(session);
  if (!slides.length) { toast("슬라이드가 없어요"); return; }
  if (!students.length) { toast("참여한 학생이 없어요"); return; }
  const pickSlides = new Set(slides.filter(s => s.type === "ink").map(s => s.id));
  if (!pickSlides.size) slides.forEach(s => pickSlides.add(s.id));
  const pickStudents = new Set(preset && preset.length ? preset : students.map(x => x.id));
  let step = 1;
  const body = el("div", { class: "pp-wiz" });
  const m = modal({ title: "학생 인쇄", body, wide: true, actions: [] });

  const checkEl = () => el("span", { class: "pp-check", html: CHECK });
  function render() {
    body.replaceChildren();
    body.appendChild(el("div", { class: "pp-step" }, [
      el(step === 1 ? "b" : "span", {}, "1. 슬라이드"), el("span", {}, "›"), el(step === 2 ? "b" : "span", {}, "2. 학생"),
    ]));
    if (step === 1) {
      const grid = el("div", { class: "pp-slides" }, slides.map((sl, i) => {
        const def = getSlideType(sl.type);
        let th;
        try { th = def.thumb ? def.thumb(sl) : null; } catch (_) { th = null; }
        const card = el("button", { class: "pp-slide" + (pickSlides.has(sl.id) ? " on" : ""), type: "button",
          onClick: () => { pickSlides.has(sl.id) ? pickSlides.delete(sl.id) : pickSlides.add(sl.id); card.classList.toggle("on", pickSlides.has(sl.id)); upd(); },
        }, [checkEl(), el("div", { class: "pp-thumb" }, th ? [th] : []), el("div", { class: "pp-cap" }, [el("b", {}, String(i + 1)), el("span", {}, sl.title || def.label)])]);
        return card;
      }));
      const all = el("button", { class: "btn btn-sm", type: "button", onClick: () => { slides.forEach(s => pickSlides.add(s.id)); render(); } }, "전체 선택");
      const ink = el("button", { class: "btn btn-sm", type: "button", onClick: () => { pickSlides.clear(); slides.filter(s => s.type === "ink").forEach(s => pickSlides.add(s.id)); render(); } }, "필기만");
      const none = el("button", { class: "btn btn-sm btn-ghost", type: "button", onClick: () => { pickSlides.clear(); render(); } }, "해제");
      const info = el("span", { class: "grow" });
      const next = el("button", { class: "btn btn-primary", type: "button", onClick: () => { if (pickSlides.size) { step = 2; render(); } } }, "다음");
      const upd = () => { info.textContent = `${pickSlides.size}장 선택`; next.disabled = !pickSlides.size; };
      body.append(el("div", { class: "pp-tools" }, [all, ink, none]), grid, el("div", { class: "pp-foot" }, [info, el("button", { class: "btn", type: "button", onClick: () => m.close() }, "취소"), next]));
      upd();
    } else {
      const list = el("div", { class: "pp-students" }, students.map(({ id, st }) => {
        const b = el("button", { class: "pp-stu" + (pickStudents.has(id) ? " on" : ""), type: "button",
          onClick: () => { pickStudents.has(id) ? pickStudents.delete(id) : pickStudents.add(id); b.classList.toggle("on", pickStudents.has(id)); upd(); },
        }, [checkEl(), el("span", {}, st ? studentLabel(st) : "학생")]);
        return b;
      }));
      const all = el("button", { class: "btn btn-sm", type: "button", onClick: () => { students.forEach(x => pickStudents.add(x.id)); render(); } }, "전체 선택");
      const none = el("button", { class: "btn btn-sm btn-ghost", type: "button", onClick: () => { pickStudents.clear(); render(); } }, "해제");
      const info = el("span", { class: "grow" });
      const go = el("button", { class: "btn btn-primary", type: "button", onClick: async () => {
        if (!pickStudents.size) return;
        const ids = students.map(x => x.id).filter(id => pickStudents.has(id));
        const sl = slides.map(s => s.id).filter(id => pickSlides.has(id));
        m.close();
        await printStudents({ session, studentIds: ids, slideIds: sl, teacher });
      } }, [icon("print", 18), "인쇄"]);
      const upd = () => { info.textContent = `${pickStudents.size}명 · ${pickSlides.size}장`; go.disabled = !pickStudents.size; };
      body.append(el("div", { class: "pp-tools" }, [all, none]), list, el("div", { class: "pp-foot" }, [
        info, el("button", { class: "btn", type: "button", onClick: () => { step = 1; render(); } }, "이전"), go,
      ]));
      upd();
    }
  }
  render();
  return m;
}
