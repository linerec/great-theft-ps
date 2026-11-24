// SPDX-License-Identifier: AGPL-3.0-only
//
// Live reload for the person developing the page: save a file under web/ or src/ and the open page reloads itself.
// This project's own. Only for `npm run dev` (--live); a server never turns it on.
//
// The page opens an event stream (GET /__dev/events); the bridge watches the folders and sends "reload" down every open
// stream a moment after the last change (an editor saves in several steps, so changes are gathered for 150 ms first).
// The page does not reload while a stream from the console is running (see web/dev-reload.ts): it would end the game.

import { watch, type FSWatcher } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface DevReloadOptions {
  /** Folders to watch (recursively). */
  dirs: string[];
  /** Replaced by tests. */
  watchFn?: (dir: string, onChange: () => void) => { close(): void };
  debounceMs?: number;
}

const realWatch = (dir: string, onChange: () => void): FSWatcher => watch(dir, { recursive: true }, (_event, name) => {
  // Editors leave swap and backup files around: only real source files count.
  if (!name || /\.(ts|mjs|js|css|html|json)$/.test(String(name))) onChange();
});

export class DevReload {
  #clients = new Set<ServerResponse>();
  #watchers: Array<{ close(): void }> = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #debounceMs: number;

  constructor(opts: DevReloadOptions) {
    this.#debounceMs = opts.debounceMs ?? 150;
    const make = opts.watchFn ?? realWatch;
    for (const dir of opts.dirs) {
      try {
        this.#watchers.push(make(dir, () => this.changed()));
      } catch {
        /* a folder that cannot be watched (some file systems) just never triggers a reload */
      }
    }
  }

  /** How many pages are listening. */
  get listeners(): number {
    return this.#clients.size;
  }

  /** Something changed: tell the pages once things have been quiet for a moment. */
  changed(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      for (const res of this.#clients) res.write('data: reload\n\n');
    }, this.#debounceMs);
  }

  /** Answer GET /__dev/events. */
  handle(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    this.#clients.add(res);
    req.on('close', () => this.#clients.delete(res));
  }

  close(): void {
    if (this.#timer) clearTimeout(this.#timer);
    for (const w of this.#watchers) w.close();
    for (const res of this.#clients) res.end();
    this.#clients.clear();
  }
}
