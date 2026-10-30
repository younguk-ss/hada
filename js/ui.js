// UI 헬퍼 — DOM 생성, 모달/시트/토스트, 아이콘, 작은 포맷터. (docs/ARCHITECTURE.md §7)
// 가정: modal()은 v1처럼 기존 modal() 창을 교체한다(연타 누적 방지). confirm/prompt/sheet는 그 위에 쌓인다.
// 가정: mount()는 화면 전환이므로 열린 모달·시트를 모두 닫는다(대기 중 dialog는 false/null로 resolve).
// 가정: fmtTime은 남은 시간 표시에 맞게 올림(0.2초 → 00:01).
// 가정: icon()의 '24px'은 24 viewBox(Lucide 규격)로 해석, 기본 표시 크기는 20px(버튼 40px에 맞춤). 필요하면 size 인자로.
// 가정: 레이어(모달·시트)가 열려 있으면 그 안/밖의 키 입력은 document 단축키로 전달되지 않는다(Esc는 맨 위 레이어 닫기).
// 가정: el() children은 중첩 배열·숫자 허용, style 객체의 '--var'·케밥 키는 setProperty.

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") { if (v != null && v !== false) node.className = v; }
    else if (k === "style" && v && typeof v === "object") setStyle(node, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") { if (v != null) node.innerHTML = v; }
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  // 중첩 배열(map 결과 등)도 허용
  for (const c of [].concat(children).flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
// style 객체: CSS 변수(--c)·케밥 표기는 setProperty, 나머지는 camelCase 대입
function setStyle(node, obj) {
  for (const [p, val] of Object.entries(obj)) {
    if (val == null || val === false) continue;
    if (p.includes("-")) node.style.setProperty(p, String(val));
    else node.style[p] = val;
  }
}

export function template(id) {
  const t = document.getElementById(id);
  if (!t || !t.content || !t.content.firstElementChild) throw new Error(`template: #${id} 없음 (index.html)`);
  return t.content.firstElementChild.cloneNode(true);
}

export function mount(view) {
  closeAllLayers();
  const app = document.getElementById("app");
  app.innerHTML = "";
  app.appendChild(view);
}

// ── 레이어(모달·시트) 스택: Esc는 맨 위만 닫는다 ──
const layers = [];
let keysBound = false;
function bindKeys() {
  if (keysBound) return;
  keysBound = true;
  document.addEventListener("keydown", (e) => {
    if (!layers.length) return;
    const top = layers[layers.length - 1];
    if (e.key !== "Escape") {
      // 레이어 밖(body 등)에서 온 키는 뒤 화면(←/→/F 단축키)으로 보내지 않는다
      if (!top.root.contains(e.target)) e.stopPropagation();
      return;
    }
    if (e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    if (top.dismissable === false) return;
    top.close();
  }, true);
}
function openLayer(back, { kind, dismissable = true, onClose } = {}) {
  bindKeys();
  const prevFocus = document.activeElement;
  let closed = false;
  const layer = {
    kind, dismissable, root: back,
    close() {
      if (closed) return;
      closed = true;
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
      back.remove();
      if (!layers.length) document.documentElement.classList.remove("has-layer");
      try { onClose && onClose(); } catch (err) { console.error(err); }
      if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === "function") {
        try { prevFocus.focus({ preventScroll: true }); } catch {}
      }
    },
  };
  // 레이어 안의 키 입력이 document 단축키(수업 진행 ←/→ 등)로 새지 않게
  back.addEventListener("keydown", (e) => { if (e.key !== "Escape") e.stopPropagation(); });
  if (dismissable) back.addEventListener("pointerdown", (e) => { if (e.target === back) layer._downOnBack = true; });
  if (dismissable) back.addEventListener("click", (e) => {
    if (e.target === back && layer._downOnBack) layer.close();
    layer._downOnBack = false;
  });
  layers.push(layer);
  document.documentElement.classList.add("has-layer");
  document.body.appendChild(back);
  return layer;
}
export function closeAllLayers() {
  [...layers].reverse().forEach(l => l.close());
}

function focusFirst(root) {
  requestAnimationFrame(() => {
    const t = root.querySelector("[autofocus], input:not([type=hidden]), textarea, select")
      || root.querySelector(".modal-actions .btn-primary, .modal-actions .btn-danger, .sheet-actions .btn-primary");
    if (t) { try { t.focus({ preventScroll: true }); } catch {} }
  });
}

function actionButtons(actions, close, cls) {
  const row = el("div", { class: cls });
  (actions || []).forEach(a => {
    const kind = a.primary ? " btn-primary" : (a.danger ? " btn-danger" : " btn-ghost");
    const b = el("button", { class: "btn" + kind + (a.class ? " " + a.class : ""), type: "button", disabled: a.disabled }, [
      a.icon ? icon(a.icon, 18) : null, a.label,
    ]);
    b.addEventListener("click", async () => {
      if (!a.onClick) return close();
      if (b.classList.contains("loading")) return;
      let r;
      try { r = a.onClick(close); } catch (err) { console.warn("[ui] action 오류:", err); return; }
      // 비동기 핸들러면 끝날 때까지 버튼 잠금
      if (r && typeof r.then === "function") {
        b.disabled = true; b.classList.add("loading");
        try { await r; }
        catch (err) { console.warn("[ui] action 오류:", err); }
        finally { b.disabled = !!a.disabled; b.classList.remove("loading"); }
      }
    });
    row.appendChild(b);
  });
  return row;
}

// modal({ title, body, actions:[{label, primary, danger, onClick(close)}], wide, onClose, dismissable }) → { close, root }
export function modal({ title, body, actions, wide = false, onClose, dismissable = true, className = "" } = {}) {
  // 기존 modal() 창은 교체 (같은 버튼 연타로 창이 누적되지 않게)
  [...layers].filter(l => l.kind === "modal").forEach(l => l.close());
  const back = el("div", { class: "modal-back" });
  const m = el("div", {
    class: "modal" + (wide ? " modal-wide" : "") + (className ? " " + className : ""),
    role: "dialog", "aria-modal": "true", "aria-label": title || null,
  });
  const layer = openLayer(back, { kind: "modal", dismissable, onClose });
  const close = () => layer.close();
  const head = el("div", { class: "modal-head" }, [
    title ? el("h3", {}, title) : el("span"),
    dismissable ? el("button", { class: "btn btn-icon btn-ghost btn-sm modal-x", type: "button", "aria-label": "닫기", onClick: close }, icon("x", 18)) : null,
  ]);
  m.appendChild(head);
  const bodyBox = el("div", { class: "modal-body" });
  if (typeof body === "string") bodyBox.appendChild(el("p", { class: "muted" }, body));
  else if (body) bodyBox.appendChild(body);
  m.appendChild(bodyBox);
  if (actions && actions.length) m.appendChild(actionButtons(actions, close, "modal-actions row-actions"));
  back.appendChild(m);
  focusFirst(m);
  return { close, root: back };
}

// confirmDialog({ title, body?, ok='확인', cancel='취소', danger=false }) → Promise<boolean>
export function confirmDialog(opts = {}) {
  if (typeof opts === "string") opts = { title: opts };
  const { title = "", body, ok = "확인", cancel = "취소", danger = false } = opts;
  return new Promise(resolve => {
    let result = false;
    const back = el("div", { class: "modal-back" });
    const m = el("div", { class: "modal modal-confirm", role: "alertdialog", "aria-modal": "true", "aria-label": title });
    const layer = openLayer(back, { kind: "dialog", onClose: () => resolve(result) });
    const done = (v) => { result = v; layer.close(); };
    if (title) m.appendChild(el("h3", { class: "modal-title" }, title));
    if (body) m.appendChild(typeof body === "string" ? el("p", { class: "muted" }, body) : body);
    const okBtn = el("button", { class: "btn " + (danger ? "btn-danger-solid" : "btn-primary"), type: "button", onClick: () => done(true) }, ok);
    m.appendChild(el("div", { class: "modal-actions" }, [
      el("button", { class: "btn btn-ghost", type: "button", onClick: () => done(false) }, cancel),
      okBtn,
    ]));
    back.appendChild(m);
    requestAnimationFrame(() => okBtn.focus({ preventScroll: true }));
  });
}

// promptDialog({ title, value='', placeholder='', ok='확인' }) → Promise<string|null>  (취소 = null, 값은 trim)
export function promptDialog(opts = {}) {
  if (typeof opts === "string") opts = { title: opts };
  const { title = "", value = "", placeholder = "", ok = "확인", cancel = "취소", maxlength } = opts;
  return new Promise(resolve => {
    let result = null;
    const back = el("div", { class: "modal-back" });
    const m = el("div", { class: "modal modal-confirm", role: "dialog", "aria-modal": "true", "aria-label": title });
    const layer = openLayer(back, { kind: "dialog", onClose: () => resolve(result) });
    const input = el("input", { class: "input", type: "text", placeholder, maxlength, autocomplete: "off", enterkeyhint: "done" });
    input.value = value;
    const submit = () => { result = input.value.trim(); layer.close(); };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
    });
    if (title) m.appendChild(el("h3", { class: "modal-title" }, title));
    m.appendChild(input);
    m.appendChild(el("div", { class: "modal-actions" }, [
      el("button", { class: "btn btn-ghost", type: "button", onClick: () => layer.close() }, cancel),
      el("button", { class: "btn btn-primary", type: "button", onClick: submit }, ok),
    ]));
    back.appendChild(m);
    requestAnimationFrame(() => { input.focus({ preventScroll: true }); input.select(); });
  });
}

// sheet({ title?, body, onClose, actions? }) → { close, root }  하단 시트(모바일·학생)
export function sheet({ title, body, onClose, actions, dismissable = true } = {}) {
  const back = el("div", { class: "sheet-back" });
  const s = el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title || null });
  const layer = openLayer(back, { kind: "sheet", dismissable, onClose });
  const close = () => layer.close();
  s.appendChild(el("div", { class: "sheet-handle", "aria-hidden": "true" }));
  if (title || dismissable) {
    s.appendChild(el("div", { class: "sheet-head" }, [
      title ? el("h3", {}, title) : el("span"),
      dismissable ? el("button", { class: "btn btn-icon btn-ghost btn-sm", type: "button", "aria-label": "닫기", onClick: close }, icon("x", 18)) : null,
    ]));
  }
  const bodyBox = el("div", { class: "sheet-body" });
  if (typeof body === "string") bodyBox.appendChild(el("p", { class: "muted" }, body));
  else if (body) bodyBox.appendChild(body);
  s.appendChild(bodyBox);
  if (actions && actions.length) s.appendChild(actionButtons(actions, close, "sheet-actions"));
  back.appendChild(s);
  return { close, root: back };
}

// ── 토스트: 하단 가운데 스택, 2.5초 ──
let toastStack = null;
// toast(msg, { type:'ok'|'warn'|'error', duration=2500 }) → { close }
export function toast(msg, opts = {}) {
  const { type = "", duration = 2500 } = typeof opts === "string" ? { type: opts } : (opts || {});
  if (!toastStack || !toastStack.isConnected) {
    toastStack = el("div", { class: "toast-stack", "aria-live": "polite" });
    document.body.appendChild(toastStack);
  }
  const text = String(msg ?? "");
  // 같은 문구가 이미 떠 있으면 새로 쌓지 않고 시간만 연장
  const dup = [...toastStack.children].find(n => n.dataset.msg === text && !n.classList.contains("out"));
  if (dup && dup._restart) { dup._restart(); return { close: dup._hide }; }
  const ico = type === "ok" ? "check" : (type === "warn" || type === "error") ? "alert" : null;
  const t = el("div", { class: "toast" + (type ? " toast-" + type : ""), role: type === "error" ? "alert" : "status" }, [
    ico ? icon(ico, 16) : null,
    el("span", {}, text),
  ]);
  t.dataset.msg = text;
  let timer = null;
  const hide = () => {
    clearTimeout(timer);
    if (t.classList.contains("out")) return;
    t.classList.add("out");
    setTimeout(() => t.remove(), 200);
  };
  t._hide = hide;
  t._restart = () => { clearTimeout(timer); timer = setTimeout(hide, duration); };
  t.addEventListener("click", hide);
  toastStack.appendChild(t);
  // 최대 3개
  const live = [...toastStack.children].filter(n => !n.classList.contains("out"));
  if (live.length > 3) live.slice(0, live.length - 3).forEach(n => n._hide && n._hide());
  requestAnimationFrame(() => t.classList.add("show"));
  t._restart();
  return { close: hide };
}

// ── 아이콘 (Lucide 계열, 24 viewBox, stroke) ──
const ICONS = {
  "plus": '<path d="M5 12h14"/><path d="M12 5v14"/>',
  "minus": '<path d="M5 12h14"/>',
  "trash": '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  "edit": '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2.1 2.1 0 1 1 3 3L12 15l-4 1 1-4Z"/>',
  "play": '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z"/>',
  "pause": '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  "stop": '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  "chevron-left": '<path d="m15 18-6-6 6-6"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  "chevron-up": '<path d="m18 15-6-6-6 6"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "arrow-left": '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  "arrow-right": '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  "arrow-up": '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  "arrow-down": '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  "x": '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  "check": '<path d="M20 6 9 17l-5-5"/>',
  "user": '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  "users": '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  "qr": '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3"/><path d="M21 14v.01"/><path d="M17 21h4v-4"/><path d="M14 18v3"/>',
  "copy": '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
  "duplicate": '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/><path d="M15 12v6"/><path d="M12 15h6"/>',
  "pen": '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  "highlight": '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  "eraser": '<path d="m7 21-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  "text": '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  "undo": '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  "redo": '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/>',
  "eye": '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  "eye-off": '<path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M6.6 6.6A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="m2 2 20 20"/>',
  "lock": '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  "unlock": '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.75-1.4"/>',
  "refresh": '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  "timer": '<path d="M10 2h4"/><path d="m12 14 3-3"/><circle cx="12" cy="14" r="8"/>',
  "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  "history": '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  "panel": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
  "maximize": '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  "minimize": '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
  "grid": '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  "list": '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  "image": '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  "file": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  "book": '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
  "upload": '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  "download": '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  "link": '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  "external": '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  "video": '<path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.75-.43L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  "star": '<path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8Z"/>',
  "trophy": '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  "flag": '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
  "more": '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  "more-v": '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  "menu": '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  "logout": '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  "shuffle": '<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>',
  "print": '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
  "send": '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  "message": '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  "info": '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  "alert": '<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  "home": '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  "settings": '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  "present": '<path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/>',
  "hand": '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
};

export function iconSvg(name, size = 20) {
  const body = ICONS[name] || "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

// icon(name, size=20) → <span class="icon"><svg/></span>
export function icon(name, size = 20) {
  if (!ICONS[name]) console.warn("ui.icon: 없는 아이콘", name);
  const s = document.createElement("span");
  s.className = "icon";
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = iconSvg(name, size);
  return s;
}

// ── 포맷터 · 유틸 ──
export function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth()+1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// fmtTime(ms) → 'mm:ss'
export function fmtTime(ms) {
  if (ms == null || !isFinite(ms) || ms <= 0) return "00:00";
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60), s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// debounce(fn, ms) → 함수 (+ .cancel(), .flush())
export function debounce(fn, ms = 200) {
  let timer = null, lastArgs = [], lastThis = null;
  function d(...args) {
    lastArgs = args; lastThis = this;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(lastThis, lastArgs); }, ms);
  }
  d.cancel = () => { clearTimeout(timer); timer = null; };
  d.flush = () => {
    if (timer == null) return;
    clearTimeout(timer); timer = null;
    fn.apply(lastThis, lastArgs);
  };
  d.pending = () => timer != null;
  return d;
}

// copyText(text, okMsg='복사했어요', { quiet }) → Promise<boolean> (결과 toast, quiet면 실패 toast 생략)
export async function copyText(text, okMsg = "복사했어요", { quiet = false } = {}) {
  const s = String(text ?? "");
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(s);
      ok = true;
    }
  } catch {}
  if (!ok) {
    // 구형 브라우저·비보안 컨텍스트 대체
    const ta = el("textarea", { readonly: true, style: { position: "fixed", top: "-1000px", opacity: "0" } });
    ta.value = s;
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
  }
  if (ok || !quiet) toast(ok ? okMsg : "복사하지 못했어요", { type: ok ? "ok" : "error" });
  return ok;
}

// copyTextLater(Promise<string|null>, okMsg, { quiet }) → Promise<boolean>
// 누른 뒤에 정해지는 글자(예: 서버에서 만드는 복습 코드) 복사. ClipboardItem에 Promise를 넘기면 누른 동작이 이어져
// Safari·Chrome에서도 비동기 결과를 복사할 수 있다. 지원하지 않으면 값이 나온 뒤 copyText. 값이 없으면 false(toast 없음).
export async function copyTextLater(promise, okMsg = "복사했어요", opts = {}) {
  const p = Promise.resolve(promise).catch(() => null);
  const cb = navigator.clipboard;
  if (cb && window.isSecureContext && typeof window.ClipboardItem === "function" && typeof cb.write === "function") {
    try {
      const blob = p.then(t => { if (!t) throw new Error("empty"); return new Blob([String(t)], { type: "text/plain" }); });
      await cb.write([new window.ClipboardItem({ "text/plain": blob })]);
      toast(okMsg, { type: "ok" });
      return true;
    } catch {}
  }
  const t = await p;
  if (!t) return false;
  return copyText(t, okMsg, opts);
}
