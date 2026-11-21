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

type Style = 'plain' | 'tap' | 'hold' | 'latch' | 'turbo';

interface Control {
  id: string;
  label: string;
  group: string;
  /** Sticks can only be pushed plainly. */
  plainOnly?: boolean;
}

const CONTROLS: Control[] = [
  { id: 'left:up', label: '왼쪽 스틱 ↑', group: '이동', plainOnly: true },
  { id: 'left:down', label: '왼쪽 스틱 ↓', group: '이동', plainOnly: true },
  { id: 'left:left', label: '왼쪽 스틱 ←', group: '이동', plainOnly: true },
  { id: 'left:right', label: '왼쪽 스틱 →', group: '이동', plainOnly: true },
  { id: 'cross', label: '✕', group: '버튼' },
  { id: 'moon', label: '○', group: '버튼' },
  { id: 'box', label: '□', group: '버튼' },
  { id: 'pyramid', label: '△', group: '버튼' },
  { id: 'r2', label: 'R2', group: '어깨 · 트리거' },
  { id: 'l2', label: 'L2', group: '어깨 · 트리거' },
  { id: 'r1', label: 'R1', group: '어깨 · 트리거' },
  { id: 'l1', label: 'L1', group: '어깨 · 트리거' },
  { id: 'l3', label: 'L3 (왼쪽 스틱 누르기)', group: '스틱 누르기' },
  { id: 'r3', label: 'R3 (오른쪽 스틱 누르기)', group: '스틱 누르기' },
  { id: 'dpad_up', label: '십자키 ↑', group: '십자키' },
  { id: 'dpad_right', label: '십자키 →', group: '십자키' },
  { id: 'dpad_down', label: '십자키 ↓', group: '십자키' },
  { id: 'dpad_left', label: '십자키 ←', group: '십자키' },
  { id: 'touchpad', label: '터치패드 버튼', group: '시스템' },
  { id: 'options', label: 'OPTIONS', group: '시스템' },
  { id: 'share', label: 'CREATE', group: '시스템' },
  { id: 'ps', label: 'PS', group: '시스템' },
  { id: 'right:up', label: '오른쪽 스틱 ↑', group: '시점을 키로 (보통은 마우스가 담당)', plainOnly: true },
  { id: 'right:down', label: '오른쪽 스틱 ↓', group: '시점을 키로 (보통은 마우스가 담당)', plainOnly: true },
  { id: 'right:left', label: '오른쪽 스틱 ←', group: '시점을 키로 (보통은 마우스가 담당)', plainOnly: true },
  { id: 'right:right', label: '오른쪽 스틱 →', group: '시점을 키로 (보통은 마우스가 담당)', plainOnly: true },
];

const STYLE_TEXT: Record<Style, string> = {
  plain: '누르는 동안',
  tap: '짧게 한 번 (탭)',
  hold: '길게 유지 (홀드)',
  latch: '누를 때마다 켜고 끄기',
  turbo: '누르는 동안 연타',
};
const STYLE_HELP: Record<Style, string> = {
  plain: '키를 누르고 있는 동안 버튼도 눌려 있습니다. 패드와 같고 지연이 없습니다. 게임이 짧게/길게를 스스로 구분합니다.',
  tap: '키를 얼마나 오래 누르든 버튼은 짧게 한 번만 눌립니다. 같은 버튼의 "짧게"를 한 키에 따로 둘 때 씁니다.',
  hold: '키를 톡 눌러도 버튼은 정해진 시간만큼 눌려 있습니다. 같은 버튼의 "길게"를 한 키에 따로 둘 때 씁니다.',
  latch: '한 번 누르면 버튼이 눌린 채로 있고, 다시 누르면 놓습니다. (누르고 있어야 하는 조준을 토글로 바꿀 때 등)',
  turbo: '키를 누르고 있는 동안 버튼을 빠르게 반복해서 누릅니다. (연타가 필요한 달리기 등)',
};
const ACTIVATOR_TEXT: Record<Activator, string> = {
  regular: '그냥 누르면',
  long: '길게 누르면',
  double: '두 번 누르면',
  start: '누르는 순간',
  release: '뗄 때',
};

const KEY_NAMES: Record<string, string> = {
  Mouse0: '좌클릭', Mouse1: '휠 클릭', Mouse2: '우클릭', Mouse3: '마우스 뒤로', Mouse4: '마우스 앞으로', WheelUp: '휠 위로', WheelDown: '휠 아래로',
  Space: 'Space', Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', CapsLock: 'Caps Lock', Backquote: '`', Minus: '-', Equal: '=',
  ShiftLeft: '왼쪽 Shift', ShiftRight: '오른쪽 Shift', AltLeft: '왼쪽 Alt', AltRight: '오른쪽 Alt', ControlLeft: '왼쪽 Ctrl', ControlRight: '오른쪽 Ctrl',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down', Insert: 'Insert', Delete: 'Delete',
};

/** A name a person would use for an input code. */
export function keyName(code: string): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code]!;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return `숫자패드 ${code.slice(6)}`;
  return code;
}

/** Keys a browser acts on by itself: binding them would work badly or dangerously. */
function reserved(code: string): string | null {
  if (code === 'Escape') return 'Esc는 브라우저가 마우스 잠금을 푸는 데 씁니다.';
  if (/^Control(Left|Right)$/.test(code)) return 'Ctrl은 권하지 않습니다: 누른 채 W를 누르면 브라우저가 탭을 닫습니다 (Ctrl+W).';
  if (/^Meta(Left|Right)$/.test(code)) return 'Windows/Command 키는 운영체제가 가져갑니다.';
  if (code === 'F5' || code === 'F11' || code === 'F12') return `${code}는 브라우저가 씁니다 (새로고침, 전체 화면, 개발자 도구).`;
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

/** The layout in a few lines, for showing next to the picture: "이동 W A S D · ✕ Space, Enter · ...". */
export function describeLayout(profile: Profile): Array<{ label: string; keys: string }> {
  const by = new Map<string, string[]>();
  for (const layer of profile.layers) {
    for (const [key, text] of Object.entries(layer.bindings)) {
      const k = splitBindingKey(key);
      const b = readBinding(text);
      if (!k || !b) continue;
      const mark = b.style === 'tap' ? ' (짧게)' : b.style === 'hold' ? ' (길게)' : b.style === 'latch' ? ' (토글)' : b.style === 'turbo' ? ' (연타)' : '';
      const when = k.activator === 'regular' ? '' : ` ${ACTIVATOR_TEXT[k.activator]}`;
      by.set(b.control, [...(by.get(b.control) ?? []), `${keyName(k.code)}${when}${mark}`]);
    }
  }
  const out: Array<{ label: string; keys: string }> = [];
  const stick = ['left:up', 'left:left', 'left:down', 'left:right'].map((c) => by.get(c)?.[0] ?? '?');
  out.push({ label: '이동', keys: stick.join(' ') });
  out.push({ label: '시점', keys: profile.mouse.target === 'off' ? '(마우스 끔)' : profile.mouse.target === 'gyro' ? '마우스 (자이로)' : '마우스' });
  for (const c of CONTROLS) {
    if (c.id.includes(':')) continue;
    const keys = by.get(c.id);
    if (keys?.length) out.push({ label: c.label.replace(/ \(.*\)$/, '').replace(' 버튼', ''), keys: keys.join(', ') });
  }
  for (const layer of profile.layers) {
    if (layer.holdKey && layer.leftStickScale < 1) out.push({ label: '걷기', keys: `${keyName(layer.holdKey)} 누른 채 이동` });
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
    button.textContent = '키나 마우스 버튼을 누르세요 (Esc: 취소)';
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
    if (r.layer !== 'default') line.append(el('span', 'chip', `${r.layer} 레이어`));

    if (!control.plainOnly) {
      const how = el('select');
      how.setAttribute('aria-label', '버튼을 어떻게 누를지');
      for (const s of ['plain', 'tap', 'hold', 'latch', 'turbo'] as Style[]) {
        if (s === 'turbo' && (control.id === 'l2' || control.id === 'r2')) continue;
        const o = el('option', '', STYLE_TEXT[s]);
        o.value = s;
        o.title = STYLE_HELP[s];
        how.append(o);
      }
      how.value = r.style;
      how.title = STYLE_HELP[r.style];
      how.addEventListener('change', () =>
        change((p) => {
          p.layers.find((l) => l.name === r.layer)!.bindings[r.key] = writeBinding(r.control, how.value as Style, null);
        }),
      );
      line.append(how);
    }

    // On which kind of key press. Nearly always the plain one, so it stays quiet until it is something else.
    const when = el('select', r.activator === 'regular' ? 'quiet' : '');
    when.setAttribute('aria-label', '키를 어떻게 눌렀을 때');
    when.title = '이 키를 어떻게 눌렀을 때인지. 길게/두 번 누르기를 쓰면 같은 키의 "그냥 누르면"은 키를 뗄 때 나갑니다.';
    for (const a of ['regular', 'long', 'double', 'start', 'release'] as Activator[]) {
      if (r.code.startsWith('Wheel') && a !== 'regular') continue;
      const o = el('option', '', ACTIVATOR_TEXT[a]);
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
    remove.title = '이 키를 뺍니다';
    remove.type = 'button';
    remove.setAttribute('aria-label', `${keyName(r.code)} 삭제`);
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
        root.append(el('h4', 'keymap-group', group));
        table = el('div', 'keymap-table');
        root.append(table);
      }
      const row = el('div', 'keymap-row');
      row.append(el('div', 'keymap-pad', control.label));
      const cell = el('div', 'keymap-keys');
      for (const r of all.filter((x) => x.control === control.id)) cell.append(bindingLine(r, control));
      const add = el('button', 'btn small keymap-add', '+ 키');
      add.type = 'button';
      add.setAttribute('aria-label', `${control.label}에 키 추가`);
      add.addEventListener('click', () =>
        capture(add, (code) => {
          const why = reserved(code);
          if (why) return host.say(why, 'error');
          const taken = all.find((x) => x.layer === 'default' && x.code === code && x.activator === 'regular');
          const takenBy = taken ? CONTROLS.find((c) => c.id === taken.control)?.label : undefined;
          change(
            (next) => {
              next.layers[0]!.bindings[code] = writeBinding(control.id, 'plain', null);
            },
            takenBy && taken!.control !== control.id ? `${keyName(code)}: ${takenBy}에서 ${control.label}(으)로 옮겼습니다.` : `${keyName(code)} → ${control.label}`,
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
      root.append(el('h4', 'keymap-group', '누르고 있는 동안 바뀌는 것 (레이어)'));
      const table2 = el('div', 'keymap-table');
      for (const layer of layers) {
        const row = el('div', 'keymap-row');
        const what = layer.leftStickScale < 1 ? `이동을 ${Math.round(layer.leftStickScale * 100)}%로 (걷기)` : layer.lookScale !== 1 ? `시점 배율 ${layer.lookScale}` : layer.name === 'aim' ? '조준 (시점 배율을 따로 둘 수 있음)' : '키 배치를 바꿈';
        row.append(el('div', 'keymap-pad', `${layer.name}: ${what}`));
        const cell = el('div', 'keymap-keys');
        const line = el('div', 'keymap-binding');
        line.append(el('kbd', 'keycap', layer.holdKey ? keyName(layer.holdKey) : '(키 없음: 다른 키로 켜고 끔)'));
        const set = el('button', 'btn small', '키 바꾸기');
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
      root.append(el('h4', 'keymap-group', '그 밖의 동작 (아래 프로필 글에서 고칩니다)'));
      const list = el('ul', 'keymap-other');
      for (const o of other) {
        const k = splitBindingKey(o.key);
        list.append(el('li', '', `${k ? keyName(k.code) : o.key}${k && k.activator !== 'regular' ? ` ${ACTIVATOR_TEXT[k.activator]}` : ''}${o.layer !== 'default' ? ` (${o.layer} 레이어)` : ''}: ${o.text}`));
      }
      root.append(list);
    }
  };

  refresh();
  return { refresh };
}
