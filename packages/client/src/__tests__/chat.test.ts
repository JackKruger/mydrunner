import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initChat } from '../chat.js';

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('chat system messages', () => {
  it('fades and removes the connection hint after a short delay', () => {
    const chat = initChat({ onSubmit: () => {} });
    chat.pushSystem('connected — press T to chat');

    const line = document.querySelector('#chat-log .system') as HTMLElement;
    expect(line.textContent).toContain('connected — press T to chat');

    vi.advanceTimersByTime(4999);
    expect(line.classList.contains('leaving')).toBe(false);

    vi.advanceTimersByTime(1);
    expect(line.classList.contains('leaving')).toBe(true);

    vi.advanceTimersByTime(300);
    expect(document.querySelector('#chat-log .system')).toBeNull();
  });
});
