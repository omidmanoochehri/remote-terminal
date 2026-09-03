'use strict';

/*
 * Environment for spawned shells.
 *
 * By default a shell receives only a minimal, non-sensitive allowlist of the
 * agent's environment, so a remote user cannot read service tokens or other
 * secrets that happen to be set for the agent process. INHERIT_ENV=1 opts
 * back into the full environment (documented, not recommended).
 */

const WINDOWS_ALLOW = [
  'SystemRoot', 'windir', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'COMSPEC',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'USERNAME', 'USERDOMAIN',
  'COMPUTERNAME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'PSModulePath', 'WSLENV',
];

const POSIX_ALLOW = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ',
  'TERM', 'COLORTERM', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'EDITOR', 'VISUAL', 'PAGER',
];

/** LC_* locale variables are allowed as a family. */
const POSIX_PREFIXES = ['LC_'];

/**
 * @param {{platform?:string, source?:object, inherit?:boolean}} opts
 * @returns {object} environment for the child shell
 */
function buildEnv({ platform = process.platform, source = process.env, inherit = false } = {}) {
  const env = {};
  if (inherit) {
    Object.assign(env, source);
  } else if (platform === 'win32') {
    const lower = new Map(Object.keys(source).map((k) => [k.toLowerCase(), k]));
    for (const k of WINDOWS_ALLOW) {
      const real = lower.get(k.toLowerCase());
      if (real != null && source[real] != null) env[real] = source[real];
    }
  } else {
    for (const k of POSIX_ALLOW) if (source[k] != null) env[k] = source[k];
    for (const k of Object.keys(source)) {
      if (POSIX_PREFIXES.some((p) => k.startsWith(p)) && source[k] != null) env[k] = source[k];
    }
    if (!env.LANG && !env.LC_ALL) env.LANG = 'C.UTF-8'; // UTF-8 output for a UTF-8 terminal
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

module.exports = { buildEnv, WINDOWS_ALLOW, POSIX_ALLOW };
