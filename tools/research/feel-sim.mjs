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

function measure(name, set) {
  // steady speeds: a slow pan and a normal turn
  const slow = run(set, 15, 2);
  const slowMid = slow.sticks.slice(Math.round(0.5 / TICK), slow.handTicks);
  const m = mean(slowMid);
  const sd = Math.sqrt(mean(slowMid.map((v) => (v - m) ** 2)));

  const turn = run(set, 120, 1);
  const level = mean(turn.sticks.slice(Math.round(0.5 / TICK), turn.handTicks));
  const startTick = turn.sticks.findIndex((v) => v >= 0.9 * level);
  const stopTicks = (() => {
    const after = turn.sticks.slice(turn.handTicks);
    const i = after.findIndex((v) => v < 0.02 * Math.max(level, 0.01));
    return i < 0 ? after.length : i;
  })();

  // a quick swipe: 90 degrees in 0.15 s, and the angle the stick asks for (the profile's own model of the game)
  const p = defaultProfile();
  Object.assign(p.mouse, set);
  const g = p.inGame;
  const rateOf = (s) => (s <= g.innerDeadzone ? 0 : g.maxTurnRateAtFullStick * Math.pow((s - g.innerDeadzone) / (1 - g.innerDeadzone), g.responseCurve));
  const swipe = run(set, 600, 0.15, 1.5);
  const turned = swipe.sticks.reduce((a, s) => a + rateOf(s) * TICK, 0);

  console.log(
    `${name.padEnd(12)} start lag ${String(Math.round(startTick * TICK * 1000)).padStart(3)} ms | stop slide ${String(Math.round(stopTicks * TICK * 1000)).padStart(4)} ms | slow stick ${m.toFixed(3)} ± ${sd.toFixed(3)} (wobble ${((sd / (m || 1)) * 100).toFixed(0).padStart(3)} %) | 90° swipe turns ${turned.toFixed(0).padStart(3)}°`,
  );
}

console.log(`default profile, ${DEG_PER_COUNT} deg per count, hand speeds in deg/s: 15 (slow), 120 (turn), 600 (swipe)\n`);
for (const p of FEEL_PRESETS) measure(p.name, p.set);
console.log('\nsingle settings from the default (smoothing, carry-over):');
for (const [s, c] of [[0, 300], [5, 300], [12, 0], [12, 120], [24, 300]]) measure(`${s} ms/${c} ms`, { smoothingMs: s, carryMs: c });
