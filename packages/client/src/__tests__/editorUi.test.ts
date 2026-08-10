import { beforeEach, describe, expect, it } from 'vitest';

import { EditorUi, type UiCallbacks } from '../editor/ui.js';
import { defaultToolState, type ToolId, type ToolState } from '../editor/tools.js';

const callbacks: UiCallbacks = {
  onToolChange: () => {},
  onNew: () => {},
  onOpenFile: () => {},
  onSaveJson: () => {},
  onCopyModule: () => {},
  onPreview: () => {},
  onBakeChange: () => {},
  onUndo: () => {},
  onRedo: () => {},
  onNameChange: () => {},
  onIdChange: () => {},
  onObjectKindChange: () => {},
  onObjectPlacementChange: () => {},
  onAutoFlow: () => {},
  onMarkerKindChange: () => {},
};

beforeEach(() => {
  document.body.innerHTML = '';
});

function setup(): { ui: EditorUi; state: ToolState; selectTool(tool: ToolId): void } {
  const state = defaultToolState();
  const ui = new EditorUi(document.body, state, callbacks);
  return {
    ui,
    state,
    selectTool(tool) {
      state.tool = tool;
      ui.syncTool();
    },
  };
}

function section(title: string): HTMLElement {
  const heading = [...document.querySelectorAll<HTMLElement>('.ed-title')]
    .find((candidate) => candidate.textContent === title);
  if (!heading?.parentElement) throw new Error(`missing ${title} section`);
  return heading.parentElement;
}

function visibleFieldLabels(title: string): string[] {
  return [...section(title).querySelectorAll<HTMLElement>('.ed-field')]
    .filter((field) => field.style.display !== 'none')
    .map((field) => field.querySelector('.ed-label')?.textContent ?? '');
}

describe('EditorUi tool options', () => {
  it('shows only the sections used by the selected tool', () => {
    const { selectTool } = setup();

    expect(section('Brush').hidden).toBe(false);
    for (const title of ['Surface', 'Water', 'Object', 'Spawn', 'Marker', 'Delete']) {
      expect(section(title).hidden, title).toBe(true);
    }

    selectTool('paint');
    expect(section('Brush').hidden).toBe(false);
    expect(section('Surface').hidden).toBe(false);
    expect(section('Water').hidden).toBe(true);

    selectTool('water');
    expect(section('Brush').hidden).toBe(false);
    expect(section('Surface').hidden).toBe(true);
    expect(section('Water').hidden).toBe(false);

    selectTool('object');
    expect(section('Brush').hidden).toBe(true);
    expect(section('Object').hidden).toBe(false);

    selectTool('spawn');
    expect(section('Object').hidden).toBe(true);
    expect(section('Spawn').hidden).toBe(false);

    selectTool('marker');
    expect(section('Spawn').hidden).toBe(true);
    expect(section('Marker').hidden).toBe(false);

    selectTool('delete');
    expect(section('Brush').hidden).toBe(false);
    expect(visibleFieldLabels('Brush')).toEqual(['radius']);
    expect(section('Marker').hidden).toBe(true);
    expect(section('Delete').hidden).toBe(false);
  });

  it('hides the marker yaw control for kinds that never write one', () => {
    const { ui, state, selectTool } = setup();
    selectTool('marker');

    // A garage bay is a parked pose, so its facing is authored.
    expect(state.markerKind).toBe('garageBay');
    expect(visibleFieldLabels('Marker')).toEqual(['kind', 'label', 'radius', 'yaw']);

    state.markerKind = 'checkpoint';
    ui.syncMarker();
    expect(visibleFieldLabels('Marker')).toEqual(['kind', 'label', 'radius']);
  });

  it('hides brush controls that the selected brush does not consume', () => {
    const { selectTool } = setup();

    expect(visibleFieldLabels('Brush')).toEqual(['radius', 'strength', 'hardness']);

    selectTool('smooth');
    expect(visibleFieldLabels('Brush')).toEqual(['radius', 'hardness']);

    selectTool('flatten');
    expect(visibleFieldLabels('Brush')).toEqual(['radius', 'hardness']);

    selectTool('paint');
    expect(visibleFieldLabels('Brush')).toEqual(['radius']);

    selectTool('water');
    expect(visibleFieldLabels('Brush')).toEqual(['radius']);
  });

  it('offers exact ground-relative and absolute object placement', () => {
    const { state, selectTool } = setup();
    selectTool('object');
    const object = section('Object');
    const placement = [...object.querySelectorAll<HTMLSelectElement>('select')]
      .find((candidate) => [...candidate.options].some((option) => option.value === 'absolute'))!;
    const input = object.querySelector<HTMLInputElement>('input[type="number"]')!;
    const inputRow = input.closest<HTMLElement>('.ed-field')!;

    expect(state.objectPlacementMode).toBe('ground');
    expect(inputRow.style.display).toBe('none');

    placement.value = 'offset';
    placement.dispatchEvent(new Event('change'));
    expect(inputRow.querySelector('.ed-label')?.textContent).toBe('offset above ground');
    input.value = '2.375';
    input.dispatchEvent(new Event('input'));
    expect(state.objectYOffset).toBe(2.375);

    placement.value = 'absolute';
    placement.dispatchEvent(new Event('change'));
    expect(inputRow.querySelector('.ed-label')?.textContent).toBe('base world Y');
    input.value = '-4.125';
    input.dispatchEvent(new Event('input'));
    expect(state.objectWorldY).toBe(-4.125);

    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(state.objectWorldY).toBe(-4.125);
    input.dispatchEvent(new Event('blur'));
    expect(input.value).toBe('-4.125');
  });
});
