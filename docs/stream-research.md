# Studying the stream

One of this project's aims is a stream that does not stutter: to find out where hitches come from and to take them out
where a client can. This page says what can be measured, what can be changed, and what has been found so far.
Everything under "Found so far" was measured on one home network with one PS5 and one Windows laptop on Wi-Fi; it is
evidence about that setup, not a general result.

## What is measured

Two ends of the same stream:

- **`stream`**: frames as they arrive at the bridge from the console (after decryption, reordering, error correction).
- **`display`**: frames as they go onto the screen in the browser (after the WebSocket hop, decoding and pacing). This
  is the part a viewer sees.

Both are kept per second for the last ten minutes, with totals and an event list.

```
GET /api/stream/stats            everything; ?samples=N limits both series to the last N seconds
GET /api/stream/tuning           the settings below
POST /api/stream/tuning          { enableIdrOnFecFailure?, packetLossMax?, congestionIntervalMs?, heartbeatIntervalMs? }
                                 (applies to the next connection)
GET /api/handover                whether this client hands the console over to this project's other clients
```

`stream` (per second, and totals):

| Field | Meaning |
|---|---|
| `frames`, `keyFrames`, `bytes` | what arrived |
| `frameGapMeanMs`, `frameGapJitterMs`, `frameGapMaxMs` | time between frames: mean, standard deviation, longest |
| `stutters` (totals), event `stutter` | a gap longer than 2.5 frame times (83 ms at 30 fps, 42 ms at 60) |
| `assemblyMeanMs`, `assemblyMaxMs` | from the first packet of a frame to the complete frame: are its packets spread out? |
| `loopDelayMaxMs` | the longest this process kept its own event loop from running: was the hitch made here? (On Windows about 13 to 16 ms is the timer's own granularity, not a delay.) |
| `unitsReceived`, `unitsLost`, `lossReported` | packets counted per congestion interval, and the share reported to the console after the clamp |
| `framesLost`, `fecRecovered`, `corruptReports`, `idrRequests` | loss and what was done about it |
| `stages` | ms from the start to: session, control, transport, bang, streaminfo, first-frame |
| events | `stage`, `stutter`, `frames-lost`, `units-lost`, `fec-failure`, `corrupt-report`, `idr-request`, `session-in-use`, `control-retry`, `handover`, `profile`, `console-disconnect`, `stopped` |

`display` (per second, and totals), reported by the page once a second:

| Field | Meaning |
|---|---|
| `shown` | frames put on the screen |
| `gapMaxMs` | the longest the picture stood still |
| `hitches` | times it stood still for more than 2.5 frame times |
| `underruns` | frames that arrived after their slot (shown at once) |
| `skipped` | frames never shown because a newer one was due at the same refresh |
| `lateMaxMs` | how much later than the stream's own pace the latest frame arrived |
| `delayMs`, `mode` | the delay the page was holding frames back by, and the playout mode |
| `decodeMaxMs`, `decodeQueueMax` | the slowest frame through the decoder, and the most frames waiting inside it |
| `resyncs` | times the decoder was so far behind that the stream was restarted from a key frame |

## What can be changed

| Where | Setting | What it does |
|---|---|---|
| page, "Display mode" (or `?playout=`) | `smooth` / `balanced` / `immediate` / a number | paced playout with up to 100 ms or 50 ms of delay, showing on arrival, or a fixed delay in ms |
| page, "Quality" (or `?quality=`) | `saver`, `balanced`, `low-latency`, `quality` | 640x360@30 to 1920x1080@60; fixed when the stream starts |
| `/api/stream/tuning` | `enableIdrOnFecFailure` | ask for a key frame when error correction fails (the reference's option; off by default) |
| | `packetLossMax` | the most loss reported to the console per interval (default 0.05, the reference's value) |
| | `congestionIntervalMs`, `heartbeatIntervalMs` | how often loss is reported (200) and the keep-alive is sent (1000) |

## Tools

```sh
npm run connect -- --stream 30 --video 1920x1080x60x15000 --stats run.json
        # receive only, no browser: what arrives at the bridge. Options: --idr-on-fec-failure --loss-max 0.05 --congestion-ms 200
node tools/snap-console.mjs --watch 60 --playout smooth --quality quality --stats run.json
        # a real (headless) browser on the whole path: what goes on the screen. --playout immediate to compare, --no-gpu for software decoding
node tools/snap-console.mjs --nudge
        # presses the d-pad down and up once from the page and compares pictures: does input arrive?
```

Both tools take part in the handover: connect from a page while one runs and it lets go.

## Found so far

1. **The stream itself is clean.** 30 s of 960x540@30 and of 1920x1080@60: no packet loss, exactly the nominal number of
   frames, mean gap 16.68 ms at "60 fps" (so the console runs at 59.94) and 33.35 ms at "30".

2. **Whole frames arrive late in short stalls.** At 1080p60, a few gaps of 50 to 63 ms about every 20 s, in pairs or
   threes 300 ms apart. In those seconds the event loop delay and the assembly time were as always, so the frames were
   late as a whole, before they reached this process. Pings from the same computer to the router, with the console not
   involved, showed delays of 42 to 57 ms in the same pattern. So this is the Wi-Fi link of the receiving computer.
   A Wi-Fi adapter that looks for other access points has to leave its channel for a moment, which fits the pattern;
   what triggers it on that computer has not been identified.

3. **A client can make this much worse, and this one did.** After a stall of 0.15 to 0.7 s the held-up frames arrive
   together. The player saw a backlog in the decoder, dropped everything and asked for a key frame. The console delivers
   a key frame **0.85 to 0.95 s** after it is asked for, and the picture stood still until then: a stall of 0.2 s became
   a freeze of a second. Letting the decoder work through the backlog (it does that far faster than real time) removed
   these: restarts went from one per 45 s to none. A key frame request is the most expensive thing a client can do and
   should be the last resort.

4. **Pacing hides the short stalls.** `src/bridge/playout.ts` learns the stream's pace from its frame counter and shows
   each frame on that pace, later than the earliest possible by what the latest frame of the last minute needed. Same
   45 s test at 1080p60, same network: 74 hitches when showing on arrival, 10 with paced playout, and those 10 were
   around stalls longer than its 100 ms limit. The cost is that delay (it sat at 80 to 100 ms on this network, which
   had stalls of up to 0.5 s; on a quiet one it is a few ms). The test browser was a headless Chrome under load and
   added stalls of its own, so the absolute numbers are for that machine.

5. **Software decoding of 1080p60 is not fast enough** on that laptop (about 57 frames a second): the decoder falls
   further and further behind. With the GPU it takes 2 to 20 ms a frame. The page reports `decodeMaxMs` and
   `decodeQueueMax` so this is visible; stepping the quality down by itself is not built.

6. **Connecting.** After a connection ends the console answers "Remote Play is already in use" (`0x80108b10`) for about
   6 s. After a session request that it accepted and that was not followed up, for about 30 s. Once, a console accepted
   the session and then did not answer the control request for 5 s (not reproduced, cause unknown). The link asks again
   for 36 s, starts over once when the control connection stays silent, and never sends a session request it does not
   intend to follow up.

7. **The receive buffer.** The reference asks the operating system for a 100 KiB socket buffer. With the browser's
   decoder busy on the same machine there was real loss at the bridge (14 to 34 frames in a minute) that was not there
   when only the bridge ran. The buffer is now 4 MiB; with the GPU decoding, loss was 0 again. Which of the two changes
   removed it has not been separated.

## Not yet looked at

- The official app on the same network, measured the same way (only a guess so far that it sees the same stalls).
- The same measurements from a wired computer, and from the Mac.
- Forward error correction and corrupt frame reports under real loss (there has been none), and whether
  `enableIdrOnFecFailure` helps or hurts given what a key frame costs.
- The bitrate the console actually sends against the one asked for (a still menu sends about 1 Mbit/s of the 15 asked).
- Input to picture latency with a real console (it needs a way to see the effect of an input in the picture).
- The browser hop over a real network: WebSocket is TCP, so one lost packet holds back everything behind it.
  WebRTC or WebTransport datagrams are the planned answer.
- Audio.
