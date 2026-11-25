# Where the project stands, and what comes next

Written on 2026-11-21 when the work moved from one development session to another. It collects what is not in the
other documents: what is in progress, what was decided, what is unverified, and the traps. The other documents say how
things work (`README.md`, `docs/ts-protocol-port.md`, `docs/stream-research.md`, `docs/keyboard-mouse-mapping.md`).

## What works, and how it was checked

| Thing | Checked how |
|---|---|
| Discovery, registration, session, control connection, video (H.264 up to 1080p60), input | on a real PS5, from Windows and macOS |
| Picture in the browser, d-pad input from the page | real PS5, headless Chrome (`tools/snap-console.mjs --nudge`) |
| A person playing a real game with keyboard and mouse | yes, by the owner, for more than twenty minutes at a time |
| Handover between two computers (signals) | both ways between Windows and macOS, with stand-in holders (`npm run handover -- hold`) |
| Handover of a real running stream between two computers | **not tried** |
| Paced playout | simulation, and headless Chrome on a real PS5 (74 hitches against 10 in 45 s); the owner's own impression is not recorded |
| `tap:` (an 80 ms press) on a real console | **not tried** (a plain 120 ms press was) |
| The touch pad | desktop headless Chrome with synthetic pointer events only; **never on a phone** |
| iPhone Safari decoding this stream | **not tried**; the first thing to find out (see below) |
| The link simulator and `--latency` | unit tests and the test double; **no real measurement yet** (the console was off) |
| `--trust-host` | unit tests with hand-made requests; **never behind a real proxy** |
| Waking a console in rest mode (automatic on connect, `POST /api/wake`, `npm run wake`) | unit tests (the credential against chiaki-ng's conversion and the stored key's real shape, the waiting on a fake clock, the link, the API) and the real console: `npm run wake -- --check` (read-only), and one real wake (rest mode, then "ready" 13 s after the datagram, then a session accepted); **a session asked for right at the first "ready" has not been tried** |
| `--tls-cert` / `--tls-key` (HTTPS by the bridge, option B) | unit tests and real TLS handshakes with a throwaway certificate (page and `wss` upgrade); started once on loopback with the real `tailscale cert` files and checked with curl against the system's trust store (trusted, 200; a foreign Host gets 421); **never reached from another device, never bound to the tailnet address** |
| Mouse carry-over | simulation and tests; **not yet tried in a game** |

## Measuring a console game's camera response (written 2026-11-22; not yet tried on a real console)

Reported by the owner on the real game: moving the mouse turns the camera a little and then it stands still. The engine
was checked and is right on its own terms: it holds the stick for as long as the mouse moves and turns the camera by the
angle the hand asked for, *if* the game responds as the profile says. A simulation with the default profile gave stick
values of 0.14 for a slow drift, 0.36 for a normal turn and 0.75 for a fast one: small values that a game with a larger
deadzone or a camera that speeds up with time barely turns for. So the profile's idea of the game is what is wrong.

`web/calibrate-console.ts` (panel in the settings, 콘솔 게임 자동 보정) runs `src/engine/lookcalibrate.ts`: one full turn at
full deflection for the scale and the delay, 14 horizontal levels measured in a window of 0.1 to 0.7 s after the first
movement (the window of a mouse flick), up to three vertical pushes at moderate rates (the camera cannot look far up or
down). It builds the table (`buildTable`: monotone, deadzone where the rising part meets zero, ends at full deflection) and
puts it in the profile on request. The measuring of the picture is `src/engine/lookmeasure.ts`: block matching on 256 x 144
grey frames with a median over the blocks, so the character, the HUD and traffic are outvoted by the background; the gap between
the frames of a pair is chosen so the picture moves a few pixels; a picture that moves too far between frames is looked at
from half size.

Tested: 48 unit tests against a made-up world with a HUD, a fixed character, moving things and noise (the response is
recovered to within a few percent at 30 and 60 frames a second, with a delay and a ramp-up), and `npm run e2e:look` in a
real Chrome against `test/support/game-link.ts` (scale 3.20 px/deg exactly, deadzone 0.22, rates within 1 to 5 %).

**Not yet seen:** a real game. What can go wrong there: a scene with too little in it (the panel says so), a camera that
auto-centres or is blocked by a wall during the turn (a warning, or a wrong scale: the scale then falls back to an assumed 80
degrees across and says so), a game whose camera acceleration is not about time held (then the table is only right for
flicks of about half a second), traffic or crowds that outvote the background. The first real run will show.

## Comparing ways of connecting (the owner wants to try them all)

Starting: `npm run dev`, one bridge, one process: this computer's own address (http, no token) and, when Tailscale is
running and a certificate exists, the tailnet address over HTTPS with the token, port 8788 for both (`--phone` once to get
the first certificate, `--no-phone` to leave the tailnet side out). A stream's numbers: `npm run runs`.

Every stream the bridge carries is kept when it ends (`src/bridge/runlog.ts`, `npm run runs`), with the client's kind,
device and tailnet path. The ways to compare, and who can run them:

| # | Way | Measured by | Who runs it |
|---|---|---|---|
| A | chiaki-ng on a computer in the home network, straight to the console (the reference client; it keeps no statistics, so this is by eye or by camera) | feel; its on-screen numbers if it shows any | owner at the computer (installed under ~/Applications) |
| B | this bridge and a browser on the same computer (no network hop) | the run file | Claude, with the owner's go-ahead for a real stream |
| C | the bridge on one computer, a page on another in the home network (Wi-Fi) | the run file | owner's other computer or the phone on home Wi-Fi |
| D | the bridge, the phone on a mobile line, through Tailscale | the run file (`from` says tailnet, `path` says direct or relay) | owner, away from home |
| E | Sony's own app on the phone over a mobile line (Sony's path) | feel only; it shows nothing | owner |

What each number answers. `lost fr %` and `lost units %` are the console-to-bridge leg (home network, error correction
included); `to page dropped %` is the bridge-to-page leg (what the TCP connection could not carry in time: this is where
a mobile line shows); `RTT` is the page's round trip to the bridge; `shown delay` is the pacing delay the page added.
Only B, C and D give numbers; the same latency measure across A to E is a camera one: film the console's screen and the
client's screen together while pressing a button, and count frames. For D, `path` matters most: a relay adds a detour
that no setting here can remove. Keep the game, the scene and the quality the same across runs.

## In progress: playing away from home on an iPhone

Goal set by the owner: play smoothly over mobile internet on an iPhone, by touch. Picture quality may be given up.

Agreed order:

0. Wire the PS5 (its link is the unstable part of the home network: pings to it vary up to 28 ms).
1. A baseline with the bridge as it is (WebSocket), over Tailscale, at a low quality. Decide from that how much the
   transport has to change.
2. If needed, an unreliable transport (WebRTC data channel) with retransmission and FEC done by the bridge.
3. Re-encoding last, if at all. The console's slow key frame (0.85 to 0.95 s) does not force it: what is lost on the
   mobile leg can be sent again by the bridge, which has the original.
4. No relay server expected: Tailscale's direct connection, and if that fails a forwarded UDP port at home or a
   Tailscale peer relay.

Decided:

- **HTTPS by the bridge itself** ("option B"): a browser's video decoder only exists on a secure page, so a phone
  needs HTTPS. The bridge is to serve it with the certificate `tailscale cert` gives, bound to the tailnet address
  only. `tailscale serve` is NOT to be used on the home Mac: its port 443 carries public (Funnel) services, and a serve
  command there once took those down.
- Dependencies stay at zero until the baseline is measured. Candidates for step 2, for the owner to choose between:
  werift (pure TypeScript WebRTC, no native code, before 1.0) and node-datachannel (libdatachannel binding with
  prebuilt binaries, MPL-2.0).

**Option B is built** (`src/bridge/tls.ts`, `hostAllowed` in `src/bridge/static.ts`, `test/tls.test.ts`).

- `--tls-cert <file> --tls-key <file>`: `node:https` instead of `node:http`; the WebSocket handshake runs over the same
  server (`wss`). At start it prints the certificate's expiry (a warning in the last 14 days, a refusal to start once it
  has expired), checks that the key belongs to the certificate, and warns when a `--trust-host` name is not one of the
  certificate's names.
- Used with `--host <the tailnet address>` (a token is mandatory off loopback) and `--trust-host <name>`. Command on
  the Mac: `npm run dev`, which works those arguments out (`src/bridge/phone.ts`) and serves the tailnet address next to
  loopback from the same bridge (`BridgeOptions.also`); by hand it is
  `npm run bridge -- --port 8788 --host <100.x address> --tls-cert <crt> --tls-key <key> --trust-host <name>`.
- The Host check is closed: off loopback with names trusted, only those names and the bound address are answered (and
  the loopback names when bound to every address), so a page under another name that points at this computer (DNS
  rebinding) is turned away with 421. Off loopback with no name trusted it is open as before; the token protects.
- When the address is not the computer's (Tailscale down), the bridge says so and does not start.
- The tests make their own certificate (`test/support/selfsigned.ts`, a hand-built DER structure signed with an ECDSA
  key from `node:crypto`): no key is kept in the repository.
- The certificate and key for the home Mac are in `~/.gtp/tls/` (owner only). The certificate lasts about 90 days:
  renew with `tailscale cert` and restart. **Switching it on for the tailnet is the owner's decision** (it opens the
  bridge, with its token, to the owner's devices on the tailnet); until then the bridge runs on loopback.

Then, on the phone, in this order (each failure changes the plan):

1. On home Wi-Fi first: does the page load, does the console card show.
2. Quality "데이터 절약", connect: **does a picture appear.** If not, iPhone Safari does not decode this stream through
   WebCodecs (it has the API from iOS 16.4) and another path is needed (a `<video>` element fed through Managed Media
   Source is the candidate; it would also give full screen, which an iPhone only has for video elements).
3. Touch: buttons, the stick, dragging for the camera; the hitch counter in the menu.
4. "Add to Home Screen": no browser bars, screen stays awake?
5. Then on mobile data: the same, and whether `tailscale ping` says direct or relayed.

Also needed for playing away from home:

- **Waking the console: built, and tried once on the real console (it woke).** Away from home it will be in rest mode. Pressing connect
  on a console in rest mode now wakes it first (`src/console/wake.ts`, called from `Ps5Link.start`), waits until it
  answers and then asks for the session: one press, from a phone too. The wake-up credential is made from the stored
  key the way chiaki-ng does it (`credentialFromStoredKey`: the key bytes up to the first zero, read as text, at most 8
  hexadecimal characters; the older `credentialFromRegistKey` takes a hexadecimal STRING and is not for the stored
  form). Also `POST /api/wake` (sends the datagram only) and `npm run wake` (`-- --check` only says what the console
  answers). It needs "Enable Turning on PS5 from Network" in the console's rest-mode settings; that cannot be seen from
  here, the console simply ignores the datagram, and the link then says it did not wake after 60 s.

  **First real try (2026-11-21, `npm run wake`, one datagram, the console had been in rest mode):** it answered the
  probe with "standby" until the datagram, was silent while it started (the 5 s and 9 s polls got no answer: a silent
  probe costs about 2.4 s, so polls are about 4 s apart then), and said "ready" 13 s after the datagram. The datagram was
  not sent again, as designed (only "standby" asks for another one). About 35 s later a session request and the control
  connection were accepted (`npm run connect`), which also confirms that the credential made from the stored key is
  the one the console expects. **Not yet seen:** a session asked for right when the console first says "ready"
  (`settleMs`, 1.5 s, is still a guess; the first real use through the page will show whether it needs more), and a
  console with "Enable Turning on PS5 from Network" switched off (it was on here).
- **Sound.** Written end to end, checked everywhere except against a real console. The console's audio packets are
  reassembled in `src/console/audioreceiver.ts` (a port of chiaki-ng's jitter buffer; the copies in a packet are taken
  before its own frames, on purpose), sent by the bridge as `MSG.AUDIO` frames (a lost frame is a flag, not a gap) after
  one JSON `{type:'audio'}` message with the format, decoded in the page with WebCodecs `AudioDecoder`, and placed on
  the sound card's clock by `web/audio-schedule.ts` (cushion that follows the picture's delay + 40 ms; pieces too far
  ahead are dropped; a lost frame passes in silence). The audio context is made inside the connect tap (iPhone), the
  audio session is set to "playback" where `navigator.audioSession` exists (silent switch), a hidden tab decodes nothing,
  any tap wakes a context the phone interrupted. The real-browser check (`npm run e2e`) feeds a 440 Hz tone through a
  real Opus encoder, the player and Chrome's decoder and measures what reaches the sound card (444 Hz, right strength).
  **Not yet seen:** the console's real audio header (channel count: browsers decode at most 2, the player says so in
  words if the PS5 sends more, and then there is no sound), real frames decoding, lip-sync with the picture (the target
  delay is a guess), an iPhone (iOS before 26 has no `AudioDecoder`: a WASM Opus decoder would be a new dependency, the
  owner's decision). The first real stream shows the first three.
- One client per bridge: a second browser gets "another client is connected". The handover rule exists between
  bridges, not between two pages of one bridge. A phone taking over from the PC at home needs that.
- Replace the link simulator's assumed profiles with a recording from the real mobile line (the page already pings
  the bridge; it only has to keep the series).

## Reported and fixed last, not yet confirmed in a game

"In a real game the view turns a little and then stands still, however far the mouse moves." Cause: movement faster
than the speed limit was thrown away. Now carried over (`mouse.carryMs`). See "Mouse look: distance against speed" in
`docs/keyboard-mouse-mapping.md`, which also says what remains: the game's own sensitivity at maximum, and measuring
the game's turn rate and dead zone on the console (designed there, not built). That measuring tool is the most useful
next step for keyboard and mouse play.

## Traps

- **A session request that is accepted and not followed up blocks the console for about 30 s** ("in use",
  `0x80108b10`); a finished connection for about 6 s. Never send a session request you do not continue.
  `POST /api/session-check` is exactly that and is no longer used by the page.
- **A key frame costs about 0.9 s.** Ask the console for one only when nothing else helps. Twice already a "reasonable"
  reaction to a backlog turned short stalls into one-second freezes.
- **A hidden browser tab** stops drawing and holds its work back. The page stops decoding and reporting while hidden;
  measurements taken with the tab in the background are worthless.
- **Headless Chrome without a GPU cannot decode 1080p60 in time.** `tools/snap-console.mjs` leaves the GPU on; its
  numbers still contain the test browser's own stalls.
- **The tools hold the console while they run.** They take part in the handover unlocked, so a page that connects gets
  the console, but only through the handover (same registration, same network).
- **Timing tests fail when two test runs overlap** or the machine is busy (`bridge.test.ts`, the PNG frame rate one).
  Rerun alone before believing a failure.
- **PowerShell 5.1 mangles source edits** that contain backticks, `${`, apostrophes or curly quotes. On Windows, edit
  such lines with an editor tool, not with a shell replace.
- **Fixtures must use neutral addresses** (192.168.1.50, 100.64.0.2). Two real ones slipped into tests; no real
  console name, address, account or key belongs in the repository, and the scans so far only looked for the console's.
- **The handover listens on the network by default** (UDP 47876). It is the one exception to "loopback only", it only
  reads datagrams made with the console registration's keys, and `--no-handover` removes it. Clocks more than two
  minutes apart make it fail silently.
- **A remote page keeps its token in the address and in localStorage**, so that an iPhone's home screen page has it.
  Do not share screenshots or links of that address. Deleting `~/.gtp/bridge-token` and restarting changes the token.
- The profile's game numbers (360 deg/s at full stick, 10% dead zone) are guesses, not a game's.
- The default key layout changed once already (Tab, Enter, backquote). Saved profiles keep what they had.

## Things on the list, with a view on their order

1. Switch option B on for the tailnet (the owner decides), then the iPhone checks: everything else about playing away
   from home waits on "does the phone decode it". The iPhone must first be in the tailnet (the Tailscale app, same account).
2. Waking the console: done and tried once on the real console. What is left is its use through the page, away from
   home, where the session right after the first "ready" gets its real test.
3. Sound: built; what is left is hearing it from the real console and on the iPhone (see above).
4. The look calibration on a real console: the largest gain for keyboard and mouse.
5. Taking over between two pages of one bridge.
6. Touch layout: size and opacity, moving buttons, a per-game layout. Wait for the first real use; the defaults are
   untested on a real hand.
7. Analog values from keys (see `docs/keyboard-mouse-mapping.md`): trigger modifier, time as depth for driving.
8. Gyro (the phone's sensor as the camera): after touch is settled. iOS asks for permission and needs HTTPS.
9. Stepping the quality down by itself when the decoder falls behind; the Senkusha RTT/MTU test; HEVC; the login PIN.

## Tools that are not obvious

```sh
npm run connect -- --stream 30 --video 1920x1080x60x15000 --stats run.json   # what arrives at the bridge
node tools/snap-console.mjs --watch 60 --playout smooth --quality quality --stats run.json   # what the screen shows
node tools/snap-console.mjs --nudge              # d-pad down and up from the page, compared by picture
node tools/snap-console.mjs --latency 20 --link-sim lte-average   # press to picture, through a simulated mobile line
npm run handover -- who | hold | ask             # the handover, without a console for "hold"
node tools/research/analyze-run.mjs run.json     # per-second summary of a --stats file from connect
node tools/research/side-by-side.mjs run.json    # bridge side and screen side around the worst moments (snap-console --stats)
node tools/research/release-time.mjs ctrl|stream # how long the console says "in use" after a connection (real console)
node tools/research/hold-time.mjs                # the same after an abandoned session request (real console)
node tools/research/swipe-sim.mjs                # what the stick does for a mouse swipe, no console
```

`?touchpreview=1` on the page shows the touch controls without a console. `?snap=1`, `?watch=N`, `?latency=N`,
`?playout=`, `?quality=` are what `snap-console.mjs` uses and work by hand too.

## Running at home for the family (2026-11-24)

Built and tested here (unit tests and a real browser against the simulator, 1060+ tests):

- **Login and minutes per day** (`accounts.ts`, `auth-api.ts`, `web/account-ui.ts`): owner without limit, members with
  minutes per day (the day ends in a chosen time zone), one-time invitations, scrypt hashes, 30-day sessions in an
  HttpOnly SameSite=Strict cookie, slowed-down guessing, owner-only API (register, forget, tuning, people). A stream is
  counted while the picture runs and ended at zero.
- **Finding the console again** when the router gives it another address (`locate.ts`): by its id, as the registration is.
- **A real controller** (`web/gamepad.ts`): standard layout, analog triggers, round dead zone; joins keyboard and mouse.
- **A server that keeps itself current** (`tools/supervise.mjs`, `deploy/compose.yaml`): a new commit on `main` is
  started on the side and taken only if it answers and nobody is playing; a commit that fails is not retried. Seen
  working against a local repository, including refusing a broken commit, and on the real server (it took a commit by
  itself within a minute).
- **Live reload and a version line** for development.

**Not yet seen:** a stream from the real console through the server (the bridge on the NAS has the registration, the
HTTPS address works and asks for a login, but nobody has pressed connect from outside yet); a real DualSense in a real
browser (the mapping follows the browser's standard layout and is tested with a fake pad); how much of the NAS's CPU a
1080p60 stream needs; Safari on an iPhone with a controller; the minutes counted over a real evening.


## The interface (2026-11-24)

The PS5 page was redone around the picture: a player with a big button before the stream, a bar over the picture while it plays,
full screen, screenshots and clips, a connection indicator with charts, light and dark, an account menu with the time left,
toasts, and a phone layout with a bottom bar. `docs/player.md` has the list and what was checked. Not yet seen: an iPhone, an
Android phone, a real DualSense, and any of it on a real stream.

One thing it changed that was wrong before: the time left in the header was counted down by the page even when no stream was
running (the bridge counts only from the moment the picture starts), so it showed less than a member had. It is counted down
only while a stream runs now.
