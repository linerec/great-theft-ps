// SPDX-License-Identifier: AGPL-3.0-only
//
// The page's language (English until someone chooses Korean): which one is kept in this browser, and the words that are in
// index.html put into it. Imported first by app.ts, so that every other part of the page finds the language already set when it
// draws its own words (they use t() from src/i18n/index.ts).
//
// In index.html the words are English, as the page is when this has not run, and the element says that it has Korean:
//   <p data-i18n>Press <b>Esc</b> to let go.</p>                   its content (a little inline markup is fine) is the sentence
//   <button data-i18n-attr="title aria-label" title="Close" ...>   the listed attributes are sentences
// What is inside a data-i18n element is put back as a whole, so it holds text and inline markup only: no buttons, no inputs, no
// ids that code looks up. Write it as innerHTML comes back (double quotes, <br> without a slash, no named entities).

import { DEFAULT_LANG, getLang, isLang, LANG_NAMES, LANGS, normalizeKey, onLang, setLang, translate, type Lang } from '../src/i18n/index.ts';
import { save, saved } from './ui.ts';

const KEY = 'gtp.lang';

/** What the address asks for (?lang=ko, which is then kept), else what was chosen before, else English. */
function startLang(): Lang {
  const asked = new URLSearchParams(location.search).get('lang');
  if (isLang(asked)) {
    save(KEY, asked);
    return asked;
  }
  const kept = saved(KEY);
  return isLang(kept) ? kept : DEFAULT_LANG;
}

/** What the page said before any translation, to give back when the language is English again. */
const original = new WeakMap<Element, { html: string | null; attrs: Map<string, string> }>();

/** Puts the language in use into everything under `root` that says it has Korean. */
export function applyDom(root: ParentNode = document): void {
  const lang = getLang();
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n], [data-i18n-attr]')) {
    let o = original.get(el);
    if (!o) {
      o = { html: el.hasAttribute('data-i18n') ? el.innerHTML : null, attrs: new Map() };
      for (const a of (el.getAttribute('data-i18n-attr') ?? '').split(/\s+/).filter(Boolean)) o.attrs.set(a, el.getAttribute(a) ?? '');
      original.set(el, o);
    }
    if (o.html !== null) el.innerHTML = lang === 'en' ? o.html : translate(lang, normalizeKey(o.html));
    for (const [a, en] of o.attrs) el.setAttribute(a, translate(lang, normalizeKey(en)));
  }
}

const other = (lang: Lang): Lang => LANGS[(LANGS.indexOf(lang) + 1) % LANGS.length]!;

/** Buttons that say which language they change to (data-lang-toggle), and the ones that pick one (data-lang-choice). */
function paintControls(): void {
  const lang = getLang();
  for (const b of document.querySelectorAll<HTMLElement>('[data-lang-toggle]')) {
    b.textContent = LANG_NAMES[other(lang)];
    b.setAttribute('lang', other(lang));
  }
  for (const b of document.querySelectorAll<HTMLElement>('[data-lang-choice]')) {
    const own = b.dataset.langChoice;
    if (isLang(own)) {
      b.textContent = LANG_NAMES[own];
      b.setAttribute('lang', own);
    }
    b.setAttribute('aria-pressed', String(own === lang));
  }
}

/** The person's choice: kept, and put on the page at once. */
export function chooseLang(lang: Lang): void {
  save(KEY, lang);
  setLang(lang);
}

setLang(startLang());
// First among the listeners, so that whoever repaints after it finds the page's own words already in the new language.
onLang((lang) => {
  document.documentElement.lang = lang;
  applyDom();
  paintControls();
  document.dispatchEvent(new CustomEvent('gtp:lang', { detail: lang }));
});
document.documentElement.lang = getLang();
applyDom();
paintControls();
document.documentElement.removeAttribute('data-lang-pending');

document.addEventListener('click', (e) => {
  const target = e.target instanceof Element ? e.target : null;
  const toggle = target?.closest<HTMLElement>('[data-lang-toggle]');
  if (toggle) return chooseLang(other(getLang()));
  const choice = target?.closest<HTMLElement>('[data-lang-choice]');
  if (choice && isLang(choice.dataset.langChoice)) chooseLang(choice.dataset.langChoice);
});
