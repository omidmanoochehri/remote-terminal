/**
 * The Node stand-in for `ui/js/core/platform.js`, used only by
 * `e2e-desktop.mjs`.
 *
 * In the app that module is the bridge to Rust: the relay socket, the pairing
 * calls, the credential store. Here it is a bridge to Node, so the end-to-end
 * harness can drive the *real* client code against a *real* relay without a
 * window. Everything above it — the protocol state machine, the repositories,
 * the emulator — is the shipping code, unmodified.
 *
 * The substitution is done with Node's module-resolution hooks rather than by
 * making the app aware of tests: production code never learns it is being
 * driven from a script.
 */

import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL_PLATFORM = pathToFileURL(path.join(here, '..', 'ui', 'js', 'core', 'platform.js')).href;
const FAKE_PLATFORM = pathToFileURL(path.join(here, 'platform-impl.mjs')).href;

/**
 * Point every `platform.js` import at the Node implementation, and hand it the
 * credentials the harness paired with.
 */
export function installTestPlatform(credentials) {
  globalThis.__rtTestCredentials = credentials;
  register(pathToFileURL(path.join(here, 'platform-hook.mjs')).href, import.meta.url, {
    data: { real: REAL_PLATFORM, fake: FAKE_PLATFORM },
  });
}
