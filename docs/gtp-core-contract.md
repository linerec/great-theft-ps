# gtp-core: the console-facing program

**Status: specified, NOT written, NOT compiled, NOT tested against a console.**
The bridge side of this contract (`src/bridge/core-link.ts`) is implemented and tested with a fake core
(`tools/fake-core.mjs`, 5 tests). The native program itself needs a C/C++ toolchain and a PlayStation on the
same network, which the development machine did not have. Everything below marked *to verify* is unverified.

## What it is

A small command-line program built on libchiaki (AGPL-3.0, from [chiaki-ng](https://github.com/chiaki-ng/chiaki-ng))
that connects to a registered console over Remote Play, forwards the console's encoded video frames to the bridge,
and applies pad state it receives to the stream. The bridge starts it with `--link core --core <path>`.

```
browser  <-- WebSocket -->  bridge (Node)  <-- stdin/stdout, framed -->  gtp-core  <-- Remote Play (UDP/TCP) -->  console
```

## Framing

Both pipes carry messages as `u32 little-endian length` + `length` bytes. The first byte is the type.
Maximum message size 8 MiB. Zero length or oversize is a protocol error (the bridge reports it and ignores the stream).

### Bridge to core (stdin)

| Type | Body | Meaning |
|---|---|---|
| `0x01` PAD | exactly the PAD message of `src/bridge/protocol.ts` (18 bytes, or 58 with motion) | Latest pad state. `seq` increases with every message. |
| `0x02` QUALITY | UTF-8 JSON `{preset,width,height,fps,bitrateKbps,codec}` | Requested video profile. Sent right after start and on every change. |
| `0x03` QUIT | none | Release the pad, close the session, exit 0. |
| `0x04` KEYFRAME | none | Ask the console for an IDR frame. |

### Core to bridge (stdout)

| Type | Body | Meaning |
|---|---|---|
| `0x10` VIDEO | exactly the VIDEO message of `src/bridge/protocol.ts` (19 byte header + Annex B frame) | One frame. `codec` 1 = H.264, `key` = IDR, `inputSeq` may be 0 (unknown). |
| `0x13` STATUS | UTF-8 JSON `{state: "connecting"\|"streaming"\|"closed"\|"error", detail?: string}` | Session state, shown in the client. |
| `0x14` LOG | UTF-8 text | Diagnostics, written to the bridge log. stderr is also logged. |

## Behaviour the bridge relies on

1. **Release on exit.** On QUIT, on stdin closing, and on any fatal error the core must send neutral pad state
   (all buttons up, sticks centred) before closing, so no button stays held on the console.
2. **H.264 for browsers.** Ask the console for H.264 whatever the preset says. Browsers cannot all decode HEVC (the test
   machine's Chrome could not). Frames must be complete access units in Annex B with SPS/PPS before every IDR.
3. **Quality changes.** The video profile cannot be changed inside a running session; the core reconnects with the new
   profile and reports `connecting` then `streaming`. Values outside the console's own presets are *to verify*:
   the console may refuse or round them (the saver preset asks for 640x360 at 1000 kbps, below the 360p preset's 2000).
4. **Input rate.** PAD messages arrive on change plus a 100 ms keepalive. Forward the latest state; the library sends
   feedback on its own schedule (8 to 200 ms in the reference implementation).
5. **Frame loss.** Report nothing for ordinary loss; send KEYFRAME handling through the library's IDR request.

## Where to look in libchiaki (read from the chiaki-ng source, commit 43728af; *verify against your checkout*)

- Session setup and callbacks: `lib/include/chiaki/session.h` (`ChiakiConnectInfo`, `ChiakiConnectVideoProfile` with width, height,
  max_fps, bitrate and codec; `chiaki_connect_video_profile_preset`).
- Encoded frames: `ChiakiVideoSampleCallback(buf, buf_size, frames_lost, frame_recovered, user)` via `chiaki_session_set_video_sample_cb`.
  This is the hook for VIDEO messages, with no decoding in the core.
- Keyframe: `chiaki_session_request_idr`.
- Input: `ChiakiControllerState` in `lib/include/chiaki/controller.h` (buttons as a 16-bit mask in the same bit order as `BUTTON` in
  `src/engine/types.ts`, `l2_state`/`r2_state`, four int16 sticks, gyro, accel and orientation as floats).
  The library clamps gyro to +-30 before quantising.
- Audio (Opus) is not forwarded yet.

## Registration and credentials

A console must be registered once (PIN, or PSN account). The registration result (host, registration key and the related
key material) is read by the core from a config file path given with `--config`. How to obtain those values and whether
reusing a chiaki-ng registration is practical is *to verify*. The first milestone is LAN only, on your own console and account.
Nothing in this project extracts or shares account secrets.

## Build (suggested, *untested*)

CMake project that adds chiaki-ng as a subdirectory or submodule and links `chiaki-lib`. Needs a C compiler, CMake,
OpenSSL development files and the protobuf/nanopb tooling that libchiaki uses. FFmpeg is not needed because frames are not decoded.
Expect to iterate on the first build; send the errors back and they will be fixed.

## Acceptance checklist for the first run with a console

1. `gtp-core --config <file>` prints STATUS `connecting` then `streaming`.
2. VIDEO messages arrive at the expected rate; the first has `key = 1` and contains an SPS.
3. The browser shows the console picture (H.264 path of `web/video-player.ts`).
4. A PAD with Cross held opens the console's menu entry; releasing it stops. Closing the browser tab releases everything.
5. Measure input-to-picture latency on the LAN and compare with the simulated console's (9 to 19 ms through the bridge alone).
