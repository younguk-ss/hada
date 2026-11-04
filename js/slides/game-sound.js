// 게임 효과음(v2.11) — 레이싱 퀴즈·공룡 점프 공용. 소리 파일 없이 Web Audio로 그때그때 만든다(내려받기 없음·저사양 기기 부담 작음).
// 배경음악: 짧은 반복 악구(레이싱 = 경쾌한 베이스+아르페지오, 공룡 = 가벼운 8비트). 효과음: 부스터 · 미끄러짐 · 결승 · 카운트다운 ·
// 정답·오답 · 점프 · 충돌. 모두 작게(전체 음량 0.5 × 소리별 0.03~0.16) — 교실에서 여러 기기가 함께 울려도 거슬리지 않게.
// 음소거: 기기마다 localStorage 'hada:gameSound' = 'off'. soundToggle() 버튼(🔊/🔇)은 화면의 모든 토글과 함께 바뀐다.
// 가정: 브라우저는 사용자가 한 번 누르기 전에는 소리를 막는다 → 게임 화면이 붙어 있는 동안 첫 탭·키에서 AudioContext를 깨운다(attach/detach).
//       깨우기 전 요청은 조용히 버린다(배경음악은 깨운 뒤 이어서 시작). 탭이 숨겨지면 배경음악을 멈추고 돌아오면 다시.
import { el } from "../ui.js";

const KEY = "hada:gameSound";
const MASTER = 0.5;
let ac = null, master = null, noiseBuf = null;
let muted = (() => { try { return localStorage.getItem(KEY) === "off"; } catch { return false; } })();
const toggles = new Set();
let users = 0;

function ctx() {
  if (ac) return ac;
  const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  try {
    ac = new AC();
    master = ac.createGain();
    master.gain.value = muted ? 0 : MASTER;
    master.connect(ac.destination);
  } catch (_) { ac = null; }
  return ac;
}
const ready = () => !!ac && ac.state === "running" && !muted;
function unlock() {
  const c = ctx();
  if (c && c.state === "suspended") c.resume().then(() => { if (want) startBgm(want); }).catch(() => {});
  else if (c && want && !timer) startBgm(want);
}
const onGesture = () => unlock();
function onVis() {
  if (document.hidden) stopTimer();
  else if (want && ready()) startBgm(want);
}
// 게임 화면이 붙을 때·뗄 때(첫 탭에서 소리를 깨우는 감시를 켜고 끈다)
export function attach() {
  if (users++ === 0) {
    window.addEventListener("pointerdown", onGesture, { capture: true, passive: true });
    window.addEventListener("keydown", onGesture, { capture: true });
    document.addEventListener("visibilitychange", onVis);
  }
}
export function detach() {
  if (users <= 0) return;
  if (--users === 0) {
    window.removeEventListener("pointerdown", onGesture, { capture: true });
    window.removeEventListener("keydown", onGesture, { capture: true });
    document.removeEventListener("visibilitychange", onVis);
    bgm(null);
  }
}

export function isMuted() { return muted; }
export function setMuted(v) {
  muted = !!v;
  try { localStorage.setItem(KEY, muted ? "off" : "on"); } catch {}
  if (master && ac) master.gain.setTargetAtTime(muted ? 0 : MASTER, ac.currentTime, 0.03);
  if (muted) stopTimer(); else { unlock(); if (want && ready()) startBgm(want); }
  for (const t of toggles) t.sync();
}

// ── 소리 만들기 ──
function noise() {
  if (noiseBuf) return noiseBuf;
  const n = Math.floor(ac.sampleRate * 1.2);
  noiseBuf = ac.createBuffer(1, n, ac.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}
// 음 하나: f(Hz) → f2로 미끄러지며, at초 뒤 dur초 동안, vol 크기
function tone({ f, f2 = null, at = 0, dur = 0.15, type = "sine", vol = 0.1, attack = 0.008 }) {
  const t = ac.currentTime + at;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.05);
}
// 잡음(쉭·끼익): 대역 필터 f → f2, q, dur초
function hiss({ f = 1200, f2 = null, q = 1, at = 0, dur = 0.4, vol = 0.08, wobble = 0 }) {
  const t = ac.currentTime + at;
  const s = ac.createBufferSource(), bp = ac.createBiquadFilter(), g = ac.createGain();
  s.buffer = noise();
  bp.type = "bandpass"; bp.Q.value = q;
  bp.frequency.setValueAtTime(f, t);
  if (f2) bp.frequency.exponentialRampToValueAtTime(f2, t + dur);
  if (wobble) { // 타이어 끼익: 필터 주파수를 빠르게 떨게
    const lfo = ac.createOscillator(), lg = ac.createGain();
    lfo.frequency.value = wobble; lg.gain.value = f * 0.18;
    lfo.connect(lg); lg.connect(bp.frequency);
    lfo.start(t); lfo.stop(t + dur + 0.05);
  }
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(bp); bp.connect(g); g.connect(master);
  s.start(t, Math.random() * 0.3); s.stop(t + dur + 0.05);
}

const FX = {
  // 부스터: 위로 쓸어 올리는 쉭 + 올라가는 음
  boost() {
    hiss({ f: 500, f2: 3200, q: 1.4, dur: 0.6, vol: 0.12 });
    tone({ f: 220, f2: 880, dur: 0.5, type: "sawtooth", vol: 0.035 });
    tone({ f: 660, f2: 1320, at: 0.08, dur: 0.35, type: "triangle", vol: 0.05 });
  },
  // 미끄러짐: 타이어 끼익 + 내려가는 음(미끄러지는 시간과 비슷하게)
  slip() {
    hiss({ f: 2600, f2: 1100, q: 6, dur: 1.7, vol: 0.07, wobble: 22 });
    tone({ f: 520, f2: 110, dur: 1.4, type: "triangle", vol: 0.06 });
  },
  // 콤보(연속 정답): 부스터 + 올라가는 세 음
  combo() {
    hiss({ f: 600, f2: 3600, q: 1.4, dur: 0.6, vol: 0.12 });
    [784, 988, 1319].forEach((f, i) => tone({ f, at: i * 0.07, dur: 0.14, type: "square", vol: 0.04 }));
    tone({ f: 330, f2: 990, dur: 0.45, type: "sawtooth", vol: 0.03 });
  },
  // 결승: 짧은 팡파르
  finish() {
    [523, 659, 784].forEach((f, i) => tone({ f, at: i * 0.11, dur: 0.16, type: "square", vol: 0.045 }));
    [1047, 1319].forEach(f => tone({ f, at: 0.34, dur: 0.6, type: "triangle", vol: 0.07 }));
    tone({ f: 523, at: 0.34, dur: 0.6, type: "triangle", vol: 0.05 });
  },
  // 다른 사람이 결승(교사 화면)
  finishSoft() {
    tone({ f: 988, dur: 0.12, type: "triangle", vol: 0.05 });
    tone({ f: 1319, at: 0.1, dur: 0.25, type: "triangle", vol: 0.05 });
  },
  count() { tone({ f: 440, dur: 0.14, type: "square", vol: 0.04 }); },
  go() { tone({ f: 880, dur: 0.35, type: "square", vol: 0.05 }); },
  correct() {
    tone({ f: 784, dur: 0.12, type: "triangle", vol: 0.08 });
    tone({ f: 1175, at: 0.1, dur: 0.22, type: "triangle", vol: 0.08 });
  },
  wrong() {
    tone({ f: 330, dur: 0.16, type: "triangle", vol: 0.07 });
    tone({ f: 233, at: 0.14, dur: 0.28, type: "triangle", vol: 0.07 });
  },
  jump() { tone({ f: 380, f2: 760, dur: 0.12, type: "square", vol: 0.025 }); },
  hit() {
    tone({ f: 150, f2: 55, dur: 0.22, type: "sine", vol: 0.12 });
    hiss({ f: 400, q: 0.8, dur: 0.12, vol: 0.05 });
  },
};
export function play(name) {
  if (!ready()) return;
  try { FX[name]?.(); } catch (e) { console.warn("[sound]", name, e); }
}

// ── 배경음악(반복 악구, 앞을 내다보고 예약) ──
const SONGS = {
  // 레이싱: 140bpm, 8분음표. 베이스(삼각파) + 위 아르페지오(사각파, 아주 작게)
  race: { step: 60 / 140 / 2, bass: [110, 110, 165, 110, 131, 131, 196, 131, 98, 98, 147, 98, 123, 123, 185, 147],
    lead: [440, 0, 659, 0, 523, 0, 784, 659, 392, 0, 587, 0, 494, 587, 740, 0], bassVol: 0.05, leadVol: 0.018 },
  // 공룡: 120bpm, 가벼운 8비트
  dino: { step: 60 / 120 / 2, bass: [131, 0, 196, 0, 175, 0, 196, 0, 147, 0, 220, 0, 196, 0, 175, 0],
    lead: [523, 659, 784, 659, 587, 698, 880, 698, 494, 587, 784, 587, 523, 659, 784, 1047], bassVol: 0.045, leadVol: 0.014 },
};
let want = null, timer = null, nextAt = 0, idx = 0, song = null;
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
function startBgm(name) {
  if (!ready() || document.hidden) return;
  if (timer && song === SONGS[name]) return;
  stopTimer();
  song = SONGS[name];
  if (!song) return;
  nextAt = ac.currentTime + 0.1; idx = 0;
  const tick = () => {
    if (!ready()) { stopTimer(); return; }
    while (nextAt < ac.currentTime + 0.35) {
      const at = nextAt - ac.currentTime, b = song.bass[idx % song.bass.length], l = song.lead[idx % song.lead.length];
      if (b) tone({ f: b, at, dur: song.step * 0.9, type: "triangle", vol: song.bassVol });
      if (l) tone({ f: l, at, dur: song.step * 0.6, type: "square", vol: song.leadVol });
      nextAt += song.step; idx++;
    }
  };
  tick();
  timer = setInterval(tick, 120);
}
// 배경음악 켜기(이름)·끄기(null). 여러 번 불러도 같은 상태면 아무 일 없음
export function bgm(name) {
  if (name === want) { if (name && !timer) startBgm(name); return; }
  want = name || null;
  if (!want) { stopTimer(); return; }
  startBgm(want);
}

// ── 🔊/🔇 버튼 ──
const SVG_ON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 010 7"/><path d="M19 6a8.5 8.5 0 010 12"/></svg>';
const SVG_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>';
export function soundToggle({ className = "btn btn-sm btn-icon" } = {}) {
  const b = el("button", { type: "button", class: className + " gs-toggle" });
  b.sync = () => {
    const t = muted ? "소리 켜기" : "소리 끄기";
    b.innerHTML = muted ? SVG_OFF : SVG_ON;
    b.title = t;
    b.setAttribute("aria-label", t);
    b.setAttribute("aria-pressed", String(muted));
    b.classList.toggle("is-muted", muted);
  };
  b.addEventListener("click", (e) => { e.stopPropagation(); setMuted(!muted); });
  b.sync();
  toggles.add(b);
  b.release = () => toggles.delete(b);
  return b;
}
