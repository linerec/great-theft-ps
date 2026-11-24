// SPDX-License-Identifier: AGPL-3.0-only
//
// Start the bridge:
//   node src/bridge/main.ts                          a real PS5 through this project's TypeScript port
//   node src/bridge/main.ts --link core --core <gtp-core executable> [--core-arg <arg> ...]
// Options: --host 127.0.0.1  --port 8788 (when not given, and phone access is off, the next free port is used if 8788 is taken)  --token <string>  --no-handover  --name <what other clients see>
//          --no-wake             do not wake a console that is in rest mode when someone connects (the default is to wake it)
//          --no-locate           do not search the network for a console whose address changed (the stored address is used as it is)
//          --no-runs             do not keep what each stream measured (the default: one JSON file per stream, see runlog.ts)
//          --runs-dir <folder>   where those files go (default: runs/ next to the registered consoles)
//          --trust-host <name>   the HTTPS name another device reaches the bridge under (see below)
//          --tls-cert <file> --tls-key <file>   serve HTTPS itself, with the files `tailscale cert <name>` writes
//          --link-sim <profile>  put a simulated mobile network between the bridge and the page (linksim.ts)
//          --accounts            people log in (see accounts.ts): the owner has no limit, others have minutes per day. Needed for the internet.
//          --time-zone <name>    where a day ends for those minutes (default: GTP_TIMEZONE or America/New_York)
//          --owner-name <name>   the name of the owner invited on the first start (default: owner)
//          --phone               set up phone access (once): asks Tailscale for the certificate if there is none (see phone.ts)
//          --no-phone            do not answer on the tailnet address, whatever else is there
// Phone access is automatic: when Tailscale is running and there is a certificate for this computer's name, the same
// bridge also answers on the tailnet address over HTTPS (port 8788, the token is asked for), next to this computer's own
// address (no token). Giving --host, --tls-cert or --trust-host yourself switches that off: what you typed is used.
// A phone over Tailscale, without any proxy (this is what the automatic way does for you):
//   tailscale cert --cert-file c.crt --key-file c.key <name>.<tailnet>.ts.net
//   node src/bridge/main.ts --host <this computer's tailnet address> --tls-cert c.crt --tls-key c.key --trust-host <name>.<tailnet>.ts.net
// On this computer (the default) no token is used. With --host set to anything else a token is required: if you do
// not pass one, a random one is generated and added to the printed URL.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateConsole } from '../console/locate.ts';
import { ConsoleStore, defaultStorePath } from '../console/store.ts';
import { AccountStore } from './accounts.ts';
import { CoreLink } from './core-link.ts';
import { Handover } from './handover.ts';
import { LINK_PROFILES, parseLinkSim } from './linksim.ts';
import { PHONE_PORT, planPhone, realPhoneDeps, type PhonePlan } from './phone.ts';
import { firstFreePort } from './ports.ts';
import { Ps5Link, StreamResearch } from './ps5-link.ts';
import { probeTailscalePath, RunWriter } from './runlog.ts';
import { startBridge } from './server.ts';
import { describeExpiry, loadTls, namesNotCovered, type TlsMaterial } from './tls.ts';

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

// Phone access: the same bridge also answers on this computer's tailnet address, over HTTPS (see phone.ts). Off when the
// address or the TLS files were typed by hand, with --no-phone, or when Tailscale is not ready (then it says why).
let phone: PhonePlan | null = null;
if (!args['no-phone'] && args.host === undefined && args['tls-cert'] === undefined && args['trust-host'] === undefined && first('link', 'ps5') === 'ps5') {
  try {
    phone = await planPhone(args.phone ? 'on' : 'auto', realPhoneDeps(path.join(path.dirname(defaultStorePath()), 'tls'), (line) => console.log(line)));
  } catch (error) {
    if (args.phone) {
      console.error(`Phone access: ${(error as Error).message}`);
      process.exit(1);
    }
    console.log(`Phone access is off: ${(error as Error).message}`);
  }
}

// Without --port, 8788 is tried first and, if something else has it, the next ones: `npm run dev` should just work.
// With phone access the port stays 8788 whatever happens: the address on the phone's home screen must keep working.
const wantedPort = Number(first('port', String(PHONE_PORT)));
const port = args.port !== undefined || phone ? wantedPort : await firstFreePort(host, wantedPort);
if (port === null) {
  console.error(`No free port from ${wantedPort} to ${wantedPort + 19} on ${host}. Choose one with --port.`);
  process.exit(1);
}
if (port !== wantedPort) console.log(`Port ${wantedPort} is taken by another program; using ${port}.`);
const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
/**
 * Host names the bridge is reached under from another device (--trust-host, repeatable). Two ways to get HTTPS there:
 *  - the bridge serves it itself (--tls-cert, --tls-key) and is bound to this computer's tailnet address (--host);
 *  - an HTTPS proxy on this computer passes requests on to 127.0.0.1 (`tailscale serve`). Careful on a computer that
 *    already publishes things with Tailscale Funnel: a serve command can change what Funnel serves.
 * HTTPS matters: a browser decodes video only on a secure page, and only localhost counts as one without it.
 */
const trustHosts = (args['trust-host'] ?? []).filter((h) => h !== 'true');
const tlsCertFile = args['tls-cert']?.[0];
const tlsKeyFile = args['tls-key']?.[0];
if ((tlsCertFile === undefined) !== (tlsKeyFile === undefined) || tlsCertFile === 'true' || tlsKeyFile === 'true') {
  console.error('--tls-cert <file> and --tls-key <file> go together: they are the two files `tailscale cert <name>` writes');
  process.exit(2);
}
let tls: TlsMaterial | undefined;
if (tlsCertFile !== undefined && tlsKeyFile !== undefined) {
  try {
    tls = loadTls(tlsCertFile, tlsKeyFile);
  } catch (error) {
    console.error(`Could not use the TLS files: ${(error as Error).message}`);
    process.exit(1);
  }
  const expiry = describeExpiry(tls.notAfter);
  if (expiry.level === 'expired') {
    console.error(`Could not use the TLS files: ${expiry.text}. Run \`tailscale cert <name>\` again, then start the bridge again.`);
    process.exit(1);
  }
}
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
// People log in (--accounts): that replaces the token on every address (a token is then only for tools, when --token is given).
const accounts = args.accounts
  ? new AccountStore({ dir: path.join(path.dirname(defaultStorePath()), 'accounts'), timeZone: first('time-zone', process.env.GTP_TIMEZONE ?? 'America/New_York') })
  : undefined;
const token: string | undefined = args.token?.[0] ?? (accounts ? undefined : trustHosts.length > 0 ? keptToken() : loopback ? undefined : randomBytes(16).toString('hex'));
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
// What each stream measured is kept in one file when it ends, so that ways of connecting can be compared (npm run runs).
const runsDir = args['runs-dir']?.[0] ?? path.join(path.dirname(defaultStorePath()), 'runs');
if (!args['no-runs'] && linkKind === 'ps5') {
  const runs = new RunWriter({ dir: runsDir, log });
  research.onFinished = (snapshot) => void runs.write(snapshot);
}
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
  ...(tls ? { tls: { cert: tls.cert, key: tls.key } } : {}),
  ...(phone ? { also: [{ host: phone.host, port, token: args.token?.[0] ?? keptToken(), trustedHosts: [phone.name], tls: { cert: phone.tls.cert, key: phone.tls.key } }] } : {}),
  ...(linkSim ? { linkSim } : {}),
  ...(accounts ? { accounts } : {}),
  root,
  store,
  research,
  pathProbe: probeTailscalePath,
  ...(handover ? { handover } : {}),
  log,
  createLink: () =>
    linkKind === 'ps5' ? new Ps5Link({ store, research, log, ...(handover ? { handover } : {}), ...(args['no-wake'] ? { wake: false } : {}), ...(args['no-locate'] ? {} : { locate: (rec: { mac: string; host: string }) => locateConsole(rec) }) }) : new CoreLink({ command: first('core', ''), args: args['core-arg'] ?? [], log }),
}).catch((error: Error) => {
  console.error(`Could not start the bridge: ${error.message}`);
  if (phone) console.error(`Phone access keeps port ${port} so that the address on the phone keeps working. Is another \`npm run dev\` still running? (--no-phone starts without phone access.)`);
  process.exit(1);
});

console.log(`\nGreat Theft P.S bridge (${linkKind === 'ps5' ? 'PS5, TypeScript port' : 'gtp-core'})`);
console.log(`Open:  ${bridge.url}${token ? `#token=${token}` : ''}`);
if (!loopback) console.log('WARNING: listening beyond this computer. Anyone on the network who has the token can press buttons on your console.');
if (tls) {
  const expiry = describeExpiry(tls.notAfter);
  console.log(`HTTPS: ${expiry.text}.${expiry.level === 'soon' ? ' Run `tailscale cert <name>` again and restart the bridge before it runs out.' : ''}`);
  const missing = namesNotCovered(tls.names, trustHosts.map((h) => h.toLowerCase()));
  if (missing.length > 0) console.log(`WARNING: the certificate is not for ${missing.join(', ')}, so a browser will refuse the connection under that name. It is for: ${tls.names.join(', ') || '(no DNS names)'}.`);
}
if (phone && bridge.also[0]) {
  const expiry = describeExpiry(phone.tls.notAfter);
  console.log(`Phone (over Tailscale, HTTPS, the token is asked for):  https://${phone.name}:${bridge.also[0].port}/#token=${args.token?.[0] ?? keptToken()}`);
  console.log(`  ${expiry.text}; it is renewed by itself when nearly out. Only devices in your tailnet can reach it, and anyone who has this address can press buttons on your console. The token stays the same between starts.`);
  console.log('  After a stream ends, `npm run runs` shows how it went.');
}
for (const name of trustHosts) console.log(`From another device (${tls ? 'directly over HTTPS' : 'through the HTTPS proxy on this computer'}):  https://${name}${tls ? `:${bridge.port}` : ''}/${accounts ? '' : `#token=${token}`}`);
if (trustHosts.length > 0 && !accounts) console.log('Whoever can reach that address and has the token can press buttons on your console. The token stays the same between starts.');
if (accounts) {
  console.log(`Accounts: everybody logs in, on every address (day ends in ${accounts.timeZone}). They are kept in ${accounts.dir}.`);
  if (accounts.empty) {
    // Nobody is set up yet: the owner is invited, and sets the password in the page. The code is shown here and nowhere else.
    const owner = accounts.invite(first('owner-name', 'owner'), { role: 'owner' });
    const urls = [...trustHosts.map((n) => `https://${n}${tls ? `:${bridge.port}` : ''}/`), bridge.url];
    console.log(`FIRST START: open one of these to choose the owner's password (good for 48 hours, once):`);
    for (const u of urls) console.log(`  ${u}#invite=${owner.code}`);
  } else {
    console.log('  Invite someone, or set minutes per day, from the page when logged in as the owner.');
  }
}
console.log(`Registered consoles are kept in ${store.file} (secrets: keep that file private).`);
if (handover) console.log(handover.listening ? `Handover: other Great Theft P.S clients with the same console registration can ask this one to let go (UDP ${handover.port}, encrypted; lock it on the page, or start with --no-handover).` : `Handover: UDP ${handover.port} is not available here, so other clients cannot ask this one to let go.`);
if (linkSim) console.log(`SIMULATED LINK between this bridge and the page: ${linkSimName} (${linkSim.note}). Each way ${linkSim.down.delayMs} ms + up to ${linkSim.down.jitterMs} ms, a ${linkSim.down.stallMs} ms stall about every ${Math.round(linkSim.down.stallEveryMs / 1000)} s, ${linkSim.down.kbps} kbit/s down.`);
console.log('Ctrl+C to stop.\n');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    handover?.close();
    void bridge.close().then(() => process.exit(0));
  });
}
