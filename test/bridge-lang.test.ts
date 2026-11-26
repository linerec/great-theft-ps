// SPDX-License-Identifier: AGPL-3.0-only
//
// One bridge serves many people at once, each reading their own language, so the words it says to a person are chosen per
// connection: the page names its language in the first message, the bridge checks it (anything that is not a known language
// is English) and uses it for the link and for the time limit. What the PS5 link itself says in each language is in
// ps5-link.test.ts; here it is the bridge's own part.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AccountStore } from '../src/bridge/accounts.ts';
import type { LinkHandlers, LinkStartOptions } from '../src/bridge/console-link.ts';
import type { QualityRequest } from '../src/bridge/quality.ts';
import { startBridge, type Bridge } from '../src/bridge/server.ts';
import { ConsoleStore } from '../src/console/store.ts';
import { FakeLink } from './support/fake-link.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];
const bridges: Bridge[] = [];
after(async () => {
  for (const b of bridges) await b.close();
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** A console link that remembers what it was started with. */
class RecordingLink extends FakeLink {
  static started: Array<LinkStartOptions | undefined> = [];
  async start(handlers: LinkHandlers, quality: QualityRequest, options?: LinkStartOptions): Promise<void> {
    RecordingLink.started.push(options);
    return super.start(handlers, quality);
  }
}

const until = async (f: () => boolean, ms = 6000): Promise<void> => {
  const end = Date.now() + ms;
  while (!f()) {
    assert.ok(Date.now() < end, 'timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** A page that connects: `extra` goes into its hello message (and `cookie` is its login). */
function connect(port: number, extra: Record<string, unknown>, cookie?: string): { ws: WebSocket; messages: any[]; closed: Promise<number> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, cookie ? ({ headers: { Cookie: `gtp_session=${cookie}` } } as never) : undefined);
  const messages: any[] = [];
  const closed = new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)));
  ws.onmessage = (e) => typeof e.data === 'string' && messages.push(JSON.parse(e.data));
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', client: 'test', ...extra }));
  return { ws, messages, closed };
}

describe('the language a connection is served in', () => {
  it('goes to the link when the page names a known language, and is English for everything else', async () => {
    const cases: Array<[string, unknown, 'en' | 'ko']> = [
      ['says nothing', undefined, 'en'],
      ['English', 'en', 'en'],
      ['Korean', 'ko', 'ko'],
      ['a language that is not offered', 'fr', 'en'],
      ['the right letters in capitals', 'KO', 'en'],
      ['a number', 5, 'en'],
      ['null', null, 'en'],
      ['a list', ['ko'], 'en'],
      ['an object', { ko: true }, 'en'],
    ];
    for (const [what, sent, expected] of cases) {
      RecordingLink.started = [];
      const dir = mkdtempSync(path.join(tmpdir(), 'gtp-lang-'));
      dirs.push(dir);
      const bridge = await startBridge({ host: '127.0.0.1', port: 0, root, store: new ConsoleStore(path.join(dir, 'consoles.json')), createLink: () => new RecordingLink() });
      bridges.push(bridge);
      const page = connect(bridge.port, sent === undefined ? {} : { lang: sent });
      await until(() => page.messages.some((m) => m.type === 'ready'));
      assert.equal(RecordingLink.started[0]?.lang, expected, `a page that ${what === 'says nothing' ? what : `sends ${what}`}`);
      page.ws.close();
      await page.closed;
    }
  });
});

describe('the time limit, said in the language of the person it is said to', () => {
  async function rig(): Promise<{ bridge: Bridge; accounts: AccountStore; cookie: string }> {
    const dir = mkdtempSync(path.join(tmpdir(), 'gtp-lang-'));
    dirs.push(dir);
    const accounts = new AccountStore({ dir: path.join(dir, 'accounts'), scryptCost: { n: 1024, r: 8, p: 1 } });
    await accounts.acceptInvite(accounts.invite('kid', { dailyMinutes: 1 }).code, 'kid-password-1');
    const bridge = await startBridge({ host: '127.0.0.1', port: 0, root, accounts, store: new ConsoleStore(path.join(dir, 'consoles.json')), createLink: () => new FakeLink() });
    bridges.push(bridge);
    const login = await fetch(`http://127.0.0.1:${bridge.port}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'kid', password: 'kid-password-1' }) });
    assert.equal(login.status, 200);
    return { bridge, accounts, cookie: /gtp_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1]! };
  }
  const said = (messages: any[], code: string): string | undefined => messages.find((m) => m.type === 'error' && m.code === code)?.message;

  it('says there is no time left today before it starts anything', async () => {
    for (const [sent, expected] of [
      [undefined, 'You have used all your time for today'],
      ['en', 'You have used all your time for today'],
      ['ko', '오늘 사용할 수 있는 시간을 모두 썼습니다'],
      ['fr', 'You have used all your time for today'],
      [7, 'You have used all your time for today'],
    ] as const) {
      const r = await rig();
      r.accounts.addUsage('kid', 60);
      const page = connect(r.bridge.port, sent === undefined ? {} : { lang: sent }, r.cookie);
      assert.equal(await page.closed, 4403);
      assert.equal(said(page.messages, 'quota-exhausted'), expected, `lang ${JSON.stringify(sent)}`);
    }
  });

  it('says the time has ended when it ends a stream', async () => {
    for (const [sent, expected] of [
      [undefined, 'Your time for today has ended'],
      ['ko', '오늘 사용할 수 있는 시간이 끝났습니다'],
      ['xx', 'Your time for today has ended'],
    ] as const) {
      const r = await rig();
      r.accounts.addUsage('kid', 59); // one second left
      const page = connect(r.bridge.port, sent === undefined ? {} : { lang: sent }, r.cookie);
      assert.equal(await page.closed, 4403);
      assert.equal(said(page.messages, 'quota-ended'), expected, `lang ${JSON.stringify(sent)}`);
    }
  });
});
