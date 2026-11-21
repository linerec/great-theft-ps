// SPDX-License-Identifier: AGPL-3.0-only
//
// The whole picture path with a REAL console and a REAL browser: starts the bridge (the PS5 link), opens headless
// Chrome on the page, lets the page connect to the registered console, waits for decoded frames and saves a small
// picture of what the page drew. It sends no controller input, and it closes the connection at the end.
//
//   node tools/snap-console.mjs [--out picture.jpg]
//
// Needs Chrome or Edge, and a console registered on this computer that is on and reachable.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
let resolveReport;
const reported = new Promise((r) => (resolveReport = r));
const lines = [];
const bridge = await startBridge({
  host: '127.0.0.1', port: 0, root, store, research,
  log: (l) => lines.push(l),
  createLink: () => new Ps5Link({ store, research, log: (l) => lines.push(l) }),
  onE2eReport: (r) => resolveReport(r),
});

const profileDir = mkdtempSync(path.join(tmpdir(), 'gtp-snap-'));
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileDir}`, `${bridge.url}?snap=1`], { stdio: 'ignore', windowsHide: true });

let exitCode = 1;
try {
  const report = await Promise.race([reported, new Promise((_, rej) => setTimeout(() => rej(new Error('no report from the browser within 60 s')), 60000))]);
  for (const l of report.lines) console.log(l);
  const s = research.snapshot(0);
  if (s.stream) {
    const t = s.stream.totals;
    console.log(`bridge side: ${t.frames} frames, ${t.keyFrames} key, lost ${t.framesLost}, FEC rebuilt ${t.fecRecovered}, corrupt reports ${t.corruptReports}, longest gap ${t.maxFrameGapMs} ms`);
    console.log(`set-up times (ms): ${Object.entries(s.stream.stages).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  if (s.lastError) console.log(`link: ${s.lastError}`);
  if (typeof report.frame === 'string' && report.frame.startsWith('data:image/jpeg;base64,')) {
    writeFileSync(out, Buffer.from(report.frame.slice(23), 'base64'));
    console.log(`picture saved to ${out}`);
  } else console.log('no picture came back from the page');
  exitCode = report.pass ? 0 : 1;
} catch (e) {
  console.error(String(e.message ?? e));
  console.error(lines.slice(-12).join('\n'));
} finally {
  child.kill();
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
