// 부트: 슬라이드 타입 등록 → initCloud(1회, 첫 화면은 기다리지 않음) → 라우트 등록 → start (docs/ARCHITECTURE.md §8, §9)
// 가정: teacher.js는 동적 import로 격리한다(동시 수정 중 깨져도 학생 화면·랜딩은 동작). 화면 전환 전에 해시가 바뀌었으면 그리지 않는다.
// 가정: 라우트 핸들러 안의 리다이렉트는 다음 틱에 go(replace) — 동기 재디스패치는 라우터의 cleanup 기록을 덮어쓴다.
// 가정: 교사 로그인 상태에서 /teacher-login에 오면 /teacher로 보낸다(로그아웃은 대시보드).
// 가정: /student-login?form=1 은 기억된 학생이 있어도 폼을 연다(대기 화면 '코드 바꾸기'). 이때 학생 정보는 채우고 코드는 비운다.
// 가정: 참여 등록(cloudAddParticipant)은 여기서 하지 않는다 — 수업 화면 진입 시 student.js가 1회 처리.
// 가정: QR 입장(/student/join?c=)에서 기억된 학생이면 로그인 화면을 그린 뒤 그 코드로 바로 입장을 시도한다(lastCode는 성공 시 저장).
import "./slides/index.js"; // 슬라이드 타입 등록 (top-level await — 라우팅 전에 끝남)
import { route, start, go } from "./router.js";
import { mount, template, el } from "./ui.js";
import { inkWord, inkWidth } from "./handwriting.js";
import { initBrandBanner } from "./brand-banner.js";
import { store, normCode } from "./store.js";
import {
  initCloud, cloudReady, cloudLoginTeacher, cloudBootTeacher, cloudFindTeacherByCode, cloudJoinStudent,
  cloudFetchLiveSession,
} from "./cloud.js";
import { studentWaitView, studentLiveView, studentRecordsView, currentStudent } from "./student.js";

initCloud().then(ok => console.info(ok ? "hada: Supabase 클라우드 모드" : "hada: 로컬 모드"));

// 교사 모듈(동적 import로 격리)
const teacherMod = import("./teacher.js").catch(e => { console.error("[app] teacher.js 로드 실패", e); return {}; });

function redirect(path) { setTimeout(() => go(path, { replace: true }), 0); }
function ssGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function ssSet(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} }
const isEnter = (e) => e.key === "Enter" && !e.isComposing && e.keyCode !== 229;
function failView() {
  mount(el("main", { class: "center-page" }, el("div", { class: "empty" }, "화면을 불러오지 못했어요")));
}

// Landing
route("/", () => {
  const v = template("tpl-landing");
  mount(v);
  v.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => go("/" + b.dataset.go)));
  return playIntro(v.querySelector(".intro-type"));
});

// 인트로 타이포: [필기]하다 → [공유]하다 → [소통]하다 → [수업]하다
// 각 단어는 획순대로 펜으로 쓰듯 그려지고, 마지막 '수업'이 써지면 앱 이름 (수업)하다로 강조.
// 강조까지 전체 모션이 2초 안에 끝나도록 빠르게 샥샥 쓴다.
const INTRO_WORDS = ["필기", "공유", "소통", "수업"];
const INTRO_WRITE_MS = 240;  // 단어 하나 쓰는 시간
const INTRO_HOLD_MS = 80;    // 다 쓴 단어가 머무는 시간
function playIntro(root) {
  const slot = root.querySelector(".intro-slot");
  const hadaBox = root.querySelector(".intro-hada");
  let alive = true;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // 괄호 폭을 가장 넓은 단어에 맞춰 고정 — 단어가 바뀔 때 괄호가 흔들리지 않게
  slot.style.width = Math.max(...INTRO_WORDS.map(inkWidth)) + "em";
  const place = (w, opts) => {
    const word = inkWord(w, opts);
    slot.appendChild(word.svg);
    return word;
  };
  const erase = (svg) => {
    slot.querySelectorAll(".ink-word.out").forEach(n => n.remove());
    svg.classList.add("out");
    svg.addEventListener("animationend", () => svg.remove(), { once: true });
  };

  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    hadaBox.appendChild(inkWord("하다", { written: true }).svg);
    place(INTRO_WORDS.at(-1), { written: true }).highlight({ written: true });
    root.classList.add("play", "named");
    return;
  }
  (async () => {
    // 백그라운드 탭으로 열렸다면 화면에 보일 때 재생
    if (document.hidden) await new Promise(r => document.addEventListener("visibilitychange", r, { once: true }));
    if (!alive) return;
    let word = place(INTRO_WORDS[0]);
    const hada = inkWord("하다");
    hadaBox.appendChild(hada.svg);
    root.classList.add("play");
    await word.write({ delay: 40, duration: INTRO_WRITE_MS });
    if (!alive) return;
    await hada.write({ duration: 200 });
    for (const w of INTRO_WORDS.slice(1)) {
      await sleep(INTRO_HOLD_MS);
      if (!alive) return;
      erase(word.svg);
      word = place(w);
      await word.write({ delay: 40, duration: INTRO_WRITE_MS });
      if (!alive) return;
    }
    root.classList.add("named");
    word.highlight({ duration: 200 });
  })();
  return () => { alive = false; };
}

// ── 교사 로그인 ──
route("/teacher-login", () => {
  if (store.state.whoTeacher) { redirect("/teacher"); return; }
  const v = template("tpl-teacher-login");
  mount(v);
  let dead = false, busy = false;
  const nameI = v.querySelector("#t-name"), pwI = v.querySelector("#t-pw");
  const btn = v.querySelector("#t-submit"), err = v.querySelector("#t-err");
  v.querySelector(".back").onclick = () => go("/");

  async function submit() {
    if (busy) return;
    const name = nameI.value.trim(), pw = pwI.value;
    err.textContent = "";
    if (!name || !pw) { err.textContent = "이름과 비밀번호를 입력해 주세요"; (name ? pwI : nameI).focus(); return; }
    busy = true;
    btn.classList.add("loading");
    try {
      await cloudReady;
      const res = await cloudLoginTeacher(name, pw);
      if (dead) return;
      if (!res || res.error || !res.teacher) { err.textContent = (res && res.error) || "잠시 후 다시 시도해 주세요"; return; }
      store.set(s => { s.whoTeacher = res.teacher.id; });
      try { await cloudBootTeacher(res.teacher.id); } catch (e) { console.warn("[app] 교사 부팅 조회 실패", e); }
      if (!dead) go("/teacher");
    } catch (e) {
      console.warn("[app] 교사 로그인 실패", e);
      if (!dead) err.textContent = "서버에 연결하지 못했어요";
    } finally {
      busy = false;
      if (!dead) btn.classList.remove("loading");
    }
  }
  btn.onclick = submit;
  nameI.addEventListener("keydown", (e) => { if (isEnter(e)) { e.preventDefault(); pwI.focus(); } });
  pwI.addEventListener("keydown", (e) => { if (isEnter(e)) { e.preventDefault(); submit(); } });
  requestAnimationFrame(() => { if (!dead) nameI.focus({ preventScroll: true }); });
  return () => { dead = true; };
});

// ── 학생 입장 ──
// opts.autoCode: QR 입장 — 기억된 학생으로 이 코드에 바로 입장
function studentLoginView(params = {}, { autoCode = null } = {}) {
  const v = template("tpl-student-login");
  mount(v);
  let dead = false, busy = false;
  const q = (sel) => v.querySelector(sel);
  const remembered = q("#s-remembered"), againBtn = q("#s-again"), otherBtn = q("#s-other"), form = q("#s-form");
  const codeI = q("#s-code"), gradeI = q("#s-grade"), classI = q("#s-class"), numI = q("#s-num"), nameI = q("#s-name");
  const submitBtn = q("#s-submit"), err = q("#s-err");
  q(".back").onclick = () => go("/");

  const profile = currentStudent();
  const preset = normCode(params.c || ssGet("hada:joinCode") || "");
  const rememberedCode = normCode(autoCode || (profile && profile.lastCode) || "");
  const canRemember = !!(profile && profile.id && rememberedCode) && !params.form;

  // 입력 정규화
  codeI.addEventListener("input", () => {
    const c = codeI.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    if (c !== codeI.value) codeI.value = c;
  });
  for (const inp of [gradeI, classI, numI]) {
    const max = +inp.getAttribute("maxlength") || 3;
    inp.addEventListener("input", () => {
      const d = inp.value.replace(/\D/g, "").slice(0, max);
      if (d !== inp.value) inp.value = d;
    });
  }
  // Enter: 다음 칸 → 마지막은 입장
  const order = [codeI, gradeI, classI, numI, nameI];
  order.forEach((inp, i) => inp.addEventListener("keydown", (e) => {
    if (!isEnter(e)) return;
    e.preventDefault();
    if (i < order.length - 1) order[i + 1].focus(); else submitForm();
  }));

  function fillStudent(p) {
    gradeI.value = p ? String(p.grade ?? "") : "";
    classI.value = p ? String(p.classNum ?? "") : "";
    numI.value = p ? String(p.num ?? "") : "";
    nameI.value = p ? String(p.name ?? "") : "";
  }
  function showForm({ keepStudent = false, code = "" } = {}) {
    remembered.hidden = true;
    form.hidden = false;
    err.textContent = "";
    fillStudent(keepStudent ? profile : null);
    codeI.value = code;
    requestAnimationFrame(() => {
      if (dead) return;
      const target = !codeI.value ? codeI : order.find(x => !x.value) || nameI;
      target.focus({ preventScroll: true });
    });
  }

  function setBusy(btn, on) {
    if (btn === againBtn) {
      againBtn.disabled = on;
      againBtn.setAttribute("aria-busy", on ? "true" : "false");
      if (on) { againBtn._label = againBtn.textContent; againBtn.replaceChildren(el("span", { class: "spinner", style: { borderColor: "rgba(255,255,255,.35)", borderTopColor: "#fff" } })); }
      else if (againBtn._label != null) { againBtn.textContent = againBtn._label; }
    } else {
      btn.classList.toggle("loading", on);
    }
  }

  // 입장 흐름 (§9.2)
  async function join({ code, grade, classNum, num, name }, btn) {
    if (busy) return;
    busy = true;
    err.textContent = "";
    setBusy(btn, true);
    const fail = (msg) => { if (!dead) err.textContent = msg; };
    try {
      // cloudReady는 기다리지 않는다(같은 기기에 교사 로그인이 있으면 교사 부팅 조회까지 기다리게 됨). cloud 함수가 클라이언트 준비를 기다린다.
      let teacher = null;
      try { teacher = await cloudFindTeacherByCode(code); }
      catch (e) { console.warn("[app] 코드 조회 실패", e); return fail("서버에 연결하지 못했어요"); }
      if (dead) return;
      if (!teacher) return fail("코드를 확인해 주세요");
      let student = null;
      try { student = await cloudJoinStudent({ grade, classNum, num, name }); }
      catch (e) { console.warn("[app] 학생 등록 실패", e); return fail("서버에 연결하지 못했어요"); }
      if (dead) return;
      if (!student || !student.id) return fail("잠시 후 다시 시도해 주세요");
      store.set(s => {
        s.studentProfile = { id: student.id, grade: student.grade, classNum: student.classNum, num: student.num, name: student.name, lastCode: code };
        s.whoStudent = student.id;
      });
      ssSet("hada:joinCode", null);
      let live = null;
      try { live = await cloudFetchLiveSession(teacher.id, { forStudentId: student.id }); }
      catch (e) { console.warn("[app] 진행 중 수업 조회 실패", e); }
      if (dead) return;
      if (live && live.status === "live") {
        // 참여 등록은 수업 화면(studentLiveView.load)이 진입 시 1회 처리
        ssSet("hada:left", null);
        go("/student/live/" + live.id);
      } else if (!dead) {
        go("/student");
      }
    } finally {
      busy = false;
      if (!dead) setBusy(btn, false);
    }
  }

  function submitForm() {
    const code = normCode(codeI.value);
    const grade = parseInt(gradeI.value, 10), classNum = parseInt(classI.value, 10), num = parseInt(numI.value, 10);
    const name = nameI.value.trim();
    err.textContent = "";
    if (!code) { err.textContent = "코드 6자리를 입력해 주세요"; codeI.focus(); return; }
    if (!(grade > 0) || !(classNum > 0) || !(num > 0) || !name) {
      err.textContent = "학년·반·번호·이름을 모두 입력해 주세요";
      (order.find(x => !x.value.trim()) || gradeI).focus();
      return;
    }
    join({ code, grade, classNum, num, name }, submitBtn);
  }
  submitBtn.onclick = submitForm;

  if (canRemember) {
    remembered.hidden = false;
    form.hidden = true;
    againBtn.textContent = `${profile.name} (${profile.grade}-${profile.classNum}-${profile.num}) · ${rememberedCode} 입장`;
    const runRemembered = () => join({
      code: rememberedCode, grade: profile.grade, classNum: profile.classNum, num: profile.num, name: profile.name,
    }, againBtn);
    againBtn.onclick = runRemembered;
    otherBtn.onclick = () => showForm({ code: preset || rememberedCode || "" });
    if (autoCode) runRemembered();
  } else if (profile && (params.form || !rememberedCode)) {
    // 코드 바꾸기 · 코드 없이 기억된 학생: 학생 정보는 채우고 코드만 입력
    showForm({ keepStudent: true, code: preset || "" });
  } else {
    showForm({ code: preset || "" });
  }

  return () => { dead = true; };
}

route("/student-login", (params) => studentLoginView(params || {}));

// QR: /student/join?c=CODE
route("/student/join", (params) => {
  const code = normCode((params && params.c) || "");
  const me = currentStudent();
  if (me && me.id && code) {
    // 기록상 주소를 로그인 화면으로 바꿔 둔다 → 수업에서 '뒤로'를 눌러도 자동 입장이 반복되지 않음(재디스패치 없음)
    try { history.replaceState(null, "", "#/student-login"); } catch {}
    return studentLoginView({}, { autoCode: code });
  }
  if (code) ssSet("hada:joinCode", code);
  redirect("/student-login");
});

// ── 학생 ──
function studentOnly(view) {
  return (p) => {
    if (!currentStudent()) { redirect("/student-login"); return; }
    return view(p || {});
  };
}
route("/student", studentOnly(() => studentWaitView()));
route("/student/live/:id", studentOnly((p) => studentLiveView({ id: p.id })));
route("/student/records", studentOnly(() => studentRecordsView()));

// ── 교사 ──
// 가드 + 동적 모듈. 기다리는 동안 다른 화면으로 갔으면 그리지 않는다.
function teacherRoute(name) {
  return async (p) => {
    if (!store.state.whoTeacher) { redirect("/teacher-login"); return; }
    const hash = location.hash;
    const mod = await teacherMod;
    if (location.hash !== hash) return;
    const fn = mod && mod[name];
    if (typeof fn !== "function") { console.error(`[app] teacher.js의 ${name}()가 없어요`); failView(); return; }
    return fn(p || {});
  };
}
route("/teacher", teacherRoute("teacherDashboard"));
route("/editor/:id", teacherRoute("editorView"));
route("/live/:id", teacherRoute("liveView"));
route("/teacher/session/:id", teacherRoute("sessionDetailView"));

// 레거시: 진행 중 세션이 있으면 수업 진행, 없으면 대시보드
route("/teacher/live", async () => {
  const tid = store.state.whoTeacher;
  if (!tid) { redirect("/teacher-login"); return; }
  const hash = location.hash;
  await cloudReady;
  if (location.hash !== hash) return;
  const live = (store.state.sessions || []).filter(s => s.teacherId === tid && s.status === "live")
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
  redirect(live ? "/live/" + live.id : "/teacher");
});

start();
initBrandBanner(); // 상단 제작자 배너 (페이지마다 잠깐 보였다가 사라짐)
