// SPDX-License-Identifier: AGPL-3.0-only
//
// Phone access for `npm run dev`: working out the tailnet address, name and certificate (src/bridge/phone.ts), with a
// stand-in for the `tailscale` command.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { selfSigned } from './support/selfsigned.ts';
import { planPhone, type PhoneDeps } from '../src/bridge/phone.ts';

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

/** `cert`: what the stand-in for `tailscale cert` does when asked: write a certificate valid for that many days, or fail. */
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

describe('phone access with a certificate that is fine', () => {
  for (const mode of ['auto', 'on'] as const) {
    it(`gives the tailnet address, the name and the certificate, and asks Tailscale only for its status (${mode})`, async () => {
      const w = world({ have: { days: 60 } });
      const plan = await planPhone(mode, w.deps);
      assert.equal(plan.host, IP);
      assert.equal(plan.name, NAME);
      assert.equal(plan.certFile, path.join(w.dir, 'bridge.crt'));
      assert.equal(plan.keyFile, path.join(w.dir, 'bridge.key'));
      assert.deepEqual(plan.tls.names, [NAME]);
      assert.deepEqual(w.calls, [['tailscale', 'status', '--json']]);
    });
  }

  it('takes the name without its dot at the end, in lower case', async () => {
    const w = world({ have: { days: 60 }, status: status({}, { DNSName: 'Test-Mac.tail0000.ts.net.' }) });
    assert.equal((await planPhone('auto', w.deps)).name, NAME);
  });

  it('picks the IPv4 address even when the IPv6 one comes first', async () => {
    const w = world({ have: { days: 60 }, status: status({}, { TailscaleIPs: ['fd7a:115c:a1e0::7', IP] }) });
    assert.equal((await planPhone('auto', w.deps)).host, IP);
  });
});

describe('phone access and the certificate', () => {
  const certArgs = (w: World): string[] => ['tailscale', 'cert', '--cert-file', path.join(w.dir, 'bridge.crt'), '--key-file', path.join(w.dir, 'bridge.key'), NAME];

  it('renews one that has two weeks or less left, by itself, in either mode', async () => {
    for (const mode of ['auto', 'on'] as const) {
      const w = world({ have: { days: 10 }, cert: { days: 90 } });
      const plan = await planPhone(mode, w.deps);
      assert.deepEqual(w.calls[1], certArgs(w));
      assert.ok(w.log.some((l) => /only 10 days more/.test(l)));
      assert.ok(plan.tls.notAfter.getTime() > NOW.getTime() + 80 * DAY, 'the new one is in use');
    }
  });

  it('renews one that has already run out', async () => {
    const w = world({ have: { days: -2 }, cert: { days: 90 } });
    await planPhone('auto', w.deps);
    assert.deepEqual(w.calls[1], certArgs(w));
  });

  it('does not ask for a first certificate without being told to (auto), and says how to', async () => {
    const w = world({});
    await assert.rejects(planPhone('auto', w.deps), /no certificate for test-mac.*npm run dev -- --phone/s);
    assert.deepEqual(w.calls.map((c) => c[1]), ['status'], 'Tailscale was not asked for a certificate');
    assert.equal(existsSync(path.join(w.dir, 'bridge.crt')), false);
  });

  it('does not ask for a certificate for another name without being told to either (auto)', async () => {
    const w = world({ have: { days: 60, names: ['someone-else.tail0000.ts.net'] } });
    await assert.rejects(planPhone('auto', w.deps), /no certificate for test-mac.*another name/s);
    assert.deepEqual(w.calls.map((c) => c[1]), ['status']);
  });

  it('asks for a first certificate when told to (--phone)', async () => {
    const w = world({ cert: { days: 90 } });
    const plan = await planPhone('on', w.deps);
    assert.deepEqual(w.calls[1], certArgs(w));
    assert.ok(w.log.some((l) => /there is none yet/.test(l)));
    assert.ok(w.log.some((l) => /Certificate ready/.test(l)));
    assert.equal(plan.name, NAME);
  });

  it('asks for one for the right name when the one there is for another (--phone)', async () => {
    const w = world({ have: { days: 60, names: ['someone-else.tail0000.ts.net'] }, cert: { days: 90 } });
    await planPhone('on', w.deps);
    assert.deepEqual(w.calls[1], certArgs(w));
    assert.ok(w.log.some((l) => /another name/.test(l)));
  });

  it('goes on with the old certificate when renewing fails but it still works', async () => {
    const w = world({ have: { days: 5 }, cert: new Error('no network') });
    const before = readFileSync(path.join(w.dir, 'bridge.crt'), 'utf8');
    const plan = await planPhone('auto', w.deps);
    assert.equal(plan.host, IP);
    assert.ok(w.log.some((l) => /Could not renew the certificate \(no network\).*still works/.test(l)));
    assert.equal(readFileSync(path.join(w.dir, 'bridge.crt'), 'utf8'), before, 'nothing was thrown away');
  });

  it('stops, saying what to do, when it cannot get a certificate and has none that works', async () => {
    for (const [mode, have] of [['on', undefined], ['on', { days: 60, names: ['someone-else.tail0000.ts.net'] }], ['on', { days: -3 }], ['auto', { days: -3 }]] as const) {
      const w = world({ ...(have ? { have } : {}), cert: new Error('HTTPS is not enabled') });
      await assert.rejects(planPhone(mode, w.deps), /could not get a certificate for test-mac.*HTTPS is not enabled.*admin console/s);
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
    await assert.rejects(planPhone('on', w.deps), /could not get a certificate/);
  });
});

describe('phone access when Tailscale is not ready', () => {
  it('says so when the command is not there', async () => {
    const w = world({ status: new Error('`tailscale` was not found') });
    await assert.rejects(planPhone('auto', w.deps), /not installed here.*PATH/s);
  });

  it('says so when the command fails', async () => {
    const w = world({ status: new Error('failed to connect to local tailscaled') });
    await assert.rejects(planPhone('auto', w.deps), /could not ask Tailscale.*local tailscaled.*running/s);
  });

  it('says so when it is not connected, with its own words for the state', async () => {
    for (const state of ['NeedsLogin', 'Stopped', 'Starting']) {
      const w = world({ have: { days: 60 }, status: status({ BackendState: state }) });
      await assert.rejects(planPhone('auto', w.deps), new RegExp(`not connected \\(it says "${state}"\\).*sign in`, 's'));
    }
  });

  it('says so when this computer has no name in the tailnet', async () => {
    for (const self of [{ DNSName: '' }, { DNSName: undefined }, { DNSName: 'localhost' }]) {
      const w = world({ status: status({}, self) });
      await assert.rejects(planPhone('auto', w.deps), /no name in the tailnet.*MagicDNS/s);
    }
  });

  it('says so when there is no IPv4 address', async () => {
    await assert.rejects(planPhone('auto', world({ status: status({}, { TailscaleIPs: ['fd7a:115c:a1e0::7'] }) }).deps), /no Tailscale IPv4 address/);
    await assert.rejects(planPhone('auto', world({ status: status({}, { TailscaleIPs: undefined }) }).deps), /no Tailscale IPv4 address/);
  });

  it('says so when the output is not JSON', async () => {
    await assert.rejects(planPhone('auto', world({ status: 'not json at all' }).deps), /could not ask Tailscale/);
  });

  it('asks for nothing and writes nothing when it stops early', async () => {
    const w = world({ status: status({ BackendState: 'Stopped' }) });
    await assert.rejects(planPhone('on', w.deps));
    assert.deepEqual(w.calls.map((c) => c[1]), ['status']);
    assert.equal(existsSync(path.join(w.dir, 'bridge.crt')), false);
  });
});
