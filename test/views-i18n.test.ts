// SPDX-License-Identifier: AGPL-3.0-only
//
// The words of the views (the key layout editor, the routes, the login, the presets, the practice game) in both languages. English
// is what the code says; Korean comes from the dictionary (src/i18n). These tests read what a person would read in each language.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { defaultProfile, gtaProfile, PRESETS, shooterProfile } from '../src/engine/profile.ts';
import { setLang, t } from '../src/i18n/index.ts';
import { KO } from '../src/i18n/ko.ts';
import { renderGame } from '../src/testbed/render.ts';
import { FpsGame, defaultGameSettings } from '../src/testbed/fps.ts';
import { TpsGame, defaultTpsSettings } from '../src/testbed/tps.ts';
import { renderTps } from '../src/testbed/tpsrender.ts';
import { describeLayout, keyName } from '../web/keymap.ts';
import { PATHS, STEPS, VERDICTS, detectRoute } from '../web/routes.ts';

const HANGUL = /[가-힣]/;

afterEach(() => setLang('en'));

/** A canvas that does nothing and remembers what was written on it. */
function recordingCanvas(): { ctx: CanvasRenderingContext2D; words: string[] } {
  const words: string[] = [];
  const ctx: unknown = new Proxy(function () {}, {
    get: (_target, name) => (name === 'fillText' ? (text: string) => void words.push(text) : () => ctx),
    set: () => true,
  });
  return { ctx: ctx as CanvasRenderingContext2D, words };
}

describe('the key layout editor', () => {
  it('names keys and mouse buttons in the language in use', () => {
    assert.equal(keyName('KeyW'), 'W');
    assert.equal(keyName('Space'), 'Space');
    assert.equal(keyName('Mouse0'), 'Left click');
    assert.equal(keyName('Numpad5'), 'Numpad 5');
    assert.equal(keyName('ShiftLeft'), 'Left Shift');
    setLang('ko');
    assert.equal(keyName('KeyW'), 'W');
    assert.equal(keyName('Space'), 'Space');
    assert.equal(keyName('Mouse0'), '좌클릭');
    assert.equal(keyName('Numpad5'), '숫자패드 5');
    assert.equal(keyName('ShiftLeft'), '왼쪽 Shift');
  });

  it('describes the layout next to the picture in English, and in Korean when asked again', () => {
    const profile = shooterProfile();
    const en = describeLayout(profile);
    assert.deepEqual(en.slice(0, 2), [{ label: 'Move', keys: 'W A S D' }, { label: 'Look', keys: 'Mouse' }]);
    assert.deepEqual(en.find((r) => r.label === '○'), { label: '○', keys: 'C (tap), Backspace, Z (hold)' });
    assert.deepEqual(en.find((r) => r.label === 'Touchpad'), { label: 'Touchpad', keys: 'Tab, M' });
    assert.deepEqual(en.find((r) => r.label === 'L3'), { label: 'L3', keys: 'Left Shift' });
    assert.deepEqual(en.find((r) => r.label === 'Walk'), { label: 'Walk', keys: 'Hold X and move' });
    assert.ok(en.every((r) => !HANGUL.test(r.label + r.keys)), 'English has no Korean in it');

    setLang('ko');
    const ko = describeLayout(profile);
    assert.deepEqual(ko.slice(0, 2), [{ label: '이동', keys: 'W A S D' }, { label: '시점', keys: '마우스' }]);
    assert.deepEqual(ko.find((r) => r.label === '○'), { label: '○', keys: 'C (짧게), Backspace, Z (길게)' });
    assert.deepEqual(ko.find((r) => r.label === '터치패드'), { label: '터치패드', keys: 'Tab, M' });
    assert.deepEqual(ko.find((r) => r.label === '걷기'), { label: '걷기', keys: 'X 누른 채 이동' });
    assert.equal(ko.length, en.length);
  });

  it('says how the mouse looks: off, gyro, or the stick', () => {
    const profile = defaultProfile();
    profile.mouse.target = 'off';
    assert.equal(describeLayout(profile)[1]!.keys, '(mouse off)');
    profile.mouse.target = 'gyro';
    assert.equal(describeLayout(profile)[1]!.keys, 'Mouse (gyro)');
    setLang('ko');
    assert.equal(describeLayout(profile)[1]!.keys, '마우스 (자이로)');
    profile.mouse.target = 'off';
    assert.equal(describeLayout(profile)[1]!.keys, '(마우스 끔)');
  });

  it('adds the style of a key to its name (rapid presses for the GTA layout)', () => {
    assert.equal(describeLayout(gtaProfile()).find((r) => r.label === '✕')!.keys, 'Left Shift (rapid), Enter');
    setLang('ko');
    assert.equal(describeLayout(gtaProfile()).find((r) => r.label === '✕')!.keys, '왼쪽 Shift (연타), Enter');
  });

  it('shows the names of the layouts that come with it in either language', () => {
    assert.deepEqual(PRESETS.map((p) => t(p.name)), ['Default (general)', 'Shooter example (short and long press on different keys)', 'GTA V style']);
    setLang('ko');
    assert.deepEqual(PRESETS.map((p) => t(p.name)), ['기본 (범용)', '슈터 예시 (짧게/길게를 다른 키로)', 'GTA V 스타일']);
  });
});

describe('the routes', () => {
  /** Every sentence the tables hold. */
  const sentences = (): string[] => {
    const out: string[] = [];
    for (const s of STEPS) out.push(s.title);
    for (const v of Object.values(VERDICTS)) out.push(v.title, v.short);
    for (const p of PATHS) {
      out.push(p.name, p.sub, p.tag, p.needs, p.watch, p.status);
      for (const n of p.nodes) out.push(n.title, n.sub);
      for (const step of Object.values(p.steps)) out.push(step.proto, step.note, ...step.labels);
    }
    return out;
  };

  it('holds English that has Korean beside it, for every word of every table', () => {
    const all = sentences();
    assert.ok(all.length > 200);
    assert.deepEqual(all.filter((s) => HANGUL.test(s)), [], 'the tables are written in English');
    assert.deepEqual(all.filter((s) => !Object.hasOwn(KO, s)), [], 'every word of the tables has Korean (is it marked with N_?)');
  });

  it('shows a route in the language in use', () => {
    const lan = PATHS.find((p) => p.id === 'lan')!;
    assert.equal(t(lan.name), 'At home · same network');
    assert.equal(t(lan.steps.wake.note), 'The function exists, but it has not been tried on a real PS5 yet.');
    setLang('ko');
    assert.equal(t(lan.name), '집 안 · 같은 네트워크');
    assert.equal(t(lan.steps.wake.note), '함수는 있지만 실제 PS5로는 아직 시험하지 않았습니다.');
    assert.equal(t(VERDICTS.likely.title), '코드 있음 · 실기 미확인');
    assert.equal(VERDICTS.ok.symbol, '✔');
  });

  it('guesses the route and says why, in the language in use', () => {
    const same = { pageHost: '192.168.1.20', consoleHost: '192.168.1.30', interfaces: [{ address: '192.168.1.20', netmask: '255.255.255.0' }] };
    assert.deepEqual(detectRoute(same), { id: 'bridge', reason: 'The browser, the bridge and the PS5 are on the same home network.' });
    assert.equal(detectRoute({ ...same, consoleHost: '10.0.0.5' }).reason, 'The PS5 (10.0.0.5) seems to be on a different subnet from the bridge computer.');
    assert.equal(detectRoute({ pageHost: 'localhost', interfaces: [] }).reason, 'The browser is open on the same computer as the bridge.');
    assert.equal(detectRoute({ pageHost: '192.168.1.20', interfaces: [] }).reason, 'This page was opened from an address inside the home.');
    assert.equal(detectRoute({ pageHost: 'mac.tail1234.ts.net', interfaces: [] }).reason, 'This page was opened from a VPN (Tailscale) address.');
    assert.equal(detectRoute({ pageHost: 'play.example.com', interfaces: [] }).reason, 'This page was opened from an address outside the home.');

    setLang('ko');
    assert.deepEqual(detectRoute(same), { id: 'bridge', reason: '브라우저와 브리지, PS5가 같은 집 네트워크에 있습니다.' });
    assert.equal(detectRoute({ ...same, consoleHost: '10.0.0.5' }).reason, 'PS5(10.0.0.5)가 브리지 컴퓨터와 다른 대역에 있어 보입니다.');
    assert.equal(detectRoute({ pageHost: 'localhost', interfaces: [] }).reason, '브라우저가 브리지와 같은 컴퓨터에서 열려 있습니다.');
    assert.equal(detectRoute({ pageHost: 'mac.tail1234.ts.net', interfaces: [] }).reason, '이 페이지를 VPN(Tailscale) 주소로 열었습니다.');
  });
});

describe('the practice game', () => {
  it('names what the character is doing in the language in use', () => {
    const game = new TpsGame(defaultTpsSettings());
    const names = (): string[] => {
      const out: string[] = [];
      game.inVehicle = false;
      game.aiming = false;
      game.speed = 0;
      out.push(game.movementName);
      game.speed = 1;
      out.push(game.movementName);
      game.speed = 3;
      out.push(game.movementName);
      game.speed = 5;
      out.push(game.movementName);
      game.speed = 6;
      out.push(game.movementName);
      game.aiming = true;
      out.push(game.movementName);
      game.aiming = false;
      game.inVehicle = true;
      out.push(game.movementName);
      return out;
    };
    assert.deepEqual(names(), ['Standing', 'Walking', 'Jogging', 'Running', 'Sprinting', 'Aiming', 'Driving']);
    setLang('ko');
    assert.deepEqual(names(), ['정지', '걷기', '조깅', '달리기', '스프린트', '조준', '운전']);
  });

  it('draws the score in the language in use, on both canvases', () => {
    const fps = new FpsGame(defaultGameSettings());
    const tps = new TpsGame(defaultTpsSettings());
    for (const [lang, score] of [['en', 'Hits 0 / shots 0'], ['ko', '명중 0 / 발사 0']] as const) {
      setLang(lang);
      const a = recordingCanvas();
      renderGame(a.ctx, fps, 320, 200);
      assert.ok(a.words.includes(score), `${lang}: ${a.words.join(' | ')}`);
      const b = recordingCanvas();
      renderTps(b.ctx, tps, 320, 200);
      assert.ok(b.words.includes(score), `${lang}: ${b.words.join(' | ')}`);
    }
  });
});
