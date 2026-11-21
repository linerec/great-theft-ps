// SPDX-License-Identifier: AGPL-3.0-only
//
// Getting the PSN account id. Sony is never contacted: fetch is replaced, so these tests show what is sent and what is
// kept, not that Sony accepts it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { accountIdFromUserId, extractLoginCode, fetchAccountId, PSN_LOGIN_URL, PsnAccountError } from '../src/console/psn-account.ts';

const CODE = 'v3.AbCdEf-1234_xyz';
const redirect = (query: string): string => `https://remoteplay.dl.playstation.net/remoteplay/redirect?${query}`;

interface Seen {
  url: string;
  method: string;
  authorization: string;
  contentType: string | null;
  body: string;
}

function stubFetch(replies: Array<{ status?: number; json?: unknown; throws?: boolean }>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  let i = 0;
  const f = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(url), method: init?.method ?? 'GET', authorization: headers.get('authorization') ?? '', contentType: headers.get('content-type'), body: String(init?.body ?? '') });
    const reply = replies[i++] ?? { status: 500 };
    if (reply.throws) throw new Error('offline');
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, seen };
}

describe('login code from what the user pasted', () => {
  it('takes the code from the redirect address and ignores the rest of it', () => {
    assert.equal(extractLoginCode(redirect(`code=${CODE}&cid=abc`)), CODE);
    assert.equal(extractLoginCode(`  ${redirect(`cid=abc&code=${CODE}`)}\n`), CODE);
    assert.equal(extractLoginCode(CODE), CODE, 'a bare code is accepted too');
  });

  it('refuses anything else with a message that says what to paste', () => {
    const bad: Array<[string, RegExp]> = [
      ['', /no login code/],
      ['https://example.com/redirect?code=abcd1234', /remoteplay\.dl\.playstation\.net/],
      ['http://remoteplay.dl.playstation.net/remoteplay/redirect?code=abcd1234', /remoteplay\.dl\.playstation\.net/],
      [redirect('cid=nothing'), /no login code/],
      [redirect('code='), /no login code/],
      [redirect('code=ab'), /no login code/],
      [redirect(`code=${'a'.repeat(201)}`), /no login code/],
      [redirect('code=bad code with spaces'), /no login code/],
      ['https://', /not a valid address/],
    ];
    for (const [input, message] of bad) assert.throws(() => extractLoginCode(input), (e: unknown) => e instanceof PsnAccountError && e.code === 'invalid-input' && message.test(e.message), input);
  });
});

describe('account id from the user id', () => {
  it('is the number as 8 little endian bytes in base64', () => {
    assert.equal(accountIdFromUserId('258'), 'AgEAAAAAAAA=');
    assert.equal(accountIdFromUserId('18446744073709551615'), '//////////8=');
    for (const bad of ['', 'abc', '-1', '18446744073709551616', '1'.repeat(21)]) assert.throws(() => accountIdFromUserId(bad), PsnAccountError, bad);
  });
});

describe('exchanging the code', () => {
  it('sends what the reference sends and returns only the account id', async () => {
    const { fetch, seen } = stubFetch([
      { json: { access_token: 'ACCESS/TOKEN+1', refresh_token: 'REFRESH-TOKEN', expires_in: 3599 } },
      { json: { user_id: '258', scopes: 'psn:clientapp', other: 'ignored' } },
    ]);
    const result = await fetchAccountId(CODE, { fetch });
    assert.equal(result, 'AgEAAAAAAAA=');
    assert.equal(typeof result, 'string', 'nothing but the id comes back');

    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.method, 'POST');
    assert.equal(seen[0]!.url, 'https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/token');
    assert.equal(seen[0]!.contentType, 'application/x-www-form-urlencoded');
    assert.equal(seen[0]!.body, `grant_type=authorization_code&code=${CODE}&redirect_uri=https://remoteplay.dl.playstation.net/remoteplay/redirect&`);
    assert.match(seen[0]!.authorization, /^Basic [A-Za-z0-9+/=]+$/);
    assert.equal(Buffer.from(seen[0]!.authorization.slice(6), 'base64').toString().split(':')[0], 'ba495a24-818c-472b-b12d-ff231c1b5745');
    assert.equal(seen[1]!.method, 'GET');
    assert.equal(seen[1]!.url, 'https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/token/ACCESS%2FTOKEN%2B1', 'the token is escaped into the path');
    assert.equal(seen[1]!.authorization, seen[0]!.authorization);
  });

  it('turns Sony refusing the code into a message, without passing Sony text or the code along', async () => {
    const { fetch } = stubFetch([{ status: 400, json: { error: 'invalid_grant', error_description: `the code ${CODE} is no good` } }]);
    await assert.rejects(fetchAccountId(CODE, { fetch }), (e: unknown) => {
      assert.ok(e instanceof PsnAccountError);
      assert.equal(e.code, 'login-rejected');
      assert.match(e.message, /HTTP 400, invalid_grant/);
      assert.ok(!e.message.includes(CODE), 'the code is not echoed');
      assert.ok(!e.message.includes('no good'), 'free text from the response is not echoed');
      return true;
    });
  });

  it('reports a network failure, a missing token and a missing user id distinctly', async () => {
    await assert.rejects(fetchAccountId(CODE, { fetch: stubFetch([{ throws: true }]).fetch }), (e: unknown) => e instanceof PsnAccountError && e.code === 'network');
    await assert.rejects(fetchAccountId(CODE, { fetch: stubFetch([{ json: {} }]).fetch }), (e: unknown) => e instanceof PsnAccountError && e.code === 'invalid-response' && /without a token/.test(e.message));
    await assert.rejects(
      fetchAccountId(CODE, { fetch: stubFetch([{ json: { access_token: 't' } }, { json: {} }]).fetch }),
      (e: unknown) => e instanceof PsnAccountError && e.code === 'invalid-response',
    );
    await assert.rejects(
      fetchAccountId(CODE, { fetch: stubFetch([{ json: { access_token: 't' } }, { throws: true }]).fetch }),
      (e: unknown) => e instanceof PsnAccountError && e.code === 'network',
    );
    await assert.rejects(
      fetchAccountId(CODE, { fetch: stubFetch([{ json: { access_token: 't' } }, { status: 401 }]).fetch }),
      (e: unknown) => e instanceof PsnAccountError && e.code === 'invalid-response' && /401/.test(e.message) && !e.message.includes('t\n'),
    );
  });

  it('the login address is Sony\'s, with the same parameters as the reference', () => {
    const url = new URL(PSN_LOGIN_URL);
    assert.equal(url.origin, 'https://auth.api.sonyentertainmentnetwork.com');
    assert.equal(url.pathname, '/2.0/oauth/authorize');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('scope'), 'psn:clientapp');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://remoteplay.dl.playstation.net/remoteplay/redirect');
    assert.equal(url.searchParams.get('prompt'), 'always');
    assert.ok(!PSN_LOGIN_URL.includes('mvaiZ'), 'the client secret is not part of an address the browser sees');
  });
});
