// SPDX-License-Identifier: AGPL-3.0-only
//
// End-to-end check, in a REAL browser, of the page's measuring of a game's response to the right stick
// (web/calibrate-console.ts): the bridge has a made-up game behind it (test/support/game-link.ts) whose camera turns by a
// known table; headless Chrome opens the page, presses the panel's button, and what it found is compared with the truth.
// Needs Chrome or Edge; run with `npm run e2e:look`. Takes about a minute.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GameLink } from '../test/support/game-link.ts';
import { flickRate } from '../test/support/lookworld.ts';
import { rateAt } from '../src/engine/calibration.ts';
import { startBridge } from '../src/bridge/server.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const chrome = candidates.find((c) => existsSync(c));
if (!chrome) {
  console.error('No Chrome/Edge found. Set CHROME to its path.');
  process.exit(2);
}

// The truth: a deadzone of 0.22, 200 degrees a second at full deflection, a camera that works up to speed over 300 ms.
const game = { table: [[0, 0], [0.22, 0], [1, 200]], latencyMs: 80, rampStart: 0.6, rampMs: 300, verticalRatio: 0.6, fps: 30 };
let link;
let resolveReport;
const reported = new Promise((r) => (resolveReport = r));
const bridge = await startBridge({ host: '127.0.0.1', port: 0, root, createLink: () => (link = new GameLink(game)), onE2eReport: (r) => resolveReport(r) });
const profileDir = mkdtempSync(path.join(tmpdir(), 'gtp-e2e-look-'));
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profileDir}`, `${bridge.url}?e2e=look`], { stdio: 'ignore', windowsHide: true });

let exitCode = 1;
try {
  const report = await Promise.race([reported, new Promise((_, rej) => setTimeout(() => rej(new Error('no report from the browser within 170 s')), 170000))]);
  console.log(report.lines.join('\n'));
  const lines = [];
  const check = (name, ok, detail = '') => lines.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  const r = report.result;
  let good = report.pass && !!r;
  if (r) {
    const near = (a, b, rel, abs) => Math.abs(a - b) <= rel * b + abs;
    check('the scale came from a full turn of the camera', r.scaleSource === 'turn', `${r.pxPerDeg?.toFixed(2)} px/deg, ${r.scaleSource}`);
    check('the delay found is plausible (the game\'s own 80 ms and the pipeline, less the picture rate\'s granularity)', r.latencyMs >= 40 && r.latencyMs <= 400, `${r.latencyMs} ms`);
    check('the deadzone is found', near(r.innerDeadzone, 0.22, 0, 0.06), r.innerDeadzone.toFixed(3));
    for (const s of [0.3, 0.4, 0.5, 0.6, 0.8, 1]) {
      const want = flickRate(game, s, game.latencyMs + 100, game.latencyMs + 700);
      const got = rateAt(r.table, s);
      check(`stick ${s}: the rate the game gives`, near(got, want, 0.14, 3), `${got.toFixed(1)} found, ${want.toFixed(1)} true`);
    }
    check('up and down are measured', r.verticalRateRatio !== null && r.verticalRateRatio > 0.35 && r.verticalRateRatio < 0.9, String(r.verticalRateRatio));
    check('only the right stick was touched', link.strayInput === 0, `${link.strayInput} stray pads`);
    const last = link.sticks.at(-1);
    check('the stick was let go at the end', !last || (last.x === 0 && last.y === 0), JSON.stringify(last));
    check('warnings', r.warnings.length === 0, r.warnings.map((w) => w.code).join(', ') || 'none');
    good = good && lines.every((l) => l.startsWith('ok'));
  }
  console.log(lines.join('\n'));
  exitCode = good ? 0 : 1;
  console.log(exitCode === 0 ? '\nE2E LOOK PASS' : '\nE2E LOOK FAIL');
} catch (e) {
  console.error(String(e.message ?? e));
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
