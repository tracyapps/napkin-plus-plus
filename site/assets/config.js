/* napkin++ — one place for the site's links and handles.
   Everything else reads from here. No build step. */

(function () {
  "use strict";

  var repo = "tracyapps/napkin-plus-plus";
  var github = "https://github.com/" + repo;

  window.NAPKIN = {
    repo: repo,
    github: github,
    downloadUrl: github + "/releases/latest",
    releasesUrl: github + "/releases",
    issuesUrl: github + "/issues",
    email: "hello@napkinplusplus.app",
    version: "1.0.0",
    requirements: "macOS 13+",
    support: {
      cashapp: {
        name: "cash app",
        handle: "$therealtapps",
        url: "https://cash.app/$therealtapps",
        note: "opens cash.app"
      },
      venmo: {
        name: "venmo",
        handle: "@tracyapps",
        url: "https://venmo.com/u/tracyapps",
        note: "opens venmo.com"
      },
      paypal: {
        name: "paypal",
        handle: "@tapps",
        url: "https://paypal.me/tapps",
        note: "opens paypal.me"
      }
    },
    elsewhere: {
      apps: "https://gradhuely.com",
      developer: "https://tapps.design"
    },
    // The footer joke: "for developers with more API keys than ___."
    // One is picked at random on each page load; keep them plural and lowercase
    // except for proper nouns.
    moreThan: [
      "YubiKeys",
      "actual keys",
      "email accounts",
      "charging cables",
      "domain names",
      "IDE plugins",
      "LLM skills",
      "browser tabs",
      "side projects",
      "unfinished side projects",
      "half-read READMEs",
      "SSH keys",
      "password reset emails",
      "OAuth apps",
      "staging environments",
      "Vercel preview URLs",
      "forgotten npm packages",
      "unread release notes",
      "Slack workspaces",
      "Notion pages",
      "files named final-final-v3",
      ".env files",
      "dead Discord servers",
      "temporary admin accounts",
      "unused cloud regions",
      "free trials they forgot to cancel",
      "open pull requests",
      "TODO comments",
      "abandoned branches",
      "semver major versions",
      "terminal windows",
      "localhost ports",
      "Postman collections",
      "tokens they're afraid to revoke",
      "MCP servers",
      "agent prompts",
      "aliases in ~/.zshrc",
      "git worktrees",
      "feature flags",
      "deprecated SDKs",
      "whiteboard photos",
      "notebooks",
      "business cards",
      "Node versions",
      "one-more microservices",
      "cron jobs they forgot about",
      "README badges",
      "draft blog posts",
      "fonts they'll never use",
      "magic links",
      "expiring certificates",
      "design tokens",
      "Figma files named final",
      "calendar invites",
      "screenshots of error messages",
      "unopened Apple developer emails",
      ".DS_Store files",
      "keyboard shortcuts they've customized",
      "VS Code extensions",
      "bookmarked docs",
      "pinned Slack messages"
    ],
  };
})();
