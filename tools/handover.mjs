// SPDX-License-Identifier: AGPL-3.0-only
//
// Try the handover between this project's clients (src/bridge/handover.ts) from the command line.
//
//   npm run handover -- who                         which of them has the console? Changes nothing.
//   npm run handover -- hold [--seconds 60] [--locked]
//                                                   stand in for a client that has the console, WITHOUT talking to the
//                                                   console at all: for checking from another computer that the two
//                                                   can hear each other (who / ask there).
//   npm run handover -- ask                         ask the client that has the console to let go. A real request: an
//                                                   unlocked client of yours DOES disconnect.
//   Options: --mac <id>  --name <what the others see>
//
// Only clients with the same registration for the console hear each other (copy it with: npm run consoles).

import { broadcastTargets, Handover } from '../src/bridge/handover.ts';
import { ConsoleStore, defaultStorePath } from '../src/console/store.ts';

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith('--'));
const opt = (name) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);

const store = new ConsoleStore(defaultStorePath());
const list = store.list();
const chosen = opt('mac') ? list.find((c) => c.mac === opt('mac').toLowerCase()) : list[0];
if (!chosen) {
  console.error(list.length ? 'That console is not registered on this computer.' : 'No console is registered on this computer.');
  process.exit(1);
}
if (!['who', 'hold', 'ask'].includes(command ?? '')) {
  console.error('Say what to do: who, hold or ask. See the top of tools/handover.mjs.');
  process.exit(2);
}

const handover = new Handover({ store, ...(opt('name') ? { name: opt('name') } : {}) });
await handover.start();
console.log(`This client: "${handover.name}". Listening for requests: ${handover.listening ? `yes (UDP ${handover.port})` : 'no (the port is not available)'}. Networks: ${broadcastTargets(handover.port).length}.`);

if (command === 'who') {
  const found = await handover.who(chosen.mac, 2200);
  if (found.length === 0) console.log('No client of this project says it has the console (or none can be heard from here).');
  for (const f of found) console.log(`"${f.name}" has the console${f.locked ? ', locked' : ', not locked'}.`);
} else if (command === 'ask') {
  const t0 = Date.now();
  const answer = await handover.ask(chosen.mac, 2500);
  console.log(answer.result === 'none' ? 'No answer.' : `Answer after ${Date.now() - t0} ms: "${answer.name}" ${answer.result === 'yielded' ? 'let go' : 'is locked and stays'}.`);
} else {
  const seconds = Number(opt('seconds') ?? 60);
  const locked = argv.includes('--locked');
  console.log(`Standing in for a client that has the console (${locked ? 'locked' : 'not locked'}) for ${seconds} s. The console itself is not contacted.`);
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.log('Nobody asked.');
      resolve();
    }, seconds * 1000);
    handover.hold(chosen.mac, {
      locked,
      release: (by) => {
        clearTimeout(timer);
        console.log(`"${by}" asked for the console: let go.`);
        setTimeout(resolve, 300);
      },
    });
  });
}
handover.close();
process.exit(0);
