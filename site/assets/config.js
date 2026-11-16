/* napkin++ — one place for the site's links and handles.
   Everything else reads from here. No build step. */

(function () {
  "use strict";

  var repo = "tapps/napkin-plus-plus";
  var github = "https://github.com/" + repo;

  window.NAPKIN = {
    repo: repo,
    github: github,
    downloadUrl: github + "/releases/latest",
    releasesUrl: github + "/releases",
    issuesUrl: github + "/issues",
    email: "hello@napkinplusplus.app",
    version: "1.0.0",
    requirements: "macOS 12+",
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
    }
  };
})();
