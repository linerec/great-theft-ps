// SPDX-License-Identifier: AGPL-3.0-only
//
// Keeping what each stream measured, so that ways of connecting can be compared afterwards: the same game on the home
// network, over Wi-Fi, over a mobile line, with or without the bridge's own hop. This project's own.
//
// When a stream ends, the bridge writes everything it measured (both ends: how frames arrived from the console, what
// the bridge managed to send to the page, what the page put on the screen) to one JSON file in a local folder, with a
// summary on top. `npm run runs` prints the summaries side by side.
//
// What is kept about the person watching is coarse on purpose: where the page connected from (this computer, the
// tailnet, the local network, elsewhere), the kind of device, and for a tailnet client whether the path was direct or
// went through a relay. No addresses, no names. The files stay on the computer that runs the bridge.

import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ClientKind = 'this-computer' | 'tailnet' | 'local-network' | 'other';

/** Where a page connected from, from the address the socket shows. `local` is the address it connected to. */
export function classifyClient(remote: string | undefined, local?: string): ClientKind {
  if (!remote) return 'other';
  const norm = (a: string): string => a.replace(/^::ffff:/i, '').toLowerCase();
  const r = norm(remote);
  if (local && r === norm(local)) return 'this-computer';
  if (r === '::1' || r.startsWith('127.')) return 'this-computer';
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(r);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 100 && b >= 64 && b <= 127) return 'tailnet';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return 'local-network';
    return 'other';
  }
  if (r.startsWith('fd7a:115c:a1e0:')) return 'tailnet';
  if (r.startsWith('fe80:') || r.startsWith('fc') || r.startsWith('fd')) return 'local-network';
  return 'other';
}

/** The kind of device, from the browser's own description. Coarse: it is for telling runs apart, not for tracking. */
export function coarseDevice(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const iphone = /iPhone OS (\d+)[_.](\d+)/.exec(ua);
  if (iphone) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  const android = /Android (\d+)/.exec(ua);
  if (android) return `Android ${android[1]}`;
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'unknown';
}

export interface TailscalePath {
  /** 'direct', 'relay (<region>)' or 'unknown'. */
  path: string;
  os: string;
}

/** What `tailscale status --json` says about the way to the peer with that tailnet address. The peer's own address is not kept. */
export function pathFromTailscaleStatus(status: unknown, clientIp: string): TailscalePath | null {
  const peers = (status as { Peer?: Record<string, unknown> } | null)?.Peer;
  if (!peers || typeof peers !== 'object') return null;
  const want = clientIp.replace(/^::ffff:/i, '');
  for (const p of Object.values(peers)) {
    const peer = p as { TailscaleIPs?: unknown; CurAddr?: unknown; Relay?: unknown; OS?: unknown } | null;
    if (!peer || !Array.isArray(peer.TailscaleIPs) || !peer.TailscaleIPs.includes(want)) continue;
    const direct = typeof peer.CurAddr === 'string' && peer.CurAddr !== '';
    const relay = typeof peer.Relay === 'string' ? peer.Relay.replace(/[^a-z0-9-]/gi, '').slice(0, 12) : '';
    return { path: direct ? 'direct' : relay ? `relay (${relay})` : 'unknown', os: typeof peer.OS === 'string' ? peer.OS.replace(/[^a-z0-9 ._-]/gi, '').slice(0, 20) : '' };
  }
  return null;
}

export type PathProbe = (clientIp: string) => Promise<TailscalePath | null>;

/** Asks the local Tailscale. Null when it is not there or does not answer in time. */
export const probeTailscalePath: PathProbe = (clientIp) =>
  new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 4000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        resolve(pathFromTailscaleStatus(JSON.parse(stdout), clientIp));
      } catch {
        resolve(null);
      }
    });
  });

/** Asks the probe, but gives up after `ms` (a slow or failing probe must not hold up ending a stream). */
export async function probeWithin(probe: PathProbe, clientIp: string, ms: number): Promise<TailscalePath | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([probe(clientIp).catch(() => null), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------------------------------------ the summary

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round = (v: number, digits = 1): number => Math.round(v * 10 ** digits) / 10 ** digits;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (part: number, whole: number): number => (whole > 0 ? round((100 * part) / whole, 2) : 0);
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

export interface RunSummary {
  seconds: number;
  /** What was asked of the console, e.g. "1280x720 @60, 8000 kbps". */
  asked: string;
  client: string;
  /** How the way from the console to the bridge did. */
  fromConsole: { fps: number; kbps: number; framesLostPct: number; unitsLostPct: number; fecRecovered: number; idrRequests: number; stutters: number; maxFrameGapMs: number; jitterMs: number; maxAssemblyMs: number };
  /** How the way from the bridge to the page did: frames left out because the page was behind. */
  toPage: { sent: number; dropped: number; droppedPct: number };
  /** What the page put on the screen. Null when the page reported nothing. */
  onScreen: null | { hitches: number; hitchesPerMin: number; delayMs: number; maxLateMs: number; maxDecodeMs: number; resyncs: number; rttMedianMs: number; rttP95Ms: number; rttMaxMs: number; sound: string };
  /** The console's sound as it arrived at the bridge. */
  sound: { frames: number; concealed: number; concealedPct: number };
  /** If the run did not end well. */
  error: string;
}

/** The numbers worth comparing, from everything one stream measured (StreamResearch.snapshot()). */
export function summarizeRun(snapshot: Obj): RunSummary {
  const stream = obj(snapshot.stream);
  const totals = obj(stream.totals);
  const samples = arr(stream.samples);
  const seconds = Math.max(0, Math.round(num(stream.elapsedMs) / 1000));
  const frames = num(totals.frames);
  const video = obj(snapshot.video);
  const asked = video.width ? `${num(video.width)}x${num(video.height)} @${num(video.maxFps)}, ${num(video.bitrateKbps)} kbps` : '?';
  const client = obj(snapshot.client);
  const paths = arr(client.paths).map((p) => `${p.path}`);
  const clientText = [client.kind ?? '?', client.device && client.device !== 'unknown' ? client.device : '', paths.length ? [...new Set(paths)].join('→') : ''].filter(Boolean).join(' · ');

  const leg = obj(snapshot.leg);
  const legTotals = obj(leg.totals);
  const sent = num(legTotals.frames);
  const dropped = num(legTotals.dropped);

  const display = obj(snapshot.display);
  const dTotals = obj(display.totals);
  const dSamples = arr(display.samples);
  const rtts = dSamples.map((s) => num(s.rttMs)).filter((x) => x > 0).sort((a, b) => a - b);
  const onScreen =
    dSamples.length === 0
      ? null
      : {
          hitches: num(dTotals.hitches),
          hitchesPerMin: round(num(dTotals.hitches) / Math.max(1, dSamples.length / 60), 1),
          delayMs: round(mean(dSamples.map((s) => num(s.delayMs))), 0),
          maxLateMs: round(num(dTotals.maxLateMs), 0),
          maxDecodeMs: round(num(dTotals.maxDecodeMs), 0),
          resyncs: num(dTotals.resyncs),
          rttMedianMs: round(percentile(rtts, 0.5), 0),
          rttP95Ms: round(percentile(rtts, 0.95), 0),
          rttMaxMs: round(rtts.length ? rtts[rtts.length - 1]! : 0, 0),
          sound: typeof display.sound === 'string' ? display.sound : '',
        };

  const audio = obj(stream.audio);
  return {
    seconds,
    asked,
    client: clientText,
    fromConsole: {
      fps: round(seconds > 0 ? frames / seconds : 0, 1),
      kbps: round(seconds > 0 ? (num(totals.bytes) * 8) / 1000 / seconds : 0, 0),
      framesLostPct: pct(num(totals.framesLost), frames + num(totals.framesLost)),
      unitsLostPct: pct(num(totals.unitsLost), num(totals.unitsReceived) + num(totals.unitsLost)),
      fecRecovered: num(totals.fecRecovered),
      idrRequests: num(totals.idrRequests),
      stutters: num(totals.stutters),
      maxFrameGapMs: round(num(totals.maxFrameGapMs), 0),
      jitterMs: round(mean(samples.map((s) => num(s.frameGapJitterMs)).filter((x) => x > 0)), 1),
      maxAssemblyMs: round(num(totals.maxAssemblyMs), 0),
    },
    toPage: { sent, dropped, droppedPct: pct(dropped, sent + dropped) },
    onScreen,
    sound: { frames: num(audio.frames), concealed: num(audio.concealed), concealedPct: pct(num(audio.concealed), num(audio.frames) + num(audio.concealed)) },
    error: typeof snapshot.lastError === 'string' ? snapshot.lastError : '',
  };
}

// ------------------------------------------------------------------------------------------------ the files

export interface RunRecord {
  version: 1;
  savedAt: string;
  summary: RunSummary;
  snapshot: Obj;
}

export interface RunWriterOptions {
  dir: string;
  /** How many runs to keep; older ones are deleted. Default 100. */
  keep?: number;
  /** Streams shorter than this are not kept (a connection that failed at once has nothing to compare). Default 5 seconds. */
  minSeconds?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export class RunWriter {
  #o: Required<Omit<RunWriterOptions, 'log'>> & { log?: (line: string) => void };

  constructor(o: RunWriterOptions) {
    this.#o = { keep: 100, minSeconds: 5, now: () => new Date(), ...o };
  }

  /** Writes one run. Returns the file name, or null when the stream was too short to keep. */
  write(snapshot: Obj): string | null {
    const summary = summarizeRun(snapshot);
    if (summary.seconds < this.#o.minSeconds) return null;
    mkdirSync(this.#o.dir, { recursive: true, mode: 0o700 });
    const at = this.#o.now();
    const kind = String(obj(snapshot.client).kind ?? 'unknown').replace(/[^a-z-]/g, '');
    const name = `${at.toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${kind}.json`;
    const record: RunRecord = { version: 1, savedAt: at.toISOString(), summary, snapshot };
    writeFileSync(join(this.#o.dir, name), JSON.stringify(record), { mode: 0o600 });
    this.#prune();
    this.#o.log?.(`run saved: ${name} (${summary.seconds} s, ${summary.client})`);
    return name;
  }

  #prune(): void {
    const files = readdirSync(this.#o.dir).filter((f) => /^\d{4}-\d\d-\d\dT[\d-]+-[a-z-]+\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - this.#o.keep))) {
      try {
        unlinkSync(join(this.#o.dir, f));
      } catch {
        /* already gone */
      }
    }
  }
}

/** The kept runs, oldest first. A file that cannot be read is skipped. */
export function loadRuns(dir: string): Array<RunRecord & { file: string }> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: Array<RunRecord & { file: string }> = [];
  for (const file of files) {
    try {
      const r = JSON.parse(readFileSync(join(dir, file), 'utf8')) as RunRecord;
      if (r.version === 1 && r.summary) out.push({ ...r, file });
    } catch {
      /* skipped */
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the table

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/** One line per run, the numbers that tell ways of connecting apart. */
export function formatRunTable(runs: Array<Pick<RunRecord, 'savedAt' | 'summary'>>): string {
  const rows: string[][] = [['saved', 'from', 'length', 'asked', 'kbps', 'lost fr %', 'lost units %', 'FEC saved', 'stutters', 'max gap ms', 'to page dropped %', 'hitches/min', 'shown delay ms', 'RTT med/p95 ms', 'sound concealed %']];
  for (const { savedAt, summary: s } of runs) {
    const d = s.onScreen;
    rows.push([
      savedAt.slice(5, 16).replace('T', ' '),
      s.client || '?',
      `${Math.floor(s.seconds / 60)}m${String(s.seconds % 60).padStart(2, '0')}s`,
      s.asked,
      String(s.fromConsole.kbps),
      String(s.fromConsole.framesLostPct),
      String(s.fromConsole.unitsLostPct),
      String(s.fromConsole.fecRecovered),
      String(s.fromConsole.stutters),
      String(s.fromConsole.maxFrameGapMs),
      String(s.toPage.droppedPct),
      d ? String(d.hitchesPerMin) : '-',
      d ? String(d.delayMs) : '-',
      d && d.rttMedianMs > 0 ? `${d.rttMedianMs}/${d.rttP95Ms}` : '-',
      String(s.sound.concealedPct),
    ]);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => pad(c, widths[i]!)).join('  ').trimEnd()).join('\n');
}
