/**
 * A saved way to start a terminal: a name, optionally a machine and a shell, a
 * working directory and a first command. Presets live on this device only —
 * launching one produces exactly the traffic that filling in the New terminal
 * form by hand would, so nothing about the protocol changes.
 *
 * A port of `TerminalPreset.kt`.
 */

export function makePreset({ id, name, agentId = null, shellId = null, directory = '', command = '' }) {
  return { id, name, agentId, shellId, directory, command };
}

export function newPresetId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function presetFromJson(o) {
  if (!o || typeof o !== 'object') return null;
  const id = typeof o.id === 'string' ? o.id : '';
  const name = typeof o.name === 'string' ? o.name : '';
  if (!id || !name) return null;
  const optional = (key) => (typeof o[key] === 'string' && o[key].length > 0 ? o[key] : null);
  return makePreset({
    id,
    name,
    agentId: optional('agentId'),
    shellId: optional('shellId'),
    directory: optional('directory') ?? '',
    command: optional('command') ?? '',
  });
}

export function presetsFromJson(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(presetFromJson).filter(Boolean);
}

export function presetsToJson(presets) {
  return presets.map((p) => {
    const o = { id: p.id, name: p.name };
    if (p.agentId) o.agentId = p.agentId;
    if (p.shellId) o.shellId = p.shellId;
    if (p.directory) o.directory = p.directory;
    if (p.command) o.command = p.command;
    return o;
  });
}
