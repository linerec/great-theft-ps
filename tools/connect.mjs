// SPDX-License-Identifier: AGPL-3.0-only
//
// Walk a connection to a registered console step by step and say how far it gets. For checking the protocol port
// against real hardware. It sends no controller input and it closes the connection at the end.
//
//   npm run connect [-- --mac <id>] [--host <ip>] [--hold <seconds>]
//
// Steps: is the console there and on (a direct question to its address) -> session request -> control connection ->
// session id. Nothing secret is printed: no keys, no device id, no session id (only its length).

import { discover } from '../src/console/discovery.ts';
import { Ctrl, CtrlError, CTRL_MESSAGE } from '../src/console/ctrl.ts';
import { requestSession, SessionError } from '../src/console/session.ts';
import { ConsoleStore, defaultStorePath } from '../src/console/store.ts';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const step = (n, text) => console.log(`\n[${n}] ${text}`);
const ok = (text) => console.log(`    ok    ${text}`);
const bad = (text) => console.log(`    FAIL  ${text}`);

const store = new ConsoleStore(defaultStorePath());
const list = store.list();
const chosen = opt('mac') ? list.find((c) => c.mac === opt('mac').toLowerCase()) : list[0];
if (!chosen) {
  console.error(list.length ? 'That console is not registered on this computer.' : 'No console is registered on this computer. Register one first (the PS5 page, or npm run register).');
  process.exit(1);
}
const record = store.get(chosen.mac);
const host = opt('host') ?? record.host;
const holdSeconds = Number(opt('hold') ?? 3);
console.log(`Console: ${chosen.nickname || '(no name)'} (${chosen.target}) at ${host}`);

let exitCode = 1;
let ctrl;
try {
  step(1, 'Is the console there, and is it on?');
  const found = (await discover({ hosts: [host], timeoutMs: 2500 })).hosts[0];
  if (!found) {
    bad('no answer at that address (off, another network, or the address changed: try --host)');
    process.exit(1);
  }
  if (found.state !== 'ready') {
    bad(`it answers, but it is in rest mode (HTTP ${found.statusCode}). Turn it on first.`);
    process.exit(1);
  }
  ok(`on, system version ${found.systemVersion ?? '?'}`);

  step(2, 'Session request (TCP 9295)');
  const grant = await requestSession({ host, target: record.target, registKey: Buffer.from(record.registKey, 'hex'), rpKey: Buffer.from(record.rpKey, 'hex') });
  ok('accepted: the console knows this registration and sent a nonce');
  store.markVerified(record.mac, host);

  step(3, 'Control connection (TCP 9295), encrypted with the session keys');
  const seen = [];
  ctrl = new Ctrl({ host, target: record.target, crypt: grant.crypt, registKey: Buffer.from(record.registKey, 'hex') });
  let pinAsked = false;
  ctrl.events.onMessage = (type, payload) => seen.push(`0x${type.toString(16)}(${payload.length})`);
  ctrl.events.onLoginPinRequest = () => (pinAsked = true);
  await ctrl.connect();
  ok(`accepted${ctrl.serverType !== undefined ? `, console type ${ctrl.serverType} (0 = PS4, 1 = PS4 Pro, 2 = PS5)` : ' (the console did not say its type)'}`);
  ok('this is the first use of the session keys, so the key schedule matches the console');

  step(4, 'Session id from the console');
  try {
    const id = await ctrl.waitForSessionId(8000);
    const usable = /^[A-Za-z0-9]{24,78}$/.test(id);
    ok(`received, ${id.length} characters${usable ? '' : ' (not in the usual form: the reference would use a fallback, and so did this)'}`);
    exitCode = 0;
  } catch (e) {
    if (pinAsked) bad('the console asks for the login PIN of the account before it goes on. That is not supported yet.');
    else bad(`${e.message}`);
  }

  if (holdSeconds > 0) {
    console.log(`\n    (keeping the connection open for ${holdSeconds} s to see what else the console sends)`);
    await new Promise((r) => setTimeout(r, holdSeconds * 1000));
  }
  const names = Object.fromEntries(Object.entries(CTRL_MESSAGE).map(([k, v]) => [`0x${v.toString(16)}`, k]));
  console.log(`    messages from the console, type(payload bytes): ${seen.map((s) => `${s}${names[s.split('(')[0]] ? `=${names[s.split('(')[0]]}` : ''}`).join(' ') || '(none)'}`);
} catch (e) {
  if (e instanceof SessionError || e instanceof CtrlError) bad(`${e.message} [${e.code}]`);
  else throw e;
} finally {
  ctrl?.close();
}

console.log(exitCode === 0 ? '\nResult: the console accepted the session and the control connection. Next step to build: the stream connection.' : '\nResult: stopped at the step marked FAIL.');
process.exit(exitCode);
