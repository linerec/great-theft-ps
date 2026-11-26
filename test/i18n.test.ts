// SPDX-License-Identifier: AGPL-3.0-only
//
// English is what the code and the page say; Korean is a dictionary beside it (src/i18n). These tests keep the two in step: every
// sentence has its Korean, no Korean is left for a sentence that is gone, nothing Korean is written into the code, and the
// pieces that are filled in ({name}) are the same in both. A sentence that is changed in English without its Korean fails here.

import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { clearMissing, fill, getLang, isLang, langOf, missingKeys, normalizeKey, onLang, setLang, t, translate } from '../src/i18n/index.ts';
import { KO_BRIDGE } from '../src/i18n/ko-bridge.ts';
import { KO_CORE } from '../src/i18n/ko-core.ts';
import { KO_PAGE } from '../src/i18n/ko-page.ts';
import { KO_PLAY } from '../src/i18n/ko-play.ts';
import { KO_STUDY } from '../src/i18n/ko-study.ts';
import { KO_VIEWS } from '../src/i18n/ko-views.ts';
import { KO } from '../src/i18n/ko.ts';
import { allSentences, filesUnder, readLiteral, sentencesInCode, sentencesInPage } from './support/i18n-scan.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const where = (f: { file: string; line: number }): string => `${path.relative(root, f.file)}:${f.line}`;
const placeholders = (s: string): string => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;

/** Runs `use` on a file with this text in it, which is gone afterwards. */
function withFile<T>(name: string, body: string, use: (file: string) => T): T {
  const file = path.join(root, 'test', 'support', `.scan-${process.pid}-${name}`);
  writeFileSync(file, body);
  try {
    return use(file);
  } finally {
    rmSync(file, { force: true });
  }
}

describe('translate', () => {
  it('gives English as it is and Korean from the dictionary, with the values put in', () => {
    assert.equal(translate('en', 'Played {minutes} min', { minutes: 5 }), 'Played 5 min');
    assert.equal(translate('ko', 'Language'), '언어');
    assert.equal(translate('ko', 'A sentence nobody translated {n}', { n: 2 }), 'A sentence nobody translated 2');
  });

  it('remembers what had no Korean, but never for English', () => {
    clearMissing();
    translate('en', 'Only English here');
    assert.deepEqual(missingKeys(), []);
    translate('ko', 'Only English here');
    assert.deepEqual(missingKeys(), ['Only English here']);
    clearMissing();
  });

  it('leaves a {name} that has no value alone, and does not read values as patterns', () => {
    assert.equal(fill('Hello {who}, {missing}', { who: '$&' }), 'Hello $&, {missing}');
    assert.equal(fill('Hello {toString}', {}), 'Hello {toString}');
  });

  it('follows the page language, and tells whoever listens when it changes', () => {
    const seen: string[] = [];
    const stop = onLang((l) => seen.push(l));
    assert.equal(getLang(), 'en');
    assert.equal(t('Language'), 'Language');
    setLang('ko');
    assert.equal(t('Language'), '언어');
    setLang('ko');
    setLang('en');
    stop();
    setLang('ko');
    setLang('en');
    assert.deepEqual(seen, ['ko', 'en']);
  });

  it('takes only languages that exist: anything else is English', () => {
    assert.equal(langOf('ko'), 'ko');
    assert.equal(langOf('fr'), 'en');
    assert.equal(langOf(undefined), 'en');
    assert.equal(isLang('en'), true);
    assert.equal(isLang('EN'), false);
  });

  it('reads a page sentence the way the browser gives it back', () => {
    assert.equal(normalizeKey('  Press\n   <b>Esc</b>  to let go. '), 'Press <b>Esc</b> to let go.');
  });
});

describe('the sentence finder', () => {
  const scanText = (text: string): ReturnType<typeof sentencesInCode> => withFile('code.tmp.ts', text, (file) => sentencesInCode(file));

  it('finds t(), N_() and translate(lang, ) with their escapes, and says what it cannot read', () => {
    const r = scanText("t('It\\'s {n}'); N_(\"a \\u2026 b\"); translate(lang, `plain`); this.t('not one'); t(`x ${y}`); t('a' + 'b'); t(variable);");
    assert.deepEqual(r.found.map((f) => f.key), ["It's {n}", 'a … b', 'plain']);
    assert.equal(r.problems.length, 2);
    assert.match(r.problems[0]!.problem, /\$\{\}/);
    assert.match(r.problems[1]!.problem, /joined/);
  });

  it('reads literals', () => {
    assert.deepEqual(readLiteral("'a\\nb'", 0), { value: 'a\nb', end: 6 });
    assert.equal(readLiteral('abc', 0), null);
  });

  it('finds the sentences of a page: content as a whole, and the listed attributes', () => {
    const r = withFile('page.tmp.html', '<p data-i18n>Press\n <b>Esc</b> now.</p><button data-i18n-attr="title aria-label" title="Close" aria-label="Close it"><svg></svg></button><div data-i18n><button>x</button></div><p data-i18n>a<br/>b</p>', (file) => sentencesInPage(file));
    assert.deepEqual(r.found.map((f) => f.key), ['Press <b>Esc</b> now.', 'Close', 'Close it', '<button>x</button>', 'a<br/>b']);
    assert.equal(r.problems.length, 2);
    assert.match(r.problems.map((p) => p.problem).join('|'), /<button> inside a data-i18n element/);
    assert.match(r.problems.map((p) => p.problem).join('|'), /without the slash/);
  });
});

describe('the dictionary and the program', () => {
  const { found, problems } = allSentences(root);
  const used = new Set(found.map((f) => f.key));

  it('is written in sentences the finder can read', () => {
    assert.deepEqual(problems.map((p) => `${where(p)}  ${p.problem}`), []);
  });

  it('has Korean for every sentence', () => {
    const lacking = found.filter((f) => !Object.hasOwn(KO, f.key));
    assert.deepEqual(lacking.map((f) => `${where(f)}  ${JSON.stringify(f.key)}`), []);
  });

  it('has no Korean for a sentence that is not there any more', () => {
    assert.deepEqual(Object.keys(KO).filter((k) => !used.has(k)), []);
  });

  it('has no sentence that two parts of the dictionary translate differently (the later part would silently win)', () => {
    const parts = { core: KO_CORE, page: KO_PAGE, play: KO_PLAY, views: KO_VIEWS, bridge: KO_BRIDGE, study: KO_STUDY };
    const seen = new Map<string, { part: string; ko: string }>();
    const clashes: string[] = [];
    for (const [part, dict] of Object.entries(parts)) {
      for (const [en, ko] of Object.entries(dict)) {
        const before = seen.get(en);
        if (before && before.ko !== ko) clashes.push(`${JSON.stringify(en)}: ${before.part} says ${JSON.stringify(before.ko)}, ${part} says ${JSON.stringify(ko)}`);
        else seen.set(en, { part, ko });
      }
    }
    assert.deepEqual(clashes, []);
  });

  it('fills in the same pieces in both languages, and has no other braces', () => {
    const wrong: string[] = [];
    for (const [en, ko] of Object.entries(KO)) {
      if (placeholders(en) !== placeholders(ko)) wrong.push(`${JSON.stringify(en)} has {${placeholders(en)}} but its Korean has {${placeholders(ko)}}`);
      if (/[{}]/.test(en.replace(/\{\w+\}/g, ''))) wrong.push(`${JSON.stringify(en)} has a brace that is not a {name}`);
      if (/[{}]/.test(ko.replace(/\{\w+\}/g, ''))) wrong.push(`the Korean of ${JSON.stringify(en)} has a brace that is not a {name}`);
    }
    assert.deepEqual(wrong, []);
  });

  it('has Korean that is Korean, and English that is not', () => {
    const wrong: string[] = [];
    for (const [en, ko] of Object.entries(KO)) {
      if (HANGUL.test(en)) wrong.push(`the English of ${JSON.stringify(en)} has Korean in it`);
      if (!HANGUL.test(ko) && ko !== en && !/^[\d\s.,:;·×%°/()\-–—+=<>{}&a-zA-Z]*$/.test(ko)) wrong.push(`the Korean of ${JSON.stringify(en)} is ${JSON.stringify(ko)}`);
    }
    assert.deepEqual(wrong, []);
  });

  it('keeps Korean out of the code and the page: it lives in the dictionary', () => {
    const files = [...filesUnder(path.join(root, 'web'), /\.(ts|html|css|js)$/), ...filesUnder(path.join(root, 'src'), /\.ts$/)].filter((f) => !/[\\/]src[\\/]i18n[\\/]/.test(f));
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (HANGUL.test(line)) hits.push(`${path.relative(root, f)}:${i + 1}  ${line.trim().slice(0, 80)}`);
      });
    }
    assert.deepEqual(hits, []);
  });
});
