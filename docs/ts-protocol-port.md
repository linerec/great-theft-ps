# Porting the console protocol to TypeScript

The bridge talks to a console through a *console link*. The chosen link for a real PlayStation is a TypeScript
implementation of the Remote Play protocol (`src/console/`), so a machine only needs Node.js (no compiler). It is
ported from [chiaki-ng](https://github.com/chiaki-ng/chiaki-ng) (AGPL-3.0-only with an OpenSSL exception, which this
project's AGPL-3.0 licence is compatible with). Every ported file says which source files and commit it derives from.

**Honest state: only Phase 0 exists.** It has been checked against a real PS5 (see the table); nothing beyond discovery
has talked to a real PlayStation yet. Each phase ends with something you can run at home that either works or prints a
precise reason, so the port is validated against real hardware one small step at a time.

## How each phase is checked

1. **Unit tests** with known answers wherever they exist (AES-GCM through `node:crypto`, round trips for the erasure code, framing).
2. **A simulated console** that speaks the console side, written from the same reading of the source. It catches coding mistakes.
   It cannot catch a *misreading* shared by both sides, so it is never reported as proof of correctness.
3. **A run on your console** with a small tool that prints what happened. This is the only real evidence. Bring back the output.

Do not share packet captures that contain registration keys or tokens.

## Phases

| Phase | What | Source it derives from | Check at home |
|---|---|---|---|
| **0 (done)** | Find consoles, read their state, wake one | `discovery.c`, `http.c` | `npm run discover` lists your console (name, state, system version). **Confirmed on a real PS5 in rest mode, run from macOS (2026-11-20):** the SRCH probe, port 9302, the `00030010` protocol version and the response parser all matched. **Not yet verified:** WAKEUP (needs a registration key), PS4, Windows and Linux hosts. |
| **1a (done, confirmed on a real PS5)** | Registering with a console: PIN key schedule, request body, search and TCP exchange, reading the answer, storing the result | `regist.c`, `rpcrypt.c` (registration part) | `npm run register` or the page: prints the registered console or the console's exact reason for refusing. **Confirmed on a real PS5 (2026-11-21, from macOS):** the console accepted the registration and the stored keys work from a second computer after `npm run consoles -- export/import`. Also checked against chiaki-ng's test vectors. **Unverified:** the PS4 paths. |
| **1b (done, confirmed on a real PS5)** | Session init request, session keys from the nonce and the registration key (`keys_a`/`keys_b`), version mismatch handling | `session.c`, `rpcrypt.c` | Part of every connection. **Confirmed on a real PS5** from macOS and Windows. Measured: a request the console accepted and that is not followed up keeps it "in use" (`0x80108b10`) for about 30 s; after a connection ends, for about 6 s. The link asks again for 36 s. |
| **2 (done, confirmed on a real PS5)** | Control connection (TCP 9295): request with values encrypted by the session keys, message framing, session id, heartbeat, login PIN request | `ctrl.c`, `session.c` (device id) | `npm run connect` walks discovery, session request, control connection and session id, and says where it stops. **Confirmed on a real PS5 (2026-11-21):** the console accepted the control request, its type decrypted to 2 (PS5) and it sent a valid session id. That is the first use of the session keys, so it also confirms the PS5 session key schedule (`keys_a`/`keys_b`) and Phase 1b. **Not built:** sending the account's login PIN from the page, the PSN path. |
| **3 (done, confirmed on a real PS5)** | Takion transport over UDP 9296 (handshake, acknowledgements, retransmission, packet MACs and cipher, audio/video packet headers for protocol 7, 9 and 12), protobuf messages | `takion.c`, `takionsendbuffer.c`, `reorderqueue.c`, `gkcrypt.c`, `takion.proto` | `npm run connect -- --stream 5`. All of the reference's own vectors pass, including MAC checks on packets captured from a console. Differences from the reference are listed at the top of `src/console/takion.ts` (16 bit wrap in the reorder queue, a larger socket receive buffer, no don't-fragment). |
| 4 (skipped for now) | Network test (RTT and MTU, port 9297) | `senkusha.c` | Not built. The stream uses the reference's fallbacks (MTU 1454, RTT 1 ms), which is what the reference does when its own test fails. |
| **5 (video done, confirmed on a real PS5)** | Stream set-up (BIG with launch spec and ECDH key, BANG, stream info), receiving video: frame assembly, forward error correction, loss handling, key frame requests | `streamconnection.c`, `launchspec.c`, `ecdh.c`, `frameprocessor.c`, `fec.c` (with the GF(2^8) arithmetic it takes from jerasure), `bitstream.c`, `videoreceiver.c`, `packetstats.c`, `congestioncontrol.c` | The browser shows the console's picture: 960x540@30 and 1920x1080@60 H.264 received without loss on a home network. FEC decodes all 64 of the reference's vectors. **Not built:** audio (Opus), haptics, HEVC in the page. **Not yet seen on hardware:** FEC recovery and corrupt frame reports (there was no loss to recover from). |
| **6 (done, confirmed on a real PS5)** | Sending input (state plus history events), loss reports, clean disconnect | `feedbacksender.c`, `feedback.c`, `controller.c`, `congestioncontrol.c` | `node tools/snap-console.mjs --nudge`: a d-pad press from the page moved the selection on the console and back. **Not built:** touchpad, a physical controller's rumble and trigger effects, microphone. |
| 7 | Quality profile mapping, Opus audio, remote (PSN) connection | `session.c`, `remote/*` | later |

The sizes of the source files involved (about 400 KB of C in total, of which `rpcrypt.c` is mostly constant tables)
mean this is a long port. It is done in this order so that every step is testable on its own.

## Observed on real hardware

See also `docs/stream-research.md` for what was measured about the stream itself (timing, stalls, what the console does
when asked for a key frame).

Facts seen on a PS5 in rest mode (2026-11-20, macOS, home network). Identifiers are left out on purpose.

- The answer to SRCH is `HTTP/1.1 620 Server Standby` with LF line ends and the headers `host-id`, `host-type`,
  `host-name`, `host-request-port` (997), `device-discovery-protocol-version` (`00030010`), `system-version`
  (an 8 digit number; `14230000` here). A console in rest mode sends no `running-app-*` headers. This exact shape is a
  regression test.
- The PS5 answered the PS5 probe and did **not** answer the PS4 probe (987 and version `00020020`).
- A broadcast reaches the console once per interface path, so with two interfaces on the same subnet each probe is
  answered twice. Results are de-duplicated by host id.
- The same answer comes back whether the probe is broadcast or sent to the console's address.

## Risks to keep in mind

- **Sony can change the protocol.** chiaki-ng follows those changes in its C code; the port has to follow them too.
  Each file records the chiaki-ng commit it was written from so differences are easy to find.
- **Shared misreadings.** See above: the simulator is not proof.
- **Registration.** The console must be registered once. This project registers itself (the same exchange other Remote
  Play clients use), so the registration key never has to be copied out of another program. The result is kept in
  `~/.gtp/consoles.json` (or `$GTP_HOME`), written with owner-only permissions where the system supports it, and is never
  sent to the browser. Treat that file like a password for your console.
- **The PSN account id.** The console wants the numeric id of your PSN account during registration. It can be typed in
  (a decimal number, or its 8 bytes in base64), or fetched by the page ("If you do not know your PSN account ID, get it here").
  Fetching is the flow chiaki-ng uses: the user logs in on Sony's own page, a one-time code in the redirect address is
  exchanged at Sony's token endpoint, and the id is read from the token info. **That exchange is authenticated with the
  client id and secret of Sony's own Remote Play application** (published by chiaki-ng), which makes it a grey area: an
  unofficial client presenting an official application's credentials. It was added only because the project owner asked
  for it, it is opt-in (the page shows a notice that must be accepted), runs on the bridge only (the secret never reaches
  a browser), and keeps as little as possible: the access and refresh tokens are never stored, logged or returned, only the
  account id is kept, and the code is cleared from the page after use. Rate limited to 6 exchanges a minute. Anyone who
  prefers not to use it can leave it alone and type the number in. Not yet run against Sony's servers.
- **LAN only first.** Connecting from outside the home network needs a PSN login and NAT traversal (`lib/src/remote/`).

## Browser-only later

The same TypeScript can later run inside an Isolated Web App (Direct Sockets) or an Electron/Tauri shell, which would
remove the bridge for desktop clients. Notes in the project docs (the browser-only feasibility note).
