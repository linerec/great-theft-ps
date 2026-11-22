// SPDX-License-Identifier: AGPL-3.0-only
// What does the engine send for a mouse swipe? Prints the right stick over time and the angle it stands for.
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (p) => import(pathToFileURL(path.join(repo, p)).href);
const { MappingEngine } = await load('src/engine/engine.ts');
const { defaultProfile } = await load('src/engine/profile.ts');

const TICK = 0.004;
function swipe(label, counts, seconds, edit = () => {}) {
  const p = defaultProfile();
  edit(p);
  const e = new MappingEngine(p);
  const ticks = Math.round(seconds / TICK);
  let deflectedMs = 0;
  let peak = 0;
  let modelAngle = 0; // what the camera turns if the game is exactly what the profile says
  const g = p.inGame;
  const rateOf = (stick) => (stick <= g.innerDeadzone ? 0 : g.maxTurnRateAtFullStick * Math.pow((stick - g.innerDeadzone) / (1 - g.innerDeadzone), g.responseCurve));
  for (let i = 0; i < ticks + 250; i++) {
    if (i < ticks) e.mouseMove(counts / ticks, 0);
    const s = e.tick(TICK);
    const m = Math.abs(s.rightX);
    if (m > 0.02) deflectedMs += 4;
    peak = Math.max(peak, m);
    modelAngle += rateOf(m) * TICK;
  }
  const asked = counts * p.mouse.degPerCount;
  console.log(`${label.padEnd(46)} asked ${asked.toFixed(0).padStart(4)} deg | stick up to ${peak.toFixed(2)}, deflected for ${String(deflectedMs).padStart(4)} ms | camera turns ${modelAngle.toFixed(0).padStart(4)} deg if the game matches the profile (${((modelAngle / asked) * 100).toFixed(0)}%)`);
}
console.log('default profile: 0.05 deg per count, speed limit 360 deg/s, game assumed 360 deg/s at full stick');
swipe('slow pan: 1 cm/s for 1 s at 1000 DPI', 394, 1);
swipe('pan: 5 cm in 1 s at 1000 DPI', 1969, 1);
swipe('swipe: 10 cm in 0.3 s at 1000 DPI', 3937, 0.3);
swipe('swipe: 10 cm in 0.3 s at 1600 DPI', 6299, 0.3);
swipe('flick: 5 cm in 0.1 s at 1600 DPI', 3150, 0.1);
console.log('\nthe same, if the game really turns 150 deg/s at full stick (the profile still says 360)');
const real150 = (counts, seconds, label) => {
  const p = defaultProfile();
  const e = new MappingEngine(p);
  const ticks = Math.round(seconds / TICK);
  let angle = 0;
  for (let i = 0; i < ticks + 250; i++) {
    if (i < ticks) e.mouseMove(counts / ticks, 0);
    const m = Math.abs(e.tick(TICK).rightX);
    angle += (m <= 0.1 ? 0 : 150 * ((m - 0.1) / 0.9)) * TICK;
  }
  console.log(`${label.padEnd(46)} asked ${(counts * 0.05).toFixed(0).padStart(4)} deg | camera turns ${angle.toFixed(0).padStart(4)} deg (${((angle / (counts * 0.05)) * 100).toFixed(0)}%)`);
};
real150(1969, 1, 'pan: 5 cm in 1 s at 1000 DPI');
real150(6299, 0.3, 'swipe: 10 cm in 0.3 s at 1600 DPI');
