/*
 * napkin++ — link intelligence.
 *
 * Pure and side-effect free: given the raw signals the main process collected
 * (HTTP headers + HTML, DNS records, a GitHub repo's metadata and a handful of
 * its files) decide what the project is probably built on. Everything here is
 * a *suggestion*: the renderer shows the evidence, the user ticks what to keep,
 * and `project.enrich` merges it into the dossier without overwriting edits.
 *
 * Runs in Node (tests, main process) and in the renderer.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NapkinDetect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ------------------------------------------------------------- html parsing

  const ENTITIES = {
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    nbsp: ' ',
    '#39': "'",
    '#x27': "'",
  };

  function decodeEntities(value) {
    return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name) => {
      const key = name.toLowerCase();
      if (ENTITIES[key] !== undefined) return ENTITIES[key];
      if (key.startsWith('#x')) {
        const code = parseInt(key.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (key.startsWith('#')) {
        const code = parseInt(key.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return match;
    });
  }

  function parseAttributes(tag) {
    const out = {};
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let match;
    while ((match = re.exec(tag))) {
      const value = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4];
      out[match[1].toLowerCase()] = decodeEntities(value || '');
    }
    return out;
  }

  function stripComments(html) {
    return String(html || '').replace(/<!--[\s\S]*?-->/g, ' ');
  }

  /** Meta tags, link icons and a few generator hints, without a DOM. */
  function readHtml(html) {
    const text = stripComments(html);
    const meta = {};
    const tagRe = /<(meta|link)\b[^>]*>/gi;
    let match;
    while ((match = tagRe.exec(text))) {
      const tag = match[0];
      const attrs = parseAttributes(tag);
      if (match[1].toLowerCase() === 'meta') {
        const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
        if (!key || attrs.content === undefined) continue;
        if (!(key in meta)) meta[key] = attrs.content;
      } else {
        const rel = (attrs.rel || '').toLowerCase();
        if (!rel) continue;
        if (!meta['link:' + rel]) meta['link:' + rel] = attrs.href || '';
        if (rel.includes('apple-touch-icon') && !meta['link:apple-touch-icon']) {
          meta['link:apple-touch-icon'] = attrs.href || '';
        }
      }
    }
    const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return {
      title: titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '',
      meta,
      text: text.slice(0, 400000),
    };
  }

  function absoluteUrl(value, base) {
    const raw = String(value || '').trim();
    if (!raw || /^data:/i.test(raw) || /^javascript:/i.test(raw)) return '';
    try {
      const url = new URL(raw, base);
      return /^https?:$/.test(url.protocol) ? url.toString() : '';
    } catch {
      return '';
    }
  }

  /**
   * The best image a site offers for a card. Open Graph first, then Twitter,
   * then a large touch icon. Relative URLs resolve against the final page URL.
   */
  function pickPreviewImage(html, baseUrl) {
    const page = typeof html === 'string' ? readHtml(html) : html;
    const meta = page.meta || {};
    const order = [
      'og:image:secure_url',
      'og:image:url',
      'og:image',
      'twitter:image',
      'twitter:image:src',
      'image',
      'thumbnailurl',
      'link:apple-touch-icon',
      'link:apple-touch-icon-precomposed',
      'link:icon',
    ];
    for (const key of order) {
      const url = absoluteUrl(meta[key], baseUrl);
      if (url) return url;
    }
    return '';
  }

  function describePage(html, baseUrl) {
    const page = typeof html === 'string' ? readHtml(html) : html;
    const meta = page.meta || {};
    return {
      title: page.title || '',
      description: meta['og:description'] || meta.description || '',
      siteName: meta['og:site_name'] || '',
      generator: meta.generator || '',
      image: pickPreviewImage(page, baseUrl),
    };
  }

  // ------------------------------------------------------------ rule helpers

  function headerValue(headers, name) {
    if (!headers) return '';
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === wanted) {
        return Array.isArray(value) ? value.join(', ') : String(value || '');
      }
    }
    return '';
  }

  function anyHeader(headers, test) {
    for (const [key, value] of Object.entries(headers || {})) {
      const flat = Array.isArray(value) ? value.join(', ') : String(value || '');
      if (test(key.toLowerCase(), flat)) return key + ': ' + flat.slice(0, 120);
    }
    return '';
  }

  function anyRecord(list, test) {
    for (const value of list || []) {
      if (test(String(value))) return String(value);
    }
    return '';
  }

  function joinBecause(list) {
    return list.filter(Boolean).slice(0, 3).join('; ');
  }

  // --------------------------------------------------------------- providers

  const LIMITS = {
    stack: 10,
    tags: 8,
    services: 10,
  };

  /** Each entry returns evidence strings; the first truthy one wins. */
  function detectHosting(signals) {
    const site = signals.site || {};
    const headers = site.headers || {};
    const dns = signals.dns || {};
    const html = String(site.html || '');
    const found = [];
    const push = (id, label, evidence, url, role) => {
      if (evidence) found.push({ id, label, evidence: joinBecause([evidence]), url, role: role || 'hosting' });
    };

    push(
      'vercel',
      'Vercel',
      anyHeader(headers, (key) => key.startsWith('x-vercel-')) ||
        (/(^|,\s*)vercel/i.test(headerValue(headers, 'server')) && 'server: Vercel') ||
        anyRecord(dns.cname, (v) => /vercel-dns\.com$/i.test(v) && 'CNAME → ' + v) ||
        (/_vercel\/insights|vercel\.live/i.test(html) && 'Vercel analytics script in the page'),
      'https://vercel.com/dashboard'
    );
    push(
      'netlify',
      'Netlify',
      anyHeader(headers, (key) => key.startsWith('x-nf-') || key === 'x-netlify-request-id') ||
        (/netlify/i.test(headerValue(headers, 'server')) && 'server: Netlify') ||
        anyRecord(dns.cname, (v) => /netlify\.(app|com)$/i.test(v) && 'CNAME → ' + v),
      'https://app.netlify.com'
    );
    push(
      'cloudflare-pages',
      'Cloudflare Pages',
      /pages\.dev$/i.test(new URL(site.finalUrl || site.url || 'https://x.invalid').hostname) &&
        'pages.dev hostname' ||
        anyRecord(dns.cname, (v) => /pages\.dev$/i.test(v) && 'CNAME → ' + v),
      'https://dash.cloudflare.com/?to=/:account/pages'
    );
    push(
      'github-pages',
      'GitHub Pages',
      /\.github\.io$/i.test(new URL(site.finalUrl || site.url || 'https://x.invalid').hostname) &&
        'github.io hostname' ||
        anyRecord(dns.cname, (v) => /github\.io$/i.test(v) && 'CNAME → ' + v),
      'https://github.com/settings/pages'
    );
    push(
      'render',
      'Render',
      anyHeader(headers, (key) => key === 'x-render-origin-server') ||
        anyRecord(dns.cname, (v) => /onrender\.com$/i.test(v) && 'CNAME → ' + v),
      'https://dashboard.render.com'
    );
    push(
      'railway',
      'Railway',
      (/railway/i.test(headerValue(headers, 'server')) && 'server: Railway') ||
        anyRecord(dns.cname, (v) => /railway\.app$/i.test(v) && 'CNAME → ' + v),
      'https://railway.app/dashboard'
    );
    push(
      'fly',
      'Fly.io',
      (/^fly\//i.test(headerValue(headers, 'server')) && 'server: fly/…') ||
        anyRecord(dns.cname, (v) => /fly\.dev$/i.test(v) && 'CNAME → ' + v),
      'https://fly.io/dashboard'
    );
    push(
      'heroku',
      'Heroku',
      /herokuapp\.com$/i.test(new URL(site.finalUrl || site.url || 'https://x.invalid').hostname) &&
        'herokuapp.com hostname' ||
        anyRecord(dns.cname, (v) => /herokuapp\.com$/i.test(v) && 'CNAME → ' + v),
      'https://dashboard.heroku.com'
    );
    push(
      'digitalocean',
      'DigitalOcean',
      anyRecord(dns.cname, (v) => /ondigitalocean\.app$/i.test(v) && 'CNAME → ' + v) ||
        (/^DigitalOcean$/i.test(headerValue(headers, 'x-served-by')) && 'x-served-by: DigitalOcean'),
      'https://cloud.digitalocean.com/apps'
    );
    push(
      'firebase',
      'Firebase Hosting',
      anyHeader(headers, (key) => key === 'x-firebase-hosting' || key === 'x-goog-project-id') ||
        anyRecord(dns.cname, (v) => /web\.app$/i.test(v) && 'CNAME → ' + v),
      'https://console.firebase.google.com'
    );
    push(
      'azure-static',
      'Azure Static Web Apps',
      anyRecord(dns.cname, (v) => /azurestaticapps\.net$/i.test(v) && 'CNAME → ' + v),
      'https://portal.azure.com'
    );
    push(
      'aws-amplify',
      'AWS Amplify',
      anyRecord(dns.cname, (v) => /amplifyapp\.com$/i.test(v) && 'CNAME → ' + v),
      'https://console.aws.amazon.com/amplify'
    );
    push(
      'wordpress',
      'WordPress',
      (readHtml(html).meta.generator || '').match(/WordPress/i) ? 'generator meta: WordPress' : '',
      ''
    );
    return found;
  }

  function detectCdn(signals) {
    const headers = (signals.site || {}).headers || {};
    const found = [];
    if (headerValue(headers, 'cf-ray') || /cloudflare/i.test(headerValue(headers, 'server'))) {
      found.push({
        id: 'cloudflare',
        label: 'Cloudflare',
        role: 'cdn',
        url: 'https://dash.cloudflare.com',
        evidence: headerValue(headers, 'cf-ray')
          ? 'cf-ray response header'
          : 'server: Cloudflare',
      });
    }
    if (headerValue(headers, 'x-amz-cf-id')) {
      found.push({
        id: 'cloudfront',
        label: 'AWS CloudFront',
        role: 'cdn',
        url: 'https://console.aws.amazon.com/cloudfront',
        evidence: 'x-amz-cf-id response header',
      });
    }
    return found;
  }

  function detectDns(signals) {
    const dns = signals.dns || {};
    const ns = (dns.ns || []).join(' ');
    const found = [];
    const push = (id, label, evidence, url) => {
      if (evidence) found.push({ id, label, role: 'dns', url, evidence });
    };
    push('cloudflare', 'Cloudflare', /\.ns\.cloudflare\.com/i.test(ns) && 'NS → ns.cloudflare.com', 'https://dash.cloudflare.com');
    push('namecheap', 'Namecheap', /registrar-servers\.com/i.test(ns) && 'NS → registrar-servers.com', 'https://ap.www.namecheap.com');
    push('godaddy', 'GoDaddy', /domaincontrol\.com/i.test(ns) && 'NS → domaincontrol.com', 'https://dcc.godaddy.com');
    push('route53', 'AWS Route 53', /awsdns-/i.test(ns) && 'NS → awsdns', 'https://console.aws.amazon.com/route53');
    push('google-dns', 'Google Cloud DNS', /(googledomains\.com|ns[0-9]*\.google\.com)/i.test(ns) && 'NS → google', 'https://console.cloud.google.com/net-services/dns');
    push('hover', 'Hover', /hover\.com/i.test(ns) && 'NS → hover.com', 'https://www.hover.com');
    push('gandi', 'Gandi', /gandi\.net/i.test(ns) && 'NS → gandi.net', 'https://admin.gandi.net');
    push('porkbun', 'Porkbun', /porkbun\.com/i.test(ns) && 'NS → porkbun.com', 'https://porkbun.com/account/domainsSpeedy');
    push('vercel-dns', 'Vercel DNS', /vercel-dns\.com/i.test(ns) && 'NS → vercel-dns.com', 'https://vercel.com/dashboard/domains');
    push('netlify-dns', 'Netlify DNS', /netlify\.com/i.test(ns) && 'NS → netlify.com', 'https://app.netlify.com/account/dns');
    push('digitalocean-dns', 'DigitalOcean DNS', /digitalocean\.com/i.test(ns) && 'NS → digitalocean.com', 'https://cloud.digitalocean.com/networking/domains');
    return found;
  }

  function detectEmail(signals) {
    const dns = signals.dns || {};
    const mx = (dns.mx || []).join(' ').toLowerCase();
    const txt = (dns.txt || []).join(' ').toLowerCase();
    const found = [];
    const push = (id, label, evidence, url) => {
      if (evidence) found.push({ id, label, role: 'email', url, evidence });
    };
    push('google-workspace', 'Google Workspace', /(google\.com|googlemail\.com)/.test(mx) && 'MX → google.com', 'https://admin.google.com');
    push('microsoft365', 'Microsoft 365', /outlook\.com|protection\.outlook\.com/.test(mx) && 'MX → outlook.com', 'https://admin.microsoft.com');
    push('zoho', 'Zoho Mail', /zoho/.test(mx) && 'MX → zoho', 'https://mail.zoho.com');
    push('fastmail', 'Fastmail', /messagingengine\.com/.test(mx) && 'MX → messagingengine.com', 'https://app.fastmail.com');
    push('proton', 'Proton Mail', /protonmail\.ch|proton\.me/.test(mx) && 'MX → proton', 'https://mail.proton.me');
    push('improvmx', 'ImprovMX', /improvmx\.com/.test(mx) && 'MX → improvmx.com', 'https://app.improvmx.com');
    push('forwardemail', 'Forward Email', /forwardemail\.net/.test(mx) && 'MX → forwardemail.net', 'https://forwardemail.net');
    push('resend', 'Resend', /_spf\.resend\.com|resend\.com/.test(txt) && 'SPF includes resend.com', 'https://resend.com/api-keys');
    push('sendgrid', 'SendGrid', /sendgrid\.net/.test(txt) && 'SPF includes sendgrid.net', 'https://app.sendgrid.com');
    push('postmark', 'Postmark', /spf\.postmarkapp\.com/.test(txt) && 'SPF includes postmarkapp.com', 'https://account.postmarkapp.com');
    push('mailgun', 'Mailgun', /mailgun\.org/.test(txt) && 'SPF includes mailgun.org', 'https://app.mailgun.com');
    push('brevo', 'Brevo', /sendinblue|brevo/.test(txt) && 'SPF includes Brevo', 'https://app.brevo.com');
    push('amazon-ses', 'Amazon SES', /amazonses\.com/.test(txt) && 'SPF includes amazonses.com', 'https://console.aws.amazon.com/ses');
    return found;
  }

  // --------------------------------------------------------------- git repos

  const REPO_HOSTS = {
    'github.com': 'github',
    'www.github.com': 'github',
    'gitlab.com': 'gitlab',
    'www.gitlab.com': 'gitlab',
    'bitbucket.org': 'bitbucket',
    'codeberg.org': 'codeberg',
  };

  function parseRepoUrl(value) {
    let url;
    try {
      url = new URL(String(value || '').trim());
    } catch {
      return null;
    }
    const host = url.hostname.replace(/^www\./, '');
    const kind = REPO_HOSTS[host];
    if (!kind) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const name = parts[1].replace(/\.git$/i, '');
    if (!owner || !name) return null;
    return { host, kind, owner, name, url: 'https://' + host + '/' + owner + '/' + name };
  }

  // --------------------------------------------------- dependencies and files

  /**
   * package.json dependency → what it tells us. `stack` is the human name for
   * the Stack row, `service` becomes a service entry, `tag` feeds tags.
   */
  const DEPENDENCIES = [
    { dep: /^next$/, stack: 'Next.js', tag: 'nextjs' },
    { dep: /^react$/, stack: 'React' },
    { dep: /^vue$/, stack: 'Vue' },
    { dep: /^nuxt$/, stack: 'Nuxt', tag: 'nuxt' },
    { dep: /^svelte$/, stack: 'Svelte' },
    { dep: /^@sveltejs\/kit$/, stack: 'SvelteKit', tag: 'sveltekit' },
    { dep: /^astro$/, stack: 'Astro', tag: 'astro' },
    { dep: /^@remix-run\//, stack: 'Remix', tag: 'remix' },
    { dep: /^solid-js$/, stack: 'Solid' },
    { dep: /^angular$|^@angular\/core$/, stack: 'Angular', tag: 'angular' },
    { dep: /^electron$/, stack: 'Electron', tag: 'electron' },
    { dep: /^expo$/, stack: 'Expo', tag: 'expo' },
    { dep: /^express$/, stack: 'Express' },
    { dep: /^fastify$/, stack: 'Fastify' },
    { dep: /^hono$/, stack: 'Hono' },
    { dep: /^koa$/, stack: 'Koa' },
    { dep: /^vite$/, stack: 'Vite' },
    { dep: /^tailwindcss$/, stack: 'Tailwind CSS', tag: 'tailwind' },
    { dep: /^typescript$/, stack: 'TypeScript', tag: 'typescript' },
    { dep: /^drizzle-orm$/, stack: 'Drizzle ORM', tag: 'drizzle' },
    { dep: /^@prisma\/client$|^prisma$/, stack: 'Prisma', tag: 'prisma' },
    { dep: /^@trpc\//, stack: 'tRPC', tag: 'trpc' },
    { dep: /^graphql$|^@apollo\//, stack: 'GraphQL' },
    { dep: /^zod$/, stack: 'Zod' },
    { dep: /^@neondatabase\/serverless$|^neon$/, service: { provider: 'Neon', role: 'database', url: 'https://console.neon.tech' }, tag: 'neon' },
    { dep: /^@supabase\/supabase-js$|^supabase$/, service: { provider: 'Supabase', role: 'database', url: 'https://supabase.com/dashboard' }, tag: 'supabase' },
    { dep: /^@planetscale\/database$/, service: { provider: 'PlanetScale', role: 'database', url: 'https://app.planetscale.com' }, tag: 'planetscale' },
    { dep: /^@libsql\/client$|^libsql$/, service: { provider: 'Turso', role: 'database', url: 'https://turso.tech/app' }, tag: 'turso' },
    { dep: /^mongoose$|^mongodb$/, service: { provider: 'MongoDB', role: 'database' }, tag: 'mongodb' },
    { dep: /^pg$|^postgres$/, service: { provider: 'PostgreSQL', role: 'database' } },
    { dep: /^mysql2$/, service: { provider: 'MySQL', role: 'database' } },
    { dep: /^redis$|^ioredis$/, service: { provider: 'Redis', role: 'cache' } },
    { dep: /^@upstash\/redis$|^@upstash\/ratelimit$/, service: { provider: 'Upstash', role: 'cache', url: 'https://console.upstash.com' }, tag: 'upstash' },
    { dep: /^@clerk\//, service: { provider: 'Clerk', role: 'auth', url: 'https://dashboard.clerk.com' }, tag: 'clerk' },
    { dep: /^next-auth$|^@auth\/core$|^@auth\//, service: { provider: 'Auth.js', role: 'auth', url: 'https://authjs.dev' }, tag: 'authjs' },
    { dep: /^@auth0\//, service: { provider: 'Auth0', role: 'auth', url: 'https://manage.auth0.com' }, tag: 'auth0' },
    { dep: /^firebase$|^firebase-admin$/, service: { provider: 'Firebase', role: 'auth', url: 'https://console.firebase.google.com' }, tag: 'firebase' },
    { dep: /^@workos-inc\//, service: { provider: 'WorkOS', role: 'auth', url: 'https://dashboard.workos.com' }, tag: 'workos' },
    { dep: /^stripe$|^@stripe\//, service: { provider: 'Stripe', role: 'payments', url: 'https://dashboard.stripe.com' }, tag: 'stripe' },
    { dep: /^@lemonsqueezy\//, service: { provider: 'Lemon Squeezy', role: 'payments', url: 'https://app.lemonsqueezy.com' }, tag: 'lemonsqueezy' },
    { dep: /^@paddle\/paddle-js$|^@paddle\/paddle-node$/, service: { provider: 'Paddle', role: 'payments', url: 'https://vendors.paddle.com' }, tag: 'paddle' },
    { dep: /^resend$|^@resend\//, service: { provider: 'Resend', role: 'email', url: 'https://resend.com/api-keys' }, tag: 'resend' },
    { dep: /^@sendgrid\/mail$/, service: { provider: 'SendGrid', role: 'email', url: 'https://app.sendgrid.com' }, tag: 'sendgrid' },
    { dep: /^postmark$/, service: { provider: 'Postmark', role: 'email', url: 'https://account.postmarkapp.com' }, tag: 'postmark' },
    { dep: /^mailgun\.js$/, service: { provider: 'Mailgun', role: 'email', url: 'https://app.mailgun.com' }, tag: 'mailgun' },
    { dep: /^@getbrevo\/brevo$|^sib-api-v3-sdk$/, service: { provider: 'Brevo', role: 'email', url: 'https://app.brevo.com' }, tag: 'brevo' },
    { dep: /^@aws-sdk\/client-s3$/, service: { provider: 'AWS S3', role: 'storage', url: 'https://s3.console.aws.amazon.com' }, tag: 's3' },
    { dep: /^uploadthing$|^@uploadthing\//, service: { provider: 'UploadThing', role: 'storage', url: 'https://uploadthing.com/dashboard' }, tag: 'uploadthing' },
    { dep: /^cloudinary$|^@cloudinary\//, service: { provider: 'Cloudinary', role: 'storage', url: 'https://console.cloudinary.com' }, tag: 'cloudinary' },
    { dep: /^@vercel\/analytics$|^@vercel\/speed-insights$/, service: { provider: 'Vercel Analytics', role: 'analytics', url: 'https://vercel.com/dashboard/analytics' }, tag: 'vercel' },
    { dep: /^posthog-js$|^posthog-node$/, service: { provider: 'PostHog', role: 'analytics', url: 'https://app.posthog.com' }, tag: 'posthog' },
    { dep: /^plausible-tracker$|^@plausible\//, service: { provider: 'Plausible', role: 'analytics', url: 'https://plausible.io' }, tag: 'plausible' },
    { dep: /^@sentry\//, service: { provider: 'Sentry', role: 'monitoring', url: 'https://sentry.io' }, tag: 'sentry' },
    { dep: /^openai$/, service: { provider: 'OpenAI', role: 'ai', url: 'https://platform.openai.com' }, tag: 'openai' },
    { dep: /^@anthropic-ai\/sdk$/, service: { provider: 'Anthropic', role: 'ai', url: 'https://console.anthropic.com' }, tag: 'anthropic' },
    { dep: /^@google\/generative-ai$|^@google\/genai$/, service: { provider: 'Google AI', role: 'ai', url: 'https://aistudio.google.com' }, tag: 'google-ai' },
    { dep: /^@livekit\//, service: { provider: 'LiveKit', role: 'realtime', url: 'https://cloud.livekit.io' }, tag: 'livekit' },
    { dep: /^socket\.io$|^socket\.io-client$/, service: { provider: 'Socket.IO', role: 'realtime' }, tag: 'socketio' },
    { dep: /^@mux\/mux-js$|^mux$/, service: { provider: 'Mux', role: 'video', url: 'https://dashboard.mux.com' }, tag: 'mux' },
  ];

  const FILE_SIGNALS = [
    { file: 'vercel.json', service: { provider: 'Vercel', role: 'hosting', url: 'https://vercel.com/dashboard' }, tag: 'vercel' },
    { file: 'netlify.toml', service: { provider: 'Netlify', role: 'hosting', url: 'https://app.netlify.com' }, tag: 'netlify' },
    { file: 'wrangler.toml', service: { provider: 'Cloudflare Workers', role: 'hosting', url: 'https://dash.cloudflare.com' }, tag: 'cloudflare' },
    { file: 'fly.toml', service: { provider: 'Fly.io', role: 'hosting', url: 'https://fly.io/dashboard' }, tag: 'fly' },
    { file: 'render.yaml', service: { provider: 'Render', role: 'hosting', url: 'https://dashboard.render.com' }, tag: 'render' },
    { file: 'railway.json', service: { provider: 'Railway', role: 'hosting', url: 'https://railway.app/dashboard' }, tag: 'railway' },
    { file: 'railway.toml', service: { provider: 'Railway', role: 'hosting', url: 'https://railway.app/dashboard' }, tag: 'railway' },
    { file: 'docker-compose.yml', stack: 'Docker', tag: 'docker' },
    { file: 'docker-compose.yaml', stack: 'Docker', tag: 'docker' },
    { file: 'Dockerfile', stack: 'Docker', tag: 'docker' },
    { file: 'prisma/schema.prisma', service: { provider: 'Prisma', role: 'database' }, tag: 'prisma' },
    { file: 'supabase/config.toml', service: { provider: 'Supabase', role: 'database', url: 'https://supabase.com/dashboard' }, tag: 'supabase' },
    { file: 'tsconfig.json', stack: 'TypeScript', tag: 'typescript' },
  ];

  const ENV_KEYS = [
    { key: /^VERCEL_/, service: { provider: 'Vercel', role: 'hosting', url: 'https://vercel.com/dashboard' }, tag: 'vercel' },
    { key: /^NEON_|^POSTGRES_PRISMA_URL$|^POSTGRES_URL$/, service: { provider: 'Neon', role: 'database', url: 'https://console.neon.tech' }, tag: 'neon' },
    { key: /^SUPABASE_/, service: { provider: 'Supabase', role: 'database', url: 'https://supabase.com/dashboard' }, tag: 'supabase' },
    { key: /^CLERK_/, service: { provider: 'Clerk', role: 'auth', url: 'https://dashboard.clerk.com' }, tag: 'clerk' },
    { key: /^STRIPE_/, service: { provider: 'Stripe', role: 'payments', url: 'https://dashboard.stripe.com' }, tag: 'stripe' },
    { key: /^RESEND_/, service: { provider: 'Resend', role: 'email', url: 'https://resend.com/api-keys' }, tag: 'resend' },
    { key: /^UPSTASH_/, service: { provider: 'Upstash', role: 'cache', url: 'https://console.upstash.com' }, tag: 'upstash' },
    { key: /^R2_|^S3_|^AWS_/, service: { provider: 'AWS', role: 'storage', url: 'https://console.aws.amazon.com' }, tag: 'aws' },
    { key: /^LIVEKIT_/, service: { provider: 'LiveKit', role: 'realtime', url: 'https://cloud.livekit.io' }, tag: 'livekit' },
    { key: /^OPENAI_/, service: { provider: 'OpenAI', role: 'ai', url: 'https://platform.openai.com' }, tag: 'openai' },
    { key: /^ANTHROPIC_/, service: { provider: 'Anthropic', role: 'ai', url: 'https://console.anthropic.com' }, tag: 'anthropic' },
    { key: /^POSTHOG_/, service: { provider: 'PostHog', role: 'analytics', url: 'https://app.posthog.com' }, tag: 'posthog' },
    { key: /^SENTRY_/, service: { provider: 'Sentry', role: 'monitoring', url: 'https://sentry.io' }, tag: 'sentry' },
    { key: /^TURSO_/, service: { provider: 'Turso', role: 'database', url: 'https://turso.tech/app' }, tag: 'turso' },
    { key: /^PLANETSCALE_/, service: { provider: 'PlanetScale', role: 'database', url: 'https://app.planetscale.com' }, tag: 'planetscale' },
  ];

  const PYTHON_DEPS = [
    { dep: /^fastapi$/i, stack: 'FastAPI', tag: 'fastapi' },
    { dep: /^django$/i, stack: 'Django', tag: 'django' },
    { dep: /^flask$/i, stack: 'Flask', tag: 'flask' },
    { dep: /^streamlit$/i, stack: 'Streamlit', tag: 'streamlit' },
    { dep: /^sqlalchemy$/i, stack: 'SQLAlchemy' },
    { dep: /^psycopg2?(-binary)?$/i, service: { provider: 'PostgreSQL', role: 'database' } },
    { dep: /^celery$/i, stack: 'Celery' },
    { dep: /^torch$/i, stack: 'PyTorch', tag: 'pytorch' },
    { dep: /^transformers$/i, stack: 'Transformers', tag: 'transformers' },
    { dep: /^supabase$/i, service: { provider: 'Supabase', role: 'database', url: 'https://supabase.com/dashboard' }, tag: 'supabase' },
    { dep: /^stripe$/i, service: { provider: 'Stripe', role: 'payments', url: 'https://dashboard.stripe.com' }, tag: 'stripe' },
    { dep: /^openai$/i, service: { provider: 'OpenAI', role: 'ai', url: 'https://platform.openai.com' }, tag: 'openai' },
  ];

  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function packageDependencies(files) {
    const pkg = safeJson(files['package.json'] || '');
    if (!pkg || typeof pkg !== 'object') return [];
    const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {}, pkg.peerDependencies || {});
    return Object.keys(deps);
  }

  function pythonDependencies(files) {
    const text = files['requirements.txt'] || '';
    const names = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const name = trimmed.split(/[<>=!~\[; ]/)[0];
      if (name) names.push(name);
    }
    const pyproject = files['pyproject.toml'] || '';
    const quoted = pyproject.match(/"([a-zA-Z0-9_.-]+)\s*[<>=!~]?[^"]*"/g) || [];
    for (const item of quoted) {
      const name = item.replace(/"/g, '').split(/[<>=!~\[; ]/)[0];
      if (name) names.push(name);
    }
    return names;
  }

  // ------------------------------------------------------------------ engine

  function addUnique(list, item, keyFn) {
    const key = keyFn ? keyFn(item) : item;
    if (list.some((existing) => (keyFn ? keyFn(existing) : existing) === key)) return false;
    list.push(item);
    return true;
  }

  function tagFor(value) {
    return String(value || '')
      .toLowerCase()
      .trim()
      .replace(/\+/g, 'plus')
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 24);
  }

  /**
   * @param {object} signals { site, dns, repo, offline }
   * @returns {object} findings — everything detected, with evidence.
   */
  function classify(signals) {
    const input = signals || {};
    const site = input.site || null;
    const repo = input.repo || null;
    const dns = input.dns || {};
    const findings = {
      hosting: [],
      dns: [],
      email: [],
      cdn: [],
      services: [],
      stack: [],
      languages: [],
      tags: [],
      page: null,
      repo: null,
      evidence: [],
      sources: [],
      warnings: [],
      offline: Boolean(input.offline),
    };

    if (site && site.html) {
      findings.page = describePage(site.html, site.finalUrl || site.url);
      findings.sources.push({ kind: 'site', url: site.finalUrl || site.url });
      findings.hosting = detectHosting({ site, dns });
      findings.cdn = detectCdn({ site });
      if (!findings.page.image) {
        findings.warnings.push('No social preview image found on the page.');
      }
    } else if (site) {
      findings.warnings.push('The site did not return readable HTML.');
    }

    if (dns && (dns.ns || []).length) {
      findings.dns = detectDns({ dns });
      findings.email = detectEmail({ dns });
    }

    if (repo) {
      findings.sources.push({ kind: 'repo', url: repo.url });
      findings.repo = {
        kind: repo.kind,
        owner: repo.owner,
        name: repo.name,
        description: (repo.meta && repo.meta.description) || '',
        homepage: (repo.meta && repo.meta.homepage) || '',
        topics: (repo.meta && repo.meta.topics) || [],
        language: (repo.meta && repo.meta.language) || '',
        stars: (repo.meta && repo.meta.stargazers_count) || 0,
      };
      const files = repo.files || {};

      const language = findings.repo.language;
      if (language) {
        addUnique(findings.languages, { name: language, evidence: 'GitHub primary language' }, (x) => x.name.toLowerCase());
      }
      const languages = repo.languages || {};
      Object.entries(languages)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .forEach(([name, bytes]) => {
          if (name.toLowerCase() === String(language).toLowerCase()) return;
          addUnique(
            findings.languages,
            { name, evidence: Math.round(bytes / 1024) + ' KB in the repo' },
            (x) => x.name.toLowerCase()
          );
        });

      if (files['package.json']) {
        const deps = packageDependencies(files);
        for (const dep of deps) {
          const rule = DEPENDENCIES.find((entry) => entry.dep.test(dep));
          if (!rule) continue;
          if (rule.stack) addUnique(findings.stack, { name: rule.stack, evidence: dep + ' dependency' }, (x) => x.name.toLowerCase());
          if (rule.service) {
            addUnique(
              findings.services,
              Object.assign({}, rule.service, { evidence: dep + ' dependency' }),
              (x) => x.provider + '|' + x.role
            );
          }
          if (rule.tag) addUnique(findings.tags, rule.tag);
        }
        if (!findings.languages.length) {
          addUnique(findings.languages, { name: 'JavaScript', evidence: 'package.json' }, (x) => x.name.toLowerCase());
        }
      }
      if (files['tsconfig.json']) {
        addUnique(findings.stack, { name: 'TypeScript', evidence: 'tsconfig.json' }, (x) => x.name.toLowerCase());
        addUnique(findings.tags, 'typescript');
        addUnique(findings.languages, { name: 'TypeScript', evidence: 'tsconfig.json' }, (x) => x.name.toLowerCase());
      }
      if (files['requirements.txt'] || files['pyproject.toml']) {
        addUnique(findings.languages, { name: 'Python', evidence: 'Python manifest' }, (x) => x.name.toLowerCase());
        for (const dep of pythonDependencies(files)) {
          const rule = PYTHON_DEPS.find((entry) => entry.dep.test(dep));
          if (!rule) continue;
          if (rule.stack) addUnique(findings.stack, { name: rule.stack, evidence: dep + ' dependency' }, (x) => x.name.toLowerCase());
          if (rule.service) {
            addUnique(findings.services, Object.assign({}, rule.service, { evidence: dep + ' dependency' }), (x) => x.provider + '|' + x.role);
          }
          if (rule.tag) addUnique(findings.tags, rule.tag);
        }
      }
      if (files['Cargo.toml']) {
        addUnique(findings.languages, { name: 'Rust', evidence: 'Cargo.toml' }, (x) => x.name.toLowerCase());
        addUnique(findings.stack, { name: 'Rust', evidence: 'Cargo.toml' }, (x) => x.name.toLowerCase());
      }
      if (files['go.mod']) {
        addUnique(findings.languages, { name: 'Go', evidence: 'go.mod' }, (x) => x.name.toLowerCase());
      }
      if (files['Gemfile']) {
        addUnique(findings.languages, { name: 'Ruby', evidence: 'Gemfile' }, (x) => x.name.toLowerCase());
        if (/rails/i.test(files['Gemfile'])) {
          addUnique(findings.stack, { name: 'Rails', evidence: 'Gemfile' }, (x) => x.name.toLowerCase());
          addUnique(findings.tags, 'rails');
        }
      }
      if (files['composer.json']) {
        addUnique(findings.languages, { name: 'PHP', evidence: 'composer.json' }, (x) => x.name.toLowerCase());
      }

      for (const rule of FILE_SIGNALS) {
        if (!(rule.file in files)) continue;
        if (rule.stack) addUnique(findings.stack, { name: rule.stack, evidence: rule.file }, (x) => x.name.toLowerCase());
        if (rule.service) {
          addUnique(
            findings.services,
            Object.assign({}, rule.service, { evidence: rule.file }),
            (x) => x.provider + '|' + x.role
          );
        }
        if (rule.tag) addUnique(findings.tags, rule.tag);
      }

      const envText = files['.env.example'] || files['.env.sample'] || '';
      if (envText) {
        const keys = envText
          .split(/\r?\n/)
          .map((line) => line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/))
          .filter(Boolean)
          .map((match) => match[1]);
        for (const key of keys) {
          const rule = ENV_KEYS.find((entry) => entry.key.test(key));
          if (!rule) continue;
          addUnique(
            findings.services,
            Object.assign({}, rule.service, { evidence: key + ' in .env.example' }),
            (x) => x.provider + '|' + x.role
          );
          if (rule.tag) addUnique(findings.tags, rule.tag);
        }
      }
    }

    if (site && site.html) {
      const html = String(site.html);
      const htmlRules = [
        { test: /__NEXT_DATA__|\/_next\/static\//, stack: 'Next.js', tag: 'nextjs' },
        { test: /data-sveltekit|_app\/immutable\//, stack: 'SvelteKit', tag: 'sveltekit' },
        { test: /__NUXT__|\/_nuxt\//, stack: 'Nuxt', tag: 'nuxt' },
        { test: /astro-island|data-astro-cid/, stack: 'Astro', tag: 'astro' },
        { test: /wp-content\//, stack: 'WordPress', tag: 'wordpress' },
        { test: /cdn\.shopify\.com/, stack: 'Shopify', tag: 'shopify' },
        { test: /_vercel\/insights/, service: { provider: 'Vercel Analytics', role: 'analytics', url: 'https://vercel.com/dashboard/analytics' }, tag: 'vercel' },
        { test: /plausible\.io\/js/, service: { provider: 'Plausible', role: 'analytics', url: 'https://plausible.io' }, tag: 'plausible' },
        { test: /posthog\.com/, service: { provider: 'PostHog', role: 'analytics', url: 'https://app.posthog.com' }, tag: 'posthog' },
        { test: /js\.stripe\.com/, service: { provider: 'Stripe', role: 'payments', url: 'https://dashboard.stripe.com' }, tag: 'stripe' },
        { test: /clerk\.accounts\.dev|clerk\.com/, service: { provider: 'Clerk', role: 'auth', url: 'https://dashboard.clerk.com' }, tag: 'clerk' },
        { test: /supabase\.co\/auth/, service: { provider: 'Supabase', role: 'auth', url: 'https://supabase.com/dashboard' }, tag: 'supabase' },
        { test: /resend\.com/, service: { provider: 'Resend', role: 'email', url: 'https://resend.com/api-keys' }, tag: 'resend' },
        { test: /livekit\.io/, service: { provider: 'LiveKit', role: 'realtime', url: 'https://cloud.livekit.io' }, tag: 'livekit' },
      ];
      for (const rule of htmlRules) {
        if (!rule.test.test(html)) continue;
        if (rule.stack) addUnique(findings.stack, { name: rule.stack, evidence: 'markup on the page' }, (x) => x.name.toLowerCase());
        if (rule.service) {
          addUnique(findings.services, Object.assign({}, rule.service, { evidence: 'script on the page' }), (x) => x.provider + '|' + x.role);
        }
        if (rule.tag) addUnique(findings.tags, rule.tag);
      }
      const powered = headerValue((site && site.headers) || {}, 'x-powered-by');
      if (powered) {
        if (/next/i.test(powered)) addUnique(findings.stack, { name: 'Next.js', evidence: 'x-powered-by: ' + powered }, (x) => x.name.toLowerCase());
        if (/express/i.test(powered)) addUnique(findings.stack, { name: 'Express', evidence: 'x-powered-by: ' + powered }, (x) => x.name.toLowerCase());
        if (/php/i.test(powered)) addUnique(findings.stack, { name: 'PHP', evidence: 'x-powered-by: ' + powered }, (x) => x.name.toLowerCase());
        if (/asp\.net/i.test(powered)) addUnique(findings.stack, { name: 'ASP.NET', evidence: 'x-powered-by: ' + powered }, (x) => x.name.toLowerCase());
      }
      if (findings.page && /next\.js/i.test(findings.page.generator)) {
        addUnique(findings.stack, { name: 'Next.js', evidence: 'generator meta' }, (x) => x.name.toLowerCase());
      }
    }

    // Hosting and DNS are services too; keep one list the UI can show as
    // "detected services" and one list for "how it is hosted".
    for (const item of [...findings.hosting, ...findings.cdn, ...findings.dns, ...findings.email]) {
      addUnique(
        findings.services,
        { provider: item.label, role: item.role, url: item.url || '', notes: item.evidence, evidence: item.evidence },
        (x) => x.provider + '|' + x.role
      );
      if (item.id) addUnique(findings.tags, tagFor(item.label));
    }

    // Evidence list for the sheet: the strongest single line per category.
    const primary = (list) => (list.length ? list[0] : null);
    for (const [label, item] of [
      ['Hosting', primary(findings.hosting)],
      ['CDN', primary(findings.cdn)],
      ['DNS', primary(findings.dns)],
      ['Email', primary(findings.email)],
    ]) {
      if (item) findings.evidence.push({ label, value: item.label, because: item.evidence });
    }
    for (const item of findings.stack.slice(0, 5)) {
      findings.evidence.push({ label: 'Stack', value: item.name, because: item.evidence });
    }
    for (const item of findings.languages.slice(0, 3)) {
      findings.evidence.push({ label: 'Language', value: item.name, because: item.evidence });
    }

    findings.tags = findings.tags.slice(0, LIMITS.tags);
    return findings;
  }

  function lowerSet(list) {
    return new Set((list || []).map((value) => String(value || '').toLowerCase()));
  }

  /**
   * Turn findings into something the user can tick. Anything already in the
   * project is filtered out so applying twice is a no-op, and nothing that is
   * already set is ever proposed as a replacement.
   */
  function proposals(findings, project) {
    const f = findings || classify({});
    const p = project || { stack: [], tags: [], services: [], links: [] };
    const stack = lowerSet(p.stack);
    const tags = lowerSet(p.tags);
    const serviceKeys = new Set((p.services || []).map((s) => (s.provider + '|' + s.role).toLowerCase()));

    const newStack = [];
    for (const item of f.stack || []) {
      if (stack.has(item.name.toLowerCase())) continue;
      stack.add(item.name.toLowerCase());
      newStack.push(item);
      if (newStack.length >= LIMITS.stack) break;
    }

    const newServices = [];
    for (const item of f.services || []) {
      const key = (item.provider + '|' + item.role).toLowerCase();
      if (serviceKeys.has(key)) continue;
      serviceKeys.add(key);
      newServices.push(item);
      if (newServices.length >= LIMITS.services) break;
    }

    const newTags = [];
    for (const item of f.tags || []) {
      const tag = tagFor(item);
      if (!tag || tags.has(tag)) continue;
      tags.add(tag);
      newTags.push(tag);
      if (newTags.length >= LIMITS.tags) break;
    }

    const sources = (f.sources || []).map((source) => source.url).filter(Boolean);
    const links = [];
    const homepage = f.repo && f.repo.homepage;
    const hasLive = (p.links || []).some(
      (link) => link.kind === 'live' && String(link.url || '').toLowerCase() === String(homepage || '').toLowerCase()
    );
    if (/^https?:\/\//i.test(String(homepage || '')) && !hasLive && !(p.links || []).some((link) => link.kind === 'live')) {
      links.push({ label: 'Live', kind: 'live', url: homepage });
    }
    const summary = [];
    const hosting = (f.hosting || [])[0];
    const database = (f.services || []).find((s) => s.role === 'database');
    if (hosting) summary.push('hosted on ' + hosting.label);
    if (database) summary.push(database.provider + ' for data');
    if (f.languages.length) summary.push(f.languages.map((l) => l.name).join(', '));

    const note = sources.length
      ? 'Auto-detected from ' +
        sources.map((url) => url.replace(/^https?:\/\//, '')).join(' and ') +
        (summary.length ? ': ' + summary.join('; ') + '.' : '.')
      : '';

    return {
      stack: newStack,
      tags: newTags,
      services: newServices,
      links,
      languages: f.languages || [],
      evidence: f.evidence || [],
      warnings: f.warnings || [],
      note,
      summary: summary.length ? summary.join('; ') : 'Nothing conclusive yet.',
      sources,
      hasAnything: Boolean(newStack.length || newTags.length || newServices.length || links.length || note),
      offline: Boolean(f.offline),
    };
  }

  /** A compact one-line description used by toasts and the overview card. */
  function headline(findings) {
    const f = findings || {};
    const bits = [];
    const hosting = (f.hosting || [])[0];
    if (hosting) bits.push(hosting.label);
    const database = (f.services || []).find((s) => s.role === 'database');
    if (database) bits.push(database.provider);
    for (const stack of (f.stack || []).slice(0, 2)) bits.push(stack.name);
    return bits.slice(0, 4).join(' · ');
  }

  return {
    LIMITS,
    readHtml,
    parseAttributes,
    decodeEntities,
    absoluteUrl,
    pickPreviewImage,
    describePage,
    parseRepoUrl,
    classify,
    proposals,
    headline,
    tagFor,
    safeJson,
    DEPENDENCIES,
  };
});
