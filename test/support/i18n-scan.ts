// SPDX-License-Identifier: AGPL-3.0-only
//
// Finds the sentences the program says to people, in the code and in the page, the way test/i18n.test.ts and the people who
// write the Korean dictionary need them (see src/i18n/index.ts for the rules a sentence follows).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { normalizeKey } from '../../src/i18n/index.ts';

export interface Found {
  /** The English sentence: the key of the dictionary. */
  key: string;
  file: string;
  line: number;
}
export interface Problem {
  file: string;
  line: number;
  problem: string;
}

/** Inline markup that a sentence of the page may hold (what is inside a data-i18n element is put back as a whole). */
const INLINE = new Set(['b', 'i', 'em', 'strong', 'kbd', 'code', 'br', 'small', 'span', 'sub', 'sup', 'a']);

export function filesUnder(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, ext));
    else if (ext.test(name)) out.push(full);
  }
  return out;
}

const lineOf = (text: string, at: number): number => text.slice(0, at).split('\n').length;

/** The string literal that starts at `i` (a quote), its value and where it ends; null when it is not one or it holds `${`. */
export function readLiteral(src: string, i: number): { value: string; end: number } | { error: string } | null {
  const q = src[i];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  let value = '';
  let j = i + 1;
  while (j < src.length) {
    const c = src[j]!;
    if (c === q) return { value, end: j + 1 };
    if (q === '`' && c === '$' && src[j + 1] === '{') return { error: 'a sentence with ${}: use {name} and the values as the second argument' };
    if (c === '\n' && q !== '`') return { error: 'a string that is not closed on its line' };
    if (c === '\\') {
      const n = src[j + 1]!;
      if (n === 'n') value += '\n';
      else if (n === 't') value += '\t';
      else if (n === 'u' && src[j + 2] === '{') {
        const close = src.indexOf('}', j);
        value += String.fromCodePoint(parseInt(src.slice(j + 3, close), 16));
        j = close - 1;
      } else if (n === 'u') {
        value += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
        j += 4;
      } else if (n === 'x') {
        value += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16));
        j += 2;
      } else if (n === '\n') {
        // a line continuation: nothing
      } else value += n;
      j += 2;
      continue;
    }
    value += c;
    j++;
  }
  return { error: 'a string that is not closed' };
}

/** Sentences in the code: the first argument of t( (and tr(, the same in a language that was handed over) and N_(, and the second of translate(lang, . */
export function sentencesInCode(file: string): { found: Found[]; problems: Problem[] } {
  const src = readFileSync(file, 'utf8');
  const found: Found[] = [];
  const problems: Problem[] = [];
  const call = /(?<![\w.$#])(?:t|tr|N_)\(\s*|(?<![\w.$#])translate\(\s*[\w.$#]+\s*,\s*/g;
  for (let m = call.exec(src); m; m = call.exec(src)) {
    const at = m.index + m[0].length;
    const lit = readLiteral(src, at);
    if (!lit) continue; // not a literal: a sentence that was named elsewhere (N_) and is shown here
    if ('error' in lit) {
      problems.push({ file, line: lineOf(src, at), problem: lit.error });
      continue;
    }
    const after = src.slice(lit.end).match(/^\s*(.)/)?.[1];
    if (after !== ',' && after !== ')') {
      problems.push({ file, line: lineOf(src, at), problem: 'a sentence joined from pieces: write it as one string' });
      continue;
    }
    found.push({ key: lit.value, file, line: lineOf(src, at) });
  }
  return { found, problems };
}

const TAG = /<([a-zA-Z][\w-]*)((?:\s+[^\s=>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
const attrValue = (attrs: string, name: string): string | null => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return m ? (m[1] ?? m[2] ?? '') : null;
};
const decode = (s: string): string => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Sentences in the page: the content of data-i18n elements, and the attributes that data-i18n-attr lists. */
export function sentencesInPage(file: string): { found: Found[]; problems: Problem[] } {
  const src = readFileSync(file, 'utf8');
  const found: Found[] = [];
  const problems: Problem[] = [];
  for (let m = TAG.exec(src); m; m = TAG.exec(src)) {
    const [whole, name = '', attrs = ''] = m;
    const line = lineOf(src, m.index);
    const wantsAttrs = attrValue(attrs, 'data-i18n-attr');
    for (const a of (wantsAttrs ?? '').split(/\s+/).filter(Boolean)) {
      const v = attrValue(attrs, a);
      if (v === null || !v.trim()) problems.push({ file, line, problem: `data-i18n-attr lists ${a}, which <${name}> does not have (or it is empty)` });
      else found.push({ key: normalizeKey(decode(v)), file, line });
    }
    if (!/(?:^|\s)data-i18n(?:\s|=|$)/.test(attrs)) continue;
    // The content runs to the matching close tag of the same name.
    const open = new RegExp(`<${name}(?=[\\s>/])`, 'g');
    const close = new RegExp(`</${name}\\s*>`, 'g');
    const from = m.index + whole.length;
    let depth = 1;
    let cursor = from;
    let end = -1;
    while (depth > 0) {
      open.lastIndex = cursor;
      close.lastIndex = cursor;
      const o = open.exec(src);
      const c = close.exec(src);
      if (!c) break;
      if (o && o.index < c.index) {
        depth++;
        cursor = o.index + 1;
      } else {
        depth--;
        cursor = c.index + c[0].length;
        if (depth === 0) end = c.index;
      }
    }
    if (end < 0) {
      problems.push({ file, line, problem: `<${name} data-i18n> is not closed` });
      continue;
    }
    const inner = src.slice(from, end);
    const key = normalizeKey(inner);
    if (!key) {
      problems.push({ file, line, problem: 'a data-i18n element with nothing in it' });
      continue;
    }
    for (const t of inner.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)) {
      if (t[0].startsWith('</')) continue;
      if (!INLINE.has(t[1]!.toLowerCase())) problems.push({ file, line, problem: `<${t[1]}> inside a data-i18n element: only inline markup (${[...INLINE].join(', ')}) can be put back as a whole` });
      if (/\sid\s*=/.test(t[2]!)) problems.push({ file, line, problem: 'an id inside a data-i18n element is lost when the content is put back' });
      if (/\/>$/.test(t[0]) && t[1]!.toLowerCase() === 'br') problems.push({ file, line, problem: 'write <br> without the slash (the page reads the content back from the browser, which does)' });
    }
    if (/&(?!amp;|lt;|gt;|nbsp;)\w+;/.test(inner)) problems.push({ file, line, problem: 'a named entity other than &amp; &lt; &gt; &nbsp;: write the character itself' });
    found.push({ key, file, line });
  }
  return { found, problems };
}

/** Everything the program says, with where. */
export function allSentences(root: string): { found: Found[]; problems: Problem[] } {
  const found: Found[] = [];
  const problems: Problem[] = [];
  const code = [...filesUnder(path.join(root, 'web'), /\.ts$/), ...filesUnder(path.join(root, 'src'), /\.ts$/)].filter((f) => !/[\\/]src[\\/]i18n[\\/]/.test(f));
  for (const f of code) {
    const r = sentencesInCode(f);
    found.push(...r.found);
    problems.push(...r.problems);
  }
  const page = sentencesInPage(path.join(root, 'web', 'index.html'));
  found.push(...page.found);
  problems.push(...page.problems);
  return { found, problems };
}
