// 구형 브라우저 보완(v2.8) — 학교 태블릿의 오래된 크롬·삼성 인터넷에서도 화면이 깨지지 않게.
// app.js의 첫 import라서 다른 모듈보다 먼저 평가된다(store.js가 부팅 때 structuredClone을 쓴다).
// 가정: 문법(?. ?? ||= 등)은 보완할 수 없으므로 크롬 85 이상이 필요하다. 여기서는 앱이 쓰는 함수만 채운다.
const def = (obj, name, value) => {
  if (typeof obj[name] === "function") return;
  try { Object.defineProperty(obj, name, { value, configurable: true, writable: true }); } catch (_) { /* 무시 */ }
};

def(Object, "hasOwn", (o, k) => Object.prototype.hasOwnProperty.call(o, k)); // 크롬 93+
def(globalThis, "structuredClone", (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))); // 크롬 98+ (앱 데이터는 JSON)
def(Array.prototype, "at", function at(i) { // 크롬 92+
  let n = Math.trunc(i) || 0;
  if (n < 0) n += this.length;
  return n < 0 || n >= this.length ? undefined : this[n];
});
