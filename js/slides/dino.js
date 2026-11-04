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
// 가정(v2.11): 효과음(js/slides/game-sound.js) — 학생: 배경음악(플레이 중)·카운트다운·점프·충돌·정답·오답·완주 팡파르,
//       교사: 진행 중 배경음악 + 완주할 때마다 짧은 소리. 🔊 버튼으로 기기마다 음소거.
// 가정(v2.14): 문제마다 제한 시간 q.sec(10~120초, 기본 20초) — 넘기면 '시간 초과'(오답). 순위는 그대로 정답 수가 먼저.
//       오답이면 다시 달리기 시작한 뒤(지나온 선인장이 비켜날 0.25초 뒤, 땅에 있을 때) 공룡이 뒤로 미끄러진다:
//       세상이 멈춘 채 0.35초 동안 뒤로 64px 밀리고 0.5초 어질어질(점프 불가) → 1.1초에 걸쳐 제자리로.
// 가정(v2.16): 목표 정답률(config.passPct, 기본 80%, 0 = 없음). Q문제를 다 푼 뒤 맞힌 문제가 목표(올림)보다 적으면 계속 달리며
//       아직 못 맞힌 문제만 다시(선인장 jumpsPerQuestion 개마다) — 목표에 닿을 때까지 되풀이(안전장치 MAX_ROUNDS).
//       다시 풀 문제가 있으면 틀려도 정답을 보여 주지 않는다. 틀렸을 때(config.holdWrong, 기본 켬) 그 문제 제한 시간이 끝날 때까지
//       문제 창이 남아 있다('다시 나올 때를 위해 찾아 두세요'). 순위의 정답 = 처음에 맞힌 문제 수(correct), 다시 풀어 맞힌 수는 solved.
//       콤보: 연속 정답 2·3·4개부터 달리기 속도 ×1.1·1.2·1.3(틀리면 끊김). 선인장 간격은 거리 기준이라 빨라지면 다음 문제도 빨리 온다.
//       결과·끝난 뒤 'log' 응답·dino:progress 에 답 기록 [qi, opt, ok] → 교사 문제 리뷰(common.gameReview).
import { el } from "../ui.js";
import { findStudent } from "../store.js";
import { registerSlideType, newId, injectCss, fmtMs } from "./registry.js";
import { questionEditor, optionLetter, questionImage, gameReview } from "./common.js";
import * as sound from "./game-sound.js";

// ── 상수 ──
const W = 800, H = 240, GY = 206;       // 논리 캔버스 · 땅(발바닥) 높이
const P = 2.5;                           // 공룡 픽셀 한 칸
const DX = 56;                           // 공룡 x
const DW = 20 * P, DH = 20 * P;          // 공룡 크기(50×50)
const GRAV = 2600, JUMP_V = 840;         // px/s², px/s (최고 높이 ≈ 136px, 체공 ≈ 0.65초)
const BASE_SPEED = 320, SPEED_UP = 1.06;
const GAP_MIN = 1.1, GAP_MAX = 2.0;      // 선인장 간격(초)
const INVULN = 0.8, FEEDBACK_MS = 800;
const QUIZ_SECS = [10, 15, 20, 30, 45, 60, 90, 120], QUIZ_SEC = 20; // 문제 제한(초) 고를 수 있는 값 · 기본
const PASS_PCTS = [0, 60, 70, 80, 90, 100], PASS_PCT = 80; // 목표 정답률(%) — 못 미치면 틀린 문제를 다시 풀며 계속
const MAX_ROUNDS = 6;                    // 다시 풀기 라운드 안전장치
const COMBO_MAX = 3, COMBO_SPEED = 0.1;  // 연속 정답 2개부터 단계마다 +10% (3단계까지)
const MAX_SPEED = BASE_SPEED * 2.2;
const SLIP_WAIT = 0.25, SLIP_SLIDE = 0.35, SLIP_HOLD = 0.5, SLIP_BACK = 1.1, SLIP_PX = 64; // 오답 미끄러짐(초 · px)
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
    slipPend: -1, slipAt: -1, // 오답 미끄러짐: 예약 시각 · 시작 시각(w.t)
  };
}

// 미끄러짐 진행(초) · 세상이 멈춘 동안인지 · 공룡 x 어긋남(px, 뒤로 = 음수)
const slipS = w => (w.slipAt >= 0 ? w.t - w.slipAt : Infinity);
const slipStopped = w => slipS(w) < SLIP_SLIDE + SLIP_HOLD;
function slipX(w) {
  const s = slipS(w);
  if (s < SLIP_SLIDE) { const f = s / SLIP_SLIDE; return -SLIP_PX * (1 - (1 - f) ** 2); }
  if (s < SLIP_SLIDE + SLIP_HOLD) return -SLIP_PX;
  if (s < SLIP_SLIDE + SLIP_HOLD + SLIP_BACK) { const f = (s - SLIP_SLIDE - SLIP_HOLD) / SLIP_BACK; return -SLIP_PX * (1 - f * f * (3 - 2 * f)); }
  return 0;
}

function dinoBox(w) {
  const top = GY - DH - w.y, x = DX + slipX(w);
  return { x0: x + 3 * P, x1: x + 16 * P, y0: top + 2 * P, y1: GY - w.y - P };
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
  // 미끄러짐: 발밑 흙먼지 · 어질어질 별
  const x = DX + slipX(w), s = slipS(w), stopped = slipStopped(w);
  if (s < SLIP_SLIDE + 0.3) {
    const a = 1 - s / (SLIP_SLIDE + 0.3);
    g.fillStyle = `rgba(140,130,115,${(0.6 * a).toFixed(3)})`;
    for (let i = 0; i < 5; i++) g.fillRect(x + 30 + i * 7 + s * 30 * i, GY - 4 - (i % 3) * 3 - s * 14, 4, 3);
  }
  if (stopped && s >= SLIP_SLIDE * 0.6) {
    g.fillStyle = INK;
    for (let i = 0; i < 2; i++) {
      const ang = s * 9 + i * Math.PI;
      const sx = x + 40 + Math.cos(ang) * 14, sy = GY - DH - w.y - 8 + Math.sin(ang) * 4;
      g.fillRect(sx - 3, sy - 0.75, 6, 1.5); g.fillRect(sx - 0.75, sy - 3, 1.5, 6);
    }
  }
  // 공룡 (무적 중 깜빡임)
  const blink = w.t < w.invUntil && Math.floor(w.t * 12) % 2 === 0;
  if (blink) return;
  const frame = !moving || w.air || stopped ? FRAMES.stand : (Math.floor(w.legT * 10) % 2 ? FRAMES.a : FRAMES.b);
  const top = GY - DH - w.y;
  for (const [c, r, len] of frame) g.fillRect(x + c * P, top + r * P, len * P, P + 0.4);
}

// ── 게임 엔진 (캔버스 + rAF 루프) ──
// onPass(passes) → true 면 이번 프레임에서 멈춤(문제), onHit(hits)
function createEngine(canvas, { auto = false, onPass, onHit, onJump } = {}) {
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

  function doJump() { w.vy = JUMP_V; w.air = true; w.buf = -1; try { onJump?.(); } catch (_) {} }

  function step(dt) {
    w.t += dt;
    // 오답 미끄러짐: 예약 시각이 지나고 땅에 있으면 시작. 미끄러지고 어지러운 동안은 세상이 멈춘다
    if (w.slipPend >= 0 && w.t >= w.slipPend && !w.air) { w.slipAt = w.t; w.slipPend = -1; }
    const stopped = slipStopped(w);
    if (!stopped) w.legT += dt;
    const sp = stopped ? 0 : w.speed;
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
    if (!stopped) w.nextIn -= dt;
    if (w.nextIn <= 0) {
      const v = CACTI[Math.floor(Math.random() * CACTI.length)];
      w.obs.push({ x: W + 20, w: v.w, h: v.h, v, hit: false, passed: false });
      // 거리 기준 간격: 빨라지면 다음 선인장(과 다음 문제)도 빨리 온다. 너무 붙지 않게 0.7초 이하로는 줄이지 않음
      w.nextIn = Math.max(0.7, rnd(Math.random, GAP_MIN, GAP_MAX) * (BASE_SPEED / Math.max(BASE_SPEED, w.speed)));
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
    const bx = DX + slipX(w) + 3 * P;
    for (const o of w.obs) {
      if (o.passed || o.x + o.w >= bx) continue;
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
      if (frozen || !alive || slipStopped(w)) return;
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
    slip() { w.slipPend = w.t + SLIP_WAIT; },
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
  const sec = QUIZ_SECS.includes(Number(q?.sec)) ? Number(q.sec) : QUIZ_SEC;
  return { id: q?.id || newId("q"), question: String(q?.question ?? ""), options: opts, answerIds, image: q?.image && q.image.url ? q.image : null, sec };
}
function cfgOf(slide) {
  const c = slide?.config || {};
  const j = Math.round(Number(c.jumpsPerQuestion));
  const questions = (Array.isArray(c.questions) ? c.questions : []).map(normQ);
  const passPct = PASS_PCTS.includes(Number(c.passPct)) ? Number(c.passPct) : PASS_PCT;
  return {
    questions,
    jumpsPerQuestion: j >= 1 && j <= 10 ? j : 3,
    passPct, holdWrong: c.holdWrong !== false,
    need: passPct ? Math.min(questions.length, Math.ceil((questions.length * passPct) / 100 - 1e-9)) : 0, // 목표 정답 수(올림)
  };
}
const newQuestion = (sec = QUIZ_SEC) => normQ({ id: newId("q"), sec });
// '문제마다 20초' · 문제마다 다르면 '문제마다 10~30초'
function secText(questions) {
  const s = questions.map(q => q.sec);
  const lo = s.length ? Math.min(...s) : QUIZ_SEC, hi = s.length ? Math.max(...s) : QUIZ_SEC;
  return lo === hi ? `문제마다 ${lo}초` : `문제마다 ${lo}~${hi}초`;
}

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
    solved: num(r.payload?.solved ?? r.payload?.correct ?? r.score), // v2.15 까지는 다시 풀기가 없어 correct 와 같음
    rounds: num(r.payload?.rounds),
  })).sort(cmpResult);
}
// 리뷰용 답 기록: 학생 id → [[qi, opt, ok], …]. 결과 응답의 log → 끝난 뒤 'log' 응답 → (교사 화면) 진행 이벤트로 모은 기록
function dinoLogs(list, live = null) {
  const m = new Map();
  for (const key of ["result", "log"]) {
    for (const r of list || []) {
      if ((r.itemKey || "") !== key || m.has(r.studentId)) continue;
      if (Array.isArray(r.payload?.log)) m.set(r.studentId, r.payload.log);
    }
  }
  if (live) for (const [sid, p] of live) if (!m.has(sid) && p.log?.length) m.set(sid, p.log);
  return m;
}
const reviewQs = cfg => cfg.questions.map(q => ({ id: q.id, question: q.question, image: q.image, options: q.options, answerId: q.answerIds[0] || null }));
const comboMul = s => 1 + COMBO_SPEED * Math.min(COMBO_MAX, Math.max(0, s - 1));

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
    r.sid, name(r.sid), r.kind, r.rank || 0, r.answered || 0, r.correct || 0, r.total || 0, r.hits || 0, r.solved || 0, r.round || 0, r.tried || 0,
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
    el("span", { class: "c-num c-acc" }, "정답"),
    el("span", { class: "c-num" }, "시간"),
    el("span", { class: "c-num" }, "충돌"),
  ]);
  // 정답 칸: 큰 '맞힌 수/문제 수' + 정답률(푼 문제 중, 80% 이상 초록 · 50% 이상 주황 · 그 아래 빨강)
  const accEl = (r) => {
    const n = r.total || Q, c = r.correct || 0;
    const done = r.kind === "done" ? n : (r.tried ?? r.answered ?? 0); // 완주 = 모두 풂. 정답·정답률 = 처음에 맞힌 것
    if (!done) return el("span", { class: "dn-acc is-none" }, [el("b", {}, `0/${n}`)]);
    const pct = Math.round((c / done) * 100);
    const re = (r.solved || 0) > c || r.rounds || r.round;
    return el("span", { class: "dn-acc", title: `처음 푼 문제 ${done}개 중 ${c}개 정답` }, [
      el("b", {}, `${c}/${n}`),
      el("span", { class: `pill ${pct >= 80 ? "pill-ok" : pct >= 50 ? "pill-warn" : "pill-danger"}` }, `${pct}%`),
      re ? el("span", { class: "dn-retry", title: "틀린 문제를 다시 풀어 맞힌 수" }, `↻ ${r.solved || 0}/${n}`) : null,
    ]);
  };
  const rowEl = (r) => {
    let time;
    if (r.kind === "done") time = fmtMs(r.timeMs);
    else if (r.kind === "live") time = el("span", { class: "pill pill-live" }, r.round ? `다시 풀기 ${r.round}회차` : `진행 중 ${Math.min(Q, r.tried ?? r.answered ?? 0)}/${Q}`);
    else time = el("span", { class: "pill pill-muted" }, "미완주");
    const rk = r.kind === "done" && r.rank ? el("span", { class: `dn-badge${r.rank <= 3 ? ` r${r.rank}` : ""}` }, String(r.rank)) : el("span", { class: "dn-badge is-none" }, "–");
    return el("div", { class: `dn-lb-row is-${r.kind}${meId && r.sid === meId ? " is-me" : ""}` }, [
      showRank ? el("span", {}, [rk]) : null,
      el("span", { class: "c-name" }, name(r.sid)),
      el("span", { class: "c-num c-acc" }, [accEl(r)]),
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
function Editor({ slide, lesson, update, ctx }) {
  css(ctx);
  const cfg = cfgOf(slide);
  const save = () => update({
    config: {
      ...slide.config,
      questions: cfg.questions.map(q => ({ ...q, options: q.options.map(o => ({ ...o })), answerIds: q.answerIds.slice() })),
      jumpsPerQuestion: cfg.jumpsPerQuestion,
      passPct: cfg.passPct,
      holdWrong: cfg.holdWrong,
    },
  });
  // 간단한 고르기 칸(누르면 바로 저장)
  const segOf = (options, value, onPick) => {
    const root = el("div", { class: "seg" });
    const paintS = v => [...root.children].forEach((b, i) => b.classList.toggle("active", options[i].value === v));
    options.forEach(o => root.appendChild(el("button", { type: "button", onClick: () => { paintS(o.value); onPick(o.value); } }, o.label)));
    paintS(value);
    return root;
  };
  const passSeg = segOf(PASS_PCTS.map(v => ({ value: v, label: v ? `${v}%` : "없음" })), cfg.passPct, v => { cfg.passPct = v; save(); });
  const holdSeg = segOf([{ value: true, label: "남은 시간 멈춤" }, { value: false, label: "바로 달리기" }], cfg.holdWrong, v => { cfg.holdWrong = v; save(); });

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

  // 문제 푸는 시간: 위 칸 = 모든 문제에 한 번에(모두 같을 때만 켜짐), 문제 칸마다 따로
  const sameSec = () => (cfg.questions.length && cfg.questions.every(q => q.sec === cfg.questions[0].sec) ? cfg.questions[0].sec : null);
  const secSels = new Map(); // q.id → select
  const timeSeg = el("div", { class: "seg" }, QUIZ_SECS.map(v => el("button", {
    type: "button", "data-sec": String(v),
    onClick: () => {
      for (const q of cfg.questions) { q.sec = v; const s = secSels.get(q.id); if (s) s.value = String(v); }
      paintSeg(); save();
    },
  }, `${v}초`)));
  const paintSeg = () => { const v = sameSec(); for (const b of timeSeg.children) b.classList.toggle("active", Number(b.dataset.sec) === v); };

  const list = el("div", { class: "dn-qlist" });
  function card(q, i) {
    const sel = el("select", {
      class: "input input-sm dn-qsec", title: "이 문제 푸는 시간", "aria-label": `문제 ${i + 1} 푸는 시간`,
      onChange: () => {
        const cur = cfg.questions.find(x => x.id === q.id);
        if (!cur) return;
        cur.sec = QUIZ_SECS.includes(Number(sel.value)) ? Number(sel.value) : QUIZ_SEC;
        paintSeg(); save();
      },
    }, QUIZ_SECS.map(v => el("option", { value: String(v) }, `⏱ ${v}초`)));
    sel.value = String(q.sec);
    secSels.set(q.id, sel);
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
      image: q.image, imageAt: { lessonId: lesson?.id, slideId: slide.id },
      onChange: ({ question, options, answerIds, image }) => {
        const cur = cfg.questions.find(x => x.id === q.id);
        if (!cur) return;
        cur.question = question;
        cur.options = options.slice(0, 4);
        cur.answerIds = answerIds.slice(0, 1);
        cur.image = image || null;
        save();
      },
    });
    return el("div", { class: "dn-qedit" }, [
      el("div", { class: "dn-qedit-head" }, [el("span", { class: "dn-qedit-num" }, `문제 ${i + 1}`), el("span", { class: "dn-spacer" }), sel, del]),
      qe,
    ]);
  }
  function renderList() {
    secSels.clear();
    paintSeg();
    if (!cfg.questions.length) list.replaceChildren(el("div", { class: "empty" }, "아직 문제가 없어요"));
    else list.replaceChildren(...cfg.questions.map(card));
  }
  renderList();

  const addBtn = el("button", {
    class: "btn btn-sm", type: "button",
    onClick: () => {
      cfg.questions.push(newQuestion(cfg.questions[cfg.questions.length - 1]?.sec ?? QUIZ_SEC)); // 바로 앞 문제 시간을 이어받음
      save(); renderList();
      list.querySelector(".dn-qedit:last-child textarea")?.focus();
    },
  }, "+ 문제");

  const root = el("div", { class: "dn-edit" }, [
    preview.el,
    el("label", { class: "field" }, [el("span", {}, "선인장 몇 개마다 문제"), jumps]),
    el("div", { class: "field" }, [
      el("span", {}, "문제 푸는 시간"), timeSeg,
      el("div", { class: "hint" }, "여기서 고르면 모든 문제에 적용돼요 · 문제마다 ⏱에서 따로 바꿀 수 있어요"),
    ]),
    el("div", { class: "field" }, [
      el("span", {}, "목표 정답률"), passSeg,
      el("div", { class: "hint" }, "문제를 다 푼 뒤 이만큼 맞히지 못하면, 계속 달리며 틀린 문제를 다시 풀어요(목표에 닿을 때까지)"),
    ]),
    el("div", { class: "field" }, [
      el("span", {}, "틀렸을 때"), holdSeg,
      el("div", { class: "hint" }, "남은 시간 멈춤 = 그 문제 시간이 끝날 때까지 기다렸다 달려요. 빨리 찍어서 틀리면 손해예요"),
    ]),
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
  const jpq = cfg.jumpsPerQuestion, need = cfg.need, retry = need > 0;
  const meId = ctx.me?.id || null;

  let mode = "";          // wait | count | play | question | feedback | hold | done | over
  let gen = 0, startKey = null, dead = false;
  // 판 상태: queue = 남은 문제 차례(문제 번호), round = 다시 풀기 회차(0 = 처음), log = 답 기록 [qi, opt, ok]
  let t0 = 0, attempts = 0, firstOk = 0, streak = 0, round = 0, roundTotal = Q, roundDone = 0;
  let queue = [], solved = new Set(), tried = new Set(), log = [];
  let localResult = null, submitState = "", logSent = false; // submitState: '' | sending | ok | fail
  let qButtons = [];
  let waitMsg = "";
  function resetRun() {
    attempts = 0; firstOk = 0; streak = 0; round = 0; roundTotal = Q; roundDone = 0;
    queue = cfg.questions.map((_, i) => i); solved = new Set(); tried = new Set(); log = [];
    localResult = null; submitState = ""; logSent = false;
  }
  const speedNow = () => Math.min(MAX_SPEED, BASE_SPEED * Math.pow(SPEED_UP, Math.min(attempts, Q)) * comboMul(streak));

  const canvas = el("canvas");
  const overlay = el("div", { class: "dn-over", hidden: true });
  const game = el("div", { class: "dn-game" }, [canvas, overlay]);
  const msg = el("div", { class: "dn-msg", hidden: true });
  const hudQ = el("span", { class: "pill" });
  const hudHit = el("span", { class: "pill" });
  const hudNext = el("span", { class: "pill pill-muted" });
  const hudGoal = el("span", { class: "pill" }), hudCombo = el("span", { class: "pill dn-combo" });
  const sndBtn = sound.soundToggle({ className: "btn btn-sm btn-icon dn-snd" });
  const hud = el("div", { class: "dn-hud", hidden: true }, [hudQ, hudGoal, hudCombo, hudHit, hudNext, sndBtn]);
  sound.attach();
  const hint = el("div", { class: "dn-hint", hidden: true }, "탭하거나 스페이스로 점프");
  const result = el("div", { class: "dn-result", hidden: true });
  const qLayer = el("div", { class: "dn-qlayer", hidden: true });
  const root = el("div", { class: "dn-stu", onPointerdown: onTap }, [msg, hud, game, hint, result, qLayer]);

  const engine = createEngine(canvas, { auto: true, onPass, onHit, onJump: () => { if (mode === "play") sound.play("jump"); } });
  document.addEventListener("keydown", onKey);

  // 가정: ctx.timeout(host 보조 함수, destroy 시 자동 정리)이 없으면 setTimeout. gen/dead 검사로 늦은 콜백 무시.
  const later = (fn, ms) => (typeof ctx.timeout === "function" ? ctx.timeout(fn, ms) : setTimeout(fn, ms));
  const inGame = () => mode === "count" || mode === "play" || mode === "question" || mode === "feedback" || mode === "hold";

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
    if (passes % jpq === 0 && queue.length) { askQuestion(); return true; }
    return false;
  }
  function onHit() {
    paintHud();
    game.classList.remove("is-hit");
    void game.offsetWidth; // 애니메이션 재시작
    game.classList.add("is-hit");
    if (mode === "play") sound.play("hit");
    try { navigator.vibrate?.(40); } catch {}
  }

  function paintHud() {
    const w = engine.world;
    hudQ.textContent = round ? `다시 풀기 ${roundDone}/${roundTotal}` : `문제 ${tried.size}/${Q}`;
    hudGoal.hidden = !retry;
    hudGoal.textContent = solved.size >= need ? `목표 달성 ✓ ${solved.size}/${Q}` : `정답 ${solved.size}/${Q} · 목표 ${need}`;
    hudGoal.className = `pill ${solved.size >= need ? "pill-ok" : ""}`;
    hudCombo.hidden = streak < 2;
    hudCombo.textContent = `🔥 ${streak}콤보 ×${comboMul(streak).toFixed(1)}`;
    hudHit.textContent = `충돌 ${w.hits}`;
    const left = jpq - (w.passes % jpq);
    hudNext.textContent = !queue.length ? "완료" : `다음 문제까지 ${left}`;
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
    sound.bgm(playing && mode !== "count" ? "dino" : null); // 플레이·문제 동안 배경음악
    if (!game.hidden) engine.fit();
  }

  function showCount(n) {
    overlay.replaceChildren(el("div", { class: "dn-count" }, String(n)));
    overlay.hidden = false;
    sound.play("count");
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
    resetRun();
    overlay.hidden = true; closeQuestion();
    engine.reset(); engine.setAuto(true); engine.setSpeed(BASE_SPEED); engine.freeze(false);
    layout();
  }

  // 3·2·1 → 플레이
  function startCountdown() {
    gen++;
    const my = gen;
    mode = "count";
    resetRun();
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
      sound.play("go");
      engine.freeze(false);
      layout();
      if (meId) ctx.send("dino:progress", { sid: meId, answered: 0, tried: 0, correct: 0, solved: 0, hits: 0, round: 0 });
    };
    later(tick, 1000);
  }

  function askQuestion() {
    const qi = queue[0];
    const q = cfg.questions[qi];
    if (!q) return;
    overlay.hidden = true; // 다시 풀기 알림이 떠 있었으면 닫기
    mode = "question";
    engine.freeze(true);
    const fb = el("div", { class: "dn-fb" });
    const limMs = q.sec * 1000, until = performance.now() + limMs, my = gen;
    const bar = el("i"), barWrap = el("div", { class: "dn-qbar" }, [bar]), left = el("span", { class: "pill" });
    const cur = { qi, q, fb, until, limMs, bar, barWrap, left, my };
    qButtons = q.options.map((o, i) => el("button", {
      class: "choice", type: "button", onClick: () => answer(cur, o.id),
    }, [el("span", { class: "choice-key" }, optionLetter(i)), el("span", { class: "choice-text" }, o.text || " ")]));
    qLayer.replaceChildren(el("div", { class: "dn-qcard" }, [
      el("div", { class: "dn-qtop" }, [
        round ? el("span", { class: "pill pill-warn" }, `다시 풀기 · ${qi + 1}번 문제`) : el("span", { class: "dn-qnum" }, `문제 ${qi + 1} / ${Q}`),
        left,
      ]),
      barWrap,
      el("h2", { class: "dn-qtext" }, q.question || " "),
      questionImage(q.image),
      el("div", { class: "dn-choices" }, qButtons),
      fb,
    ]));
    qLayer.hidden = false;
    layout();
    // 제한 시간: 0.1초마다 막대·남은 초, 다 되면 '시간 초과'(오답)
    const tick = () => {
      if (my !== gen || dead || mode !== "question") return;
      if (paintBar(cur) <= 0) answer(cur, null);
      else later(tick, 100);
    };
    tick();
  }
  // 남은 시간 막대 → 남은 ms
  function paintBar(cur) {
    const rem = Math.max(0, cur.until - performance.now());
    cur.bar.style.width = `${(rem / cur.limMs) * 100}%`;
    cur.barWrap.classList.toggle("urgent", rem <= 5000);
    const t = `${Math.ceil(rem / 1000)}초`;
    if (cur.left.textContent !== t) cur.left.textContent = t;
    return rem;
  }

  function answer(cur, id) {
    if (mode !== "question") return;
    const { q, qi, fb } = cur;
    const ok = !!id && q.answerIds.includes(id);
    const oi = id ? q.options.findIndex(o => o.id === id) : -1;
    attempts += 1;
    if (!tried.has(qi)) { tried.add(qi); if (ok) firstOk += 1; }
    if (ok) { solved.add(qi); streak += 1; } else streak = 0;
    log.push([qi, oi, ok ? 1 : 0]);
    queue.shift();
    if (round) roundDone += 1;
    if (round && solved.size >= need) queue = []; // 다시 풀기 중 목표에 닿으면 남은 문제 없이 끝
    // 이 차례가 끝났으면: 목표에 닿았으면 끝, 아니면 못 맞힌 문제로 다시 풀기
    let finished = false, newRound = 0;
    if (!queue.length) {
      if (solved.size >= need || round >= MAX_ROUNDS) finished = true;
      else {
        round += 1;
        queue = cfg.questions.map((_, i) => i).filter(i => !solved.has(i));
        roundTotal = queue.length; roundDone = 0; newRound = queue.length;
      }
    }
    // 틀렸을 때: 다시 풀 수 있으면 정답을 알려 주지 않는다. 남은 시간 멈춤이면 제한 시간까지 이 창을 둔다
    const hold = !ok && !!id && cfg.holdWrong && cur.until - performance.now() > FEEDBACK_MS;
    mode = hold ? "hold" : "feedback";
    q.options.forEach((o, i) => {
      const b = qButtons[i];
      if (!b) return;
      b.disabled = true;
      if (o.id === id) b.classList.add("selected", ok ? "correct" : "wrong");
      if (!ok && !retry && q.answerIds.includes(o.id)) b.classList.add("correct");
    });
    fb.textContent = ok
      ? (streak >= 2 ? `정답! 🔥 ${streak}연속 — 더 빨라져요` : "정답!")
      : `${id ? "아쉬워요" : "시간 초과"}${hold ? " — 시간이 끝나면 다시 달려요" : ""}${retry && !finished ? " · 이 문제는 다시 나올 수 있어요, 지금 찾아 두세요" : ""}`;
    fb.className = `dn-fb ${ok ? "ok" : "bad"}`;
    if (!finished) sound.play(ok ? (streak >= 2 ? "combo" : "correct") : "wrong"); // 마지막은 완주 팡파르로
    const hits = engine.world.hits;
    if (meId) ctx.send("dino:progress", { sid: meId, answered: attempts, tried: tried.size, correct: firstOk, solved: solved.size, hits, round, last: [qi, oi, ok ? 1 : 0] });
    engine.setSpeed(speedNow());
    paintHud();
    // 마지막 문제: 피드백 동안 교사가 [종료]해도 결과가 남도록 즉시 제출
    if (finished) {
      const timeMs = Math.round(performance.now() - t0);
      localResult = { correct: firstOk, solved: solved.size, total: Q, timeMs, hits, run: startKey, attempts, rounds: round, log: log.slice() };
      submitResult();
    }
    const my = gen;
    const go = () => {
      if (my !== gen || dead) return;
      closeQuestion();
      if (finished) { toDone(); return; }
      mode = "play"; engine.freeze(false); if (!ok) engine.slip(); layout();
      if (newRound) notice(`정답 ${solved.size}/${Q} — 목표 ${need}개! 틀린 ${newRound}문제를 다시 풀어요`);
    };
    if (!hold) { later(go, FEEDBACK_MS); return; }
    const tick = () => {
      if (my !== gen || dead || mode !== "hold") return;
      if (paintBar(cur) <= 0) go(); else later(tick, 100);
    };
    tick();
  }
  // 게임 화면 위 잠깐 알림
  function notice(text) {
    overlay.replaceChildren(el("div", { class: "dn-notice" }, text));
    overlay.hidden = false;
    sound.play("count");
    const my = gen;
    later(() => { if (my === gen && !dead && mode !== "count") overlay.hidden = true; }, 3000);
  }
  // 다 풀지 못하고 끝나도 답 기록은 남긴다(교사 리뷰용)
  function submitLog() {
    if (logSent || !log.length || localResult) return;
    logSent = true;
    Promise.resolve().then(() => ctx.submit({ log: log.slice(), run: startKey, partial: true }, { itemKey: "log" })).catch(() => { logSent = false; });
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
      if (inGame()) sound.play("finish"); // 이 화면에서 끝까지 풀었을 때만(다시 열어 결과만 볼 땐 조용히)
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
      submitLog();
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
          stat("처음 정답", `${mine.correct}/${mine.total || Q}`),
          (mine.solved || 0) > mine.correct ? stat("다시 풀어", `${mine.solved}/${mine.total || Q}`) : null,
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
      sound.bgm(null); sound.detach(); sndBtn.release();
    },
  };
}

// ── 교사 ──
function TeacherLive({ slide, ctx }) {
  css(ctx);
  const cfg = cfgOf(slide);
  const Q = cfg.questions.length;
  const progress = new Map(); // sid → {sid, answered, tried, correct, solved, hits, round, log}
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
  sound.attach();
  const sndBtn = sound.soundToggle();
  let doneSeen = null; // 완주 수(새로 늘면 짧은 소리)
  // 끝난 뒤 문제 리뷰(v2.16): 리더보드 대신 한 문제씩 크게, 정답은 문제마다 눌러야 보인다
  let reviewEl = null;
  const bReview = el("button", { class: "btn btn-primary", type: "button", hidden: true, onClick: () => setReview(!reviewEl) }, "📝 문제 리뷰");
  const reviewBox = el("div", { class: "dn-review", hidden: true });
  const root = el("div", { class: "dn-live" }, [
    el("div", { class: "dn-live-head" }, [
      el("h2", {}, slide.title || "공룡 점프"), pillBox, countP, el("span", { class: "dn-spacer" }), bReview, sndBtn, ctlHead,
    ]),
    body,
    reviewBox,
  ]);
  function setReview(on) {
    on = !!on && phase === "ended";
    reviewEl?.destroy?.();
    reviewEl = on ? gameReview({ questions: reviewQs(cfg), logs: dinoLogs(ctx.responses(), progress), ctx, big: true }) : null;
    reviewBox.replaceChildren(...(reviewEl ? [reviewEl] : []));
    reviewBox.hidden = !on;
    body.hidden = on;
    bReview.textContent = on ? "← 순위표" : "📝 문제 리뷰";
    bReview.className = `btn ${on ? "" : "btn-primary"}`;
  }

  const kvDone = el("b");
  const panel = el("div", { class: "dn-panel" }, [
    ctlPanel,
    el("div", {}, [
      kv("문제", el("b", {}, `${Q}개`)),
      kv("문제 간격", el("b", {}, `선인장 ${cfg.jumpsPerQuestion}개`)),
      kv("푸는 시간", el("b", {}, secText(cfg.questions).replace("문제마다 ", ""))),
      kv("완주", kvDone),
      cfg.need ? kv("목표", el("b", {}, `${cfg.passPct}% (${cfg.need}/${Q})`)) : null,
    ]),
  ]);

  // 실시간 진행
  ctx.on("dino:progress", (p) => {
    if (!p || !p.sid) return;
    if ((ctx.activity()?.phase || "idle") === "idle") return;
    const prev = progress.get(p.sid);
    const log = prev?.log ? prev.log.slice() : [];
    if (Array.isArray(p.last)) log.push(p.last); // 답 기록(리뷰용) — 결과가 저장되면 그쪽이 먼저
    progress.set(p.sid, {
      sid: p.sid, answered: num(p.answered), tried: num(p.tried ?? p.answered), correct: num(p.correct),
      solved: num(p.solved ?? p.correct), hits: num(p.hits), round: num(p.round), log,
    });
    paintBoard();
  });

  function boardRows() {
    const done = results(ctx.responses());
    const ids = new Set(done.map(r => r.sid));
    const rows = done.map((r, i) => ({ ...r, kind: "done", rank: i + 1 }));
    const live = [...progress.values()].filter(p => !ids.has(p.sid))
      .sort((a, b) => (b.correct - a.correct) || (b.tried - a.tried) || (b.solved - a.solved) || (a.hits - b.hits));
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
    if (doneSeen != null && doneN > doneSeen && phase === "running") sound.play("finishSoft");
    doneSeen = doneN;
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
      bReview.hidden = ph !== "ended";
      if (ph !== "ended" && reviewEl) setReview(false);
      sound.bgm(ph === "running" ? "dino" : null);
      pillBox.replaceChildren(statusPill(ph));
      ctlHead.update(ph); ctlPanel.update(ph);
      if (preview) { preview.engine.destroy(); preview = null; }
      if (ph === "idle") {
        progress.clear();
        preview = previewGame();
        body.replaceChildren(
          preview.el,
          el("div", { class: "dn-info" }, Q ? `문제 ${Q}개 · 선인장 ${cfg.jumpsPerQuestion}개마다 문제 · ${secText(cfg.questions)}${cfg.need ? ` · 목표 정답 ${cfg.need}/${Q}(못 미치면 틀린 문제 다시)` : ""}` : "아직 문제가 없어요"),
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
    destroy() { if (preview) preview.engine.destroy(); preview = null; reviewEl?.destroy?.(); sound.bgm(null); sound.detach(); sndBtn.release(); },
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
  const logs = dinoLogs(responses);
  return el("div", { class: "dn-sum" }, [
    el("div", { class: "dn-sum-meta" }, [
      el("span", { class: "pill pill-muted" }, `문제 ${Q}개`),
      el("span", { class: "pill pill-muted" }, `완주 ${rows.length}명`),
    ]),
    rows.length
      ? leaderboard(rows, { Q, name: id => nameOf(ctx, id), showRank: rows.length > 1 })
      : el("div", { class: "empty" }, "기록이 없어요"),
    // 문제 리뷰(교사 기록만, 정답은 문제마다 눌러야 보임)
    ctx?.isTeacher !== false && logs.size ? el("div", { class: "dn-sum-review" }, [el("div", { class: "dn-sum-h" }, "문제 리뷰"), gameReview({ questions: reviewQs(cfg), logs, ctx, big: false })]) : null,
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
.dn-hud .dn-snd { margin-left: auto; }
.gs-toggle.is-muted { color: var(--muted); }
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
.dn-qtop { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.dn-qtop .pill { font-variant-numeric: tabular-nums; }
.dn-qbar { height: 6px; border-radius: 999px; background: var(--surface-2); overflow: hidden; margin-top: -4px; }
.dn-qbar i { display: block; height: 100%; width: 100%; background: var(--accent); border-radius: inherit; }
.dn-qbar.urgent i { background: var(--danger); }
.dn-hud .dn-combo { background: #fde2d4; color: #b3410f; font-weight: 800; }
.dn-notice { padding: 10px 18px; border-radius: 999px; background: rgba(28,22,14,.82); color: #fff; font-weight: 700; font-size: clamp(14px, 2.2vw, 18px); text-align: center; max-width: 90%; animation: dn-pop .5s ease both; }
.dn-retry { font-size: .62em; font-weight: 700; color: var(--accent-ink); white-space: nowrap; }
.dn-review { display: flex; flex-direction: column; gap: 12px; }
.dn-sum-review { display: grid; gap: 8px; margin-top: 4px; }
.dn-sum-h { font-weight: 700; font-size: 14px; }
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
.dn-lb-row { display: grid; grid-template-columns: 48px minmax(0, 1fr) 118px 112px 52px; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); font-variant-numeric: tabular-nums; }
.dn-lb.no-rank .dn-lb-row { grid-template-columns: minmax(0, 1fr) 118px 112px 52px; }
.dn-acc { display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
.dn-acc b { font-size: 1.2em; font-weight: 800; color: var(--ink); }
.dn-acc .pill { height: 22px; padding: 0 8px; font-size: 13px; font-weight: 800; }
.dn-acc.is-none b { color: var(--muted); font-weight: 700; }
.dn-lb-head .c-acc { color: var(--ink); font-weight: 800; }
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
.dn-lb.is-big .dn-lb-row { font-size: 20px; padding: 14px 20px; grid-template-columns: 60px minmax(0, 1fr) 190px 168px 76px; }
.dn-lb.is-big .dn-acc b { font-size: 30px; }
.dn-lb.is-big .dn-acc .pill { height: 30px; padding: 0 12px; font-size: 17px; }
.dn-lb.is-big .dn-lb-head { font-size: 13px; padding-top: 10px; padding-bottom: 10px; }
.dn-lb.is-big .dn-badge { width: 40px; height: 40px; font-size: 17px; }
@media (max-width: 480px) {
  .dn-lb-row, .dn-lb.is-big .dn-lb-row { grid-template-columns: 36px minmax(0, 1fr) 92px 84px 36px; padding: 10px; gap: 6px; font-size: 14px; }
  .dn-lb.no-rank .dn-lb-row { grid-template-columns: minmax(0, 1fr) 92px 84px 36px; }
  .dn-lb.is-big .dn-acc b { font-size: 18px; }
  .dn-acc .pill, .dn-lb.is-big .dn-acc .pill { height: 20px; padding: 0 6px; font-size: 11px; }
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
.dn-edit { padding: 24px; display: grid; grid-auto-rows: max-content; gap: 14px; max-width: 760px; margin: 0 auto; width: 100%; box-sizing: border-box; overflow: auto; height: 100%; align-content: start; }
.dn-qlist { display: grid; gap: 12px; }
.dn-qedit { display: flex; flex-direction: column; gap: 10px; padding: 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.dn-qedit-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dn-qsec { width: auto; flex: none; }
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
