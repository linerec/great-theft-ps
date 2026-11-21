// SPDX-License-Identifier: AGPL-3.0-only
//
// The whole picture path with a REAL console and a REAL browser: starts the bridge (the PS5 link), opens headless
// Chrome on the page, lets the page connect to the registered console, waits for decoded frames and saves a small
// picture of what the page drew. It closes the connection at the end.
//
//   node tools/snap-console.mjs [--out picture.jpg] [--nudge]
//   node tools/snap-console.mjs --watch 60 [--playout smooth|immediate|<ms>] [--quality quality] [--stats run.json]
//   node tools/snap-console.mjs --latency 20 [--link-sim lte-average]
//
// --latency presses the d-pad down and up that many times and measures the time from each press to the picture
// changing. The console has to show a screen where the d-pad moves a selection (a menu); the selection ends where it
// began when the number is even. --link-sim puts a simulated mobile network between the bridge and the page.
//
// --watch keeps the stream open for that many seconds and prints what went on the screen: frames shown, hitches (the
// screen stood still for more than two and a half frame times), frames that came after their slot. Run it once with
// --playout immediate and once with --playout smooth to compare the two on the same network.
//
// Without --nudge it sends no controller input. With it, the page presses the d-pad down once and up once (the same
// path a key press takes) and takes a picture before, between and after: one step down and one step back, to see
// that input reaches the console. Pictures are saved as picture.jpg, picture-2.jpg, picture-3.jpg.
//
// Needs Chrome or Edge, and a console registered on this computer that is on and reachable.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Handover } from '../src/bridge/handover.ts';
import { LINK_PROFILES, parseLinkSim } from '../src/bridge/linksim.ts';
import { Ps5Link, StreamResearch } from '../src/bridge/ps5-link.ts';
import { startBridge } from '../src/bridge/server.ts';
import { ConsoleStore, defaultStorePath } from '../src/console/store.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(tmpdir(), 'gtp-console-snap.jpg');
const candidates = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const chrome = candidates.find((p) => existsSync(p));
if (!chrome) {
  console.error('No Chrome/Edge found. Set CHROME to its path.');
  process.exit(2);
}

const store = new ConsoleStore(defaultStorePath());
if (store.list().length === 0) {
  console.error('No console is registered on this computer.');
  process.exit(1);
}
const research = new StreamResearch();
// This tool takes part in the handover like any client, unlocked: when the person connects from a page while it is
// measuring, it lets go at once instead of keeping the console from them.
const handover = new Handover({ store, name: 'measurement tool' });
await handover.start();
const arg = (name) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);
const watchSeconds = Number(arg('watch') ?? 0);
const latencyTries = Number(arg('latency') ?? 0);
const linkSim = arg('link-sim') ? parseLinkSim(arg('link-sim')) : null;
if (arg('link-sim') && !linkSim) {
  console.error(`--link-sim must be one of ${Object.keys(LINK_PROFILES).join(', ')}, or five numbers: delay,jitter,stallMs,stallEveryMs,kbps`);
  process.exit(2);
}
let resolveReport;
const reported = new Promise((r) => (resolveReport = r));
const lines = [];
const bridge = await startBridge({
  host: '127.0.0.1', port: 0, root, store, research,
  ...(linkSim ? { linkSim } : {}),
  log: (l) => lines.push(l),
  createLink: () => new Ps5Link({ store, research, handover, log: (l) => lines.push(l) }),
  onE2eReport: (r) => resolveReport(r),
});

const pageOptions = [
  watchSeconds > 0 ? `&watch=${watchSeconds}` : '',
  latencyTries > 0 ? `&latency=${latencyTries}` : '',
  arg('playout') ? `&playout=${encodeURIComponent(arg('playout'))}` : '',
  arg('quality') ? `&quality=${encodeURIComponent(arg('quality'))}` : '',
].join('');
const profileDir = mkdtempSync(path.join(tmpdir(), 'gtp-snap-'));
const child = spawn(chrome, ['--headless=new', ...(process.argv.includes('--no-gpu') ? ['--disable-gpu'] : []), '--no-first-run', `--user-data-dir=${profileDir}`, `${bridge.url}?snap=1${process.argv.includes('--nudge') ? '&nudge=1' : ''}${pageOptions}`], { stdio: 'ignore', windowsHide: true });

let exitCode = 1;
try {
  const limit = 60 + watchSeconds + latencyTries * 4;
  if (linkSim) console.log(`simulated link: ${arg('link-sim')} (${linkSim.note})`);
  const report = await Promise.race([reported, new Promise((_, rej) => setTimeout(() => rej(new Error(`no report from the browser within ${limit} s`)), limit * 1000))]);
  for (const l of report.lines) console.log(l);
  const whole = research.snapshot();
  if (whole.display) {
    // What the viewer saw, second by second, as the page reported it.
    const d = whole.display;
    console.log(`screen: ${d.totals.shown} frames shown, ${d.totals.hitches} hitches, ${d.totals.underruns} frames after their slot, ${d.totals.skipped} skipped, longest standstill ${d.totals.maxGapMs} ms, latest frame ${d.totals.maxLateMs} ms`);
    console.log(`decoder: slowest frame ${d.totals.maxDecodeMs} ms, restarts from a key frame because it fell behind: ${d.totals.resyncs}`);
    const rough = d.samples.filter((x) => x.hitches > 0 || x.underruns > 0 || x.lateMaxMs > 25);
    for (const x of rough.slice(0, 40)) console.log(`  second ${String(x.t).padStart(3)}: shown ${x.shown}, longest standstill ${x.gapMaxMs} ms, hitches ${x.hitches}, after slot ${x.underruns}, latest ${x.lateMaxMs} ms, delay ${x.delayMs} ms, decode ${x.decodeMaxMs} ms (queue ${x.decodeQueueMax})`);
  }
  if (arg('stats')) {
    writeFileSync(arg('stats'), JSON.stringify(whole, null, 1));
    console.log(`measurements saved to ${arg('stats')}`);
  }
  const s = research.snapshot(0);
  if (s.stream) {
    const t = s.stream.totals;
    console.log(`bridge side: ${t.frames} frames, ${t.keyFrames} key, lost ${t.framesLost}, FEC rebuilt ${t.fecRecovered}, corrupt reports ${t.corruptReports}, longest gap ${t.maxFrameGapMs} ms`);
    console.log(`set-up times (ms): ${Object.entries(s.stream.stages).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  if (s.lastError) console.log(`link: ${s.lastError}`);
  const pictures = (Array.isArray(report.frames) ? report.frames : []).filter((f) => typeof f === 'string' && f.startsWith('data:image/jpeg;base64,'));
  pictures.forEach((f, i) => {
    const file = i === 0 ? out : out.replace(/(\.\w+)?$/, (ext) => `-${i + 1}${ext}`);
    writeFileSync(file, Buffer.from(f.slice(23), 'base64'));
    console.log(`picture saved to ${file}`);
  });
  if (pictures.length === 0) console.log('no picture came back from the page');
  exitCode = report.pass ? 0 : 1;
} catch (e) {
  console.error(String(e.message ?? e));
  console.error(lines.slice(-12).join('\n'));
} finally {
  child.kill();
  handover.close();
  await bridge.close();
  setTimeout(() => {
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* the browser may still hold files for a moment */
    }
    process.exit(exitCode);
  }, 800);
}
