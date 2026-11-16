'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../site/api/contact.js');

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    end(body) {
      this.body = body || '';
    },
  };
}

function fakeRequest(body, method) {
  return { method: method || 'POST', body };
}

function call(body, method) {
  const res = fakeResponse();
  const promise = handler(fakeRequest(body, method), res);
  return Promise.resolve(promise).then(() => res);
}

const valid = {
  name: 'Tracy',
  email: 'tracy@example.com',
  topic: 'a bug',
  message: 'The paste button ate my last line.',
};

test('rejects anything but POST', async () => {
  const res = await call(null, 'GET');
  assert.equal(res.statusCode, 405);
});

test('rejects a missing or invalid body', async () => {
  assert.equal((await call(null)).statusCode, 400);
  assert.equal((await call('not json')).statusCode, 400);
  // A raw JSON string is accepted: Vercel usually parses it, but not always.
  assert.equal((await call(JSON.stringify(valid))).statusCode, 503);
});

test('validates name, email and message', async () => {
  assert.equal((await call(Object.assign({}, valid, { name: ' ' }))).statusCode, 400);
  assert.equal((await call(Object.assign({}, valid, { email: 'nope' }))).statusCode, 400);
  assert.equal((await call(Object.assign({}, valid, { message: 'x' }))).statusCode, 400);
});

test('a filled honeypot gets a quiet 204', async () => {
  const res = await call(Object.assign({}, valid, { website: 'https://spam.example' }));
  assert.equal(res.statusCode, 204);
});

test('says so when the mail service is not configured', async () => {
  const previous = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const res = await call(valid);
  assert.equal(res.statusCode, 503);
  assert.match(JSON.parse(res.body).error, /not configured/);
  if (previous !== undefined) process.env.RESEND_API_KEY = previous;
});

test('sends through Resend and reports a failure honestly', async () => {
  const previous = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 're_test_key';
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => '' };
  };
  try {
    const res = await call(valid);
    assert.equal(res.statusCode, 204);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.reply_to, valid.email);
    assert.equal(payload.to[0], 'hello@napkinplusplus.app');
    assert.match(payload.text, /paste button/);

    global.fetch = async () => ({ ok: false, status: 422, text: async () => 'bad from' });
    const failed = await call(valid);
    assert.equal(failed.statusCode, 502);
    assert.match(JSON.parse(failed.body).error, /refused/);

    global.fetch = async () => {
      throw new Error('offline');
    };
    const offline = await call(valid);
    assert.equal(offline.statusCode, 502);
  } finally {
    global.fetch = originalFetch;
    if (previous === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previous;
  }
});
