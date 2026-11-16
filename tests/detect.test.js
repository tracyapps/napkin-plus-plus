'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const detect = require('../app/detect.js');

const SITE_HTML = `<!doctype html>
<html>
  <head>
    <title>Lu &amp; Co — client portal</title>
    <meta content="Lu, the client portal" name="description" />
    <meta property="og:title" content="Lu" />
    <meta content="/social/card.png" property="og:image" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="apple-touch-icon" href="/touch.png" />
    <script src="/_next/static/chunks/main.js"></script>
  </head>
  <body><div id="__NEXT_DATA__"></div></body>
</html>`;

function signals(overrides) {
  return Object.assign(
    {
      site: null,
      dns: null,
      repo: null,
      offline: false,
    },
    overrides || {}
  );
}

function repoSignals(files) {
  return {
    kind: 'github',
    owner: 'acme',
    name: 'lu',
    url: 'https://github.com/acme/lu',
    meta: {
      description: 'Client portal',
      homepage: 'https://lu.app',
      topics: ['nextjs', 'supabase'],
      language: 'TypeScript',
      stargazers_count: 12,
    },
    languages: { TypeScript: 120000, CSS: 4000 },
    files: files || {},
  };
}

test('readHtml finds meta tags in either attribute order and decodes entities', () => {
  const page = detect.readHtml(SITE_HTML);
  assert.equal(page.title, 'Lu & Co — client portal');
  assert.equal(page.meta['og:image'], '/social/card.png');
  assert.equal(page.meta.description, 'Lu, the client portal');
  assert.equal(page.meta['link:apple-touch-icon'], '/touch.png');
});

test('pickPreviewImage prefers open graph and resolves relative URLs', () => {
  assert.equal(
    detect.pickPreviewImage(SITE_HTML, 'https://lu.app/path/page'),
    'https://lu.app/social/card.png'
  );
  const twitterOnly = '<meta name="twitter:image" content="https://cdn.example/x.png">';
  assert.equal(detect.pickPreviewImage(twitterOnly, 'https://lu.app'), 'https://cdn.example/x.png');
  const icon = '<link rel="apple-touch-icon" href="/apple.png">';
  assert.equal(detect.pickPreviewImage(icon, 'https://lu.app'), 'https://lu.app/apple.png');
  const none = '<meta property="og:image" content="data:image/png;base64,AAAA">';
  assert.equal(detect.pickPreviewImage(none, 'https://lu.app'), '');
});

test('parseRepoUrl understands the hosts people actually paste', () => {
  assert.deepEqual(detect.parseRepoUrl('https://github.com/acme/lu'), {
    host: 'github.com',
    kind: 'github',
    owner: 'acme',
    name: 'lu',
    url: 'https://github.com/acme/lu',
  });
  assert.equal(detect.parseRepoUrl('https://github.com/acme/lu.git').name, 'lu');
  assert.equal(detect.parseRepoUrl('https://www.github.com/acme/lu/tree/main').name, 'lu');
  assert.equal(detect.parseRepoUrl('https://gitlab.com/acme/lu').kind, 'gitlab');
  assert.equal(detect.parseRepoUrl('https://bitbucket.org/acme/lu').kind, 'bitbucket');
  assert.equal(detect.parseRepoUrl('https://lu.app'), null);
  assert.equal(detect.parseRepoUrl('not a url'), null);
});

test('classify names hosting from response headers and the repo stack', () => {
  const findings = detect.classify(
    signals({
      site: {
        url: 'https://lu.app',
        finalUrl: 'https://lu.app',
        headers: { 'x-vercel-id': 'iad1::abc', server: 'Vercel' },
        html: SITE_HTML,
      },
      repo: repoSignals({
        'package.json': JSON.stringify({
          dependencies: {
            next: '15.0.0',
            '@neondatabase/serverless': '1.0.0',
            '@clerk/nextjs': '6.0.0',
            resend: '4.0.0',
          },
        }),
        'tsconfig.json': '{}',
        '.env.example': 'DATABASE_URL=postgres://x\nCLERK_SECRET_KEY=abc\n',
      }),
    })
  );
  assert.equal(findings.hosting[0].label, 'Vercel');
  assert.match(findings.hosting[0].evidence, /x-vercel-id/);
  const stack = findings.stack.map((item) => item.name);
  assert.ok(stack.includes('Next.js'));
  assert.ok(stack.includes('TypeScript'));
  const providers = findings.services.map((item) => item.provider);
  assert.ok(providers.includes('Neon'));
  assert.ok(providers.includes('Clerk'));
  assert.ok(providers.includes('Resend'));
  assert.ok(providers.includes('Vercel'));
  assert.ok(findings.languages.some((item) => item.name === 'TypeScript'));
  assert.ok(findings.tags.includes('nextjs'));
  assert.equal(findings.page.image, 'https://lu.app/social/card.png');
});

test('classify reads DNS for nameservers, mail and verification records', () => {
  const findings = detect.classify(
    signals({
      dns: {
        host: 'lu.app',
        ns: ['kate.ns.cloudflare.com', 'rob.ns.cloudflare.com'],
        mx: [{ exchange: 'aspmx.l.google.com' }].map((record) => record.exchange),
        txt: ['v=spf1 include:_spf.resend.com ~all', 'stripe-verification=abc'],
        cname: [],
      },
    })
  );
  assert.equal(findings.dns[0].label, 'Cloudflare');
  assert.equal(findings.email[0].label, 'Google Workspace');
  assert.ok(findings.email.some((item) => item.label === 'Resend'));
  assert.ok(findings.services.some((item) => item.provider === 'Cloudflare' && item.role === 'dns'));
});

test('classify stays quiet when nothing is reachable', () => {
  const findings = detect.classify(signals({ offline: true }));
  assert.deepEqual(findings.hosting, []);
  assert.deepEqual(findings.stack, []);
  assert.equal(findings.offline, true);
  const proposals = detect.proposals(findings, { stack: [], tags: [], services: [], links: [] });
  assert.equal(proposals.hasAnything, false);
  assert.equal(proposals.note, '');
});

test('proposals never overwrite what the dossier already records', () => {
  const findings = detect.classify(
    signals({
      site: {
        url: 'https://lu.app',
        finalUrl: 'https://lu.app',
        headers: { 'x-vercel-id': 'abc' },
        html: SITE_HTML,
      },
      repo: repoSignals({
        'package.json': JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }),
      }),
    })
  );
  const project = {
    stack: ['Next.js'],
    tags: ['client'],
    services: [{ provider: 'Vercel', role: 'hosting', url: 'https://vercel.com/acme' }],
    links: [{ kind: 'live', url: 'https://lu.app' }],
  };
  const proposals = detect.proposals(findings, project);
  assert.deepEqual(proposals.stack.map((item) => item.name), ['React']);
  assert.deepEqual(proposals.services, []);
  assert.ok(!proposals.tags.includes('client'));
  assert.deepEqual(proposals.links, []);
  assert.match(proposals.note, /Auto-detected from lu\.app/);
  assert.match(proposals.note, /hosted on Vercel/);
});

test('proposals offer a repo homepage as a live link when one is missing', () => {
  const findings = detect.classify(signals({ repo: repoSignals({}) }));
  const proposals = detect.proposals(findings, { stack: [], tags: [], services: [], links: [] });
  assert.equal(proposals.links.length, 1);
  assert.equal(proposals.links[0].url, 'https://lu.app');
  assert.equal(proposals.links[0].kind, 'live');
});

test('proposals cap what one sheet can add', () => {
  const deps = {};
  for (const name of detect.DEPENDENCIES.slice(0, 40)) {
    const sample = String(name.dep).replace(/^\^|\$$/g, '').replace(/\\/g, '');
    if (sample && !/[[\]()|?*+^$]/.test(sample)) deps[sample] = '1.0.0';
  }
  const findings = detect.classify(
    signals({ repo: repoSignals({ 'package.json': JSON.stringify({ dependencies: deps }) }) })
  );
  const proposals = detect.proposals(findings, { stack: [], tags: [], services: [], links: [] });
  assert.ok(proposals.stack.length <= detect.LIMITS.stack);
  assert.ok(proposals.tags.length <= detect.LIMITS.tags);
  assert.ok(proposals.services.length <= detect.LIMITS.services);
});

test('headline is a short list of the strongest findings', () => {
  const findings = detect.classify(
    signals({
      site: {
        url: 'https://lu.app',
        finalUrl: 'https://lu.app',
        headers: { 'x-vercel-id': 'abc' },
        html: SITE_HTML,
      },
    })
  );
  assert.equal(detect.headline(findings), 'Vercel · Next.js');
});

test('tagFor keeps tags lowercase and one word', () => {
  assert.equal(detect.tagFor('Next.js'), 'nextjs');
  assert.equal(detect.tagFor('Cloudflare Pages'), 'cloudflarepages');
  assert.equal(detect.tagFor('C++'), 'cplusplus');
  assert.equal(detect.tagFor('  '), '');
});
