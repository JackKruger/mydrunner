// Text-chat HUD: a fading log of recent messages in the top-left, plus
// an input field at the bottom that opens on T (or the on-screen
// "chat" button on mobile). Submit on Enter, cancel on Escape.
//
// All DOM is created here so the host page only needs to call init(). The
// visual rules live in the shared player stylesheet.

const MAX_VISIBLE = 5;
const MAX_LEN = 200;
const SYSTEM_MESSAGE_LIFETIME_MS = 5000;
const MESSAGE_FADE_MS = 300;

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
  const log = document.createElement('div');
  log.id = 'chat-log';
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', 'Team radio messages');
  log.setAttribute('aria-live', 'polite');
  log.setAttribute('aria-relevant', 'additions');
  document.body.appendChild(log);

  const inputWrap = document.createElement('div');
  inputWrap.id = 'chat-input-wrap';
  inputWrap.className = 'instrument-panel';
  inputWrap.setAttribute('role', 'group');
  inputWrap.setAttribute('aria-label', 'Team radio');
  const label = document.createElement('label');
  label.className = 'chat-label';
  label.htmlFor = 'chat-input';
  label.textContent = 'Team radio // transmit';
  const input = document.createElement('input');
  input.id = 'chat-input';
  input.type = 'text';
  input.maxLength = MAX_LEN;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Message the convoy…';
  const hint = document.createElement('div');
  hint.className = 'chat-hint';
  hint.textContent = 'Enter sends · Esc cancels';
  inputWrap.appendChild(label);
  inputWrap.appendChild(input);
  inputWrap.appendChild(hint);
  document.body.appendChild(inputWrap);

  const updateKeyboardOffset = (): void => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const obscured = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    document.documentElement.style.setProperty('--chat-keyboard-offset', `${obscured}px`);
  };
  window.visualViewport?.addEventListener('resize', updateKeyboardOffset);
  window.visualViewport?.addEventListener('scroll', updateKeyboardOffset);

  const entries: HTMLElement[] = [];

  const remove = (line: HTMLElement): void => {
    const index = entries.indexOf(line);
    if (index !== -1) entries.splice(index, 1);
    line.remove();
  };

  const append = (line: HTMLElement): void => {
    log.appendChild(line);
    entries.push(line);
    while (entries.length > MAX_VISIBLE) {
      const dropped = entries.shift()!;
      dropped.remove();
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
    if (opts.system) {
      setTimeout(() => {
        if (!line.isConnected) return;
        line.classList.add('leaving');
        setTimeout(() => remove(line), MESSAGE_FADE_MS);
      }, SYSTEM_MESSAGE_LIFETIME_MS);
    }
  };

  let open = false;

  const close = (): void => {
    open = false;
    inputWrap.classList.remove('open');
    input.value = '';
    input.blur();
    document.documentElement.style.setProperty('--chat-keyboard-offset', '0px');
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
      setTimeout(() => {
        input.focus();
        updateKeyboardOffset();
      }, 0);
    },
    isOpen() {
      return open;
    },
  };
}
