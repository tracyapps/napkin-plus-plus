/*
 * napkin++ — paste parsers.
 *
 * The whole point of a napkin is that you scribble first and organize later.
 * These parsers turn whatever is on the clipboard into structure the vault can
 * accept: .env blocks, account lines, URL lists, pasted notes, and a whole old
 * notes file that needs to become projects.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NapkinParse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SENSITIVE_KEY = /(secret|token|password|passwd|pwd|key|credential|private|auth|dsn|webhook|salt|hash|signature|session|cookie)/i;
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const URL_RE = /https?:\/\/[^\s<>"']+/g;

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function isSecretKey(key) {
    return SENSITIVE_KEY.test(text(key));
  }

  function hostOf(value) {
    try {
      return new URL(text(value).trim()).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function trimUrl(url) {
    return text(url).replace(/[).,;:!\]]+$/, '');
  }

  // ------------------------------------------------------------------- .env

  function stripQuotes(value) {
    const v = text(value).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
      return v.slice(1, -1);
    }
    return v;
  }

  function parseEnvBlock(input) {
    const raw = text(input);
    const trimmed = raw.trim();
    const empty = { pairs: [], confidence: 0, source: 'none' };
    if (!trimmed) return empty;

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          const pairs = [];
          for (const [key, value] of Object.entries(obj)) {
            if (value !== null && typeof value === 'object') continue;
            pairs.push({ key, value: String(value), hidden: isSecretKey(key) });
          }
          if (pairs.length) return { pairs, confidence: 0.95, source: 'json' };
        }
      } catch {
        /* not JSON — fall through to line parsing */
      }
    }

    const pairs = [];
    let considered = 0;
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('//') || t.startsWith(';')) continue;
      considered += 1;
      const stripped = t.replace(/^export\s+/, '');
      const match = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*([:=])\s*(.*)$/.exec(stripped);
      if (!match) continue;
      const key = match[1];
      // `Key: value` only counts as env when the key is really env-shaped;
      // "Repo: https://…" is a link, not a variable.
      if (match[2] === ':' && !/^[A-Z0-9_]+$/.test(key)) continue;
      let value = match[3];
      if (value.startsWith('"') || value.startsWith("'")) {
        value = stripQuotes(value);
      } else {
        const comment = value.search(/\s#/);
        if (comment >= 0) value = value.slice(0, comment);
        value = value.trim();
      }
      pairs.push({ key, value, hidden: isSecretKey(key) });
    }
    const confidence = considered === 0 ? 0 : Math.min(1, pairs.length / considered);
    return { pairs, confidence, source: 'lines' };
  }

  // --------------------------------------------------------------- accounts

  /**
   * Best-effort password for an unlabelled line: only when exactly one
   * plausible token remains, or the line is explicitly delimited.
   */
  function inferPassword(line, email) {
    const rest = line
      .replace(email, ' ')
      .replace(/(?:user(?:name)?|login|uid|handle)\s*[:=]\s*\S+/gi, ' ')
      .replace(/(?:label|service|env|note|notes)\s*[:=]\s*[^|;,]+/gi, ' ')
      .replace(/[|,;]/g, ' ');
    const tokens = rest
      .split(/\s+/)
      .map((x) => x.replace(/^[-–—:]+|[-–—:]+$/g, ''))
      .filter(Boolean)
      .filter(
        (x) =>
          !/^(user|username|login|pass|password|pw|pwd|email|mail|acct|account|dev|prod|staging|test)$/i.test(
            x
          )
      );
    const plausible = tokens.filter(
      (x) =>
        x.length >= 6 &&
        !EMAIL.test(x) &&
        !/^https?:/.test(x) &&
        !/^(dashboard|console|admin|account|billing|notes?|hint|service|provider|platform|email|username|login)$/i.test(
          x
        )
    );
    if (plausible.length === 1) return plausible[0];
    if (plausible.length > 1 && /[|,\t]/.test(line)) return plausible[0];
    return '';
  }

  /** Account fields are typed: a login password is one of them. */
  function fieldsFor(line, email) {
    const explicit = /(?:pass(?:word)?|pw|pwd)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/i.exec(line);
    const value = explicit ? stripQuotes(explicit[1]) : inferPassword(line, email);
    if (!value) return [];
    return [{ label: 'Password', value, hidden: true }];
  }

  function parseAccountLines(input) {
    const out = [];
    const seen = new Set();
    for (const line of text(input).split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      if (t.length > 400) continue;
      const emailMatch = EMAIL.exec(t);
      if (!emailMatch) continue;
      const email = emailMatch[0];
      if (seen.has(email + '|' + t.length) && !/pass|password/i.test(t)) continue;
      seen.add(email + '|' + t.length);

      const before = t.slice(0, emailMatch.index);
      let label = '';
      const labelMatch = /(?:^|[|:]\s*)([^|:=]{1,40}?)\s*[:|]\s*$/.exec(before);
      if (labelMatch && !EMAIL.test(labelMatch[1])) label = labelMatch[1].trim();
      else if (/^[A-Za-z][A-Za-z0-9 ._-]{1,30}\s*[|—–]\s*$/.test(before)) {
        label = before.replace(/[|—–]\s*$/, '').trim();
      }

      let username = '';
      const userMatch = /(?:user(?:name)?|login|uid|handle)\s*[:=]\s*([^\s,;|]+)/i.exec(t);
      if (userMatch) username = userMatch[1].replace(/^["']|["']$/g, '');

      let notes = '';
      const noteMatch = /(?:note|notes|hint)\s*[:=]\s*(.+)$/i.exec(t);
      if (noteMatch) notes = noteMatch[1].trim().slice(0, 300);

      let env = '';
      const envMatch = /\b(prod|production|staging|stage|dev|development|local|test)\b/i.exec(t);
      if (envMatch) env = envMatch[1].toLowerCase();

      let service = '';
      const svcMatch = /(?:service|provider|platform)\s*[:=]\s*([A-Za-z0-9 .+-]{2,30})/i.exec(t);
      if (svcMatch) service = svcMatch[1].trim();

      out.push({
        label,
        email,
        username,
        fields: fieldsFor(t, email),
        notes,
        env,
        service,
        raw: t,
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ links

  function guessProvider(url) {
    const host = hostOf(url).toLowerCase();
    const map = [
      [/(^|\.)vercel\.com$/, 'Vercel'],
      [/(^|\.)vercel\.app$/, 'Vercel'],
      [/(^|\.)railway\.app$/, 'Railway'],
      [/(^|\.)railway\.com$/, 'Railway'],
      [/(^|\.)neon\.tech$/, 'Neon'],
      [/(^|\.)supabase\.co$/, 'Supabase'],
      [/(^|\.)supabase\.com$/, 'Supabase'],
      [/(^|\.)clerk\.com$/, 'Clerk'],
      [/(^|\.)clerk\.dev$/, 'Clerk'],
      [/(^|\.)livekit\.io$/, 'LiveKit'],
      [/(^|\.)livekit\.cloud$/, 'LiveKit'],
      [/(^|\.)resend\.com$/, 'Resend'],
      [/(^|\.)brevo\.com$/, 'Brevo'],
      [/(^|\.)sendinblue\.com$/, 'Brevo'],
      [/(^|\.)sendgrid\.com$/, 'SendGrid'],
      [/(^|\.)postmarkapp\.com$/, 'Postmark'],
      [/(^|\.)mailgun\.com$/, 'Mailgun'],
      [/(^|\.)github\.com$/, 'GitHub'],
      [/(^|\.)gitlab\.com$/, 'GitLab'],
      [/(^|\.)bitbucket\.org$/, 'Bitbucket'],
      [/(^|\.)cloudflare\.com$/, 'Cloudflare'],
      [/(^|\.)fly\.io$/, 'Fly.io'],
      [/(^|\.)planetscale\.com$/, 'PlanetScale'],
      [/(^|\.)turso\.tech$/, 'Turso'],
      [/(^|\.)upstash\.com$/, 'Upstash'],
      [/(^|\.)mongodb\.com$/, 'MongoDB'],
      [/(^|\.)stripe\.com$/, 'Stripe'],
      [/(^|\.)openai\.com$/, 'OpenAI'],
      [/(^|\.)anthropic\.com$/, 'Anthropic'],
      [/(^|\.)cloudinary\.com$/, 'Cloudinary'],
      [/(^|\.)uploadthing\.com$/, 'UploadThing'],
      [/(^|\.)sentry\.io$/, 'Sentry'],
      [/(^|\.)posthog\.com$/, 'PostHog'],
      [/(^|\.)linear\.app$/, 'Linear'],
      [/(^|\.)notion\.so$/, 'Notion'],
      [/(^|\.)figma\.com$/, 'Figma'],
      [/(^|\.)firebase\.google\.com$/, 'Firebase'],
      [/(^|\.)firebaseio\.com$/, 'Firebase'],
      [/(^|\.)aws\.amazon\.com$/, 'AWS'],
      [/(^|\.)amazonaws\.com$/, 'AWS'],
      [/(^|\.)netlify\.app$/, 'Netlify'],
      [/(^|\.)netlify\.com$/, 'Netlify'],
      [/(^|\.)render\.com$/, 'Render'],
      [/(^|\.)heroku\.com$/, 'Heroku'],
      [/(^|\.)twilio\.com$/, 'Twilio'],
      [/(^|\.)namecheap\.com$/, 'Namecheap'],
      [/(^|\.)porkbun\.com$/, 'Porkbun'],
      [/(^|\.)elevenlabs\.io$/, 'ElevenLabs'],
      [/(^|\.)replicate\.com$/, 'Replicate'],
      [/(^|\.)huggingface\.co$/, 'Hugging Face'],
    ];
    for (const [re, name] of map) if (re.test(host)) return name;
    return '';
  }

  function guessLinkKind(url, label) {
    const host = hostOf(url).toLowerCase();
    const l = text(label).toLowerCase();
    const full = text(url).toLowerCase();
    if (/(^|\.)(github|gitlab|bitbucket|codeberg)\.(com|org)$/.test(host) && !/\/dashboard/.test(full)) {
      return 'repo';
    }
    if (/\bdocs?\b|documentation|readme/.test(l) || /\/docs?\b|documentation/.test(full)) return 'docs';
    if (/dashboard|console|admin/.test(l) || /dashboard|console|admin/.test(full)) return 'dashboard';
    if (/staging|stage|preview/.test(l) || /staging|preview/.test(full)) return 'staging';
    if (/\blive\b|production|\bprod\b/.test(l)) return 'live';
    if (/(^|\.)(vercel\.app|netlify\.app|fly\.dev|onrender\.com|pages\.dev|web\.app|railway\.app)$/.test(host)) {
      return 'live';
    }
    if (/(^|\.)(vercel\.com|railway\.com|supabase\.com|neon\.tech|clerk\.com|livekit\.io|resend\.com|brevo\.com)$/.test(host)) {
      return 'dashboard';
    }
    return 'other';
  }

  function parseLinks(input) {
    const out = [];
    const seen = new Set();
    for (const line of text(input).split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const urls = t.match(URL_RE) || [];
      for (const rawUrl of urls) {
        const url = trimUrl(rawUrl);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        let label = t.slice(0, t.indexOf(rawUrl)).replace(/[-–—:|>]+\s*$/, '').trim();
        if (!label || /^[|>–—-]+$/.test(label)) label = '';
        out.push({
          url,
          label: label.slice(0, 60),
          kind: guessLinkKind(url, label),
          provider: guessProvider(url),
        });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ stack

  const STACK = [
    ['Next.js', /\bnext(?:\.js|js)\b/i],
    ['React', /\breact(?:\.js)?\b/i],
    ['Vue', /\bvue(?:\.js)?\b/i],
    ['Svelte', /\bsvelte(?:kit)?\b/i],
    ['Astro', /\bastro\b/i],
    ['Remix', /\bremix\b/i],
    ['TypeScript', /\btypescript\b|\bts\b(?=\s|\/)/i],
    ['JavaScript', /\bjavascript\b|\bnode(?:\.js)?\b/i],
    ['Tailwind', /\btailwind\b/i],
    ['Prisma', /\bprisma\b/i],
    ['Drizzle', /\bdrizzle\b/i],
    ['Python', /\bpython\b|\bdjango\b|\bflask\b|\bfastapi\b/i],
    ['Ruby', /\bruby\b|\brails\b/i],
    ['PHP', /\bphp\b|\blaravel\b/i],
    ['Go', /\bgolang\b|\bgo\s+1\.\d/i],
    ['Rust', /\brust\b/i],
    ['Swift', /\bswift\b/i],
    ['Kotlin', /\bkotlin\b/i],
    ['PostgreSQL', /\bpostgres(?:ql)?\b|\bpg\b/i],
    ['MySQL', /\bmysql\b|\bmariadb\b/i],
    ['SQLite', /\bsqlite\b/i],
    ['Redis', /\bredis\b/i],
    ['MongoDB', /\bmongo(?:db)?\b/i],
    ['Supabase', /\bsupabase\b/i],
    ['Firebase', /\bfirebase\b/i],
    ['Neon', /\bneon\b/i],
    ['Vercel', /\bvercel\b/i],
    ['Railway', /\brailway\b/i],
    ['Netlify', /\bnetlify\b/i],
    ['Cloudflare', /\bcloudflare\b|\bworkers\b/i],
    ['Docker', /\bdocker\b/i],
    ['Kubernetes', /\bkubernetes\b|\bk8s\b/i],
    ['LiveKit', /\blivekit\b/i],
    ['Clerk', /\bclerk\b/i],
    ['Stripe', /\bstripe\b/i],
    ['Resend', /\bresend\b/i],
    ['Brevo', /\bbrevo\b|\bsendinblue\b/i],
    ['OpenAI', /\bopenai\b|\bgpt-?4\b/i],
    ['Anthropic', /\banthropic\b|\bclaude\b/i],
    ['Electron', /\belectron\b/i],
    ['React Native', /\breact native\b|\bexpo\b/i],
  ];

  function detectStack(input) {
    const raw = text(input);
    const hits = [];
    for (const [name, re] of STACK) {
      const m = re.exec(raw);
      if (m) hits.push({ name, index: m.index });
    }
    hits.sort((a, b) => a.index - b.index);
    const out = [];
    for (const hit of hits) if (!out.includes(hit.name)) out.push(hit.name);
    return out.slice(0, 10);
  }

  // -------------------------------------------------------------- detection

  function hasFields(account) {
    return account.fields && account.fields.length > 0;
  }

  function detectTextKind(input) {
    const raw = text(input);
    const trimmed = raw.trim();
    if (!trimmed) return { kind: 'empty', confidence: 0 };
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
    const env = parseEnvBlock(trimmed);
    const accounts = parseAccountLines(trimmed);
    const links = parseLinks(trimmed);

    if (env.pairs.length >= 1 && env.confidence >= 0.55 && env.pairs.length >= Math.min(2, lines.length)) {
      return { kind: 'env', confidence: env.confidence, env };
    }
    if (accounts.length && (accounts.some(hasFields) || accounts.length > 1)) {
      return { kind: 'accounts', confidence: 0.8, accounts };
    }
    if (links.length && links.length >= Math.max(1, Math.round(lines.length * 0.5))) {
      return { kind: 'links', confidence: 0.75, links };
    }
    if (
      /^#!|^\s*(import|from|const|let|var|function|class|def|SELECT|CREATE|interface|export|package|func|fn)\b/m.test(
        trimmed
      ) ||
      (lines.length >= 2 && /\{[\s\S]*\}|<\/?[a-z][\s\S]*>/i.test(trimmed))
    ) {
      return { kind: 'code', confidence: 0.65 };
    }
    if (accounts.length) return { kind: 'accounts', confidence: 0.6, accounts };
    return { kind: 'note', confidence: 0.4 };
  }

  // ------------------------------------------------------------ blob splitter

  function headingOf(line) {
    const t = line.trim();
    if (!t || t.length > 70) return '';
    let m = /^#{1,6}\s+(.+)$/.exec(t);
    if (m) return m[1].trim();
    m = /^\[(.{1,60})\]$/.exec(t);
    if (m) return m[1].trim();
    m = /^(?:project|app|client|site)\s*[:—-]\s*(.+)$/i.exec(t);
    if (m) return m[1].trim();
    m = /^\*\*(.+?)\*\*$/.exec(t);
    if (m) return m[1].trim();
    m = /^(?:=+|-{3,}|—{2,}|\*{3,})\s*(.+?)\s*(?:=+|-{3,}|—{2,}|\*{3,})$/.exec(t);
    if (m) return m[1].trim();
    if (
      t.length >= 3 &&
      t.length <= 44 &&
      /[A-Z]/.test(t) &&
      t === t.toUpperCase() &&
      !/[=@]/.test(t) &&
      !/^[A-Z]{2,5}$/.test(t)
    ) {
      return t
        .toLowerCase()
        .replace(/\b[a-z]/g, (c) => c.toUpperCase())
        .replace(/[:#\-–—]+$/, '')
        .trim();
    }
    return '';
  }

  function hintFor(body) {
    const env = parseEnvBlock(body);
    const accounts = parseAccountLines(body);
    const links = parseLinks(body);
    const stack = detectStack(body);
    return {
      envPairs: env.pairs.length,
      envConfidence: env.confidence,
      accounts: accounts.length,
      links: links.length,
      stack,
      preview: body.replace(/\s+/g, ' ').trim().slice(0, 180),
    };
  }

  function dedupeNames(blocks) {
    const used = new Map();
    for (const block of blocks) {
      const key = block.name.toLowerCase();
      const n = used.get(key) || 0;
      used.set(key, n + 1);
      if (n > 0) block.name = block.name + ' (' + (n + 1) + ')';
    }
    return blocks;
  }

  function splitBlob(input, fallbackName) {
    const raw = text(input).replace(/\r\n/g, '\n');
    if (!raw.trim()) return [];
    const lines = raw.split('\n');
    const blocks = [];
    let current = { name: '', body: [] };
    let foundHeadings = 0;
    const divider = /^[-=_*—]{3,}\s*$/;
    const hasDividers = lines.some((line) => divider.test(line.trim()));

    if (hasDividers) {
      // Dashed rules are the strongest signal in hand-written notes; section
      // labels like "WP ADMIN:" or "SUPABASE" must not become projects.
      for (const line of lines) {
        if (divider.test(line.trim())) {
          if (current.body.join('\n').trim()) blocks.push(current);
          current = { name: '', body: [] };
        } else {
          current.body.push(line);
        }
      }
      if (current.body.join('\n').trim()) blocks.push(current);
    } else {
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const heading = headingOf(line);
        const prevBlank = i === 0 || !lines[i - 1].trim();
        const nextBlank = i === lines.length - 1 || !lines[i + 1].trim();
        const looksLikeHeading =
          heading && (prevBlank || foundHeadings > 0) && (nextBlank || !/^\s/.test(line));
        if (looksLikeHeading) {
          foundHeadings += 1;
          if (current.body.join('\n').trim() || current.name) blocks.push(current);
          current = { name: heading, body: [] };
        } else {
          current.body.push(line);
        }
      }
      if (current.body.join('\n').trim() || current.name) blocks.push(current);
    }

    let result = blocks
      .map((b, index) => {
        const body = b.body.join('\n').replace(/^\n+|\n+$/g, '');
        const fallback = text(fallbackName).trim() || 'Imported block ' + (index + 1);
        return {
          name: (b.name || '').trim() || guessName(body) || fallback,
          body,
        };
      })
      .filter((b) => b.body.trim() || b.name);

    if (!hasDividers && foundHeadings < 1) {
      const chunks = raw
        .split(/\n{3,}/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (chunks.length >= 2) {
        result = chunks.map((chunk, index) => {
          const fallback = [text(fallbackName).trim(), String(index + 1)].filter(Boolean).join(' ');
          return {
            name: guessName(chunk) || fallback || 'Imported napkin',
            body: chunk,
          };
        });
      } else {
        result = [
          {
            name: guessName(raw) || text(fallbackName).trim() || 'Imported napkin',
            body: raw.trim(),
          },
        ];
      }
    }

    result = result.filter((b) => b.body.trim());
    for (const block of result) block.hints = hintFor(block.body);
    return dedupeNames(result).slice(0, 80);
  }

  function guessName(body) {
    const lines = text(body)
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .slice(0, 4);
    const identityKey = /^(u|p|pw|db|user|username|email|login|pass|password|pwd|admin|host|port|url|uri|key|api|token|secret|credential|dsn|id|code|pin|note|notes|service|install|unit)$/i;
    const genericLabel = /^(service|install|unit|notes?|config|setup|usage|api|keys?|env|environment)$/i;
    for (const rawLine of lines) {
      const raw = rawLine.trim();
      const clean = raw
        .replace(/^#+\s*/, '')
        .replace(/[:#\-–—]+$/, '')
        .trim();
      if (clean.length < 2 || clean.length > 48) continue;
      if (clean.includes('@')) continue;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) continue;
      if (/^[A-Z_]+\s*=/.test(clean)) continue;
      if (/^(begin|end)\s+(public|private)\s+key$/i.test(clean)) continue;
      if (/^[A-Z0-9]{20,}$/.test(clean) || /^[A-Za-z0-9+/=_-]{24,}$/.test(clean)) continue;
      if (genericLabel.test(clean)) continue;

      const sep = raw.search(/[:=]/);
      if (sep >= 0) {
        const left = raw.slice(0, sep).trim();
        const right = raw.slice(sep + 1).trim();
        if (right) {
          if (identityKey.test(left)) continue;
          if (left.split(/\s+/).length > 3) continue;
          if (/(key|token|secret|pass|pwd|auth|credential|dsn|url|id|code|pin|note)/i.test(left)) continue;
          if (right.length > 24 || /[A-Za-z0-9+/=]{20,}/.test(right)) continue;
        }
      }
      return clean;
    }
    return '';
  }

  /** Minimal display project from a pasted blob, used by the importer. */
  function projectDraft(block) {
    const env = parseEnvBlock(block.body);
    const links = parseLinks(block.body);
    const accounts = parseAccountLines(block.body);
    const stack = detectStack(block.body);
    const services = [];
    const seen = new Set();
    for (const link of links) {
      if (link.provider && !seen.has(link.provider)) {
        seen.add(link.provider);
        services.push({
          provider: link.provider,
          role: link.kind === 'repo' ? 'code' : link.kind === 'live' ? 'hosting' : '',
          url: link.url,
          notes: '',
        });
      }
    }
    return {
      name: block.name,
      description: '',
      tags: [],
      stack,
      links: links.map((l) => ({ label: l.label || l.provider || hostOf(l.url), kind: l.kind, url: l.url })),
      services,
      envs:
        env.pairs.length >= 2
          ? [
              {
                name: 'dev',
                url: '',
                vars: env.pairs.map((p) => ({ key: p.key, value: p.value, hidden: p.hidden })),
              },
            ]
          : [],
      accounts: accounts.map((a) => ({
        label: a.label || a.env || 'account',
        email: a.email,
        username: a.username,
        fields: a.fields,
        service: a.service,
        env: a.env,
        notes: a.notes,
      })),
      entries: [],
    };
  }

  // -------------------------------------------------------- capture routing

  const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;
  const CODE_LINE = /^\s{2,}\S|\t|=>|[{};]\s*$|^\s*(import|from|const|let|var|function|class|def|return|export|package|func|fn|interface|type|SELECT|INSERT|UPDATE|CREATE|ALTER|curl|npm|npx|pnpm|yarn|git|docker|kubectl|sudo|echo|cd|ls)\b|^\s*(if|for|while|switch|try|catch)\s*\(|[=<>!]=|\$\{|\w+\([^)]*\)\s*;?$|<\/?[a-z][\w-]*[^>]*>/i;

  /** Split leftover capture text into code lines and prose lines. */
  function splitCodeAndNote(block) {
    const codeLines = [];
    const noteLines = [];
    let bucket = 'note';
    for (const line of text(block).split(/\r?\n/)) {
      if (!line.trim()) {
        (bucket === 'code' ? codeLines : noteLines).push(line);
        continue;
      }
      bucket = CODE_LINE.test(line) ? 'code' : 'note';
      (bucket === 'code' ? codeLines : noteLines).push(line);
    }
    const clean = (lines) => lines.join('\n').replace(/^\n+|\n+$/g, '').trim();
    return { code: clean(codeLines), note: clean(noteLines) };
  }

  /**
   * Split one pasted blob into the places a project keeps things: env vars,
   * logins, links, code, and a note for everything left over. Used by the
   * project overview capture box, where the paste already has a home — it is
   * only deciding which shelf in that project it belongs on.
   *
   * Lossless by design: a line is only consumed when it was fully understood;
   * anything ambiguous stays in the note.
   */
  function routeCapture(input) {
    const raw = text(input).replace(/\r\n/g, '\n');
    const trimmed = raw.trim();
    const result = { env: null, accounts: [], links: [], code: '', note: '', kinds: [] };
    if (!trimmed) return result;

    const lines = raw.split('\n');
    const used = new Array(lines.length).fill(false);
    const envKeys = new Set();

    const envLines = [];
    lines.forEach((line, index) => {
      const trimmedLine = line.trim();
      const match = ENV_LINE.exec(trimmedLine);
      if (!match) return;
      if (EMAIL.test(trimmedLine)) return;
      envLines.push(index);
    });

    const parsedEnv = parseEnvBlock(trimmed);
    const singleUppercase =
      parsedEnv.pairs.length === 1 && /^[A-Z0-9_]+$/.test(parsedEnv.pairs[0].key);
    if (parsedEnv.pairs.length && (envLines.length >= 2 || singleUppercase)) {
      result.env = parsedEnv;
      for (const pair of parsedEnv.pairs) envKeys.add(pair.key);
      lines.forEach((line, index) => {
        const match = ENV_LINE.exec(line.trim());
        if (match && envKeys.has(match[1])) used[index] = true;
      });
    }

    const accountText = lines.filter((line, index) => !used[index]).join('\n');
    const parsedAccounts = parseAccountLines(accountText);
    if (
      parsedAccounts.length &&
      (parsedAccounts.some(hasFields) || parsedAccounts.length > 1)
    ) {
      result.accounts = parsedAccounts;
      for (const account of parsedAccounts) {
        const index = lines.findIndex(
          (line, i) => !used[i] && line.includes(account.email)
        );
        if (index >= 0) used[index] = true;
      }
    }

    result.links = parseLinks(lines.filter((line, index) => !used[index]).join('\n'));
    for (const link of result.links) {
      const index = lines.findIndex((line, i) => !used[i] && line.includes(link.url));
      if (index < 0) continue;
      const leftover = lines[index]
        .replace(link.url, '')
        .replace(/^[\s\-–—:|>]+|[\s\-–—:|>]+$/g, '')
        .trim();
      // "Repo: https://…" is a link line; "deploy notes https://…" keeps its words.
      if (leftover.length <= 24) used[index] = true;
    }

    const rest = lines
      .filter((line, index) => !used[index])
      .join('\n')
      .replace(/^\n+|\n+$/g, '')
      .trim();
    if (rest) {
      if (detectTextKind(rest).kind === 'code') {
        const split = splitCodeAndNote(rest);
        result.code = split.code;
        result.note = split.note;
      } else {
        result.note = rest;
      }
    }

    if (result.env) result.kinds.push('env');
    if (result.accounts.length) result.kinds.push('accounts');
    if (result.links.length) result.kinds.push('links');
    if (result.code) result.kinds.push('code');
    if (result.note) result.kinds.push('note');
    return result;
  }

  return {
    isSecretKey,
    parseEnvBlock,
    parseAccountLines,
    parseLinks,
    detectTextKind,
    routeCapture,
    detectStack,
    guessProvider,
    guessLinkKind,
    splitBlob,
    projectDraft,
    headingOf,
    hostOf,
    trimUrl,
  };
});
