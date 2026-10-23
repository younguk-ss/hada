// 붓글씨 손글씨 쓰기: 글리프 외곽선을 획순대로 그려지는 마스크로 드러내 실제 펜으로 쓰는 듯한 모션.
import { INK_GLYPHS } from "./handwriting-data.js";

const NS = "http://www.w3.org/2000/svg";
const TRACK = 60;            // 글자 사이 자간 (0.06em)
const PAD = 40;              // 좌우 여백
const Y0 = -660, Y1 = 360;   // 모든 단어 공통 세로 범위 → 괄호와 같은 높이로 정렬
const PEN_SPEED = 11;        // units/ms
const PEN_MIN_MS = 60;       // 짧은 획도 이 정도는 걸려야 '쓰는' 느낌
const PEN_LIFT = 18;         // 획 사이 펜 드는 시간
const CHAR_GAP = 40;         // 글자 사이
let uid = 0;

const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

function layout(text) {
  let x = 0, x0 = Infinity, x1 = -Infinity;
  const chars = [...text].map(ch => {
    const g = INK_GLYPHS[ch];
    x0 = Math.min(x0, x + g.bbox[0]);
    x1 = Math.max(x1, x + g.bbox[2]);
    const c = { ch, g, x };
    x += g.adv + TRACK;
    return c;
  });
  return { chars, x0: x0 - PAD, x1: x1 + PAD };
}

// 단어 폭(em) — 괄호 칸 너비를 가장 넓은 단어에 맞출 때 사용
export function inkWidth(text) {
  const { x0, x1 } = layout(text);
  return (x1 - x0) / 1000;
}

// text 를 붓글씨 SVG 로 만든다. written=true 면 처음부터 다 쓰인 상태.
export function inkWord(text, { written = false } = {}) {
  const { chars, x0, x1 } = layout(text);
  const svg = svgEl("svg", {
    class: "ink-word", viewBox: `${x0} ${Y0} ${x1 - x0} ${Y1 - Y0}`, "aria-hidden": "true",
  });
  svg.style.width = `${(x1 - x0) / 1000}em`;
  svg.style.height = `${(Y1 - Y0) / 1000}em`;

  const parts = chars.map(({ g, x }) => {
    const id = `ink-m${++uid}`;
    const grp = svgEl("g", { transform: `translate(${x} 0)` });
    const mask = svgEl("mask", { id, maskUnits: "userSpaceOnUse", x: -200, y: Y0 - 100, width: g.adv + 400, height: Y1 - Y0 + 200 });
    const strokes = g.strokes.map(s => {
      const p = svgEl("path", {
        d: s.d, fill: "none", stroke: "#fff", "stroke-width": s.w,
        "stroke-linecap": "round", "stroke-linejoin": "round",
        "stroke-dasharray": `${s.len} ${s.len + 2}`, "stroke-dashoffset": written ? 0 : s.len + 1,
      });
      mask.appendChild(p);
      return { el: p, len: s.len };
    });
    // 획 마스크가 놓친 가장자리 털끝을 마지막에 채우는 안전망
    const fill = svgEl("rect", { x: -200, y: Y0 - 100, width: g.adv + 400, height: Y1 - Y0 + 200, fill: "#fff", opacity: written ? 1 : 0 });
    mask.appendChild(fill);
    grp.append(mask, svgEl("path", { d: g.d, mask: `url(#${id})` }));
    svg.appendChild(grp);
    return { strokes, fill };
  });

  // 획순대로 쓴다. 모든 획이 끝나면 resolve.
  function write({ delay = 0 } = {}) {
    let t = delay;
    const anims = [];
    for (const { strokes, fill } of parts) {
      for (const s of strokes) {
        const dur = Math.max(PEN_MIN_MS, s.len / PEN_SPEED);
        anims.push(s.el.animate(
          [{ strokeDashoffset: s.len + 1 }, { strokeDashoffset: 0 }],
          { duration: dur, delay: t, easing: "cubic-bezier(.45,.05,.3,1)", fill: "both" },
        ));
        t += dur + PEN_LIFT;
      }
      anims.push(fill.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: t - PEN_LIFT, fill: "both" }));
      t += CHAR_GAP;
    }
    return Promise.all(anims.map(a => a.finished)).catch(() => {});
  }

  // 형광펜으로 단어 아래쪽을 긋는다 (앱 이름 강조용)
  function highlight({ written: done = false } = {}) {
    const y = -150, h = 230;
    const hl = svgEl("path", {
      class: "ink-highlight",
      d: `M${x0 + 10} ${y + 30} C${x0 + (x1 - x0) * 0.35} ${y + 10} ${x0 + (x1 - x0) * 0.65} ${y - 10} ${x1 - 10} ${y - 30}`,
      fill: "none", "stroke-width": h, "stroke-linecap": "butt",
    });
    svg.insertBefore(hl, svg.firstChild);
    const len = hl.getTotalLength();
    hl.setAttribute("stroke-dasharray", `${len} ${len + 2}`);
    hl.setAttribute("stroke-dashoffset", done ? 0 : len + 1);
    if (done) return Promise.resolve();
    return hl.animate([{ strokeDashoffset: len + 1 }, { strokeDashoffset: 0 }],
      { duration: 420, easing: "cubic-bezier(.3,.6,.2,1)", fill: "both" }).finished.catch(() => {});
  }

  return { svg, write, highlight };
}
