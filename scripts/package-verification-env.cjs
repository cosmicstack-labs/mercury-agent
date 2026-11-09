const { join } = require('node:path');

// The skill CLI's install-root override takes precedence over MERCURY_HOME.
// Override both so verification never changes an owner's installed skills.
function packageVerificationEnv(tmp, inherited = process.env) {
  const home = join(tmp, 'mercury home');
  return {
    ...inherited,
    HOME: tmp,
    USERPROFILE: tmp,
    MERCURY_HOME: home,
    MERCURY_SKILLS_INSTALL_ROOT: join(home, 'skills'),
    MERCURY_PLUGIN_CATALOG_URL: 'off',
    MERCURY_PLUGINS: 'off',
    NO_COLOR: '1',
  };
}

module.exports = { packageVerificationEnv };
