/**
 * The resolution hook `platform-node.mjs` registers: any import of the app's
 * `platform.js` resolves to the Node implementation instead. Nothing else is
 * touched, so every other module the harness loads is the shipping one.
 */

let mapping = { real: '', fake: '' };

export async function initialize(data) {
  mapping = data;
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url === mapping.real) return { ...resolved, url: mapping.fake, shortCircuit: true };
  return resolved;
}
