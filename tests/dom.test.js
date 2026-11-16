'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require('../app/dom.js');

const D = globalThis.NapkinDOM;

test('initials ignore parentheticals and punctuation', () => {
  assert.equal(D.initials('lu app'), 'LA');
  assert.equal(D.initials('lu-app (2)'), 'LA');
  assert.equal(D.initials('lu-app (3)'), 'LA');
  assert.equal(D.initials('digital ocean ta.org new'), 'DN');
  assert.equal(D.initials('acme'), 'AC');
  assert.equal(D.initials('a'), 'A');
  assert.equal(D.initials('   '), '?');
});

test('hostOf drops www and tolerates nonsense', () => {
  assert.equal(D.hostOf('https://www.lu.app/path'), 'lu.app');
  assert.equal(D.hostOf('https://vercel.com/acme/lu'), 'vercel.com');
  assert.equal(D.hostOf('not a url'), 'not a url');
});

test('highlight escapes markup before marking matches', () => {
  const html = D.highlight('<script>x</script> lu app', ['lu']);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('<mark class="mark">lu</mark>'));
});

test('truncate and firstLine keep previews to one short line', () => {
  assert.equal(D.truncate('  a   b  ', 10), 'a b');
  assert.equal(D.firstLine('first\nsecond', 20), 'first');
  assert.equal(D.truncate('abcdefghij', 5), 'abcd…');
});
