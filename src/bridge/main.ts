// SPDX-License-Identifier: AGPL-3.0-only
//
// Start the bridge:
//   node src/bridge/main.ts                          simulated console (no PlayStation needed)
//   node src/bridge/main.ts --link core --core <gtp-core executable> [--core-arg <arg> ...]
// Options: --host 127.0.0.1  --port 8787  --token <string>
// On this computer (the default) no token is used. With --host set to anything else a token is required: if you do
// not pass one, a random one is generated and added to the printed URL.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CoreLink } from './core-link.ts';
import { MockConsole } from './mock-console.ts';
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
const token: string | undefined = args.token?.[0] ?? (loopback ? undefined : randomBytes(16).toString('hex'));
const linkKind = first('link', 'mock');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const log = (line: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

if (linkKind !== 'mock' && linkKind !== 'core') {
  console.error('--link must be "mock" or "core"');
  process.exit(2);
}
if (linkKind === 'core' && !args.core) {
  console.error('--link core needs --core <path to gtp-core>');
  process.exit(2);
}

const bridge = await startBridge({
  host,
  port,
  token,
  root,
  log,
  createLink: () =>
    linkKind === 'mock' ? new MockConsole() : new CoreLink({ command: first('core', ''), args: args['core-arg'] ?? [], log }),
}).catch((error: Error) => {
  console.error(`Could not start the bridge: ${error.message}`);
  process.exit(1);
});

console.log(`\nGreat Theft P.S bridge (${linkKind === 'mock' ? 'SIMULATED console' : 'gtp-core'})`);
console.log(`Open:  ${bridge.url}${token ? `#token=${token}` : ''}`);
if (!loopback) console.log('WARNING: listening beyond this computer. Anyone on the network who has the token can press buttons on your console.');
console.log('Ctrl+C to stop.\n');

process.on('SIGINT', () => void bridge.close().then(() => process.exit(0)));
