'use strict';

/*
 * napkin++ — one place for the strings that appear in more than one process.
 *
 * The repository slug is the single fact a release has to get right: the
 * in-app update check, the feedback issue link, the site's download button and
 * the CI release workflow all derive from it. Change it here (and in
 * site/assets/config.js) before the first push.
 */

module.exports = {
  PRODUCT: 'napkin++',
  REPO: 'tracyapps/napkin-plus-plus',
  REPO_URL: 'https://github.com/tracyapps/napkin-plus-plus',
  SITE_URL: 'https://napkinplusplus.app',
  SUPPORT_URL: 'https://napkinplusplus.app/support',
  DOWNLOAD_URL: 'https://github.com/tracyapps/napkin-plus-plus/releases/latest',
  FEEDBACK_EMAIL: 'hello@napkinplusplus.app',
  DEVELOPER_URL: 'https://tapps.design',
  RELEASES_API: 'https://api.github.com/repos/tracyapps/napkin-plus-plus/releases/latest',
  USER_AGENT: 'napkin++-app',
};
