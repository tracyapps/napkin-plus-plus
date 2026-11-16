'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fold = require('../app/fold.js');

test('folds braces and ignores braces inside strings and comments', () => {
  const js = [
    'function a() {',
    '  if (x) {',
    '    return 1;',
    '  }',
    '}',
    'const s = "}";',
    '// }',
  ].join('\n');
  const folds = fold.computeFolds(js);
  assert.ok(folds.some((f) => f.start === 0 && f.end === 4));
  assert.ok(folds.some((f) => f.start === 1 && f.end === 3));
  assert.equal(folds.filter((f) => f.start === 5).length, 0);
});

test('does not fold a block that closes on the same line', () => {
  const folds = fold.computeFolds('const x = { a: 1 };\nconst y = [1, 2];');
  assert.equal(folds.length, 0);
});

test('folds python and yaml by indentation', () => {
  const py = ['def f():', '    if x:', '        return 1', '    return 2', '', 'after = 1'].join('\n');
  const folds = fold.computeFolds(py);
  assert.ok(folds.some((f) => f.start === 0 && f.end === 3 && f.kind === 'indent'));
  assert.ok(folds.some((f) => f.start === 1 && f.end === 2 && f.kind === 'indent'));

  const yaml = ['services:', '  web:', '    image: nginx', '  db:', '    image: postgres', 'other: 1'].join('\n');
  const yFolds = fold.computeFolds(yaml);
  assert.ok(yFolds.some((f) => f.start === 0 && f.end === 4));
  assert.ok(yFolds.some((f) => f.start === 1 && f.end === 2));
});

test('computes hidden ranges for collapsed folds', () => {
  const js = ['a {', '  b', '  c', '}', 'd {', '  e', '}'].join('\n');
  const folds = fold.computeFolds(js);
  const ranges = fold.hiddenRanges(folds, new Set([0, 4]));
  assert.deepEqual(ranges, [
    { start: 1, end: 3 },
    { start: 5, end: 6 },
  ]);
  assert.equal(fold.hiddenCount(ranges), 5);
});

test('collapsing only hides the region that is collapsed', () => {
  const js = ['a {', '  b {', '    c', '  }', '}'].join('\n');
  const folds = fold.computeFolds(js);
  const ranges = fold.hiddenRanges(folds, new Set([1]));
  assert.deepEqual(ranges, [{ start: 2, end: 3 }]);
});

test('foldMap keeps the widest region per start line', () => {
  const js = ['a {', '  b {', '    c', '  }', '}'].join('\n');
  const map = fold.foldMap(fold.computeFolds(js));
  assert.equal(map.get(0).end, 4);
  assert.equal(map.get(1).end, 3);
});

test('labels folds from their first line', () => {
  const lines = fold.splitLines('function calculate() {\n  return 1;\n}');
  const folds = fold.computeFolds(lines.join('\n'));
  assert.equal(fold.foldLabel(lines, folds[0]), 'function calculate() {');
});
