// SPDX-License-Identifier: AGPL-3.0-only
// Bridge side and screen side of one run, second by second, around the worst moments.
import { readFileSync } from 'node:fs';
for (const file of process.argv.slice(2)) {
  const run = JSON.parse(readFileSync(file, 'utf8'));
  const st = new Map(run.stream.samples.map((s) => [s.t, s]));
  const di = new Map(run.display.samples.map((s) => [s.t, s]));
  const bad = [...di.values()].filter((d) => d.gapMaxMs > 120 || d.resyncs > 0).map((d) => d.t);
  const show = new Set();
  for (const t of bad) for (let k = t - 2; k <= t + 2; k++) show.add(k);
  console.log(`\n== ${file.split(/[\\/]/).pop()}  mode ${run.display.mode}  totals ${JSON.stringify(run.display.totals)}`);
  console.log('  t | bridge: frames kbit/s gapMax asmMax loopMax lostU key idr | screen: shown gapMax late decode queue resync waiting delay');
  for (const t of [...show].sort((a, b) => a - b)) {
    const s = st.get(t);
    const d = di.get(t);
    const b = s ? `${String(s.frames).padStart(3)} ${String(Math.round((s.bytes * 8) / 1000)).padStart(6)} ${String(s.frameGapMaxMs).padStart(7)} ${String(s.assemblyMaxMs).padStart(6)} ${String(s.loopDelayMaxMs).padStart(6)} ${String(s.unitsLost).padStart(4)} ${s.keyFrames} ${s.idrRequests}` : '   (no sample)';
    const p = d ? `${String(d.shown).padStart(3)} ${String(d.gapMaxMs).padStart(7)} ${String(d.lateMaxMs).padStart(7)} ${String(d.decodeMaxMs).padStart(6)} ${String(d.decodeQueueMax).padStart(3)} ${d.resyncs} ${String(d.waiting).padStart(2)} ${d.delayMs}` : '   (no report)';
    console.log(`${String(t).padStart(3)} | ${b} | ${p}`);
  }
  const ev = run.stream.events.filter((e) => !['stage', 'profile'].includes(e.kind));
  console.log(`  bridge events: ${ev.map((e) => `${(e.t / 1000).toFixed(1)}s ${e.kind}${e.detail ? `(${e.detail})` : ''}`).join(' | ') || 'none'}`);
}
