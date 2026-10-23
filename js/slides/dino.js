// 공룡 점프(dino) 게임 슬라이드 — docs/ARCHITECTURE.md §6.3(게임) · §6.4 dino
// 크롬 공룡 오마주: 캔버스 도형으로 직접 그림(외부 이미지 없음). 논리 800×240, DPR 대응, 폭에 맞춰 스케일.
// 가정: 속도 증가는 복리(기본 320px/s × 1.06^푼 문제 수).
// 가정: 무적(0.8초) 중에 닿은 선인장도 '통과'로 세지 않는다(충돌 수는 늘지 않음).
// 가정: 늦게 들어온 학생도 교사를 기다리지 않고 바로 3·2·1 후 시작. 새로고침하면 처음부터 다시(결과 제출 전).
// 가정: 문제를 다 풀기 전에 교사가 [종료]하면 결과를 제출하지 않는다(교사 리더보드에는 '미완주'로 표시).
// 가정: timeMs 는 명세대로 performance.now() - t0 (문제 푸는 시간·탭 숨김 시간 포함, 마지막 답을 고른 순간까지).
// 가정: 카운트다운이 끝나 플레이를 시작할 때도 dino:progress(answered 0)를 1회 보내 교사 화면에 '진행 중' 행을 띄운다.
// 가정: 학생 순위의 분모 = max(완주자 수, 참가자 수). 학생 리더보드는 완주자만(상위 10 + 나).
// 가정: 기록 요약(summary)은 결과가 1명뿐이면(학생 '내 기록') 순위 칸을 숨긴다.
// 가정: 결과 payload 에 run(= activity.startedAt)을 덧붙인다 → 교사 [다시]→[시작] 사이 idle 패치를 놓쳐도 이전 판 결과로 '완료' 처리하지 않음.
// 가정: 마지막 답을 고르는 즉시 제출(0.8초 피드백은 화면만) — 그 사이 [종료]돼도 결과 유지.
import { el } from "../ui.js";
import { findStudent } from "../store.js";
import { registerSlideType, newId, injectCss, fmtMs } from "./registry.js";
import { questionEditor, optionLetter } from "./common.js";

// ── 상수 ──
const W = 800, H = 240, GY = 206;       // 논리 캔버스 · 땅(발바닥) 높이
const P = 2.5;                           // 공룡 픽셀 한 칸
const DX = 56;                           // 공룡 x
const DW = 20 * P, DH = 20 * P;          // 공룡 크기(50×50)
const GRAV = 2600, JUMP_V = 840;         // px/s², px/s (최고 높이 ≈ 136px, 체공 ≈ 0.65초)
const BASE_SPEED = 320, SPEED_UP = 1.06;
const GAP_MIN = 1.1, GAP_MAX = 2.0;      // 선인장 간격(초)
const INVULN = 0.8, FEEDBACK_MS = 800;
const INK = "#535353", SOFT = "#d6d2c8";

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3h7a2 2 0 0 1 2 2v3h-5v1h3"/><path d="M12 3v9a5 5 0 0 1-5 5H6"/><path d="M16 9v3a5 5 0 0 1-5 5"/><path d="M3 9v2a6 6 0 0 0 3 5"/><path d="M8 17v4M12 17v4"/><path d="M16 12h2"/><circle cx="15" cy="5.5" r=".7" fill="currentColor"/></svg>`;

// ── 스프라이트 (# = 칠함) ──
const DINO_BODY = [
  "           ######## ",
  "          ## #######",
  "          ##########",
  "          ##########",
  "          #####     ",
  "          ########  ",
  "#        #####      ",
  "#       #######     ",
  "##     #########    ",
  "###   ###########   ",
  "##############  #   ",
  "##############      ",
  " ############       ",
  "  ##########        ",
  "   ########         ",
  "    ######          ",
];
// 다리: [열, 행, 길이]
const LEG = {
  leftLong: [[5, 16, 2], [5, 17, 2], [5, 18, 2], [5, 19, 3]],
  leftShort: [[5, 16, 2], [5, 17, 3]],
  rightLong: [[9, 16, 2], [9, 17, 2], [9, 18, 2], [9, 19, 3]],
  rightShort: [[9, 16, 2], [9, 17, 3]],
};
// 행 → [열, 행, 길이] 런
function runs(rows) {
  const out = [];
  rows.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      if (row[c] !== "#") { c++; continue; }
      let e = c;
      while (e < row.length && row[e] === "#") e++;
      out.push([c, r, e - c]);
      c = e;
    }
  });
  return out;
}
const BODY_RUNS = runs(DINO_BODY);
const FRAMES = {
  stand: [...BODY_RUNS, ...LEG.leftLong, ...LEG.rightLong],
  a: [...BODY_RUNS, ...LEG.leftLong, ...LEG.rightShort],
  b: [...BODY_RUNS, ...LEG.leftShort, ...LEG.rightLong],
};

// 선인장 3종: 위에서부터 [x, y, w, h]
const CACTI = [
  { w: 17, h: 35, r: [[6, 0, 5, 35], [0, 9, 3, 12], [0, 18, 6, 3], [14, 5, 3, 12], [11, 14, 6, 3]] },
  { w: 25, h: 50, r: [[9, 0, 7, 50], [0, 12, 4, 18], [0, 26, 9, 4], [21, 6, 4, 18], [16, 20, 9, 4]] },
  { w: 37, h: 35, r: [[6, 0, 5, 35], [0, 9, 3, 12], [0, 18, 6, 3], [14, 5, 3, 12], [11, 14, 6, 3],
    [26, 7, 5, 28], [21, 12, 3, 10], [21, 19, 5, 3], [34, 10, 3, 9], [31, 16, 5, 3]] },
];
const CLOUD = [[10, 0, 16, 3], [5, 3, 26, 3], [0, 6, 38, 4]];

// ── 월드 ──
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const rnd = (rand, a, b) => a + rand() * (b - a);

function newWorld(rand = Math.random) {
  return {
    t: 0, y: 0, vy: 0, air: false, buf: -1, legT: 0,
    obs: [], nextIn: 0.9, speed: BASE_SPEED,
    clouds: [{ x: 170, y: 44 }, { x: 460, y: 78 }, { x: 690, y: 34 }],
    pebbles: Array.from({ length: 26 }, () => ({ x: rand() * W, y: GY + 6 + rand() * 22, w: 1 + rand() * 3 })),
    invUntil: -1, hits: 0, passes: 0,
  };
}

function dinoBox(w) {
  const top = GY - DH - w.y;
  return { x0: DX + 3 * P, x1: DX + 16 * P, y0: top + 2 * P, y1: GY - w.y - P };
}
function cactusBox(o) {
  return { x0: o.x + 3, x1: o.x + o.w - 3, y0: GY - o.h + 4, y1: GY };
}
const overlap = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

function drawWorld(g, w, { moving = false } = {}) {
  g.clearRect(0, 0, W, H);
  // 구름
  g.fillStyle = SOFT;
  for (const c of w.clouds) for (const [x, y, rw, rh] of CLOUD) g.fillRect(c.x + x, c.y + y, rw, rh);
  // 땅 + 자갈
  g.fillStyle = INK;
  g.fillRect(0, GY - 2, W, 2);
  for (const p of w.pebbles) g.fillRect(p.x, p.y, p.w, 1.5);
  // 선인장
  for (const o of w.obs) {
    const top = GY - o.h;
    for (const [x, y, rw, rh] of o.v.r) g.fillRect(o.x + x, top + y, rw, rh);
  }
  // 공룡 (무적 중 깜빡임)
  const blink = w.t < w.invUntil && Math.floor(w.t * 12) % 2 === 0;
  if (blink) return;
  const frame = !moving || w.air ? FRAMES.stand : (Math.floor(w.legT * 10) % 2 ? FRAMES.a : FRAMES.b);
  const top = GY - DH - w.y;
  for (const [c, r, len] of frame) g.fillRect(DX + c * P, top + r * P, len * P, P + 0.4);
}

// ── 게임 엔진 (캔버스 + rAF 루프) ──
// onPass(passes) → true 면 이번 프레임에서 멈춤(문제), onHit(hits)
function createEngine(canvas, { auto = false, onPass, onHit } = {}) {
  const g = canvas.getContext("2d");
  let w = newWorld();
  let isAuto = !!auto, frozen = !auto;
  let raf = 0, last = 0, alive = true, scale = 1;

  function fit() {
    const cssW = canvas.clientWidth;
    if (!cssW) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const pw = Math.round(cssW * dpr), ph = Math.round((cssW * H / W) * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    scale = pw / W;
    draw();
  }
  function draw() {
    g.setTransform(scale, 0, 0, scale, 0, 0);
    drawWorld(g, w, { moving: !frozen });
  }

  function doJump() { w.vy = JUMP_V; w.air = true; w.buf = -1; }

  function step(dt) {
    w.t += dt;
    w.legT += dt;
    const sp = w.speed;
    // 미리보기: 자동 점프
    if (isAuto && !w.air) {
      const next = w.obs.find(o => o.x + o.w > DX);
      if (next) {
        const dist = next.x - (DX + DW - 6);
        if (dist > 0 && dist < sp * 0.16 + 8) doJump();
      }
    }
    // 점프 물리
    if (w.air) {
      w.vy -= GRAV * dt;
      w.y += w.vy * dt;
      if (w.y <= 0) {
        w.y = 0; w.vy = 0; w.air = false;
        if (w.buf >= w.t) doJump(); // 착지 직전 입력 버퍼
      }
    }
    // 배경
    for (const p of w.pebbles) {
      p.x -= sp * dt;
      if (p.x < -4) { p.x += W + 8; p.y = GY + 6 + Math.random() * 22; p.w = 1 + Math.random() * 3; }
    }
    for (const c of w.clouds) {
      c.x -= sp * 0.12 * dt;
      if (c.x < -50) { c.x = W + Math.random() * 120; c.y = 26 + Math.random() * 64; }
    }
    // 장애물 생성·이동
    w.nextIn -= dt;
    if (w.nextIn <= 0) {
      const v = CACTI[Math.floor(Math.random() * CACTI.length)];
      w.obs.push({ x: W + 20, w: v.w, h: v.h, v, hit: false, passed: false });
      w.nextIn = rnd(Math.random, GAP_MIN, GAP_MAX);
    }
    for (const o of w.obs) o.x -= sp * dt;
    // 충돌
    if (!isAuto) {
      const db = dinoBox(w);
      for (const o of w.obs) {
        if (o.hit || o.passed || !overlap(db, cactusBox(o))) continue;
        o.hit = true;
        if (w.t >= w.invUntil) {
          w.hits += 1;
          w.invUntil = w.t + INVULN;
          try { onHit?.(w.hits); } catch (e) { console.warn("[dino] onHit", e); }
        }
      }
    }
    // 통과
    for (const o of w.obs) {
      if (o.passed || o.x + o.w >= DX + 3 * P) continue;
      o.passed = true;
      if (isAuto || o.hit) continue;
      w.passes += 1;
      let stop = false;
      try { stop = !!onPass?.(w.passes); } catch (e) { console.warn("[dino] onPass", e); }
      if (stop) break;
    }
    w.obs = w.obs.filter(o => o.x > -60);
  }

  function frame(ts) {
    raf = 0;
    if (!alive) return;
    const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0;
    last = ts;
    if (!frozen && dt > 0) step(dt);
    draw();
    schedule();
  }
  function schedule() {
    if (!alive || raf || frozen || document.hidden) return;
    raf = requestAnimationFrame(frame);
  }
  function halt() { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; }

  // 탭 숨김 → 루프 정지
  const onVis = () => { if (document.hidden) halt(); else schedule(); };
  document.addEventListener("visibilitychange", onVis);
  let ro = null;
  if (typeof ResizeObserver === "function") { ro = new ResizeObserver(fit); ro.observe(canvas); }
  else window.addEventListener("resize", fit);

  schedule();

  return {
    get world() { return w; },
    jump() {
      if (frozen || !alive) return;
      if (!w.air) doJump();
      else w.buf = w.t + 0.12;
    },
    freeze(b) {
      frozen = !!b;
      if (frozen) { halt(); draw(); } else { last = 0; schedule(); }
    },
    reset() { w = newWorld(); draw(); },
    setAuto(b) { isAuto = !!b; },
    setSpeed(px) { w.speed = px; },
    fit,
    destroy() {
      alive = false;
      halt();
      document.removeEventListener("visibilitychange", onVis);
      if (ro) ro.disconnect(); else window.removeEventListener("resize", fit);
    },
  };
}

// 미리보기용 게임 영역(자동 점프)
function previewGame(extraClass = "") {
  const canvas = el("canvas");
  const box = el("div", { class: `dn-game is-preview ${extraClass}`.trim() }, [canvas]);
  const engine = createEngine(canvas, { auto: true });
  return { el: box, engine };
}

// ── config ──
function normQ(q) {
  const opts = (q?.options || []).slice(0, 4).map(o => ({ id: o?.id || newId("opt"), text: String(o?.text ?? "") }));
  while (opts.length < 4) opts.push({ id: newId("opt"), text: "" });
  const raw = Array.isArray(q?.answerIds) ? q.answerIds : (q?.answerId ? [q.answerId] : []);
  const answerIds = raw.filter(id => opts.some(o => o.id === id)).slice(0, 1);
  return { id: q?.id || newId("q"), question: String(q?.question ?? ""), options: opts, answerIds };
}
function cfgOf(slide) {
  const c = slide?.config || {};
  const j = Math.round(Number(c.jumpsPerQuestion));
  return {
    questions: (Array.isArray(c.questions) ? c.questions : []).map(normQ),
    jumpsPerQuestion: j >= 1 && j <= 10 ? j : 3,
  };
}
const newQuestion = () => normQ({ id: newId("q") });

// ── 결과·순위 ──
const num = (v, d = 0) => (v == null || !isFinite(+v) ? d : +v);
const cmpResult = (a, b) => (b.correct - a.correct) || (a.timeMs - b.timeMs) || (a.hits - b.hits);

// itemKey 'result' 응답 → 학생별 최신 1개 → 순위순
function results(list) {
  const m = new Map();
  for (const r of list || []) {
    if ((r.itemKey || "") !== "result") continue;
    const p = m.get(r.studentId);
    if (!p || (r.updatedAt || 0) >= (p.updatedAt || 0)) m.set(r.studentId, r);
  }
  return [...m.values()].map(r => ({
    sid: r.studentId,
    correct: num(r.payload?.correct ?? r.score),
    total: num(r.payload?.total),
    timeMs: num(r.payload?.timeMs ?? r.timeMs, Infinity),
    hits: num(r.payload?.hits),
  })).sort(cmpResult);
}

function nameOf(ctx, id) {
  let s = null;
  try { s = ctx?.students?.()?.get?.(id) || null; } catch { s = null; }
  if (!s) { try { s = findStudent(id); } catch { s = null; } }
  if (!s && ctx?.me?.id === id) s = ctx.me;
  return s?.name || "학생";
}

// 이름 조회기: ctx.students() Map 을 한 번만 만든다(행마다 만들지 않게)
function namer(ctx) {
  let m = null;
  try { m = ctx?.students?.() || null; } catch { m = null; }
  return id => m?.get?.(id)?.name || nameOf(ctx, id);
}

// onSession 은 자주 불린다 → 참여자·학생 정보가 바뀐 때만 다시 그리기 위한 비교 키
function sessionSig(ctx) {
  let n = 0;
  try { n = ctx?.students?.()?.size || 0; } catch { n = 0; }
  return `${(ctx?.participants?.() || []).join(",")}|${n}`;
}

// 리더보드 행 비교 키(같으면 DOM 을 다시 만들지 않는다)
function rowsSig(rows, name) {
  return JSON.stringify(rows.map(r => [
    r.sid, name(r.sid), r.kind, r.rank || 0, r.answered || 0, r.correct || 0, r.total || 0, r.hits || 0,
    Number.isFinite(r.timeMs) ? r.timeMs : -1,
  ]));
}

// 리더보드: rows [{kind:'done'|'live'|'dnf', rank?, sid, correct, total?, timeMs?, hits, answered?}]
function leaderboard(rows, { Q, name, meId = null, big = false, limit = 0, showRank = true } = {}) {
  if (!rows.length) return el("div", { class: "empty" }, "아직 아무도 없어요");
  const cls = `dn-lb${big ? " is-big" : ""}${showRank ? "" : " no-rank"}`;
  const head = el("div", { class: "dn-lb-row dn-lb-head" }, [
    showRank ? el("span", {}, "순위") : null,
    el("span", {}, "이름"),
    el("span", { class: "c-num" }, "정답"),
    el("span", { class: "c-num" }, "시간"),
    el("span", { class: "c-num" }, "충돌"),
  ]);
  const rowEl = (r) => {
    let time;
    if (r.kind === "done") time = fmtMs(r.timeMs);
    else if (r.kind === "live") time = el("span", { class: "pill pill-live" }, `진행 중 ${r.answered || 0}/${Q}`);
    else time = el("span", { class: "pill pill-muted" }, "미완주");
    const rk = r.kind === "done" && r.rank ? el("span", { class: `dn-badge${r.rank <= 3 ? ` r${r.rank}` : ""}` }, String(r.rank)) : el("span", { class: "dn-badge is-none" }, "–");
    return el("div", { class: `dn-lb-row is-${r.kind}${meId && r.sid === meId ? " is-me" : ""}` }, [
      showRank ? el("span", {}, [rk]) : null,
      el("span", { class: "c-name" }, name(r.sid)),
      el("span", { class: "c-num" }, `${r.correct || 0}/${r.total || Q}`),
      el("span", { class: "c-num" }, [time]),
      el("span", { class: "c-num" }, String(r.hits || 0)),
    ]);
  };
  const kids = [head];
  if (limit && rows.length > limit) {
    rows.slice(0, limit).forEach(r => kids.push(rowEl(r)));
    const mineIdx = meId ? rows.findIndex(r => r.sid === meId) : -1;
    if (mineIdx >= limit) { kids.push(el("div", { class: "dn-lb-gap" }, "⋯")); kids.push(rowEl(rows[mineIdx])); }
  } else rows.forEach(r => kids.push(rowEl(r)));
  return el("div", { class: cls }, kids);
}

function statusPill(phase) {
  if (phase === "running") return el("span", { class: "pill pill-live" }, "진행 중");
  if (phase === "ended") return el("span", { class: "pill pill-muted" }, "종료");
  return el("span", { class: "pill pill-muted" }, "대기");
}

// ── 편집기 ──
function Editor({ slide, update, ctx }) {
  css(ctx);
  const cfg = cfgOf(slide);
  const save = () => update({
    config: {
      ...slide.config,
      questions: cfg.questions.map(q => ({ ...q, options: q.options.map(o => ({ ...o })), answerIds: q.answerIds.slice() })),
      jumpsPerQuestion: cfg.jumpsPerQuestion,
    },
  });

  const preview = previewGame("is-small");

  const jumps = el("input", {
    type: "number", class: "input", min: "1", max: "10", step: "1", inputmode: "numeric",
    onInput: () => {
      const v = Math.round(Number(jumps.value));
      if (v >= 1 && v <= 10 && v !== cfg.jumpsPerQuestion) { cfg.jumpsPerQuestion = v; save(); }
    },
    onChange: () => { jumps.value = String(cfg.jumpsPerQuestion); },
  });
  jumps.value = String(cfg.jumpsPerQuestion);

  const list = el("div", { class: "dn-qlist" });
  function card(q, i) {
    const del = el("button", {
      class: "btn btn-icon btn-ghost", type: "button", title: "문제 삭제",
      onClick: async () => {
        const filled = q.question.trim() || q.options.some(o => o.text.trim());
        if (filled && !(await ctx.confirm("이 문제를 지울까요?", { ok: "삭제", danger: true }))) return;
        cfg.questions = cfg.questions.filter(x => x.id !== q.id);
        save(); renderList();
      },
    }, "×");
    const qe = questionEditor({
      question: q.question, options: q.options, answerIds: q.answerIds,
      multiple: false, minOptions: 4, maxOptions: 4, placeholder: "질문을 입력하세요",
      onChange: ({ question, options, answerIds }) => {
        const cur = cfg.questions.find(x => x.id === q.id);
        if (!cur) return;
        cur.question = question;
        cur.options = options.slice(0, 4);
        cur.answerIds = answerIds.slice(0, 1);
        save();
      },
    });
    return el("div", { class: "dn-qedit" }, [
      el("div", { class: "dn-qedit-head" }, [el("span", { class: "dn-qedit-num" }, `문제 ${i + 1}`), del]),
      qe,
    ]);
  }
  function renderList() {
    if (!cfg.questions.length) list.replaceChildren(el("div", { class: "empty" }, "아직 문제가 없어요"));
    else list.replaceChildren(...cfg.questions.map(card));
  }
  renderList();

  const addBtn = el("button", {
    class: "btn btn-sm", type: "button",
    onClick: () => {
      cfg.questions.push(newQuestion());
      save(); renderList();
      list.querySelector(".dn-qedit:last-child textarea")?.focus();
    },
  }, "+ 문제");

  const root = el("div", { class: "dn-edit" }, [
    preview.el,
    el("label", { class: "field" }, [el("span", {}, "선인장 몇 개마다 문제"), jumps]),
    list,
    el("div", {}, [addBtn]),
  ]);
  return { el: root, destroy() { preview.engine.destroy(); } };
}

// ── 학생 ──
function Student({ slide, ctx }) {
  css(ctx);
  const cfg = cfgOf(slide);
  const Q = cfg.questions.length;
  const jpq = cfg.jumpsPerQuestion;
  const meId = ctx.me?.id || null;

  let mode = "";          // wait | count | play | question | feedback | done | over
  let gen = 0, startKey = null, dead = false;
  let t0 = 0, answered = 0, correct = 0;
  let localResult = null, submitState = ""; // '' | sending | ok | fail
  let qButtons = [];
  let waitMsg = "";

  const canvas = el("canvas");
  const overlay = el("div", { class: "dn-over", hidden: true });
  const game = el("div", { class: "dn-game" }, [canvas, overlay]);
  const msg = el("div", { class: "dn-msg", hidden: true });
  const hudQ = el("span", { class: "pill" });
  const hudHit = el("span", { class: "pill" });
  const hudNext = el("span", { class: "pill pill-muted" });
  const hud = el("div", { class: "dn-hud", hidden: true }, [hudQ, hudHit, hudNext]);
  const hint = el("div", { class: "dn-hint", hidden: true }, "탭하거나 스페이스로 점프");
  const result = el("div", { class: "dn-result", hidden: true });
  const qLayer = el("div", { class: "dn-qlayer", hidden: true });
  const root = el("div", { class: "dn-stu", onPointerdown: onTap }, [msg, hud, game, hint, result, qLayer]);

  const engine = createEngine(canvas, { auto: true, onPass, onHit });
  document.addEventListener("keydown", onKey);

  // 가정: ctx.timeout(host 보조 함수, destroy 시 자동 정리)이 없으면 setTimeout. gen/dead 검사로 늦은 콜백 무시.
  const later = (fn, ms) => (typeof ctx.timeout === "function" ? ctx.timeout(fn, ms) : setTimeout(fn, ms));
  const inGame = () => mode === "count" || mode === "play" || mode === "question" || mode === "feedback";

  // 입력: 게임 영역 탭 / Space / ArrowUp
  function onTap(e) {
    if (mode !== "play") return;
    if (e.button != null && e.button > 0) return;
    if (e.target?.closest?.("button,a,input,textarea")) return;
    e.preventDefault();
    engine.jump();
  }
  function onKey(e) {
    if (!root.isConnected) return;
    if (e.target?.closest?.("input,textarea,select,[contenteditable]")) return;
    const isJump = e.code === "Space" || e.key === " " || e.key === "ArrowUp";
    if (mode === "play" && isJump) { e.preventDefault(); if (!e.repeat) engine.jump(); return; }
    if (mode === "question" && /^[1-4]$/.test(e.key)) { e.preventDefault(); qButtons[+e.key - 1]?.click(); return; }
    if (inGame() && isJump) e.preventDefault(); // 스크롤 방지
  }

  function onPass(passes) {
    paintHud();
    if (mode !== "play") return false;
    if (passes % jpq === 0 && answered < Q) { askQuestion(); return true; }
    return false;
  }
  function onHit() {
    paintHud();
    game.classList.remove("is-hit");
    void game.offsetWidth; // 애니메이션 재시작
    game.classList.add("is-hit");
    try { navigator.vibrate?.(40); } catch {}
  }

  function paintHud() {
    const w = engine.world;
    hudQ.textContent = `문제 ${answered}/${Q}`;
    hudHit.textContent = `충돌 ${w.hits}`;
    const left = jpq - (w.passes % jpq);
    hudNext.textContent = answered >= Q ? "완료" : `다음 문제까지 ${left}`;
  }

  function layout() {
    const playing = inGame();
    msg.hidden = !(mode === "wait" || mode === "over");
    msg.textContent = mode === "over" ? "게임이 끝났어요" : waitMsg;
    hud.hidden = !playing;
    game.hidden = !(playing || mode === "wait");
    game.classList.toggle("is-preview", mode === "wait");
    hint.hidden = !(mode === "play" || mode === "count");
    result.hidden = !(mode === "done" || mode === "over");
    root.classList.toggle("is-playing", playing);
    if (!game.hidden) engine.fit();
  }

  function showCount(n) {
    overlay.replaceChildren(el("div", { class: "dn-count" }, String(n)));
    overlay.hidden = false;
  }

  function closeQuestion() {
    qLayer.hidden = true;
    qLayer.replaceChildren();
    qButtons = [];
  }

  // 대기(idle): 자동 미리보기
  function toWait(text = "선생님이 시작하면 게임이 시작돼요") {
    if (mode === "wait" && waitMsg === text) return;
    gen++;
    mode = "wait"; waitMsg = text; startKey = null;
    answered = 0; correct = 0; localResult = null; submitState = "";
    overlay.hidden = true; closeQuestion();
    engine.reset(); engine.setAuto(true); engine.setSpeed(BASE_SPEED); engine.freeze(false);
    layout();
  }

  // 3·2·1 → 플레이
  function startCountdown() {
    gen++;
    const my = gen;
    mode = "count";
    answered = 0; correct = 0; localResult = null; submitState = "";
    closeQuestion();
    engine.reset(); engine.setAuto(false); engine.setSpeed(BASE_SPEED); engine.freeze(true);
    paintHud(); layout();
    let n = 3;
    showCount(n);
    const tick = () => {
      if (my !== gen || dead) return;
      n -= 1;
      if (n > 0) { showCount(n); later(tick, 1000); return; }
      overlay.hidden = true;
      t0 = performance.now();
      mode = "play";
      engine.freeze(false);
      layout();
      if (meId) ctx.send("dino:progress", { sid: meId, answered: 0, correct: 0, hits: 0 });
    };
    later(tick, 1000);
  }

  function askQuestion() {
    const q = cfg.questions[answered];
    if (!q) return;
    mode = "question";
    engine.freeze(true);
    const fb = el("div", { class: "dn-fb" });
    qButtons = q.options.map((o, i) => el("button", {
      class: "choice", type: "button", onClick: () => answer(q, o.id, fb),
    }, [el("span", { class: "choice-key" }, optionLetter(i)), el("span", { class: "choice-text" }, o.text || " ")]));
    qLayer.replaceChildren(el("div", { class: "dn-qcard" }, [
      el("div", { class: "dn-qnum" }, `문제 ${answered + 1} / ${Q}`),
      el("h2", { class: "dn-qtext" }, q.question || " "),
      el("div", { class: "dn-choices" }, qButtons),
      fb,
    ]));
    qLayer.hidden = false;
    layout();
  }

  function answer(q, id, fb) {
    if (mode !== "question") return;
    mode = "feedback";
    const ok = q.answerIds.includes(id);
    answered += 1;
    if (ok) correct += 1;
    const timeMs = answered >= Q ? Math.round(performance.now() - t0) : null;
    q.options.forEach((o, i) => {
      const b = qButtons[i];
      if (!b) return;
      b.disabled = true;
      if (o.id === id) b.classList.add("selected", ok ? "correct" : "wrong");
      if (!ok && q.answerIds.includes(o.id)) b.classList.add("correct");
    });
    fb.textContent = ok ? "정답!" : "아쉬워요";
    fb.className = `dn-fb ${ok ? "ok" : "bad"}`;
    const hits = engine.world.hits;
    if (meId) ctx.send("dino:progress", { sid: meId, answered, correct, hits });
    engine.setSpeed(BASE_SPEED * Math.pow(SPEED_UP, answered));
    paintHud();
    // 마지막 문제: 피드백 0.8초 동안 교사가 [종료]해도 결과가 남도록 즉시 제출
    if (answered >= Q) {
      localResult = { correct, total: Q, timeMs, hits, run: startKey };
      submitResult();
    }
    const my = gen;
    later(() => {
      if (my !== gen || dead) return;
      closeQuestion();
      if (answered >= Q) toDone();
      else { mode = "play"; engine.freeze(false); layout(); }
    }, FEEDBACK_MS);
  }

  async function submitResult() {
    if (!localResult) return;
    const r = localResult;
    submitState = "sending"; paintResult();
    try {
      await ctx.submit(r, { itemKey: "result", score: r.correct, correct: r.correct === r.total, timeMs: r.timeMs });
      submitState = "ok";
    } catch {
      submitState = "fail"; // ctx.submit 이 toast 처리
    }
    if (!dead && localResult === r) paintResult();
  }

  function toDone() {
    if (mode !== "done") {
      gen++;
      mode = "done";
      overlay.hidden = true; closeQuestion();
      engine.freeze(true);
      layout();
    }
    paintResult();
  }
  function toOver() {
    if (mode !== "over") {
      gen++;
      mode = "over";
      overlay.hidden = true; closeQuestion();
      engine.freeze(true);
      layout();
    }
    paintResult();
  }

  let resultSig = "", stuSessSig = "";
  function paintResult() {
    if (mode !== "done" && mode !== "over") return;
    const phase = ctx.activity()?.phase || "idle";
    const name = namer(ctx);
    let rows = results(ctx.responses());
    const kids = [];
    // 내 결과(서버본 우선, 없으면 로컬본으로 순위 추정)
    let mine = rows.find(r => r.sid === meId) || null;
    if (!mine && localResult && meId) {
      mine = { sid: meId, ...localResult };
      rows = [...rows, mine].sort(cmpResult);
    }
    if (mine) {
      const rank = rows.indexOf(mine) + 1;
      const total = Math.max(rows.length, (ctx.participants() || []).length);
      kids.push(el("div", { class: "dn-rankcard" }, [
        el("div", { class: "dn-rank" }, [el("b", {}, `${rank}위`), el("span", {}, `/ ${total}명`)]),
        el("div", { class: "dn-stats" }, [
          stat("정답", `${mine.correct}/${mine.total || Q}`),
          stat("시간", fmtMs(mine.timeMs)),
          stat("충돌", String(mine.hits)),
        ]),
        submitState === "fail"
          ? el("button", { class: "btn btn-primary", type: "button", onClick: submitResult }, "다시 제출")
          : el("div", { class: "dn-sub" }, submitState === "sending" ? "저장 중…" : (phase === "running" ? "순위가 바뀔 수 있어요" : "")),
      ]));
    }
    const ranked = rows.map((r, i) => ({ ...r, kind: "done", rank: i + 1 }));
    // 바뀐 것이 없으면 DOM 유지(onSession·onResponses 가 자주 불려도 재생성하지 않게)
    const sig = JSON.stringify([phase, submitState, Math.max(rows.length, (ctx.participants() || []).length), mine ? rows.indexOf(mine) : -1, rowsSig(ranked, name)]);
    if (sig === resultSig) return;
    resultSig = sig;
    kids.push(leaderboard(ranked, { Q, name, meId, limit: 10 }));
    result.replaceChildren(...kids);
  }

  function stat(label, value) {
    return el("div", { class: "dn-stat" }, [el("span", {}, label), el("b", {}, value)]);
  }

  // 단계 동기화
  function sync() {
    const a = ctx.activity() || { phase: "idle" };
    const key = a.startedAt || "run";
    // 이번 판의 내 결과만 인정(이전 판 응답이 아직 안 지워졌을 수 있음). run 없는 옛 응답은 인정.
    const r = ctx.myResponse?.("result") || null;
    const mine = r && (r.payload?.run == null || r.payload.run === key) ? r : null;
    const localOk = !!localResult && (localResult.run == null || localResult.run === key);
    if (a.phase === "running") {
      if (!Q) return toWait("아직 문제가 없어요");
      if (key === startKey && mode === "done") return paintResult();
      if (!inGame() && (mine || localOk)) { startKey = key; return toDone(); }
      if (key !== startKey || !inGame()) {
        startKey = key;
        return startCountdown();
      }
      return; // 진행 중 그대로
    }
    if (a.phase === "ended") {
      if (localOk || mine) return toDone();
      return toOver();
    }
    toWait();
  }
  sync();

  return {
    el: root,
    onActivity() { sync(); },
    onResponses() { if (mode === "done" || mode === "over") paintResult(); else sync(); },
    onSession() {
      if (mode !== "done" && mode !== "over") return;
      const sig = sessionSig(ctx);
      if (sig === stuSessSig) return;
      stuSessSig = sig;
      paintResult();
    },
    destroy() {
      dead = true;
      gen++;
      engine.destroy();
      document.removeEventListener("keydown", onKey);
    },
  };
}

// ── 교사 ──
function TeacherLive({ slide, ctx }) {
  css(ctx);
  const cfg = cfgOf(slide);
  const Q = cfg.questions.length;
  const progress = new Map(); // sid → {sid, answered, correct, hits}
  let phase = null, busy = false, preview = null;

  const handlers = {
    start() {
      if (!Q) { ctx.toast("문제를 먼저 만드세요"); return; }
      progress.clear();
      ctx.setActivity({ phase: "running", startedAt: (ctx.now ? ctx.now() : Date.now()), endsAt: null });
    },
    end() { ctx.setActivity({ phase: "ended", endsAt: null }); },
    async again() {
      if (busy) return;
      const has = ctx.responses().length > 0 || progress.size > 0;
      if (has && !(await ctx.confirm("결과를 지우고 처음으로 돌릴까요?", { ok: "다시", danger: true }))) return;
      busy = true;
      try { await ctx.clearResponses(); }
      catch (e) { console.warn("[dino] clearResponses", e); busy = false; return; } // host 가 toast
      busy = false;
      progress.clear();
      ctx.setActivity({ phase: "idle", startedAt: null, endsAt: null });
    },
  };
  const ctlHead = controls(handlers);
  const ctlPanel = controls(handlers);

  const pillBox = el("span", { class: "dn-pillbox" });
  const countP = el("span", { class: "pill" });
  const body = el("div", { class: "dn-live-body" });
  const root = el("div", { class: "dn-live" }, [
    el("div", { class: "dn-live-head" }, [
      el("h2", {}, slide.title || "공룡 점프"), pillBox, countP, el("span", { class: "dn-spacer" }), ctlHead,
    ]),
    body,
  ]);

  const kvDone = el("b");
  const panel = el("div", { class: "dn-panel" }, [
    ctlPanel,
    el("div", {}, [
      kv("문제", el("b", {}, `${Q}개`)),
      kv("문제 간격", el("b", {}, `선인장 ${cfg.jumpsPerQuestion}개`)),
      kv("완주", kvDone),
    ]),
  ]);

  // 실시간 진행
  ctx.on("dino:progress", (p) => {
    if (!p || !p.sid) return;
    if ((ctx.activity()?.phase || "idle") === "idle") return;
    progress.set(p.sid, { sid: p.sid, answered: num(p.answered), correct: num(p.correct), hits: num(p.hits) });
    paintBoard();
  });

  function boardRows() {
    const done = results(ctx.responses());
    const ids = new Set(done.map(r => r.sid));
    const rows = done.map((r, i) => ({ ...r, kind: "done", rank: i + 1 }));
    const live = [...progress.values()].filter(p => !ids.has(p.sid))
      .sort((a, b) => (b.answered - a.answered) || (b.correct - a.correct) || (a.hits - b.hits));
    for (const p of live) rows.push({ ...p, kind: phase === "ended" ? "dnf" : "live" });
    return { rows, doneN: done.length };
  }

  let boardSig = "", sessSig = "";
  function paintBoard(force = false) {
    const { rows, doneN } = boardRows();
    const m = Math.max((ctx.participants() || []).length, doneN);
    const ct = `완주 ${doneN}/${m}`, kt = `${doneN}/${m}명`;
    if (countP.textContent !== ct) countP.textContent = ct;
    if (kvDone.textContent !== kt) kvDone.textContent = kt;
    if (phase === "idle") { boardSig = ""; return; }
    const name = namer(ctx);
    const sig = rowsSig(rows, name);
    if (!force && sig === boardSig) return; // 바뀐 것이 없으면 DOM 유지
    boardSig = sig;
    body.replaceChildren(leaderboard(rows, { Q, name, big: true }));
  }

  function paint() {
    const ph = ctx.activity()?.phase || "idle";
    const changed = ph !== phase;
    if (changed) {
      phase = ph;
      pillBox.replaceChildren(statusPill(ph));
      ctlHead.update(ph); ctlPanel.update(ph);
      if (preview) { preview.engine.destroy(); preview = null; }
      if (ph === "idle") {
        progress.clear();
        preview = previewGame();
        body.replaceChildren(
          preview.el,
          el("div", { class: "dn-info" }, Q ? `문제 ${Q}개 · 선인장 ${cfg.jumpsPerQuestion}개마다 문제` : "아직 문제가 없어요"),
        );
      }
    }
    paintBoard(changed);
  }
  paint();

  return {
    el: root,
    panel,
    onActivity() { paint(); },
    onResponses() { paintBoard(); },
    onSession() {
      const sig = sessionSig(ctx);
      if (sig === sessSig) return;
      sessSig = sig;
      paintBoard();
    },
    destroy() { if (preview) preview.engine.destroy(); preview = null; },
  };
}

function controls(h) {
  const bStart = el("button", { class: "btn btn-primary", type: "button", onClick: () => h.start() }, "시작");
  const bEnd = el("button", { class: "btn btn-dark", type: "button", onClick: () => h.end() }, "종료");
  const bAgain = el("button", { class: "btn btn-ghost", type: "button", onClick: () => h.again() }, "다시");
  const root = el("div", { class: "dn-ctl" }, [bStart, bEnd, bAgain]);
  root.update = (ph) => {
    bStart.hidden = ph !== "idle";
    bEnd.hidden = ph !== "running";
    bAgain.hidden = ph === "idle";
  };
  return root;
}

function kv(label, valueEl) {
  return el("div", { class: "dn-kv" }, [el("span", {}, label), valueEl]);
}

// ── 기록 요약 ──
function summary(slide, responses = [], session, ctx) {
  css(ctx);
  const cfg = cfgOf(slide);
  const Q = cfg.questions.length;
  const rows = results(responses).map((r, i) => ({ ...r, kind: "done", rank: i + 1 }));
  return el("div", { class: "dn-sum" }, [
    el("div", { class: "dn-sum-meta" }, [
      el("span", { class: "pill pill-muted" }, `문제 ${Q}개`),
      el("span", { class: "pill pill-muted" }, `완주 ${rows.length}명`),
    ]),
    rows.length
      ? leaderboard(rows, { Q, name: id => nameOf(ctx, id), showRank: rows.length > 1 })
      : el("div", { class: "empty" }, "기록이 없어요"),
  ]);
}

// ── 썸네일: 정지 장면 ──
function thumb(slide) {
  css(null);
  const c = el("canvas", { class: "dn-thumb-canvas", width: "400", height: "120" });
  const g = c.getContext("2d");
  if (g) {
    const w = newWorld(seeded(7));
    w.y = 34; w.air = true;
    w.obs = [{ x: 300, ...pick(1) }, { x: 560, ...pick(0) }];
    g.setTransform(0.5, 0, 0, 0.5, 0, 0);
    drawWorld(g, w);
  }
  return el("div", { class: "dn-thumb" }, [c, el("span", { class: "thumb-title" }, slide.title || "공룡 점프")]);
}
function pick(i) { const v = CACTI[i]; return { w: v.w, h: v.h, v, hit: false, passed: false }; }

// ── CSS ──
function css(ctx) { (ctx?.injectCss || injectCss)("dino", CSS); }

const CSS = `
.dn-stu [hidden], .dn-live [hidden], .dn-panel [hidden], .dn-edit [hidden] { display: none !important; }
.dn-stu { position: relative; height: 100%; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 16px 16px calc(20px + env(safe-area-inset-bottom)); max-width: 980px; margin: 0 auto; width: 100%; box-sizing: border-box; }
.dn-stu.is-playing { touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; cursor: pointer; }
.dn-msg { font-size: 18px; font-weight: 600; text-align: center; padding: 8px 0; }
.dn-hud { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.dn-hud .pill { font-variant-numeric: tabular-nums; }
.dn-game { position: relative; width: 100%; aspect-ratio: 800 / 240; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; flex: none; box-sizing: border-box; }
.dn-game canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.dn-game.is-preview { opacity: .8; }
.dn-game.is-small { max-width: 520px; }
.dn-game.is-hit { animation: dn-hit .4s ease; }
@keyframes dn-hit { 0% { box-shadow: inset 0 0 0 3px var(--danger); } 100% { box-shadow: inset 0 0 0 0 transparent; } }
.dn-over { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(247, 246, 242, .55); pointer-events: none; }
.dn-count { font-size: clamp(44px, 12vw, 96px); font-weight: 800; color: var(--ink); animation: dn-pop .9s ease both; font-variant-numeric: tabular-nums; }
@keyframes dn-pop { 0% { transform: scale(.6); opacity: 0; } 25% { transform: scale(1.06); opacity: 1; } 100% { transform: scale(1); opacity: .9; } }
.dn-hint { font-size: 13px; color: var(--muted); text-align: center; }
.dn-qlayer { position: absolute; inset: 0; z-index: 5; display: grid; place-items: center; padding: 16px; background: rgba(247, 246, 242, .9); overflow: auto; touch-action: manipulation; }
.dn-qcard { width: 100%; max-width: 640px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow-2); padding: 20px; display: flex; flex-direction: column; gap: 14px; box-sizing: border-box; }
.dn-qnum { font-size: 13px; color: var(--muted); font-weight: 600; }
.dn-qtext { margin: 0; font-size: 21px; line-height: 1.45; font-weight: 700; white-space: pre-wrap; word-break: keep-all; overflow-wrap: anywhere; }
.dn-choices { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 560px) { .dn-choices { grid-template-columns: 1fr; } }
.dn-qcard .choice { min-height: 56px; width: 100%; text-align: left; display: flex; align-items: center; gap: 12px; font-size: 17px; padding: 10px 14px; cursor: pointer; box-sizing: border-box; }
.dn-qcard .choice:disabled { cursor: default; }
:where(.dn-qcard .choice) { background: var(--surface); border: 1.5px solid var(--line-strong); border-radius: var(--radius-sm); color: var(--ink); font: inherit; }
:where(.dn-qcard .choice.correct) { border-color: var(--ok); background: var(--ok-soft); }
:where(.dn-qcard .choice.wrong) { border-color: var(--danger); background: var(--danger-soft); }
:where(.dn-qcard .choice-key) { width: 28px; height: 28px; border-radius: 50%; border: 1.5px solid var(--line-strong); display: inline-grid; place-items: center; font-weight: 700; font-size: 13px; flex: none; }
.dn-fb { min-height: 24px; font-weight: 700; text-align: center; font-size: 17px; }
.dn-fb.ok { color: var(--ok); }
.dn-fb.bad { color: var(--danger); }
.dn-result { display: flex; flex-direction: column; gap: 16px; }
.dn-rankcard { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 24px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow-1); }
.dn-rank { font-size: 16px; color: var(--muted); display: flex; align-items: baseline; gap: 6px; }
.dn-rank b { font-size: 48px; color: var(--ink); font-weight: 800; font-variant-numeric: tabular-nums; }
.dn-stats { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.dn-stat { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 84px; padding: 8px 12px; background: var(--surface-2); border-radius: var(--radius-sm); }
.dn-stat span { font-size: 12px; color: var(--muted); }
.dn-stat b { font-size: 20px; font-variant-numeric: tabular-nums; }
.dn-sub { font-size: 13px; color: var(--muted); min-height: 18px; }
.dn-lb { display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.dn-lb-row { display: grid; grid-template-columns: 48px minmax(0, 1fr) 64px 112px 52px; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); font-variant-numeric: tabular-nums; }
.dn-lb.no-rank .dn-lb-row { grid-template-columns: minmax(0, 1fr) 64px 112px 52px; }
.dn-lb-row:first-child { border-top: 0; }
.dn-lb-head { font-size: 12px; color: var(--muted); background: var(--surface-2); padding-top: 8px; padding-bottom: 8px; }
.dn-lb-row .c-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.dn-lb-row .c-num { text-align: right; white-space: nowrap; }
.dn-lb-row.is-me { background: var(--accent-soft); }
.dn-lb-row.is-live .c-name, .dn-lb-row.is-dnf .c-name { color: var(--ink-2); font-weight: 500; }
.dn-badge { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: var(--surface-2); font-weight: 700; font-size: 14px; }
.dn-badge.r1 { background: var(--highlight); }
.dn-badge.r2 { background: #e5e7eb; }
.dn-badge.r3 { background: #f3dcc4; }
.dn-badge.is-none { background: transparent; color: var(--muted); }
.dn-lb-gap { padding: 2px 14px; color: var(--muted); text-align: center; border-top: 1px solid var(--line); }
.dn-lb.is-big .dn-lb-row { font-size: 20px; padding: 14px 20px; grid-template-columns: 60px minmax(0, 1fr) 96px 168px 76px; }
.dn-lb.is-big .dn-lb-head { font-size: 13px; padding-top: 10px; padding-bottom: 10px; }
.dn-lb.is-big .dn-badge { width: 40px; height: 40px; font-size: 17px; }
@media (max-width: 480px) {
  .dn-lb-row, .dn-lb.is-big .dn-lb-row { grid-template-columns: 36px minmax(0, 1fr) 46px 84px 36px; padding: 10px; gap: 6px; font-size: 14px; }
  .dn-lb.no-rank .dn-lb-row { grid-template-columns: minmax(0, 1fr) 46px 84px 36px; }
  .dn-lb-row .pill { font-size: 11px; }
}
.dn-live { height: 100%; overflow: auto; padding: 24px 32px; display: flex; flex-direction: column; gap: 18px; box-sizing: border-box; }
.dn-live-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dn-live-head h2 { margin: 0; font-size: 24px; font-weight: 700; }
.dn-pillbox { display: inline-flex; }
.dn-spacer { flex: 1; }
.dn-ctl { display: flex; gap: 8px; }
.dn-live-body { display: flex; flex-direction: column; gap: 14px; }
.dn-live .dn-game { max-width: 880px; margin: 0 auto; }
.dn-info { color: var(--muted); text-align: center; font-size: 15px; }
.dn-panel { display: grid; gap: 14px; }
.dn-kv { display: flex; justify-content: space-between; gap: 8px; padding: 8px 2px; border-bottom: 1px solid var(--line); font-size: 14px; }
.dn-kv span { color: var(--muted); }
.dn-edit { padding: 24px; display: grid; gap: 14px; max-width: 760px; margin: 0 auto; width: 100%; box-sizing: border-box; overflow: auto; height: 100%; align-content: start; }
.dn-qlist { display: grid; gap: 12px; }
.dn-qedit { display: flex; flex-direction: column; gap: 10px; padding: 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.dn-qedit-head { display: flex; align-items: center; justify-content: space-between; }
.dn-qedit-num { font-weight: 700; font-size: 14px; color: var(--ink-2); }
.dn-qedit .q-editor > div:last-child { display: none; }
.dn-qedit .q-opt .btn-icon { display: none; }
.dn-qedit .q-editor textarea { font-size: 17px; font-weight: 600; min-height: 64px; resize: vertical; }
.dn-sum { display: grid; gap: 12px; }
.dn-sum-meta { display: flex; gap: 6px; flex-wrap: wrap; }
.dn-thumb { display: flex; flex-direction: column; justify-content: center; gap: 4px; width: 100%; height: 100%; padding: 6px; box-sizing: border-box; background: var(--surface); overflow: hidden; }
.dn-thumb-canvas { width: 100%; height: auto; display: block; }
.dn-thumb .thumb-title { font-size: 12px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

registerSlideType({
  type: "dino",
  category: "game",
  label: "공룡 점프",
  desc: "선인장을 넘으며 문제 풀기",
  icon: ICON,
  create() { return { type: "dino", config: { questions: [], jumpsPerQuestion: 3 } }; },
  thumb,
  Editor,
  Student,
  TeacherLive,
  summary,
  validate(slide) {
    const c = cfgOf(slide);
    if (!c.questions.length) return "문제를 1개 이상 만드세요";
    if (c.questions.some(q => !q.question.trim())) return "질문을 입력하세요";
    if (c.questions.some(q => q.options.some(o => !o.text.trim()))) return "빈 선택지가 있어요";
    if (c.questions.some(q => !q.answerIds.length)) return "정답을 선택하세요";
    return null;
  },
});
