// SPDX-License-Identifier: AGPL-3.0-only
// Summarise a measurement file written by `npm run connect -- --stream N --stats file.json`.
import { readFileSync } from 'node:fs';

for (const file of process.argv.slice(2)) {
  const run = JSON.parse(readFileSync(file, 'utf8'));
  const s = run.stream;
  const full = s.samples.filter((w) => w.frames > 0).slice(1); // the first second holds the start-up
  const col = (k) => full.map((w) => w[k]);
  const stat = (a) => {
    const v = [...a].sort((x, y) => x - y);
    const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
    return `min ${v[0]} / median ${q(0.5)} / p90 ${q(0.9)} / max ${v[v.length - 1]}`;
  };
  console.log(`\n== ${run.video.width}x${run.video.height}@${run.video.maxFps}, asked ${run.video.bitrateKbps} kbit/s, ${run.seconds} s`);
  console.log(`totals: ${JSON.stringify(s.totals)}`);
  console.log(`stages: ${JSON.stringify(s.stages)}   stutter threshold ${s.stutterThresholdMs} ms`);
  console.log(`per second (${full.length} full seconds)`);
  console.log(`  frames          ${stat(col('frames'))}`);
  console.log(`  kbit/s          ${stat(col('bytes').map((b) => Math.round((b * 8) / 1000)))}`);
  console.log(`  gap mean ms     ${stat(col('frameGapMeanMs'))}`);
  console.log(`  gap jitter ms   ${stat(col('frameGapJitterMs'))}`);
  console.log(`  gap max ms      ${stat(col('frameGapMaxMs'))}`);
  for (const k of ['assemblyMeanMs', 'assemblyMaxMs', 'loopDelayMaxMs']) if (full.some((w) => w[k] !== undefined)) console.log(`  ${k.padEnd(15)} ${stat(col(k))}`);
  const kinds = {};
  for (const e of s.events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  console.log(`events: ${JSON.stringify(kinds)}`);
  const st = s.events.filter((e) => e.kind === 'stutter');
  if (st.length) console.log(`stutters at (ms): ${st.map((e) => `${e.t}(${e.detail.split(' ')[0]})`).join(' ')}`);
}
