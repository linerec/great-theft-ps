// SPDX-License-Identifier: AGPL-3.0-only
//
// `npm run phone`: working out the tailnet address, name and certificate (src/bridge/phone.ts), with a stand-in for the
// `tailscale` command.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { selfSigned } from './support/selfsigned.ts';
import { preparePhone, type PhoneDeps } from '../src/bridge/phone.ts';

const NAME = 'test-mac.tail0000.ts.net';
const IP = '100.64.0.7';
const NOW = new Date('2026-11-22T12:00:00Z');
const DAY = 86_400_000;

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const status = (over: Record<string, unknown> = {}, self: Record<string, unknown> = {}): string =>
  JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${NAME}.`, TailscaleIPs: [IP, 'fd7a:115c:a1e0::7'], ...self }, ...over });

interface World {
  dir: string;
  deps: PhoneDeps;
  calls: string[][];
  log: string[];
}

/**
 * `cert`: what the stand-in for `tailscale cert` does when asked: write a certificate valid for that many days (for the
 * name asked, or `certName`), fail with a message, or (undefined) not be called.
 */
function world(o: { status?: string | Error; have?: { days: number; names?: string[] }; cert?: { days: number; names?: string[] } | Error } = {}): World {
  const dir = mkdtempSync(path.join(tmpdir(), 'gtp-phone-'));
  dirs.push(dir);
  const write = (days: number, names: string[]): void => {
    const c = selfSigned({ names, notBefore: new Date(NOW.getTime() - 2 * DAY), notAfter: new Date(NOW.getTime() + days * DAY) });
    writeFileSync(path.join(dir, 'bridge.crt'), c.cert);
    writeFileSync(path.join(dir, 'bridge.key'), c.key);
  };
  if (o.have) write(o.have.days, o.have.names ?? [NAME]);
  const calls: string[][] = [];
  const log: string[] = [];
  const deps: PhoneDeps = {
    tlsDir: dir,
    now: () => NOW,
    log: (l) => void log.push(l),
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === 'status') {
        if (o.status instanceof Error) throw o.status;
        return o.status ?? status();
      }
      if (args[0] === 'cert') {
        if (o.cert instanceof Error) throw o.cert;
        if (!o.cert) throw new Error('unexpected: the certificate should not have been asked for');
        write(o.cert.days, o.cert.names ?? [args.at(-1)!]);
        return '';
      }
      throw new Error(`unexpected command ${args.join(' ')}`);
    },
  };
  return { dir, deps, calls, log };
}

describe('phone mode, with a certificate that is fine', () => {
  it('fills in the tailnet address, the name, the certificate and the fixed port, and asks Tailscale nothing more', async () => {
    const w = world({ have: { days: 60 } });
    const args: Record<string, string[]> = { phone: ['true'] };
    await preparePhone(args, w.deps);
    assert.deepEqual(args.host, [IP]);
    assert.deepEqual(args.port, ['8788']);
    assert.deepEqual(args['tls-cert'], [path.join(w.dir, 'bridge.crt')]);
    assert.deepEqual(args['tls-key'], [path.join(w.dir, 'bridge.key')]);
    assert.deepEqual(args['trust-host'], [NAME]);
    assert.deepEqual(w.calls, [['tailscale', 'status', '--json']], 'only the status was read');
    assert.ok(w.log.some((l) => /tailnet address only, port 8788/.test(l)));
    assert.ok(w.log.some((l) => /npm run runs/.test(l)));
  });

  it('lets what was typed win, and does not list a name twice', async () => {
    const w = world({ have: { days: 60 } });
    const args: Record<string, string[]> = { phone: ['true'], port: ['9000'], host: ['100.64.0.99'], 'trust-host': [NAME, 'other.example'] };
    await preparePhone(args, w.deps);
    assert.deepEqual(args.port, ['9000']);
    assert.deepEqual(args.host, ['100.64.0.99']);
    assert.deepEqual(args['trust-host'], [NAME, 'other.example']);
  });

  it('takes the name without its dot at the end, in lower case', async () => {
    const w = world({ have: { days: 60, names: ['test-mac.tail0000.ts.net'] }, status: status({}, { DNSName: 'Test-Mac.tail0000.ts.net.' }) });
    const args: Record<string, string[]> = {};
    await preparePhone(args, w.deps);
    assert.deepEqual(args['trust-host'], [NAME]);
  });

  it('picks the IPv4 address even when the IPv6 one comes first', async () => {
    const w = world({ have: { days: 60 }, status: status({}, { TailscaleIPs: ['fd7a:115c:a1e0::7', IP] }) });
    const args: Record<string, string[]> = {};
    await preparePhone(args, w.deps);
    assert.deepEqual(args.host, [IP]);
  });
});

describe('phone mode, getting the certificate', () => {
  const certArgs = (w: World): string[] => ['tailscale', 'cert', '--cert-file', path.join(w.dir, 'bridge.crt'), '--key-file', path.join(w.dir, 'bridge.key'), NAME];

  it('asks for one when there is none', async () => {
    const w = world({ cert: { days: 90 } });
    const args: Record<string, string[]> = {};
    await preparePhone(args, w.deps);
    assert.deepEqual(w.calls[1], certArgs(w));
    assert.ok(w.log.some((l) => /there is none yet/.test(l)));
    assert.ok(w.log.some((l) => /Certificate ready/.test(l)));
    assert.ok(existsSync(path.join(w.dir, 'bridge.crt')));
  });

  it('renews one that has two weeks or less left', async () => {
    const w = world({ have: { days: 10 }, cert: { days: 90 } });
    await preparePhone({}, w.deps);
    assert.deepEqual(w.calls[1], certArgs(w));
    assert.ok(w.log.some((l) => /only 10 days more/.test(l)));
  });

  it('renews one that is for another name', async () => {
    const w = world({ have: { days: 60, names: ['someone-else.tail0000.ts.net'] }, cert: { days: 90 } });
    await preparePhone({}, w.deps);
    assert.deepEqual(w.calls[1], certArgs(w));
    assert.ok(w.log.some((l) => /another name/.test(l)));
  });

  it('goes on with the old certificate when renewing fails but it still works', async () => {
    const w = world({ have: { days: 5 }, cert: new Error('no network') });
    const args: Record<string, string[]> = {};
    const before = readFileSync(path.join(w.dir, 'bridge.crt'), 'utf8');
    await preparePhone(args, w.deps);
    assert.deepEqual(args.host, [IP]);
    assert.ok(w.log.some((l) => /Could not renew the certificate \(no network\).*still works/.test(l)));
    assert.equal(readFileSync(path.join(w.dir, 'bridge.crt'), 'utf8'), before, 'nothing was thrown away');
  });

  it('stops, saying what to do, when it cannot get a certificate and has none that works', async () => {
    for (const have of [undefined, { days: -3 }, { days: 60, names: ['someone-else.tail0000.ts.net'] }]) {
      const w = world({ ...(have ? { have } : {}), cert: new Error('HTTPS is not enabled') });
      await assert.rejects(preparePhone({}, w.deps), /could not get a certificate for test-mac.*HTTPS is not enabled.*admin console/s);
    }
  });

  it('does not take a certificate that Tailscale claims to have written but did not', async () => {
    const w = world({});
    w.deps.run = async (_c, args) => {
      if (args[0] === 'status') return status();
      writeFileSync(path.join(w.dir, 'bridge.crt'), 'garbage');
      writeFileSync(path.join(w.dir, 'bridge.key'), 'garbage');
      return '';
    };
    await assert.rejects(preparePhone({}, w.deps), /could not get a certificate/);
  });
});

describe('phone mode, when Tailscale is not ready', () => {
  it('says so when the command is not there', async () => {
    const w = world({ status: new Error('`tailscale` was not found') });
    await assert.rejects(preparePhone({}, w.deps), /not installed here.*PATH/s);
  });

  it('says so when the command fails', async () => {
    const w = world({ status: new Error('failed to connect to local tailscaled') });
    await assert.rejects(preparePhone({}, w.deps), /could not ask Tailscale.*local tailscaled.*running/s);
  });

  it('says so when it is not connected, with its own words for the state', async () => {
    for (const state of ['NeedsLogin', 'Stopped', 'Starting']) {
      const w = world({ status: status({ BackendState: state }) });
      await assert.rejects(preparePhone({}, w.deps), new RegExp(`not connected \\(it says "${state}"\\).*sign in`, 's'));
    }
  });

  it('says so when this computer has no name in the tailnet', async () => {
    for (const self of [{ DNSName: '' }, { DNSName: undefined }, { DNSName: 'localhost' }]) {
      const w = world({ status: status({}, self) });
      await assert.rejects(preparePhone({}, w.deps), /no name in the tailnet.*MagicDNS/s);
    }
  });

  it('says so when there is no IPv4 address', async () => {
    const w = world({ status: status({}, { TailscaleIPs: ['fd7a:115c:a1e0::7'] }) });
    await assert.rejects(preparePhone({}, w.deps), /no Tailscale IPv4 address/);
    const w2 = world({ status: status({}, { TailscaleIPs: undefined }) });
    await assert.rejects(preparePhone({}, w2.deps), /no Tailscale IPv4 address/);
  });

  it('says so when the output is not JSON', async () => {
    const w = world({ status: 'not json at all' });
    await assert.rejects(preparePhone({}, w.deps), /could not ask Tailscale/);
  });

  it('asks for nothing and writes nothing when it stops early', async () => {
    const w = world({ status: status({ BackendState: 'Stopped' }) });
    await assert.rejects(preparePhone({}, w.deps));
    assert.deepEqual(w.calls.map((c) => c[1]), ['status']);
    assert.equal(existsSync(path.join(w.dir, 'bridge.crt')), false);
  });
});
