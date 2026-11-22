// SPDX-License-Identifier: AGPL-3.0-only
//
// Keeping what each stream measured (src/bridge/runlog.ts) and the research hub's part in it.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FakeLink } from './support/fake-link.ts';
import { StreamResearch } from '../src/bridge/ps5-link.ts';
import { startBridge, type Bridge } from '../src/bridge/server.ts';
import { classifyClient, coarseDevice, formatRunTable, loadRuns, pathFromTailscaleStatus, probeWithin, RunWriter, summarizeRun } from '../src/bridge/runlog.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridges: Bridge[] = [];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'gtp-runs-'));
  dirs.push(d);
  return d;
};
after(async () => {
  for (const b of bridges) await b.close();
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const VIDEO = { width: 1280, height: 720, maxFps: 60, bitrateKbps: 8000, codec: 'h264' };

/** A stream of 100 seconds: 6000 frames, 60 lost, 10 MB, and what the page saw. */
function snapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  const samples = Array.from({ length: 100 }, (_, t) => ({ t, frameGapJitterMs: t < 50 ? 2 : 4 }));
  return {
    state: 'ended',
    lastError: '',
    video: VIDEO,
    client: { kind: 'tailnet', device: 'iPhone', paths: [{ t: 10, path: 'relay (sea)', os: 'iOS' }, { t: 100, path: 'direct', os: 'iOS' }] },
    stream: {
      elapsedMs: 100_000,
      totals: { frames: 6000, framesLost: 60, bytes: 10_000_000, unitsReceived: 9900, unitsLost: 100, fecRecovered: 40, idrRequests: 3, stutters: 2, maxFrameGapMs: 180, maxAssemblyMs: 22 },
      samples,
      events: [],
      audio: { frames: 9000, concealed: 1000 },
    },
    leg: { totals: { frames: 5700, dropped: 300 }, samples: [{ t: 0, frames: 60, kbps: 800, dropped: 3 }] },
    display: {
      totals: { hitches: 10, maxLateMs: 70, maxDecodeMs: 12, resyncs: 1 },
      samples: Array.from({ length: 100 }, (_, i) => ({ delayMs: 40 + (i % 2) * 20, rttMs: i < 90 ? 50 : 400 })),
      sound: 'playing',
    },
    ...over,
  };
}

describe('where a page connected from', () => {
  const cases: Array<[string | undefined, string | undefined, string]> = [
    ['127.0.0.1', undefined, 'this-computer'],
    ['::1', undefined, 'this-computer'],
    ['::ffff:127.0.0.1', undefined, 'this-computer'],
    ['100.64.0.2', '100.64.0.2', 'this-computer'], // a browser on the bridge's own computer, through its tailnet address
    ['100.64.0.9', '100.64.0.2', 'tailnet'],
    ['100.127.255.1', undefined, 'tailnet'],
    ['100.128.0.1', undefined, 'other'], // just outside 100.64.0.0/10
    ['100.63.255.255', undefined, 'other'],
    ['fd7a:115c:a1e0::1', undefined, 'tailnet'],
    ['::ffff:100.100.1.1', undefined, 'tailnet'],
    ['192.168.1.20', '192.168.1.5', 'local-network'],
    ['10.1.2.3', undefined, 'local-network'],
    ['172.16.0.1', undefined, 'local-network'],
    ['172.32.0.1', undefined, 'other'],
    ['169.254.1.1', undefined, 'local-network'],
    ['8.8.8.8', undefined, 'other'],
    [undefined, undefined, 'other'],
    ['not an address', undefined, 'other'],
  ];
  for (const [remote, local, want] of cases) {
    it(`${remote ?? '(nothing)'} → ${want}`, () => assert.equal(classifyClient(remote, local), want));
  }
});

describe('the kind of device', () => {
  it('tells phones, computers and the rest apart, and keeps nothing finer', () => {
    assert.equal(coarseDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1'), 'iPhone');
    assert.equal(coarseDevice('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15'), 'iPad');
    assert.equal(coarseDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120.0.0.0 Mobile Safari/537.36'), 'Android 14');
    assert.equal(coarseDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0'), 'Mac');
    assert.equal(coarseDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131'), 'Windows');
    assert.equal(coarseDevice('node'), 'unknown');
    assert.equal(coarseDevice(undefined), 'unknown');
  });
});

describe('the way to a tailnet client', () => {
  const status = {
    Self: { TailscaleIPs: ['100.64.0.1'] },
    Peer: {
      'nodekey:a': { TailscaleIPs: ['100.64.0.2', 'fd7a:115c:a1e0::2'], CurAddr: '203.0.113.7:41641', Relay: 'nyc', OS: 'iOS' },
      'nodekey:b': { TailscaleIPs: ['100.64.0.3'], CurAddr: '', Relay: 'sea', OS: 'macOS' },
      'nodekey:c': { TailscaleIPs: ['100.64.0.4'], CurAddr: '', Relay: '', OS: 'windows' },
    },
  };
  it('says "direct" when the peer has a direct address, and does not keep that address', () => {
    const p = pathFromTailscaleStatus(status, '100.64.0.2');
    assert.deepEqual(p, { path: 'direct', os: 'iOS' });
    assert.ok(!JSON.stringify(p).includes('203.0.113'));
  });
  it('names the relay region when there is no direct address', () => assert.deepEqual(pathFromTailscaleStatus(status, '100.64.0.3'), { path: 'relay (sea)', os: 'macOS' }));
  it('says "unknown" when neither is known', () => assert.deepEqual(pathFromTailscaleStatus(status, '100.64.0.4'), { path: 'unknown', os: 'windows' }));
  it('finds a peer by its IPv6 address and by a mapped IPv4 address', () => {
    assert.equal(pathFromTailscaleStatus(status, 'fd7a:115c:a1e0::2')?.path, 'direct');
    assert.equal(pathFromTailscaleStatus(status, '::ffff:100.64.0.3')?.path, 'relay (sea)');
  });
  it('gives null for a peer it does not know and for output that is not what it expects', () => {
    assert.equal(pathFromTailscaleStatus(status, '100.64.0.99'), null);
    assert.equal(pathFromTailscaleStatus(null, '100.64.0.2'), null);
    assert.equal(pathFromTailscaleStatus({ Peer: 'x' }, '100.64.0.2'), null);
    assert.equal(pathFromTailscaleStatus({ Peer: { a: { TailscaleIPs: 'nope' } } }, '100.64.0.2'), null);
  });
  it('cleans what it keeps (a region or OS name is not trusted text)', () => {
    const p = pathFromTailscaleStatus({ Peer: { a: { TailscaleIPs: ['100.64.0.5'], CurAddr: '', Relay: 'sea<script>x', OS: 'iOS\n\u0000' } } }, '100.64.0.5');
    assert.equal(p?.path, 'relay (seascriptx)');
    assert.equal(p?.os, 'iOS');
  });
});

describe('asking within a time limit', () => {
  it('returns what the probe found', async () => assert.deepEqual(await probeWithin(async () => ({ path: 'direct', os: 'iOS' }), '100.64.0.2', 500), { path: 'direct', os: 'iOS' }));
  it('gives null when the probe is too slow, without waiting for it', async () => {
    const t = Date.now();
    assert.equal(await probeWithin(() => new Promise(() => {}), '100.64.0.2', 60), null);
    assert.ok(Date.now() - t < 400);
  });
  it('gives null when the probe fails', async () => assert.equal(await probeWithin(() => Promise.reject(new Error('no tailscale')), '100.64.0.2', 500), null));
});

describe('the summary of a stream', () => {
  it('works out the numbers worth comparing', () => {
    const s = summarizeRun(snapshot());
    assert.equal(s.seconds, 100);
    assert.equal(s.asked, '1280x720 @60, 8000 kbps');
    assert.equal(s.client, 'tailnet · iPhone · relay (sea)→direct');
    assert.deepEqual(s.fromConsole, { fps: 60, kbps: 800, framesLostPct: 0.99, unitsLostPct: 1, fecRecovered: 40, idrRequests: 3, stutters: 2, maxFrameGapMs: 180, jitterMs: 3, maxAssemblyMs: 22 });
    assert.deepEqual(s.toPage, { sent: 5700, dropped: 300, droppedPct: 5 });
    assert.deepEqual(s.onScreen, { hitches: 10, hitchesPerMin: 6, delayMs: 50, maxLateMs: 70, maxDecodeMs: 12, resyncs: 1, rttMedianMs: 50, rttP95Ms: 400, rttMaxMs: 400, sound: 'playing' });
    assert.deepEqual(s.sound, { frames: 9000, concealed: 1000, concealedPct: 10 });
    assert.equal(s.error, '');
  });

  it('copes with a stream nobody watched on a page, and with an empty or odd snapshot', () => {
    const s = summarizeRun(snapshot({ display: null, leg: null, client: null }));
    assert.equal(s.onScreen, null);
    assert.deepEqual(s.toPage, { sent: 0, dropped: 0, droppedPct: 0 });
    assert.equal(s.client, '?');
    const empty = summarizeRun({});
    assert.equal(empty.seconds, 0);
    assert.equal(empty.asked, '?');
    assert.equal(empty.fromConsole.framesLostPct, 0, 'no division by zero');
    assert.doesNotThrow(() => summarizeRun({ stream: 'x', display: 5, leg: [], client: 'y' } as never));
  });

  it('leaves an RTT out of the figures when the page never reported one', () => {
    const s = summarizeRun(snapshot({ display: { totals: {}, samples: [{ delayMs: 40 }] } }));
    assert.equal(s.onScreen?.rttMedianMs, 0);
    assert.match(formatRunTable([{ savedAt: '2026-11-22T10:00:00.000Z', summary: s }]), / -  /);
  });
});

describe('the files', () => {
  it('writes one file per stream with the summary on top, private to its owner', () => {
    const dir = tmp();
    const w = new RunWriter({ dir, now: () => new Date('2026-11-22T10:31:05.123Z') });
    const name = w.write(snapshot());
    assert.equal(name, '2026-11-22T10-31-05-tailnet.json');
    const mode = statSync(path.join(dir, name!)).mode & 0o777;
    assert.equal(mode, 0o600);
    const runs = loadRuns(dir);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.summary.seconds, 100);
    assert.equal(runs[0]!.savedAt, '2026-11-22T10:31:05.123Z');
    assert.deepEqual((runs[0]!.snapshot.leg as { totals: unknown }).totals, { frames: 5700, dropped: 300 });
  });

  it('does not keep a stream that was over at once', () => {
    const dir = tmp();
    const w = new RunWriter({ dir });
    assert.equal(w.write(snapshot({ stream: { elapsedMs: 2000, totals: {} } })), null);
    assert.equal(w.write({}), null);
    assert.equal(existsSync(dir) ? readdirSync(dir).length : 0, 0);
  });

  it('keeps only the newest ones', () => {
    const dir = tmp();
    let n = 0;
    const w = new RunWriter({ dir, keep: 3, now: () => new Date(Date.UTC(2026, 10, 22, 10, 0, n++)) });
    for (let i = 0; i < 5; i++) w.write(snapshot());
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ['2026-11-22T10-00-02-tailnet.json', '2026-11-22T10-00-03-tailnet.json', '2026-11-22T10-00-04-tailnet.json']);
  });

  it('leaves other files in the folder alone when it clears out old runs, and reads an absent folder as no runs', () => {
    const dir = tmp();
    const w = new RunWriter({ dir, keep: 1 });
    w.write(snapshot());
    writeFileSync(path.join(dir, 'notes.txt'), 'mine');
    writeFileSync(path.join(dir, 'a-run-of-someone-else.json'), '{}');
    w.write(snapshot({ client: { kind: 'this-computer', device: 'Mac', paths: [] } }));
    const files = readdirSync(dir).sort();
    assert.equal(files.filter((f) => /^\d{4}-/.test(f)).length, 1, 'only one run is left');
    assert.ok(files.includes('notes.txt') && files.includes('a-run-of-someone-else.json'), 'what is not a run stays');
    assert.deepEqual(loadRuns(path.join(dir, 'absent')), []);
  });

  it('skips a damaged file', () => {
    const dir = tmp();
    new RunWriter({ dir }).write(snapshot());
    writeFileSync(path.join(dir, '2026-01-01T00-00-00-other.json'), '{not json');
    writeFileSync(path.join(dir, '2026-01-02T00-00-00-other.json'), JSON.stringify({ version: 2 }));
    assert.equal(loadRuns(dir).length, 1);
  });

  it('keeps no address in what it writes', () => {
    const dir = tmp();
    new RunWriter({ dir }).write(snapshot());
    const text = readFileSync(path.join(dir, readdirSync(dir)[0]!), 'utf8');
    assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(text.replace(/"(maxAssemblyMs|frameGapJitterMs)":[\d.]+/g, '')), 'no IPv4 address');
  });
});

describe('the table', () => {
  it('has a line per run under one header, aligned', () => {
    const a = summarizeRun(snapshot());
    const b = summarizeRun(snapshot({ client: { kind: 'this-computer', device: 'Mac', paths: [] }, leg: { totals: { frames: 6000, dropped: 0 }, samples: [{}] } }));
    const table = formatRunTable([
      { savedAt: '2026-11-22T10:31:05.000Z', summary: a },
      { savedAt: '2026-11-22T10:40:00.000Z', summary: b },
    ]);
    const lines = table.split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /^saved\s+from\s+length\s+asked\s+kbps/);
    assert.match(lines[1]!, /^11-22 10:31\s+tailnet · iPhone · relay \(sea\)→direct\s+1m40s\s+1280x720 @60, 8000 kbps\s+800/);
    assert.match(lines[2]!, /this-computer · Mac/);
    assert.equal(lines[1]!.indexOf('1m40s'), lines[2]!.indexOf('1m40s'), 'columns line up');
  });
});

describe('the research hub keeps a stream when it ends', () => {
  const video = VIDEO as never;

  it('hands over everything measured, once, however many ways there are to end', () => {
    const r = new StreamResearch();
    const kept: Array<Record<string, unknown>> = [];
    r.onFinished = (s) => void kept.push(s);
    r.begin(video);
    r.state = 'streaming';
    r.setClient({ kind: 'tailnet', device: 'iPhone' });
    r.finish('the console closed it');
    r.finish('again');
    assert.equal(kept.length, 1);
    assert.equal(r.state, 'ended');
    assert.equal(r.lastError, 'the console closed it');
    assert.equal(kept[0]!.lastError, 'the console closed it', 'the reason is in what was kept');
    assert.deepEqual((kept[0]!.client as { kind: string }).kind, 'tailnet');
  });

  it('keeps nothing when no stream was begun or when it already ended', () => {
    const r = new StreamResearch();
    let n = 0;
    r.onFinished = () => void n++;
    r.finish();
    assert.equal(n, 0);
    assert.equal(r.state, 'idle');
    r.begin(video);
    r.finish();
    r.finish();
    assert.equal(n, 1);
  });

  it('is not held up by a failing keeper', () => {
    const r = new StreamResearch();
    r.onFinished = () => {
      throw new Error('disk full');
    };
    r.begin(video);
    assert.doesNotThrow(() => r.finish('x'));
    assert.equal(r.state, 'ended');
  });

  it('counts the frames sent to the page and the ones left out, only while streaming', () => {
    const r = new StreamResearch();
    r.addLeg({ frames: 60, kbps: 800, dropped: 0 });
    r.begin(video);
    r.addLeg({ frames: 60, kbps: 800, dropped: 0 });
    assert.equal(r.snapshot().leg, null, 'not before the stream is up');
    r.state = 'streaming';
    r.addLeg({ frames: 58, kbps: 790, dropped: 2 });
    r.addLeg({ frames: 60, kbps: 810, dropped: 0 });
    const leg = r.snapshot().leg as { totals: { frames: number; dropped: number }; samples: unknown[] };
    assert.deepEqual(leg.totals, { frames: 118, dropped: 2 });
    assert.equal(leg.samples.length, 2);
    r.finish();
    r.addLeg({ frames: 60, kbps: 800, dropped: 0 });
    assert.equal((r.snapshot().leg as { samples: unknown[] }).samples.length, 2, 'nothing after it ended');
  });

  it('starts every stream with nothing left from the last one', () => {
    const r = new StreamResearch();
    r.begin(video);
    r.state = 'streaming';
    r.setClient({ kind: 'tailnet', device: 'iPhone' });
    r.addLeg({ frames: 60, kbps: 800, dropped: 1 });
    r.addDisplay({ sound: 'playing', rttMs: 40, shown: 60 });
    r.finish();
    r.begin(video);
    assert.equal(r.client, null);
    assert.equal(r.snapshot().leg, null);
    assert.equal(r.snapshot().display, null);
    assert.equal(r.display.sound, '');
  });

  it('keeps at most four looks at the way to the client', () => {
    const r = new StreamResearch();
    r.notePath({ path: 'direct', os: 'iOS' });
    assert.equal(r.client, null, 'nobody is connected');
    r.begin(video);
    r.setClient({ kind: 'tailnet', device: 'iPhone' });
    for (let i = 0; i < 9; i++) r.notePath({ path: i % 2 ? 'direct' : 'relay (sea)', os: 'iOS' });
    assert.equal(r.client!.paths.length, 4);
  });

  it('takes the page\'s own round trip and sound state, and nothing it should not', () => {
    const r = new StreamResearch();
    r.begin(video);
    r.addDisplay({ rttMs: 42.5, shown: 60, sound: 'playing' });
    r.addDisplay({ rttMs: 'slow', shown: 60, sound: '<script>' });
    r.addDisplay({ rttMs: 1e12, shown: 60, sound: 'muted' });
    assert.deepEqual(r.display.samples.map((s) => s.rttMs), [42.5, 0, 60000]);
    assert.equal(r.display.sound, 'muted');
    r.addDisplay({ shown: 1, sound: 'nonsense' });
    assert.equal(r.display.sound, 'muted', 'an unknown state is not kept');
  });
});

describe('the bridge notes who connected and how the way to the page did', () => {
  it('records the kind of client and, second by second, what it sent to the page', async () => {
    const research = new StreamResearch();
    research.begin(VIDEO as never);
    research.state = 'streaming'; // a real link does this when the console accepts the session
    let probed = 0;
    const bridge = await startBridge({
      host: '127.0.0.1',
      port: 0,
      root,
      research,
      pathProbe: async () => (probed++, { path: 'direct', os: 'x' }),
      createLink: () => new FakeLink(),
    });
    bridges.push(bridge);
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
    ws.binaryType = 'arraybuffer';
    let ready = false;
    ws.onmessage = (e) => {
      if (typeof e.data === 'string' && JSON.parse(e.data).type === 'ready') ready = true;
    };
    await new Promise<void>((resolve, reject) => ((ws.onopen = () => resolve()), (ws.onerror = () => reject(new Error('ws error')))));
    ws.send(JSON.stringify({ type: 'hello', client: 'test' }));
    for (let i = 0; i < 100 && !ready; i++) await sleep(10);
    assert.equal(research.client?.kind, 'this-computer', 'a page on the bridge\'s own computer');
    assert.equal(research.client?.device, 'unknown', 'a test client says nothing about itself');
    for (let i = 0; i < 200 && research.leg.samples.length < 2; i++) await sleep(10);
    const leg = research.snapshot().leg as { totals: { frames: number; dropped: number }; samples: Array<{ frames: number; kbps: number; dropped: number }> };
    assert.ok(leg.samples.length >= 2, 'one sample a second');
    assert.ok(leg.samples[0]!.frames > 0 && leg.samples[0]!.kbps > 0, 'frames and bits were sent');
    assert.equal(leg.totals.dropped, 0, 'a page that keeps up loses nothing');
    assert.equal(probed, 0, 'the way to a client on this computer is not worth asking about');
    ws.close();
  });
});
