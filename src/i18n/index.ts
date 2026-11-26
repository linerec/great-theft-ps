// SPDX-License-Identifier: AGPL-3.0-only
//
// Words for people, in English and Korean. English is what the code says and what everyone gets until they choose
// otherwise; Korean is a dictionary beside it, keyed by the English sentence itself. So a sentence is written once, in the
// place where it is used, and the reader of the code sees what the person sees.
//
//   t('Connecting to {name}…', { name })      the text for the language in use (the page's), `{name}` filled in
//   N_('Same network, at home')               marks a sentence that is stored and shown later through t(): data tables
//   translate(lang, 'Log in first')           for code that serves several people at once (the bridge): the language is theirs
//
// A sentence that has no Korean entry is shown in English (never blank), and is remembered in missingKeys() so that a
// test run or a look at the page can tell. test/i18n.test.ts keeps the dictionary and the code in step.
//
// Rules for a sentence (they keep it translatable): one string literal, no joining of pieces with +, no `${}` inside (use
// `{name}`), no other braces, and no plural tricks ("{n} min" rather than "{n} minute(s)").

import { KO } from './ko.ts';

export type Lang = 'en' | 'ko';
export const LANGS: readonly Lang[] = ['en', 'ko'];
export const DEFAULT_LANG: Lang = 'en';
/** Each language in its own words: what a person looks for in a list of languages. */
export const LANG_NAMES: Record<Lang, string> = { en: 'English', ko: '한국어' };
/** For dates and numbers. */
export const LOCALES: Record<Lang, string> = { en: 'en-US', ko: 'ko-KR' };

export type Vars = Record<string, string | number>;

export const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANGS as readonly string[]).includes(v);
/** What a request or a saved choice says, or English when it says nothing usable. */
export const langOf = (v: unknown): Lang => (isLang(v) ? v : DEFAULT_LANG);

const DICTIONARIES: Record<Lang, Record<string, string>> = { en: {}, ko: KO };
const missing = new Set<string>();

/** Sentences that were asked for in a language that has no entry for them (English is the source, so never for English). */
export const missingKeys = (): string[] => [...missing];
export const clearMissing = (): void => missing.clear();

export function fill(text: string, vars?: Vars): string {
  return vars ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : whole)) : text;
}

/** The sentence in a language, with `{name}` replaced by the values. */
export function translate(lang: Lang, en: string, vars?: Vars): string {
  if (lang === 'en') return fill(en, vars);
  const text = DICTIONARIES[lang][en];
  if (text === undefined) missing.add(en);
  return fill(text ?? en, vars);
}

// ------------------------------------------------------------------ the page's language

let current: Lang = DEFAULT_LANG;
const listeners = new Set<(lang: Lang) => void>();

export const getLang = (): Lang => current;

/** Changes the language in use and tells whoever draws words once and keeps them (onLang). */
export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  for (const f of listeners) f(lang);
}

/** `f` runs after the language changes, so that words that were put on the screen once are put there again. Returns the way to stop. */
export function onLang(f: (lang: Lang) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** The sentence in the language in use. */
export const t = (en: string, vars?: Vars): string => translate(current, en, vars);

/** Marks a sentence that is kept in a table and shown later with t(); it is the sentence itself. */
export const N_ = <S extends string>(en: S): S => en;

export const locale = (): string => LOCALES[current];

/** A page sentence as a key: runs of white space are one space, and the ends are trimmed. */
export const normalizeKey = (s: string): string => s.replace(/\s+/g, ' ').trim();
