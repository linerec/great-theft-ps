// SPDX-License-Identifier: AGPL-3.0-only
//
// The key layout editor: which key presses which button of the pad, and how.
//
// It shows the profile from the pad's side (one row per button, the keys bound to it next to it), because that is the
// question a person has: "what do I press for Square?". A key is added by pressing it. Each binding has two choices:
//   how the button is pressed   as long as the key / a tap / held at least a while / on and off / over and over
//   on which kind of key press  the plain press / a long press / a double press / the moment it goes down / on release
// Anything the editor cannot show in that form (several actions on one key, layer switches, half-pressed triggers) is
// listed as it is written and left alone; the profile text below the editor remains the full truth.

import { bindingKey, parseActions, splitBindingKey, validateProfile, type Activator, type Profile } from '../src/engine/profile.ts';
import { N_, onLang, t } from '../src/i18n/index.ts';

type Style = 'plain' | 'tap' | 'hold' | 'latch' | 'turbo';

interface Control {
  id: string;
  /** What is printed on the pad (✕, R2, OPTIONS): the same in every language. */
  mark?: string;
  /** Else, a sentence for t(). A control that has both (L3) is called by its sentence on the pad and by its mark in the summary. */
  name?: string;
  /** A shorter name for the summary beside the picture, when `name` is long. */
  short?: string;
  /** A sentence for t(). */
  group: string;
  /** Sticks can only be pushed plainly. */
  plainOnly?: boolean;
}

const GROUP_MOVE = N_('Move');
const GROUP_LOOK = N_('Look with keys (the mouse usually does this)');

const CONTROLS: Control[] = [
  { id: 'left:up', name: N_('Left stick ↑'), group: GROUP_MOVE, plainOnly: true },
  { id: 'left:down', name: N_('Left stick ↓'), group: GROUP_MOVE, plainOnly: true },
  { id: 'left:left', name: N_('Left stick ←'), group: GROUP_MOVE, plainOnly: true },
  { id: 'left:right', name: N_('Left stick →'), group: GROUP_MOVE, plainOnly: true },
  { id: 'cross', mark: '✕', group: N_('Buttons') },
  { id: 'moon', mark: '○', group: N_('Buttons') },
  { id: 'box', mark: '□', group: N_('Buttons') },
  { id: 'pyramid', mark: '△', group: N_('Buttons') },
  { id: 'r2', mark: 'R2', group: N_('Shoulders · triggers') },
  { id: 'l2', mark: 'L2', group: N_('Shoulders · triggers') },
  { id: 'r1', mark: 'R1', group: N_('Shoulders · triggers') },
  { id: 'l1', mark: 'L1', group: N_('Shoulders · triggers') },
  { id: 'l3', mark: 'L3', name: N_('L3 (press the left stick)'), group: N_('Stick presses') },
  { id: 'r3', mark: 'R3', name: N_('R3 (press the right stick)'), group: N_('Stick presses') },
  { id: 'dpad_up', name: N_('D-pad ↑'), group: N_('D-pad') },
  { id: 'dpad_right', name: N_('D-pad →'), group: N_('D-pad') },
  { id: 'dpad_down', name: N_('D-pad ↓'), group: N_('D-pad') },
  { id: 'dpad_left', name: N_('D-pad ←'), group: N_('D-pad') },
  { id: 'touchpad', name: N_('Touchpad button'), short: N_('Touchpad'), group: N_('System') },
  { id: 'options', mark: 'OPTIONS', group: N_('System') },
  { id: 'share', mark: 'CREATE', group: N_('System') },
  { id: 'ps', mark: 'PS', group: N_('System') },
  { id: 'right:up', name: N_('Right stick ↑'), group: GROUP_LOOK, plainOnly: true },
  { id: 'right:down', name: N_('Right stick ↓'), group: GROUP_LOOK, plainOnly: true },
  { id: 'right:left', name: N_('Right stick ←'), group: GROUP_LOOK, plainOnly: true },
  { id: 'right:right', name: N_('Right stick →'), group: GROUP_LOOK, plainOnly: true },
];

/** What a control is called on the pad's side of a row. */
const padName = (c: Control): string => (c.name ? t(c.name) : c.mark!);
/** The shorter name for the layout summary. */
const shortName = (c: Control): string => c.mark ?? t(c.short ?? c.name!);

// Sentences for t(): the tables hold them, the editor shows them in the language of the page each time it draws.
const STYLE_TEXT: Record<Style, string> = {
  plain: N_('While pressed'),
  tap: N_('Short tap'),
  hold: N_('Long hold'),
  latch: N_('Toggle on and off with each press'),
  turbo: N_('Rapid presses while held'),
};
const STYLE_HELP: Record<Style, string> = {
  plain: N_('The button stays pressed as long as you hold the key. Same as the pad, with no delay. The game tells a short press from a long one by itself.'),
  tap: N_('However long you hold the key, the button is pressed once, briefly. Use it to give the "short press" of the same button its own key.'),
  hold: N_('Even a quick tap on the key keeps the button pressed for a set time. Use it to give the "long press" of the same button its own key.'),
  latch: N_('One press keeps the button down, the next one lets it go. (For example, to turn an aim you have to hold into a toggle.)'),
  turbo: N_('The button is pressed over and over, fast, while you hold the key. (For example, sprinting that needs button mashing.)'),
};
/** A short word after the key in the layout summary, for the styles that are not a plain press. */
const STYLE_MARK: Partial<Record<Style, string>> = {
  tap: N_('tap'),
  hold: N_('hold'),
  latch: N_('toggle'),
  turbo: N_('rapid'),
};
const ACTIVATOR_TEXT: Record<Activator, string> = {
  regular: N_('on a plain press'),
  long: N_('on a long press'),
  double: N_('on a double press'),
  start: N_('on key down'),
  release: N_('on release'),
};

/** Names of keys that are words, for t(). */
const KEY_WORDS: Record<string, string> = {
  Mouse0: N_('Left click'), Mouse1: N_('Wheel click'), Mouse2: N_('Right click'), Mouse3: N_('Mouse back'), Mouse4: N_('Mouse forward'),
  WheelUp: N_('Wheel up'), WheelDown: N_('Wheel down'),
  ShiftLeft: N_('Left Shift'), ShiftRight: N_('Right Shift'), AltLeft: N_('Left Alt'), AltRight: N_('Right Alt'), ControlLeft: N_('Left Ctrl'), ControlRight: N_('Right Ctrl'),
};
/** Names of keys as they are printed on the keyboard: the same in every language. */
const KEY_PRINTED: Record<string, string> = {
  Space: 'Space', Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', CapsLock: 'Caps Lock', Backquote: '`', Minus: '-', Equal: '=',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down', Insert: 'Insert', Delete: 'Delete',
};

/** A name a person would use for an input code. */
export function keyName(code: string): string {
  if (KEY_WORDS[code]) return t(KEY_WORDS[code]!);
  if (KEY_PRINTED[code]) return KEY_PRINTED[code]!;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return t('Numpad {key}', { key: code.slice(6) });
  return code;
}

/** Keys a browser acts on by itself: binding them would work badly or dangerously. */
function reserved(code: string): string | null {
  if (code === 'Escape') return t('The browser uses Esc to release the mouse lock.');
  if (/^Control(Left|Right)$/.test(code)) return t('Ctrl is not recommended: pressing W while holding it makes the browser close the tab (Ctrl+W).');
  if (/^Meta(Left|Right)$/.test(code)) return t('The operating system takes the Windows/Command key.');
  if (code === 'F5' || code === 'F11' || code === 'F12') return t('{key} is used by the browser (refresh, full screen, developer tools).', { key: code });
  return null;
}

interface Row {
  layer: string;
  key: string;
  code: string;
  activator: Activator;
  control: string;
  style: Style;
  /** The length in ms (tap, hold) or presses per second (turbo) written in the binding, if any. */
  param: number | null;
}

function readBinding(text: string): { control: string; style: Style; param: number | null } | null {
  const actions = parseActions(text);
  if (!actions || actions.length !== 1) return null;
  const a = actions[0]!;
  const out = (o: { button: string } | { trigger: string }): string => ('button' in o ? o.button : o.trigger);
  if (a.kind === 'button') return { control: a.button, style: 'plain', param: null };
  if (a.kind === 'trigger' && a.amount === 1) return { control: a.trigger, style: 'plain', param: null };
  if (a.kind === 'stick' && a.amount === 1) return { control: `${a.stick}:${a.dir}`, style: 'plain', param: null };
  if (a.kind === 'tap') return { control: out(a.out), style: 'tap', param: a.ms };
  if (a.kind === 'hold') return { control: out(a.out), style: 'hold', param: a.ms };
  if (a.kind === 'latch') return { control: out(a.out), style: 'latch', param: null };
  if (a.kind === 'turbo') return { control: a.button, style: 'turbo', param: a.hz };
  return null;
}

function writeBinding(control: string, style: Style, param: number | null): string {
  if (control.includes(':')) return `stick:${control}`;
  const trigger = control === 'l2' || control === 'r2';
  if (style === 'plain') return trigger ? `trigger:${control}` : `btn:${control}`;
  if (style === 'turbo') return trigger ? `trigger:${control}` : `turbo:${control}${param ? `:${param}` : ''}`;
  if (style === 'latch') return `latch:${control}`;
  return `${style}:${control}${param ? `:${param}` : ''}`;
}

/** The layout in a few lines, for showing next to the picture: "Move W A S D · ✕ Space, Enter · ...". In the language in use now: the caller draws it again when that changes. */
export function describeLayout(profile: Profile): Array<{ label: string; keys: string }> {
  const by = new Map<string, string[]>();
  for (const layer of profile.layers) {
    for (const [key, text] of Object.entries(layer.bindings)) {
      const k = splitBindingKey(key);
      const b = readBinding(text);
      if (!k || !b) continue;
      const markWord = STYLE_MARK[b.style];
      const mark = markWord ? ` (${t(markWord)})` : '';
      const when = k.activator === 'regular' ? '' : ` ${t(ACTIVATOR_TEXT[k.activator])}`;
      by.set(b.control, [...(by.get(b.control) ?? []), `${keyName(k.code)}${when}${mark}`]);
    }
  }
  const out: Array<{ label: string; keys: string }> = [];
  const stick = ['left:up', 'left:left', 'left:down', 'left:right'].map((c) => by.get(c)?.[0] ?? '?');
  out.push({ label: t('Move'), keys: stick.join(' ') });
  out.push({ label: t('Look'), keys: profile.mouse.target === 'off' ? t('(mouse off)') : profile.mouse.target === 'gyro' ? t('Mouse (gyro)') : t('Mouse') });
  for (const c of CONTROLS) {
    if (c.id.includes(':')) continue;
    const keys = by.get(c.id);
    if (keys?.length) out.push({ label: shortName(c), keys: keys.join(', ') });
  }
  for (const layer of profile.layers) {
    if (layer.holdKey && layer.leftStickScale < 1) out.push({ label: t('Walk'), keys: t('Hold {key} and move', { key: keyName(layer.holdKey) }) });
  }
  return out;
}

export interface KeymapHost {
  getProfile(): Profile;
  /** Use this profile from now on. */
  setProfile(next: Profile): void;
  say(text: string, kind: 'ok' | 'error'): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function mountKeymap(root: HTMLElement, host: KeymapHost): { refresh(): void } {
  /** Change the profile through a copy, and only if the result is still a valid profile. */
  const change = (edit: (p: Profile) => void, done = ''): void => {
    const next = JSON.parse(JSON.stringify(host.getProfile())) as Profile;
    edit(next);
    const checked = validateProfile(next);
    if (!checked.ok) return host.say(checked.errors.slice(0, 2).join(' / '), 'error');
    host.setProfile(checked.profile);
    if (done) host.say(done, 'ok');
    refresh();
  };

  /** Wait for the next key, mouse button or wheel notch. Esc cancels. */
  const capture = (button: HTMLButtonElement, then: (code: string) => void): void => {
    const before = button.textContent;
    button.textContent = t('Press a key or mouse button (Esc: cancel)');
    button.classList.add('listening');
    const shield = el('div', 'keymap-shield');
    document.body.append(shield);
    const stop = (): void => {
      window.removeEventListener('keydown', onKey, true);
      shield.remove();
      button.textContent = before;
      button.classList.remove('listening');
    };
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      stop();
      if (e.code !== 'Escape') then(e.code);
    };
    window.addEventListener('keydown', onKey, true);
    shield.addEventListener('mousedown', (e) => {
      e.preventDefault();
      stop();
      then(`Mouse${e.button}`);
    });
    shield.addEventListener('contextmenu', (e) => e.preventDefault());
    shield.addEventListener('wheel', (e) => {
      e.preventDefault();
      stop();
      then(e.deltaY < 0 ? 'WheelUp' : 'WheelDown');
    }, { passive: false });
  };

  const rows = (p: Profile): { rows: Row[]; other: Array<{ layer: string; key: string; text: string }> } => {
    const list: Row[] = [];
    const other: Array<{ layer: string; key: string; text: string }> = [];
    for (const layer of p.layers) {
      for (const [key, text] of Object.entries(layer.bindings)) {
        const k = splitBindingKey(key);
        const b = readBinding(text);
        if (k && b) list.push({ layer: layer.name, key, code: k.code, activator: k.activator, ...b });
        else other.push({ layer: layer.name, key, text });
      }
    }
    return { rows: list, other };
  };

  const bindingLine = (r: Row, control: Control): HTMLElement => {
    const line = el('div', 'keymap-binding');
    line.append(el('kbd', 'keycap', keyName(r.code)));
    if (r.layer !== 'default') line.append(el('span', 'chip', t('{layer} layer', { layer: r.layer })));

    if (!control.plainOnly) {
      const how = el('select');
      how.setAttribute('aria-label', t('How the button is pressed'));
      for (const s of ['plain', 'tap', 'hold', 'latch', 'turbo'] as Style[]) {
        if (s === 'turbo' && (control.id === 'l2' || control.id === 'r2')) continue;
        const o = el('option', '', t(STYLE_TEXT[s]));
        o.value = s;
        o.title = t(STYLE_HELP[s]);
        how.append(o);
      }
      how.value = r.style;
      how.title = t(STYLE_HELP[r.style]);
      how.addEventListener('change', () =>
        change((p) => {
          p.layers.find((l) => l.name === r.layer)!.bindings[r.key] = writeBinding(r.control, how.value as Style, null);
        }),
      );
      line.append(how);
    }

    // On which kind of key press. Nearly always the plain one, so it stays quiet until it is something else.
    const when = el('select', r.activator === 'regular' ? 'quiet' : '');
    when.setAttribute('aria-label', t('On which kind of key press'));
    when.title = t('Which kind of press of this key counts. If long or double press is used, the "on a plain press" of the same key is sent when the key is released.');
    for (const a of ['regular', 'long', 'double', 'start', 'release'] as Activator[]) {
      if (r.code.startsWith('Wheel') && a !== 'regular') continue;
      const o = el('option', '', t(ACTIVATOR_TEXT[a]));
      o.value = a;
      when.append(o);
    }
    when.value = r.activator;
    when.addEventListener('change', () =>
      change((p) => {
        const layer = p.layers.find((l) => l.name === r.layer)!;
        const text = layer.bindings[r.key]!;
        delete layer.bindings[r.key];
        layer.bindings[bindingKey(r.code, when.value as Activator)] = text;
      }),
    );
    line.append(when);
    const remove = el('button', 'btn ghost small', '×');
    remove.title = t('Remove this key');
    remove.type = 'button';
    remove.setAttribute('aria-label', t('Remove {key}', { key: keyName(r.code) }));
    remove.addEventListener('click', () => change((p) => void delete p.layers.find((l) => l.name === r.layer)!.bindings[r.key]));
    line.append(remove);
    return line;
  };

  const refresh = (): void => {
    const p = host.getProfile();
    const { rows: all, other } = rows(p);
    root.textContent = '';

    let group = '';
    let table: HTMLElement | null = null;
    for (const control of CONTROLS) {
      if (control.group !== group) {
        group = control.group;
        root.append(el('h4', 'keymap-group', t(group)));
        table = el('div', 'keymap-table');
        root.append(table);
      }
      const row = el('div', 'keymap-row');
      row.append(el('div', 'keymap-pad', padName(control)));
      const cell = el('div', 'keymap-keys');
      for (const r of all.filter((x) => x.control === control.id)) cell.append(bindingLine(r, control));
      const add = el('button', 'btn small keymap-add', t('+ Key'));
      add.type = 'button';
      add.setAttribute('aria-label', t('Add a key to {control}', { control: padName(control) }));
      add.addEventListener('click', () =>
        capture(add, (code) => {
          const why = reserved(code);
          if (why) return host.say(why, 'error');
          const taken = all.find((x) => x.layer === 'default' && x.code === code && x.activator === 'regular');
          const takenControl = taken ? CONTROLS.find((c) => c.id === taken.control) : undefined;
          change(
            (next) => {
              next.layers[0]!.bindings[code] = writeBinding(control.id, 'plain', null);
            },
            takenControl && taken!.control !== control.id
              ? t('{key}: moved from {from} to {to}.', { key: keyName(code), from: padName(takenControl), to: padName(control) })
              : `${keyName(code)} → ${padName(control)}`,
          );
        }),
      );
      cell.append(add);
      row.append(cell);
      table!.append(row);
    }

    // Layers with a hold key: shown, with the key changeable; their other properties stay in the profile text.
    const layers = p.layers.filter((l, i) => i > 0);
    if (layers.length) {
      root.append(el('h4', 'keymap-group', t('What changes while a key is held (layers)')));
      const table2 = el('div', 'keymap-table');
      for (const layer of layers) {
        const row = el('div', 'keymap-row');
        const what = layer.leftStickScale < 1
          ? t('{layer}: move at {percent}% (walk)', { layer: layer.name, percent: Math.round(layer.leftStickScale * 100) })
          : layer.lookScale !== 1
            ? t('{layer}: look scale {scale}', { layer: layer.name, scale: layer.lookScale })
            : layer.name === 'aim'
              ? t('{layer}: aim (the look scale can be set separately)', { layer: layer.name })
              : t('{layer}: changes the key layout', { layer: layer.name });
        row.append(el('div', 'keymap-pad', what));
        const cell = el('div', 'keymap-keys');
        const line = el('div', 'keymap-binding');
        line.append(el('kbd', 'keycap', layer.holdKey ? keyName(layer.holdKey) : t('(no key: switched on and off by another key)')));
        const set = el('button', 'btn small', t('Change key'));
        set.type = 'button';
        set.addEventListener('click', () =>
          capture(set, (code) => {
            const why = reserved(code);
            if (why) return host.say(why, 'error');
            change((next) => {
              const l = next.layers.find((x) => x.name === layer.name)!;
              // The layer's own binding for its hold key moves with the key (the aim layer presses L2 with it).
              if (l.holdKey && l.bindings[l.holdKey] !== undefined) {
                l.bindings[code] = l.bindings[l.holdKey]!;
                delete l.bindings[l.holdKey];
              }
              l.holdKey = code;
            }, `${layer.name}: ${keyName(code)}`);
          }),
        );
        line.append(set);
        cell.append(line);
        row.append(cell);
        table2.append(row);
      }
      root.append(table2);
    }

    if (other.length) {
      root.append(el('h4', 'keymap-group', t('Other actions (edit them in the profile text below)')));
      const list = el('ul', 'keymap-other');
      for (const o of other) {
        const k = splitBindingKey(o.key);
        const when = k && k.activator !== 'regular' ? ` ${t(ACTIVATOR_TEXT[k.activator])}` : '';
        const layer = o.layer !== 'default' ? ` (${t('{layer} layer', { layer: o.layer })})` : '';
        list.append(el('li', '', `${k ? keyName(k.code) : o.key}${when}${layer}: ${o.text}`));
      }
      root.append(list);
    }
  };

  refresh();
  // The words are drawn here and kept: draw them again in the new language.
  onLang(() => refresh());
  return { refresh };
}
