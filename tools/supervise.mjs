// SPDX-License-Identifier: AGPL-3.0-only
//
// Keeps the bridge running on a server and takes new versions of it from git by itself.
//
//   node tools/supervise.mjs            (what the container runs; see docs/deploy-nas.md)
//
// It starts the bridge (`node src/bridge/main.ts` with the arguments in GTP_ARGS), restarts it if it dies, and every
// GTP_UPDATE_SECONDS (default 60) looks at the branch (GTP_BRANCH, default main). A newer commit is tried like this, and
// only when nobody is playing (src/deploy/update-plan.ts): checked out on the side, started on another port with an empty
// home folder, and asked for its page. If that works the running copy is moved to it and this program exits, so that the
// container (restart: always) starts again from the new files, this script included. If not, the commit is written down
// as bad and left alone until the branch moves on. A stream is never cut for an update.
//
// Environment: GTP_ARGS, GTP_PORT (8788), GTP_BRANCH, GTP_UPDATE_SECONDS, GTP_HOME (where registrations and accounts are
// kept), and, once, GTP_IMPORT_URL + GTP_PASSPHRASE to fetch an encrypted copy of a console registration (see below).

import { execFile, spawn } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { crashLoop, planUpdate, splitArgs } from '../src/deploy/update-plan.ts';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.GTP_HOME ?? path.join(process.env.HOME ?? root, '.gtp');
const port = Number(process.env.GTP_PORT ?? 8788);
const branch = process.env.GTP_BRANCH ?? 'main';
const everyMs = Math.max(10, Number(process.env.GTP_UPDATE_SECONDS ?? 60)) * 1000;
mkdirSync(home, { recursive: true });
const badFile = path.join(home, 'bad-commits.txt');
const logFile = path.join(home, 'deploy.log');

const log = (line) => {
  const text = `[${new Date().toISOString().slice(0, 19)}] ${line}`;
  console.log(text);
  try {
    appendFileSync(logFile, `${text}\n`);
  } catch {
    /* the log is a convenience */
  }
};
// `safe.directory=*`: in a container the folder is often owned by someone other than the user git runs as, and git then refuses it.
const git = async (...args) => (await run('git', ['-c', 'safe.directory=*', ...args], { cwd: root, timeout: 60_000 })).stdout.trim();
const badSet = () => new Set(existsSync(badFile) ? readFileSync(badFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : []);

// ---------------------------------------------------------------- a console registration, once

/** GTP_IMPORT_URL points at the encrypted copy `npm run consoles -- export` wrote (served for a moment on the home network). */
async function importRegistration() {
  const url = process.env.GTP_IMPORT_URL;
  if (!url) return;
  const marker = path.join(home, `.imported-${createHash('sha256').update(url).digest('hex').slice(0, 12)}`);
  if (existsSync(marker)) return;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`the copy could not be fetched (${res.status})`);
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'gtp-import-')), 'consoles.gtpbackup');
    writeFileSync(file, Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
    const { stdout } = await run('node', ['tools/consoles.mjs', 'import', file], { cwd: root, env: { ...process.env, GTP_HOME: home }, timeout: 60_000 });
    rmSync(path.dirname(file), { recursive: true, force: true });
    writeFileSync(marker, new Date().toISOString());
    log(`imported a console registration: ${stdout.trim().split('\n').slice(-2).join(' ')}`);
  } catch (e) {
    log(`could not import the console registration: ${String(e.stderr ?? e.message ?? e).trim().split('\n')[0]}`);
  }
}

// ---------------------------------------------------------------- the bridge

let child = null;
let stopping = false;
const deaths = [];

function startBridge() {
  const args = ['src/bridge/main.ts', '--port', String(port), ...splitArgs(process.env.GTP_ARGS)];
  log(`starting the bridge: node ${args.join(' ')}`);
  child = spawn('node', args, { cwd: root, stdio: 'inherit', env: { ...process.env, GTP_HOME: home } });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    deaths.push(Date.now());
    log(`the bridge ended (${signal ?? code})`);
    if (crashLoop(deaths, Date.now())) {
      log('the bridge keeps dying: giving up, so that the container starts over');
      process.exit(1);
    }
    setTimeout(startBridge, 3000);
  });
}

async function busy() {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/busy`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? (await r.json()).busy === true : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- taking a new version

/** Start the commit on the side and ask for its page. Resolves to null when it is fine, or the reason when it is not. */
async function startsUp(commit) {
  const tree = path.join(tmpdir(), `gtp-next-${commit.slice(0, 8)}`);
  const sideHome = mkdtempSync(path.join(tmpdir(), 'gtp-smoke-home-'));
  const sidePort = 20000 + randomInt(0, 20000);
  let side = null;
  let reason = null;
  try {
    rmSync(tree, { recursive: true, force: true });
    await git('worktree', 'prune');
    await git('worktree', 'add', '--detach', tree, commit);
    await run('node', ['--check', 'tools/supervise.mjs'], { cwd: tree, timeout: 20_000 });
    let output = '';
    side = spawn('node', ['src/bridge/main.ts', '--port', String(sidePort), '--no-phone', '--no-handover', '--no-runs', '--no-locate'], { cwd: tree, env: { ...process.env, GTP_HOME: sideHome }, stdio: ['ignore', 'pipe', 'pipe'] });
    side.stdout.on('data', (d) => (output += d));
    side.stderr.on('data', (d) => (output += d));
    let exited = false;
    side.on('exit', () => (exited = true));
    const deadline = Date.now() + 25_000;
    for (;;) {
      if (exited) {
        reason = `it stopped by itself: ${output.trim().split('\n').slice(-2).join(' | ')}`;
        break;
      }
      try {
        const page = await fetch(`http://127.0.0.1:${sidePort}/`, { signal: AbortSignal.timeout(2000) });
        const me = await fetch(`http://127.0.0.1:${sidePort}/api/me`, { signal: AbortSignal.timeout(2000) });
        if (page.ok && me.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) {
        reason = 'it did not answer within 25 seconds';
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (e) {
    reason = String(e.stderr ?? e.message ?? e).trim().split('\n')[0];
  } finally {
    side?.kill();
    rmSync(sideHome, { recursive: true, force: true });
    await git('worktree', 'remove', '--force', tree).catch(() => rmSync(tree, { recursive: true, force: true }));
  }
  return reason;
}

let announcedWait = '';
async function checkForUpdate() {
  let remote = null;
  try {
    await git('fetch', '--quiet', 'origin', branch);
    remote = await git('rev-parse', `origin/${branch}`);
  } catch (e) {
    log(`could not ask git for news: ${String(e.message ?? e).split('\n')[0]}`);
  }
  const local = await git('rev-parse', 'HEAD');
  const plan = planUpdate({ local, remote, bad: badSet(), busy: remote && remote !== local ? await busy() : false });
  if (plan.action === 'wait') {
    if (announcedWait !== remote) log(`a new version (${remote?.slice(0, 8)}) is waiting for the stream to end`);
    announcedWait = remote ?? '';
    return;
  }
  if (plan.action !== 'try') return;
  log(`new version ${plan.commit.slice(0, 8)} (running ${local.slice(0, 8)}): trying it on the side first`);
  const problem = await startsUp(plan.commit);
  if (problem) {
    appendFileSync(badFile, `${plan.commit}\n`);
    log(`${plan.commit.slice(0, 8)} does not start (${problem}). Staying on ${local.slice(0, 8)} until the branch moves on`);
    return;
  }
  if ((await busy()) !== false) {
    log(`${plan.commit.slice(0, 8)} starts fine, but someone began playing: waiting`);
    return;
  }
  await git('reset', '--hard', plan.commit);
  log(`now on ${plan.commit.slice(0, 8)}: restarting`);
  stopping = true;
  child?.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500);
}

await importRegistration();
log(`on ${(await git('rev-parse', '--short', 'HEAD').catch(() => '?'))}, branch ${branch}, checking every ${everyMs / 1000} s`);
startBridge();
setInterval(() => void checkForUpdate().catch((e) => log(`update check failed: ${e.message}`)), everyMs);
setTimeout(() => void checkForUpdate().catch(() => {}), 20_000);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    child?.kill('SIGTERM');
    setTimeout(() => process.exit(0), 1500);
  });
}
