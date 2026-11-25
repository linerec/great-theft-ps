// SPDX-License-Identifier: AGPL-3.0-only
// What do the scores of the mouse-feel study say? Reads the ratings and prints the analysis (src/engine/feel-study.ts).
//
//   node tools/research/feel-report.mjs <file> [--user <name>] [--json] [--min-seconds 8] [--proposals 12]
//
// <file> is any of: the server's own file (feel-ratings.jsonl in the study folder next to the console registrations: one JSON
// line per rating, with the person's name), a JSON list of ratings (what "기록 복사" in the panel puts on the clipboard), or an
// answer of GET /api/study/ratings. "-" reads from standard input. Without --user every person's ratings are analysed together.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { analyzeRatings, formatReport, parseRating } = await import(pathToFileURL(path.join(repo, 'src/engine/feel-study.ts')).href);

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const file = args.find((a, i) => !a.startsWith('--') && !['--user', '--min-seconds', '--proposals'].includes(args[i - 1] ?? ''));
if (!file) {
  console.error('usage: node tools/research/feel-report.mjs <file|-> [--user <name>] [--json] [--min-seconds 8] [--proposals 12]');
  process.exit(2);
}

const text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
/** [{ user, rating }]: the three shapes this takes, whichever the file is. */
function entries() {
  const trimmed = text.trim();
  try {
    const whole = JSON.parse(trimmed);
    const list = Array.isArray(whole) ? whole : Array.isArray(whole?.ratings) ? whole.ratings : null;
    if (list) return list.map((r) => ({ user: r?.user ?? '', rating: r?.rating ?? r }));
  } catch {
    // not one JSON value: JSON lines
  }
  return trimmed.split('\n').filter(Boolean).flatMap((line) => {
    try {
      const o = JSON.parse(line);
      return [{ user: o.user ?? '', rating: o.rating ?? o }];
    } catch {
      return [];
    }
  });
}

const wanted = value('user', null);
const ratings = [];
let refused = 0;
for (const e of entries()) {
  if (wanted && e.user !== wanted) continue;
  const parsed = parseRating(e.rating);
  if (parsed.ok) ratings.push(parsed.rating);
  else refused++;
}
if (refused) console.error(`${refused} entries did not pass the check and were left out`);
const report = analyzeRatings(ratings, { minSeconds: Number(value('min-seconds', 8)), proposals: Number(value('proposals', 12)) });
console.log(flag('json') ? JSON.stringify(report, null, 2) : formatReport(report));
