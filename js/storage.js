// 슬라이드 이미지: Supabase Storage(public 버킷 'slides') 업로드·썸네일·PDF·PowerPoint 변환
// 경로: <lessonId>/<slideId>_<Date.now().toString(36)>.jpg, 썸네일은 같은 이름 + '_t.jpg' (폭 320px)
// 로컬 모드: 업로드 없이 data URL을 그대로 돌려준다(썸네일은 작은 data URL).
// 가정: 본 이미지는 긴 변 2400px 이하로 맞추고, 5MB를 넘으면 화질/크기를 낮춰 다시 인코딩한다.
// 놓인 이미지(편집기 [이미지], slide.config.images): <lessonId>/<slideId>_img_<시각>.png|jpg, 썸네일 없음. 긴 변 1600px,
//       투명한 픽셀이 있으면 PNG(흰 배경을 깔지 않음), 없으면 JPEG.
import { cloudEnabled, supaClient, clientReady } from "./cloud.js";
import { newId, store } from "./store.js";

const BUCKET = "slides";
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.min.mjs";
const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs";
const THUMB_W = 320;
const MAX_SIDE = 2400;
// 세로(학습지) 페이지는 학생이 확대해서 쓰므로 긴 변을 더 크게(A4 ≈ 2120×3000 ≈ 250dpi)
const MAX_SIDE_PORTRAIT = 3000;
const maxSideFor = (w, h) => (h > w ? MAX_SIDE_PORTRAIT : MAX_SIDE);
const MAX_BYTES = 5 * 1024 * 1024 - 16 * 1024;
const PLACED_MAX_SIDE = 1600;
const UPLOAD_OPTS = { contentType: "image/jpeg", cacheControl: "31536000", upsert: false };

export function isDataUrl(s) {
  return typeof s === "string" && s.startsWith("data:");
}

// 본 이미지 경로 → 썸네일 경로
export function thumbPathOf(path) {
  return path ? path.replace(/\.jpg$/i, "") + "_t.jpg" : null;
}

// 클라우드 설정인데 아직 클라이언트 생성 전이면 잠시 대기(최대 8초) — data URL로 새는 것 방지
async function waitClient() {
  if (cloudEnabled() || !store.cloudMode) return;
  await Promise.race([clientReady, new Promise(r => setTimeout(r, 8000))]);
}

function bucket() {
  const supa = supaClient();
  return supa ? supa.storage.from(BUCKET) : null;
}

function publicUrl(path) {
  const b = bucket();
  return b ? b.getPublicUrl(path).data.publicUrl : null;
}

// ── 인코딩 헬퍼 ──
function canvasToBlob(cv, quality = 0.85, type = "image/jpeg") {
  return new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error("이미지 변환 실패")), type, quality));
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return await res.blob();
}

async function loadBitmap(blob) {
  if (typeof createImageBitmap === "function") {
    try { return await createImageBitmap(blob); } catch (_) { /* 아래 <img> 경로로 */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// 흰 배경 위에 그려서(투명 PNG 대비) 지정 폭으로 캔버스 생성
function drawToCanvas(src, w, h) {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  const g = cv.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(src, 0, 0, cv.width, cv.height);
  return cv;
}

function thumbCanvas(src, w, h) {
  const tw = Math.min(THUMB_W, w);
  return drawToCanvas(src, tw, h * (tw / w));
}

// 캔버스(이미 렌더된 원본) → { main: Blob, thumb: Blob }
async function encodeCanvas(cv, quality = 0.85) {
  let main = await canvasToBlob(cv, quality);
  let q = quality, scale = 1;
  // 5MB 초과 시 화질 → 크기 순으로 낮춤
  while (main.size > MAX_BYTES && (q > 0.5 || scale > 0.4)) {
    if (q > 0.5) q -= 0.1; else scale *= 0.8;
    const c2 = scale < 1 ? drawToCanvas(cv, cv.width * scale, cv.height * scale) : cv;
    main = await canvasToBlob(c2, q);
  }
  const thumb = await canvasToBlob(thumbCanvas(cv, cv.width, cv.height), 0.8);
  return { main, thumb };
}

// 임의 이미지 Blob → { main, thumb }
async function encodeBlob(blob) {
  const bmp = await loadBitmap(blob);
  const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, maxSideFor(w0, h0) / Math.max(w0, h0));
  // 이미 적당한 JPEG면 재인코딩하지 않음(화질 보존)
  if (blob.type === "image/jpeg" && k === 1 && blob.size <= MAX_BYTES) {
    const thumb = await canvasToBlob(thumbCanvas(bmp, w0, h0), 0.8);
    bmp.close?.();
    return { main: blob, thumb };
  }
  const cv = drawToCanvas(bmp, w0 * k, h0 * k);
  bmp.close?.();
  return await encodeCanvas(cv, 0.85);
}

// { main, thumb } Blob → 업로드 또는 로컬 data URL
async function putEncoded(lessonId, slideId, enc) {
  if (!cloudEnabled() || !bucket()) {
    return { url: await blobToDataUrl(enc.main), path: null, thumb: await blobToDataUrl(enc.thumb) };
  }
  const path = `${lessonId}/${slideId}_${Date.now().toString(36)}.jpg`;
  const tpath = thumbPathOf(path);
  const b = bucket();
  const [r1, r2] = await Promise.all([
    b.upload(path, enc.main, UPLOAD_OPTS),
    b.upload(tpath, enc.thumb, UPLOAD_OPTS),
  ]);
  if (r1.error) {
    if (!r2.error) b.remove([tpath]).catch?.(() => {}); // 고아 썸네일 정리(best-effort)
    throw new Error("이미지 업로드 실패: " + (r1.error.message || r1.error));
  }
  if (r2.error) console.warn("[storage] 썸네일 업로드 실패:", r2.error);
  return { url: publicUrl(path), path, thumb: r2.error ? publicUrl(path) : publicUrl(tpath) };
}

// 본+썸네일 업로드. 로컬 모드: dataURL 그대로 반환
export async function uploadSlideImage(lessonId, slideId, blobOrDataUrl) {
  if (!blobOrDataUrl) throw new Error("이미지가 없어요");
  await waitClient();
  if (!cloudEnabled() && isDataUrl(blobOrDataUrl)) {
    // 로컬 모드: 원본 data URL 유지, 썸네일만 작게
    let thumb = blobOrDataUrl;
    try {
      const bmp = await loadBitmap(await dataUrlToBlob(blobOrDataUrl));
      thumb = await blobToDataUrl(await canvasToBlob(thumbCanvas(bmp, bmp.width || bmp.naturalWidth, bmp.height || bmp.naturalHeight), 0.8));
      bmp.close?.();
    } catch (_) { /* 썸네일 실패 시 원본 사용 */ }
    return { url: blobOrDataUrl, path: null, thumb };
  }
  const blob = isDataUrl(blobOrDataUrl) ? await dataUrlToBlob(blobOrDataUrl) : blobOrDataUrl;
  const enc = await encodeBlob(blob);
  return await putEncoded(lessonId, slideId, enc);
}

// 투명한 픽셀이 있나(듬성듬성 확인)
function hasAlpha(g, w, h) {
  const d = g.getImageData(0, 0, w, h).data;
  const step = 4 * Math.max(1, Math.floor((w * h) / 250000));
  for (let i = 3; i < d.length; i += step) if (d[i] < 250) return true;
  return false;
}

// 슬라이드 위에 놓는 이미지 → { url, path, ar(가로/세로) }. 로컬 모드: data URL
export async function uploadPlacedImage(lessonId, slideId, blob) {
  if (!blob) throw new Error("이미지가 없어요");
  await waitClient();
  const bmp = await loadBitmap(blob);
  const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
  if (!w0 || !h0) { bmp.close?.(); throw new Error("이미지를 읽지 못했어요"); }
  let k = Math.min(1, PLACED_MAX_SIDE / Math.max(w0, h0));
  const draw = (scale, white) => {
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(w0 * scale));
    cv.height = Math.max(1, Math.round(h0 * scale));
    const g = cv.getContext("2d");
    if (white) { g.fillStyle = "#ffffff"; g.fillRect(0, 0, cv.width, cv.height); }
    g.drawImage(bmp, 0, 0, cv.width, cv.height);
    return { cv, g };
  };
  let main, png = false;
  try {
    const first = draw(k, false);
    png = !/jpe?g/i.test(blob.type || "") && hasAlpha(first.g, first.cv.width, first.cv.height);
    if (png) {
      main = await canvasToBlob(first.cv, undefined, "image/png");
      while (main.size > MAX_BYTES && k > 0.1) { k *= 0.75; main = await canvasToBlob(draw(k, false).cv, undefined, "image/png"); }
    } else {
      let q = 0.88;
      main = await canvasToBlob(draw(k, true).cv, q);
      while (main.size > MAX_BYTES && (q > 0.5 || k > 0.1)) {
        if (q > 0.5) q -= 0.1; else k *= 0.8;
        main = await canvasToBlob(draw(k, true).cv, q);
      }
    }
  } finally { bmp.close?.(); }
  const ar = Math.round((w0 / h0) * 10000) / 10000;
  if (!cloudEnabled() || !bucket()) return { url: await blobToDataUrl(main), path: null, ar };
  const path = `${lessonId}/${slideId}_img_${Date.now().toString(36)}.${png ? "png" : "jpg"}`;
  const { error } = await bucket().upload(path, main, { ...UPLOAD_OPTS, contentType: png ? "image/png" : "image/jpeg" });
  if (error) throw new Error("이미지 업로드 실패: " + (error.message || error));
  return { url: publicUrl(path), path, ar };
}

// 본+썸네일 삭제 (best-effort)
export async function removeSlideImage(path) {
  if (!path || !cloudEnabled() || !bucket()) return;
  try {
    const { error } = await bucket().remove([path, thumbPathOf(path)]);
    if (error) console.warn("[storage] 삭제 실패:", error);
  } catch (e) { console.warn("[storage] 삭제 실패:", e); }
}

// 수업 자료 폴더 전체 삭제 (best-effort)
export async function removeLessonImages(lessonId) {
  if (!lessonId || !cloudEnabled() || !bucket()) return;
  try {
    for (let round = 0; round < 20; round++) {
      const { data, error } = await bucket().list(lessonId, { limit: 1000 });
      if (error || !data || !data.length) return;
      const paths = data.filter(f => f && f.name).map(f => `${lessonId}/${f.name}`);
      if (!paths.length) return;
      const { error: e2 } = await bucket().remove(paths);
      if (e2) { console.warn("[storage] 폴더 삭제 실패:", e2); return; }
      if (data.length < 1000) return;
    }
  } catch (e) { console.warn("[storage] 폴더 삭제 실패:", e); }
}

// 다른 수업 자료로 이미지 복사 (복제용). 실패하면 null. tag: 파일 이름 꼬리(놓인 이미지 '_img'), 확장자는 원본 그대로
export async function copySlideImage(path, lessonId, slideId, { tag = "", thumb = true } = {}) {
  if (!path || !cloudEnabled() || !bucket()) return null;
  try {
    const ext = (/\.(png|jpe?g|webp)$/i.exec(path) || [, "jpg"])[1].toLowerCase();
    const np = `${lessonId}/${slideId}${tag}_${Date.now().toString(36)}.${ext}`;
    const { error } = await bucket().copy(path, np);
    if (error) throw error;
    if (!thumb) return { url: publicUrl(np), path: np, thumb: null };
    const { error: e2 } = await bucket().copy(thumbPathOf(path), thumbPathOf(np));
    return { url: publicUrl(np), path: np, thumb: publicUrl(e2 ? np : thumbPathOf(np)) };
  } catch (e) {
    console.warn("[storage] 복사 실패:", e);
    return null;
  }
}

// ── 파일 → ink 슬라이드 ──
let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS).then(m => {
      m.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return m;
    }).catch(e => { pdfjsPromise = null; throw e; });
  }
  return pdfjsPromise;
}

// 가져온 PDF·이미지 슬라이드의 기본 모드 = 발표(학습지 쪽은 teacher.js가 'individual'로 바꿔 넣는다)
function inkSlide(id, img) {
  return { id, type: "ink", title: null, config: {}, bg: img.url, bgPath: img.path, thumb: img.thumb, mode: "none", strokes: [], texts: [] };
}

// 동시 업로드 제한(≤3)
function limiter(max) {
  let active = 0;
  const q = [];
  const next = () => {
    if (active >= max || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}

// 쪽을 차례로 그려(render(i) → 캔버스) 동시 3개까지 올린다 → ink 슬라이드[]. 실패하면 이미 올린 그림은 지운다(best-effort)
async function pagesToSlides(total, render, lessonId, report) {
  const slides = new Array(total);
  const run = limiter(3);
  const jobs = [];
  let done = 0;
  let failed = null;
  report(0, total);
  try {
    for (let i = 0; i < total && !failed; i++) {
      // 렌더는 순서대로(메모리), 업로드는 동시 3개까지
      const cv = await render(i);
      const enc = await encodeCanvas(cv, 0.85);
      cv.width = cv.height = 0;
      const id = newId("slide");
      // 업로드 실패는 여기서 잡아 두고(남은 쪽 중단) 아래에서 한 번에 처리
      jobs.push(run(async () => {
        if (failed) return;
        const img = await putEncoded(lessonId, id, enc);
        slides[i] = inkSlide(id, img);
        report(++done, total);
      }).catch(e => { failed ||= e; }));
    }
    await Promise.all(jobs);
    if (failed) throw failed;
    return slides;
  } catch (e) {
    // 진행 중 업로드가 끝난 뒤, 이미 올라간 이미지는 best-effort 삭제(고아 방지)
    await Promise.allSettled(jobs);
    for (const s of slides) if (s && s.bgPath) removeSlideImage(s.bgPath);
    throw e;
  }
}

// PDF·PowerPoint(.pptx)·이미지 → ink 슬라이드(업로드 완료된 URL). onProgress(done, total)
// 가정(v2.15): .pptx 는 js/pptx.js 가 브라우저에서 직접 그린다(긴 변 2400px, 숨긴 슬라이드 제외). 옛 .ppt·.key 는 안내만.
export async function fileToSlides(file, lessonId, onProgress) {
  const name = (file && file.name || "").toLowerCase();
  const ext = name.split(".").pop();
  const isPdf = file.type === "application/pdf" || ext === "pdf";
  const isPptx = ext === "pptx" || file.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const isImg = /^image\/(png|jpe?g|webp|gif|bmp)$/.test(file.type) || ["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext);
  const report = (d, t) => { try { onProgress && onProgress(d, t); } catch (_) {} };
  await waitClient();

  if (isImg) {
    report(0, 1);
    const id = newId("slide");
    const enc = await encodeBlob(file);
    const img = await putEncoded(lessonId, id, enc);
    report(1, 1);
    return [inkSlide(id, img)];
  }
  if (isPptx) {
    const { openPptx } = await import("./pptx.js");
    const deck = await openPptx(await file.arrayBuffer());
    try {
      if (!deck.count) throw new Error("슬라이드가 없어요");
      return await pagesToSlides(deck.count, i => deck.render(i, deck.aspect >= 1 ? MAX_SIDE : MAX_SIDE_PORTRAIT * deck.aspect), lessonId, report);
    } finally { deck.close(); }
  }
  if (ext === "ppt" || ext === "pps" || ext === "key") throw new Error("옛 .ppt·Keynote 파일은 .pptx나 PDF로 저장해서 올려 주세요");
  if (!isPdf) throw new Error("PDF·PowerPoint(.pptx)·이미지만 올릴 수 있어요");

  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  try {
    return await pagesToSlides(doc.numPages, async (idx) => {
      const page = await doc.getPage(idx + 1);
      // 긴 변 기준 해상도(세로 3000px · 가로 2400px), 배율 1.6~4
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(4, Math.max(1.6, maxSideFor(vp1.width, vp1.height) / Math.max(vp1.width, vp1.height)));
      const vp = page.getViewport({ scale });
      const cv = document.createElement("canvas");
      cv.width = Math.floor(vp.width);
      cv.height = Math.floor(vp.height);
      const g = cv.getContext("2d");
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, cv.width, cv.height);
      try { await page.render({ canvasContext: g, viewport: vp }).promise; }
      finally { page.cleanup?.(); }
      return cv;
    }, lessonId, report);
  } finally {
    try { doc.destroy?.(); } catch (_) {}
  }
}
