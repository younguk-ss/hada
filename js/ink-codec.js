// 필기 획 압축 (v2.18.2) — DB·실시간으로 오가는 획만 줄인다. 화면·메모리의 Stroke 모양은 그대로({ points: [{x,y,p}] }).
//
// 왜: 점 하나가 JSON으로 {"x":0.5377,"y":0.1799,"p":0.08}(약 32바이트)라서, 확대해서 작게 쓴 논설문 6줄이
//     한 쪽 700 KB를 넘었다(획 1,000~1,500개). 저장할 때마다 쪽 전체를 다시 보내므로 DB가 버티지 못했다.
// 형식: stroke.points 대신 stroke.pz(문자열). 첫 글자 = 종류 — 'P' = x,y,p / 'Q' = x,y(압력은 모두 0.5).
//       x·y는 1/10000, p는 1/100 단위 정수(캔버스가 저장하던 자릿수 그대로 → 되돌리면 같은 값).
//       첫 점은 그 값, 다음 점부터는 앞 점과의 차이. 값마다 zigzag(음수 → 홀수) 후 5비트씩 base64url 한 글자
//       (글자 값 32 이상 = 다음 글자가 이어짐). 확대해서 쓴 글씨는 점 하나가 보통 3글자 → 약 10배 작다.
// 이전 버전 화면은 points가 없는 획을 건너뛴다(죽지 않음) — 새로 고치면 다시 보인다.
// 가정: 값이 이상한 획(숫자가 아닌 좌표 등)은 압축하지 않고 그대로 둔다. 풀 수 없는 pz는 점 없는 획(그리지 않음)으로 둔다.

const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const IDX = new Int16Array(128).fill(-1);
for (let i = 0; i < ABC.length; i++) IDX[ABC.charCodeAt(i)] = i;
const MAXQ = 2 ** 40; // 이보다 큰 정수는 압축하지 않음(안전한 정수 범위 안)

function put(out, n) {
  let v = n >= 0 ? n * 2 : -n * 2 - 1;
  while (v >= 32) { out.push(ABC[32 + (v % 32)]); v = Math.floor(v / 32); }
  out.push(ABC[v]);
}

// 점 배열 → 문자열 | null(압축할 수 없음)
export function encodePoints(points) {
  if (!Array.isArray(points) || !points.length) return null;
  const n = points.length;
  const q = new Array(n * 3);
  let anyP = false;
  for (let i = 0; i < n; i++) {
    const pt = points[i];
    if (!pt) return null;
    const x = Math.round(pt.x * 10000), y = Math.round(pt.y * 10000);
    const p = Math.round((pt.p ?? 0.5) * 100);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(p)) return null;
    if (Math.abs(x) > MAXQ || Math.abs(y) > MAXQ || Math.abs(p) > MAXQ) return null;
    if (p !== 50) anyP = true;
    q[i * 3] = x; q[i * 3 + 1] = y; q[i * 3 + 2] = p;
  }
  const out = [anyP ? "P" : "Q"];
  let px = 0, py = 0, pp = 0;
  for (let i = 0; i < n; i++) {
    const x = q[i * 3], y = q[i * 3 + 1], p = q[i * 3 + 2];
    put(out, x - px); put(out, y - py);
    if (anyP) put(out, p - pp);
    px = x; py = y; pp = p;
  }
  return out.join("");
}

// 문자열 → 점 배열 | null(형식이 맞지 않음)
export function decodePoints(s) {
  if (typeof s !== "string" || s.length < 3) return null;
  const kind = s[0];
  if (kind !== "P" && kind !== "Q") return null;
  const withP = kind === "P";
  const len = s.length;
  let i = 1;
  const next = () => {
    let v = 0, mul = 1;
    for (;;) {
      if (i >= len) return NaN;
      const code = s.charCodeAt(i++);
      const c = code < 128 ? IDX[code] : -1;
      if (c < 0) return NaN;
      if (c >= 32) { v += (c - 32) * mul; mul *= 32; if (mul > 2 ** 45) return NaN; }
      else { v += c * mul; break; }
    }
    return v % 2 ? -(v + 1) / 2 : v / 2;
  };
  const pts = [];
  let x = 0, y = 0, p = withP ? 0 : 50; // 'Q'는 압력 0.5 고정
  while (i < len) {
    const dx = next(), dy = next(), dp = withP ? next() : 0;
    if (Number.isNaN(dx) || Number.isNaN(dy) || Number.isNaN(dp)) return null;
    x += dx; y += dy; p += dp;
    pts.push({ x: x / 10000, y: y / 10000, p: p / 100 });
  }
  return pts.length ? pts : null;
}

// 화면용 획 → 저장용 획(points 대신 pz). 압축할 수 없으면 그대로.
// owner(개별 레코드의 학생 id)와 같은 by·기본 도구 'pen'은 빼고 보낸다(풀 때 되살림, pz가 있는 획만).
//   이전 버전 화면도 by가 없으면 그 학생 획, tool이 없으면 펜으로 그린다.
export function packStroke(s, owner = null) {
  if (!s || typeof s !== "object" || s.pz || !Array.isArray(s.points) || !s.points.length) return s;
  const pz = encodePoints(s.points);
  if (pz == null) return s;
  const { points, ...rest } = s;
  if (owner && rest.by === owner) delete rest.by;
  if (rest.tool === "pen") delete rest.tool;
  rest.pz = pz;
  return rest;
}

// 저장용 획 → 화면용 획. pz가 없으면 그대로(이전 형식)
export function unpackStroke(w, owner = null) {
  if (!w || typeof w !== "object" || typeof w.pz !== "string") return w;
  const { pz, ...rest } = w;
  if (!(Array.isArray(rest.points) && rest.points.length)) rest.points = decodePoints(pz) || [];
  if (!("tool" in rest)) rest.tool = "pen";
  if (owner && !("by" in rest)) rest.by = owner;
  return rest;
}

export function packStrokes(list, owner = null) { return Array.isArray(list) ? list.map(s => packStroke(s, owner)) : []; }
export function unpackStrokes(list, owner = null) { return Array.isArray(list) ? list.map(w => unpackStroke(w, owner)) : []; }
