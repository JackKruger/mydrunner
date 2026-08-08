import { beforeEach, describe, expect, it } from 'vitest';
import { showJoinScreen } from '../joinScreen.js';
import { createStockBuild } from '@mydrunner/shared';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('join briefing', () => {
  it('exposes the rig choice as an accessible keyboard radio group', async () => {
    const result = showJoinScreen({ name: 'Ada', build: createStockBuild('ridgeback'), carKind: 'ridgeback' });
    const overlay = document.querySelector('#join-overlay')!;
    const patrol = document.querySelector('[data-car-kind="ridgeback"]') as HTMLButtonElement;
    const hilux = document.querySelector('[data-car-kind="overlander"]') as HTMLButtonElement;

    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(document.querySelector('#join-cars')?.getAttribute('role')).toBe('radiogroup');
    expect(patrol.getAttribute('aria-checked')).toBe('true');
    expect(hilux.getAttribute('aria-checked')).toBe('false');

    patrol.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(patrol.getAttribute('aria-checked')).toBe('false');
    expect(hilux.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(hilux);

    (document.querySelector('#join-go') as HTMLButtonElement).click();
    await expect(result).resolves.toEqual({ name: 'Ada', build: createStockBuild('overlander'), carKind: 'overlander' });
    expect(document.querySelector('#join-overlay')).toBeNull();
  });

  it('offers exactly the five fictional 4x4 bases', () => {
    void showJoinScreen({ name: 'Ada', build: createStockBuild('ridgeback') });
    const ids = [...document.querySelectorAll<HTMLElement>('[data-car-kind]')].map((element) => element.dataset.carKind);
    expect(ids).toEqual(['ridgeback', 'overlander', 'stockman-single', 'stockman-dual', 'longreach']);
    expect(document.body.textContent).not.toMatch(/Falcon|motorbike/i);
  });

  it('trims the call sign and supports native form submission', async () => {
    const result = showJoinScreen({ build: createStockBuild('stockman-single'), carKind: 'stockman-single' });
    const input = document.querySelector('#join-name') as HTMLInputElement;
    input.value = '  Trail Boss  ';
    (document.querySelector('#join-card') as HTMLFormElement).requestSubmit();

    await expect(result).resolves.toEqual({ name: 'Trail Boss', build: createStockBuild('stockman-single'), carKind: 'stockman-single' });
  });
});
