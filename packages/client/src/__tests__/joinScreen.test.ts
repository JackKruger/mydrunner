import { beforeEach, describe, expect, it } from 'vitest';
import { showJoinScreen } from '../joinScreen.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('join briefing', () => {
  it('exposes the rig choice as an accessible keyboard radio group', async () => {
    const result = showJoinScreen({ name: 'Ada', carKind: 'patrol' });
    const overlay = document.querySelector('#join-overlay')!;
    const patrol = document.querySelector('[data-car-kind="patrol"]') as HTMLButtonElement;
    const hilux = document.querySelector('[data-car-kind="hilux"]') as HTMLButtonElement;

    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(document.querySelector('#join-cars')?.getAttribute('role')).toBe('radiogroup');
    expect(patrol.getAttribute('aria-checked')).toBe('true');
    expect(hilux.getAttribute('aria-checked')).toBe('false');

    patrol.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(patrol.getAttribute('aria-checked')).toBe('false');
    expect(hilux.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(hilux);

    (document.querySelector('#join-go') as HTMLButtonElement).click();
    await expect(result).resolves.toEqual({ name: 'Ada', carKind: 'hilux' });
    expect(document.querySelector('#join-overlay')).toBeNull();
  });

  it('trims the call sign and supports native form submission', async () => {
    const result = showJoinScreen({ carKind: 'ute' });
    const input = document.querySelector('#join-name') as HTMLInputElement;
    input.value = '  Trail Boss  ';
    (document.querySelector('#join-card') as HTMLFormElement).requestSubmit();

    await expect(result).resolves.toEqual({ name: 'Trail Boss', carKind: 'ute' });
  });
});
