// SPDX-License-Identifier: AGPL-3.0-only
//
// Prints what the bridge kept about each stream (src/bridge/runlog.ts), one line per run, to compare ways of connecting.
//   npm run runs                      the table of all kept runs
//   npm run runs -- --last 5          only the newest five
//   npm run runs -- --detail <n>      one run in full (n counts from the newest: 1 is the newest)
//   npm run runs -- --dir <folder>    another folder than the default
// Each file also holds the whole record (second-by-second series from both ends and the events), so it can be opened
// with anything that reads JSON.

import path from 'node:path';

import { defaultStorePath } from '../src/console/store.ts';
import { formatRunTable, loadRuns } from '../src/bridge/runlog.ts';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dir = opt('dir') ?? path.join(path.dirname(defaultStorePath()), 'runs');
let runs = loadRuns(dir);
if (runs.length === 0) {
  console.log(`No runs kept yet in ${dir}. Each stream that lasts at least five seconds is kept when it ends.`);
  process.exit(0);
}
const detail = opt('detail');
if (detail !== undefined) {
  const n = Number(detail);
  const run = runs[runs.length - n];
  if (!Number.isInteger(n) || !run) {
    console.error(`--detail takes a number from 1 to ${runs.length}`);
    process.exit(2);
  }
  console.log(run.file);
  console.log(JSON.stringify(run.summary, null, 2));
  const events = (run.snapshot.stream?.events ?? []).slice(0, 40);
  if (events.length) console.log('\nevents:\n' + events.map((e) => `  ${(e.t / 1000).toFixed(1)} s  ${e.kind}${e.detail ? `  ${e.detail}` : ''}`).join('\n'));
  process.exit(0);
}
const last = Number(opt('last'));
if (Number.isInteger(last) && last > 0) runs = runs.slice(-last);
console.log(formatRunTable(runs));
console.log(`\n${runs.length} run(s) in ${dir}`);
