// SPDX-License-Identifier: AGPL-3.0-only
//
// The video receiver: packets in, frames out. chiaki-ng has no test for lib/src/videoreceiver.c (commit 43728af), so
// everything here is written for this port. Frames are built here: each starts with a real slice header (the slices
// of chiaki-ng's test/bitstream.c, so that the reference frame tracking has something to read) followed by random
// bytes, is cut into units with FEC units from this port's encoder (test/frameprocessor.test-helpers.ts), and then
// units and whole frames are dropped, reordered and repeated. The expected behaviour is worked out from the C code.
// This shows that the port does what a reading of the reference says, not what a console does.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TakionAvPacket } from '../src/console/av-packet.ts';
import {
  BITSTREAM_SLICE, bitstreamHeader, bitstreamInit, bitstreamSlice, bitstreamSliceSetReferenceFrame, type BitstreamSlice,
} from '../src/console/bitstream.ts';
import { PacketStats } from '../src/console/packetstats.ts';
import { VIDEO_PROFILES_MAX, VideoReceiver, type VideoFrameInfo, type VideoReceiverOptions } from '../src/console/videoreceiver.ts';
import { makePacket, packetizeFrame, prng, randomBytes, shuffled } from './frameprocessor.test-helpers.ts';

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'hex'));

// Stream headers and the first bytes of slices, from chiaki-ng test/bitstream.c.
const H264_HEADER = hex('00 00 00 01 67 4d 40 32 91 8a 01 e0 08 9f 97 01 6a 02 02 02 80 00 03 e9 00 01 d4 c0 44 d0 f1 f1 50 00 00 00 01 68 ee 3c 80');
const H264_I = hex('00 00 00 01 65 88 80 82 1f 00 49 ee 03 29 ff f8 7f 88 46 44 77 17 e7 6d b3 ad 38 19 74 5a f1 51');
/** P slice referring to the frame before it. */
const H264_P = hex('00 00 00 01 41 9a 04 44 3f 41 5b f4 65 b4 3e 1a d3 a0 28 1f 83 63 0e c2 fc 9d 7a c7 c4 7d f9 18');
/** P slice referring to the frame 6 before it (reference_frame 5). */
const H264_P_REF_5 = hex('00 00 00 01 41 9b fd 98 89 df 00 03 24 60 47 1a 90 10 b3 2c 4e 45 fc ff 45 24 8c 79 ec 12 e5 9b');
const H265_HEADER = hex(`
  00 00 00 01 40 01 0c 01 ff ff 01 60 00 00 03 00 b0 00 00 03 00 00 03 00 96 0a c0 90 00 00 00 01
  42 01 01 01 60 00 00 03 00 b0 00 00 03 00 00 03 00 96 a0 03 c0 80 11 07 cb c2 b9 24 29 52 70 16
  a0 20 20 20 80 00 07 d2 00 01 d4 c0 20 e5 a1 e3 d0 00 00 00 01 44 01 c0 f3 c0 4c 90`);
const H265_I = hex('00 00 00 01 28 01 ac 25 cf 83 ff 23 54 ab 5c f5 7a 06 7c 3f 31 9b e6 10 57 e8 0e cf dd da db 3f');
/** P slice referring to the frame before it, listing 9 earlier frames it could refer to instead. */
const H265_P = hex('00 00 00 01 02 01 d2 85 7a aa a6 08 60 13 55 17 6b 71 72 f9 6e d4 f2 66 78 0c 12 e7 79 f0 bc c9');

const UNIT = 100;
const FEC = 2;
/** 5 source units and 2 FEC units per frame. */
const FRAME_SIZE = 98 * 4 + 60;

type Kind = 'I' | 'P' | 'R';
const HEADS: Record<'h264' | 'h265', Record<Kind, Uint8Array>> = {
  h264: { I: H264_I, P: H264_P, R: H264_P_REF_5 },
  h265: { I: H265_I, P: H265_P, R: H265_P },
};

interface TestFrame {
  index: number;
  bytes: Uint8Array;
  packets: TakionAvPacket[];
}

/** One frame per letter: I, P (refers to the frame before) or R (H.264 only: refers to the frame 6 before). */
function makeFrames(codec: 'h264' | 'h265', kinds: string, seed: number, firstIndex = 0, profile = 0): TestFrame[] {
  const rnd = prng(seed);
  return [...kinds].map((kind, i) => {
    const head = HEADS[codec][kind as Kind];
    const bytes = new Uint8Array(FRAME_SIZE);
    bytes.set(head);
    bytes.set(randomBytes(rnd, FRAME_SIZE - head.length), head.length);
    const index = (firstIndex + i) & 0xffff;
    return { index, bytes, packets: packetizeFrame(bytes, { frameIndex: index, unitSize: UNIT, fecUnits: FEC, adaptiveStreamIndex: profile }) };
  });
}

interface FrameEvent {
  type: 'header' | 'frame';
  data: Uint8Array;
  info: VideoFrameInfo;
}
type Event =
  | FrameEvent
  | { type: 'corrupt'; start: number; end: number }
  | { type: 'idr' }
  | { type: 'fec-failure'; frameIndex: number; idrRequestSent: boolean };

function harness(codec: 'h264' | 'h265', opts: Partial<VideoReceiverOptions> = {}, profiles = 1) {
  const events: Event[] = [];
  const clock = { ms: 1_000_000 };
  const receiver = new VideoReceiver({
    codec,
    onFrame: (frame, info) => {
      events.push({ type: info.isHeader ? 'header' : 'frame', data: Uint8Array.from(frame), info });
    },
    onCorruptFrames: (start, end) => {
      events.push({ type: 'corrupt', start, end });
    },
    onIdrRequest: () => {
      events.push({ type: 'idr' });
    },
    onFecFailure: (e) => {
      events.push({ type: 'fec-failure', ...e });
    },
    now: () => clock.ms,
    ...opts,
  });
  const header = codec === 'h264' ? H264_HEADER : H265_HEADER;
  receiver.streamInfo(Array.from({ length: profiles }, (_, i) => ({ width: 1280 + i, height: 720 + i, header })));
  const summary = (): string[] => events.map((e) => {
    if (e.type === 'header' || e.type === 'frame') return `${e.type}:${e.info.frameIndex}`;
    if (e.type === 'corrupt') return `corrupt:${e.start}-${e.end}`;
    if (e.type === 'idr') return 'idr';
    return `fec-failure:${e.frameIndex}:${e.idrRequestSent}`;
  });
  const frameEvents = (): FrameEvent[] => events.filter((e): e is FrameEvent => e.type === 'frame');
  const feed = (packets: readonly TakionAvPacket[]): void => {
    for (const p of packets) receiver.avPacket(p);
  };
  return { receiver, events, clock, summary, frameEvents, feed, header };
}

const without = (frame: TestFrame, lost: number[]): TakionAvPacket[] => frame.packets.filter((_, i) => !lost.includes(i));

describe('video receiver: a stream without losses', () => {
  for (const codec of ['h264', 'h265'] as const) {
    it(`${codec}: the stream header first, then every frame byte for byte, in order`, () => {
      const h = harness(codec);
      const frames = makeFrames(codec, 'IPPPPP', 1);
      for (const f of frames) h.feed(f.packets);

      assert.deepEqual(h.summary(), ['header:0', 'frame:0', 'frame:1', 'frame:2', 'frame:3', 'frame:4', 'frame:5']);
      const first = h.events[0] as FrameEvent;
      assert.deepEqual(first.data, h.header);
      assert.deepEqual(first.info, {
        isHeader: true, frameIndex: 0, framesLost: 0, recovered: false, profileIndex: 0, sliceType: BITSTREAM_SLICE.UNKNOWN, keyFrame: false, fecRecovered: false,
      });
      for (const [i, e] of h.frameEvents().entries()) {
        assert.deepEqual(e.data, frames[i]!.bytes, `frame ${i}`);
        assert.deepEqual(e.info, {
          isHeader: false, frameIndex: i, framesLost: 0, recovered: false, profileIndex: 0,
          sliceType: i === 0 ? BITSTREAM_SLICE.I : BITSTREAM_SLICE.P, keyFrame: i === 0, fecRecovered: false,
        });
      }
      assert.equal(h.receiver.frameIndexPrevComplete, 5);
      assert.equal(h.receiver.getFramesLostTotal(), 0);
    });
  }

  it('a frame is handed out as soon as its last source unit is there, before its FEC units', () => {
    const h = harness('h264');
    const [f] = makeFrames('h264', 'I', 2);
    h.feed(f!.packets.slice(0, 4));
    assert.deepEqual(h.summary(), ['header:0']);
    h.feed(f!.packets.slice(4, 5));
    assert.deepEqual(h.summary(), ['header:0', 'frame:0']);
    h.feed(f!.packets.slice(5));
    assert.deepEqual(h.summary(), ['header:0', 'frame:0']);
  });

  it('what is handed out starts with a start code and a slice; the stream header is not put in front', () => {
    const h = harness('h264');
    const frames = makeFrames('h264', 'IP', 3);
    for (const f of frames) h.feed(f.packets);
    const [i, p] = h.frameEvents();
    assert.deepEqual(Array.from(i!.data.subarray(0, 5)), [0, 0, 0, 1, 0x65]);
    assert.deepEqual(Array.from(p!.data.subarray(0, 5)), [0, 0, 0, 1, 0x41]);
    assert.equal(i!.data.length, FRAME_SIZE);
  });

  it('the first frame may be number 1; a stream that starts later reports the frames before as missing', () => {
    const one = harness('h264');
    for (const f of makeFrames('h264', 'IPP', 4, 1)) one.feed(f.packets);
    assert.deepEqual(one.summary(), ['header:1', 'frame:1', 'frame:2', 'frame:3']);

    const five = harness('h264');
    for (const f of makeFrames('h264', 'IPP', 4, 5)) five.feed(f.packets);
    assert.deepEqual(five.summary(), ['header:5', 'corrupt:1-4', 'frame:5', 'frame:6', 'frame:7']);
  });

  it('frame numbers wrap around from 65535 to 0', () => {
    const h = harness('h264');
    const frames = makeFrames('h264', 'IPPPPPP', 5, 65533);
    for (const f of frames) h.feed(f.packets);
    assert.deepEqual(h.summary(), ['header:65533', 'frame:65533', 'frame:65534', 'frame:65535', 'frame:0', 'frame:1', 'frame:2', 'frame:3']);
    for (const [i, e] of h.frameEvents().entries()) assert.deepEqual(e.data, frames[i]!.bytes);
  });
});

describe('video receiver: lost units', () => {
  for (const codec of ['h264', 'h265'] as const) {
    it(`${codec}: up to as many lost units per frame as it has FEC units are made up for`, () => {
      const rnd = prng(10);
      const h = harness(codec);
      const frames = makeFrames(codec, 'IPPPPPPPPPPPPPPPPPPPPPPPPPPPPP', 11);
      const sourceLost: boolean[] = [];
      for (const f of frames) {
        const lost = shuffled([0, 1, 2, 3, 4, 5, 6], rnd).slice(0, rnd() % 3); // 0, 1 or 2 of the 7 units
        sourceLost.push(lost.some((i) => i < 5));
        h.feed(without(f, lost));
      }
      assert.deepEqual(h.summary(), ['header:0', ...frames.map((f) => `frame:${f.index}`)]);
      for (const [i, e] of h.frameEvents().entries()) {
        assert.deepEqual(e.data, frames[i]!.bytes, `frame ${i}`);
        assert.equal(e.info.fecRecovered, sourceLost[i], `frame ${i}`);
        assert.equal(e.info.framesLost, 0);
      }
      assert.ok(sourceLost.includes(true) && sourceLost.includes(false));
    });
  }

  for (const [name, lost] of [['its last unit arrives', [0, 1, 2]], ['its last unit is lost too', [0, 1, 6]], ['only two of its units arrive', [0, 1, 2, 3, 6]]] as Array<[string, number[]]>) {
    it(`h264: a frame that lost three units or more is reported and not handed out (${name}); the frames building on it neither`, () => {
      const h = harness('h264');
      //                                0123456789
      const frames = makeFrames('h264', 'IPPPPPPPRP', 12);
      for (const f of frames) h.feed(f.index === 3 ? without(f, lost) : f.packets);

      // Frame 3 cannot be rebuilt: reported once when it is given up, and again (as the reference does) with every
      // frame that follows, up to the frame before that one, until a frame can be shown again. Frames 4 to 7 refer to
      // the frame before them, which was never shown, so they are dropped. Frame 8 refers to frame 2 and is shown.
      assert.deepEqual(h.summary(), [
        'header:0', 'frame:0', 'frame:1', 'frame:2',
        'corrupt:3-3', 'corrupt:3-3', 'corrupt:3-4', 'corrupt:3-5', 'corrupt:3-6', 'corrupt:3-7',
        'frame:8', 'frame:9',
      ]);
      const shown = h.frameEvents();
      assert.deepEqual(shown[3]!.data, frames[8]!.bytes);
      assert.equal(shown[3]!.info.framesLost, 5, 'frame 3 and frames 4 to 7');
      assert.equal(shown[4]!.info.framesLost, 0);
      assert.equal(h.receiver.getFramesLostTotal(), 5);
      assert.equal(h.receiver.frameIndexPrevComplete, 9);
    });
  }

  it('h264: a frame of which nothing arrives is reported by the next frame; it is not itself counted as lost', () => {
    const h = harness('h264');
    const frames = makeFrames('h264', 'IPPPPPPPRP', 13);
    for (const f of frames) if (f.index !== 3) h.feed(f.packets);
    assert.deepEqual(h.summary(), [
      'header:0', 'frame:0', 'frame:1', 'frame:2',
      'corrupt:3-3', 'corrupt:3-4', 'corrupt:3-5', 'corrupt:3-6', 'corrupt:3-7',
      'frame:8', 'frame:9',
    ]);
    assert.equal(h.frameEvents()[3]!.info.framesLost, 4, 'frames 4 to 7, dropped for their missing reference');
    assert.equal(h.receiver.getFramesLostTotal(), 4);
  });

  it('h264: a key frame after a loss is shown whatever came before', () => {
    const h = harness('h264');
    const frames = makeFrames('h264', 'IPPPIP', 14);
    for (const f of frames) if (f.index !== 2) h.feed(f.packets);
    assert.deepEqual(h.summary(), ['header:0', 'frame:0', 'frame:1', 'corrupt:2-2', 'corrupt:2-3', 'frame:4', 'frame:5']);
    assert.equal(h.frameEvents()[2]!.info.keyFrame, true);
    assert.equal(h.frameEvents()[2]!.info.framesLost, 1);
  });

  it('h265: a frame whose reference frame is missing is rewritten to refer to the newest frame that was shown', () => {
    const h = harness('h265');
    const frames = makeFrames('h265', 'IPPPPPPP', 15);
    for (const f of frames) if (![3, 5, 6].includes(f.index)) h.feed(f.packets);

    assert.deepEqual(h.summary(), ['header:0', 'frame:0', 'frame:1', 'frame:2', 'corrupt:3-3', 'frame:4', 'corrupt:5-6', 'frame:7']);
    const shown = h.frameEvents();

    // frame 4 referred to frame 3 (reference_frame 0) and now refers to frame 2 (reference_frame 1)
    const bs = bitstreamInit('h265');
    assert.ok(bitstreamHeader(bs, H265_HEADER));
    const expected4 = Uint8Array.from(frames[4]!.bytes);
    assert.ok(bitstreamSliceSetReferenceFrame(bs, expected4, 1));
    assert.notDeepEqual(expected4, frames[4]!.bytes);
    assert.deepEqual(shown[3]!.data, expected4);
    assert.deepEqual(shown[3]!.data.subarray(16), frames[4]!.bytes.subarray(16), 'only the slice header changed');
    assert.equal(shown[3]!.info.recovered, true);
    assert.equal(shown[3]!.info.framesLost, 0, 'nothing counts as lost when the frame could be rewritten');
    const slice: BitstreamSlice = { sliceType: BITSTREAM_SLICE.UNKNOWN, referenceFrame: 0 };
    assert.ok(bitstreamSlice(bs, shown[3]!.data, slice));
    assert.equal(slice.referenceFrame, 1);

    // frame 7 referred to frame 6 and now refers to frame 4 (reference_frame 2)
    const expected7 = Uint8Array.from(frames[7]!.bytes);
    assert.ok(bitstreamSliceSetReferenceFrame(bs, expected7, 2));
    assert.deepEqual(shown[4]!.data, expected7);
    assert.equal(shown[4]!.info.recovered, true);
    assert.equal(h.receiver.getFramesLostTotal(), 0);
  });

  it('h265: when the slice does not list a frame that was shown, the frame is dropped and counted as lost', () => {
    const h = harness('h265');
    //                                0         1
    //                                01234567890123456
    const frames = makeFrames('h265', 'IPPPPPPPPPPPPPIP', 16);
    // frames 3 to 12 never arrive; frame 13 lists 9 earlier frames (12 down to 4), none of which was shown
    for (const f of frames) if (f.index < 3 || f.index > 12) h.feed(f.packets);
    assert.deepEqual(h.summary(), ['header:0', 'frame:0', 'frame:1', 'frame:2', 'corrupt:3-12', 'corrupt:3-13', 'frame:14', 'frame:15']);
    assert.equal(h.frameEvents()[3]!.info.framesLost, 1);
    assert.equal(h.receiver.getFramesLostTotal(), 1);
  });
});

describe('video receiver: packets out of order and repeated', () => {
  for (const codec of ['h264', 'h265'] as const) {
    it(`${codec}: the units of a frame in any order, as long as its last unit is not among the first four to arrive`, () => {
      const rnd = prng(20);
      const h = harness(codec);
      const frames = makeFrames(codec, 'IPPPPPPPPPPPPPPPPPPP', 21);
      for (const f of frames) {
        const order = shuffled(f.packets, rnd);
        // The unit with the highest index ends the frame when it arrives (see the test further down), so it has to
        // be the fifth unit or later: by then there are as many units as the frame has source units.
        const at = order.findIndex((p) => p.unitIndex === 6);
        if (at < 4) {
          const to = 4 + (rnd() % 3);
          [order[at], order[to]] = [order[to]!, order[at]!];
        }
        h.feed(order);
      }
      assert.deepEqual(h.summary(), ['header:0', ...frames.map((f) => `frame:${f.index}`)]);
      for (const [i, e] of h.frameEvents().entries()) assert.deepEqual(e.data, frames[i]!.bytes, `frame ${i}`);
      // a FEC unit that comes before the last source unit is used instead of waiting for it
      assert.ok(h.frameEvents().some((e) => e.info.fecRecovered));
    });
  }

  it('every packet twice in a row: each frame once', () => {
    const h = harness('h264');
    const frames = makeFrames('h264', 'IPPPP', 22);
    for (const f of frames) for (const p of f.packets) h.feed([p, p]);
    assert.deepEqual(h.summary(), ['header:0', 'frame:0', 'frame:1', 'frame:2', 'frame:3', 'frame:4']);
    for (const [i, e] of h.frameEvents().entries()) assert.deepEqual(e.data, frames[i]!.bytes);
  });

  it('a whole frame sent again after it was handed out, and again after the next frame began: nothing more comes out', () => {
    const lines: string[] = [];
    const h = harness('h264', { log: (l) => lines.push(l) });
    const frames = makeFrames('h264', 'IPP', 23);
    h.feed(frames[0]!.packets);
    h.feed(frames[0]!.packets);
    h.feed(frames[1]!.packets);
    h.feed(frames[0]!.packets);
    h.feed(frames[2]!.packets);
    h.feed(frames[1]!.packets);
    assert.deepEqual(h.summary(), ['header:0', 'frame:0', 'frame:1', 'frame:2']);
    assert.equal(lines.filter((l) => l === 'Video Receiver received old frame packet').length, 14);
    assert.equal(lines.filter((l) => l === 'Received duplicate unit').length, 7);
  });

  it('a repeated unit does not make an incomplete frame look complete', () => {
    const h = harness('h264');
    const [f] = makeFrames('h264', 'I', 24);
    h.feed([f!.packets[0]!, f!.packets[1]!, f!.packets[1]!, f!.packets[1]!, f!.packets[0]!, f!.packets[2]!, f!.packets[3]!]);
    assert.deepEqual(h.summary(), ['header:0'], 'four different units of five');
    h.feed([f!.packets[5]!]);
    assert.deepEqual(h.summary(), ['header:0', 'frame:0']);
    assert.deepEqual(h.frameEvents()[0]!.data, f!.bytes);
  });

  it('when the next frame begins, the frame before is given up; its late packets are ignored', () => {
    const h = harness('h264');
    const frames = makeFrames('h264', 'IPPI', 25);
    h.feed(frames[0]!.packets);
    h.feed(frames[1]!.packets.slice(0, 3)); // three of five source units
    h.feed(frames[2]!.packets.slice(0, 1));
    assert.deepEqual(h.summary(), ['header:0', 'frame:0', 'corrupt:1-1', 'corrupt:1-1']);
    h.feed(frames[1]!.packets.slice(3)); // too late
    h.feed(frames[2]!.packets.slice(1));
    h.feed(frames[3]!.packets);
    assert.deepEqual(h.summary(), ['header:0', 'frame:0', 'corrupt:1-1', 'corrupt:1-1', 'corrupt:1-2', 'frame:3']);
    assert.equal(h.frameEvents()[1]!.info.framesLost, 2);
  });

  it('when the next frame begins and enough units of the frame before are there, it is rebuilt and handed out first', () => {
    const h = harness('h264');
    const frames = makeFrames('h264', 'IPP', 26);
    h.feed(frames[0]!.packets);
    // source units 0, 1, 3 and both FEC units make five; the last one to arrive completes the frame
    h.feed([frames[1]!.packets[0]!, frames[1]!.packets[1]!, frames[1]!.packets[3]!, frames[1]!.packets[5]!]);
    assert.deepEqual(h.summary(), ['header:0', 'frame:0']);
    h.feed([frames[1]!.packets[6]!]);
    h.feed(frames[2]!.packets);
    assert.deepEqual(h.summary(), ['header:0', 'frame:0', 'frame:1', 'frame:2']);
    assert.deepEqual(h.frameEvents()[1]!.data, frames[1]!.bytes);
    assert.equal(h.frameEvents()[1]!.info.fecRecovered, true);
  });
});

describe('video receiver: profiles (chiaki_video_receiver_stream_info and switching)', () => {
  it('switching to another profile hands out that profile\'s header before its first frame', () => {
    const events: Array<[string, number, number]> = [];
    const headers = [H264_HEADER, Uint8Array.from([...H264_HEADER, 0xaa]), Uint8Array.from([...H264_HEADER, 0xbb])];
    const receiver = new VideoReceiver({
      codec: 'h264',
      onFrame: (frame, info) => {
        events.push([info.isHeader ? 'header' : 'frame', info.profileIndex, info.isHeader ? frame[frame.length - 1]! : info.frameIndex]);
      },
    });
    receiver.streamInfo(headers.map((header, i) => ({ width: 1920 >> i, height: 1080 >> i, header })));
    assert.equal(receiver.profiles.length, 3);
    assert.equal(receiver.profileCur, -1);

    for (const f of makeFrames('h264', 'IPP', 31, 0, 0)) for (const p of f.packets) receiver.avPacket(p);
    for (const f of makeFrames('h264', 'IPP', 32, 3, 2)) for (const p of f.packets) receiver.avPacket(p);
    for (const f of makeFrames('h264', 'IP', 33, 6, 1)) for (const p of f.packets) receiver.avPacket(p);
    for (const f of makeFrames('h264', 'IP', 34, 8, 2)) for (const p of f.packets) receiver.avPacket(p);
    assert.deepEqual(events, [
      ['header', 0, 0x80], ['frame', 0, 0], ['frame', 0, 1], ['frame', 0, 2],
      ['header', 2, 0xbb], ['frame', 2, 3], ['frame', 2, 4], ['frame', 2, 5],
      ['header', 1, 0xaa], ['frame', 1, 6], ['frame', 1, 7],
      ['header', 2, 0xbb], ['frame', 2, 8], ['frame', 2, 9],
    ]);
    assert.equal(receiver.profileCur, 2);
  });

  it('the header of the new profile is read for the slices that follow', () => {
    // profile 1 has a header the H.264 parser cannot read: the receiver goes on, but can no longer follow P slices
    const lines: string[] = [];
    const frameIndices: number[] = [];
    const receiver = new VideoReceiver({
      codec: 'h264',
      log: (l) => lines.push(l),
      onFrame: (_frame, info) => {
        if (!info.isHeader) frameIndices.push(info.frameIndex);
      },
    });
    receiver.streamInfo([{ width: 1, height: 1, header: H264_HEADER }, { width: 2, height: 2, header: H265_HEADER }]);
    for (const f of makeFrames('h264', 'IP', 35, 0, 0)) for (const p of f.packets) receiver.avPacket(p);
    assert.equal(receiver.bitstream.h264.sps.log2MaxFrameNumMinus4, 3);
    for (const f of makeFrames('h264', 'IP', 36, 2, 1)) for (const p of f.packets) receiver.avPacket(p);
    assert.equal(receiver.bitstream.h264.sps.log2MaxFrameNumMinus4, 0);
    assert.ok(lines.includes('Failed to parse video header'));
    assert.ok(lines.includes('Switched to profile 1, resolution: 2x2'));
    assert.deepEqual(frameIndices, [0, 1, 2, 3]);
  });

  it('packets for a profile that was not announced, or before the stream info, are dropped', () => {
    const none = new VideoReceiver({ codec: 'h264', onFrame: () => assert.fail('nothing may come out') });
    for (const f of makeFrames('h264', 'IP', 37)) for (const p of f.packets) none.avPacket(p);
    assert.equal(none.frameIndexCur, -1);

    const h = harness('h264', {}, 2);
    for (const f of makeFrames('h264', 'IP', 38, 0, 2)) h.feed(f.packets);
    assert.deepEqual(h.summary(), []);
    for (const f of makeFrames('h264', 'IP', 39, 0, 1)) h.feed(f.packets);
    assert.deepEqual(h.summary(), ['header:0', 'frame:0', 'frame:1']);
  });

  it('the stream info is taken once; at most eight profiles; the headers are copied', () => {
    const lines: string[] = [];
    const receiver = new VideoReceiver({ codec: 'h264', log: (l) => lines.push(l) });
    const header = Uint8Array.from(H264_HEADER);
    receiver.streamInfo(Array.from({ length: 10 }, (_, i) => ({ width: 100 + i, height: 50, header })));
    assert.equal(VIDEO_PROFILES_MAX, 8);
    assert.equal(receiver.profiles.length, 8);
    assert.equal(receiver.profiles[7]!.width, 107);
    header.fill(0);
    assert.deepEqual(receiver.profiles[0]!.header, H264_HEADER);

    receiver.streamInfo([{ width: 1, height: 1, header: H264_HEADER }]);
    assert.equal(receiver.profiles.length, 8);
    assert.ok(lines.includes('Video Receiver profiles already set'));
    assert.ok(lines.includes('  0: 100x50'));
  });
});

describe('video receiver: asking for a key frame after a frame that could not be rebuilt', () => {
  it('off by default: no request, the frames that follow are judged by their reference frame only', () => {
    const h = harness('h264');
    const frames = makeFrames('h264', 'IPPI', 40);
    for (const f of frames) h.feed(f.index === 1 ? without(f, [0, 1, 2]) : f.packets);
    assert.deepEqual(h.summary(), ['header:0', 'frame:0', 'corrupt:1-1', 'corrupt:1-1', 'corrupt:1-2', 'frame:3']);
    assert.equal(h.receiver.getWaitingForIdr(), false);
  });

  it('on: one request, P frames are dropped until an I frame arrives, and the request is repeated every second', () => {
    const h = harness('h264', { enableIdrOnFecFailure: true });
    //                                01234567
    const frames = makeFrames('h264', 'IPPRRIPP', 41);
    h.feed(frames[0]!.packets);
    h.feed(without(frames[1]!, [0, 1, 2]));
    assert.deepEqual(h.summary(), ['header:0', 'frame:0', 'corrupt:1-1', 'idr', 'fec-failure:1:true']);
    assert.equal(h.receiver.getWaitingForIdr(), true);

    h.clock.ms += 400;
    h.feed(frames[2]!.packets);
    h.clock.ms += 400;
    h.feed(frames[3]!.packets);
    assert.deepEqual(h.summary().slice(5), ['corrupt:1-1', 'corrupt:1-2'], 'dropped silently, no second request yet');

    h.clock.ms += 400; // 1200 ms after the request
    h.feed(frames[4]!.packets);
    assert.deepEqual(h.summary().slice(7), ['corrupt:1-3', 'idr']);

    h.clock.ms += 999;
    h.feed(frames[5]!.packets);
    assert.deepEqual(h.summary().slice(9), ['corrupt:1-4', 'frame:5']);
    assert.equal(h.receiver.getWaitingForIdr(), false);
    const key = h.frameEvents()[1]!;
    assert.equal(key.info.keyFrame, true);
    assert.equal(key.info.framesLost, 1, 'only the frame that failed counts; the P frames dropped while waiting do not');
    assert.deepEqual(key.data, frames[5]!.bytes);

    h.feed(frames[6]!.packets);
    h.feed(frames[7]!.packets);
    assert.deepEqual(h.summary().slice(11), ['frame:6', 'frame:7']);
    assert.equal(h.receiver.getFramesLostTotal(), 1);
  });

  it('on: a second failure while waiting does not send a second request before a second has passed', () => {
    const h = harness('h264', { enableIdrOnFecFailure: true });
    const frames = makeFrames('h264', 'IPPPI', 42);
    h.feed(frames[0]!.packets);
    h.feed(without(frames[1]!, [0, 1, 2]));
    h.clock.ms += 100;
    h.feed(without(frames[2]!, [0, 1, 2]));
    h.clock.ms += 1000;
    h.feed(without(frames[3]!, [0, 1, 2]));
    assert.deepEqual(h.summary(), [
      'header:0', 'frame:0',
      'corrupt:1-1', 'idr', 'fec-failure:1:true',
      'corrupt:1-1', 'corrupt:1-2', 'fec-failure:2:true',
      'corrupt:1-2', 'corrupt:1-3', 'idr', 'fec-failure:3:true',
    ]);
    h.feed(frames[4]!.packets);
    assert.equal(h.frameEvents()[1]!.info.framesLost, 1 + 2 + 3, 'each failure adds the frames since the last one shown, as in the reference');
  });

  it('on: when the request cannot be sent, the receiver does not wait', () => {
    const h = harness('h264', {
      enableIdrOnFecFailure: true,
      onIdrRequest: () => false,
    });
    const frames = makeFrames('h264', 'IPP', 43);
    h.feed(frames[0]!.packets);
    h.feed(without(frames[1]!, [0, 1, 2]));
    assert.deepEqual(h.summary(), ['header:0', 'frame:0', 'corrupt:1-1', 'fec-failure:1:false']);
    assert.equal(h.receiver.getWaitingForIdr(), false);
  });

  it('setWaitingForIdr(true) after a request made elsewhere: P frames are dropped until the I frame', () => {
    const h = harness('h264');
    const frames = makeFrames('h264', 'IPPIP', 44);
    h.feed(frames[0]!.packets);
    h.receiver.setWaitingForIdr(true);
    assert.equal(h.receiver.idrRequestLastMs, h.clock.ms);
    h.feed(frames[1]!.packets);
    h.clock.ms += 1000;
    h.feed(frames[2]!.packets);
    h.feed(frames[3]!.packets);
    h.feed(frames[4]!.packets);
    assert.deepEqual(h.summary(), ['header:0', 'frame:0', 'corrupt:1-1', 'idr', 'corrupt:1-2', 'frame:3', 'frame:4']);
    assert.equal(h.frameEvents()[1]!.info.framesLost, 0);
  });
});

describe('video receiver: the callbacks', () => {
  it('a frame the callback refuses does not count as shown: the frame referring to it is dropped', () => {
    const shown: number[] = [];
    const h = harness('h264', {
      onFrame: (_frame, info) => {
        if (info.isHeader) return;
        shown.push(info.frameIndex);
        if (info.frameIndex === 1) return false;
      },
    });
    for (const f of makeFrames('h264', 'IPPIP', 50)) h.feed(f.packets);
    assert.deepEqual(shown, [0, 1, 3, 4]);
    assert.deepEqual(h.summary(), ['corrupt:1-1', 'corrupt:1-2']);
    assert.equal(h.receiver.getFramesLostTotal(), 1);
  });

  it('without a frame callback no frame is remembered as a reference: every P frame counts as lost', () => {
    const corrupt: string[] = [];
    const receiver = new VideoReceiver({ codec: 'h264', onCorruptFrames: (s, e) => void corrupt.push(`${s}-${e}`) });
    receiver.streamInfo([{ width: 1, height: 1, header: H264_HEADER }]);
    for (const f of makeFrames('h264', 'IPP', 51, 1)) for (const p of f.packets) receiver.avPacket(p);
    assert.equal(receiver.frameIndexPrevComplete, 1, 'the I frame counts as complete');
    assert.deepEqual(Array.from(receiver.referenceFrames), new Array(16).fill(-1));
    assert.deepEqual(corrupt, ['2-2']);
    assert.equal(receiver.getFramesLostTotal(), 2);
  });

  it('a callback that throws: the error comes out of avPacket and the receiver carries on as if it had said no', () => {
    const shown: number[] = [];
    const h = harness('h264', {
      onFrame: (_frame, info) => {
        if (info.isHeader) return;
        if (info.frameIndex === 1) throw new Error('decoder fell over');
        shown.push(info.frameIndex);
      },
    });
    const frames = makeFrames('h264', 'IPPIP', 52);
    h.feed(frames[0]!.packets);
    let thrown = 0;
    for (const p of frames[1]!.packets) {
      try {
        h.receiver.avPacket(p);
      } catch (e) {
        assert.match(String(e), /decoder fell over/);
        thrown++;
      }
    }
    assert.equal(thrown, 1, 'once, with the packet that completed the frame');
    for (const f of frames.slice(2)) h.feed(f.packets);
    assert.deepEqual(shown, [0, 3, 4]);
  });

  it('the frame given to the callback is a view that the next frame overwrites', () => {
    const kept: Uint8Array[] = [];
    const h = harness('h264', {
      onFrame: (frame, info) => {
        if (!info.isHeader) kept.push(frame);
      },
    });
    const frames = makeFrames('h264', 'IP', 53);
    h.feed(frames[0]!.packets);
    assert.deepEqual(Uint8Array.from(kept[0]!), frames[0]!.bytes);
    h.feed(frames[1]!.packets);
    assert.notDeepEqual(Uint8Array.from(kept[0]!), frames[0]!.bytes);
    assert.deepEqual(Uint8Array.from(kept[1]!), frames[1]!.bytes);
  });

  it('the units received and missing go to the packet statistics, one frame late', () => {
    const packetStats = new PacketStats();
    const h = harness('h264', { packetStats });
    const frames = makeFrames('h264', 'IPPP', 54);
    h.feed(frames[0]!.packets);
    assert.deepEqual(packetStats.get(false), { received: 0n, lost: 0n });
    h.feed(without(frames[1]!, [2]));
    assert.deepEqual(packetStats.get(false), { received: 7n, lost: 0n });
    h.feed([...frames[2]!.packets, ...frames[2]!.packets]); // repeats are not counted
    assert.deepEqual(packetStats.get(false), { received: 13n, lost: 1n });
    h.feed(frames[3]!.packets.slice(0, 1));
    assert.deepEqual(packetStats.get(true), { received: 20n, lost: 1n });
  });
});

describe('video receiver: kept as in the reference although it looks wrong', () => {
  it('the count of lost frames goes wrong when the frame number wraps between the last frame shown and a frame that failed', () => {
    const h = harness('h264');
    const frames = makeFrames('h264', 'IPPPI', 60, 65533);
    h.feed(frames[0]!.packets); // 65533
    h.feed(frames[1]!.packets); // 65534
    // 65535 never arrives; frame 0 cannot be rebuilt
    h.feed(without(frames[3]!, [0, 1, 2]));
    assert.deepEqual(h.summary(), ['header:65533', 'frame:65533', 'frame:65534', 'corrupt:65535-65535', 'corrupt:65535-0']);
    assert.equal(h.receiver.framesLost, 0 - 65535 + 1, 'frame_index_cur - next_frame_expected + 1 without regard to the wrap');
    h.feed(frames[4]!.packets);
    assert.equal(h.frameEvents()[2]!.info.framesLost, -65534);
  });

  it('the unit with the highest index ends its frame when it arrives: if it overtakes the others, the frame is given up', () => {
    const h = harness('h264');
    const frames = makeFrames('h264', 'IPPI', 63);
    h.feed(frames[0]!.packets);
    // frame 1: its last FEC unit first, then all the others. Nothing is missing, and still the frame is lost.
    h.feed([frames[1]!.packets[6]!, ...frames[1]!.packets.slice(0, 6)]);
    assert.deepEqual(h.summary(), ['header:0', 'frame:0', 'corrupt:1-1']);
    assert.equal(h.receiver.framesLost, 1);
    h.feed(frames[2]!.packets);
    h.feed(frames[3]!.packets);
    assert.deepEqual(h.summary(), ['header:0', 'frame:0', 'corrupt:1-1', 'corrupt:1-1', 'corrupt:1-2', 'frame:3']);

    // with four other units before it, the same unit completes the frame instead
    const ok = harness('h264');
    const again = makeFrames('h264', 'IP', 63);
    ok.feed(again[0]!.packets);
    ok.feed([...again[1]!.packets.slice(0, 4), again[1]!.packets[6]!, again[1]!.packets[4]!, again[1]!.packets[5]!]);
    assert.deepEqual(ok.summary(), ['header:0', 'frame:0', 'frame:1']);
    assert.deepEqual(ok.frameEvents()[1]!.data, again[1]!.bytes);
  });

  it('the very first frame failing is reported as frames 1 to 0', () => {
    const h = harness('h264');
    const frames = makeFrames('h264', 'IPI', 64);
    h.feed(without(frames[0]!, [0, 1, 2]));
    assert.deepEqual(h.summary(), ['header:0', 'corrupt:1-0']);
    assert.equal(h.receiver.framesLost, 0, '0 - 1 + 1');
    h.feed(frames[1]!.packets);
    h.feed(frames[2]!.packets);
    assert.deepEqual(h.summary(), ['header:0', 'corrupt:1-0', 'corrupt:1-1', 'frame:2']);
  });

  it('a frame whose slice header cannot be read is handed out without any check', () => {
    const h = harness('h264');
    const junk = new Uint8Array(FRAME_SIZE).fill(0x55);
    const frames = makeFrames('h264', 'IP', 61);
    h.feed(frames[0]!.packets);
    // frame 1 never arrives; frame 2 is not a slice at all
    h.feed(packetizeFrame(junk, { frameIndex: 2, unitSize: UNIT, fecUnits: FEC }));
    assert.deepEqual(h.summary(), ['header:0', 'frame:0', 'corrupt:1-1', 'frame:2']);
    const e = h.frameEvents()[1]!;
    assert.deepEqual(e.data, junk);
    assert.equal(e.info.sliceType, BITSTREAM_SLICE.UNKNOWN);
    assert.equal(e.info.keyFrame, false);
  });

  it('a packet of a frame without units, or with a unit index outside the frame, does no harm', () => {
    const h = harness('h264');
    h.receiver.avPacket(makePacket({ frameIndex: 0, unitIndex: 0, unitsInFrameTotal: 0, unitsInFrameFec: 0, data: new Uint8Array(10) }));
    h.receiver.avPacket(makePacket({ frameIndex: 0, unitIndex: 9, unitsInFrameTotal: 3, unitsInFrameFec: 4, data: new Uint8Array(10) }));
    assert.deepEqual(h.summary(), ['header:0']);
    for (const f of makeFrames('h264', 'IP', 62, 1)) h.feed(f.packets);
    assert.deepEqual(h.summary(), ['header:0', 'frame:1', 'frame:2']);
  });
});
