import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStockBuild } from '@mydrunner/shared';
import {
  createGameSave,
  deleteGameSave,
  loadGameSaves,
  loadStartOptions,
  saveStartOptions,
  showStartScreen,
  updateGameSave,
} from '../startScreen.js';

const storageData = new Map<string, string>();
const storage: Storage = {
  get length() { return storageData.size; },
  clear() { storageData.clear(); },
  getItem(key) { return storageData.get(key) ?? null; },
  key(index) { return [...storageData.keys()][index] ?? null; },
  removeItem(key) { storageData.delete(key); },
  setItem(key, value) { storageData.set(key, String(value)); },
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('local game saves', () => {
  it('promotes the old single-player choice to a Continue slot', () => {
    const saves = loadGameSaves({
      name: 'Ada',
      build: createStockBuild('ridgeback'),
      carKind: 'ridgeback',
    });

    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ id: 'legacy', name: 'Ada' });
    expect(loadGameSaves()[0]?.build.baseId).toBe('ridgeback');
  });

  it('creates, updates, and deletes independent slots', () => {
    const first = createGameSave({ name: 'Ada', build: createStockBuild('ridgeback'), carKind: 'ridgeback' });
    const second = createGameSave({ name: 'Bea', build: createStockBuild('longreach'), carKind: 'longreach' });

    expect(loadGameSaves()).toHaveLength(2);
    updateGameSave(first.id, { name: 'Ada Mk II', build: createStockBuild('overlander'), carKind: 'overlander' });
    expect(loadGameSaves().find((save) => save.id === first.id)).toMatchObject({ name: 'Ada Mk II' });
    expect(loadGameSaves().find((save) => save.id === first.id)?.build.baseId).toBe('overlander');

    deleteGameSave(second.id);
    expect(loadGameSaves().map((save) => save.id)).toEqual([first.id]);
  });

  it('uses safe defaults when stored options are missing or malformed', () => {
    expect(loadStartOptions()).toEqual({ engineAudio: false, showControlGuide: true });
    localStorage.setItem('mydrunner.options.v1', '{broken');
    expect(loadStartOptions()).toEqual({ engineAudio: false, showControlGuide: true });
    saveStartOptions({ engineAudio: true, showControlGuide: false });
    expect(loadStartOptions()).toEqual({ engineAudio: true, showControlGuide: false });
  });
});

describe('start screen', () => {
  it('disables Continue without a save and starts the new-game flow', async () => {
    const result = showStartScreen({
      saves: [],
      development: false,
      options: loadStartOptions(),
    });

    expect(document.querySelector<HTMLButtonElement>('#start-continue')?.disabled).toBe(true);
    expect(document.querySelector('#start-dev')).toBeNull();
    expect(document.body.classList.contains('start-screen-open')).toBe(true);
    document.querySelector<HTMLButtonElement>('#start-new')!.click();
    await expect(result).resolves.toEqual({ type: 'new' });
    expect(document.querySelector('#start-overlay')).toBeNull();
    expect(document.body.classList.contains('start-screen-open')).toBe(false);
  });

  it('continues the newest save and exposes dev tool links in development', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200);
    const older = createGameSave({ name: 'Older', build: createStockBuild('ridgeback'), carKind: 'ridgeback' });
    const newer = createGameSave({ name: 'Newest', build: createStockBuild('longreach'), carKind: 'longreach' });
    const result = showStartScreen({
      saves: [older, newer],
      development: true,
      options: loadStartOptions(),
    });

    expect(document.querySelector('#start-continue')?.textContent).toContain('Newest');
    document.querySelector<HTMLButtonElement>('#start-dev')!.click();
    expect(document.querySelector<HTMLAnchorElement>('a[href="asset-editor.html"]')).not.toBeNull();
    expect(document.querySelector<HTMLAnchorElement>('a[href="editor.html"]')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('[data-start-back]')!.click();
    document.querySelector<HTMLButtonElement>('#start-continue')!.click();

    await expect(result).resolves.toMatchObject({ type: 'play', save: { id: newer.id, name: 'Newest' } });
  });

  it('persists options immediately', () => {
    const changed = vi.fn();
    void showStartScreen({
      saves: [],
      development: false,
      options: loadStartOptions(),
      onOptionsChanged: changed,
    });
    document.querySelector<HTMLButtonElement>('#start-options')!.click();
    const audio = document.querySelector<HTMLInputElement>('#option-audio')!;
    audio.checked = true;
    audio.dispatchEvent(new Event('change', { bubbles: true }));

    expect(loadStartOptions().engineAudio).toBe(true);
    expect(changed).toHaveBeenLastCalledWith({ engineAudio: true, showControlGuide: true });
  });
});
