/*
 * Tests for DT.imageStats (src/shared.js): which pictures count as "light picture with dark text"
 * (a document), the ones the option «Инвертировать светлые картинки с текстом» inverts.
 *
 * Usage: node test/stats.test.js
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ctx = { console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'shared.js'), 'utf8'), ctx);
const DT = ctx.DT;

const W = 96, H = 96;

/** A picture as a function (x, y) -> [r, g, b, a]. */
function picture(fn) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b, a = 255] = fn(x, y);
      const i = (y * W + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return DT.imageStats(data, W * H);
}

const WHITE = [255, 255, 255];
const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('a document screenshot (black text, a blue link) is a document', () => {
  const st = picture((x, y) => {
    const line = Math.floor(y / 8);
    const inText = y % 8 < 3 && x > 6 && x < 88 && (x + line * 3) % 7 < 4;
    if (!inText) return WHITE;
    return line === 4 ? [30, 90, 200] : [20, 20, 20];
  });
  assert.strictEqual(st.doc, true, JSON.stringify(st));
});

test('a black-and-white diagram is a document', () => {
  const st = picture((x, y) => {
    const box = (x > 10 && x < 40 && (y === 20 || y === 40)) || ((x === 10 || x === 40) && y > 20 && y < 40);
    const box2 = (x > 55 && x < 85 && (y === 60 || y === 80)) || ((x === 55 || x === 85) && y > 60 && y < 80);
    const link = Math.abs(y - (20 + x * 0.6)) < 1 && x > 40 && x < 56;
    return box || box2 || link ? [0, 0, 0] : WHITE;
  });
  assert.strictEqual(st.doc, true, JSON.stringify(st));
});

test('a colourful illustration on a white background is not a document', () => {
  // a pinecone mascot with brown outlines, a little cake and confetti on white
  // (like the achievement picture that was inverted by mistake)
  const st = picture((x, y) => {
    if (inEllipse(x, y, 48, 46, 24, 30)) {
      if (!inEllipse(x, y, 48, 46, 22, 28)) return [107, 74, 43];          // outline
      return (x + y) % 9 < 2 ? [150, 110, 70] : [236, 214, 186];           // scales
    }
    if (y > 78 && y < 86 && x > 34 && x < 62) return [120, 190, 235];      // cake
    if ((x * 7 + y * 13) % 97 < 2) return [[255, 77, 109], [255, 209, 102], [6, 214, 160]][x % 3];
    return WHITE;
  });
  assert.strictEqual(st.doc, false, JSON.stringify(st));
});

test('a coloured flowchart stays a picture', () => {
  const st = picture((x, y) => {
    if (x > 8 && x < 44 && y > 10 && y < 30) return [255, 205, 120];
    if (x > 52 && x < 88 && y > 60 && y < 80) return [150, 200, 255];
    if (y === 20 && x > 44 && x < 70) return [0, 0, 0];
    return WHITE;
  });
  assert.strictEqual(st.doc, false, JSON.stringify(st));
});

test('a photo is not a document', () => {
  const st = picture((x, y) => [40 + x * 2, 120 + y, 200 - x]);
  assert.strictEqual(st.doc, false, JSON.stringify(st));
});

test('a transparent dark logo: transparency and darkness are measured', () => {
  const st = picture((x, y) => (inEllipse(x, y, 48, 48, 30, 12) ? [17, 17, 17, 255] : [0, 0, 0, 0]));
  assert.ok(st.transparent > 0.5 && st.dark > 0.9, JSON.stringify(st));
});

let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`ok   ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${t.name}\n     ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
