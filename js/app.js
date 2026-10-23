// Bootstrap: routes, auth, dispatch.
import { route, start, go } from "./router.js";
import { mount, template, $, $$ } from "./ui.js";
import { inkWord, inkWidth } from "./handwriting.js";
import { store } from "./store.js";
import { teacherDashboard, editorView } from "./teacher.js";
import { studentDashboard, studentLive } from "./student.js";
import { initCloud, cloudEnabled, cloudUpsertTeacher, cloudUpsertStudent, cloudAddParticipant, cloudFetchTeacherByName, sha } from "./cloud.js";

// Kick off cloud sync (no-op if env not configured)
initCloud().then(ok => {
  if (ok) console.info("hada: cloud sync via Supabase enabled");
  else console.info("hada: local mode (Supabase not configured)");
});

// 마이그레이션: 기존 교사 중 joinCode 없는 사람에게 영구 코드 발급
(function ensureTeacherCodes() {
  let changed = false;
  (store.state.teachers || []).forEach(t => {
    if (!t.joinCode) { t.joinCode = store.newJoinCode(); changed = true; }
  });
  if (changed) store.set(s => s);
})();

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

// Teacher login
route("/teacher-login", () => {
  const v = template("tpl-teacher-login");
  mount(v);
  v.querySelector(".back").onclick = () => go("/");
  v.querySelector("#t-submit").onclick = async () => {
    const name = v.querySelector("#t-name").value.trim();
    const pw = v.querySelector("#t-pw").value;
    const err = v.querySelector("#t-err");
    const btn = v.querySelector("#t-submit");
    err.textContent = "";
    if (!name || !pw) { err.textContent = "이름과 비밀번호를 입력해 주세요."; return; }
    btn.disabled = true;
    try {
      const inputHash = await sha(pw);
      // 🔑 클라우드 모드: 로컬 stale 회피 위해 항상 클라우드에서 직접 조회
      let cloudT = null;
      if (cloudEnabled()) {
        cloudT = await cloudFetchTeacherByName(name).catch(() => null);
      }
      let t = cloudT || store.state.teachers.find(x => x.name === name);

      if (!t) {
        // 신규 가입
        t = { id: store.newId("t"), name, passwordHash: inputHash, joinCode: store.newJoinCode() };
        store.set(s => s.teachers.push(t));
        await cloudUpsertTeacher(t).catch(() => {});
      } else {
        // 기존 계정: 해시 비교 (legacy password 평문도 fallback)
        const storedHash = t.passwordHash || (t.password ? await sha(t.password) : "");
        if (storedHash !== inputHash) {
          err.textContent = "비밀번호가 일치하지 않습니다.";
          return;
        }
        // 누락된 필드 보강 (legacy 마이그레이션) + 로컬 store 동기화
        if (!t.joinCode) t.joinCode = store.newJoinCode();
        store.set(s => {
          const i = s.teachers.findIndex(y => y.id === t.id);
          if (i >= 0) {
            s.teachers[i] = { id: t.id, name: t.name, passwordHash: storedHash, joinCode: t.joinCode };
          } else {
            s.teachers.push({ id: t.id, name: t.name, passwordHash: storedHash, joinCode: t.joinCode });
          }
        });
        await cloudUpsertTeacher({ ...t, passwordHash: storedHash }).catch(() => {});
      }
      store.set(s => s.whoTeacher = t.id);
      go("/teacher");
    } finally {
      btn.disabled = false;
    }
  };
});

// Student login (with optional 'c' = join code prefill from QR)
route("/student-login", (params) => {
  const v = template("tpl-student-login");
  mount(v);
  v.querySelector(".back").onclick = () => go("/");

  const codeInput = v.querySelector("#s-code");
  // QR로 진입 시 코드 자동 채움 (URL 파라미터 c 또는 sessionStorage 인계)
  const presetCode = (params && params.c) ? params.c : sessionStorage.getItem("hada:joinCode");
  if (presetCode) codeInput.value = presetCode.toUpperCase();
  // 입력은 항상 대문자로 정규화
  codeInput.addEventListener("input", () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6); });

  v.querySelector("#s-submit").onclick = () => {
    const code = (codeInput.value || "").toUpperCase().trim();
    const grade = parseInt(v.querySelector("#s-grade").value);
    const classNum = parseInt(v.querySelector("#s-class").value);
    const num = parseInt(v.querySelector("#s-num").value);
    const name = v.querySelector("#s-name").value.trim();
    const err = v.querySelector("#s-err");
    err.textContent = "";
    if (!code) { err.textContent = "수업 코드를 입력해 주세요. (선생님이 화면 또는 QR로 안내한 6자리)"; return; }
    if (!grade || !classNum || !num || !name) { err.textContent = "학년·반·번호·이름을 모두 입력해 주세요."; return; }

    const teacher = store.findTeacherByCode(code);
    if (!teacher) { err.textContent = "해당 코드의 선생님을 찾지 못했어요. 코드를 다시 확인해 주세요."; return; }
    const target = store.state.sessions.find(s => s.teacherId === teacher.id && s.status === "live");
    if (!target) { err.textContent = `${teacher.name} 선생님이 현재 진행 중인 수업이 없어요. 수업이 시작되면 다시 입장해 주세요.`; return; }

    let me = store.state.students.find(x => x.grade === grade && x.classNum === classNum && x.num === num && x.name === name);
    if (!me) {
      me = { id: store.newId("s"), grade, classNum, num, name };
      store.set(st => st.students.push(me));
      cloudUpsertStudent(me).catch(() => {});
    }
    store.set(st => {
      st.whoStudent = me.id;
      const ss = st.sessions.find(x => x.id === target.id);
      if (ss && !ss.participants.includes(me.id)) ss.participants.push(me.id);
    });
    cloudAddParticipant(target.id, me.id).catch(() => {});
    sessionStorage.removeItem("hada:joinCode");
    go("/student/live/" + target.id);
  };
});

// QR-driven student join: /student/join?c=<teacherJoinCode> (legacy: ?t=<teacherId>)
route("/student/join", (params) => {
  let code = (params.c || "").toUpperCase();
  // 레거시 t= 파라미터 지원: 해당 교사의 코드 그대로 사용
  if (!code && params.t) {
    const tt = store.state.teachers.find(t => t.id === params.t);
    if (tt) code = (tt.joinCode || "").toUpperCase();
  }

  const me = store.state.students.find(x => x.id === store.state.whoStudent);
  if (!me) {
    if (code) sessionStorage.setItem("hada:joinCode", code);
    go("/student-login");
    return;
  }
  const teacher = code ? store.findTeacherByCode(code) : null;
  const target = teacher
    ? store.state.sessions.find(s => s.teacherId === teacher.id && s.status === "live")
    : store.state.sessions.find(s => s.status === "live"); // 코드 없으면 진행 중인 아무 LIVE
  if (target) {
    if (!target.participants.includes(me.id)) {
      target.participants.push(me.id);
      store.set(s => s);
      cloudUpsertStudent(me).catch(() => {});
      cloudAddParticipant(target.id, me.id).catch(() => {});
    }
    go("/student/live/" + target.id);
  } else {
    alert(teacher
      ? `${teacher.name} 선생님이 현재 진행 중인 수업이 없습니다.`
      : "해당 코드의 선생님을 찾지 못했어요.\n코드를 다시 확인해 주세요.");
    go("/student");
  }
});

// Teacher dashboard
route("/teacher", () => {
  if (!store.state.whoTeacher) { go("/teacher-login"); return; }
  return teacherDashboard();
});

// Teacher dashboard tabs (live shortcut)
route("/teacher/live", () => {
  if (!store.state.whoTeacher) { go("/teacher-login"); return; }
  const cleanup = teacherDashboard();
  // simulate tab click
  setTimeout(() => {
    const btn = document.querySelector('.nav-item[data-tab="live"]');
    if (btn) btn.click();
  }, 0);
  return cleanup;
});

// Editor
route("/editor/:id", (p) => {
  if (!store.state.whoTeacher) { go("/teacher-login"); return; }
  editorView(p);
});

// Student dashboard
route("/student", () => {
  if (!store.state.whoStudent) { go("/student-login"); return; }
  return studentDashboard();
});
route("/student/live/:id", (p) => {
  if (!store.state.whoStudent) { go("/student-login"); return; }
  studentLive(p);
});

start();
