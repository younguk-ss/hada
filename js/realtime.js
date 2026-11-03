// 세션 실시간 채널: broadcast + presence (토픽 rt:session:<id>, cloud.js의 db: 채널과 분리)
// 로컬 모드: BroadcastChannel('hada-rt:<id>') + 간이 presence(heartbeat)
// 가정: 같은 탭에서 같은 세션을 여러 번 join하면 하나의 실제 채널을 공유한다(참조 카운트).
//       마지막 leave 후 1.5초 동안은 채널을 유지해 라우트 재진입 시 재구독을 피한다.
// 가정: 코어 이벤트는 여기서 자동 처리한다 —
//       'session:patch' 수신 → cloud.applySessionPatch (rev 비교),
//       'session:hello' 수신(교사) → 현재 상태 전체를 'session:patch'로 응답(300ms 묶음),
//       학생은 구독 완료(재연결 포함)마다 'session:hello' 자동 송신,
//       'responses:del' 수신 → cloud.applyResponseDelete.
// 가정: 교사 시계 — 'session:patch'의 sentAt(교사 Date.now())으로 표본 offset = sentAt - 로컬 now를 세션별 최근 8개 보관,
//       추정 offset = max(표본)(지연이 가장 작은 표본). teacherNow(id) = Date.now() + offset (표본 없음·교사 본인이면 0).
// 가정(v2.13): recent() = 접속 중 ∪ 끊긴 지 AWAY_MS 안 된 학생 — 교사 화면의 '접속 중 먼저' 순서용. 태블릿이 잠깐 잠들거나
//       와이파이가 끊겼다 붙어도 목록이 아래·위로 출렁이지 않게. 점(접속 표시)은 online() 그대로. 유예가 끝나면 presence 알림을 한 번 더 보낸다.
import { cloudEnabled, clientReady, supaClient, clientId, applySessionPatch, sessionHelloState, applyResponseDelete, ensureStudentsLoaded } from "./cloud.js";
import { store } from "./store.js";

const cores = new Map(); // sessionId → core
let current = null;      // 최근 join한 handle

const BUDGET = 20;       // 송신 ≤ 20 msg/s
const AWAY_MS = 10000;   // 끊긴 학생을 '접속 중' 순서에 남겨 두는 시간

const clockSamples = new Map(); // sessionId → [offset, ...] (최근 8개)
function addClockSample(sessionId, sentAt) {
  if (typeof sentAt !== "number" || !isFinite(sentAt)) return;
  const arr = clockSamples.get(sessionId) || [];
  arr.push(sentAt - Date.now());
  if (arr.length > 8) arr.splice(0, arr.length - 8);
  clockSamples.set(sessionId, arr);
}

// 교사 시계 기준 현재 시각 (교사 본인·표본 없음 → Date.now())
export function teacherNow(sessionId) {
  const core = cores.get(sessionId);
  if (core && core.me.role === "teacher") return Date.now();
  const arr = clockSamples.get(sessionId);
  return Date.now() + (arr && arr.length ? Math.max(...arr) : 0);
}

function createCore(sessionId, me) {
  const core = {
    sessionId, me, refs: 0, dead: false,
    listeners: new Map(),      // event → Set<cb>
    presenceCbs: new Set(),
    online: new Set(),
    recent: new Set(),         // online ∪ 방금 끊긴 학생(AWAY_MS 안)
    away: new Map(),           // 끊긴 학생 id → 끊긴 시각
    awayTimer: null,
    queue: [],                 // 구독 전/예산 초과 송신 대기
    sentAt: [],
    joined: false, tracked: false,
    ch: null, bc: null, local: false,
    peers: new Map(),          // 로컬 presence: id → {info, seen}
    timers: [],
    leaveTimer: null, presTimer: null, helloTimer: null, pumpTimer: null,
  };

  core.emit = (event, payload) => {
    const set = core.listeners.get(event);
    if (!set) return;
    [...set].forEach(cb => { try { cb(payload); } catch (e) { console.error("[realtime] listener 오류:", event, e); } });
  };

  core.addListener = (event, cb) => {
    if (!core.listeners.has(event)) core.listeners.set(event, new Set());
    core.listeners.get(event).add(cb);
    return () => core.listeners.get(event)?.delete(cb);
  };

  // presence 갱신 (100ms 디바운스)
  core.presenceChanged = () => {
    clearTimeout(core.presTimer);
    core.presTimer = setTimeout(() => {
      if (core.dead) return;
      const ids = new Set();
      if (core.local) {
        const now = Date.now();
        for (const [id, p] of core.peers) {
          if (now - p.seen > 20000) { core.peers.delete(id); continue; }
          if (p.info?.role === "student") ids.add(id);
        }
      } else if (core.ch) {
        const st = core.ch.presenceState() || {};
        for (const [key, metas] of Object.entries(st)) {
          const m = (metas || [])[0];
          if (m && m.role === "student") ids.add(m.id || key);
        }
      }
      const now = Date.now();
      for (const id of core.online) if (!ids.has(id)) core.away.set(id, now);
      const recent = new Set(ids);
      let wake = Infinity;
      for (const [id, t] of core.away) {
        if (ids.has(id) || now - t >= AWAY_MS) { core.away.delete(id); continue; }
        recent.add(id);
        wake = Math.min(wake, t + AWAY_MS - now);
      }
      core.online = ids;
      core.recent = recent;
      clearTimeout(core.awayTimer);
      core.awayTimer = wake < Infinity ? setTimeout(() => core.presenceChanged(), wake + 20) : null;
      // 교사: presence에만 있는(참여 행이 아직 안 보인) 학생도 이름이 보이게 1회 조회
      if (core.me.role === "teacher" && !core.local) { try { ensureStudentsLoaded(ids); } catch (_) {} }
      [...core.presenceCbs].forEach(cb => { try { cb(ids); } catch (e) { console.error("[realtime] presence 오류:", e); } });
    }, 100);
  };

  // 송신: 예산 안에서 즉시, 넘치면 대기열
  core.rawSend = (event, payload) => {
    if (core.local) {
      try { core.bc.postMessage({ event, payload, from: clientId() }); } catch (e) { console.warn("[realtime] 로컬 송신 실패:", e); }
      return;
    }
    core.ch.send({ type: "broadcast", event, payload }).catch?.(e => console.warn("[realtime] 송신 실패:", event, e));
  };
  core.pump = () => {
    clearTimeout(core.pumpTimer);
    core.pumpTimer = null;
    if (core.dead || (!core.local && !core.joined)) return;
    const now = Date.now();
    core.sentAt = core.sentAt.filter(t => now - t < 1000);
    while (core.queue.length && core.sentAt.length < BUDGET) {
      const { event, payload } = core.queue.shift();
      core.sentAt.push(now);
      core.rawSend(event, payload);
    }
    if (core.queue.length) core.pumpTimer = setTimeout(core.pump, 100);
  };
  core.send = (event, payload = {}) => {
    if (core.dead) return;
    core.queue.push({ event, payload });
    if (core.queue.length > 60) core.queue.splice(0, core.queue.length - 60);
    core.pump();
  };

  // 코어 이벤트 자동 처리
  core.addListener("session:patch", (p) => {
    if (core.me.role !== "teacher" && p) addClockSample(sessionId, p.sentAt);
    try { applySessionPatch(sessionId, p); } catch (e) { console.error(e); }
  });
  core.addListener("responses:del", (p) => { try { applyResponseDelete(p); } catch (e) { console.error(e); } });
  core.addListener("session:hello", () => {
    if (core.me.role !== "teacher") return;
    clearTimeout(core.helloTimer);
    core.helloTimer = setTimeout(() => {
      const st = sessionHelloState(sessionId);
      if (st) core.send("session:patch", st);
    }, 300);
  });
  core.onSubscribed = () => {
    if (core.me.role === "student") core.send("session:hello", { id: core.me.id });
    core.pump();
  };

  start(core);
  return core;
}

async function start(core) {
  // 클라우드 설정이 없으면 바로 로컬. 있으면 클라이언트 생성까지만 대기(부팅 조회는 기다리지 않음)
  let ok = false;
  if (store.cloudMode || cloudEnabled()) { try { ok = await clientReady; } catch (_) { ok = false; } }
  if (core.dead) return;
  const supa = ok && cloudEnabled() ? supaClient() : null;
  if (!supa) { startLocal(core); return; }

  const me = core.me;
  const ch = supa.channel(`rt:session:${core.sessionId}`, {
    config: { broadcast: { self: false, ack: false }, presence: { key: me.id } },
  });
  core.ch = ch;
  ch.on("broadcast", { event: "*" }, (msg) => core.emit(msg.event, msg.payload || {}));
  ch.on("presence", { event: "sync" }, () => core.presenceChanged());
  ch.subscribe(async (status) => {
    if (core.dead) return;
    if (status === "SUBSCRIBED") {
      core.joined = true;
      if (!core.tracked) {
        core.tracked = true; // SUBSCRIBED 직후 1회 (재연결 시 다시 1회)
        try { await ch.track({ id: me.id, name: me.name || "", role: me.role }); } catch (e) { console.warn("[realtime] track 실패:", e); }
      }
      core.onSubscribed();
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      core.joined = false;
      core.tracked = false;
      if (status !== "CLOSED") console.warn("[realtime] 채널 상태:", status);
    }
  });
}

function startLocal(core) {
  core.local = true;
  if (typeof BroadcastChannel === "undefined") { core.onSubscribed(); return; }
  const bc = new BroadcastChannel("hada-rt:" + core.sessionId);
  core.bc = bc;
  const me = core.me;
  const info = { id: me.id, name: me.name || "", role: me.role };
  const post = (m) => { try { bc.postMessage({ ...m, from: clientId() }); } catch (_) {} };
  bc.onmessage = (ev) => {
    const m = ev.data;
    if (!m || m.from === clientId() || core.dead) return;
    if (m.p) {
      if (m.p === "bye") core.peers.delete(m.id);
      else {
        core.peers.set(m.me.id, { info: m.me, seen: Date.now() });
        if (m.p === "hello") post({ p: "here", me: info });
      }
      core.presenceChanged();
      return;
    }
    core.emit(m.event, m.payload || {});
  };
  post({ p: "hello", me: info });
  core.timers.push(setInterval(() => { post({ p: "here", me: info }); core.presenceChanged(); }, 8000));
  core.bye = () => post({ p: "bye", id: me.id });
  core.onSubscribed();
}

function destroyCore(core) {
  if (core.dead) return;
  core.dead = true;
  clearTimeout(core.leaveTimer); clearTimeout(core.presTimer); clearTimeout(core.helloTimer); clearTimeout(core.pumpTimer); clearTimeout(core.awayTimer);
  core.timers.forEach(t => clearInterval(t));
  if (cores.get(core.sessionId) === core) cores.delete(core.sessionId);
  if (core.local) {
    try { core.bye && core.bye(); } catch (_) {}
    try { core.bc && core.bc.close(); } catch (_) {}
  } else if (core.ch) {
    const supa = supaClient();
    const ch = core.ch;
    Promise.resolve().then(async () => {
      try { await ch.untrack(); } catch (_) {}
      try { supa ? await supa.removeChannel(ch) : await ch.unsubscribe(); } catch (_) {}
    });
  }
  core.listeners.clear();
  core.presenceCbs.clear();
}

function makeHandle(core) {
  const offs = new Set();
  let left = false;
  const h = {
    sessionId: core.sessionId,
    me: core.me,
    send(event, payload) { if (!left) core.send(event, payload); },
    on(event, cb) {
      if (left) return () => {};
      const off = core.addListener(event, cb);
      offs.add(off);
      return () => { off(); offs.delete(off); };
    },
    online() { return core.online; },
    recent() { return core.recent; },
    now() { return teacherNow(core.sessionId); },
    onPresence(cb) {
      if (left) return () => {};
      core.presenceCbs.add(cb);
      const off = () => core.presenceCbs.delete(cb);
      offs.add(off);
      return () => { off(); offs.delete(off); };
    },
    leave() {
      if (left) return;
      left = true;
      offs.forEach(f => f());
      offs.clear();
      if (current === h) current = null;
      core.refs = Math.max(0, core.refs - 1);
      if (core.refs === 0) {
        clearTimeout(core.leaveTimer);
        core.leaveTimer = setTimeout(() => { if (core.refs === 0) destroyCore(core); }, 1500);
      }
    },
  };
  return h;
}

// 세션 채널 참가. me = {id, name, role:'teacher'|'student'}
export function joinSessionChannel(sessionId, me) {
  let core = cores.get(sessionId);
  if (core && (core.dead || core.me.id !== me.id || core.me.role !== me.role)) { destroyCore(core); core = null; }
  if (!core) { core = createCore(sessionId, { ...me }); cores.set(sessionId, core); }
  clearTimeout(core.leaveTimer);
  core.refs++;
  const h = makeHandle(core);
  current = h;
  return h;
}

// 현재 세션 채널 (host·patchSession이 사용)
export function currentChannel() {
  return current;
}

// 페이지를 떠날 때 로컬 presence 정리
window.addEventListener("pagehide", () => {
  for (const core of cores.values()) if (core.local && core.bye) core.bye();
});
