// SPDX-License-Identifier: AGPL-3.0-only
//
// Register this computer with your console, from the command line. The same thing the page does, with the exact
// reason printed when it fails.
//
//   npm run register -- --host <console IP> --pin <8 digits> [--account-id <decimal or base64>] [--target ps5-1]
//
// Before running it, on the console open  Settings > System > Remote Play > Link Device  (PS5) or
// Settings > Remote Play Connection Settings > Add Device  (PS4) and keep that screen with the code open.
// The console must be on, not in rest mode. The result is saved in the GTP folder (see the path printed at the end).
// The PIN and the account id are not printed and not stored in shell history if you leave --pin out and type it when
// asked (set GTP_PIN instead of --pin to avoid putting it on the command line).

import { createInterface } from 'node:readline/promises';

import { discover } from '../src/console/discovery.ts';
import { parseAccountId, register, RegistError } from '../src/console/regist.ts';
import { ConsoleStore, defaultStorePath } from '../src/console/store.ts';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const host = opt('host');
if (!host) {
  console.error('usage: npm run register -- --host <console IP> [--pin <8 digits>] [--account-id <decimal or base64>] [--target ps5-1]');
  process.exit(2);
}

const store = new ConsoleStore(defaultStorePath());
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (question) => (await rl.question(question)).trim();

try {
  let target = opt('target');
  if (!target) {
    const found = (await discover({ hosts: [host], timeoutMs: 2500 })).hosts[0];
    if (!found) {
      console.error(`No answer from ${host}. Check the address, that the console is on, and that Remote Play is enabled.`);
      process.exit(1);
    }
    target = found.target;
    console.log(`Found ${found.hostName ?? 'a console'} (${found.hostType ?? '?'}), ${found.state === 'ready' ? 'on' : 'in rest mode'}, target ${target}.`);
    if (found.state !== 'ready') console.log('The console is in rest mode. Turn it on first, otherwise registration will not work.');
  }
  const pin = opt('pin') ?? process.env.GTP_PIN ?? (await ask('PIN shown on the console (8 digits): '));
  let accountText = opt('account-id') ?? process.env.GTP_ACCOUNT_ID;
  if (!accountText && store.accountId) {
    console.log('Using the account id saved from an earlier registration.');
    accountText = store.accountId;
  }
  if (!accountText) console.log('No account id yet. The page of npm run bridge can fetch and save it (open its registration form and look for the PSN account id helper), or type it in below.');
  accountText ??= await ask('PSN account id (decimal number or base64): ');

  const result = await register({ host, target, pin, accountId: accountText, log: (line) => console.log(`  ${line}`) });
  store.setAccountId(Buffer.from(parseAccountId(accountText)).toString('base64'));
  const saved = store.put(result, host);
  console.log(`\nRegistered "${saved.nickname}" (${saved.target}, id ${saved.mac}).`);
  console.log(`Saved in ${store.file}. That file holds the keys for your console: keep it private.`);
} catch (e) {
  if (e instanceof RegistError) {
    console.error(`\nRegistration failed (${e.code}): ${e.message}`);
    process.exit(1);
  }
  throw e;
} finally {
  rl.close();
}
