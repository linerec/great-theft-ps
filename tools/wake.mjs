// SPDX-License-Identifier: AGPL-3.0-only
//
// Wake a registered console that is in rest mode, and wait until it answers. For trying the wake-up on real hardware.
//
//   npm run wake [-- --mac <id>] [--timeout <seconds>]
//   npm run wake -- --check          only say what the console answers (on, in rest mode, nothing); sends no wake-up
//
// Without --check this SENDS the wake-up datagram to the console's address: a console in rest mode switches on. The
// console must allow it in its rest-mode settings ("Enable Turning on PS5 from Network"). Nothing secret is printed: the
// key stays in memory and only the number of seconds the console took is shown.

import { ConsoleStore, defaultStorePath } from '../src/console/store.ts';
import { probePresence, wakeConsole } from '../src/console/wake.ts';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const store = new ConsoleStore(defaultStorePath());
const list = store.list();
const chosen = opt('mac') ? list.find((c) => c.mac === opt('mac').toLowerCase()) : list[0];
if (!chosen) {
  console.error(list.length ? 'That console is not registered on this computer.' : 'No console is registered on this computer. Register one first (the PS5 page, or npm run register).');
  process.exit(1);
}
const record = store.get(chosen.mac);
const name = chosen.nickname || 'PS5';
const SAYS = { ready: 'is on (ready)', standby: 'is in rest mode (standby)', absent: 'does not answer' };

const before = await probePresence(record.host);
console.log(`${name} ${SAYS[before]}.`);
if (argv.includes('--check')) process.exit(before === 'absent' ? 1 : 0);
if (before === 'ready') {
  console.log('Nothing to wake.');
  process.exit(0);
}
if (before === 'absent') {
  console.log('It is shut down, not on this network, or at another address: a wake-up datagram would not be answered either. Nothing sent.');
  process.exit(1);
}

console.log('Sending the wake-up datagram, then asking once every 1.5 s...');
const t0 = Date.now();
const result = await wakeConsole(
  { host: record.host, target: record.target, registKey: record.registKey },
  {
    ...(opt('timeout') ? { timeoutMs: Number(opt('timeout')) * 1000 } : {}),
    onState: (presence, seconds) => console.log(`  ${String(seconds).padStart(3)} s  ${presence}`),
  },
);
const took = ((Date.now() - t0) / 1000).toFixed(1);
switch (result.result) {
  case 'woke':
    console.log(`\n${name} woke up and answers (${result.seconds} s until it said ready; ${took} s in all, with the pause before it is handed on).`);
    break;
  case 'timeout':
    console.log(`\n${name} did not answer within ${result.seconds} s. Is "Enable Turning on PS5 from Network" on in its rest-mode settings, and is it on this network?`);
    process.exit(1);
    break;
  default:
    console.log(`\nResult: ${result.result}${result.message ? ` (${result.message})` : ''}`);
    process.exit(1);
}
