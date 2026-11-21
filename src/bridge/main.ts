// SPDX-License-Identifier: AGPL-3.0-only
//
// Start the bridge:
//   node src/bridge/main.ts                          a real PS5 through this project's TypeScript port
//   node src/bridge/main.ts --link core --core <gtp-core executable> [--core-arg <arg> ...]
// Options: --host 127.0.0.1  --port 8787  --token <string>  --no-handover  --name <what other clients see>
//          --trust-host <name>   the HTTPS name a proxy on this computer gives the bridge (see below)
//          --link-sim <profile>  put a simulated mobile network between the bridge and the page (linksim.ts)
// On this computer (the default) no token is used. With --host set to anything else a token is required: if you do
// not pass one, a random one is generated and added to the printed URL.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConsoleStore, defaultStorePath } from '../console/store.ts';
import { CoreLink } from './core-link.ts';
import { Handover } from './handover.ts';
import { LINK_PROFILES, parseLinkSim } from './linksim.ts';
import { Ps5Link, StreamResearch } from './ps5-link.ts';
import { startBridge } from './server.ts';

function parseArgs(argv: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    (out[a.slice(2)] ??= []).push(argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true');
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const first = (k: string, d: string): string => args[k]?.[0] ?? d;
const host = first('host', '127.0.0.1');
const port = Number(first('port', '8787'));
const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
/**
 * Host names the bridge is reached under through an HTTPS proxy on this computer (--trust-host, repeatable). This is
 * how another device uses it without the bridge leaving loopback: `tailscale serve` gives this computer an HTTPS
 * address inside the tailnet and passes requests on to 127.0.0.1. HTTPS matters: a browser decodes video only on a
 * secure page, and only localhost counts as one without it.
 */
const trustHosts = (args['trust-host'] ?? []).filter((h) => h !== 'true');
/** A token that stays the same between starts, so that the address on the other device keeps working. */
function keptToken(): string {
  const file = path.join(path.dirname(defaultStorePath()), 'bridge-token');
  try {
    const kept = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(kept)) return kept;
  } catch {
    /* none yet */
  }
  const fresh = randomBytes(16).toString('hex');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${fresh}\n`, { mode: 0o600 });
  return fresh;
}
const token: string | undefined = args.token?.[0] ?? (trustHosts.length > 0 ? keptToken() : loopback ? undefined : randomBytes(16).toString('hex'));
const linkKind = first('link', 'ps5');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const log = (line: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

if (linkKind !== 'ps5' && linkKind !== 'core') {
  console.error('--link must be "ps5" or "core"');
  process.exit(2);
}
if (linkKind === 'core' && !args.core) {
  console.error('--link core needs --core <path to gtp-core>');
  process.exit(2);
}

const linkSimName = args['link-sim']?.[0];
const linkSim = linkSimName ? parseLinkSim(linkSimName) : null;
if (linkSimName && !linkSim) {
  console.error(`--link-sim must be one of ${Object.keys(LINK_PROFILES).join(', ')}, or five numbers: delay,jitter,stallMs,stallEveryMs,kbps`);
  process.exit(2);
}
const store = new ConsoleStore(defaultStorePath());
const research = new StreamResearch();
// This project's clients hand the console over among themselves (handover.ts). That needs a listener on the local
// network: UDP, readable and writable only with the same console registration, and all it can do is end this
// client's stream. --no-handover leaves it out.
const handover = args['no-handover'] || linkKind !== 'ps5' ? undefined : new Handover({ store, log, ...(args.name?.[0] ? { name: args.name[0] } : {}) });
await handover?.start();
const bridge = await startBridge({
  host,
  port,
  ...(token !== undefined ? { token } : {}),
  ...(trustHosts.length > 0 ? { trustedHosts: trustHosts } : {}),
  ...(linkSim ? { linkSim } : {}),
  root,
  store,
  research,
  ...(handover ? { handover } : {}),
  log,
  createLink: () =>
    linkKind === 'ps5' ? new Ps5Link({ store, research, log, ...(handover ? { handover } : {}) }) : new CoreLink({ command: first('core', ''), args: args['core-arg'] ?? [], log }),
}).catch((error: Error) => {
  console.error(`Could not start the bridge: ${error.message}`);
  process.exit(1);
});

console.log(`\nGreat Theft P.S bridge (${linkKind === 'ps5' ? 'PS5, TypeScript port' : 'gtp-core'})`);
console.log(`Open:  ${bridge.url}${token ? `#token=${token}` : ''}`);
if (!loopback) console.log('WARNING: listening beyond this computer. Anyone on the network who has the token can press buttons on your console.');
for (const name of trustHosts) console.log(`From another device (through the HTTPS proxy on this computer):  https://${name}/#token=${token}`);
if (trustHosts.length > 0) console.log('Whoever can reach that address and has the token can press buttons on your console. The token stays the same between starts.');
console.log(`Registered consoles are kept in ${store.file} (secrets: keep that file private).`);
if (handover) console.log(handover.listening ? `Handover: other Great Theft P.S clients with the same console registration can ask this one to let go (UDP ${handover.port}, encrypted; lock it on the page, or start with --no-handover).` : `Handover: UDP ${handover.port} is not available here, so other clients cannot ask this one to let go.`);
if (linkSim) console.log(`SIMULATED LINK between this bridge and the page: ${linkSimName} (${linkSim.note}). Each way ${linkSim.down.delayMs} ms + up to ${linkSim.down.jitterMs} ms, a ${linkSim.down.stallMs} ms stall about every ${Math.round(linkSim.down.stallEveryMs / 1000)} s, ${linkSim.down.kbps} kbit/s down.`);
console.log('Ctrl+C to stop.\n');

process.on('SIGINT', () => {
  handover?.close();
  void bridge.close().then(() => process.exit(0));
});
