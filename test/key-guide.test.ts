// SPDX-License-Identifier: AGPL-3.0-only
//
// The guide that is shown beside the picture lists what each key does. A key that does two things at once (get into a car AND
// switch to the driving controls) used to be left out of it, and that is the key a player looks for first.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { setLang } from '../src/i18n/index.ts';
import { defaultProfile, gtaProfile } from '../src/engine/profile.ts';
import { describeLayout } from '../web/keymap.ts';

afterEach(() => setLang('en'));

describe('the key guide', () => {
  it('lists a key that presses a button and also switches a layer under that button', () => {
    const rows = describeLayout(gtaProfile());
    assert.deepEqual(rows.find((r) => r.label === '△'), { label: '△', keys: 'F' });
  });

  it('lists a key under every button it presses, and says nothing of a layer it switches', () => {
    const profile = defaultProfile();
    profile.layers[0]!.bindings = { KeyG: 'btn:cross+btn:moon', KeyH: 'toggle:walk' };
    const rows = describeLayout(profile);
    assert.deepEqual(rows.find((r) => r.label === '✕'), { label: '✕', keys: 'G' });
    assert.deepEqual(rows.find((r) => r.label === '○'), { label: '○', keys: 'G' });
    assert.ok(!rows.some((r) => /\bH\b/.test(r.keys)), 'a key that only switches a layer is not a button');
  });

  it('keeps the order a player looks in: moving, looking, then the buttons', () => {
    const labels = describeLayout(gtaProfile()).map((r) => r.label);
    assert.deepEqual(labels.slice(0, 6), ['Move', 'Look', '✕', '○', '□', '△']);
  });

  it('is the same list in Korean, with the same keys', () => {
    const en = describeLayout(gtaProfile());
    setLang('ko');
    const ko = describeLayout(gtaProfile());
    assert.equal(ko.length, en.length);
    assert.deepEqual(ko.find((r) => r.label === '△'), { label: '△', keys: 'F' });
  });
});
