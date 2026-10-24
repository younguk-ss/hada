// 모든 슬라이드 타입 등록(부수효과 import) + 레지스트리·호스트 재수출. app.js 가 1회 import.
// 가정: 타입 모듈 하나가 깨져도(문법 오류·404) 앱 전체가 죽지 않도록 동적 import 로 각각 격리한다.
//       top-level await 로 모두 끝난 뒤에 이 모듈이 평가 완료 → app.js 시점엔 등록이 끝나 있다.
//       실패한 타입은 registry 의 UNKNOWN('지원하지 않는 슬라이드')으로 표시된다.
export * from "./registry.js";
export { mountSlideHost } from "./host.js";

const TYPES = ["ink", "mcq", "poll", "short", "blank", "wordcloud", "dragdrop", "wall", "link", "embed", "video", "videoquiz", "dino", "race"];

await Promise.all(TYPES.map(t =>
  import(`./${t}.js`).catch(e => console.error(`[slides] ${t}.js 로드 실패`, e))
));
