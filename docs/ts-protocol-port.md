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
| 1 | Registration material, session init request, crypto for the init exchange, version negotiation (`RP-Version`) | `regist.c`, `session.c`, `rpcrypt.c`, `ecdh.c` | a tool prints "session request accepted" or the console's reason for refusing |
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
- **Registration.** The console must be registered once. Where the registration key and related key material come from,
  and how this project receives them, is decided in Phase 1. Nothing here extracts or shares account secrets.
- **LAN only first.** Connecting from outside the home network needs a PSN login and NAT traversal (`lib/src/remote/`).

## Browser-only later

The same TypeScript can later run inside an Isolated Web App (Direct Sockets) or an Electron/Tauri shell, which would
remove the bridge for desktop clients. Notes in the project docs (`05-브라우저-단독-가능성.md`).
