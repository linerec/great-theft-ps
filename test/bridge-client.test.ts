// SPDX-License-Identifier: AGPL-3.0-only
//
// The page's side of the bridge connection that speaks to a person: which language it tells the bridge it reads, and the words
// it gives for why a connection closed. The socket is a stand-in; nothing connects anywhere.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { setLang } from '../src/i18n/index.ts';
import { BridgeClient } from '../web/bridge-client.ts';

class FakeSocket {
  static last: FakeSocket;
  static OPEN = 1;
  readyState = 0;
  binaryType = '';
  sent: string[] = [];
  onopen: () => void = () => {};
  onmessage: (e: { data: string }) => void = () => {};
  onclose: (e: { code: number }) => void = () => {};
  onerror: () => void = () => {};
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
}
(globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;

afterEach(() => setLang('en'));

describe('the page tells the bridge which language it reads', () => {
  it('in its first message, as it is when it connects', () => {
    const client = new BridgeClient();
    client.connect('ws://bridge/ws');
    FakeSocket.last.onopen();
    assert.equal(JSON.parse(FakeSocket.last.sent[0]!).lang, 'en');
    assert.equal(JSON.parse(FakeSocket.last.sent[0]!).type, 'hello');

    setLang('ko');
    client.connect('ws://bridge/ws', 'secret', 'aabbccddeeff');
    FakeSocket.last.onopen();
    const hello = JSON.parse(FakeSocket.last.sent[0]!);
    assert.equal(hello.lang, 'ko');
    assert.equal(hello.token, 'secret', 'the rest of the message is as it was');
    assert.equal(hello.console, 'aabbccddeeff');
  });
});

describe('why a connection closed, in the words of the page', () => {
  const closedWith = (code: number, serverSaid?: string): string => {
    const client = new BridgeClient();
    client.connect('ws://bridge/ws');
    if (serverSaid !== undefined) FakeSocket.last.onmessage({ data: JSON.stringify({ type: 'error', code: 'x', message: serverSaid }) });
    FakeSocket.last.onclose({ code });
    assert.equal(client.state, 'closed');
    return client.detail;
  };

  it('asks for a login, in English or in Korean', () => {
    assert.match(closedWith(4401), /^You need to log in\. Reloading the page opens the login window\./);
    setLang('ko');
    assert.match(closedWith(4401), /^로그인이 필요합니다\. 페이지를 새로 고치면 로그인 창이 열립니다\./);
  });

  it('says the time has ended unless the bridge said something itself, which is kept as it came', () => {
    assert.equal(closedWith(4403), 'Your time for today has ended');
    setLang('ko');
    assert.equal(closedWith(4403), '오늘 사용할 수 있는 시간이 끝났습니다');
    assert.equal(closedWith(4403, '오늘 사용할 수 있는 시간을 모두 썼습니다'), '오늘 사용할 수 있는 시간을 모두 썼습니다');
  });

  it('gives what the bridge said for any other close', () => {
    assert.equal(closedWith(1011, 'No PS5 is registered. Register a console first.'), 'No PS5 is registered. Register a console first.');
    assert.equal(closedWith(1006), 'closed (1006)');
  });
});
