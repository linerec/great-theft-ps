// SPDX-License-Identifier: AGPL-3.0-only
//
// Where the ratings of the mouse-feel study are kept (src/engine/feel-study.ts): one file of JSON lines next to the other
// state of the bridge, readable by this user only. They are small, each is checked again when read, and a person's own can be
// taken back (a mistaken score), so a file that is edited by hand or damaged loses at most the lines that are wrong.
//
// A rating belongs to a person (the account name, or "local" when nobody logs in). The page keeps its own copy and sends what
// the server does not have yet, so a rating delivered twice is recognised by its id and kept once.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseRating, type FeelRating } from '../engine/feel-study.ts';

export interface StoredRating {
  user: string;
  receivedAt: string;
  rating: FeelRating;
}

/** Nobody needs more than this many, and a file that grows without end is a way to fill the disk of a server on the internet. */
export const MAX_PER_USER = 2000;
export const MAX_TOTAL = 8000;

export type AddResult = 'stored' | 'duplicate' | 'full';

export class StudyStore {
  readonly file: string;
  #items: StoredRating[] = [];
  #now: () => number;

  constructor(dir: string, now: () => number = Date.now) {
    this.file = path.join(dir, 'feel-ratings.jsonl');
    this.#now = now;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line) as { user?: unknown; receivedAt?: unknown; rating?: unknown };
          const parsed = parseRating(raw.rating, this.#now());
          if (typeof raw.user === 'string' && raw.user && typeof raw.receivedAt === 'string' && parsed.ok && !this.#has(raw.user, parsed.rating.id)) this.#items.push({ user: raw.user, receivedAt: raw.receivedAt, rating: parsed.rating });
        } catch {
          // a damaged line is left out; the others are kept
        }
      }
    }
  }

  #has(user: string, id: string): boolean {
    return this.#items.some((s) => s.user === user && s.rating.id === id);
  }

  /** Keeps a rating that has already been checked with parseRating. */
  add(user: string, rating: FeelRating): AddResult {
    if (this.#has(user, rating.id)) return 'duplicate';
    if (this.#items.length >= MAX_TOTAL || this.#items.filter((s) => s.user === user).length >= MAX_PER_USER) return 'full';
    const item: StoredRating = { user, receivedAt: new Date(this.#now()).toISOString(), rating };
    appendFileSync(this.file, `${JSON.stringify(item)}\n`, { mode: 0o600 });
    this.#items.push(item);
    return 'stored';
  }

  /** One person's ratings, oldest first; without a name everybody's. */
  list(user?: string): StoredRating[] {
    return this.#items.filter((s) => user === undefined || s.user === user).sort((a, b) => Date.parse(a.rating.at) - Date.parse(b.rating.at));
  }

  /** Takes back one of a person's own ratings. */
  remove(user: string, id: string): boolean {
    const at = this.#items.findIndex((s) => s.user === user && s.rating.id === id);
    if (at < 0) return false;
    this.#items.splice(at, 1);
    // Written whole and moved into place, so that a stop in the middle leaves the old file or the new one, not half of either.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, this.#items.map((s) => `${JSON.stringify(s)}\n`).join(''), { mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // a file system without modes
    }
    return true;
  }
}
