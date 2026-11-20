// SPDX-License-Identifier: AGPL-3.0-only
//
// Look for PlayStation consoles on the local network. Run it on the network where the console is:
//   node tools/discover.mjs                      broadcast on every network interface
//   node tools/discover.mjs --host 192.168.0.20  ask one console directly (works across subnets and some VPNs)
//   node tools/discover.mjs --wake <registKeyHex> --host <ip> [--ps4]   wake a console that is in rest mode
// Options: --timeout <ms> (default 3000), --json
//
// This is the first step of talking to a real console and it has only been tested against a simulator.
// Please copy the whole output when you report what happened.
import { credentialFromRegistKey, discover, localBroadcastAddresses, wakeup } from '../src/console/discovery.ts';

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);
const host = value('host');
const timeoutMs = Number(value('timeout') ?? 3000);
const logs = [];

if (value('wake')) {
  if (!host) {
    console.error('--wake needs --host <console ip>');
    process.exit(2);
  }
  await wakeup(host, credentialFromRegistKey(value('wake')), !flag('ps4'));
  console.log(`Wake-up packet sent to ${host} (${flag('ps4') ? 'PS4' : 'PS5'}). The console needs "Enable Turning on PS5/PS4 from Network" in rest mode settings.`);
  process.exit(0);
}

console.log('Network interfaces used for broadcast:');
for (const b of localBroadcastAddresses()) console.log(`  ${b.iface.padEnd(24)} ${b.address.padEnd(16)} broadcast ${b.broadcast}`);

const result = await discover({ hosts: host ? [host] : undefined, timeoutMs, log: (l) => logs.push(l) });

if (flag('json')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.log(`\nProbes sent from local UDP port ${result.localPort}:`);
for (const s of result.sent) console.log(`  ${s}`);
console.log('');

if (result.hosts.length === 0) {
  console.log('No console answered.\n');
  console.log('Things to check:');
  console.log('  - The console is on, or in rest mode with network wake-up enabled, and on the same network (same subnet) as this computer.');
  console.log('  - Remote Play is enabled on the console (Settings > System > Remote Play).');
  console.log('  - A VPN (for example a corporate one) may capture broadcast traffic: disconnect it, or try --host <console ip>.');
  console.log('  - Windows Firewall: allow Node.js on private networks when it asks.');
  if (logs.length) console.log(`\nDiagnostics:\n${logs.map((l) => `  ${l}`).join('\n')}`);
  process.exit(1);
}

for (const h of result.hosts) {
  console.log(`${h.hostName ?? '(no name)'}  [${h.hostType ?? '?'}]  ${h.address}`);
  console.log(`  state:           ${h.state} (HTTP ${h.statusCode})`);
  console.log(`  host id:         ${h.hostId ?? '-'}`);
  console.log(`  system version:  ${h.systemVersion ?? '-'}  (treated as ${h.target})`);
  console.log(`  protocol:        ${h.protocolVersion ?? '-'}   request port: ${h.hostRequestPort ?? '-'}`);
  if (h.runningAppName) console.log(`  running:         ${h.runningAppName} (${h.runningAppTitleId ?? '-'})`);
}
if (logs.length) console.log(`\nNotes:\n${logs.map((l) => `  ${l}`).join('\n')}`);
