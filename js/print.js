// 인쇄: 학생 개별 결과(슬라이드·학생 선택) + 기록 화면 인쇄
// - A4 세로, 여백 최소(가장자리 5mm — 대부분의 프린터가 찍을 수 있는 안쪽). 학습지 이미지는 16:10 틀의 여백을 잘라내고,
//   세로 학습지는 PDF 자체의 흰 여백까지 잘라(내용 영역 ∪ 필기 범위) 종이 한 장을 꽉 채운다.
// - 종이마다 오른쪽 위에 작은 워터마크(assets/print-mark.png), 머리글(수업 이름·학생)은 작게.
// - 학습지(학생 결과·빈 학습지)는 장마다 머리글에 그 수업의 복습 QR + 코드 → 학생이 찍으면 자기 페이스로 복습(/r/CODE).
// 가정: 필기 좌표는 16:10 프레임 기준(0..1), 배경은 object-fit: contain → 이미지 영역을 계산해 잘라낸다.
// 가정: 복습 코드를 못 만들면(열 없는 DB·오프라인) QR 없이 인쇄하고 toast로 알린다.
// 가정: 내용 영역은 확대 보기와 같은 분석(zoom-view pageRectFor: 썸네일의 흰색 아닌 범위 + 2% 여유, 세로 학습지만)을 쓴다.
//       못 읽거나 가로 슬라이드면 종이 전체. 필기·텍스트가 내용 영역 밖(학습지 흰 여백)에 있으면 그만큼 넓힌다.
import { el, modal, toast, icon } from "./ui.js";
import { findStudent, studentLabel } from "./store.js";
import { drawStroke, drawTextBox, strokeKey } from "./canvas.js";
import { getSlideType, effectiveMode, injectCss } from "./slides/index.js";
import { cloudEnsureReviewCode } from "./cloud.js";
import { pageRectFor } from "./zoom-view.js";
import { wsPages } from "./worksheet.js";
import { slideImages } from "./lesson-view.js";

const MARK = "assets/print-mark.png";
const FRAME = 16 / 10;        // 슬라이드 프레임 비율
const REF_W = 960;            // canvas.js 의 선 굵기 기준 폭
const PAGE_W = 200;           // A4 210mm - 좌우 5mm
const BODY_H = 272;           // A4 297mm - 위 5 - 머리 13 - 아래 5 - 여유 2
const GAP = 4;                // 슬라이드 사이(mm)
const PX_W = 1600;            // 출력 이미지 폭(px) ≈ 200dpi

// 인쇄 대상 = 세션 슬라이드 + 학습지 쪽(뒤에 이어서, 모드 '개별' → 그 학생 칸의 필기). _ws = 학습지 표시(선택 창 번호 자리에 '학습지')
// 가정: 학습지는 ink 슬라이드 모양이라 renderInk/recordFor 를 그대로 쓴다.
function sheetSources(session) {
  const slides = (session && session.slidesSnapshot) || [];
  const ws = wsPages(session).map((p, i) => ({ ...p, title: `${i + 1}쪽`, mode: "individual", _ws: true }));
  return { slides, ws, all: [...slides, ...ws] };
}
const numOfIn = (deck) => (sl) => (sl._ws ? "학습지" : deck.indexOf(sl) + 1);

injectCss("print", `
#print-root{display:none}
@media print{
  html.pp-printing body>*:not(#print-root){display:none!important}
  html.pp-printing #print-root{display:block}
  html.pp-printing body{background:#fff!important;margin:0}
  html.pp-record .pp-fixed-mark{display:block}
}
#print-root,#print-root *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pp-sheet{width:210mm;height:296.5mm;box-sizing:border-box;padding:5mm;display:flex;flex-direction:column;break-after:page;page-break-after:always;overflow:hidden;background:#fff;color:#1c1c22}
.pp-sheet:last-child{break-after:auto;page-break-after:auto}
.pp-sheet.flow{height:auto;overflow:visible}
.pp-head{flex:none;height:13mm;display:flex;align-items:center;gap:3mm;font:500 8.5pt/1.25 "Pretendard Variable",Pretendard,sans-serif;color:#6b6b72}
.pp-head .pp-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-head .pp-page{font-variant-numeric:tabular-nums}
.pp-mark{width:11mm;height:11mm;object-fit:contain;flex:none}
.pp-name{flex:none;display:flex;align-items:flex-end;gap:1mm;color:#1c1c22;font-size:8.5pt}
.pp-name i{display:inline-block;width:7mm;border-bottom:.25mm solid #8b8a86;height:4mm}
.pp-name i.w{width:22mm}
.pp-qr{flex:none;display:flex;align-items:center;gap:1.6mm}
.pp-qr-txt{display:flex;flex-direction:column;align-items:flex-end;font-size:6pt;line-height:1.2;color:#6b6b72}
.pp-qr-txt b{font-size:10pt;line-height:1.15;letter-spacing:.08em;color:#1c1c22;font-variant-numeric:tabular-nums}
.pp-qr-img{width:12mm;height:12mm;display:block;image-rendering:pixelated}
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

// 필기·텍스트가 차지하는 범위(16:10 프레임 정규화) | null. 선 굵기·글자 크기만큼 여유를 둔다.
function inkBounds(strokes, texts, removed) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (ax, ay, bx, by) => { x0 = Math.min(x0, ax); y0 = Math.min(y0, ay); x1 = Math.max(x1, bx); y1 = Math.max(y1, by); };
  strokes.forEach((s, i) => {
    if (!s || removed.has(strokeKey(s, i)) || s.tool === "eraser") return;
    const px = (s.size || 4) / REF_W, py = px * FRAME;
    for (const p of s.points || []) add(p.x - px, p.y - py, p.x + px, p.y + py);
  });
  for (const t of texts) {
    if (!t || !t.value || (t.id && removed.has(t.id))) continue;
    const fs = (t.size || 18) / REF_W;
    const lines = String(t.value).split("\n");
    // 칸 크기(t.w·t.h, v2.8)가 있으면 그 칸, 없으면 글자 수로 어림
    const w = t.w > 0 ? t.w : Math.max(...lines.map(l => l.length)) * fs * 1.05 + fs;
    const h = Math.max(t.h > 0 ? t.h : 0, (lines.length * 1.3 + 0.6) * fs * FRAME);
    add(t.x, t.y, t.x + w, t.y + h);
  }
  return x1 > x0 ? { x0, y0, x1, y1 } : null;
}

// ── 필기 슬라이드 한 장 → { src(objectURL|dataURL), aspect, framed } ──
// studentId가 없으면 빈 학습지(편집기 기본 필기만)
async function renderInk(session, slide, studentId) {
  const rec = studentId ? recordFor(session, slide, studentId) : null;
  const strokes = [...(slide.strokes || []), ...((rec && rec.strokes) || [])];
  const texts = [...(slide.texts || []), ...((rec && rec.texts) || [])];
  const removed = new Set((rec && rec.removed) || []);
  const [img, placed] = await Promise.all([
    loadImg(slide.bg),
    Promise.all(slideImages(slide).map(async im => ({ im, pic: await loadImg(im.url) }))), // 슬라이드 위 이미지
  ]);
  // 이미지가 프레임에서 차지하는 영역
  let r = { x: 0, y: 0, w: 1, h: 1 };
  if (img && img.naturalWidth && img.naturalHeight) {
    const ra = img.naturalWidth / img.naturalHeight;
    if (ra < FRAME) { const w = ra / FRAME; r = { x: (1 - w) / 2, y: 0, w, h: 1 }; }
    else { const h = FRAME / ra; r = { x: 0, y: (1 - h) / 2, w: 1, h }; }
  }
  // 자를 영역 = 학습지 내용 영역(흰 여백 제외) ∪ 필기 범위, 학습지 이미지 영역 안으로 (종이 한 장을 꽉 채움).
  // 가정: 학습지 바깥(16:10 틀의 빈 곳)에 쓴 필기는 인쇄하지 않는다(기록 화면 '학생별'에서는 보임).
  let f = { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
  if (img) {
    let focus = null;
    try { focus = (await pageRectFor(slide.thumb || slide.bg)).focus; } catch (_) { focus = null; }
    if (focus && focus.x1 > focus.x0 && focus.y1 > focus.y0) {
      let ink = inkBounds(strokes, texts, removed);
      for (const { im, pic } of placed) {
        if (!pic) continue;
        const b = { x0: im.x, y0: im.y, x1: im.x + im.w, y1: im.y + im.w * FRAME / im.ar };
        ink = ink ? { x0: Math.min(ink.x0, b.x0), y0: Math.min(ink.y0, b.y0), x1: Math.max(ink.x1, b.x1), y1: Math.max(ink.y1, b.y1) } : b;
      }
      const u = ink ? { x0: Math.min(focus.x0, ink.x0), y0: Math.min(focus.y0, ink.y0), x1: Math.max(focus.x1, ink.x1), y1: Math.max(focus.y1, ink.y1) } : focus;
      f = { x0: Math.max(f.x0, u.x0), y0: Math.max(f.y0, u.y0), x1: Math.min(f.x1, u.x1), y1: Math.min(f.y1, u.y1) };
      if (!(f.x1 > f.x0 && f.y1 > f.y0)) f = { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
    }
  }
  const cx0 = f.x0, cy0 = f.y0, cx1 = f.x1, cy1 = f.y1;
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
  for (const { im, pic } of placed) if (pic) ctx.drawImage(pic, im.x * FW, im.y * FH, im.w * FW, im.w * FW / im.ar);
  const k = FW / REF_W;
  strokes.forEach((s, i) => { if (!removed.has(strokeKey(s, i))) drawStroke(ctx, s, FW, FH, k); });
  for (const t of texts) {
    if (!t || !t.value || (t.id && removed.has(t.id))) continue;
    drawTextBox(ctx, t, FW, FH, Math.max(4, (t.size || 18) * k), '"Pretendard Variable", Pretendard, -apple-system, system-ui, sans-serif');
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

// ── 복습 QR (수업마다) ──
export function reviewUrl(code) {
  return `${location.origin}${location.pathname}#/r/${encodeURIComponent(code || "")}`;
}
// index.html이 qrcode를 defer로 불러오므로 준비될 때까지 잠시 기다림
async function qrDataUrl(text) {
  for (let i = 0; i < 40 && !(window.QRCode && window.QRCode.toDataURL); i++) await new Promise(r => setTimeout(r, 250));
  const Q = window.QRCode;
  if (!Q || typeof Q.toDataURL !== "function") return null;
  return await new Promise((res) => {
    try { Q.toDataURL(text, { width: 360, margin: 0, errorCorrectionLevel: "M" }, (err, url) => res(err ? null : url)); }
    catch (_) { res(null); }
  });
}
// 머리글용 '복습 코드 · QR' 묶음(장마다 cloneNode). 못 만들면 null
async function reviewBadge(session) {
  const code = await cloudEnsureReviewCode(session);
  if (!code) { toast("복습 코드를 만들지 못해 QR 없이 인쇄해요"); return null; }
  const src = await qrDataUrl(reviewUrl(code));
  return el("div", { class: "pp-qr" }, [
    el("div", { class: "pp-qr-txt" }, [el("span", {}, "복습 코드"), el("b", {}, code), el("span", {}, location.host)]),
    src ? el("img", { class: "pp-qr-img", src, alt: "" }) : null,
  ]);
}

// ── 학습지 묶음 인쇄 (공용) ──
// sets: [{ studentId|null, who: 머리글 오른쪽(문자열|노드) }], studentId 없으면 빈 학습지
async function printSheets({ session, sets, slides, teacher }) {
  const total = slides.length * sets.length;
  const t = toast(total > 6 ? `인쇄 준비 중… (${total}장)` : "인쇄 준비 중…", { duration: 120000 });
  const badge = await reviewBadge(session);
  document.getElementById("print-root")?.remove();
  const root = el("div", { id: "print-root" });
  const urls = [];
  const title = session.title || "수업";
  for (const set of sets) {
    const sid = set.studentId || null;
    const sheets = [];
    let cur = null, used = 0;
    const newSheet = (flow = false) => {
      const body = el("div", { class: "pp-body" });
      const pageNo = el("span", { class: "pp-page" });
      const who = set.who;
      const sheet = el("section", { class: "pp-sheet" + (flow ? " flow" : "") }, [
        el("header", { class: "pp-head" }, [
          el("span", { class: "pp-title" }, typeof who === "string" ? `${title} · ${who}` : title),
          who && typeof who !== "string" ? who.cloneNode(true) : null,
          pageNo,
          badge ? badge.cloneNode(true) : null,
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
      } else if (sid) {
        const node = renderSummary(session, sl, sid, teacher);
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

// ── 학생 개별 결과 인쇄 ──
// slideIds 순서는 세션 슬라이드 순서를 따른다.
export async function printStudents({ session, studentIds, slideIds, teacher }) {
  const slides = sheetSources(session).all.filter(s => slideIds.includes(s.id));
  if (!slides.length || !studentIds.length) { toast("인쇄할 슬라이드와 학생을 고르세요"); return; }
  const sets = studentIds.map(sid => { const st = findStudent(sid); return { studentId: sid, who: st ? studentLabel(st) : "학생" }; });
  await printSheets({ session, sets, slides, teacher });
}

// ── 빈 학습지 인쇄 (수업 전·중에 나눠 줄 종이: 기본 필기만 + 이름 칸 + 복습 QR) ──
export async function printBlank({ session, slideIds, teacher }) {
  const slides = sheetSources(session).all.filter(s => s.type === "ink" && slideIds.includes(s.id));
  if (!slides.length) { toast("인쇄할 슬라이드를 고르세요"); return; }
  const name = el("span", { class: "pp-name" }, [
    el("i"), "학년", el("i"), "반", el("i"), "번", " 이름", el("i", { class: "w" }),
  ]);
  await printSheets({ session, sets: [{ studentId: null, who: name }], slides, teacher });
}

// ── 기록 화면 그대로 인쇄 (글씨 작게, 여백 작게, 워터마크) ──
export async function printRecordView() {
  let mark = document.querySelector(".pp-fixed-mark");
  if (!mark) { mark = el("img", { class: "pp-fixed-mark", src: MARK, alt: "" }); document.body.appendChild(mark); }
  const css = `@page { size: A4 portrait; margin: 5mm; }
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

// 슬라이드 고르기 격자 (pick: Set<slideId>, 탭마다 onChange, numOf: 카드 번호)
function slideGrid(slides, pick, onChange, numOf = (sl, i) => i + 1) {
  return el("div", { class: "pp-slides" }, slides.map((sl, i) => {
    const def = getSlideType(sl.type);
    let th;
    try { th = def.thumb ? def.thumb(sl) : null; } catch (_) { th = null; }
    const card = el("button", { class: "pp-slide" + (pick.has(sl.id) ? " on" : ""), type: "button",
      onClick: () => { pick.has(sl.id) ? pick.delete(sl.id) : pick.add(sl.id); card.classList.toggle("on", pick.has(sl.id)); onChange(); },
    }, [el("span", { class: "pp-check", html: CHECK }), el("div", { class: "pp-thumb" }, th ? [th] : []), el("div", { class: "pp-cap" }, [el("b", {}, String(numOf(sl, i))), el("span", {}, sl.title || def.label)])]);
    return card;
  }));
}

// ── 빈 학습지 인쇄 선택 창: 필기 슬라이드 고르기 → 인쇄 ──
export function openBlankPrint({ session, teacher } = {}) {
  const { slides: deck, all } = sheetSources(session);
  const slides = all.filter(sl => sl.type === "ink");
  if (!slides.length) { toast("인쇄할 필기 슬라이드가 없어요"); return null; }
  const pick = new Set(slides.map(sl => sl.id));
  const body = el("div", { class: "pp-wiz" });
  const m = modal({ title: "빈 학습지 인쇄", body, wide: true, actions: [] });
  const info = el("span", { class: "grow" });
  const goBtn = el("button", { class: "btn btn-primary", type: "button", onClick: async () => {
    if (!pick.size) return;
    const ids = slides.map(sl => sl.id).filter(id => pick.has(id));
    m.close();
    await printBlank({ session, slideIds: ids, teacher });
  } }, [icon("print", 18), "인쇄"]);
  const upd = () => { info.textContent = `${pick.size}장 · 장마다 복습 QR · 부수는 인쇄 창에서`; goBtn.disabled = !pick.size; };
  const render = () => {
    body.replaceChildren(
      el("div", { class: "pp-tools" }, [
        el("button", { class: "btn btn-sm", type: "button", onClick: () => { slides.forEach(sl => pick.add(sl.id)); render(); } }, "전체 선택"),
        el("button", { class: "btn btn-sm btn-ghost", type: "button", onClick: () => { pick.clear(); render(); } }, "해제"),
      ]),
      slideGrid(slides, pick, upd, numOfIn(deck)), // 번호는 수업 슬라이드 순서, 학습지 쪽은 '학습지'
      el("div", { class: "pp-foot" }, [info, el("button", { class: "btn", type: "button", onClick: () => m.close() }, "취소"), goBtn]),
    );
    upd();
  };
  render();
  return m;
}

// ── 학생 인쇄 선택 창: 1) 슬라이드 2) 학생 ──
export function openStudentPrint({ session, teacher, studentIds: preset } = {}) {
  const { slides: deck, all: slides } = sheetSources(session);
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
      const grid = slideGrid(slides, pickSlides, () => upd(), numOfIn(deck));
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
