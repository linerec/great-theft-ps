// SPDX-License-Identifier: AGPL-3.0-only
// What do the mouse "feel" settings do to the stick, in numbers? No console, no game: only the engine, fed the counts a
// real mouse makes (whole counts, a few per millisecond), and the stick it answers with.
//
//   start lag    from the hand starting to move at a steady speed until the stick is at 90 % of where it settles
//   stop slide   from the hand stopping until the stick is back under 2 % (the camera keeps turning that long)
//   slow jitter  how much the stick wobbles around its mean while the hand moves slowly and steadily (a quantised mouse
//                gives whole counts, so the wanted turn rate comes in ones and zeros)
//   fast swipe   the angle the stick asks for in a quick swipe, as a share of what the hand turned
//
// usage: node tools/research/feel-sim.mjs [dpi]
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (p) => import(pathToFileURL(path.join(repo, p)).href);
const { MappingEngine } = await load('src/engine/engine.ts');
const { defaultProfile } = await load('src/engine/profile.ts');
const { FEEL_PRESETS } = await load('web/mouse-feel.ts');

const TICK = 0.004;
const DEG_PER_COUNT = 0.05;

/** Counts a hand moving at `degPerSec` makes in one tick, as whole counts (the remainder carries over, as a sensor does). */
function counter(degPerSec) {
  let rest = 0;
  return () => {
    rest += (degPerSec / DEG_PER_COUNT) * TICK;
    const whole = Math.trunc(rest);
    rest -= whole;
    return whole;
  };
}

function run(set, handDegPerSec, handSeconds, tailSeconds = 1) {
  const p = defaultProfile();
  Object.assign(p.mouse, set);
  const e = new MappingEngine(p);
  const next = counter(handDegPerSec);
  const sticks = [];
  const ticks = Math.round((handSeconds + tailSeconds) / TICK);
  const handTicks = Math.round(handSeconds / TICK);
  for (let i = 0; i < ticks; i++) {
    if (i < handTicks) e.mouseMove(next(), 0);
    sticks.push(Math.abs(e.tick(TICK).rightX));
  }
  return { sticks, handTicks };
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

/** The angle the game turns per drawing frame (4 ticks, 16 ms), if it is what the profile says; what a person sees as smooth or not. */
function frameAngles(set, degPerSec, seconds) {
  const p = defaultProfile();
  Object.assign(p.mouse, set);
  const g = p.inGame;
  const rateOf = (s) => (s <= g.innerDeadzone ? 0 : g.maxTurnRateAtFullStick * Math.pow((s - g.innerDeadzone) / (1 - g.innerDeadzone), g.responseCurve));
  const { sticks, handTicks } = run(set, degPerSec, seconds, 0);
  const out = [];
  for (let i = Math.round(0.5 / TICK); i + 4 <= handTicks; i += 4) out.push(sticks.slice(i, i + 4).reduce((a, st) => a + rateOf(st) * TICK, 0));
  return out;
}
const cv = (a) => {
  const m = mean(a);
  return m === 0 ? 0 : Math.sqrt(mean(a.map((v) => (v - m) ** 2))) / m;
};

function measure(name, set) {
  const startLag = (speed) => {
    const t = run(set, speed, 1);
    const level = mean(t.sticks.slice(Math.round(0.5 / TICK), t.handTicks));
    return Math.round(t.sticks.findIndex((v) => v >= 0.9 * level) * TICK * 1000);
  };
  const stopSlide = (speed) => {
    const t = run(set, speed, 1);
    const level = mean(t.sticks.slice(Math.round(0.5 / TICK), t.handTicks));
    const after = t.sticks.slice(t.handTicks);
    const i = after.findIndex((v) => v < 0.02 * Math.max(level, 0.01));
    return Math.round((i < 0 ? after.length : i) * TICK * 1000);
  };
  // a quick swipe: 90 degrees in 0.15 s, and the angle the stick asks for (the profile's own model of the game)
  const p = defaultProfile();
  Object.assign(p.mouse, set);
  const g = p.inGame;
  const rateOf = (s) => (s <= g.innerDeadzone ? 0 : g.maxTurnRateAtFullStick * Math.pow((s - g.innerDeadzone) / (1 - g.innerDeadzone), g.responseCurve));
  const swipe = run(set, 600, 0.15, 1.5);
  const turned = swipe.sticks.reduce((a, s) => a + rateOf(s) * TICK, 0);
  const pct = (v) => `${(v * 100).toFixed(0).padStart(3)}%`;

  console.log(
    `${name.padEnd(14)} | start lag 45/120 deg/s ${String(startLag(45)).padStart(3)}/${String(startLag(120)).padStart(3)} ms | stop slide 45/120 ${String(stopSlide(45)).padStart(3)}/${String(stopSlide(120)).padStart(3)} ms | uneven turning per frame at 3/15/45 deg/s ${pct(cv(frameAngles(set, 3, 2)))} ${pct(cv(frameAngles(set, 15, 2)))} ${pct(cv(frameAngles(set, 45, 2)))} | 90° swipe ${turned.toFixed(0)}°`,
  );
}

console.log(`default profile, ${DEG_PER_COUNT} deg per count; "uneven" = spread of the angle turned per 16 ms frame, as a share of its mean (0 = perfectly even)\n`);
for (const p of FEEL_PRESETS) measure(p.name, p.set);
console.log('\nsmoothing that fades with speed (smoothing ms / fade rate deg/s):');
for (const [sm, fade] of [[12, 40], [12, 60], [12, 100], [20, 60], [8, 60]]) measure(`${sm} ms / ${fade}`, { smoothingMs: sm, smoothingFadeRate: fade, carryMs: 300 });
console.log('\nfixed smoothing, for comparison:');
for (const sm of [0, 3, 5, 8, 12, 20]) measure(`${sm} ms fixed`, { smoothingMs: sm, smoothingFadeRate: 0, carryMs: 300 });
