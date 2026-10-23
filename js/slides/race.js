// 레이싱 퀴즈(race) — docs/ARCHITECTURE.md §6.3 게임 · §6.4 race
// 결정적 시뮬레이션 + 이산 이벤트(race:answer, race:finish)만 보낸다. 위치 스트림 없음.
// 모든 클라이언트가 같은 규칙(simulate)으로 같은 조의 모든 차를 계산해 그린다.
// 가정: 이벤트·결과 payload 에 slideId·startedAt·name 필드를 덧붙인다(다른 경기 이벤트 거르기·이름 표시용).
// 가정: 상대 차의 race:answer 가 체크포인트 도착 후 17초(제한 15초+2초) 안에 안 오면 '15초 시점 오답'으로 가정해 진행
//       (재접속·이벤트 유실 시 차가 영원히 서 있지 않게). 실제 이벤트가 오면 그 값으로 다시 계산한다.
// 가정: 시간 기준은 교사 시계의 activity.startedAt. 학생 기기는 교사 시계를 추정해 쓴다:
//       race 자체 표본(학생 race:ping → 교사 race:clock {sentAt}, 표본 = sentAt - 수신 시각, 최근 8개 최댓값 + 30ms)이 있으면 그것,
//       없으면 코어 ctx.now()(있다면), 그것도 없으면 Date.now(). 교사 화면은 자기 시계(Date.now()) 그대로.
// 가정: 체크포인트에 서면 이전 부스터/감속은 끝난다(새 답의 효과로 교체).
// 가정: 교사 [종료]·자동 종료 때 activity.endedAt 을 함께 기록 → 모든 화면이 그 시각에서 멈춘다.
//       endedAt 이 없으면(옛 세션 등) 이 화면이 'ended'를 처음 본 시각(교사 시계)에서 멈춘다. 완주 제출은 진행 중이거나 종료 전 결승일 때만.
// 가정: 학생 자기 답은 sessionStorage 에도 저장해 새로고침 후 복원(실패해도 동작).
// 가정: config 기본 questions 는 명세 표대로 [] — 편집기에서 '+ 문제'.
// 가정: 레인 0 = 가장 안쪽. 차 색은 레인 순서(초록·빨강·파랑·노랑).
// 가정: summary 의 ctx.isTeacher === false(학생 '내 기록', 내 응답만 전달)면 조 순위표 대신 내 결과만 보여 준다.
// 가정: 결과 제출 실패 시 5초→10초→…30초 간격으로 재시도(실패 toast 연타 방지).
import { el, icon } from "../ui.js";
import { findStudent } from "../store.js";
import { registerSlideType, newId, injectCss, groupStudents } from "./registry.js";
import { questionEditor, optionLetter } from "./common.js";

// ── 규칙 상수 ──
const BASE = 1 / 12000;          // 랩/ms (1랩 12초)
const QUIZ_MS = 15000;           // 문제 제한
const BOOST_MS = 2500, BOOST_MUL = 2.0;
const SPIN_MS = 1000;
const SLOW_MS = 2500, SLOW_MUL = 0.5;
const GUESS_MS = QUIZ_MS + 2000; // 상대 답 미수신 시 오답 가정까지
const COUNT_MS = 3000;
const END_DELAY = 3000;

// ── 트랙 기하 (논리 좌표 800×500) ──
const TW = 800, TH = 500, CX = 400, CY = 255, A = 190, R = 128, LANE_W = 19, HALF = 43;
const COLORS = [
  { body: "#22a34a", dark: "#14652d", light: "#5fd283", ink: "#fff" },
  { body: "#e03131", dark: "#8f1c1c", light: "#ff7b7b", ink: "#fff" },
  { body: "#2f6fe0", dark: "#1b418f", light: "#7aa7ff", ink: "#fff" },
  { body: "#f5c400", dark: "#9a7a00", light: "#ffe36b", ink: "#1c1c22" },
];

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="6"/><rect x="7.5" y="10" width="9" height="4" rx="2"/><path d="M12 6v4M12 14v4"/></svg>`;

// ── 설정 정규화 ──
function newQuestion() {
  return { id: newId("q"), question: "", options: Array.from({ length: 4 }, () => ({ id: newId("opt"), text: "" })), answerId: null };
}
function cfgOf(slide) {
  const c = slide?.config || {};
  const laps = [1, 2, 3].includes(Number(c.laps)) ? Number(c.laps) : 2;
  const questions = (Array.isArray(c.questions) ? c.questions : []).map(q => {
    const options = (q.options || []).slice(0, 4).map(o => ({ id: o.id || newId("opt"), text: o.text ?? "" }));
    while (options.length < 4) options.push({ id: newId("opt"), text: "" });
    const ans = q.answerId ?? (Array.isArray(q.answerIds) ? q.answerIds[0] : null);
    return {
      id: q.id || newId("q"), question: String(q.question ?? ""), options,
      answerId: options.some(o => o.id === ans) ? ans : null,
    };
  });
  return { laps, questions };
}

// ── 결정적 시뮬레이션 ──
function mulAt(wins, t) {
  for (const w of wins) if (t >= w.from && t < w.to) return w.mul;
  return 1;
}
function edgesAfter(wins, t0) {
  const e = [];
  for (const w of wins) { if (w.from > t0) e.push(w.from); if (w.to > t0) e.push(w.to); }
  return e.sort((a, b) => a - b);
}
// t0 부터 dist(랩) 가는 데 도착하는 시각
function reachTime(t0, wins, dist) {
  if (dist <= 0) return t0;
  let t = t0, rem = dist;
  for (const e of [...edgesAfter(wins, t0), Infinity]) {
    const m = mulAt(wins, t);
    if (m > 0) {
      const can = e === Infinity ? Infinity : BASE * m * (e - t);
      if (can >= rem) return t + rem / (BASE * m);
      rem -= can;
    }
    t = e;
  }
  return t;
}
// t0 → t 사이 이동 거리(랩)
function distBetween(t0, wins, t) {
  let d = 0, cur = t0;
  for (const e of [...edgesAfter(wins, t0).filter(x => x < t), t]) {
    if (e > cur) d += BASE * mulAt(wins, cur) * (e - cur);
    cur = Math.max(cur, e);
  }
  return d;
}
function modeAt(wins, t) {
  for (const w of wins) {
    if (t >= w.from && t < w.to) {
      if (w.mul === 0) return { mode: "spin", spinF: (t - w.from) / (w.to - w.from) };
      return { mode: w.mul > 1 ? "boost" : "slow", spinF: 0 };
    }
  }
  return { mode: "drive", spinF: 0 };
}

// t: startedAt 기준 ms. ansOf(k) → {correct, at}|null. guessAfter: 상대 차 오답 가정(ms) 또는 null
// → { p(랩), mode: grid|drive|boost|slow|spin|quiz|done, spinF, k, arriveAt, cross[], finishAt, correct }
function simulate(t, Q, laps, ansOf, guessAfter = null) {
  const res = { p: -0.006, mode: "grid", spinF: 0, k: 0, arriveAt: 0, cross: [], finishAt: null, correct: 0 };
  if (!(t >= 0)) return res;
  let t0 = 0, p0 = 0, wins = [];
  for (let k = 1; k <= Q + 1; k++) {
    const target = k <= Q ? (laps * k) / (Q + 1) : laps;
    for (let L = Math.floor(p0 + 1e-9) + 1; L <= laps && L <= target + 1e-9; L++) {
      const tc = reachTime(t0, wins, L - p0);
      if (tc > t) break;
      res.cross.push(tc);
    }
    const tArr = reachTime(t0, wins, target - p0);
    if (t < tArr) {
      res.p = p0 + distBetween(t0, wins, t);
      Object.assign(res, modeAt(wins, t));
      return res;
    }
    if (k > Q) { res.p = laps; res.mode = "done"; res.finishAt = tArr; return res; }
    const a = ansOf(k);
    let at, ok;
    if (a) { at = Math.max(Number(a.at) || 0, tArr); ok = !!a.correct; }
    else if (guessAfter != null && t >= tArr + guessAfter) { at = tArr + QUIZ_MS; ok = false; }
    if (at == null || t < at) {
      res.p = target; res.mode = "quiz"; res.k = k; res.arriveAt = tArr;
      return res;
    }
    if (ok) res.correct++;
    wins = ok
      ? [{ from: at, to: at + BOOST_MS, mul: BOOST_MUL }]
      : [{ from: at, to: at + SPIN_MS, mul: 0 }, { from: at + SPIN_MS, to: at + SPIN_MS + SLOW_MS, mul: SLOW_MUL }];
    t0 = at; p0 = target;
  }
  return res;
}
function lapsOf(cross) {
  return cross.map((c, i) => Math.round(c - (i ? cross[i - 1] : 0)));
}

// ── 이벤트 저장소 (모듈 수준: 재마운트해도 유지) ──
const RACES = new Map(); // key `${slideId}|${startedAt}` → { answers: Map<sid, Map<k,{correct,at}>>, finishes: Map<sid,payload> }
const NAMES = new Map(); // sid → 이벤트로 받은 이름

// ── 교사 시계 추정 (학생 기기) ──
const CLOCKS = new Map(); // sessionId → { samples: number[], offset: number|null }
function clockOf(ctx) {
  let id = "";
  try { id = ctx?.session?.()?.id || ""; } catch { id = ""; }
  let c = CLOCKS.get(id);
  if (!c) { c = { samples: [], offset: null }; CLOCKS.set(id, c); }
  return c;
}
function addClockSample(c, sentAt) {
  if (!Number.isFinite(sentAt) || sentAt <= 0) return;
  c.samples.push(sentAt - Date.now());
  if (c.samples.length > 8) c.samples.shift();
  c.offset = Math.max(...c.samples) + 30; // 지연이 가장 작은 표본 + 지연 하한
}
const ctxNow = ctx => (ctx?.now ? ctx.now() : Date.now()); // 코어 교사 시계(교사 화면은 Date.now())
function clockNow(ctx, c) {
  if (c && c.offset != null) return Date.now() + c.offset;
  try {
    const t = typeof ctx?.now === "function" ? Number(ctx.now()) : NaN;
    if (Number.isFinite(t)) return t;
  } catch { /* 무시 */ }
  return Date.now();
}
function raceStore(key) {
  let r = RACES.get(key);
  if (!r) { r = { answers: new Map(), finishes: new Map() }; RACES.set(key, r); }
  return r;
}
function putAnswer(rs, sid, k, v) {
  let m = rs.answers.get(sid);
  if (!m) { m = new Map(); rs.answers.set(sid, m); }
  if (!m.has(k)) m.set(k, v);
}
function loadMine(key, sid) {
  const out = { answers: new Map(), fin: false };
  try {
    const raw = sessionStorage.getItem(`hada:race:${key}:${sid}`);
    if (raw) {
      const j = JSON.parse(raw);
      for (const [k, v] of j.a || []) out.answers.set(Number(k), v);
      out.fin = !!j.fin;
    }
  } catch { /* 저장소 없음 */ }
  return out;
}
function saveMine(key, sid, answers, fin) {
  try { sessionStorage.setItem(`hada:race:${key}:${sid}`, JSON.stringify({ a: [...answers], fin: !!fin })); } catch { /* 무시 */ }
}

// ── 결과 ──
function normRes(p) {
  return {
    lapMs: Array.isArray(p?.lapMs) ? p.lapMs.map(Number) : [],
    totalMs: Number(p?.totalMs) || null,
    correct: Number(p?.correct) || 0,
    total: Number(p?.total) || 0,
    gid: p?.gid ?? null,
  };
}
// sid → 결과 (응답 itemKey 'result' 우선, 그다음 race:finish 이벤트)
function resultsMap(list, startedAt, rs) {
  const m = new Map();
  for (const r of list || []) {
    if ((r.itemKey || "") !== "result") continue;
    const sa = Number(r.payload?.startedAt) || 0;
    if (startedAt && sa && sa !== startedAt) continue;
    m.set(r.studentId, normRes(r.payload));
  }
  if (rs) for (const [sid, p] of rs.finishes) if (!m.has(sid)) m.set(sid, normRes(p));
  return m;
}
// 조 순위: 완주자 totalMs 오름차순 → 미완주(레인 순)
function standings(group, results) {
  const rows = (group.memberIds || []).map((sid, lane) => ({ sid, lane, res: results.get(sid) || null, rank: null }));
  const fin = rows.filter(r => r.res && r.res.totalMs != null).sort((a, b) => a.res.totalMs - b.res.totalMs);
  fin.forEach((r, i) => { r.rank = i + 1; });
  return [...fin, ...rows.filter(r => !fin.includes(r))];
}

function nameOf(ctx, id) {
  let s = null;
  try { s = ctx?.students?.()?.get?.(id) || null; } catch { s = null; }
  if (!s) { try { s = findStudent(id); } catch { s = null; } }
  return s?.name || NAMES.get(id) || "학생";
}
function fmtClock(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}
const frac = p => ((p % 1) + 1) % 1;
const laneR = lane => R + (lane - 1.5) * LANE_W;

// 조의 차 목록 계산 (학생·교사 공용)
function groupCars(group, t, { Q, laps, rs, results, meId = null, mineSim = null, nameFn }) {
  return (group.memberIds || []).slice(0, 4).map((sid, lane) => {
    let sim;
    if (sid === meId && mineSim) sim = mineSim;
    else {
      const m = rs.answers.get(sid);
      sim = simulate(t, Q, laps, k => m?.get(k) || null, GUESS_MS);
    }
    const done = results.has(sid) || sim.mode === "done";
    return {
      sid, lane, sim, done, me: sid === meId, name: nameFn(sid),
      p: done ? laps + 0.015 : sim.p, mode: done ? "done" : sim.mode, spinF: sim.spinF,
    };
  });
}

// ── 캔버스 그리기 ──
function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function stadium(g, r) {
  g.beginPath();
  g.moveTo(CX - A, CY + r);
  g.lineTo(CX + A, CY + r);
  g.arc(CX + A, CY, r, Math.PI / 2, -Math.PI / 2, true);
  g.lineTo(CX - A, CY - r);
  g.arc(CX - A, CY, r, -Math.PI / 2, Math.PI / 2, true);
  g.closePath();
}
// 진행 비율(0..1) → 좌표·방향. 결승선 = 아래 직선 가운데, 오른쪽으로 출발(화면 기준 반시계)
function pointAt(f, r) {
  const P = 4 * A + 2 * Math.PI * r;
  let s = f * P;
  if (s < A) return { x: CX + s, y: CY + r, h: 0 };
  s -= A;
  if (s < Math.PI * r) { const th = Math.PI / 2 - s / r; return { x: CX + A + r * Math.cos(th), y: CY + r * Math.sin(th), h: th - Math.PI / 2 }; }
  s -= Math.PI * r;
  if (s < 2 * A) return { x: CX + A - s, y: CY - r, h: Math.PI };
  s -= 2 * A;
  if (s < Math.PI * r) { const th = -Math.PI / 2 - s / r; return { x: CX - A + r * Math.cos(th), y: CY + r * Math.sin(th), h: th - Math.PI / 2 }; }
  s -= Math.PI * r;
  return { x: CX - A + s, y: CY + r, h: 0 };
}
function trackDist(x, y) {
  const dx = Math.max(Math.abs(x - CX) - A, 0);
  return Math.abs(Math.hypot(dx, y - CY) - R);
}
function isInfield(x, y) {
  return Math.hypot(Math.max(Math.abs(x - CX) - A, 0), y - CY) < R;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 배경 소품(시드 고정 → 모든 화면에서 같은 모양)
let SCENE = null;
function scene() {
  if (SCENE) return SCENE;
  const rnd = mulberry32(240117);
  const dunes = Array.from({ length: 7 }, (_, i) => ({
    y: 30 + i * 70 + rnd() * 20, a: 10 + rnd() * 26, w: 14 + rnd() * 26,
    c: i % 2 ? "rgba(255,240,205,.24)" : "rgba(170,110,60,.10)",
  }));
  const specks = Array.from({ length: 420 }, () => ({
    x: rnd() * TW, y: rnd() * TH, r: rnd() < 0.8 ? 1 : 1.7,
    c: rnd() < 0.5 ? "rgba(120,75,35,.22)" : "rgba(255,248,225,.38)",
  }));
  const cliff = (top) => {
    const pts = [];
    for (let x = 0; x <= TW + 40; x += 32) {
      const d = 12 + rnd() * 16;
      pts.push([x, top ? d : TH - d]);
    }
    return pts;
  };
  const rocks = [];
  let tries = 0, inner = 0;
  while (rocks.length < 22 && tries++ < 900) {
    const r = 6 + rnd() * 14, x = rnd() * TW, y = 34 + rnd() * (TH - 68);
    if (trackDist(x, y) < HALF + 14 + r) continue;
    if (isInfield(x, y)) {
      if (inner >= 5 || r > 12) continue;
      if (Math.abs(y - CY) < 26 && Math.abs(x - CX) < 140) continue; // 글자 자리
      inner++;
    }
    if (rocks.some(o => Math.hypot(o.x - x, o.y - y) < o.r + r + 6)) continue;
    const n = 7 + Math.floor(rnd() * 3), pts = [];
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2, d = r * (0.72 + rnd() * 0.38);
      pts.push([Math.cos(ang) * d, Math.sin(ang) * d * 0.78]);
    }
    rocks.push({ x, y, r, pts, tone: rnd() });
  }
  const shrubs = [];
  tries = 0;
  while (shrubs.length < 14 && tries++ < 600) {
    const x = rnd() * TW, y = 34 + rnd() * (TH - 68);
    if (trackDist(x, y) < HALF + 20) continue;
    if (rocks.some(o => Math.hypot(o.x - x, o.y - y) < o.r + 10)) continue;
    const twigs = Array.from({ length: 7 + Math.floor(rnd() * 5) }, () => ({ a: rnd() * Math.PI * 2, l: 4 + rnd() * 6 }));
    shrubs.push({ x, y, twigs });
  }
  const stripes = [];
  for (let o = -HALF + 2; o < HALF - 1; o += 3) stripes.push({ o, a: (0.012 + rnd() * 0.03).toFixed(3) });
  const asph = Array.from({ length: 1500 }, () => ({
    f: rnd(), o: (rnd() * 2 - 1) * (HALF - 2), c: rnd() < 0.5 ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.2)",
  }));
  const skids = Array.from({ length: 8 }, (_, i) => {
    const right = i % 2 === 0;
    const a0 = (right ? -Math.PI / 2 : Math.PI / 2) + 0.3 + rnd() * 1.6;
    return { cx: right ? CX + A : CX - A, r: R - 26 + rnd() * 30, a0, a1: a0 + 0.4 + rnd() * 0.6 };
  });
  SCENE = { dunes, specks, top: cliff(true), bottom: cliff(false), rocks, shrubs, stripes, asph, skids };
  return SCENE;
}

function paintCliff(g, pts, top) {
  g.beginPath();
  g.moveTo(0, top ? 0 : TH);
  for (const [x, y] of pts) g.lineTo(x, y);
  g.lineTo(TW, top ? 0 : TH);
  g.closePath();
  const gr = g.createLinearGradient(0, top ? 0 : TH, 0, top ? 30 : TH - 30);
  gr.addColorStop(0, "#8a4c25");
  gr.addColorStop(1, "#bf7c45");
  g.fillStyle = gr;
  g.fill();
  g.strokeStyle = "rgba(255,215,160,.25)";
  g.lineWidth = 1;
  g.beginPath();
  pts.forEach(([x, y], i) => { const yy = top ? y * 0.55 : TH - (TH - y) * 0.55; if (i) g.lineTo(x, yy); else g.moveTo(x, yy); });
  g.stroke();
}

function paintScene(g, laps, Q) {
  const S = scene();
  // 모래 바탕
  let gr = g.createLinearGradient(0, 0, 0, TH);
  gr.addColorStop(0, "#efd3a0");
  gr.addColorStop(0.55, "#e2b878");
  gr.addColorStop(1, "#cf9a5c");
  g.fillStyle = gr;
  g.fillRect(0, 0, TW, TH);
  gr = g.createRadialGradient(TW * 0.28, TH * 0.22, 20, TW * 0.28, TH * 0.22, 440);
  gr.addColorStop(0, "rgba(255,244,214,.5)");
  gr.addColorStop(1, "rgba(255,244,214,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, TW, TH);
  // 사구 결
  g.lineCap = "round";
  for (const d of S.dunes) {
    g.strokeStyle = d.c; g.lineWidth = d.w;
    g.beginPath(); g.moveTo(-20, d.y);
    g.bezierCurveTo(TW * 0.3, d.y + d.a, TW * 0.6, d.y - d.a, TW + 20, d.y + d.a * 0.5);
    g.stroke();
  }
  g.lineCap = "butt";
  for (const s of S.specks) { g.fillStyle = s.c; g.fillRect(s.x, s.y, s.r, s.r); }
  // 협곡 벽
  paintCliff(g, S.top, true);
  paintCliff(g, S.bottom, false);
  // 내야
  stadium(g, R - HALF - 7);
  gr = g.createRadialGradient(CX, CY, 10, CX, CY, 260);
  gr.addColorStop(0, "rgba(255,236,196,.45)");
  gr.addColorStop(1, "rgba(214,160,100,.25)");
  g.fillStyle = gr;
  g.fill();
  g.font = "800 26px Pretendard, system-ui, sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillStyle = "rgba(120,70,30,.22)";
  g.fillText("HADA RACEWAY", CX, CY);
  // 덤불
  for (const s of S.shrubs) {
    g.strokeStyle = "rgba(112,100,48,.85)"; g.lineWidth = 0.9;
    g.beginPath();
    for (const t of s.twigs) { g.moveTo(s.x, s.y); g.lineTo(s.x + Math.cos(t.a) * t.l, s.y + Math.sin(t.a) * t.l * 0.8); }
    g.stroke();
    g.fillStyle = "#8f8a45";
    for (const t of s.twigs) { g.fillRect(s.x + Math.cos(t.a) * t.l - 0.8, s.y + Math.sin(t.a) * t.l * 0.8 - 0.8, 1.6, 1.6); }
  }
  // 바위
  for (const k of S.rocks) {
    g.save(); g.translate(k.x, k.y);
    g.fillStyle = "rgba(90,50,20,.28)";
    g.beginPath(); g.ellipse(3, k.r * 0.45, k.r * 1.05, k.r * 0.5, 0, 0, Math.PI * 2); g.fill();
    const rg = g.createRadialGradient(-k.r * 0.35, -k.r * 0.4, 1, 0, 0, k.r * 1.2);
    rg.addColorStop(0, k.tone < 0.5 ? "#cf9a69" : "#bd8f66");
    rg.addColorStop(1, k.tone < 0.5 ? "#7a4a2a" : "#6b4a34");
    g.fillStyle = rg;
    g.beginPath();
    k.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath(); g.fill();
    g.strokeStyle = "rgba(60,35,18,.35)"; g.lineWidth = 1; g.stroke();
    g.strokeStyle = "rgba(255,230,190,.4)";
    g.beginPath(); g.moveTo(-k.r * 0.5, -k.r * 0.2); g.lineTo(k.r * 0.1, -k.r * 0.45); g.stroke();
    g.restore();
  }
  // 트랙 그림자
  g.save(); g.translate(0, 4);
  stadium(g, R); g.lineWidth = 2 * HALF + 18; g.strokeStyle = "rgba(80,45,15,.25)"; g.stroke();
  g.restore();
  // 연석(빨강/흰색)
  for (const r of [R + HALF + 3, R - HALF - 3]) {
    stadium(g, r); g.lineWidth = 7;
    g.setLineDash([]); g.strokeStyle = "#f7f3ea"; g.stroke();
    g.setLineDash([9, 9]); g.strokeStyle = "#d63a2f"; g.stroke();
  }
  g.setLineDash([]);
  // 아스팔트
  stadium(g, R); g.lineWidth = 2 * HALF;
  gr = g.createLinearGradient(0, CY - R - HALF, 0, CY + R + HALF);
  gr.addColorStop(0, "#4b4d53"); gr.addColorStop(0.5, "#393b40"); gr.addColorStop(1, "#45474d");
  g.strokeStyle = gr; g.stroke();
  for (const s of S.stripes) { stadium(g, R + s.o); g.lineWidth = 1; g.strokeStyle = `rgba(255,255,255,${s.a})`; g.stroke(); }
  for (const s of S.asph) { const p = pointAt(s.f, R + s.o); g.fillStyle = s.c; g.fillRect(p.x, p.y, 1.3, 1.3); }
  // 타이어 자국
  g.strokeStyle = "rgba(15,15,18,.2)"; g.lineWidth = 2.2;
  for (const k of S.skids) { g.beginPath(); g.arc(k.cx, CY, k.r, k.a0, k.a1); g.stroke(); }
  // 가장자리 선 · 레인 구분선
  for (const o of [HALF - 3, -(HALF - 3)]) { stadium(g, R + o); g.lineWidth = 1.6; g.strokeStyle = "rgba(255,255,255,.75)"; g.stroke(); }
  g.setLineDash([12, 14]);
  for (const o of [-LANE_W, 0, LANE_W]) { stadium(g, R + o); g.lineWidth = 1.3; g.strokeStyle = "rgba(255,255,255,.38)"; g.stroke(); }
  g.setLineDash([]);
  // 체크 무늬 결승선
  const sq = (2 * HALF - 6) / 10, y0 = CY + R - HALF + 3;
  for (let i = 0; i < 10; i++) for (let j = 0; j < 2; j++) {
    g.fillStyle = (i + j) % 2 ? "#111" : "#fff";
    g.fillRect(CX - sq + j * sq, y0 + i * sq, sq, sq);
  }
  // 퀴즈 체크포인트 표시
  const fs = [...new Set(Array.from({ length: Q }, (_, i) => frac((laps * (i + 1)) / (Q + 1)).toFixed(3)))].map(Number);
  g.font = "800 10px Pretendard, system-ui, sans-serif";
  for (const f of fs) {
    const p = pointAt(f, R + HALF + 16);
    g.beginPath(); g.arc(p.x, p.y, 7, 0, Math.PI * 2);
    g.fillStyle = "#ffd43b"; g.fill();
    g.strokeStyle = "#8a6400"; g.lineWidth = 1.2; g.stroke();
    g.fillStyle = "#5c4300"; g.fillText("?", p.x, p.y + 0.5);
  }
}

const BG_CACHE = new Map();
function staticLayer(pw, ph, laps, Q) {
  const key = `${pw}x${ph}|${laps}|${Q}`;
  let c = BG_CACHE.get(key);
  if (c) return c;
  c = document.createElement("canvas");
  c.width = pw; c.height = ph;
  const g = c.getContext("2d");
  g.setTransform(pw / TW, 0, 0, ph / TH, 0, 0);
  paintScene(g, laps, Q);
  if (BG_CACHE.size >= 8) BG_CACHE.delete(BG_CACHE.keys().next().value);
  BG_CACHE.set(key, c);
  return c;
}

function drawCar(g, pt, c) {
  const col = COLORS[c.lane % 4];
  let h = pt.h;
  if (c.mode === "spin") h += Math.PI * 4 * (1 - (1 - c.spinF) ** 2);
  g.save();
  g.translate(pt.x, pt.y);
  if (c.me) {
    g.beginPath(); g.arc(0, 0, 17, 0, Math.PI * 2);
    g.strokeStyle = "rgba(255,255,255,.9)"; g.lineWidth = 2; g.setLineDash([4, 4]); g.stroke(); g.setLineDash([]);
  }
  // 그림자
  g.save(); g.translate(2, 3); g.rotate(h);
  g.fillStyle = "rgba(0,0,0,.3)"; rr(g, -13, -7, 26, 14, 5); g.fill();
  g.restore();
  g.rotate(h);
  // 바퀴
  g.fillStyle = "#16161a";
  for (const [x, y] of [[-10, -9], [-10, 5], [5, -9], [5, 5]]) { rr(g, x, y, 6, 4, 1.2); g.fill(); }
  // 차체
  const gr = g.createLinearGradient(0, -6, 0, 6);
  gr.addColorStop(0, col.light); gr.addColorStop(0.5, col.body); gr.addColorStop(1, col.dark);
  g.fillStyle = gr; rr(g, -12, -6, 24, 12, 4.5); g.fill();
  g.strokeStyle = col.dark; g.lineWidth = 0.8; g.stroke();
  g.fillStyle = "#f4f4f4"; rr(g, 10, -4.5, 3, 9, 1.5); g.fill();       // 앞 범퍼
  g.fillStyle = "#1f1f24"; rr(g, -14, -7, 3, 14, 1); g.fill();          // 뒤 스포일러
  g.fillStyle = "#fff"; g.beginPath(); g.arc(-1.5, 0, 3.8, 0, Math.PI * 2); g.fill(); // 헬멧
  g.fillStyle = col.dark; g.beginPath(); g.arc(-0.6, 0, 2.3, -Math.PI / 2, Math.PI / 2); g.fill();
  g.restore();
  if (c.mode === "quiz") {
    g.beginPath(); g.arc(pt.x, pt.y - 19, 8, 0, Math.PI * 2);
    g.fillStyle = "#ffd43b"; g.fill(); g.strokeStyle = "#8a6400"; g.lineWidth = 1.2; g.stroke();
    g.fillStyle = "#5c4300"; g.font = "800 11px Pretendard, system-ui, sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("?", pt.x, pt.y - 18.5);
  }
}
function drawTag(g, pt, c, cssScale) {
  if (!c.name) return;
  const col = COLORS[c.lane % 4];
  const fs = Math.min(24, Math.max(10, 11 / (cssScale || 1)));
  const text = c.name.length > 6 ? `${c.name.slice(0, 6)}…` : c.name;
  g.font = `700 ${fs}px Pretendard, system-ui, sans-serif`;
  const w = g.measureText(text).width + fs * 0.9, h = fs * 1.5;
  const x = pt.x - w / 2, y = pt.y - 14 - h - (c.mode === "quiz" ? 14 : 0);
  g.fillStyle = c.me ? col.body : "rgba(255,255,255,.92)";
  rr(g, x, y, w, h, h / 2); g.fill();
  if (!c.me) { g.strokeStyle = col.body; g.lineWidth = Math.max(1.2, fs * 0.12); g.stroke(); }
  g.fillStyle = c.me ? col.ink : "#1c1c22";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, pt.x, y + h / 2 + 0.5);
}

// 트랙 하나(캔버스 하나). draw(cars, dt, live)
class TrackView {
  constructor(cfgFn) {
    this.cfg = cfgFn;
    this.canvas = el("canvas", { class: "race-canvas" });
    this.g = this.canvas.getContext("2d");
    this.pw = 0; this.ph = 0; this.scale = 1; this.cssScale = 1;
    this.parts = []; this.disp = new Map(); this.acc = new Map();
  }
  fit() {
    const w = this.canvas.clientWidth;
    if (!w) return false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(w * dpr), ph = Math.round((w * dpr * TH) / TW);
    if (pw !== this.pw || ph !== this.ph) { this.canvas.width = pw; this.canvas.height = ph; this.pw = pw; this.ph = ph; }
    this.scale = pw / TW; this.cssScale = w / TW;
    return true;
  }
  busy() { return this.parts.length > 0; }
  draw(cars = [], dt = 0, live = false) {
    if (!this.fit()) return false;
    const { laps, Q } = this.cfg();
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.pw, this.ph);
    g.drawImage(staticLayer(this.pw, this.ph, laps, Q), 0, 0);
    g.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    const k = 1 - Math.exp(-dt * 8);
    const items = [];
    for (const c of cars) {
      let p = c.p;
      const prev = this.disp.get(c.sid);
      // 상대 차: 이벤트 늦게 도착 시 순간이동 대신 부드럽게
      if (!c.me && prev != null && dt > 0 && Math.abs(p - prev) < 0.6) p = prev + (p - prev) * k;
      this.disp.set(c.sid, p);
      const pt = pointAt(frac(p), laneR(c.lane));
      items.push({ c, pt });
      if (live && dt > 0) this.emit(c, pt, dt);
    }
    this.stepParticles(dt);
    items.sort((a, b) => a.pt.y - b.pt.y);
    for (const it of items) drawCar(g, it.pt, it.c);
    for (const it of items) drawTag(g, it.pt, it.c, this.cssScale);
    return true;
  }
  emit(c, pt, dt) {
    let rate = 0, kind = null;
    if (c.mode === "boost") { rate = 70; kind = "fire"; }
    else if (c.mode === "spin") { rate = 40; kind = "dust"; }
    else if (c.mode === "slow") { rate = 14; kind = "dust"; }
    if (!rate) return;
    const acc = (this.acc.get(c.sid) || 0) + rate * dt;
    let n = Math.floor(acc);
    this.acc.set(c.sid, acc - n);
    const back = pt.h + Math.PI;
    while (n-- > 0 && this.parts.length < 500) {
      const ang = back + (Math.random() - 0.5) * 0.7;
      const sp = kind === "fire" ? 60 + Math.random() * 70 : 15 + Math.random() * 25;
      const life = kind === "fire" ? 0.32 : 0.7;
      this.parts.push({
        x: pt.x + Math.cos(back) * 13 + (Math.random() - 0.5) * 4, y: pt.y + Math.sin(back) * 13 + (Math.random() - 0.5) * 4,
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life, max: life, size: kind === "fire" ? 4.5 : 5, kind,
      });
    }
  }
  stepParticles(dt) {
    const g = this.g, out = [];
    for (const q of this.parts) {
      q.life -= dt;
      if (q.life <= 0) continue;
      q.x += q.vx * dt; q.y += q.vy * dt;
      out.push(q);
      const f = q.life / q.max;
      let r;
      if (q.kind === "fire") {
        g.globalCompositeOperation = "lighter";
        g.fillStyle = `hsla(${18 + 40 * f},100%,${50 + 25 * f}%,${(0.85 * f).toFixed(3)})`;
        r = q.size * (0.4 + 0.6 * f);
      } else {
        g.globalCompositeOperation = "source-over";
        g.fillStyle = `rgba(170,135,95,${(0.35 * f).toFixed(3)})`;
        r = q.size * (1.6 - f);
      }
      g.beginPath(); g.arc(q.x, q.y, r, 0, Math.PI * 2); g.fill();
    }
    g.globalCompositeOperation = "source-over";
    this.parts = out;
  }
}

// rAF 루프 (dt 클램프, 숨김 시 정지)
function makeLoop(frame, wants) {
  let raf = null, last = 0, dead = false;
  function loop(ts) {
    raf = null;
    if (dead || document.hidden) return;
    const dt = Math.min(0.05, Math.max(0, (ts - last) / 1000));
    last = ts;
    try { frame(dt); } catch (e) { console.error("[race] frame", e); }
    if (wants()) raf = requestAnimationFrame(loop);
  }
  function kick() {
    if (raf || dead || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }
  const onVis = () => { if (!document.hidden) kick(); };
  document.addEventListener("visibilitychange", onVis);
  return {
    kick,
    stop() { dead = true; if (raf) cancelAnimationFrame(raf); raf = null; document.removeEventListener("visibilitychange", onVis); },
  };
}

function ensureCss(ctx) { (ctx?.injectCss || injectCss)("race", CSS); }

// 타이머: host 보조(ctx.timeout/interval/clearTimer) 우선, 없으면 직접 관리 → destroy 시 clearAll
function timerKit(ctx) {
  const own = new Map(); // id → 'timeout'|'interval' (대체 경로만)
  const hasHost = typeof ctx?.timeout === "function" && typeof ctx?.interval === "function" && typeof ctx?.clearTimer === "function";
  return {
    later(fn, ms) {
      if (hasHost) return ctx.timeout(fn, ms);
      const id = setTimeout(() => { own.delete(id); fn(); }, ms);
      own.set(id, "timeout");
      return id;
    },
    every(fn, ms) {
      if (hasHost) return ctx.interval(fn, ms);
      const id = setInterval(fn, ms);
      own.set(id, "interval");
      return id;
    },
    cancel(id) {
      if (id == null) return;
      if (hasHost) { ctx.clearTimer(id); return; }
      if (own.get(id) === "interval") clearInterval(id); else clearTimeout(id);
      own.delete(id);
    },
    clearAll() {
      for (const [id, kind] of own) { if (kind === "interval") clearInterval(id); else clearTimeout(id); }
      own.clear();
    },
  };
}

const CSS = `
.race-stu [hidden], .race-live [hidden], .race-edit [hidden] { display: none !important; }
.race-stu { position: relative; height: 100%; overflow: auto; display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 12px 12px calc(16px + env(safe-area-inset-bottom)); box-sizing: border-box; }
.race-stage { position: relative; width: 100%; flex: none; border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow-1); background: #e2b878; }
.race-canvas { display: block; width: 100%; aspect-ratio: 16 / 10; }
.race-hud { position: absolute; left: 10px; top: 10px; right: 10px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; pointer-events: none; }
.race-hud .rh { background: rgba(24,20,14,.74); color: #fff; border-radius: 999px; padding: 4px 10px; font-weight: 800; font-size: 14px; font-variant-numeric: tabular-nums; letter-spacing: .02em; }
.race-hud .rh-sub { font-weight: 600; font-size: 12px; }
.race-hud .rh:empty { display: none; }
.race-count { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; font-size: clamp(48px, 12vw, 128px); font-weight: 900; color: #fff; text-shadow: 0 4px 18px rgba(0,0,0,.45); z-index: 3; }
.race-count:empty { display: none; }
.race-count.pop { animation: race-pop .9s ease-out; }
@keyframes race-pop { 0% { transform: scale(1.7); opacity: 0; } 25% { transform: scale(1); opacity: 1; } 100% { opacity: .92; } }
.race-flash { position: absolute; left: 50%; top: 16%; transform: translateX(-50%); padding: 8px 16px; border-radius: 999px; font-weight: 800; color: #fff; background: var(--ok); box-shadow: var(--shadow-2); pointer-events: none; opacity: 0; transition: opacity .2s; white-space: nowrap; z-index: 4; }
.race-flash.show { opacity: 1; }
.race-flash.bad { background: var(--danger); }
.race-quiz { position: absolute; inset: 0; z-index: 6; display: flex; align-items: center; justify-content: center; padding: 12px; background: rgba(28,22,14,.45); overflow: auto; box-sizing: border-box; }
.race-quiz-card { background: var(--surface); border-radius: var(--radius-lg); box-shadow: var(--shadow-2); padding: 18px; width: min(640px, 100%); display: grid; gap: 12px; box-sizing: border-box; margin: auto; }
.race-quiz-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.race-qbar { height: 6px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
.race-qbar i { display: block; height: 100%; width: 100%; background: var(--accent); border-radius: inherit; }
.race-qbar.urgent i { background: var(--danger); }
.race-q { font-size: 20px; font-weight: 700; line-height: 1.4; white-space: pre-wrap; word-break: keep-all; overflow-wrap: anywhere; margin: 0; }
.race-choices { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
@media (max-width: 520px) { .race-choices { grid-template-columns: 1fr; } }
.race-choices .choice { min-height: 56px; width: 100%; text-align: left; display: flex; align-items: center; gap: 10px; font-size: 16px; padding: 10px 12px; cursor: pointer; }
.race-card { width: min(560px, 100%); background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow-1); padding: 14px 16px; display: grid; gap: 10px; box-sizing: border-box; flex: none; }
.race-rank { font-size: 15px; color: var(--ink-2); }
.race-rank b { font-size: 26px; color: var(--ink); margin-right: 2px; }
.race-laps { display: flex; gap: 6px; flex-wrap: wrap; }
.race-laps .pill { font-variant-numeric: tabular-nums; }
.race-standings { display: grid; }
.race-srow { display: grid; grid-template-columns: 24px 12px minmax(0,1fr) auto; gap: 8px; align-items: center; padding: 6px 2px; border-top: 1px solid var(--line); font-size: 14px; font-variant-numeric: tabular-nums; }
.race-srow.me { font-weight: 700; }
.race-srow .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.race-srow .tm { color: var(--ink-2); }
.race-srow .tm.dnf { color: var(--danger); }
.race-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
.race-msg { padding: 8px 0; }
.race-live { height: 100%; display: flex; flex-direction: column; gap: 12px; padding: 16px 20px; box-sizing: border-box; min-height: 0; }
.race-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: none; }
.race-head .race-title { font-weight: 700; font-size: 17px; margin-right: 4px; }
.race-sp { flex: 1; }
.race-ctl { display: flex; gap: 6px; flex-wrap: wrap; }
.race-grid-wrap { position: relative; flex: 1; min-height: 0; overflow: auto; }
.race-idle-info { flex: none; text-align: center; font-size: 13px; color: var(--ink-2); }
.race-grid { display: grid; gap: 12px; justify-content: center; align-content: start; }
.race-tile { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; min-width: 0; }
.race-tile-h { display: flex; gap: 10px; align-items: center; padding: 0 10px; height: 34px; font-size: 13px; overflow: hidden; white-space: nowrap; }
.race-tile-h b { font-size: 14px; flex: none; }
.race-tile-h .mb { display: inline-flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--ink-2); }
.race-panel { display: grid; gap: 14px; }
.race-gblock { display: grid; gap: 4px; }
.race-gt { font-weight: 700; font-size: 14px; }
.race-tbl-wrap { overflow-x: auto; }
.race-table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
.race-table th { font-weight: 600; color: var(--muted); font-size: 12px; }
.race-table th, .race-table td { padding: 6px 4px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
.race-table th:nth-child(2), .race-table td:nth-child(2) { text-align: left; max-width: 110px; overflow: hidden; text-overflow: ellipsis; }
.race-table th:first-child, .race-table td:first-child { text-align: center; width: 28px; }
.race-table tr.win td { font-weight: 700; }
.race-table .dnf { color: var(--danger); font-weight: 600; }
.race-table .run { color: var(--muted); }
.race-sum { display: grid; gap: 14px; }
.race-sum-meta { display: flex; gap: 6px; flex-wrap: wrap; }
.race-edit { padding: 20px; display: grid; gap: 14px; max-width: 760px; margin: 0 auto; width: 100%; box-sizing: border-box; overflow: auto; height: 100%; align-content: start; }
.race-edit-prev { border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow-1); max-width: 420px; width: 100%; justify-self: center; }
.race-qlist { display: grid; gap: 12px; }
.race-qcard { border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; display: grid; gap: 8px; background: var(--surface); }
.race-qcard-h { display: flex; align-items: center; gap: 8px; }
.race-qcard .q-editor textarea { font-size: 17px; font-weight: 600; min-height: 64px; resize: vertical; }
`;

// ── 편집기 ──
function seg(options, value, onPick) {
  const root = el("div", { class: "seg" });
  const paint = v => [...root.children].forEach((b, i) => b.classList.toggle("active", options[i].value === v));
  options.forEach(o => root.appendChild(el("button", { type: "button", onClick: () => { paint(o.value); onPick(o.value); } }, o.label)));
  paint(value);
  return root;
}

function Editor({ slide, update, ctx }) {
  ensureCss(ctx);
  let cfg = cfgOf(slide);
  const emit = () => update({
    config: {
      ...(slide.config || {}),
      laps: cfg.laps,
      questions: cfg.questions.map(q => ({ id: q.id, question: q.question, options: q.options.map(o => ({ ...o })), answerId: q.answerId })),
    },
  });

  const preview = new TrackView(() => ({ laps: cfg.laps, Q: cfg.questions.length }));
  const gridCars = () => [0, 1, 2, 3].map(lane => ({ sid: `p${lane}`, lane, p: -0.006, mode: "grid", spinF: 0, name: "", me: false }));
  const drawPreview = () => preview.draw(gridCars(), 0, false);
  const prevWrap = el("div", { class: "race-edit-prev" }, [preview.canvas]);
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(drawPreview) : null;
  ro?.observe(prevWrap);
  requestAnimationFrame(drawPreview);

  const lapsSeg = seg([1, 2, 3].map(v => ({ value: v, label: `${v}바퀴` })), cfg.laps, v => { cfg.laps = v; emit(); drawPreview(); });

  const list = el("div", { class: "race-qlist" });
  function renderList() {
    if (!cfg.questions.length) { list.replaceChildren(el("div", { class: "empty" }, "아직 문제가 없어요")); return; }
    list.replaceChildren(...cfg.questions.map((q, i) => {
      const del = el("button", { class: "btn btn-icon btn-ghost", type: "button", title: "삭제", onClick: async () => {
        const filled = q.question.trim() || q.options.some(o => o.text.trim());
        if (filled && !(await ctx.confirm("이 문제를 지울까요?", { ok: "삭제", danger: true }))) return;
        cfg.questions = cfg.questions.filter(x => x !== q);
        renderList(); emit(); drawPreview();
      } }, [icon("trash")]);
      const qe = questionEditor({
        question: q.question, options: q.options, answerIds: q.answerId ? [q.answerId] : [],
        multiple: false, maxOptions: 4, minOptions: 4, placeholder: "문제를 입력하세요",
        onChange: ({ question, options, answerIds }) => {
          q.question = question;
          q.options = options.slice(0, 4);
          q.answerId = answerIds[0] || null;
          emit();
        },
      });
      return el("div", { class: "race-qcard" }, [
        el("div", { class: "race-qcard-h" }, [el("b", {}, `${i + 1}번`), el("span", { class: "race-sp" }), del]),
        qe,
      ]);
    }));
  }
  renderList();

  const addBtn = el("button", { class: "btn btn-sm", type: "button", onClick: () => {
    cfg.questions.push(newQuestion());
    renderList(); emit(); drawPreview();
    list.lastElementChild?.querySelector("textarea")?.focus();
  } }, "+ 문제");

  return {
    el: el("div", { class: "race-edit" }, [
      prevWrap,
      el("div", { class: "field" }, [el("label", {}, "바퀴 수"), lapsSeg]),
      list,
      el("div", {}, [addBtn]),
    ]),
    destroy() { ro?.disconnect(); },
  };
}

// ── 학생 ──
function Student({ slide, me, ctx }) {
  ensureCss(ctx);
  const cfg = cfgOf(slide);
  const Q = cfg.questions.length, laps = cfg.laps;
  const meId = me?.id || null;
  if (me?.id && me?.name) NAMES.set(me.id, me.name);
  let act = ctx.activity() || { phase: "idle" };
  let race = null;
  let needDraw = true, lastSim = null, cdText = "", flashTm = null;
  const tk = timerKit(ctx);

  const track = new TrackView(() => ({ laps, Q }));
  const hudLap = el("span", { class: "rh" }), hudTime = el("span", { class: "rh" }), hudLast = el("span", { class: "rh rh-sub" });
  const hud = el("div", { class: "race-hud" }, [hudLap, hudTime, hudLast]);
  const countEl = el("div", { class: "race-count" });
  const flashEl = el("div", { class: "race-flash" });
  const stage = el("div", { class: "race-stage" }, [track.canvas, hud, countEl, flashEl]);
  const msgEl = el("div", { class: "empty race-msg" });
  const card = el("div", { class: "race-card", hidden: true });
  const quizEl = el("div", { class: "race-quiz", hidden: true });
  const root = el("div", { class: "race-stu" }, [msgEl, stage, card, quizEl]);

  const nameFn = sid => nameOf(ctx, sid);
  const clock = clockOf(ctx);
  const now = () => clockNow(ctx, clock); // 교사 시계 기준
  const tNow = () => {
    const n = now();
    const end = act.phase === "ended" ? (Number(act.endedAt) || race.endSeen || n) : Infinity;
    return Math.min(n, end) - race.startedAt;
  };
  // 교사 시계 표본 요청: 표본 3개 또는 8회까지, 1.5초 간격(채널이 늦게 붙어도 재시도)
  let pings = 0, lastPing = 0;
  function ping(force = false) {
    const t = Date.now();
    if (!force && (clock.samples.length >= 3 || pings >= 8 || t - lastPing < 1500)) return;
    pings++; lastPing = t;
    ctx.send("race:ping", { slideId: slide.id });
  }
  const mySim = t => simulate(t, Q, laps, k => race.mine.get(k) || null, null);

  function makeRace(key, sa) {
    const rs = raceStore(key);
    const saved = loadMine(key, meId);
    const mine = saved.answers;
    for (const [k, v] of rs.answers.get(meId) || []) if (!mine.has(k)) mine.set(k, v);
    for (const [k, v] of mine) putAnswer(rs, meId, k, v);
    return { key, startedAt: sa, rs, mine, group: null, sentFin: saved.fin, submitted: false, submitting: false, retryAt: 0, quizK: 0, quizArrive: 0, quizBar: null, quizLeft: null, cardSig: "", endSeen: null };
  }

  function sync() {
    act = ctx.activity() || { phase: "idle" };
    const sa = act.phase !== "idle" ? Number(act.startedAt) || 0 : 0;
    const key = sa ? `${slide.id}|${sa}` : "";
    if ((race?.key || "") !== key) { hideQuiz(); race = key ? makeRace(key, sa) : null; if (race) ping(true); }
    if (race) race.group = (act.groups || []).find(g => (g.memberIds || []).includes(meId)) || null;
    if (race) race.endSeen = act.phase === "ended" ? (race.endSeen ?? now()) : null; // endedAt 없을 때 멈출 시각
    checkMine();
    paintStatic();
    needDraw = true;
    loop.kick();
  }

  function checkMine() {
    if (!race) return;
    const r = ctx.myResponse?.("result");
    const sa = Number(r?.payload?.startedAt) || 0;
    if (r && (!sa || sa === race.startedAt)) race.submitted = true;
  }

  // 단계별 정적 화면(메시지·보이기/숨기기)
  function paintStatic() {
    const inRace = !!(race && race.group);
    let msg = "";
    if (act.phase === "idle" || !race) msg = "선생님이 시작하면 출발해요";
    else if (!race.group) msg = "다음 경기에 참여해요";
    msgEl.textContent = msg;
    msgEl.hidden = !msg;
    stage.hidden = !!race && !race.group;
    hud.hidden = !inRace;
    if (!inRace) { card.hidden = true; countEl.textContent = ""; cdText = ""; hideQuiz(); }
    layout();
  }

  function layout() {
    const W = root.clientWidth, H = root.clientHeight;
    if (!W || !H) return;
    let h = H - 28;
    if (!msgEl.hidden) h -= msgEl.offsetHeight + 12;
    if (!card.hidden) h -= card.offsetHeight + 12;
    const w = Math.max(220, Math.min(W - 24, h * 1.6));
    stage.style.width = `${Math.floor(w)}px`;
    needDraw = true;
  }

  // 체크포인트 처리·완주 제출 (숨김 중에도 1초마다)
  function logic() {
    if (!race || !race.group) return null;
    const t = tNow();
    const running = act.phase === "running";
    let sim = mySim(t);
    let guard = 0;
    while (running && !race.submitted && sim.mode === "quiz" && t >= sim.arriveAt + QUIZ_MS && guard++ < 50) {
      answer(sim.k, null, sim.arriveAt + QUIZ_MS);
      sim = mySim(t);
    }
    if (running && !race.submitted && sim.mode === "quiz") showQuiz(sim); else hideQuiz();
    if (sim.mode === "done" && !race.submitted) finish(sim);
    lastSim = sim;
    return sim;
  }

  function answer(k, optId, atOverride) {
    if (!race || race.mine.has(k)) return;
    const q = cfg.questions[k - 1];
    const correct = !!optId && optId === q?.answerId;
    const arrive = race.quizK === k ? race.quizArrive : (lastSim?.k === k ? lastSim.arriveAt : 0);
    const at = Math.round(atOverride ?? Math.min(arrive + QUIZ_MS, Math.max(arrive, now() - race.startedAt)));
    const v = { correct, at };
    race.mine.set(k, v);
    putAnswer(race.rs, meId, k, v);
    saveMine(race.key, meId, race.mine, race.sentFin);
    ctx.send("race:answer", { sid: meId, gid: race.group?.id || null, k, correct, at, slideId: slide.id, startedAt: race.startedAt, name: me?.name || "" });
    const ai = q ? q.options.findIndex(o => o.id === q.answerId) : -1;
    if (correct) flash("정답! 부스터", true);
    else flash(`${optId ? "아쉬워요" : "시간 초과"}${ai >= 0 ? ` · 정답 ${optionLetter(ai)}` : ""}`, false);
    hideQuiz();
  }

  function flash(text, ok) {
    flashEl.textContent = text;
    flashEl.className = `race-flash show${ok ? "" : " bad"}`;
    tk.cancel(flashTm);
    flashTm = tk.later(() => { flashEl.classList.remove("show"); flashTm = null; }, 1300);
  }

  function showQuiz(sim) {
    if (race.quizK === sim.k) return;
    const q = cfg.questions[sim.k - 1];
    if (!q) return;
    race.quizK = sim.k; race.quizArrive = sim.arriveAt;
    const k = sim.k;
    const bar = el("i");
    const barWrap = el("div", { class: "race-qbar" }, [bar]);
    const left = el("span", { class: "pill" });
    quizEl.replaceChildren(el("div", { class: "race-quiz-card" }, [
      el("div", { class: "race-quiz-top" }, [el("span", { class: "pill pill-muted" }, `문제 ${k}/${Q}`), left]),
      barWrap,
      el("h2", { class: "race-q" }, q.question || ""),
      el("div", { class: "race-choices" }, q.options.map((o, i) => el("button", {
        class: "choice", type: "button",
        onClick: () => { if (race && race.quizK === k) answer(k, o.id, null); },
      }, [el("span", { class: "choice-key" }, optionLetter(i)), el("span", { class: "choice-text" }, o.text || " ")]))),
    ]));
    quizEl.hidden = false;
    race.quizBar = { bar, barWrap, left };
    quizTimer();
  }
  function quizTimer() {
    if (!race?.quizK || !race.quizBar) return;
    const rem = Math.max(0, race.quizArrive + QUIZ_MS - (now() - race.startedAt));
    const { bar, barWrap, left } = race.quizBar;
    bar.style.width = `${(rem / QUIZ_MS) * 100}%`;
    barWrap.classList.toggle("urgent", rem <= 5000);
    const s = `${Math.ceil(rem / 1000)}초`;
    if (left.textContent !== s) left.textContent = s;
  }
  function hideQuiz() {
    if (race) { race.quizK = 0; race.quizBar = null; }
    if (!quizEl.hidden) { quizEl.hidden = true; quizEl.replaceChildren(); }
  }

  function finish(sim) {
    if (!race || race.submitting || Date.now() < race.retryAt) return;
    // 진행 중일 때만(종료 뒤엔 종료 시각 전에 결승한 경우만) 완주로 인정
    if (act.phase !== "running") {
      const endAt = Number(act.endedAt) || race.endSeen;
      if (act.phase !== "ended" || !endAt || !(sim.finishAt <= endAt - race.startedAt)) return;
    }
    const lapMs = lapsOf(sim.cross);
    const totalMs = Math.round(sim.finishAt);
    const payload = { lapMs, totalMs, correct: sim.correct, total: Q, gid: race.group?.id || null, startedAt: race.startedAt };
    if (!race.rs.finishes.has(meId)) race.rs.finishes.set(meId, payload);
    if (!race.sentFin) {
      race.sentFin = true;
      saveMine(race.key, meId, race.mine, true);
      ctx.send("race:finish", { sid: meId, gid: payload.gid, lapMs, totalMs, correct: sim.correct, total: Q, slideId: slide.id, startedAt: race.startedAt, name: me?.name || "" });
    }
    const r = race;
    r.submitting = true;
    Promise.resolve()
      .then(() => ctx.submit(payload, { itemKey: "result", score: sim.correct, timeMs: totalMs }))
      .then(() => { r.submitted = true; })
      .catch(() => { r.fails = (r.fails || 0) + 1; r.retryAt = Date.now() + Math.min(30000, 5000 * 2 ** (r.fails - 1)); })
      .finally(() => { r.submitting = false; needDraw = true; loop.kick(); });
  }

  function renderCard(rows, ended) {
    const mine = rows.find(r => r.sid === meId);
    const my = mine?.res || null;
    const n = rows.length;
    const head = my
      ? el("div", { class: "race-rank" }, [el("b", {}, mine.rank ? `${mine.rank}위` : "완주"), mine.rank ? ` / ${n}명` : ""])
      : el("div", { class: "race-rank" }, [el("b", {}, "DNF"), " 완주하지 못했어요"]);
    const lapsRow = my ? el("div", { class: "race-laps" }, [
      ...my.lapMs.map((ms, i) => el("span", { class: "pill" }, `LAP ${i + 1} ${fmtClock(ms)}`)),
      el("span", { class: "pill pill-ok" }, `정답 ${my.correct}/${my.total || Q}`),
    ]) : null;
    const list = el("div", { class: "race-standings" }, rows.map(r => el("div", { class: `race-srow${r.sid === meId ? " me" : ""}` }, [
      el("span", {}, r.res ? String(r.rank) : "—"),
      el("span", { class: "race-dot", style: { background: COLORS[r.lane % 4].body } }),
      el("span", { class: "nm" }, `${r.rank === 1 ? "🏆 " : ""}${nameFn(r.sid)}`),
      el("span", { class: `tm${!r.res && ended ? " dnf" : ""}` }, r.res ? fmtClock(r.res.totalMs) : (ended ? "DNF" : "주행 중")),
    ])));
    card.replaceChildren(head, lapsRow, list);
  }

  function frame(dt) {
    if (!race || !race.group) {
      if (needDraw && !stage.hidden) { if (track.draw([], 0, false)) needDraw = false; }
      return;
    }
    const sim = logic() || mySim(tNow());
    const t = tNow();
    const live = act.phase === "running";
    const results = resultsMap(ctx.responses(), race.startedAt, race.rs);
    const cars = groupCars(race.group, t, { Q, laps, rs: race.rs, results, meId, mineSim: sim, nameFn });
    if (track.draw(cars, dt, live)) needDraw = false;

    // HUD
    const meCar = cars.find(c => c.me);
    const myRes = results.get(meId);
    const done = !!myRes || meCar?.done;
    const cross = sim.cross;
    hudLap.textContent = done ? "완주" : `LAP ${Math.min(laps, cross.length + 1)}/${laps}`;
    hudTime.textContent = fmtClock(done ? (myRes?.totalMs ?? sim.finishAt) : Math.max(0, t));
    const lapList = myRes?.lapMs?.length ? myRes.lapMs : lapsOf(cross);
    hudLast.textContent = lapList.length ? `지난 랩 ${fmtClock(lapList[lapList.length - 1])}` : "";

    // 카운트다운
    let txt = "";
    if (live && t < 0) txt = String(Math.ceil(-t / 1000));
    else if (live && t < 800) txt = "GO!";
    if (txt !== cdText) {
      cdText = txt;
      countEl.textContent = txt;
      countEl.classList.remove("pop");
      void countEl.offsetWidth;
      if (txt) countEl.classList.add("pop");
    }
    quizTimer();

    // 결과 카드
    const ended = act.phase === "ended";
    const showCard = done || ended;
    let sig = "";
    let rows = null;
    if (showCard) {
      rows = standings(race.group, results);
      sig = JSON.stringify([ended, rows.map(r => [r.sid, r.res?.totalMs ?? null, r.rank])]);
    }
    if (sig !== race.cardSig) {
      race.cardSig = sig;
      if (rows) renderCard(rows, ended);
      card.hidden = !showCard;
      layout();
    }
  }

  const loop = makeLoop(frame, () => (act.phase === "running" && !!race?.group) || track.busy() || needDraw);

  // 실시간 이벤트
  function onAnswerEvt(p) {
    if (!p || !p.sid || p.sid === meId || !(Number(p.k) >= 1)) return;
    if (p.slideId && p.slideId !== slide.id) return;
    const sa = Number(p.startedAt) || race?.startedAt;
    if (!sa) return;
    if (p.name) NAMES.set(p.sid, p.name);
    putAnswer(raceStore(`${slide.id}|${sa}`), p.sid, Number(p.k), { correct: !!p.correct, at: Number(p.at) || 0 });
    loop.kick();
  }
  function onFinishEvt(p) {
    if (!p || !p.sid || p.sid === meId) return;
    if (p.slideId && p.slideId !== slide.id) return;
    const sa = Number(p.startedAt) || race?.startedAt;
    if (!sa) return;
    if (p.name) NAMES.set(p.sid, p.name);
    raceStore(`${slide.id}|${sa}`).finishes.set(p.sid, p);
    loop.kick();
  }
  ctx.on("race:answer", onAnswerEvt);
  ctx.on("race:finish", onFinishEvt);
  // 다른 학생의 ping 에 대한 응답도 표본으로 쓴다
  ctx.on("race:clock", p => {
    if (!p) return;
    addClockSample(clock, Number(p.sentAt));
    needDraw = true;
    loop.kick();
  });

  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { layout(); loop.kick(); }) : null;
  ro?.observe(root);
  tk.every(() => { ping(); if (document.hidden) logic(); else loop.kick(); }, 1000);

  sync();
  ping();

  return {
    el: root,
    onActivity() { sync(); },
    onResponses() { checkMine(); needDraw = true; loop.kick(); },
    onSession() { needDraw = true; loop.kick(); }, // 이름 등 갱신(싸고 멱등)
    destroy() {
      loop.stop();
      ro?.disconnect();
      tk.clearAll();
    },
  };
}

// ── 교사 ──
function standingsTable(rows, { laps, Q, ended, nameFn, liveOf }) {
  const head = el("tr", {}, [
    el("th", {}, "순위"), el("th", {}, "이름"),
    ...Array.from({ length: laps }, (_, i) => el("th", {}, `LAP${i + 1}`)),
    el("th", {}, "합계"), el("th", {}, "정답"),
  ]);
  const body = rows.map(r => {
    const res = r.res;
    const live = !res && liveOf ? liveOf(r.sid) : null;
    const lapCells = Array.from({ length: laps }, (_, i) => {
      if (res) return el("td", {}, fmtClock(res.lapMs[i]));
      const ms = live?.lapMs?.[i];
      return el("td", { class: "run" }, ms != null ? fmtClock(ms) : "");
    });
    const total = res ? el("td", {}, fmtClock(res.totalMs))
      : ended ? el("td", { class: "dnf" }, "DNF")
      : el("td", { class: "run" }, live ? live.label : "주행 중");
    return el("tr", { class: r.rank === 1 && res ? "win" : "" }, [
      el("td", {}, res ? (r.rank === 1 ? "🏆" : String(r.rank)) : "—"),
      el("td", {}, [el("span", { class: "race-dot", style: { background: COLORS[r.lane % 4].body, marginRight: "6px" } }), nameFn(r.sid)]),
      ...lapCells,
      total,
      el("td", {}, res ? `${res.correct}/${res.total || Q}` : (live ? `${live.correct}/${Q}` : "")),
    ]);
  });
  return el("div", { class: "race-tbl-wrap" }, [el("table", { class: "race-table" }, [el("thead", {}, [head]), el("tbody", {}, body)])]);
}

function TeacherLive({ slide, ctx }) {
  ensureCss(ctx);
  const cfg = cfgOf(slide);
  const Q = cfg.questions.length, laps = cfg.laps;
  let act = ctx.activity() || { phase: "idle" };
  let race = null; // { key, startedAt, rs, groups, tiles, endTimer, panelSig }
  let needDraw = true, cdText = "", previewView = null, built = false;
  const tk = timerKit(ctx);
  const nameFn = sid => nameOf(ctx, sid);

  // 버튼 묶음 (스테이지 머리 + 패널에 같은 것)
  function makeControls() {
    const bStart = el("button", { class: "btn btn-sm btn-primary", type: "button", onClick: start }, "시작");
    const bEnd = el("button", { class: "btn btn-sm", type: "button", onClick: end }, "종료");
    const bAgain = el("button", { class: "btn btn-sm btn-ghost", type: "button", onClick: again }, "다시");
    const root = el("div", { class: "race-ctl" }, [bStart, bEnd, bAgain]);
    return {
      el: root,
      update() {
        bStart.hidden = act.phase !== "idle";
        bEnd.hidden = act.phase !== "running";
        bAgain.hidden = act.phase === "idle";
      },
    };
  }
  const ctl1 = makeControls(), ctl2 = makeControls();
  const statePill = el("span", { class: "pill" });
  const countPill = el("span", { class: "pill pill-muted" });
  const head = el("div", { class: "race-head" }, [
    el("span", { class: "race-title" }, slide.title || "레이싱 퀴즈"), statePill, countPill, el("span", { class: "race-sp" }), ctl1.el,
  ]);
  const grid = el("div", { class: "race-grid" });
  const countEl = el("div", { class: "race-count" });
  const wrap = el("div", { class: "race-grid-wrap" }, [grid, countEl]);
  const idleInfo = el("div", { class: "race-idle-info" });
  const root = el("div", { class: "race-live" }, [head, wrap, idleInfo]);
  const panelBody = el("div", { class: "race-panel" });
  const panel = el("div", { class: "race-panel" }, [ctl2.el, panelBody]);

  function rosterIds() {
    const parts = ctx.participants() || [];
    const on = ctx.online() || new Set();
    const ids = parts.filter(id => on.has(id));
    return ids.length ? ids : parts;
  }

  function start() {
    if (act.phase !== "idle") return;
    const gs = groupStudents(rosterIds(), 4);
    if (!gs.length) { ctx.toast("참여 학생이 없어요"); return; }
    const groups = gs.map((memberIds, i) => ({ id: `g${i + 1}`, name: `${i + 1}조`, memberIds }));
    ctx.setActivity({ phase: "running", startedAt: ctxNow(ctx) + COUNT_MS, endedAt: null, groups });
    sendClock();
  }
  // 학생 시계 보정용: race:ping 에 race:clock {sentAt} 응답(300ms 에 1회로 합침 — 모든 학생이 함께 받는다)
  let clockTm = null, lastClock = 0;
  function sendClock() {
    if (clockTm != null) { tk.cancel(clockTm); clockTm = null; }
    lastClock = Date.now();
    ctx.send("race:clock", { slideId: slide.id, sentAt: ctxNow(ctx) });
  }
  ctx.on("race:ping", () => {
    if (clockTm != null) return;
    const wait = lastClock + 300 - Date.now();
    if (wait <= 0) sendClock();
    else clockTm = tk.later(() => { clockTm = null; sendClock(); }, wait);
  });
  async function end() {
    if (act.phase !== "running") return;
    const res = race ? resultsMap(ctx.responses(), race.startedAt, race.rs) : new Map();
    const all = (act.groups || []).flatMap(g => g.memberIds || []);
    if (all.some(id => !res.has(id))) {
      const ok = await ctx.confirm("아직 달리는 학생이 있어요. 종료할까요?", { ok: "종료" });
      if (!ok || ctx.activity().phase !== "running") return;
    }
    ctx.setActivity({ phase: "ended", endedAt: ctxNow(ctx) });
  }
  async function again() {
    if (act.phase === "idle") return;
    const ok = await ctx.confirm("결과를 지우고 처음으로 돌릴까요?", { ok: "다시", danger: true });
    if (!ok) return;
    try { await ctx.clearResponses(); } catch (e) { console.warn("[race] clearResponses", e); }
    if (race) RACES.delete(race.key);
    ctx.setActivity({ phase: "idle", startedAt: null, endedAt: null, groups: [] });
  }

  const tNow = () => {
    const n = ctxNow(ctx);
    const endAt = act.phase === "ended" ? (Number(act.endedAt) || race.endSeen || n) : Infinity;
    return Math.min(n, endAt) - race.startedAt;
  };

  function buildTiles() {
    if (!race) {
      if (!previewView) previewView = new TrackView(() => ({ laps, Q }));
      grid.replaceChildren(el("div", { class: "race-tile" }, [previewView.canvas]));
      return;
    }
    race.tiles = race.groups.map(g => {
      const view = new TrackView(() => ({ laps, Q }));
      const labels = (g.memberIds || []).slice(0, 4).map(sid => ({ sid, node: el("span", {}, nameFn(sid)) }));
      const names = labels.map((l, lane) => el("span", { class: "mb" }, [
        el("span", { class: "race-dot", style: { background: COLORS[lane].body } }), l.node,
      ]));
      const tile = el("div", { class: "race-tile" }, [el("div", { class: "race-tile-h" }, [el("b", {}, g.name || g.id), ...names]), view.canvas]);
      return { group: g, view, el: tile, labels };
    });
    grid.replaceChildren(...race.tiles.map(t => t.el));
  }

  // 화면에 맞게 열 수·타일 폭 결정
  function fitGrid() {
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const n = race ? race.tiles.length : 1;
    if (!W || !n) return;
    const gap = 12, hh = race ? 35 : 0;
    let best = { c: 1, w: 0 };
    for (let c = 1; c <= n; c++) {
      const rows = Math.ceil(n / c);
      let w = (W - gap * (c - 1)) / c;
      if (H > 0) w = Math.min(w, ((H - gap * (rows - 1)) / rows - hh) * 1.6);
      if (w > best.w) best = { c, w };
    }
    const colW = (W - gap * (best.c - 1)) / best.c;
    const w = Math.floor(Math.max(Math.min(240, colW), best.w));
    grid.style.gridTemplateColumns = `repeat(${best.c}, ${w}px)`;
    needDraw = true;
  }

  function sync() {
    act = ctx.activity() || { phase: "idle" };
    const sa = act.phase !== "idle" ? Number(act.startedAt) || 0 : 0;
    const key = sa ? `${slide.id}|${sa}` : "";
    if (!built || (race?.key || "") !== key) {
      built = true;
      if (race?.endTimer != null) tk.cancel(race.endTimer);
      race = key ? { key, startedAt: sa, rs: raceStore(key), groups: (act.groups || []).filter(g => (g.memberIds || []).length), tiles: [], endTimer: null, panelSig: "" } : null;
      buildTiles();
      fitGrid();
    }
    if (race) race.endSeen = act.phase === "ended" ? (race.endSeen ?? ctxNow(ctx)) : null; // endedAt 없을 때 멈출 시각
    paintHead();
    renderPanel(true);
    needDraw = true;
    loop.kick();
  }

  function paintHead() {
    ctl1.update(); ctl2.update();
    const ph = act.phase;
    statePill.className = `pill ${ph === "running" ? "pill-live" : ph === "ended" ? "pill-muted" : ""}`;
    statePill.textContent = ph === "running" ? "진행 중" : ph === "ended" ? "끝남" : "대기";
    if (race) {
      const all = race.groups.flatMap(g => g.memberIds || []);
      const res = resultsMap(ctx.responses(), race.startedAt, race.rs);
      countPill.textContent = `완주 ${all.filter(id => res.has(id)).length}/${all.length}`;
    } else {
      countPill.textContent = `참여 ${rosterIds().length}명`;
    }
    idleInfo.hidden = !!race;
    if (!race) {
      const t = `참여 ${rosterIds().length}명 · 시작을 누르면 조가 편성돼요`;
      if (idleInfo.textContent !== t) idleInfo.textContent = t;
    }
  }

  function liveInfo(t) {
    const map = new Map();
    for (const g of race.groups) for (const sid of g.memberIds || []) {
      const m = race.rs.answers.get(sid);
      const s = simulate(t, Q, laps, k => m?.get(k) || null, GUESS_MS);
      map.set(sid, {
        lapMs: lapsOf(s.cross), correct: s.correct,
        label: s.mode === "grid" ? "출발 전" : s.mode === "done" ? "결승" : `LAP ${Math.min(laps, s.cross.length + 1)}`,
      });
    }
    return map;
  }

  function renderPanel(force = false) {
    if (!race) {
      panelBody.replaceChildren(el("div", { class: "empty" }, "시작하면 4명씩 조가 만들어져요"));
      return;
    }
    const ended = act.phase === "ended";
    const results = resultsMap(ctx.responses(), race.startedAt, race.rs);
    const live = liveInfo(tNow());
    const blocks = race.groups.map(g => ({ g, rows: standings(g, results) }));
    const sig = JSON.stringify([ended, blocks.map(b => b.rows.map(r => [r.sid, nameFn(r.sid), r.res?.totalMs ?? null, live.get(r.sid)?.label, live.get(r.sid)?.correct]))]);
    if (!force && sig === race.panelSig) return;
    race.panelSig = sig;
    panelBody.replaceChildren(...blocks.map(({ g, rows }) => el("div", { class: "race-gblock" }, [
      el("div", { class: "race-gt" }, g.name || g.id),
      standingsTable(rows, { laps, Q, ended, nameFn, liveOf: sid => live.get(sid) }),
    ])));
  }

  // 배정 학생 전원 완주 → 3초 뒤 종료
  function checkAutoEnd() {
    if (!race || act.phase !== "running" || race.endTimer != null) return;
    const all = race.groups.flatMap(g => g.memberIds || []);
    if (!all.length) return;
    const res = resultsMap(ctx.responses(), race.startedAt, race.rs);
    if (!all.every(id => res.has(id))) return;
    const r = race;
    const fire = () => {
      r.endTimer = null;
      const a = ctx.activity();
      if (a.phase === "running" && Number(a.startedAt) === r.startedAt) ctx.setActivity({ phase: "ended", endedAt: ctxNow(ctx) });
    };
    r.endTimer = tk.later(fire, END_DELAY);
  }

  function frame(dt) {
    if (!race) {
      if (needDraw && previewView?.draw([], 0, false)) needDraw = false;
      return;
    }
    const t = tNow();
    const liveRun = act.phase === "running";
    const results = resultsMap(ctx.responses(), race.startedAt, race.rs);
    let drawn = true;
    for (const tile of race.tiles) {
      const cars = groupCars(tile.group, t, { Q, laps, rs: race.rs, results, nameFn });
      drawn = tile.view.draw(cars, dt, liveRun) && drawn;
    }
    if (drawn) needDraw = false;
    let txt = "";
    if (liveRun && t < 0) txt = String(Math.ceil(-t / 1000));
    else if (liveRun && t < 800) txt = "GO!";
    if (txt !== cdText) {
      cdText = txt;
      countEl.textContent = txt;
      countEl.classList.remove("pop");
      void countEl.offsetWidth;
      if (txt) countEl.classList.add("pop");
    }
  }
  const busy = () => !!race?.tiles?.some(t => t.view.busy());
  const loop = makeLoop(frame, () => (act.phase === "running" && !!race) || busy() || needDraw);

  function onEvt() { paintHead(); renderPanel(); checkAutoEnd(); loop.kick(); }
  ctx.on("race:answer", p => {
    if (!p || !p.sid || !(Number(p.k) >= 1)) return;
    if (p.slideId && p.slideId !== slide.id) return;
    const sa = Number(p.startedAt) || race?.startedAt;
    if (!sa) return;
    if (p.name) NAMES.set(p.sid, p.name);
    putAnswer(raceStore(`${slide.id}|${sa}`), p.sid, Number(p.k), { correct: !!p.correct, at: Number(p.at) || 0 });
    onEvt();
  });
  ctx.on("race:finish", p => {
    if (!p || !p.sid) return;
    if (p.slideId && p.slideId !== slide.id) return;
    const sa = Number(p.startedAt) || race?.startedAt;
    if (!sa) return;
    if (p.name) NAMES.set(p.sid, p.name);
    raceStore(`${slide.id}|${sa}`).finishes.set(p.sid, p);
    onEvt();
  });

  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { fitGrid(); loop.kick(); }) : null;
  ro?.observe(wrap);
  tk.every(() => {
    if (act.phase === "running") { paintHead(); renderPanel(); checkAutoEnd(); }
    loop.kick();
  }, 1000);

  sync();

  return {
    el: root,
    panel,
    onActivity() { sync(); },
    onResponses() { paintHead(); renderPanel(); checkAutoEnd(); needDraw = true; loop.kick(); },
    onSession() {
      paintHead();
      renderPanel();
      // 학생 정보가 늦게 들어오면 이름표 갱신(싸고 멱등)
      for (const t of race?.tiles || []) for (const l of t.labels || []) { const n = nameFn(l.sid); if (l.node.textContent !== n) l.node.textContent = n; }
    },
    destroy() {
      loop.stop();
      ro?.disconnect();
      if (race?.endTimer != null) tk.cancel(race.endTimer);
      tk.clearAll();
    },
  };
}

// ── 기록 요약 ──
function summary(slide, responses = [], session, ctx) {
  ensureCss(ctx);
  const cfg = cfgOf(slide);
  const a = session?.activity?.[slide.id] || {};
  const sa = Number(a.startedAt) || 0;
  const results = resultsMap(responses, sa, null);
  let groups = (a.groups || []).filter(g => (g.memberIds || []).length);
  if (!groups.length && results.size) {
    const by = new Map();
    for (const [sid, r] of results) {
      const gid = r.gid || "g1";
      if (!by.has(gid)) by.set(gid, []);
      by.get(gid).push(sid);
    }
    groups = [...by].map(([id, memberIds], i) => ({ id, name: `${i + 1}조`, memberIds }));
  }
  if (!groups.length) return el("div", { class: "empty" }, "경기 기록이 없어요");
  // 학생 '내 기록': 내 응답만 넘어오므로 조 순위 대신 내 결과만
  if (ctx && ctx.isTeacher === false) {
    const meId = ctx.me?.id;
    const my = results.get(meId) || (results.size === 1 ? [...results.values()][0] : null);
    if (!my) {
      const inRace = groups.some(g => (g.memberIds || []).includes(meId));
      return el("div", { class: "empty" }, inRace ? "완주하지 못했어요" : "경기 기록이 없어요");
    }
    return el("div", { class: "race-sum" }, [
      el("div", { class: "race-laps" }, [
        ...my.lapMs.map((ms, i) => el("span", { class: "pill" }, `LAP ${i + 1} ${fmtClock(ms)}`)),
        el("span", { class: "pill" }, `합계 ${fmtClock(my.totalMs)}`),
        el("span", { class: "pill pill-ok" }, `정답 ${my.correct}/${my.total || cfg.questions.length}`),
      ]),
    ]);
  }
  const all = groups.flatMap(g => g.memberIds);
  const nameFn = sid => nameOf(ctx, sid);
  return el("div", { class: "race-sum" }, [
    el("div", { class: "race-sum-meta" }, [
      el("span", { class: "pill pill-muted" }, `${cfg.laps}바퀴 · 문제 ${cfg.questions.length}`),
      el("span", { class: "pill pill-ok" }, `완주 ${all.filter(id => results.has(id)).length}/${all.length}`),
    ]),
    ...groups.map(g => el("div", { class: "race-gblock" }, [
      el("div", { class: "race-gt" }, g.name || g.id),
      standingsTable(standings(g, results), { laps: cfg.laps, Q: cfg.questions.length, ended: true, nameFn, liveOf: null }),
    ])),
  ]);
}

registerSlideType({
  type: "race",
  category: "game",
  label: "레이싱 퀴즈",
  desc: "문제를 풀며 조별로 달리는 레이스",
  icon: ICON,
  create() { return { type: "race", config: { questions: [], laps: 2 } }; },
  thumb(slide) {
    const n = (slide.config?.questions || []).length;
    return el("div", { class: "thumb-generic" }, [
      el("span", { class: "thumb-icon", html: ICON }),
      el("span", { class: "thumb-title" }, slide.title || (n ? `레이싱 퀴즈 · ${n}문제` : "레이싱 퀴즈")),
    ]);
  },
  Editor,
  Student,
  TeacherLive,
  summary,
  validate(slide) {
    const c = cfgOf(slide);
    if (!c.questions.length) return "문제를 1개 이상 만드세요";
    for (const q of c.questions) {
      if (!q.question.trim()) return "빈 문제가 있어요";
      if (q.options.some(o => !o.text.trim())) return "빈 선택지가 있어요";
      if (!q.answerId) return "정답을 선택하세요";
    }
    return null;
  },
});

// 테스트·다른 모듈용 (순수 함수)
export { simulate, cfgOf };
