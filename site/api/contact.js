'use strict';

/*
 * POST /api/contact — the only server-side part of napkinplusplus.app.
 *
 * Sends one email through Resend and returns 204. Without RESEND_API_KEY it
 * returns 503 on purpose: the page then shows its mailto fallback with the
 * message already filled in, which is a better failure than a form that
 * silently disappears into a log.
 *
 * Environment (Vercel → Project → Settings → Environment Variables):
 *   RESEND_API_KEY   re_…            required to actually send
 *   CONTACT_TO       hello@napkinplusplus.app
 *   CONTACT_FROM     napkin++ <hello@napkinplusplus.app>   (domain verified in Resend)
 */

const MAX = { name: 120, email: 200, topic: 80, message: 6000 };

function clean(value, max) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, max);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function reply(response, status, body) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(body === undefined ? '' : JSON.stringify(body));
}

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    return reply(response, 405, { error: 'Use POST.' });
  }

  // Vercel parses application/json bodies for Node functions; a raw body is
  // still possible if that ever changes.
  let payload = request.body;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = null;
    }
  }
  if (!payload || typeof payload !== 'object') {
    return reply(response, 400, { error: 'Expected a JSON body.' });
  }

  // Honeypot: a real person never fills a hidden "website" field. Answer 204
  // so a bot has nothing to learn.
  if (clean(payload.website, 200)) {
    response.statusCode = 204;
    return response.end();
  }

  const name = clean(payload.name, MAX.name);
  const email = clean(payload.email, MAX.email);
  const topic = clean(payload.topic, MAX.topic) || 'hello';
  const message = clean(payload.message, MAX.message);

  if (!name) return reply(response, 400, { error: 'A name helps me reply.' });
  if (!validEmail(email)) return reply(response, 400, { error: 'That email address looks incomplete.' });
  if (message.length < 4) return reply(response, 400, { error: 'Tell me a little more.' });

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    return reply(response, 503, { error: 'The contact form is not configured yet. Email instead.' });
  }

  const to = process.env.CONTACT_TO || 'hello@napkinplusplus.app';
  const from = process.env.CONTACT_FROM || 'napkin++ <hello@napkinplusplus.app>';
  const text = [
    'From: ' + name + ' <' + email + '>',
    'Topic: ' + topic,
    '',
    message,
    '',
    '— sent from napkinplusplus.app/contact',
  ].join('\n');
  const html =
    '<div style="font:14px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1f1c18">' +
    '<p style="margin:0 0 12px"><b>' +
    escapeHtml(name) +
    '</b> &lt;' +
    escapeHtml(email) +
    '&gt;<br><span style="color:#6a6055">' +
    escapeHtml(topic) +
    '</span></p>' +
    '<pre style="white-space:pre-wrap;font:13px/1.55 ui-monospace,Menlo,monospace;background:#f6f1e8;padding:14px;border-radius:8px">' +
    escapeHtml(message) +
    '</pre></div>';

  try {
    const mail = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: email,
        subject: 'napkin++ · ' + topic + ' · ' + name,
        text,
        html,
      }),
    });
    if (!mail.ok) {
      const detail = await mail.text().catch(() => '');
      console.error('resend rejected the message', mail.status, detail.slice(0, 400));
      return reply(response, 502, { error: 'The mail service refused that message. Email instead.' });
    }
  } catch (error) {
    console.error('resend request failed', error && error.message);
    return reply(response, 502, { error: 'Could not reach the mail service. Email instead.' });
  }

  response.statusCode = 204;
  response.setHeader('cache-control', 'no-store');
  return response.end();
};
