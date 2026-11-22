# Great Theft P.S (GTP)

A PlayStation Remote Play client that runs in a web browser, in early development. Goals:

1. Precise keyboard + mouse to controller mapping, including a configurable **speed limit** for mouse look.
2. **Shareable per-game profiles.**
3. A stream that **does not stutter**, with the measurements to find out why when it does, and fine-grained
   **bandwidth / quality control**.
4. Many devices: web browser first, then desktop and mobile.

Architecture: `PS5 <-> Remote Play (LAN) <-> bridge <-> WebSocket <-> browser`. The bridge is a small Node program on a
computer in the same network as the console. Its console side (`src/console/`) is a TypeScript port of the Remote Play
protocol from [chiaki-ng](https://github.com/chiaki-ng/chiaki-ng): no native code, nothing to compile. The mapping engine
runs in the browser. WebSocket (TCP) is the first transport between browser and bridge; WebRTC is planned for use over
the internet.

**What works today, on a real PS5:** finding the console, registering with it, connecting, the picture in the browser
(H.264, up to 1920x1080 at 60), and keyboard and mouse input reaching the console. **Written but not yet heard on a real console:** sound (see below). **Not there yet:** the login PIN prompt, connecting from
outside the home network without a VPN. It has been used
with one PS5 on one home network; expect rough edges.

"GTP" is short for the project name. This is an unofficial, independent project. See `NOTICE.md` for what it is derived
from and for trademark notes.

## Status

| Part | State |
|---|---|
| Mapping engine + test beds (pad-only FPS, GTA V style third-person) | **working** (browser self-test) |
| Console link, a TypeScript port of the Remote Play protocol (`src/console/`) | **working on a real PS5**: discovery, registration, session, control connection, Takion transport, video with error correction, input. Checked against chiaki-ng's own test vectors as well. Details and what is unverified: `docs/ts-protocol-port.md` |
| Bridge: WebSocket server, safety, API, measurements | **working** |
| Browser client: H.264 through WebCodecs, paced playout, pad sending, quality presets | **working** (Chrome; real-browser checks with and without a console) |
| Handing the console over between your own clients, with a lock | **working** between two computers (signals checked both ways; see below) |
| Waking a console in rest mode | works on a real PS5 (woke in 13 s, then accepted a session); not yet tried through the page |
| Sound: Opus from the console to the page (`src/console/audioreceiver.ts`, `web/audio-player.ts`) | **written and tested** with a real browser's Opus encoder and decoder, a 440 Hz tone comes out right; **not yet heard from a real console**. Needs WebCodecs `AudioDecoder` (Chrome; Safari from iOS/macOS 26) and at most two channels |
| Login PIN, HEVC in the page, RTT/MTU test | not built |
| Profile sharing registry, WebRTC, PSN (outside the home), desktop and mobile shells | not started |
| gtp-core (C, libchiaki), an alternative console link | specified, not built (`docs/gtp-core-contract.md`) |

## Run

Requires Node.js 24 or newer. No dependencies to install.

```sh
npm run dev      # the bridge to your PS5, for this computer and, over Tailscale, for a phone; open the printed URL
npm test         # unit and integration tests (node --test)
npm run e2e      # real-browser end-to-end check (headless Chrome <-> bridge <-> a test double, no console)
npm run discover # look for PlayStation consoles on the local network
npm run register -- --host <console IP>   # register with your console (the page can do it too)
npm run consoles -- list|export|import    # see, back up and move registrations
npm run connect  # walk a connection to your console step by step and say where it stops (-- --stream 10 for video)
npm run handover -- who|hold|ask          # try the handover between your clients
```

### Play

`npm run dev` (or `npm run bridge`: the same), open the address it prints, and on the **PS5** page press the one button: it registers a console when
there is none and connects when there is one. Click the picture to lock the mouse (Esc releases it); keyboard and mouse
then go to the console through the current profile (arrow keys are the d-pad). **연습장** holds two test games for trying
the mapping without a console, and **설정** has the mapping, console management and advanced items.

Above the picture:

- **화질**: 640x360@30 to 1920x1080@60. A console fixes this when the stream starts, so changing it reconnects.
- **표시**: how frames are paced onto the screen. *부드럽게* holds each frame back a little (as much as the latest frame
  of the last minute needed, at most 100 ms) and shows frames on the console's own even pace, so that a frame arriving
  40 ms late on Wi-Fi does not show as a freeze. *균형* does the same with at most 50 ms. *최소 지연* shows every frame the
  moment it arrives. "표시 지연" is the delay in use, "화면 끊김" counts the hitches you actually saw.
- **잠금**: see "Several computers, one console".

A console in rest mode shows as 대기 모드 and the button says **깨우고 연결**: the bridge sends the wake-up datagram, waits
until the console answers, then connects, so from a phone it is still one press. The console must allow it in its rest-mode
settings (*Enable Turning on PS5 from Network*). `npm run wake` does the waking alone (`-- --check` only reports what the
console answers). A console that is already on is not sent anything, and `--no-wake` on the bridge switches the waking off.

### Register your console (once)

On a computer in the same network as the console. The console must be **on** (not in rest mode) with **Settings > System >
Remote Play > Link Device** open; it shows an 8 digit code. Use the page ("콘솔 등록하기") or `npm run register`; both say
exactly why it failed when it does. The first registration also needs your PSN account id (a decimal number, or its 8
bytes in base64); it is remembered afterwards. If you do not know it, the page can fetch it: it opens Sony's own login
page in your browser and reads the id from the address it redirects to. **Read the notice there:** this uses the client
credentials of Sony's own Remote Play app (as chiaki-ng does), which is a grey area under Sony's terms; tokens are not
kept. It is optional: typing the number in works without it.

The result is saved in `~/.gtp/consoles.json` (set `GTP_HOME` to move it) and is never sent to the browser. That file
lets a program control your console: keep it private and do not commit or share it.

### Move a registration to another computer (never register twice)

To use the same console from another computer without a new 8 digit code and without logging in to PSN again, make a
passphrase-protected copy and import it there:

```sh
npm run consoles -- export gtp-consoles.gtpbackup     # on the computer that has the registration
npm run consoles -- import gtp-consoles.gtpbackup     # on the other computer
```

The copy is encrypted (scrypt + AES-256-GCM), but it holds the keys to your console: carry it by USB stick or a private
channel and delete it after importing.

### Several computers, one console

A console serves one Remote Play client at a time and offers no way to end another client's session. So your own
copies of this program agree on a rule among themselves:

- A copy that is connected **lets go when another of your copies wants the console**, and that one takes over
  (a few seconds: the console needs about six to free the session).
- Tick **잠금** and the connection is kept instead: the other copy is told who has it, locked. The lock belongs to the
  connection and ends with it.

This works between computers that hold the **same registration** (moved with `npm run consoles`, above): the signal is a
small UDP datagram on the local network (port 47876), encrypted and authenticated with a key derived from the
registration, so nobody else can read it or make a copy let go. It cannot do anything about other programs (the official
app, chiaki): they do not take part. `npm run handover -- who` shows which of your copies has the console; `--no-handover`
on the bridge switches the whole thing off.

### Bridge safety

It can press buttons on a console, so: the page and its API listen on loopback only unless you pass `--host`. On loopback
there is no token to deal with: the WebSocket must be same-origin and the Host header must be loopback, so another web
page (or a DNS rebinding trick) cannot drive it. A program already running as you on the same computer can still connect,
which is no new power because it can already read your files. If you pass `--host` to listen on the network, a token
becomes mandatory (random unless `--token`, and added to the printed URL). One client at a time; the pad is released when
the client disconnects or goes silent for 2 s; messages are size and rate limited. It refuses to start if another program
already answers on the port (default 8787); pick another with `--port`.

The one thing that listens on the network by default is the handover signal described above. All it can be made to do,
and only by someone who holds your console's registration, is end this copy's stream.

### From another device, such as a phone (HTTPS over Tailscale)

A browser decodes video only on a secure page, and only `localhost` counts as one without HTTPS. So a phone needs an
`https://` address. The bridge can serve it itself, with the certificate that Tailscale issues for the computer's name,
and listen on the computer's Tailscale address only, so that nothing outside your tailnet can reach it. There is nothing to start separately: `npm run dev` does it. When Tailscale is running and there is a certificate for this
computer's name, the same bridge also answers on this computer's tailnet address, over HTTPS, next to its own address:

```
Open:  http://127.0.0.1:8788/                                  this computer, no token
Phone (over Tailscale, HTTPS, the token is asked for):  https://<name>.<tailnet>.ts.net:8788/#token=...
```

It is one bridge: one client at a time across both addresses, one console link, one set of measurements. The tailnet
side is bound to the tailnet address only (not the home network, not the internet) and keeps port 8788, so that the
address on the phone's home screen stays the same; if 8788 is taken it stops and says so rather than moving. The
certificate is renewed by itself when it has two weeks left. The first certificate is not asked for without being told:
run `npm run dev -- --phone` once (it asks Tailscale for one; no Tailscale setting is changed). If Tailscale is not
running, or HTTPS certificates are not turned on for the tailnet, the bridge says what to do and goes on with this
computer's address alone. `--no-phone` leaves the tailnet side out. Giving `--host`, `--tls-cert` or `--trust-host`
yourself switches the automatic part off: what you typed is used. By hand, what it does is:

```sh
tailscale ip -4                                     # this computer's tailnet address
tailscale cert --cert-file c.crt --key-file c.key <name>.<tailnet>.ts.net
npm run bridge -- --port 8788 --host <tailnet address> --tls-cert c.crt --tls-key c.key --trust-host <name>.<tailnet>.ts.net
```

Open the `https://<name>.<tailnet>.ts.net:8788/#token=...` address that the bridge prints; the token is kept in
`~/.gtp/bridge-token`, so the address keeps working between starts (delete the file and restart to change it). The Host
header is then checked against that name and the bound address, so a page under any other name cannot reach the bridge.
At start the bridge says how long the certificate lasts.
The key file is as sensitive as the registration: keep it private. If the address is not this computer's, or Tailscale is
not running, the bridge says so and does not start.

Do not use `tailscale serve` for this on a computer that already publishes something with Tailscale Funnel: a serve
command can change what Funnel serves. `--trust-host` also works behind an HTTPS proxy on the same computer.

### Comparing ways of connecting

When a stream ends (and lasted at least five seconds) the bridge keeps what it measured in one file in `runs/` next to
the registered consoles: how frames arrived from the console (loss, error correction, evenness), how many the bridge had
to leave out because the page was behind, what the page put on the screen (hitches, delay, its round trip to the
bridge), the sound, and who watched, coarsely: this computer, the tailnet, the local network or elsewhere; the kind of
device; for a tailnet client whether the path was direct or went through a relay. No addresses are kept.
`npm run runs` prints one line per run, so a run over home Wi-Fi and one over a mobile line can be read side by side;
`npm run runs -- --detail 1` shows the newest in full. `--no-runs` turns it off, `--runs-dir <folder>` moves it.

### Looking into stutter

`docs/stream-research.md` has what was measured so far and how to measure it yourself: `GET /api/stream/stats` gives the
stream as it arrives at the bridge and as it goes onto the screen, second by second, and there are tools to compare
settings on your own network.

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
src/engine/      mapping engine (no dependencies, runs in browsers and Node): pad state, calibration, mouse look, profiles
src/testbed/     the two pad-only test games and the black-box calibration
src/console/     the console side: a TypeScript port of the Remote Play protocol (see NOTICE.md and docs/ts-protocol-port.md)
  discovery.ts, regist.ts, session.ts, ctrl.ts     find, register, session request, control connection
  rpcrypt.ts, rp-tables.ts, ecdh.ts, gkcrypt.ts    key schedules, key exchange, packet cipher and MACs
  takion.ts, takionsendbuffer.ts, reorderqueue.ts, takion-proto.ts   the UDP transport and its protobuf messages
  streamconnection.ts, launchspec.ts               stream set-up, heartbeat, loss reports, key frame requests
  videoreceiver.ts, frameprocessor.ts, fec.ts, fec-gf256.ts, bitstream.ts   frames from packets, error correction
  controller.ts, feedback.ts, feedbacksender.ts    input to the console
  streamstats.ts                                   measurements of the stream (this project's own)
  store.ts, backup.ts, psn-account.ts              registrations on disk, moving them, the PSN account id
src/bridge/      the bridge
  main.ts, server.ts, ws.ts, static.ts, api.ts     command line entry, WebSocket relay and safety, the /api/ endpoints
  ps5-link.ts, console-link.ts, core-link.ts       the link to a real PS5; the seam for other links
  playout.ts                                       when to show each frame (used by the page)
  handover.ts                                      handing the console over between your own clients
  protocol.ts, quality.ts, h264.ts                 wire format shared with the page, quality presets, H.264 helpers
web/             the page: PS5 view, test beds, settings, video player, bridge client
tools/           connect, discover, register, consoles, handover, snap-console (real console + real browser), e2e-browser
test/            tests, the reference's vectors, and test doubles (test/support/)
docs/            status-and-next.md (start here), keyboard-mouse-mapping.md, stream-research.md, ts-protocol-port.md, gtp-core-contract.md
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

The page edits a profile by pressing keys (설정 → 입력 매핑: one row per pad button, "+ 키", then the key) and keeps one
per game in the browser. `docs/keyboard-mouse-mapping.md` has the built-in layout, why it is what it is, and what the
established remappers do.

### Binding syntax

`btn:cross`, `stick:left:up[:0.5]`, `trigger:r2[:0.5]`, `turbo:cross[:hz]` (presses repeatedly while held),
`toggle:<layer>` (flips a layer on each press), `none` (binds a key to nothing inside a layer), and `+` to combine
(`btn:pyramid+toggle:vehicle`). A hold key of a layer is looked up in that layer only, so holding it never also fires its default binding.

By default a button is down exactly as long as its key, so a game tells short and long presses apart as it does on a
pad. For games that put two actions on one button by press length, two keys can share the button: `tap:box[:ms]` (a
press of fixed length however long the key is held) and `hold:box[:ms]` (held at least that long, even after a quick
key press). `latch:l2` switches a button on and off with each press. One key can also do different things by how it is
pressed: `"KeyF": ...`, `"KeyF@long": ...`, `"KeyF@double": ...`, `"KeyF@start": ...`, `"KeyF@release": ...`; a key
with a long or double press sends its plain press only when it is let go, which is the price of that.

## License

AGPL-3.0-only. The console-facing bridge is planned to link libchiaki (AGPL-3.0), so the project is released under the same license.
No code from other Remote Play clients is copied; their sources are read for protocol structure only.

