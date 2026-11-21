// SPDX-License-Identifier: AGPL-3.0-only
//
// End-to-end check in a REAL browser: starts the bridge with a simulated console, opens headless Chrome on the
// console page, lets the page drive keyboard/mouse input, and waits for the page's report. Also checks what the
// simulated console itself received (the server-side truth). Needs Chrome or Edge; run with `npm run e2e`.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MockConsole } from '../src/bridge/mock-console.ts';
import { startBridge } from '../src/bridge/server.ts';
import { ConsoleStore } from '../src/console/store.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const chrome = candidates.find((p) => existsSync(p));
if (!chrome) {
  console.error('No Chrome/Edge found. Set CHROME to its path.');
  process.exit(2);
}

let mock;
let maxRightX = 0; // the mouse is only moved for a while, so look at the largest value seen, not the last
let resolveReport;
const reported = new Promise((r) => (resolveReport = r));
// The registration form is driven too, against a stubbed console (the real flow has its own tests).
const storeDir = mkdtempSync(path.join(tmpdir(), 'gtp-e2e-store-'));
const store = new ConsoleStore(path.join(storeDir, 'consoles.json'));
let registerCall;
let psnCode;
const bridge = await startBridge({
  host: '127.0.0.1',
  port: 0,
  root,
  store,
  api: {
    psn: async (code) => {
      psnCode = code;
      return 'AgEAAAAAAAA=';
    },
    // The form sends only an address, so the bridge asks the network what is there first; answer like a PS5 would.
    discover: async () => ({
      hosts: [{ address: '192.168.1.50', state: 'ready', statusCode: 200, hostId: '0123456789AB', hostName: 'E2E', hostType: 'PS5', isPs5: true, target: 'ps5-1' }],
    }),
    register: async (o) => {
      registerCall = o;
      return {
        target: 'ps5-1', mac: '0123456789ab', nickname: 'E2E console', rpKeyType: 2,
        registKey: Buffer.from('61626364656667680000000000000000', 'hex'), rpKey: Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
      };
    },
  },
  createLink: () => {
    mock = new MockConsole();
    const original = mock.sendPad.bind(mock);
    mock.sendPad = (seq, state) => {
      maxRightX = Math.max(maxRightX, Math.abs(state.rightX));
      original(seq, state);
    };
    return mock;
  },
  onE2eReport: (r) => resolveReport(r),
});

const profileDir = mkdtempSync(path.join(tmpdir(), 'gtp-e2e-'));
const url = `${bridge.url}?mode=console&e2e=1`;
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileDir}`, url], { stdio: 'ignore', windowsHide: true });

let exitCode = 1;
try {
  const report = await Promise.race([reported, new Promise((_, rej) => setTimeout(() => rej(new Error('no report from the browser within 40 s')), 40000))]);
  console.log(report.lines.join('\n'));
  if (process.env.E2E_FRAME_OUT && typeof report.frame === 'string' && report.frame.startsWith('data:image/png;base64,')) {
    writeFileSync(process.env.E2E_FRAME_OUT, Buffer.from(report.frame.slice(22), 'base64'));
    console.log(`saved the last simulated-console frame to ${process.env.E2E_FRAME_OUT}`);
  }
  // Server-side truth: what the simulated console actually received.
  const serverOk = mock && mock.padCount > 20 && mock.lastPad.leftY < -0.99 && mock.lastPad.r2 === 255 && maxRightX > 0.05;
  console.log(
    `${serverOk ? 'ok  ' : 'FAIL'} the simulated console received the pad (pads ${mock?.padCount}, leftY ${mock?.lastPad.leftY.toFixed(2)}, r2 ${mock?.lastPad.r2}, largest right stick seen ${maxRightX.toFixed(2)})`,
  );
  // The account id came from the PSN step of the page (stubbed), not typed into the registration form.
  const registerOk =
    psnCode === 'E2ELoginCode-123' && registerCall?.host === '192.168.1.50' && String(registerCall?.pin) === '24680135' && registerCall?.accountId === 'AgEAAAAAAAA=' &&
    !!store.get('0123456789ab') && store.accountId === 'AgEAAAAAAAA=';
  console.log(`${registerOk ? 'ok  ' : 'FAIL'} the bridge got the login code from the page, fetched the account id, and used it for the registration (target ${registerCall?.target})`);
  exitCode = report.pass && serverOk && registerOk ? 0 : 1;
  console.log(exitCode === 0 ? '\nE2E PASS' : '\nE2E FAIL');
} catch (e) {
  console.error(String(e.message ?? e));
} finally {
  child.kill();
  await bridge.close();
  setTimeout(() => {
    try {
      rmSync(profileDir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    } catch {
      /* the browser may still hold files for a moment */
    }
    process.exit(exitCode);
  }, 800);
}
