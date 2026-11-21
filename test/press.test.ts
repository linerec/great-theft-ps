// SPDX-License-Identifier: AGPL-3.0-only
//
// How a key press becomes a pad press: the plain press (down exactly as long as the key), a press of fixed length, a
// press with a least length, a latch, and one key doing different things for short, long and double presses.
// Time is stepped by hand in 4 ms ticks, so every duration here is exact.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MappingEngine } from '../src/engine/engine.ts';
import { defaultProfile, parseAction, parseActions, PRESETS, shooterProfile, splitBindingKey, validateProfile, type Profile } from '../src/engine/profile.ts';
import { BUTTON } from '../src/engine/types.ts';

const TICK = 0.004;

/** A profile with only the given bindings on the default layer, and no mouse. */
function profileWith(bindings: Record<string, string>, keys: Partial<Profile['keys']> = {}): Profile {
  const p = defaultProfile();
  p.layers = [{ name: 'default', holdKey: null, leftStickScale: 1, lookScale: 1, bindings }, { name: 'walk', holdKey: null, leftStickScale: 0.5, lookScale: 1, bindings: {} }];
  p.mouse.target = 'off';
  p.keys = { ...p.keys, ...keys };
  const checked = validateProfile(p);
  assert.ok(checked.ok, checked.ok ? '' : checked.errors.join('; '));
  return checked.profile;
}

/** Runs an engine through time and records the buttons and triggers of every tick. */
class Run {
  engine: MappingEngine;
  /** One entry per tick: [time in ms at the start of the tick, buttons, l2, r2]. */
  log: Array<[number, number, number, number]> = [];
  #ms = 0;
  constructor(profile: Profile) {
    this.engine = new MappingEngine(profile);
  }
  /** Advance by `ms`. */
  for(ms: number): this {
    for (let i = 0; i < Math.round(ms / 4); i++) {
      const s = this.engine.tick(TICK);
      this.log.push([this.#ms, s.buttons, s.l2, s.r2]);
      this.#ms += 4;
    }
    return this;
  }
  down(code: string): this {
    this.engine.keyDown(code);
    return this;
  }
  up(code: string): this {
    this.engine.keyUp(code);
    return this;
  }
  /** Press a key for `ms`, then let go. */
  press(code: string, ms: number): this {
    return this.down(code).for(ms).up(code);
  }
  /** The stretches of time, in ms, during which `button` was down: [[from, to], ...]. */
  spans(button: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let from = -1;
    for (const [t, buttons] of this.log) {
      const on = (buttons & button) !== 0;
      if (on && from < 0) from = t;
      if (!on && from >= 0) {
        out.push([from, t]);
        from = -1;
      }
    }
    if (from >= 0) out.push([from, this.#ms]);
    return out;
  }
  triggerSpans(which: 'l2' | 'r2'): Array<[number, number]> {
    const i = which === 'l2' ? 2 : 3;
    const out: Array<[number, number]> = [];
    let from = -1;
    for (const row of this.log) {
      const on = row[i]! > 0;
      if (on && from < 0) from = row[0];
      if (!on && from >= 0) {
        out.push([from, row[0]]);
        from = -1;
      }
    }
    if (from >= 0) out.push([from, this.#ms]);
    return out;
  }
}

describe('the plain press', () => {
  it('holds the button exactly as long as the key, starting at once', () => {
    const r = new Run(profileWith({ KeyR: 'btn:box' })).for(20).press('KeyR', 200).for(100);
    assert.deepEqual(r.spans(BUTTON.box), [[20, 220]]);
  });

  it('so a game tells a short press from a long one just as it does on a pad', () => {
    const r = new Run(profileWith({ KeyR: 'btn:box' })).press('KeyR', 60).for(200).press('KeyR', 900).for(40);
    assert.deepEqual(r.spans(BUTTON.box), [[0, 60], [260, 1160]]);
  });
});

describe('a press of fixed length (tap:)', () => {
  it('lasts the tap time however long the key is held, and starts at once', () => {
    const r = new Run(profileWith({ KeyR: 'tap:box' })).for(20).press('KeyR', 1000).for(100);
    assert.deepEqual(r.spans(BUTTON.box), [[20, 100]], '80 ms, the default');
  });

  it('also when the key is let go at once', () => {
    const r = new Run(profileWith({ KeyR: 'tap:box' })).press('KeyR', 8).for(200);
    assert.deepEqual(r.spans(BUTTON.box), [[0, 80]]);
  });

  it('takes its length from the binding or from the profile, and works for triggers', () => {
    const r = new Run(profileWith({ KeyR: 'tap:box:40', KeyG: 'tap:r2' }, { tapMs: 120 })).press('KeyR', 300).for(100).press('KeyG', 300).for(100);
    assert.deepEqual(r.spans(BUTTON.box), [[0, 40]]);
    assert.deepEqual(r.triggerSpans('r2'), [[400, 520]]);
  });

  it('each press of the key is its own tap', () => {
    const r = new Run(profileWith({ KeyR: 'tap:box' })).press('KeyR', 20).for(200).press('KeyR', 20).for(200);
    assert.deepEqual(r.spans(BUTTON.box), [[0, 80], [220, 300]]);
  });
});

describe('a press with a least length (hold:)', () => {
  it('turns a quick key press into a held button', () => {
    const r = new Run(profileWith({ KeyE: 'hold:box' })).press('KeyE', 40).for(900);
    assert.deepEqual(r.spans(BUTTON.box), [[0, 600]], '600 ms, the default');
  });

  it('and stays down for as long as the key is, when that is longer', () => {
    const r = new Run(profileWith({ KeyE: 'hold:box:300' })).press('KeyE', 1000).for(100);
    assert.deepEqual(r.spans(BUTTON.box), [[0, 1000]]);
  });

  it('two keys can then share one pad button: R taps it, E holds it', () => {
    const r = new Run(shooterLike()).press('KeyR', 700).for(300).press('KeyE', 30).for(900);
    assert.deepEqual(r.spans(BUTTON.box), [[0, 80], [1000, 1600]]);
  });
});
const shooterLike = (): Profile => profileWith({ KeyR: 'tap:box', KeyE: 'hold:box' });

describe('a latch', () => {
  it('switches the button on with one press and off with the next', () => {
    const r = new Run(profileWith({ KeyZ: 'latch:l2' })).for(20).press('KeyZ', 40).for(400).press('KeyZ', 40).for(100);
    assert.deepEqual(r.triggerSpans('l2'), [[20, 460]]);
  });

  it('is let go when everything is released (the window lost focus)', () => {
    const r = new Run(profileWith({ KeyZ: 'latch:l3' })).press('KeyZ', 40).for(100);
    assert.deepEqual(r.engine.latchedOutputs, ['b:l3']);
    r.engine.releaseAll();
    r.for(40);
    assert.deepEqual(r.engine.latchedOutputs, []);
    assert.deepEqual(r.spans(BUTTON.l3), [[0, 140]]);
  });
});

describe('one key, different things for short and long presses (@long)', () => {
  const p = (): Profile => profileWith({ KeyF: 'btn:pyramid', 'KeyF@long': 'btn:dpad_left' });

  it('a short press is a tap of the plain binding, sent when the key is let go', () => {
    const r = new Run(p()).for(20).press('KeyF', 120).for(300);
    assert.deepEqual(r.spans(BUTTON.pyramid), [[140, 220]], 'this is the cost: nothing happens until the key is let go');
    assert.deepEqual(r.spans(BUTTON.dpad_left), []);
  });

  it('a key held past the long press time becomes the long binding, until it is let go', () => {
    const r = new Run(p()).for(20).press('KeyF', 900).for(200);
    assert.deepEqual(r.spans(BUTTON.dpad_left), [[320, 920]], 'from 300 ms after the press');
    assert.deepEqual(r.spans(BUTTON.pyramid), [], 'and the plain one never fires');
  });

  it('a long press that ends the moment it began is still long enough to be seen', () => {
    const r = new Run(p()).press('KeyF', 304).for(300);
    assert.deepEqual(r.spans(BUTTON.dpad_left), [[300, 380]]);
  });

  it('the time is the profile\'s', () => {
    const r = new Run(profileWith({ KeyF: 'btn:pyramid', 'KeyF@long': 'btn:dpad_left' }, { longPressMs: 500 })).press('KeyF', 400).for(300);
    assert.deepEqual(r.spans(BUTTON.pyramid), [[400, 480]]);
    assert.deepEqual(r.spans(BUTTON.dpad_left), []);
  });

  it('other keys are not slowed down by it', () => {
    const r = new Run(profileWith({ KeyF: 'btn:pyramid', 'KeyF@long': 'btn:dpad_left', KeyR: 'btn:box' })).press('KeyR', 40).for(40);
    assert.deepEqual(r.spans(BUTTON.box), [[0, 40]]);
  });
});

describe('a double press (@double)', () => {
  const p = (): Profile => profileWith({ KeyC: 'btn:moon', 'KeyC@double': 'btn:r3' });

  it('two quick presses give the double binding, for as long as the second is held', () => {
    const r = new Run(p()).press('KeyC', 60).for(80).press('KeyC', 400).for(200);
    assert.deepEqual(r.spans(BUTTON.r3), [[140, 540]]);
    assert.deepEqual(r.spans(BUTTON.moon), []);
  });

  it('one press alone gives the plain binding, once it is clear that no second one comes', () => {
    const r = new Run(p()).press('KeyC', 60).for(600);
    assert.deepEqual(r.spans(BUTTON.moon), [[252, 332]], 'after the 250 ms in which a second press could have come');
    assert.deepEqual(r.spans(BUTTON.r3), []);
  });

  it('a second press that comes too late is a new first press', () => {
    const r = new Run(p()).press('KeyC', 60).for(400).press('KeyC', 60).for(600);
    assert.equal(r.spans(BUTTON.moon).length, 2);
    assert.deepEqual(r.spans(BUTTON.r3), []);
  });

  it('works together with a long press on the same key', () => {
    const q = profileWith({ KeyC: 'btn:moon', 'KeyC@double': 'btn:r3', 'KeyC@long': 'btn:l3' });
    assert.deepEqual(new Run(q).press('KeyC', 700).for(300).spans(BUTTON.l3), [[300, 700]]);
    assert.deepEqual(new Run(q).press('KeyC', 60).for(80).press('KeyC', 60).for(300).spans(BUTTON.r3), [[140, 220]]);
    assert.deepEqual(new Run(q).press('KeyC', 60).for(600).spans(BUTTON.moon), [[252, 332]]);
  });
});

describe('start and release presses', () => {
  it('@start fires the moment the key goes down, whatever the press turns out to be', () => {
    const r = new Run(profileWith({ 'KeyG@start': 'btn:cross', 'KeyG@long': 'btn:pyramid' })).for(20).press('KeyG', 600).for(200);
    assert.deepEqual(r.spans(BUTTON.cross), [[20, 100]], 'at once, as a tap: the way around the delay');
    assert.deepEqual(r.spans(BUTTON.pyramid), [[320, 620]]);
  });

  it('@release fires when the key is let go', () => {
    const r = new Run(profileWith({ KeyG: 'btn:l1', 'KeyG@release': 'btn:r1' })).press('KeyG', 200).for(200);
    assert.deepEqual(r.spans(BUTTON.l1), [[0, 200]]);
    assert.deepEqual(r.spans(BUTTON.r1), [[200, 280]]);
  });
});

describe('layers, and the things that happen once', () => {
  it('a layer switch on a key with a long press happens with the press it belongs to', () => {
    const p = profileWith({ KeyV: 'btn:r3', 'KeyV@long': 'toggle:walk' });
    const short = new Run(p).press('KeyV', 100).for(200);
    assert.deepEqual(short.engine.latchedLayers, []);
    const long = new Run(p).press('KeyV', 500).for(100);
    assert.deepEqual(long.engine.latchedLayers, ['walk']);
    assert.deepEqual(long.spans(BUTTON.r3), [], 'and the plain press did not fire');
  });

  it('a press and a release within the same tick are both seen, in order', () => {
    const r = new Run(profileWith({ KeyR: 'tap:box', KeyZ: 'latch:l1' }));
    r.down('KeyR').up('KeyR').down('KeyZ').up('KeyZ').down('KeyZ').up('KeyZ').for(200);
    assert.deepEqual(r.spans(BUTTON.box), [[0, 80]]);
    assert.deepEqual(r.spans(BUTTON.l1), [], 'on and off again before the tick: off');
  });

  it('releasing everything drops a press that was still being decided', () => {
    const r = new Run(profileWith({ KeyF: 'btn:pyramid', 'KeyF@long': 'btn:dpad_left' })).down('KeyF').for(100);
    r.engine.releaseAll();
    r.for(600);
    assert.deepEqual(r.spans(BUTTON.pyramid), []);
    assert.deepEqual(r.spans(BUTTON.dpad_left), []);
  });
});

describe('the profile text', () => {
  it('reads the new actions and refuses nonsense', () => {
    assert.deepEqual(parseAction('tap:box'), { kind: 'tap', out: { button: 'box' }, ms: null });
    assert.deepEqual(parseAction('tap:r2:60'), { kind: 'tap', out: { trigger: 'r2' }, ms: 60 });
    assert.deepEqual(parseAction('hold:moon:800'), { kind: 'hold', out: { button: 'moon' }, ms: 800 });
    assert.deepEqual(parseAction('latch:l2'), { kind: 'latch', out: { trigger: 'l2' } });
    for (const bad of ['tap:nothing', 'tap:box:5', 'tap:box:2000', 'hold:box:50', 'hold:box:9000', 'latch:box:100', 'tap', 'hold:']) assert.equal(parseAction(bad), null, bad);
    assert.equal(parseActions('tap:box+toggle:walk')!.length, 2);
  });

  it('reads the kind of press from the key', () => {
    assert.deepEqual(splitBindingKey('KeyG'), { code: 'KeyG', activator: 'regular' });
    assert.deepEqual(splitBindingKey('KeyG@long'), { code: 'KeyG', activator: 'long' });
    assert.deepEqual(splitBindingKey('Mouse3@double'), { code: 'Mouse3', activator: 'double' });
    for (const bad of ['KeyG@', 'KeyG@triple', '@long', 'Key G', 'KeyG@long@double']) assert.equal(splitBindingKey(bad), null, bad);
  });

  it('checks them in a profile, and fills in the press times of an older profile', () => {
    const p = defaultProfile() as unknown as { keys: Record<string, number>; layers: Array<{ bindings: Record<string, string> }> };
    p.layers[0]!.bindings = { 'KeyG@long': 'btn:cross', 'WheelUp@long': 'btn:cross', 'KeyH@triple': 'btn:cross', KeyJ: 'tap:box:1' };
    const bad = validateProfile(p);
    assert.equal(bad.ok, false);
    const errors = bad.ok ? [] : bad.errors;
    assert.equal(errors.length, 3, errors.join(' | '));
    assert.ok(errors.some((e) => /wheel/i.test(e)));

    const old = JSON.parse(JSON.stringify(defaultProfile()));
    old.keys = { rampUpMs: 10, rampDownMs: 20 }; // written before the press times existed
    const read = validateProfile(old);
    assert.ok(read.ok);
    assert.deepEqual(read.ok && read.profile.keys, { rampUpMs: 10, rampDownMs: 20, tapMs: 80, holdMs: 600, longPressMs: 300, doublePressMs: 250 });
    assert.equal(validateProfile({ ...old, keys: { tapMs: 5 } }).ok, false);
  });
});

describe('the layouts that come with it', () => {
  it('every preset is a valid profile', () => {
    for (const preset of PRESETS) {
      const checked = validateProfile(preset.make());
      assert.ok(checked.ok, `${preset.id}: ${checked.ok ? '' : checked.errors.join('; ')}`);
    }
  });

  it('the general layout reaches every button of the pad, with plain presses only', () => {
    const p = defaultProfile();
    const reached = new Set<string>();
    for (const layer of p.layers) {
      for (const [key, text] of Object.entries(layer.bindings)) {
        assert.equal(splitBindingKey(key)!.activator, 'regular', `${key}: the general layout adds no delay to any key`);
        for (const a of parseActions(text)!) {
          assert.ok(a.kind === 'button' || a.kind === 'stick' || a.kind === 'trigger', `${key}: ${text}`);
          if (a.kind === 'button') reached.add(a.button);
          if (a.kind === 'trigger') reached.add(a.trigger);
          if (a.kind === 'stick') reached.add(`${a.stick}:${a.dir}`);
        }
      }
    }
    for (const b of Object.keys(BUTTON)) assert.ok(reached.has(b), `no key for ${b}`);
    for (const t of ['l2', 'r2', 'left:up', 'left:down', 'left:left', 'left:right']) assert.ok(reached.has(t), `no key for ${t}`);
  });

  it('keeps off the keys a browser acts on by itself', () => {
    for (const preset of PRESETS) {
      for (const layer of preset.make().layers) {
        for (const key of [...Object.keys(layer.bindings), layer.holdKey ?? '']) {
          const code = key.split('@')[0]!;
          assert.ok(!/^(Escape|ControlLeft|ControlRight|MetaLeft|MetaRight|F5|F11|F12)$/.test(code), `${preset.id}: ${code}`);
        }
      }
    }
  });

  it('the shooter example really puts tap and hold of one button on two keys', () => {
    const r = new Run(shooterProfile());
    r.engine.setProfile({ ...shooterProfile(), mouse: { ...shooterProfile().mouse, target: 'off' } });
    r.press('KeyR', 500).for(300).press('KeyE', 20).for(900).press('KeyC', 300).for(200).press('KeyZ', 20).for(900);
    assert.deepEqual(r.spans(BUTTON.box), [[0, 80], [800, 1400]]);
    assert.deepEqual(r.spans(BUTTON.moon), [[1720, 1800], [2220, 2820]]);
  });
});
