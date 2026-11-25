// SPDX-License-Identifier: AGPL-3.0-only
//
// The page with a PRETEND console behind it, to look at and try the interface without a PlayStation: one registered
// console that answers as "ready" (or "standby" / "absent"), and a picture made by the test double (test/support/fake-link.ts,
// PNG frames that draw the pad it receives). Nothing here talks to a network or a real console.
//
//   npm run preview                 http://127.0.0.1:8799, console ready
//   npm run preview -- --standby    the console is in rest mode (the button says "깨우고 연결")
//   npm run preview -- --absent     the console does not answer
//   npm run preview -- --port 9000
//   npm run preview -- --accounts   with logins, to see the user menu and the time left: "owner" (no limit) and "aiden"
//                                   (--member-minutes 6 by default, so the five-minute warning comes at once), both with
//                                   the password "preview-pass". They exist only in this process's temporary folder.
// The page reloads when a file under web/ or src/ is saved.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FakeLink } from '../test/support/fake-link.ts';
import { DevReload } from '../src/bridge/devreload.ts';
import { startBridge } from '../src/bridge/server.ts';
import { AccountStore } from '../src/bridge/accounts.ts';
import { ConsoleStore } from '../src/console/store.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const port = Number(args[args.indexOf('--port') + 1]) || 8799;
const state = flag('standby') ? 'standby' : flag('absent') ? 'absent' : 'ready';

const dir = mkdtempSync(path.join(tmpdir(), 'gtp-preview-'));
const store = new ConsoleStore(path.join(dir, 'consoles.json'));
store.merge({
  version: 1,
  consoles: [
    {
      mac: '0123456789ab', nickname: '거실 PS5', target: 'ps5-1', host: '192.168.1.20', registeredAt: new Date().toISOString(),
      rpKey: '00112233445566778899aabbccddeeff', registKey: '61626364656667680000000000000000',
    },
  ],
});

let accounts;
if (flag('accounts')) {
  accounts = new AccountStore({ dir: path.join(dir, 'accounts'), scryptCost: { n: 1024, r: 8, p: 1 } });
  const minutes = Number(args[args.indexOf('--member-minutes') + 1]) || 6;
  await accounts.acceptInvite(accounts.invite('owner', { role: 'owner' }).code, 'preview-pass');
  await accounts.acceptInvite(accounts.invite('aiden', { dailyMinutes: minutes }).code, 'preview-pass');
  console.log(`Logins: owner or aiden (${minutes} minutes a day), password preview-pass`);
}

const bridge = await startBridge({
  host: '127.0.0.1',
  ...(accounts ? { accounts } : {}),
  port,
  root,
  store,
  devReload: new DevReload({ dirs: [path.join(root, 'web'), path.join(root, 'src')] }),
  api: {
    discover: async () => ({
      hosts: state === 'absent' ? [] : [{ address: '192.168.1.20', state, statusCode: state === 'ready' ? 200 : 620, hostId: '0123456789AB', hostName: '거실 PS5', hostType: 'PS5', isPs5: true, target: 'ps5-1' }],
    }),
  },
  createLink: () => new FakeLink(),
});
console.log(`Preview with a pretend console (${state}): ${bridge.url}`);
console.log('Ctrl+C to stop.');
process.on('SIGINT', async () => {
  await bridge.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
});
