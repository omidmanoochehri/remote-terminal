/**
 * Saved terminals: a name, where to start and what to run. Clicking one starts
 * it straight away; a preset without a machine asks which one to use.
 *
 * A port of `TerminalPresetsFragment.kt`.
 */

import { Screen } from './base.js';
import { el, clear, svgIcon, header, headerAction, stateBlock, rowsCard } from '../dom.js';
import { S } from '../strings.js';
import { menu, confirmDialog } from '../overlays.js';
import { launchPreset } from '../actions.js';

export function presetsScreen(app) {
  const screen = new Screen(app, S.presetsTitle);

  const list = el('div');
  const body = el('div.screen-body.wide', null, list);
  const root = el('div.screen', null,
    header({
      title: S.presetsTitle,
      subtitle: S.presetsSubtitle,
      onBack: () => app.back(),
      actions: [headerAction('plus', S.presetNew, () => app.openPresetEditor(null, null))],
    }),
    body);

  /** The label under a preset: its machine, or "any machine" when it floats. */
  function machineName(agentId) {
    if (agentId == null) return S.presetAnyMachine;
    const agent = app.agents.agent(agentId);
    if (!agent) return S.presetMachineGone;
    return agent.name || agent.hostname;
  }

  function render() {
    const presets = app.settings.terminalPresets;
    clear(list);

    if (presets.length === 0) {
      list.append(stateBlock({
        icon: 'bookmark',
        title: S.presetsEmptyTitle,
        body: S.presetsEmptyBody,
        actionLabel: S.presetNew,
        onAction: () => app.openPresetEditor(null, null),
      }));
      return;
    }

    list.append(rowsCard(presets.map((preset) => el('div', { style: { display: 'flex', alignItems: 'center' } },
      el('button.row-item', {
        onClick: () => launchPreset(app, preset),
        title: S.presetStart,
      },
      el('div.row-text', null,
        el('div.row-title', { text: preset.name }),
        el('div.row-meta', { text: preset.directory || S.presetNoDirectory }),
        preset.command
          ? el('div.row-meta', { text: S.presetCommandLine(preset.command), style: { fontFamily: 'var(--mono)' } })
          : null,
        el('div.row-meta', {
          text: [machineName(preset.agentId), preset.shellId].filter(Boolean).join('  •  '),
        })),
      svgIcon('play')),
      el('div', { style: { paddingRight: '8px' } },
        headerAction('more', S.more, (e) => rowMenu(e.currentTarget, preset)))))));

    list.append(el('button.cta', {
      onClick: () => app.openPresetEditor(null, null),
      style: { marginTop: '12px' },
    }, svgIcon('plus'), el('span', { text: S.presetNew })));
  }

  function rowMenu(anchor, preset) {
    menu(anchor, [
      { label: S.presetStart, icon: 'play', onClick: () => launchPreset(app, preset) },
      { label: S.edit, icon: 'settings', onClick: () => app.openPresetEditor(preset.id, preset.agentId) },
      { divider: true },
      { label: S.delete, icon: 'trash', danger: true, onClick: () => confirmDelete(preset) },
    ]);
  }

  async function confirmDelete(preset) {
    const ok = await confirmDialog({
      title: S.presetDeleteTitle(preset.name),
      body: S.presetDeleteBody,
      confirmLabel: S.delete,
      danger: true,
    });
    if (ok) app.settings.deletePreset(preset.id);
  }

  screen.listen(app.settings, 'changed', render);
  screen.listen(app.agents, 'agents', render);
  render();

  screen.root = root;
  return screen;
}
