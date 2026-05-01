// Text-chat HUD: a fading log of recent messages in the top-left, plus
// an input field at the bottom that opens on T (or the on-screen
// "chat" button on mobile). Submit on Enter, cancel on Escape.
//
// All DOM is created here so the host page only needs to call init().

const STYLE = `
#chat-log {
  position: fixed;
  top: 40px; left: 8px;
  z-index: 5;
  pointer-events: none;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.5;
  max-width: min(540px, 80vw);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
#chat-log .line {
  background: rgba(0, 0, 0, 0.55);
  border-radius: 3px;
  padding: 3px 8px;
  color: #eee;
  transition: opacity 0.6s ease-out;
  word-wrap: break-word;
  overflow-wrap: anywhere;
}
#chat-log .line.fade { opacity: 0; }
#chat-log .name { color: #ffb27a; margin-right: 6px; }
#chat-log .name.me { color: #7adfff; }
#chat-log .system .name { color: #999; font-style: italic; }

#chat-input-wrap {
  position: fixed;
  left: 8px; right: 8px;
  bottom: 28px;
  z-index: 6;
  display: none;
  justify-content: center;
}
#chat-input-wrap.open { display: flex; }
#chat-input {
  width: min(560px, 92vw);
  background: rgba(0, 0, 0, 0.78);
  color: #eee;
  border: 1px solid #d9531e;
  border-radius: 4px;
  padding: 8px 12px;
  font-family: ui-monospace, monospace;
  font-size: 14px;
  outline: none;
}
`;

const MAX_VISIBLE = 6;
const HOLD_MS = 6000;
const FADE_MS = 600;
const MAX_LEN = 200;

interface LogEntry {
  el: HTMLElement;
  expiresAt: number;
}

export interface ChatUI {
  /** Append a remote (or echoed-back) chat line to the log. */
  push(fromName: string, text: string, isMe: boolean): void;
  /** Show a system message (greys out the name slot). */
  pushSystem(text: string): void;
  /** Open the input. Has the side-effect of focusing it, which on mobile
   *  triggers the soft keyboard. */
  open(): void;
  /** True while the input is open - main loop uses this to suppress
   *  game keys. */
  isOpen(): boolean;
}

interface Hooks {
  /** Called with the typed text on submit. Empty/whitespace strings are
   *  filtered before this fires. */
  onSubmit(text: string): void;
}

export function initChat(hooks: Hooks): ChatUI {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const log = document.createElement('div');
  log.id = 'chat-log';
  document.body.appendChild(log);

  const inputWrap = document.createElement('div');
  inputWrap.id = 'chat-input-wrap';
  const input = document.createElement('input');
  input.id = 'chat-input';
  input.type = 'text';
  input.maxLength = MAX_LEN;
  input.autocomplete = 'off';
  input.spellcheck = false;
  inputWrap.appendChild(input);
  document.body.appendChild(inputWrap);

  const entries: LogEntry[] = [];

  const tick = (): void => {
    const now = performance.now();
    while (entries.length > 0 && entries[0]!.expiresAt + FADE_MS < now) {
      const e = entries.shift()!;
      e.el.remove();
    }
    for (const e of entries) {
      if (now > e.expiresAt) e.el.classList.add('fade');
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const append = (line: HTMLElement): void => {
    log.appendChild(line);
    entries.push({ el: line, expiresAt: performance.now() + HOLD_MS });
    while (entries.length > MAX_VISIBLE) {
      const dropped = entries.shift()!;
      dropped.el.remove();
    }
  };

  const pushLine = (fromName: string, text: string, opts: { isMe?: boolean; system?: boolean }): void => {
    const line = document.createElement('div');
    line.className = 'line' + (opts.system ? ' system' : '');
    const nameEl = document.createElement('span');
    nameEl.className = 'name' + (opts.isMe ? ' me' : '');
    nameEl.textContent = fromName + ':';
    const textEl = document.createElement('span');
    textEl.textContent = text;
    line.appendChild(nameEl);
    line.appendChild(textEl);
    append(line);
  };

  let open = false;

  const close = (): void => {
    open = false;
    inputWrap.classList.remove('open');
    input.value = '';
    input.blur();
  };

  const submit = (): void => {
    const text = input.value.trim().slice(0, MAX_LEN);
    if (text) hooks.onSubmit(text);
    close();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
    e.stopPropagation();
  });

  return {
    push(fromName, text, isMe) {
      pushLine(fromName, text, { isMe });
    },
    pushSystem(text) {
      pushLine('system', text, { system: true });
    },
    open() {
      open = true;
      inputWrap.classList.add('open');
      // Mobile: focusing the input opens the soft keyboard.
      setTimeout(() => input.focus(), 0);
    },
    isOpen() {
      return open;
    },
  };
}
