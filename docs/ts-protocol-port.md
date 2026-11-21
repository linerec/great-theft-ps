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
| **1a (written, not yet run on hardware)** | Registering with a console: PIN key schedule, request body, search and TCP exchange, reading the answer, storing the result | `regist.c`, `rpcrypt.c` (registration part) | `npm run register` or the page's "콘솔 등록": prints the registered console or the console's exact reason for refusing. **Checked** against chiaki-ng's own test vectors (cipher, IV, PS5 and PS4 10 keys, PS4 request body byte for byte) and a simulated console. **Unverified:** the PS5 request layout and key table 1 against real hardware, and the PS4 paths altogether. |
| **1b (written, not yet run on hardware)** | Session init request, session keys from the nonce and the registration key (`keys_a`/`keys_b`), version mismatch handling | `session.c`, `rpcrypt.c` | The PS5 page's **"연결 확인"** button (`/api/session-check`) sends the request with the stored registration and shows "accepted" or the console's reason. **Checked** against chiaki-ng's test vector for the PS4 10 key schedule and a simulated console. **Unverified:** the PS5 key schedule (no published vector) and the whole exchange on a real PS5. `ecdh.c` belongs to the next step. |
| 2 | Control channel (TCP 9295): encrypted exchange that sets up the stream | `ctrl.c` | tool reaches "ready to stream" and prints the negotiated parameters |
| 3 | Takion transport over UDP (handshake, acknowledgements, retransmission) | `takion.c`, `takionsendbuffer.c`, `reorderqueue.c` | tool shows a completed Takion handshake |
| 4 | Network test (RTT and MTU, port 9297) | `senkusha.c` | tool prints measured RTT and MTU |
| 5 | Receiving video and audio: packet authentication (GMAC), frame assembly, forward error correction, keyframe requests | `streamconnection.c`, `gkcrypt.c`, `frameprocessor.c`, `fec.c`, `videoreceiver.c` | frames flow to the bridge; the browser shows the console picture |
| 6 | Sending input (state every 8 to 200 ms plus history), loss reports, clean disconnect | `feedbacksender.c`, `congestioncontrol.c`, `controller.c` | a button press does something on the console; closing releases everything |
| 7 | Quality profile mapping, Opus audio, remote (PSN) connection | `session.c`, `remote/*` | later |

The sizes of the source files involved (about 400 KB of C in total, of which `rpcrypt.c` is mostly constant tables)
mean this is a long port. It is done in this order so that every step is testable on its own.

## Observed on real hardware

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
  (a decimal number, or its 8 bytes in base64), or fetched by the page ("PSN 계정 ID를 모르면 여기서 가져오기").
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
remove the bridge for desktop clients. Notes in the project docs (`05-브라우저-단독-가능성.md`).
