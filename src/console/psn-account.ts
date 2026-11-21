// SPDX-License-Identifier: AGPL-3.0-only
//
// Getting the numeric PSN account id that a console asks for during registration.
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): scripts/psn-account-id.py and
// gui/src/psnaccountid.cpp (commit 43728af). The flow is the one those use: the user logs in on Sony's own login page,
// which redirects to a page whose address contains a one-time code; the code is exchanged at Sony's token endpoint, and
// the account id is read from the token info.
//
// READ THIS BEFORE CHANGING IT. The exchange is authenticated with the client id and client secret of Sony's own
// Remote Play application, values that chiaki-ng publishes. That is what makes this a grey area: an unofficial client
// presents an official application's credentials. It is used here only because the project owner asked for it, only for
// the owner's own account, and with as little handling as possible:
//  - the secret is used on the server side only and never sent to a browser,
//  - the access token and the refresh token that come back are never stored, logged or returned: only the account id is
//    read, and everything else is dropped when the function returns,
//  - nothing here logs the code, the tokens or the account id.
//
// STATUS: checked against a stubbed fetch in tests only. It has not been run against Sony's servers.

const CLIENT_ID = 'ba495a24-818c-472b-b12d-ff231c1b5745';
const CLIENT_SECRET = 'mvaiZkRsAsI1IBkY';

export const REDIRECT_URI = 'https://remoteplay.dl.playstation.net/remoteplay/redirect';
const REDIRECT_HOST = 'remoteplay.dl.playstation.net';
const TOKEN_URL = 'https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/token';

/** Where the user logs in. Sony's page, in the user's own browser. */
export const PSN_LOGIN_URL =
  `https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/authorize?service_entity=urn:service-entity:psn&response_type=code&client_id=${CLIENT_ID}` +
  `&redirect_uri=${REDIRECT_URI}&scope=psn:clientapp&request_locale=en_US&ui=pr&service_logo=ps&layout_type=popup&smcid=remoteplay&prompt=always&PlatformPrivacyWs1=minimal&`;

export type PsnAccountErrorCode = 'invalid-input' | 'login-rejected' | 'network' | 'invalid-response';

export class PsnAccountError extends Error {
  code: PsnAccountErrorCode;
  constructor(code: PsnAccountErrorCode, message: string) {
    super(message);
    this.name = 'PsnAccountError';
    this.code = code;
  }
}

/**
 * The login code from what the user pasted: the whole address of the page Sony redirected to (preferred), or the bare
 * code. Only the `code` parameter is used; the rest of the address is ignored.
 */
export function extractLoginCode(input: string): string {
  const text = input.trim();
  let code: string | null;
  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new PsnAccountError('invalid-input', 'That is not a valid address');
    }
    if (url.protocol !== 'https:' || url.hostname !== REDIRECT_HOST) {
      throw new PsnAccountError('invalid-input', `Paste the address of the page Sony showed after the login (it starts with https://${REDIRECT_HOST}/)`);
    }
    code = url.searchParams.get('code');
  } else {
    code = text;
  }
  if (!code || !/^[A-Za-z0-9._~+-]{4,200}$/.test(code)) {
    throw new PsnAccountError('invalid-input', 'The address has no login code. Log in again and copy the whole address of the page that says "redirect"');
  }
  return code;
}

/** Decimal user id from Sony as the 8 bytes (little endian) base64 that the registration expects. */
export function accountIdFromUserId(userId: string): string {
  if (!/^\d{1,20}$/.test(userId)) throw new PsnAccountError('invalid-response', 'Sony returned an account id in an unexpected form');
  const n = BigInt(userId);
  if (n >= 1n << 64n) throw new PsnAccountError('invalid-response', 'Sony returned an account id that is too large');
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b.toString('base64');
}

export interface FetchAccountOptions {
  /** Replaced by tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Exchange the one-time code for the account id (base64 of its 8 bytes). Returns nothing else, on purpose. */
export async function fetchAccountId(code: string, opts: FetchAccountOptions = {}): Promise<string> {
  const doFetch = opts.fetch ?? fetch;
  const authorization = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
  const timeout = opts.timeoutMs ?? 10_000;

  let tokenResponse: Response;
  try {
    tokenResponse = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${REDIRECT_URI}&`,
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new PsnAccountError('network', 'Could not reach Sony. Check the internet connection and try again');
  }
  if (!tokenResponse.ok) {
    // Only Sony's short error name is passed on, never the body as a whole.
    const name = await tokenResponse.json().then((j: { error?: unknown }) => (typeof j.error === 'string' && /^[\w .-]{1,40}$/.test(j.error) ? j.error : '')).catch(() => '');
    throw new PsnAccountError('login-rejected', `Sony did not accept the login code (HTTP ${tokenResponse.status}${name ? `, ${name}` : ''}). The code works once and expires quickly: log in again`);
  }
  const accessToken = await tokenResponse.json().then((j: { access_token?: unknown }) => (typeof j.access_token === 'string' ? j.access_token : '')).catch(() => '');
  if (!accessToken) throw new PsnAccountError('invalid-response', 'Sony answered without a token');

  let infoResponse: Response;
  try {
    infoResponse = await doFetch(`${TOKEN_URL}/${encodeURIComponent(accessToken)}`, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(timeout) });
  } catch {
    throw new PsnAccountError('network', 'Could not reach Sony. Check the internet connection and try again');
  }
  if (!infoResponse.ok) throw new PsnAccountError('invalid-response', `Sony did not give the account information (HTTP ${infoResponse.status})`);
  const userId = await infoResponse.json().then((j: { user_id?: unknown }) => (typeof j.user_id === 'string' ? j.user_id : '')).catch(() => '');
  return accountIdFromUserId(userId);
}
