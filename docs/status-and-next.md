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
| Waking a console in rest mode (automatic on connect, `POST /api/wake`, `npm run wake`) | unit tests (the credential against chiaki-ng's conversion and the stored key's real shape, the waiting on a fake clock, the link, the API) and a read-only check against the real console (`npm run wake -- --check` saw it in rest mode); **the datagram itself has never been sent to a real console** |
| `--tls-cert` / `--tls-key` (HTTPS by the bridge, option B) | unit tests and real TLS handshakes with a throwaway certificate (page and `wss` upgrade); started once on loopback with the real `tailscale cert` files and checked with curl against the system's trust store (trusted, 200; a foreign Host gets 421); **never reached from another device, never bound to the tailnet address** |
| Mouse carry-over | simulation and tests; **not yet tried in a game** |

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
  the Mac: `npm run bridge -- --port 8788 --host <100.x address> --tls-cert <crt> --tls-key <key> --trust-host <name>`.
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

- **Waking the console: built, never sent to a real console.** Away from home it will be in rest mode. Pressing connect
  on a console in rest mode now wakes it first (`src/console/wake.ts`, called from `Ps5Link.start`), waits until it
  answers and then asks for the session: one press, from a phone too. The wake-up credential is made from the stored
  key the way chiaki-ng does it (`credentialFromStoredKey`: the key bytes up to the first zero, read as text, at most 8
  hexadecimal characters; the older `credentialFromRegistKey` takes a hexadecimal STRING and is not for the stored
  form). Also `POST /api/wake` (sends the datagram only) and `npm run wake` (`-- --check` only says what the console
  answers). It needs "Enable Turning on PS5 from Network" in the console's rest-mode settings; that cannot be seen from
  here, the console simply ignores the datagram, and the link then says it did not wake after 60 s. **On the first real
  try, look at:** how long "standby" lasts, whether the console answers the probe while it starts, and whether it takes
  a session right when it first says ready (`settleMs`, 1.5 s, is a guess).
- **Sound.** Nothing is decoded or played yet (Opus in the stream, `AudioDecoder` or Web Audio in the page).
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
2. Waking the console: built and tested without a console; the first real try is the next step (it switches the console
   on, so it is done with the owner's say).
3. Sound: its absence is felt at once on a phone.
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
