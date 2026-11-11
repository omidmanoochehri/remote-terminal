/**
 * The command palette (Ctrl+Shift+P, or "Command palette…" in a terminal's
 * menu): one search over the terminal menu's actions, snippets, presets, open
 * terminals and machines. Enter runs the top match; a click runs that one.
 */

import { S } from './strings.js';
import { searchListDialog } from './pickers.js';
import { launchPreset } from './actions.js';
import { sendSnippet } from './snippetsUi.js';

/**
 * [actions] are the current screen's menu entries (`{ label, icon, onClick }`,
 * dividers and nulls allowed); [terminal] is `{ agentId, send, bracketed }`
 * when a terminal can take a snippet.
 */
export async function openPalette(app, { actions = [], terminal = null } = {}) {
  const items = [];
  for (const a of actions) {
    if (!a || a.divider || a.paletteSkip || !a.label || !a.onClick) continue;
    items.push({ label: a.label, icon: a.icon, run: a.onClick });
  }
  if (terminal) {
    for (const snippet of app.settings.snippets) {
      items.push({
        label: S.paletteSnippet(snippet.name),
        detail: snippet.body.split('\n')[0],
        icon: 'command',
        run: () => sendSnippet(app, snippet, { send: terminal.send, bracketed: terminal.bracketed?.() }),
      });
    }
  }
  const presets = terminal ? app.settings.presetsFor(terminal.agentId) : app.settings.terminalPresets;
  for (const preset of presets) {
    items.push({
      label: S.palettePreset(preset.name),
      icon: 'bookmark',
      run: () => launchPreset(app, preset, terminal?.agentId ?? null),
    });
  }
  for (const s of app.sessions.sessions.values()) {
    const agent = app.agents.agent(s.agentId);
    const machine = agent?.name || agent?.hostname || '';
    items.push({
      label: S.paletteSwitch(s.displayTitle),
      detail: machine,
      icon: 'terminal_square',
      run: () => (terminal?.switchTo ? terminal.switchTo(s) : app.openTerminal(s.agentId, s.sessionId)),
    });
  }
  for (const agent of app.agents.agents) {
    items.push({
      label: S.paletteMachine(agent.name || agent.hostname),
      detail: agent.online ? S.machineOnline : S.machineOffline,
      icon: 'monitor',
      run: () => app.openMachine(agent.agentId),
    });
  }
  const chosen = await searchListDialog({ title: S.shortcutPalette, placeholder: S.paletteHint, items });
  if (chosen) await chosen.run();
}
