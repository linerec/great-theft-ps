# Great Theft P.S (GTP)

A PlayStation Remote Play client, in early development. Goals:

1. Precise keyboard + mouse to controller mapping, including a configurable **speed limit** for mouse look.
2. **Shareable per-game profiles.**
3. Fine-grained **bandwidth / quality control**, down to very low traffic for small screens.
4. Many devices: web browser first, then desktop and mobile.

Architecture: `PS console <-> Remote Play (LAN) <-> bridge <-> WebSocket <-> browser`. The mapping engine runs in the
browser client (TypeScript, shared by every client). The bridge is thin: it authenticates one client, relays pad state to a
*console link* and video back, and lets go of every button when the client goes away. A console link is either the
**simulated console** (for development and tests) or **gtp-core**, a native program on libchiaki (specified, not built:
see `docs/gtp-core-contract.md`). WebSocket (TCP) is the first transport; WebRTC is planned for internet use.

**Early development. It cannot stream from a real PlayStation yet.** What works today is the keyboard and mouse mapping
engine, two test games, the browser client and bridge (against a simulated console), and console discovery on the local
network. Nothing here has been run against real console hardware, and the status table below says exactly which parts
are verified and how.

"GTP" is short for the project name. This is an unofficial, independent project. See `NOTICE.md` for what it is derived
from and for trademark notes.

## Status

| Part | State |
|---|---|
| Mapping engine + test beds (pad-only FPS, GTA V style third-person) | **working** (75 tests, browser self-test) |
| Bridge: WebSocket server, auth, safety, simulated console, gtp-core contract (fake core) | **working** (25 tests) |
| Browser client: video player (PNG and real H.264 via WebCodecs), pad sending, latency, quality presets | **working** (real-Chrome end-to-end check) |
| Console link for a real PlayStation: TypeScript port of the Remote Play protocol (`src/console/`) | **Phase 0 done**: discovery confirmed on a real PS5 in rest mode (from macOS); wake-up not yet tried on hardware. Phases 1 to 7 not started: `docs/ts-protocol-port.md` |
| gtp-core (C, libchiaki), the alternative link | specified, not built (`docs/gtp-core-contract.md`) |
| Profile sharing registry, WebRTC, desktop and mobile shells | not started |

## Run

Requires Node.js 24 or newer. No dependencies to install.

```sh
npm test         # unit and integration tests (node --test): 100 tests
npm run dev      # test beds (FPS, GTA style) at http://127.0.0.1:5173/, no console needed
npm run bridge   # bridge with a SIMULATED console; prints a URL with a one-time token
npm run e2e      # real-browser end-to-end check (headless Chrome <-> bridge <-> simulated console)
npm run discover # look for PlayStation consoles on the local network (run it where the console is)
```

Open the page and click the game view to lock the mouse (Esc releases it). W A S D move, the mouse looks,
left click shoots, right click aims down sights, Shift sprints, X walks slowly.

Console mode: choose "콘솔 (브리지 연결)", paste the token from the bridge output (or open the printed URL, which
contains it) and connect. With the simulated console you see the pad state it received drawn as a picture, and the
input-to-picture latency. With a real console you will see the PlayStation once gtp-core exists.

### Bridge safety

It can press buttons on a console, so: it listens on loopback only unless you pass `--host`; a token is always required
(random unless `--token`); the WebSocket must be same-origin (another web page cannot drive it); one client at a time; the pad
is released when the client disconnects or goes silent for 2 s; messages are size and rate limited; video is dropped, not queued,
when the client cannot keep up. It also refuses to start if another program already answers on the port (default 8787),
because on some systems two programs can otherwise share a port and split traffic by address; pick another with `--port`.

## The test bed

`src/testbed/` is a tiny raycast FPS written like a console game: it reads **only** a virtual pad
(`update(pad, dt)`), never a keyboard or mouse. Look speed goes through the game's own inner deadzone,
response curve and maximum turn rate, so it shows what a real pad-only game would do with the mapping.

- *Rotation check*: the page compares accumulated mouse counts with the angle the game really turned
  (measured degrees per count vs. the configured value).
- *Hidden game settings*: the game's deadzone, curve, vertical ratio and deadzone shape are deliberately
  unknown to the mapping. Change them and the angle drifts; **Auto calibrate** then measures the game
  black-box (feeds the stick, watches the camera) and stores a calibration table in the profile.
- Walls are coloured by compass direction (east green, south blue, west yellow, north red) so a full turn is visible.

### Third-person (GTA V style)

Pick it in the game selector. A small 3D world (software renderer, no dependencies) with an orbit camera, on-foot
movement relative to the camera (walk, jog and run follow how far the stick is pushed), sprint by tapping X, jump,
aim with L2 (over-the-shoulder camera, optional assisted aim), shoot with R2, and a drivable car with a camera that swings
back behind it. Load the *GTA V* profile: **Shift** held auto-taps X, **F** presses Triangle and switches the controls to
driving (W = R2, S = L2, A/D steer), the right mouse button aims.

Only some of this is grounded in public GTA V sources (PlayStation: sprint = tap X repeatedly, jump = Square, aim = L2,
enter vehicle = Triangle, cover = R1, vehicle accelerate = R2; third-person look has deadzone, acceleration and sensitivity
settings and several aim modes). Everything else (brake on L2, handbrake on Square, every speed, camera distance, turn rate and the
look-acceleration formula) is an assumption of the test bed. It is a stand-in for judging the mapping, not a copy of the game.

What it shows that the first-person game cannot:
- **Context switching**: the same W key is "stick up" on foot and "R2" in the car. The profile uses a toggled `vehicle` layer.
- **Button mashing**: sprint needs repeated X taps, so the engine has a `turbo` action.
- **Aim sensitivity**: the game turns the camera at a different speed while aiming. The `aim` layer's `lookScale` fixes the
  angle per mouse count, and auto calibration measures it.
- **Look acceleration**: a time-dependent camera speed-up cannot be captured by a stick-to-rate table. It does not affect slow
  movement (20.0 deg for 20 expected) but grows on long fast sweeps: a 1 s sweep that should turn 150 deg turns 269 deg with
full acceleration and 209 deg at half. Prefer the game's lowest acceleration setting.

## Layout

```
src/engine/      mapping engine (no dependencies, runs in browsers and Node)
  types.ts         virtual pad state, button bits
  calibration.ts   per-game stick -> turn-rate tables and their inverse
  mouse.ts         mouse look: filter, stick conversion, virtual gyro
  engine.ts        MappingEngine: events in, pad state out, tick(dt) and runFor() for per-frame input
  profile.ts       shareable profile schema 0, validation, defaults
src/testbed/     pad-only test bed games
  fps.ts           first-person game logic (look model, movement, shooting, targets)
  render.ts        raycasting renderer
  tps.ts           GTA V style third-person game (camera, on foot, aiming, car)
  tpsrender.ts     small software 3D renderer
  measure.ts       black-box calibration of any game (stick table, vertical ratio, deadzone shape, aim scale)
src/bridge/      the bridge
  protocol.ts       wire format shared by browser and bridge (pad, video, ping, control JSON)
  quality.ts        quality presets and validation (resolution, fps, bitrate, codec)
  ws.ts             minimal RFC 6455 WebSocket server (no dependencies)
  server.ts         static files + WebSocket relay, auth, single client, safety
  console-link.ts   the seam between bridge and a console
  mock-console.ts   simulated console (PNG frames of the pad it received)
  core-link.ts      gtp-core process link and framing
  h264.ts, png.ts   Annex B helpers, PNG writer
  main.ts           command line entry (npm run bridge)
src/dev-server.mjs zero-dependency dev server for the test beds
web/             page, bridge client, video player
tools/           fake-core.mjs (tests), e2e-browser.mjs (real-browser check)
test/            engine, test bed, bridge and core-contract tests
docs/            gtp-core-contract.md
```

## How mouse look works

A stick sets a turn *rate*, a mouse sets a turn *angle*, so a plain proportional mapping feels wrong.
The engine converts mouse movement to a desired turn rate, applies smoothing, a response curve and a
hard speed limit (`mouse.maxTurnRate`), then converts the rate to a stick value through the **inverse of a
per-game calibration table** (stick deflection -> degrees per second). With a measured table the same
mouse movement turns the camera by the same angle in every game; without one a linear model built from
the game's inner deadzone and full-stick turn rate is used. The test suite checks this in a closed loop.

Most games apply the deadzone to the stick *vector*, not to each axis. The engine therefore inverts the
calibration once on the length of the desired turn rate (`inGame.deadzoneShape: "radial"`, the default);
inverting each axis separately overshoots badly on diagonals (found by the integration tests). Axial games
are supported too, and `inGame.verticalRateRatio` covers games that turn slower vertically than horizontally.
Mouse movement arrives once per display frame, so `runFor()` spreads each frame's movement evenly over the
fixed ticks to keep the speed steady.

A stick can never exceed full deflection, so the game's own maximum turn rate is a hard ceiling in stick mode.
For games with gyro aiming, `mouse.target = "gyro"` sends the mouse as a virtual gyro instead
(clamped to +-30 rad/s, the range the console-facing library can carry). Gyro axes, signs and the
accelerometer rest vector are unverified assumptions until tested against a real console (milestone M2).

## Profiles

A profile is data only. It is validated and normalised (unknown fields dropped, size limited to 64 KB,
bounded numbers, strict action syntax) and never executed. It records the in-game settings it was tuned for,
because the same profile only reproduces the same feel when those match.

### Binding syntax

`btn:cross`, `stick:left:up[:0.5]`, `trigger:r2[:0.5]`, `turbo:cross[:hz]` (presses repeatedly while held),
`toggle:<layer>` (flips a layer on each press), `none` (binds a key to nothing inside a layer), and `+` to combine
(`btn:pyramid+toggle:vehicle`). A hold key of a layer is looked up in that layer only, so holding it never also fires its default binding.

## License

AGPL-3.0-only. The console-facing bridge is planned to link libchiaki (AGPL-3.0), so the project is released under the same license.
No code from other Remote Play clients is copied; their sources are read for protocol structure only.
