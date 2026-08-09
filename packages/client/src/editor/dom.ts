// The panel's DOM vocabulary. Built imperatively, like the rest of the
// client's UI (joinScreen, chat, debugPanel) — there is no framework here
// and adding one for one panel would be the largest dependency in the app.
//
// Split out of ui.ts when the object palette grew past a flat list. The
// controls now return handles rather than nothing, because a value can
// arrive from somewhere other than the control: the object yaw is written
// by the mouse wheel and the bracket keys as well as its slider, and
// picking a new kind rewrites the size, height and length sliders along
// with their bounds. Fire-and-forget helpers cannot express that.

export function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

export function section(parent: HTMLElement, title: string): HTMLElement {
  const s = el('div', 'ed-section');
  const h = el('h2', 'ed-title');
  h.textContent = title;
  s.appendChild(h);
  parent.appendChild(s);
  return s;
}

export function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

export interface SliderHandle {
  /** Write the value without firing the change callback — this is a sync
   *  from the model, not an edit, and re-entering the callback would fight
   *  whatever is doing the syncing. */
  set(v: number): void;
  /** Re-label and re-bound in place. Used when the object kind changes and
   *  "size" stops meaning "radius" and starts meaning "half-width". */
  retarget(opts: { label?: string; min?: number; max?: number; step?: number }): void;
  setVisible(v: boolean): void;
}

export interface NumberHandle {
  set(v: number): void;
  setLabel(label: string): void;
  setVisible(v: boolean): void;
}

/** Exact decimal entry for values where slider quantisation is harmful.
 *  Empty/non-finite edits never reach state and blur restores the last
 *  accepted value. */
export function numberField(
  parent: HTMLElement,
  label: string,
  value: number,
  onInput: (v: number) => void,
): NumberHandle {
  const row = el('label', 'ed-field');
  const name = el('span', 'ed-label');
  const input = document.createElement('input');
  let accepted = value;
  name.textContent = label;
  input.type = 'number';
  input.step = 'any';
  input.value = String(value);
  input.addEventListener('input', () => {
    const next = input.valueAsNumber;
    if (!Number.isFinite(next)) return;
    accepted = next;
    onInput(next);
  });
  input.addEventListener('blur', () => {
    if (!Number.isFinite(input.valueAsNumber)) input.value = String(accepted);
  });
  row.append(name, input);
  parent.appendChild(row);
  return {
    set(v) { accepted = v; input.value = String(v); },
    setLabel(next) { name.textContent = next; },
    setVisible(v) { row.style.display = v ? '' : 'none'; },
  };
}

export function slider(
  parent: HTMLElement,
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onInput: (v: number) => void,
): SliderHandle {
  const row = el('label', 'ed-field');
  const name = el('span', 'ed-label');
  const readout = el('span', 'ed-value');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const show = (): void => { readout.textContent = Number(input.value).toFixed(2); };
  name.textContent = label;
  show();
  input.addEventListener('input', () => {
    onInput(Number(input.value));
    show();
  });
  row.append(name, input, readout);
  parent.appendChild(row);
  return {
    set(v) { input.value = String(v); show(); },
    retarget(o) {
      if (o.label !== undefined) name.textContent = o.label;
      if (o.min !== undefined) input.min = String(o.min);
      if (o.max !== undefined) input.max = String(o.max);
      if (o.step !== undefined) input.step = String(o.step);
      show();
    },
    setVisible(v) { row.style.display = v ? '' : 'none'; },
  };
}

export interface SelectOption { value: string; label: string }
export interface SelectGroup { label: string; options: SelectOption[] }
export interface SelectHandle { set(v: string): void }

/** A `<select>`, optionally split into `<optgroup>`s.
 *
 *  Grouping stopped being cosmetic at 35 object kinds: a flat list that
 *  long is a scroll-and-hunt, and the groups are the only thing that makes
 *  "where's the barrel" answerable without reading every entry. */
export function select(
  parent: HTMLElement,
  label: string,
  groups: SelectGroup[] | SelectOption[],
  value: string,
  onChange: (v: string) => void,
): SelectHandle {
  const row = el('label', 'ed-field');
  const name = el('span', 'ed-label');
  name.textContent = label;
  const sel = document.createElement('select');

  const addOption = (into: HTMLElement, o: SelectOption): void => {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    into.appendChild(opt);
  };

  const grouped = groups.length > 0 && 'options' in groups[0]!;
  if (grouped) {
    for (const g of groups as SelectGroup[]) {
      const og = document.createElement('optgroup');
      og.label = g.label;
      for (const o of g.options) addOption(og, o);
      sel.appendChild(og);
    }
  } else {
    for (const o of groups as SelectOption[]) addOption(sel, o);
  }

  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  row.append(name, sel);
  parent.appendChild(row);
  return { set(v) { sel.value = v; } };
}

export function textField(
  parent: HTMLElement,
  label: string,
  value: string,
  onChange: (v: string) => void,
): HTMLInputElement {
  const row = el('label', 'ed-field');
  const name = el('span', 'ed-label');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.addEventListener('change', () => onChange(input.value));
  row.append(name, input);
  parent.appendChild(row);
  return input;
}

export function checkbox(
  parent: HTMLElement,
  label: string,
  value: boolean,
  onChange: (v: boolean) => void,
): void {
  const row = el('label', 'ed-field');
  const name = el('span', 'ed-label');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  row.append(name, input);
  parent.appendChild(row);
}

/** A read-only line of text in a section. Used for the per-kind caption
 *  explaining what size/height/length mean for the selected object. */
export function caption(parent: HTMLElement): { set(text: string): void } {
  const c = el('div', 'ed-caption');
  parent.appendChild(c);
  return { set(text) { c.textContent = text; } };
}
