/* napkin++ — site behaviour. Vanilla, no dependencies. */

(function () {
  "use strict";

  var CFG = window.NAPKIN || {};
  var root = document.documentElement;
  var THEME_KEY = "napkin-theme";
  var ACCENT_KEY = "napkin-accent";
  var THEMES = ["system", "light", "dark"];
  var ACCENTS = ["ember", "moss", "ink", "plum"];
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function read(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function write(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      /* private mode, storage full — the current page still works */
    }
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[character];
    });
  }

  function copyText(text) {
    function legacyCopy() {
      return new Promise(function (resolve, reject) {
        var field = document.createElement("textarea");
        field.value = text;
        field.setAttribute("readonly", "");
        field.style.position = "fixed";
        field.style.top = "-1000px";
        field.style.left = "-1000px";
        document.body.appendChild(field);
        field.select();
        field.setSelectionRange(0, field.value.length);

        try {
          var copied = document.execCommand("copy");
          document.body.removeChild(field);
          if (copied) resolve();
          else reject(new Error("copy failed"));
        } catch (error) {
          document.body.removeChild(field);
          reject(error);
        }
      });
    }

    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(legacyCopy);
    }
    return legacyCopy();
  }

  /* ------------------------------------------------------------- theme */

  function themePreference() {
    var saved = read(THEME_KEY);
    if (THEMES.indexOf(saved) !== -1) return saved;
    if (THEMES.indexOf(root.getAttribute("data-theme-pref")) !== -1) {
      return root.getAttribute("data-theme-pref");
    }
    return "system";
  }

  function resolvedTheme(preference) {
    if (preference === "system") {
      return darkQuery && darkQuery.matches ? "dark" : "light";
    }
    return preference;
  }

  function applyTheme(preference, persist) {
    var next = THEMES.indexOf(preference) === -1 ? "system" : preference;
    root.setAttribute("data-theme-pref", next);
    root.setAttribute("data-theme", resolvedTheme(next));

    document.querySelectorAll("[data-theme-set]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-theme-set") === next));
    });

    var toggle = document.querySelector("[data-theme-toggle]");
    if (toggle) {
      var position = THEMES.indexOf(next);
      var upcoming = THEMES[(position + 1) % THEMES.length];
      var label = toggle.querySelector("[data-theme-label]");
      if (label) label.textContent = next;
      toggle.setAttribute("aria-label", "theme: " + next + ". switch to " + upcoming + ".");
      toggle.setAttribute("title", "theme: " + next + " — click for " + upcoming);
    }

    if (persist) write(THEME_KEY, next);
  }

  function applyAccent(name, persist) {
    var next = ACCENTS.indexOf(name) === -1 ? "ember" : name;
    root.setAttribute("data-accent", next);

    document.querySelectorAll("[data-set-accent]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-set-accent") === next));
    });

    if (persist) write(ACCENT_KEY, next);
  }

  function initTheme() {
    applyTheme(themePreference(), false);

    var toggle = document.querySelector("[data-theme-toggle]");
    if (toggle) {
      toggle.addEventListener("click", function () {
        var position = THEMES.indexOf(themePreference());
        applyTheme(THEMES[(position + 1) % THEMES.length], true);
      });
    }

    document.querySelectorAll("[data-theme-set]").forEach(function (button) {
      button.addEventListener("click", function () {
        applyTheme(button.getAttribute("data-theme-set"), true);
      });
    });

    var savedAccent = read(ACCENT_KEY);
    applyAccent(ACCENTS.indexOf(savedAccent) === -1 ? root.getAttribute("data-accent") || "ember" : savedAccent, false);

    document.querySelectorAll("[data-set-accent]").forEach(function (button) {
      button.addEventListener("click", function () {
        applyAccent(button.getAttribute("data-set-accent"), true);
      });
    });

    if (darkQuery) {
      var onSchemeChange = function () {
        if (themePreference() === "system") applyTheme("system", false);
      };
      if (darkQuery.addEventListener) darkQuery.addEventListener("change", onSchemeChange);
      else if (darkQuery.addListener) darkQuery.addListener(onSchemeChange);
    }
  }

  /* ------------------------------------------------------------ config */

  function initConfig() {
    document.querySelectorAll("[data-download]").forEach(function (link) {
      if (CFG.downloadUrl) link.href = CFG.downloadUrl;
    });

    document.querySelectorAll("[data-github]").forEach(function (link) {
      if (CFG.github) link.href = CFG.github;
    });

    document.querySelectorAll("[data-releases]").forEach(function (link) {
      if (CFG.releasesUrl) link.href = CFG.releasesUrl;
    });

    document.querySelectorAll("[data-email]").forEach(function (link) {
      if (CFG.email) link.href = "mailto:" + CFG.email;
    });

    document.querySelectorAll("[data-email-text]").forEach(function (element) {
      if (CFG.email) element.textContent = CFG.email;
    });

    document.querySelectorAll("[data-version]").forEach(function (element) {
      if (CFG.version) element.textContent = CFG.version;
    });

    document.querySelectorAll("[data-year]").forEach(function (element) {
      element.textContent = String(new Date().getFullYear());
    });

    // "for developers with more API keys than ___." Pick one per page load and
    // avoid repeating the previous pick when the browser allows sessionStorage.
    var moreThan = document.querySelector("[data-more-than]");
    var options = CFG.moreThan || [];
    if (moreThan && options.length) {
      var last = -1;
      try {
        last = Number(sessionStorage.getItem("napkin-more-than"));
      } catch (error) {
        last = -1;
      }
      var index = Math.floor(Math.random() * options.length);
      if (options.length > 1 && index === last) index = (index + 1) % options.length;
      try {
        sessionStorage.setItem("napkin-more-than", String(index));
      } catch (error) {
        /* private mode; still random every load */
      }
      moreThan.textContent = options[index];
    }

    document.querySelectorAll("[data-apps]").forEach(function (link) {
      if (CFG.elsewhere && CFG.elsewhere.apps) link.href = CFG.elsewhere.apps;
    });

    document.querySelectorAll("[data-developer]").forEach(function (link) {
      if (CFG.elsewhere && CFG.elsewhere.developer) link.href = CFG.elsewhere.developer;
    });

    document.querySelectorAll("[data-support]").forEach(function (link) {
      var entry = CFG.support && CFG.support[link.getAttribute("data-support")];
      if (!entry) return;
      link.href = entry.url;

      var handle = link.querySelector("[data-support-handle]");
      if (handle) handle.textContent = entry.handle;

      var note = link.querySelector("[data-support-note]");
      if (note) note.textContent = entry.note;
    });
  }

  /* --------------------------------------------------------------- nav */

  function initNav() {
    var head = document.querySelector(".site-head");
    var toggle = document.querySelector("[data-nav-toggle]");
    if (!head || !toggle) return;

    function setOpen(open) {
      if (open) head.setAttribute("data-nav-open", "");
      else head.removeAttribute("data-nav-open");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "close menu" : "open menu");
    }

    toggle.addEventListener("click", function (event) {
      event.stopPropagation();
      setOpen(!head.hasAttribute("data-nav-open"));
    });

    head.querySelectorAll(".site-nav a").forEach(function (link) {
      link.addEventListener("click", function () {
        setOpen(false);
      });
    });

    document.addEventListener("click", function (event) {
      if (head.hasAttribute("data-nav-open") && !head.contains(event.target)) setOpen(false);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && head.hasAttribute("data-nav-open")) {
        setOpen(false);
        toggle.focus();
      }
    });

    if (window.matchMedia) {
      var wide = window.matchMedia("(min-width: 901px)");
      var onChange = function () {
        if (wide.matches) setOpen(false);
      };
      if (wide.addEventListener) wide.addEventListener("change", onChange);
      else if (wide.addListener) wide.addListener(onChange);
    }
  }

  /* ------------------------------------------------------------ contact */

  function initContact() {
    var form = document.querySelector("[data-contact-form]");
    if (!form) return;

    var status = document.querySelector("[data-form-status]");
    var fallback = document.querySelector("[data-contact-fallback]");
    var fallbackLink = fallback && fallback.querySelector("[data-fallback-link]");
    var success = document.querySelector("[data-contact-success]");
    var submit = form.querySelector('button[type="submit"]');
    var submitText = submit ? submit.textContent : "";

    function values() {
      return {
        name: (form.elements.name.value || "").trim(),
        email: (form.elements.email.value || "").trim(),
        topic: (form.elements.topic.value || "").trim(),
        message: (form.elements.message.value || "").trim()
      };
    }

    function mailtoFor(data) {
      var subject = "napkin++ — " + (data.topic || "site message");
      var body = data.message + "\n\n— " + data.name + "\n" + data.email;
      return "mailto:" + (CFG.email || "hello@napkinplusplus.app") +
        "?subject=" + encodeURIComponent(subject) +
        "&body=" + encodeURIComponent(body);
    }

    function showSuccess() {
      form.hidden = true;
      if (fallback) fallback.hidden = true;
      if (success) {
        success.hidden = false;
        var heading = success.querySelector("h2");
        if (heading) {
          heading.setAttribute("tabindex", "-1");
          heading.focus();
        }
      }
      if (status) status.textContent = "message sent. thank you.";
    }

    function showFallback(data) {
      if (fallback) {
        fallback.hidden = false;
        if (fallbackLink) fallbackLink.href = mailtoFor(data);
        var heading = fallback.querySelector("h2");
        if (heading) {
          heading.setAttribute("tabindex", "-1");
          heading.focus();
        }
      }
      if (status) status.textContent = "the form could not send. use the email link below — your message is already in it.";
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!form.reportValidity()) return;

      var data = values();

      if (form.elements.website && form.elements.website.value) {
        showSuccess();
        return;
      }

      if (submit) {
        submit.disabled = true;
        submit.textContent = "sending…";
      }
      if (status) status.textContent = "sending…";
      if (fallback) fallback.hidden = true;

      fetch("/api/contact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(data)
      })
        .then(function (response) {
          if (!response.ok) throw new Error("contact request failed: " + response.status);
          return response;
        })
        .then(function () {
          showSuccess();
        })
        .catch(function () {
          showFallback(data);
        })
        .finally(function () {
          if (submit) {
            submit.disabled = false;
            submit.textContent = submitText;
          }
        });
    });
  }

  /* --------------------------------------------------------------- demo */

  var DEMO_PROJECTS = [
    {
      id: "lu",
      name: "lu app",
      mark: "lu",
      alias: "client portal",
      status: "active",
      tone: "#5c7a4f",
      stack: ["next.js", "supabase", "tailwind"],
      tags: ["client", "dev"],
      services: ["vercel", "supabase", "resend"],
      meta: "2 accounts · 4 vars · next.js",
      accounts: [
        { label: "test-1", meta: "dev · one@lu.example", value: "demo-not-a-real-password" },
        { label: "test-2", meta: "staging · two@lu.example", value: "demo-not-a-real-password-either" }
      ],
      keys: [
        { key: "STRIPE_SECRET", env: "dev", value: "demo_not_a_real_stripe_key" },
        { key: "DATABASE_URL", env: "dev", value: "postgres://demo:notreal@localhost:5432/lu" },
        { key: "NEXT_PUBLIC_API_URL", env: "dev", value: "http://localhost:3000/api" },
        { key: "SUPABASE_ANON_KEY", env: "staging", value: "demo_not_a_real_supabase_key" }
      ],
      folder: "clients"
    },
    {
      id: "field-notes",
      name: "field notes",
      mark: "fn",
      alias: "notes app",
      status: "active",
      tone: "#3f5f82",
      stack: ["sveltekit", "sqlite"],
      tags: ["personal"],
      services: ["cloudflare"],
      meta: "1 account · 2 vars · sveltekit",
      accounts: [
        { label: "owner", meta: "prod · me@fieldnotes.example", value: "demo-field-notes-password" }
      ],
      keys: [
        { key: "DATABASE_URL", env: "dev", value: "file:./field-notes.db" },
        { key: "SESSION_SECRET", env: "prod", value: "demo_not_a_real_session_secret" }
      ],
      folder: "personal"
    },
    {
      id: "sandbox",
      name: "sandbox",
      mark: "sb",
      alias: "experiments",
      status: "active",
      tone: "#7a4f72",
      stack: ["vite", "workers"],
      tags: ["lab"],
      services: ["cloudflare"],
      meta: "0 accounts · 3 vars · vite",
      accounts: [],
      keys: [
        { key: "CLOUDFLARE_API_TOKEN", env: "dev", value: "demo_not_a_real_cloudflare_token" },
        { key: "R2_ACCESS_KEY", env: "dev", value: "demo_not_a_real_r2_key" },
        { key: "R2_SECRET", env: "dev", value: "demo_not_a_real_r2_secret" }
      ],
      folder: "lab"
    },
    {
      id: "atlas",
      name: "atlas api",
      mark: "at",
      alias: "maps service",
      status: "active",
      tone: "#b2531f",
      stack: ["fastify", "postgres", "neon"],
      tags: ["api"],
      services: ["neon", "fly"],
      meta: "2 accounts · 2 vars · fastify",
      accounts: [
        { label: "service", meta: "prod · service@atlas.example", value: "demo-atlas-service-password" },
        { label: "readonly", meta: "prod · readonly@atlas.example", value: "demo-atlas-readonly-password" }
      ],
      keys: [
        { key: "NEON_DATABASE_URL", env: "prod", value: "postgres://demo:notreal@example.neon.tech/atlas" },
        { key: "MAPS_API_KEY", env: "prod", value: "demo_not_a_real_maps_key" }
      ],
      folder: "clients"
    },
    {
      id: "paper-trail",
      name: "paper trail",
      mark: "pt",
      alias: "invoices",
      status: "active",
      tone: "#5c7a4f",
      stack: ["astro", "stripe"],
      tags: ["client"],
      services: ["stripe", "resend", "netlify"],
      meta: "1 account · 3 vars · astro",
      accounts: [
        { label: "admin", meta: "prod · admin@papertrail.example", value: "demo-paper-trail-password" }
      ],
      keys: [
        { key: "STRIPE_SECRET", env: "prod", value: "demo_not_a_real_stripe_key" },
        { key: "RESEND_API_KEY", env: "prod", value: "demo_not_a_real_resend_key" },
        { key: "STRIPE_WEBHOOK_SECRET", env: "prod", value: "demo_not_a_real_webhook_secret" }
      ],
      folder: "clients"
    },
    {
      id: "signal-desk",
      name: "signal desk",
      mark: "sd",
      alias: "live support",
      status: "active",
      tone: "#3f5f82",
      stack: ["remix", "livekit"],
      tags: ["realtime"],
      services: ["livekit", "vercel"],
      meta: "2 accounts · 2 vars · remix",
      accounts: [
        { label: "agent-1", meta: "dev · agent@signal.example", value: "demo-signal-agent-password" },
        { label: "agent-2", meta: "staging · agent2@signal.example", value: "demo-signal-agent2-password" }
      ],
      keys: [
        { key: "LIVEKIT_URL", env: "dev", value: "wss://demo.livekit.example" },
        { key: "LIVEKIT_API_SECRET", env: "dev", value: "demo_not_a_real_livekit_secret" }
      ],
      folder: "lab"
    },
    {
      id: "night-shift",
      name: "night shift",
      mark: "ns",
      alias: "on call",
      status: "active",
      tone: "#7a4f72",
      stack: ["hono", "d1"],
      tags: ["side"],
      services: ["cloudflare"],
      meta: "1 account · 2 vars · hono",
      accounts: [
        { label: "on-call", meta: "prod · oncall@nightshift.example", value: "demo-night-shift-password" }
      ],
      keys: [
        { key: "D1_TOKEN", env: "prod", value: "demo_not_a_real_d1_token" },
        { key: "ALERT_WEBHOOK", env: "prod", value: "https://hooks.example/demo/not-real" }
      ],
      folder: "personal"
    },
    {
      id: "tin-roof",
      name: "tin roof",
      mark: "tr",
      alias: "landing page",
      status: "active",
      tone: "#b2531f",
      stack: ["astro", "netlify"],
      tags: ["site"],
      services: ["netlify"],
      meta: "0 accounts · 1 var · astro",
      accounts: [],
      keys: [
        { key: "NETLIFY_AUTH_TOKEN", env: "prod", value: "demo_not_a_real_netlify_token" }
      ],
      folder: "personal"
    }
  ];

  function initDemo() {
    var demo = document.querySelector("[data-demo]");
    if (!demo) return;

    var input = demo.querySelector("[data-demo-input]");
    var grid = demo.querySelector("[data-demo-grid]");
    var results = demo.querySelector("[data-demo-results]");
    var resultsHead = demo.querySelector("[data-demo-results-head]");
    var empty = demo.querySelector("[data-demo-empty]");
    var dossierHost = demo.querySelector("[data-demo-dossier]");
    var live = demo.querySelector("[data-demo-live]");
    if (!input || !grid || !results || !dossierHost) return;

    var byId = {};
    DEMO_PROJECTS.forEach(function (project) {
      byId[project.id] = project;
    });

    var matches = [];
    var active = 0;
    var current = null;

    function announce(message) {
      if (!live) return;
      live.textContent = "";
      window.setTimeout(function () {
        live.textContent = message;
      }, 30);
    }

    function search(query) {
      var needle = query.trim().toLowerCase();
      if (!needle) return [];
      var terms = needle.split(/\s+/);

      return DEMO_PROJECTS.map(function (project) {
        var haystack = [
          project.name,
          project.alias,
          project.stack.join(" "),
          project.tags.join(" "),
          project.services.join(" "),
          project.accounts.map(function (account) {
            return account.label + " " + account.meta;
          }).join(" "),
          project.keys.map(function (key) {
            return key.key + " " + key.env;
          }).join(" ")
        ].join(" ").toLowerCase();

        if (!terms.every(function (term) { return haystack.indexOf(term) !== -1; })) return null;

        var name = project.name.toLowerCase();
        var alias = project.alias.toLowerCase();
        var score = 4;
        if (name === needle) score = 0;
        else if (name.indexOf(needle) === 0) score = 1;
        else if (name.indexOf(needle) !== -1) score = 2;
        else if (alias.indexOf(needle) !== -1) score = 3;

        return { project: project, score: score };
      }).filter(Boolean).sort(function (a, b) {
        return a.score - b.score || a.project.name.localeCompare(b.project.name);
      }).slice(0, 8).map(function (entry) {
        return entry.project;
      });
    }

    function tileMarkup(project) {
      return '<li><button class="tile" type="button" data-open="' + esc(project.id) + '" style="--tone:' + esc(project.tone) + '" aria-label="open ' + esc(project.name) + ' — sample dossier">' +
        '<span class="tile-thumb" aria-hidden="true">' +
          '<span class="tile-lines"><i></i><i></i><i></i></span>' +
          '<span class="tile-mark">' + esc(project.mark) + '</span>' +
        '</span>' +
        '<span class="tile-body">' +
          '<span class="tile-name">' + esc(project.name) + '</span>' +
          '<span class="tile-meta">' + esc(project.meta) + '</span>' +
        '</span>' +
      '</button></li>';
    }

    function renderGrid() {
      grid.innerHTML = DEMO_PROJECTS.map(tileMarkup).join("");
    }

    function expanded(open) {
      input.setAttribute("aria-expanded", String(open));
      if (!open) input.removeAttribute("aria-activedescendant");
    }

    function showGrid() {
      grid.hidden = false;
      results.hidden = true;
      if (resultsHead) resultsHead.hidden = true;
      if (empty) empty.hidden = true;
      dossierHost.hidden = true;
      current = null;
      expanded(false);
    }

    function resultMarkup(project) {
      return '<li role="option" id="demo-opt-' + esc(project.id) + '" data-open="' + esc(project.id) + '" aria-selected="false">' +
        '<span class="res-badge" aria-hidden="true">proj</span>' +
        '<span class="res-main">' +
          '<span class="res-name">' + esc(project.name) + '</span>' +
          '<span class="res-meta">' + esc(project.status + " · " + project.stack.join(" · ") + " · " + project.accounts.length + " accounts") + '</span>' +
        '</span>' +
        '<span class="res-key" aria-hidden="true">↵ open</span>' +
      '</li>';
    }

    function updateSelection(scroll) {
      var options = results.querySelectorAll('[role="option"]');
      if (!options.length) {
        input.removeAttribute("aria-activedescendant");
        return;
      }
      if (active < 0) active = options.length - 1;
      if (active >= options.length) active = 0;

      options.forEach(function (option, index) {
        option.setAttribute("aria-selected", String(index === active));
        if (index === active) {
          input.setAttribute("aria-activedescendant", option.id);
          if (scroll) option.scrollIntoView({ block: "nearest" });
        }
      });
    }

    function showResults() {
      grid.hidden = true;
      dossierHost.hidden = true;
      current = null;
      results.innerHTML = matches.map(resultMarkup).join("");
      results.hidden = matches.length === 0;
      if (resultsHead) {
        resultsHead.hidden = matches.length === 0;
        resultsHead.textContent = matches.length + (matches.length === 1 ? " result" : " results");
      }
      if (empty) empty.hidden = matches.length > 0;
      expanded(true);
      active = 0;
      updateSelection(false);
    }

    function dossierMarkup(project) {
      var chips = project.stack.concat(project.tags).slice(0, 5).map(function (value) {
        var tag = project.tags.indexOf(value) !== -1;
        return '<span class="chip' + (tag ? " tag" : "") + '">' + esc(value) + '</span>';
      }).join("");

      var accounts = project.accounts.length ? project.accounts.map(function (account) {
        return '<div class="dossier-row">' +
          '<span class="dossier-label"><b>' + esc(account.label) + '</b><small>' + esc(account.meta) + '</small></span>' +
          '<span class="mask" aria-hidden="true">••••••••••</span>' +
          '<button class="copy-btn" type="button" data-copy="' + esc(account.value) + '" aria-label="copy ' + esc(account.label) + ' password — demo value">copy</button>' +
        '</div>';
      }).join("") : '<p class="dossier-meta">no accounts saved yet.</p>';

      var keys = project.keys.length ? project.keys.map(function (key) {
        return '<div class="dossier-row">' +
          '<span class="dossier-label"><b>' + esc(key.key) + '</b><small>' + esc(key.env) + '</small></span>' +
          '<span class="mask" aria-hidden="true">••••••••••</span>' +
          '<button class="copy-btn" type="button" data-copy="' + esc(key.value) + '" aria-label="copy ' + esc(key.key) + ' — demo value">copy</button>' +
        '</div>';
      }).join("") : '<p class="dossier-meta">no env vars saved yet.</p>';

      return '<article class="dossier" aria-label="' + esc(project.name) + ' sample dossier">' +
        '<div class="dossier-head">' +
          '<div class="dossier-title">' +
            '<span class="dossier-kicker">project · ' + esc(project.status) + '</span>' +
            '<h3 tabindex="-1">' + esc(project.name) + '</h3>' +
            '<p class="dossier-meta">' + esc(project.meta) + '</p>' +
            '<div class="dossier-chips">' + chips + '</div>' +
          '</div>' +
          '<button class="btn btn-ghost btn-sm dossier-back" type="button" data-demo-back>← projects</button>' +
        '</div>' +
        '<div class="dossier-cols">' +
          '<section class="dossier-col" aria-label="Accounts"><h4>accounts · ' + project.accounts.length + '</h4>' + accounts + '</section>' +
          '<section class="dossier-col" aria-label="Keys and environment"><h4>keys &amp; env · ' + project.keys.length + '</h4>' + keys + '</section>' +
        '</div>' +
        '<div class="dossier-foot"><span>sample data · no real keys</span><span>services: ' + esc(project.services.join(" · ")) + '</span></div>' +
      '</article>';
    }

    function openProject(id) {
      var project = byId[id];
      if (!project) return;

      current = project;
      matches = input.value.trim() ? search(input.value) : matches;
      grid.hidden = true;
      results.hidden = true;
      if (resultsHead) resultsHead.hidden = true;
      if (empty) empty.hidden = true;
      dossierHost.hidden = false;
      dossierHost.innerHTML = dossierMarkup(project);
      expanded(false);

      var heading = dossierHost.querySelector("h3");
      if (heading) heading.focus();
      announce("opened " + project.name + ". sample dossier, no real secrets.");
    }

    function closeDossier() {
      var returnId = current ? current.id : null;
      current = null;
      dossierHost.hidden = true;
      dossierHost.innerHTML = "";

      if (input.value.trim()) {
        matches = search(input.value);
        showResults();
        input.focus();
      } else {
        matches = [];
        showGrid();
        var tile = returnId && grid.querySelector('[data-open="' + returnId + '"]');
        if (tile) tile.focus();
        else input.focus();
      }
      announce("back to " + (input.value.trim() ? "search results" : "all projects") + ".");
    }

    renderGrid();
    showGrid();

    input.addEventListener("input", function () {
      var query = input.value;
      if (!query.trim()) {
        matches = [];
        showGrid();
        expanded(false);
        return;
      }
      matches = search(query);
      showResults();
    });

    input.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (results.hidden || !matches.length) return;
        event.preventDefault();
        active += event.key === "ArrowDown" ? 1 : -1;
        updateSelection(true);
      } else if (event.key === "Enter") {
        if (results.hidden || !matches.length) return;
        event.preventDefault();
        openProject(matches[active].id);
      } else if (event.key === "Escape") {
        if (!dossierHost.hidden) {
          event.preventDefault();
          closeDossier();
        } else if (input.value) {
          event.preventDefault();
          input.value = "";
          matches = [];
          showGrid();
          expanded(false);
          announce("search cleared. all projects.");
        }
      }
    });

    grid.addEventListener("click", function (event) {
      var trigger = event.target.closest("[data-open]");
      if (trigger) openProject(trigger.getAttribute("data-open"));
    });

    results.addEventListener("click", function (event) {
      var trigger = event.target.closest("[data-open]");
      if (trigger) openProject(trigger.getAttribute("data-open"));
    });

    dossierHost.addEventListener("click", function (event) {
      var back = event.target.closest("[data-demo-back]");
      if (back) {
        closeDossier();
        return;
      }

      var copy = event.target.closest("[data-copy]");
      if (!copy || copy.getAttribute("data-copied") === "true") return;

      copyText(copy.getAttribute("data-copy")).then(function () {
        copy.textContent = "copied";
        copy.setAttribute("data-copied", "true");
        announce("demo value copied. it is not a real secret.");
        window.setTimeout(function () {
          if (!copy.isConnected) return;
          copy.textContent = "copy";
          copy.removeAttribute("data-copied");
        }, 1600);
      }).catch(function () {
        announce("copy failed. this is demo data, not a real secret.");
      });
    });

    dossierHost.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !dossierHost.hidden) {
        event.preventDefault();
        closeDossier();
      }
    });

    document.addEventListener("keydown", function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        demo.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
        input.focus({ preventScroll: true });
        input.select();
      }
    });
  }

  function init() {
    initTheme();
    initConfig();
    initNav();
    initContact();
    initDemo();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
