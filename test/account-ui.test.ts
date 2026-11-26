// SPDX-License-Identifier: AGPL-3.0-only
//
// The login window, the person's name and time left, in both languages. The module draws on the page the moment it is loaded, so
// each test gives it a page made of stand-ins (elements that remember what was written to them) and a bridge that answers what
// is asked. What matters here is what a person reads, and that it is read again in the new language when the language changes.

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { setLang } from '../src/i18n/index.ts';

type Listener = (event: unknown) => void;
interface Page {
  els: Map<string, Record<string, any>>;
  /** What the page listens for, by event name (the document and the window together). */
  heard: Map<string, Listener[]>;
}

const globals = globalThis as unknown as Record<string, unknown>;
const had = new Map<string, unknown>();

const listen = (heard: Map<string, Listener[]>, type: string, f: Listener): void => void (heard.get(type) ?? heard.set(type, []).get(type)!).push(f);

/** An element that keeps what is written to it, and what it is listening for, and does nothing else. */
function element(): Record<string, any> {
  const heard = new Map<string, Listener[]>();
  const store: Record<string, any> = { open: false, hidden: false, textContent: '', className: '', value: '', dataset: {}, style: {}, heard };
  store.addEventListener = (type: string, f: Listener) => listen(heard, type, f);
  store.showModal = () => void (store.open = true);
  store.close = () => void (store.open = false);
  return new Proxy(store, { get: (o, k) => (k in o ? o[k as string] : () => undefined), set: (o, k, v) => ((o[k as string] = v), true) });
}

/** Loads the module on a page where the bridge answers `/api/me` with this, and the address bar says `hash`. */
async function open(tag: string, me: { status: number; data: unknown }, hash = ''): Promise<Page> {
  const els = new Map<string, Record<string, any>>();
  const heard = new Map<string, Listener[]>();
  const stand: Record<string, unknown> = {
    document: { getElementById: (id: string) => els.get(id) ?? els.set(id, element()).get(id), addEventListener: (type: string, f: Listener) => listen(heard, type, f) },
    window: {
      fetch: async () => ({ status: me.status, json: async () => me.data }),
      addEventListener: (type: string, f: Listener) => listen(heard, type, f),
    },
    location: { hash, search: '', pathname: '/', origin: 'http://localhost' },
    // The calls the module makes itself: an invitation that is no longer good, and a server that is not there for anything else.
    fetch: async (url: string) => {
      if (url === '/api/invite-info') return { status: 404, json: async () => ({}) };
      throw new TypeError('no server');
    },
    setInterval: () => 0,
  };
  for (const [name, value] of Object.entries(stand)) {
    if (!had.has(name)) had.set(name, globals[name]);
    globals[name] = value;
  }
  await import(`../web/account-ui.ts?${tag}`);
  await new Promise((resolve) => setTimeout(resolve, 5)); // the module asks who is logged in, and that answer comes back
  return { els, heard };
}

const say = (page: Page, event: string, detail: unknown): void => page.heard.get(event)!.forEach((f) => f({ detail, preventDefault() {} }));
const text = (page: Page, id: string): string => page.els.get(id)!.textContent;

afterEach(() => setLang('en'));
after(() => {
  for (const [name, value] of had) {
    if (value === undefined) delete globals[name];
    else globals[name] = value;
  }
});

describe('a person who is logged in', () => {
  let page: Page;
  before(async () => {
    page = await open('member', { status: 200, data: { accounts: true, user: { name: 'Mia', role: 'member', dailyMinutes: 90, disabled: false, active: true, usedSecondsToday: 0 }, remainingSeconds: null } });
  });

  it('sees their limit in the words of the page, and again in Korean when the language changes', () => {
    assert.equal(text(page, 'acctName'), 'Mia');
    assert.equal(text(page, 'acctRole'), '90 min per day');
    assert.equal(text(page, 'acctTime'), '90 min per day');
    setLang('ko');
    assert.equal(text(page, 'acctRole'), '하루 90분');
    assert.equal(text(page, 'acctTime'), '하루 90분');
    setLang('en');
    assert.equal(text(page, 'acctRole'), '90 min per day');
  });

  it('sees the time left, and it changes language with the page', () => {
    say(page, 'gtp:quota', { remainingSeconds: 290 });
    assert.equal(text(page, 'acctTime'), 'Time left 4:50');
    assert.equal(page.els.get('acctTime')!.className, 'chip wait');
    setLang('ko');
    assert.equal(text(page, 'acctTime'), '남은 시간 4:50');
    assert.equal(text(page, 'acctQuotaText'), '4:50');
  });
});

describe('the owner', () => {
  it('is told that nothing limits their time, in either language', async () => {
    const page = await open('owner', { status: 200, data: { accounts: true, user: { name: 'Owen', role: 'owner', dailyMinutes: null, disabled: false, active: true, usedSecondsToday: 0 }, remainingSeconds: null } });
    assert.equal(text(page, 'acctRole'), 'Owner · no time limit');
    assert.equal(page.els.get('acctUsers')!.hidden, false);
    setLang('ko');
    assert.equal(text(page, 'acctRole'), '주인 · 시간 제한 없음');
  });
});

describe('the login window', () => {
  let page: Page;
  before(async () => {
    page = await open('login', { status: 401, data: { accounts: true, login: true, needsSetup: true } });
  });

  it('asks for a name and password, and says what to do on a server that has nobody yet', () => {
    assert.equal(page.els.get('loginDialog')!.open, true);
    assert.equal(text(page, 'loginTitle'), 'Log in');
    assert.equal(text(page, 'loginGo'), 'Log in');
    assert.equal(text(page, 'loginNote'), 'Nobody is registered yet. Open the invitation link printed when the server was first started and set the owner password.');
    setLang('ko');
    assert.equal(text(page, 'loginTitle'), '로그인');
    assert.equal(text(page, 'loginGo'), '로그인');
    assert.equal(text(page, 'loginNote'), '아직 아무도 등록되지 않았습니다. 서버를 처음 켤 때 출력된 초대 링크로 들어와 주인 비밀번호를 정하세요.');
  });

  it('says what went wrong in the language in use, and says it again when the language changes', async () => {
    page.els.get('loginName')!.value = 'Mia';
    // There is no server to answer the login.
    await Promise.all(page.els.get('loginForm')!.heard.get('submit').map((f: Listener) => f({ preventDefault() {} })));
    assert.equal(text(page, 'loginMsg'), 'Could not connect to the server.');
    assert.equal(page.els.get('loginMsg')!.hidden, false);
    setLang('ko');
    assert.equal(text(page, 'loginMsg'), '서버에 연결하지 못했습니다.');
    assert.equal(page.els.get('loginMsg')!.dataset.kind, 'err');
  });
});

describe('an invitation link', () => {
  it('asks for a new password in the words of the language in use, also for a link that no longer works', async () => {
    // The invitation is read from the address bar when the module loads; the bridge says it is not (or no longer) good.
    const page = await open('invite', { status: 401, data: { accounts: true, login: true } }, '#invite=abc');
    assert.equal(text(page, 'loginTitle'), 'Choose a password');
    assert.equal(text(page, 'loginGo'), 'Save password and start');
    assert.equal(text(page, 'loginNote'), 'This invitation link can no longer be used. A link works once, within 48 hours. Ask for a new one.');
    assert.equal(page.els.get('loginGo')!.disabled, true);
    setLang('ko');
    assert.equal(text(page, 'loginTitle'), '비밀번호 정하기');
    assert.equal(text(page, 'loginGo'), '비밀번호 저장하고 시작');
    assert.equal(text(page, 'loginNote'), '이 초대 링크는 더 이상 쓸 수 없습니다. 링크는 한 번만, 48시간 안에 쓸 수 있습니다. 새 링크를 받으세요.');
  });
});
