// SPDX-License-Identifier: AGPL-3.0-only
//
// The audio receiver (src/console/audioreceiver.ts): packets of Opus frames in, frames in order out, a gap announced as
// null. Written from the reading of chiaki-ng's lib/src/audioreceiver.c, which has no test of its own.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TakionAvPacket } from '../src/console/av-packet.ts';
import { AUDIO_JITTER_BUFFER_SIZE, AudioReceiver, parseAudioHeader } from '../src/console/audioreceiver.ts';

/** A "frame" whose first two bytes say which one it is, so that the tests can read what came out. */
const unit = (n: number): Uint8Array => Uint8Array.from([n & 0xff, (n >> 8) & 0xff, 0xaa, 0xbb]);
const idOf = (frame: Uint8Array | null): number | null => (frame === null ? null : frame[0]! | (frame[1]! << 8));

function packet(frameIndex: number, sourceIds: number[], fecIds: number[] = [], over: Partial<TakionAvPacket> = {}): TakionAvPacket {
  const units = [...sourceIds, ...fecIds].map(unit);
  const unitSize = 4;
  return {
    packetIndex: 0, frameIndex, usesNaluInfoStructs: false, isVideo: false, isHaptics: false, unitIndex: 0,
    unitsInFrameTotal: units.length, unitsInFrameFec: (unitSize << 8) | (fecIds.length << 4) | sourceIds.length,
    codec: 5, wordAt0x18: 0, adaptiveStreamIndex: 0, byteAt0x2c: 0, keyPos: 0n, data: Uint8Array.from(units.flatMap((u) => [...u])), ...over,
  };
}

function receiver(): { rx: AudioReceiver; out: Array<number | null>; logs: string[]; seqs: number[]; headers: unknown[] } {
  const out: Array<number | null> = [];
  const logs: string[] = [];
  const seqs: number[] = [];
  const headers: unknown[] = [];
  const rx = new AudioReceiver({ onFrame: (f) => out.push(idOf(f)), onHeader: (h) => headers.push(h), packetStats: { pushSeq: (n) => void seqs.push(n) }, log: (l) => logs.push(l) });
  return { rx, out, logs, seqs, headers };
}

describe('the audio header', () => {
  it('is read as the reference does: channels, bits, then three 32 bit big endian numbers', () => {
    // The header this client itself sends for the microphone: 1 channel, 16 bits, 48000 Hz, 480 samples a frame.
    const h = parseAudioHeader(Uint8Array.from([0x01, 0x10, 0x00, 0x00, 0xbb, 0x80, 0x00, 0x00, 0x01, 0xe0, 0x00, 0x00, 0x00, 0x01]));
    assert.deepEqual(h, { channels: 1, bits: 16, rate: 48000, frameSize: 480, unknown: 1 });
  });
  it('is refused when it is not 14 bytes', () => {
    assert.throws(() => parseAudioHeader(new Uint8Array(13)), /14 bytes/);
  });
});

describe('frames in order', () => {
  it('holds back the first frames until three are waiting, then hands them out in order and keeps up from there', () => {
    const { rx, out } = receiver();
    rx.avPacket(packet(0, [0]));
    rx.avPacket(packet(1, [1]));
    assert.deepEqual(out, [], 'two frames are not enough to start');
    rx.avPacket(packet(2, [2]));
    assert.deepEqual(out, [0, 1, 2]);
    rx.avPacket(packet(3, [3]));
    assert.deepEqual(out, [0, 1, 2, 3], 'from then on a frame goes out as it arrives');
    assert.equal(rx.buffered, 0);
  });

  it('puts the first frames right even when they arrive out of order (waiting for three does that)', () => {
    const { rx, out } = receiver();
    for (const n of [1, 0, 2]) rx.avPacket(packet(n, [n]));
    assert.deepEqual(out, [0, 1, 2]);
    const second = receiver();
    for (const n of [2, 0, 1]) second.rx.avPacket(packet(n, [n]));
    assert.deepEqual(second.out, [0, 1, 2]);
  });

  it('gives up on a later frame that arrives after its successor: once delivery runs, a gap is not waited for', () => {
    const { rx, out } = receiver();
    for (const n of [0, 1, 2, 4, 3]) rx.avPacket(packet(n, [n]));
    assert.deepEqual(out, [0, 1, 2, null, 4], 'frame 3 was announced lost the moment 4 was there; when it came it was too late');
  });

  it('takes several frames from one packet', () => {
    const { rx, out } = receiver();
    rx.avPacket(packet(0, [0, 1, 2]));
    assert.deepEqual(out, [0, 1, 2]);
    rx.avPacket(packet(3, [3, 4]));
    assert.deepEqual(out, [0, 1, 2, 3, 4]);
  });

  it('does not hand out a frame twice, and drops one whose turn has passed', () => {
    const { rx, out } = receiver();
    for (const n of [0, 1, 2]) rx.avPacket(packet(n, [n]));
    rx.avPacket(packet(1, [1])); // a repeat
    rx.avPacket(packet(2, [2]));
    assert.deepEqual(out, [0, 1, 2]);
    rx.avPacket(packet(3, [3]));
    rx.avPacket(packet(3, [3]));
    assert.deepEqual(out, [0, 1, 2, 3]);
  });

  it('goes on across the wrap of the 16 bit frame number', () => {
    const { rx, out } = receiver();
    for (const n of [0xfffe, 0xffff, 0x0000, 0x0001]) rx.avPacket(packet(n, [n]));
    assert.deepEqual(out, [0xfffe, 0xffff, 0, 1]);
  });
});

describe('what the copies are for', () => {
  it('makes good a lost packet from the copies the next packet carries', () => {
    const { rx, out } = receiver();
    for (const n of [0, 1, 2]) rx.avPacket(packet(n, [n]));
    // Packets 3 and 4 are lost; packet 5 carries its own frame and copies of 3 and 4. The copies are older, so they go in
    // first; the reference takes frame 5 first, gives 3 and 4 up, and the copies arrive too late.
    rx.avPacket(packet(5, [5], [3, 4]));
    assert.deepEqual(out, [0, 1, 2, 3, 4, 5], 'nothing was concealed: the frames came with the next packet');
  });

  it('recovers only what the copies cover: a gap longer than they reach is concealed for the rest', () => {
    const { rx, out } = receiver();
    for (const n of [0, 1, 2]) rx.avPacket(packet(n, [n]));
    rx.avPacket(packet(6, [6], [4, 5])); // 3 is lost and not covered
    assert.deepEqual(out, [0, 1, 2, null, 4, 5, 6]);
  });

  it('ignores copies of frames from before the stream started, as the reference does (even frame 0 of them)', () => {
    const { rx, out } = receiver();
    // At the very start a packet's copies would name frames below 0; they are skipped, not wrapped to 65534 and 65535.
    // The reference's rule (frameIndex + copy index < copies + 1) skips the copy of frame 0 as well.
    rx.avPacket(packet(1, [1], [0xffff, 0]));
    rx.avPacket(packet(2, [2]));
    rx.avPacket(packet(3, [3]));
    assert.deepEqual(out, [1, 2, 3]);
  });

  it('does not deliver the copy of a frame it has already delivered', () => {
    const { rx, out } = receiver();
    for (const n of [0, 1, 2]) rx.avPacket(packet(n, [n]));
    rx.avPacket(packet(3, [3], [1, 2]));
    assert.deepEqual(out, [0, 1, 2, 3]);
  });
});

describe('a frame that never came', () => {
  it('is announced as null as soon as a later frame is there, so the sound goes on', () => {
    const { rx, out } = receiver();
    for (const n of [0, 1, 2]) rx.avPacket(packet(n, [n]));
    rx.avPacket(packet(4, [4]));
    assert.deepEqual(out, [0, 1, 2, null, 4]);
    rx.avPacket(packet(5, [5]));
    rx.avPacket(packet(6, [6]));
    assert.deepEqual(out, [0, 1, 2, null, 4, 5, 6]);
  });

  it('is not announced while nothing later is there: the gap is not known yet', () => {
    const { rx, out } = receiver();
    for (const n of [0, 1, 2]) rx.avPacket(packet(n, [n]));
    assert.deepEqual(out, [0, 1, 2]);
    assert.equal(rx.buffered, 0);
  });

  it('is announced right away while the buffer is still filling, when a later frame is already there', () => {
    const { rx, out } = receiver();
    for (const n of [0, 1, 3]) rx.avPacket(packet(n, [n]));
    assert.deepEqual(out, [0, 1, null, 3], 'the buffer was not yet full, so a gap is concealed at once');
  });

  it('is given up one frame at a time over a longer gap', () => {
    const { rx, out } = receiver();
    for (const n of [0, 1, 2]) rx.avPacket(packet(n, [n]));
    for (const n of [7, 8, 9]) rx.avPacket(packet(n, [n]));
    assert.deepEqual(out, [0, 1, 2, null, null, null, null, 7, 8, 9]);
  });
});

describe('the buffer', () => {
  it('forgets what waits when a new stream starts, and reports the header', () => {
    const { rx, out, headers } = receiver();
    rx.avPacket(packet(0, [0]));
    rx.avPacket(packet(1, [1]));
    assert.equal(rx.buffered, 2);
    rx.streamInfo({ channels: 2, bits: 16, rate: 48000, frameSize: 480, unknown: 1 });
    assert.equal(rx.buffered, 0);
    assert.equal(headers.length, 1);
    for (const n of [0, 1, 2]) rx.avPacket(packet(n, [n]));
    assert.deepEqual(out, [0, 1, 2], 'it starts again from the beginning');
  });

  it('whatever the arrival order, loss and repeats: frames come out in order, never twice, never more than 8 waiting', () => {
    // A small deterministic generator, so that a failure can be reproduced.
    let seed = 12345;
    const random = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let run = 0; run < 200; run++) {
      const { rx, out } = receiver();
      const startAt = run % 2 === 0 ? 0 : 65530; // half the runs cross the wrap of the frame number
      const total = 60;
      const arrivals: number[] = [];
      for (let n = 0; n < total; n++) {
        if (random() < 0.15) continue; // lost
        arrivals.push(n);
        if (random() < 0.1) arrivals.push(n); // repeated
      }
      // A little disorder: swap some neighbours.
      for (let i = 0; i + 1 < arrivals.length; i++) if (random() < 0.15) [arrivals[i], arrivals[i + 1]] = [arrivals[i + 1]!, arrivals[i]!];
      for (const n of arrivals) {
        // A packet's copies are always the frames just before its own: n - k ... n - 1.
        const k = Math.min(n, random() < 0.5 ? 2 : random() < 0.5 ? 1 : 0);
        const copies = Array.from({ length: k }, (_, j) => n - k + j);
        rx.avPacket(packet((startAt + n) & 0xffff, [(startAt + n) & 0xffff], copies.map((c) => (startAt + c) & 0xffff)));
        assert.ok(rx.buffered <= AUDIO_JITTER_BUFFER_SIZE, `run ${run}: ${rx.buffered} frames waiting`);
      }
      // What was handed out: real frames strictly in order, each once; nulls only stand for numbers in between.
      const real = out.filter((f): f is number => f !== null);
      for (let i = 1; i < real.length; i++) {
        const step = (real[i]! - real[i - 1]! + 65536) % 65536;
        assert.ok(step >= 1 && step < 32768, `run ${run}: frame ${real[i]} after ${real[i - 1]} is out of order or repeated`);
      }
      // Every position between the first and last delivered frame is either a frame or one null: the timing is kept.
      if (real.length > 0) {
        const span = ((real[real.length - 1]! - real[0]! + 65536) % 65536) + 1;
        assert.equal(out.length, span, `run ${run}: ${out.length} things handed out for ${span} frame numbers`);
      }
    }
  });
});

describe('packets it refuses', () => {
  it('turns away another codec, an empty packet, counts that do not add up and a size that does not match', () => {
    const { rx, out, logs } = receiver();
    rx.avPacket(packet(0, [0], [], { codec: 4 }));
    rx.avPacket(packet(1, [1], [], { data: new Uint8Array(0) }));
    rx.avPacket(packet(2, [2], [], { unitsInFrameTotal: 2 }));
    rx.avPacket(packet(3, [3], [], { data: new Uint8Array(5) }));
    assert.equal(rx.buffered, 0);
    assert.deepEqual(out, []);
    assert.equal(logs.length, 4);
  });

  it('does not play the haptics channel (the controller vibration), and does not count it', () => {
    const { rx, out, seqs } = receiver();
    for (const n of [0, 1, 2]) rx.avPacket(packet(n, [n], [], { isHaptics: true }));
    assert.deepEqual(out, []);
    assert.deepEqual(seqs, []);
  });

  it('counts every accepted packet once for the congestion report, with its first frame number', () => {
    const { rx, seqs } = receiver();
    rx.avPacket(packet(0, [0, 1]));
    rx.avPacket(packet(2, [2], [0, 1]));
    rx.avPacket(packet(5, [5], [], { codec: 9 })); // refused: not counted
    assert.deepEqual(seqs, [0, 2]);
  });
});
