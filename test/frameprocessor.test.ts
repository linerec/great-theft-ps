// SPDX-License-Identifier: AGPL-3.0-only
//
// The frame processor (frame units in, frame bytes out, with FEC recovery) and the packet statistics. chiaki-ng has
// no tests for lib/src/frameprocessor.c and lib/src/packetstats.c (commit 43728af), so everything here is written for
// this port: frames are cut into units here (test/frameprocessor.test-helpers.ts), with FEC units from this port's
// encoder, and the expected values of the statistics are worked out by hand from the C code. These tests show that
// the pieces agree with each other and with a reading of the reference, not that a console agrees with them.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FRAME_PROCESSOR_FLUSH_RESULT as RESULT, FrameProcessor, StreamStats, VIDEO_BUFFER_PADDING_SIZE } from '../src/console/frameprocessor.ts';
import { PacketStats } from '../src/console/packetstats.ts';
import { makePacket, packetizeFrame, prng, randomBytes, shuffled } from './frameprocessor.test-helpers.ts';

const UNIT = 100; // slot size: 2 bytes of header and 98 of payload

/** Puts the packets in (the first one also allocates the frame) and flushes. */
function run(fp: FrameProcessor, packets: ReturnType<typeof packetizeFrame>): { result: number; frame: Uint8Array; put: string[] } {
  assert.equal(fp.allocFrame(packets[0]!), 'success');
  const put = packets.map((p) => fp.putUnit(p));
  const { result, frame, frameSize } = fp.flush();
  assert.equal(frame.length, frameSize);
  return { result, frame: Uint8Array.from(frame), put };
}

describe('frame processor: a frame without losses', () => {
  it('gives the frame back byte for byte, whatever its length', () => {
    const rnd = prng(1);
    const fp = new FrameProcessor();
    for (const length of [1, 2, 97, 98, 99, 196, 197, 500, 1234, 98 * 20]) {
      for (const fecUnits of [0, 1, 3]) {
        const frame = randomBytes(rnd, length);
        const packets = packetizeFrame(frame, { frameIndex: 7, unitSize: UNIT, fecUnits });
        const { result, frame: out, put } = run(fp, packets);
        assert.equal(result, RESULT.SUCCESS);
        assert.deepEqual(out, frame, `length ${length}, ${fecUnits} FEC units`);
        assert.ok(put.every((r) => r === 'success'));
        assert.equal(fp.unitsSourceExpected, Math.ceil(length / 98));
        assert.equal(fp.unitsSourceReceived, fp.unitsSourceExpected);
        assert.equal(fp.unitsFecExpected, Math.max(1, fecUnits), 'at least one FEC unit is always expected');
        assert.equal(fp.unitsFecReceived, fecUnits);
      }
    }
  });

  it('takes the units in any order', () => {
    const rnd = prng(2);
    const fp = new FrameProcessor();
    for (let round = 0; round < 30; round++) {
      const frame = randomBytes(rnd, 100 + (rnd() % 900));
      const packets = shuffled(packetizeFrame(frame, { frameIndex: round, unitSize: UNIT, fecUnits: 2 }), rnd);
      const { result, frame: out } = run(fp, packets);
      assert.equal(result, RESULT.SUCCESS);
      assert.deepEqual(out, frame);
    }
  });

  it('takes source units of different sizes (each says how much of its slot is padding)', () => {
    const rnd = prng(3);
    const frame = randomBytes(rnd, 10 + 98 + 1 + 55 + 0 + 30);
    const packets = packetizeFrame(frame, { frameIndex: 0, unitSize: UNIT, fecUnits: 2, chunkSizes: [10, 98, 1, 55, 0, 30] });
    assert.deepEqual(packets.map((p) => p.data.length), [12, 100, 3, 57, 2, 32, 100, 100]);
    const fp = new FrameProcessor();
    assert.deepEqual(run(fp, packets).frame, frame);
    assert.equal(fp.bufSizePerUnit, 100);
    assert.equal(fp.bufStridePerUnit, 112, 'the slots are kept 16 byte aligned');
  });

  it('sizes the slots from whichever packet comes first: a short source unit, a full one or a FEC unit', () => {
    const frame = randomBytes(prng(4), 98 * 2 + 40);
    for (const first of [0, 2, 3]) {
      const packets = packetizeFrame(frame, { frameIndex: 0, unitSize: UNIT, fecUnits: 2 });
      const fp = new FrameProcessor();
      assert.equal(fp.allocFrame(packets[first]!), 'success');
      assert.equal(fp.bufSizePerUnit, 100, `first packet ${first}`);
      assert.equal(fp.unitSlotsSize, 5);
      assert.equal(fp.frameBuf!.length, 5 * 112 + VIDEO_BUFFER_PADDING_SIZE);
    }
  });

  it('reuses its buffers for frames of other sizes', () => {
    const rnd = prng(5);
    const fp = new FrameProcessor();
    for (const [length, unitSize] of [[5000, 200], [50, 40], [9000, 300], [300, 300], [8000, 64]] as Array<[number, number]>) {
      const frame = randomBytes(rnd, length);
      assert.deepEqual(run(fp, packetizeFrame(frame, { frameIndex: 0, unitSize, fecUnits: 2 })).frame, frame);
    }
  });

  it('the frame handed out is a view into the buffer, overwritten by the next frame', () => {
    const rnd = prng(6);
    const fp = new FrameProcessor();
    const a = randomBytes(rnd, 300);
    const packetsA = packetizeFrame(a, { frameIndex: 0, unitSize: UNIT, fecUnits: 1 });
    assert.equal(fp.allocFrame(packetsA[0]!), 'success');
    for (const p of packetsA) fp.putUnit(p);
    const view = fp.flush().frame;
    assert.equal(view.buffer, fp.frameBuf!.buffer);
    assert.deepEqual(Uint8Array.from(view), a);
    assert.equal(fp.allocFrame(packetizeFrame(randomBytes(rnd, 300), { frameIndex: 1, unitSize: UNIT, fecUnits: 1 })[0]!), 'success');
    assert.ok(view.every((b) => b === 0), 'the buffer is cleared for the next frame');
  });
});

describe('frame processor: lost units', () => {
  it('rebuilds any loss of up to as many units as there are FEC units', () => {
    const rnd = prng(10);
    const fp = new FrameProcessor();
    for (const [length, fecUnits] of [[98 * 4 + 30, 1], [98 * 4 + 30, 2], [98 * 6, 3], [98 * 2 + 1, 4], [50, 2]] as Array<[number, number]>) {
      const frame = randomBytes(rnd, length);
      const all = packetizeFrame(frame, { frameIndex: 3, unitSize: UNIT, fecUnits });
      const k = all.length - fecUnits;
      // every single unit, and 40 random sets of exactly fecUnits units
      const patterns: number[][] = all.map((_, i) => [i]);
      for (let n = 0; n < 40; n++) patterns.push(shuffled(all.map((_, i) => i), rnd).slice(0, fecUnits));
      for (const lost of patterns) {
        const packets = all.filter((_, i) => !lost.includes(i));
        const { result, frame: out } = run(fp, shuffled(packets, rnd));
        const sourceLost = lost.some((i) => i < k);
        assert.equal(result, sourceLost ? RESULT.FEC_SUCCESS : RESULT.SUCCESS, `lost ${lost.join(',')}`);
        assert.deepEqual(out, frame, `length ${length}, ${fecUnits} FEC units, lost ${lost.join(',')}`);
      }
    }
  });

  it('rebuilds a lost last unit with its real length (the padding count comes back with the unit)', () => {
    const frame = randomBytes(prng(11), 98 * 3 + 5);
    const all = packetizeFrame(frame, { frameIndex: 0, unitSize: UNIT, fecUnits: 1 });
    assert.equal(all[3]!.data.length, 7);
    const fp = new FrameProcessor();
    const { result, frame: out } = run(fp, all.filter((_, i) => i !== 3));
    assert.equal(result, RESULT.FEC_SUCCESS);
    assert.deepEqual(out, frame);
    assert.deepEqual(Array.from(fp.unitSlots!), [100, 100, 100, 7, 100]);
  });

  it('with uneven source units, rebuilds each lost one with its own length', () => {
    const rnd = prng(12);
    const chunkSizes = [10, 98, 1, 55, 0, 30];
    const frame = randomBytes(rnd, chunkSizes.reduce((a, b) => a + b, 0));
    const all = packetizeFrame(frame, { frameIndex: 0, unitSize: UNIT, fecUnits: 2, chunkSizes });
    const fp = new FrameProcessor();
    for (let a = 0; a < 6; a++) {
      for (let b = a + 1; b < 6; b++) {
        const { result, frame: out } = run(fp, all.filter((_, i) => i !== a && i !== b));
        assert.equal(result, RESULT.FEC_SUCCESS);
        assert.deepEqual(out, frame, `lost ${a} and ${b}`);
      }
    }
  });

  it('reports a loss of more units than there are FEC units, and hands out what is left without the holes', () => {
    const rnd = prng(13);
    const frame = randomBytes(rnd, 98 * 5);
    const all = packetizeFrame(frame, { frameIndex: 0, unitSize: UNIT, fecUnits: 2 });
    const fp = new FrameProcessor();

    let r = run(fp, all.filter((_, i) => ![1, 3, 6].includes(i)));
    assert.equal(r.result, RESULT.FEC_FAILED);
    assert.deepEqual(r.frame, Uint8Array.from([...frame.subarray(0, 98), ...frame.subarray(196, 294), ...frame.subarray(392)]));

    r = run(fp, all.filter((_, i) => ![0, 1, 2].includes(i)));
    assert.equal(r.result, RESULT.FEC_FAILED);
    assert.deepEqual(r.frame, frame.subarray(294));

    // two source units and nothing else lost is fine again
    r = run(fp, all.filter((_, i) => ![1, 3].includes(i)));
    assert.equal(r.result, RESULT.FEC_SUCCESS);
    assert.deepEqual(r.frame, frame);
  });

  it('a frame announced without FEC units cannot lose a unit', () => {
    const frame = randomBytes(prng(14), 98 * 3);
    const all = packetizeFrame(frame, { frameIndex: 0, unitSize: UNIT, fecUnits: 0 });
    assert.equal(all[0]!.unitsInFrameFec, 0);
    const fp = new FrameProcessor();
    const r = run(fp, all.filter((_, i) => i !== 1));
    assert.equal(fp.unitsFecExpected, 1, 'one FEC unit is expected all the same');
    assert.equal(r.result, RESULT.FEC_FAILED);
  });

  it('kept as in the reference: FEC works up to 256 units in a frame; a larger frame cannot lose a unit', () => {
    const rnd = prng(16);
    const fp = new FrameProcessor();
    const fits = randomBytes(rnd, 254 * 10); // 254 source units and 2 FEC units
    let r = run(fp, packetizeFrame(fits, { frameIndex: 0, unitSize: 12, fecUnits: 2 }).filter((_, i) => i !== 100 && i !== 255));
    assert.equal(r.result, RESULT.FEC_SUCCESS);
    assert.deepEqual(r.frame, fits);

    // 255 source units: the encoder here cannot make FEC units for 257 units either, so the two FEC units are only
    // announced; what matters is that the frame processor does not get as far as using them
    const tooMany = randomBytes(rnd, 255 * 10);
    const packets = packetizeFrame(tooMany, { frameIndex: 1, unitSize: 12, fecUnits: 0, announcedFecUnits: 2 });
    assert.equal(packets.length, 255);
    const fecUnit = (i: number): (typeof packets)[number] => makePacket({ ...packets[0]!, unitIndex: 255 + i, data: new Uint8Array(12).fill(i + 1) });
    r = run(fp, [...packets.filter((_, i) => i !== 100), fecUnit(0), fecUnit(1)]);
    assert.equal(fp.unitsSourceExpected + fp.unitsFecExpected, 257);
    assert.equal(r.result, RESULT.FEC_FAILED);
    r = run(fp, packets);
    assert.equal(r.result, RESULT.SUCCESS, 'complete, it is fine');
    assert.deepEqual(r.frame, tooMany);
  });

  it('flushPossible: as soon as as many units are there as the frame has source units', () => {
    const frame = randomBytes(prng(15), 98 * 4);
    const all = packetizeFrame(frame, { frameIndex: 0, unitSize: UNIT, fecUnits: 2 });
    const fp = new FrameProcessor();
    assert.equal(fp.flushPossible(), true, 'before any frame: nothing expected, nothing missing');
    assert.equal(fp.allocFrame(all[5]!), 'success');
    const seen: boolean[] = [];
    for (const i of [5, 0, 2, 4, 1]) {
      fp.putUnit(all[i]!);
      seen.push(fp.flushPossible());
    }
    assert.deepEqual(seen, [false, false, false, true, true]);
    const { result, frame: out } = fp.flush();
    assert.equal(result, RESULT.FEC_SUCCESS);
    assert.deepEqual(Uint8Array.from(out), frame);
  });
});

describe('frame processor: units it refuses, as the reference does', () => {
  const frame = randomBytes(prng(20), 98 * 3 + 10);
  const fresh = (): { fp: FrameProcessor; all: ReturnType<typeof packetizeFrame>; lines: string[] } => {
    const lines: string[] = [];
    const fp = new FrameProcessor((l) => lines.push(l));
    const all = packetizeFrame(frame, { frameIndex: 0, unitSize: UNIT, fecUnits: 2 });
    assert.equal(fp.allocFrame(all[0]!), 'success');
    return { fp, all, lines };
  };

  it('a unit that is already there: refused, not counted twice, and the frame still comes out right', () => {
    const { fp, all, lines } = fresh();
    for (const p of all) assert.equal(fp.putUnit(p), 'success');
    for (const p of all) assert.equal(fp.putUnit(p), 'invalid-data');
    assert.equal(fp.unitsSourceReceived, 4);
    assert.equal(fp.unitsFecReceived, 2);
    assert.equal(lines.filter((l) => l === 'Received duplicate unit').length, 6);
    assert.deepEqual(Uint8Array.from(fp.flush().frame), frame);
  });

  it('a repeated unit with other content does not replace the first one', () => {
    const { fp, all } = fresh();
    for (const p of all) fp.putUnit(p);
    const other = makePacket({ ...all[1]!, data: new Uint8Array(100).fill(0x55) });
    assert.equal(fp.putUnit(other), 'invalid-data');
    assert.deepEqual(Uint8Array.from(fp.flush().frame), frame);
  });

  it('a unit index outside the frame, an empty unit, a unit larger than the slot', () => {
    const { fp, all, lines } = fresh();
    assert.equal(fp.putUnit(makePacket({ ...all[0]!, unitIndex: 6 })), 'invalid-data');
    assert.equal(fp.putUnit(makePacket({ ...all[0]!, unitIndex: 6, unitsInFrameTotal: 9 })), 'invalid-data');
    assert.equal(fp.putUnit(makePacket({ ...all[0]!, data: new Uint8Array(0) })), 'invalid-data');
    assert.equal(fp.putUnit(makePacket({ ...all[0]!, data: new Uint8Array(101) })), 'invalid-data');
    assert.deepEqual(lines, [
      "Packet's unit index is outside frame unit count", "Packet's unit index is too high", 'Unit is empty', 'Unit is bigger than pre-calculated size!',
    ]);
    assert.equal(fp.unitsSourceReceived + fp.unitsFecReceived, 0);
  });

  it('a first packet that cannot start a frame', () => {
    const fp = new FrameProcessor();
    assert.equal(fp.allocFrame(makePacket({ unitsInFrameTotal: 2, unitsInFrameFec: 3, data: new Uint8Array(10) })), 'invalid-data');
    assert.equal(fp.allocFrame(makePacket({ unitsInFrameTotal: 3, unitsInFrameFec: 1, unitIndex: 0, data: new Uint8Array(1) })), 'buf-too-small');
    assert.equal(fp.allocFrame(makePacket({ unitsInFrameTotal: 3, unitsInFrameFec: 1, unitIndex: 2, data: new Uint8Array(0) })), 'buf-too-small');
    assert.equal(fp.allocFrame(makePacket({ unitsInFrameTotal: 513, unitsInFrameFec: 1, data: new Uint8Array(10) })), 'invalid-data');
    assert.equal(fp.allocFrame(makePacket({ unitsInFrameTotal: 512, unitsInFrameFec: 1, data: new Uint8Array(10) })), 'success');
    assert.equal(fp.unitSlotsSize, 512);
  });

  it('after a first packet announcing too many units nothing is written outside the buffers', () => {
    const fp = new FrameProcessor();
    const small = packetizeFrame(randomBytes(prng(21), 30), { frameIndex: 0, unitSize: 20, fecUnits: 1 });
    assert.equal(fp.allocFrame(small[0]!), 'success');
    // the frame buffer now holds 3 slots of 32 bytes; this packet asks for slots of 1008 bytes and 600 units
    const big = makePacket({ unitsInFrameTotal: 600, unitsInFrameFec: 2, unitIndex: 2, data: new Uint8Array(1000) });
    assert.equal(fp.allocFrame(big), 'invalid-data');
    assert.equal(fp.putUnit(big), 'invalid-data');
    const { result, frame } = fp.flush();
    assert.equal(result, RESULT.FEC_FAILED);
    assert.equal(frame.length, 0);
  });

  it('flush without a frame fails', () => {
    const fp = new FrameProcessor();
    const { result, frame, frameSize } = fp.flush();
    assert.equal(result, RESULT.FAILED);
    assert.equal(frame.length, 0);
    assert.equal(frameSize, 0);
    assert.equal(fp.streamStats.frames, 0);
  });

  it('a packet that is not video takes its own size as the slot size', () => {
    const fp = new FrameProcessor();
    assert.equal(fp.allocFrame(makePacket({ isVideo: false, unitsInFrameTotal: 3, unitsInFrameFec: 1, data: Uint8Array.from([0, 50, 1, 2, 3]) })), 'success');
    assert.equal(fp.bufSizePerUnit, 5);
    assert.equal(fp.allocFrame(makePacket({ isVideo: true, unitsInFrameTotal: 3, unitsInFrameFec: 1, data: Uint8Array.from([0, 50, 1, 2, 3]) })), 'success');
    assert.equal(fp.bufSizePerUnit, 55);
  });
});

describe('stream statistics (frames and bytes that came out)', () => {
  it('counts flushed frames and gives a bit rate', () => {
    const rnd = prng(30);
    const fp = new FrameProcessor();
    run(fp, packetizeFrame(randomBytes(rnd, 1000), { frameIndex: 0, unitSize: UNIT, fecUnits: 1 }));
    run(fp, packetizeFrame(randomBytes(rnd, 2000), { frameIndex: 1, unitSize: UNIT, fecUnits: 1 }));
    assert.equal(fp.streamStats.frames, 2);
    assert.equal(fp.streamStats.bytes, 3000);
    assert.equal(fp.streamStats.bitrate(60), 720000); // 3000 * 8 * 60 / 2
    fp.streamStats.reset();
    assert.equal(fp.streamStats.bitrate(60), 0);
  });

  it('divides as C does (whole numbers)', () => {
    const s = new StreamStats();
    s.frame(1);
    s.frame(1);
    s.frame(2);
    assert.equal(s.bitrate(1), 10); // 4 * 8 * 1 / 3 = 10.67
  });
});

describe('packet statistics (packetstats.c)', () => {
  it('generations: units received and missing per frame add up; reset clears them', () => {
    const stats = new PacketStats();
    assert.deepEqual(stats.get(false), { received: 0n, lost: 0n });
    stats.pushGeneration(5, 1);
    stats.pushGeneration(7, 0);
    assert.deepEqual(stats.get(false), { received: 12n, lost: 1n });
    assert.deepEqual(stats.get(true), { received: 12n, lost: 1n });
    assert.deepEqual(stats.get(false), { received: 0n, lost: 0n });
    stats.pushGeneration(3, 2);
    stats.reset();
    assert.deepEqual(stats.get(false), { received: 0n, lost: 0n });
  });

  it('a frame processor reports the units of its frame', () => {
    const stats = new PacketStats();
    const fp = new FrameProcessor();
    fp.reportPacketStats(stats);
    assert.deepEqual(stats.get(false), { received: 0n, lost: 0n }, 'before any frame');
    const all = packetizeFrame(randomBytes(prng(40), 98 * 5), { frameIndex: 0, unitSize: UNIT, fecUnits: 2 });
    run(fp, all.filter((_, i) => i !== 2 && i !== 6));
    fp.reportPacketStats(stats);
    assert.deepEqual(stats.get(false), { received: 5n, lost: 2n });
    // a frame announced without FEC units still expects one, so one unit always counts as lost
    run(fp, packetizeFrame(randomBytes(prng(41), 98 * 3), { frameIndex: 1, unitSize: UNIT, fecUnits: 0 }));
    fp.reportPacketStats(stats);
    assert.deepEqual(stats.get(false), { received: 8n, lost: 3n });
  });

  it('sequence numbers: the highest number seen since the last reset against how many arrived', () => {
    const stats = new PacketStats();
    for (const seq of [1, 2, 3, 5]) stats.pushSeq(seq);
    assert.equal(stats.seqMax, 5);
    assert.deepEqual(stats.get(true), { received: 4n, lost: 1n }); // span 5 - 0, 4 arrived
    assert.equal(stats.seqMin, 5);
    for (const seq of [7, 6]) stats.pushSeq(seq);
    assert.equal(stats.seqMax, 7);
    assert.deepEqual(stats.get(true), { received: 2n, lost: 0n });
    // more arrived than the span (repeats): the reference then counts the whole span as lost
    for (const seq of [8, 8, 8, 9]) stats.pushSeq(seq);
    assert.deepEqual(stats.get(true), { received: 4n, lost: 2n });
  });

  it('both kinds add up in one reading', () => {
    const stats = new PacketStats();
    stats.pushGeneration(10, 2);
    for (const seq of [1, 3]) stats.pushSeq(seq);
    assert.deepEqual(stats.get(false), { received: 12n, lost: 3n });
  });

  it('kept as in the reference: when the sequence number wraps around, one reading reports a loss near 2^64', () => {
    const stats = new PacketStats();
    stats.seqMin = 65530;
    stats.seqMax = 65530;
    for (const seq of [65531, 65532, 65533, 65534, 65535, 0, 1]) stats.pushSeq(seq);
    assert.equal(stats.seqMax, 1, 'the comparison itself follows the wrap');
    // seq_max - seq_min = 1 - 65530 is negative and becomes a uint64_t: 2^64 - 65529; minus the 7 that arrived
    assert.deepEqual(stats.get(true), { received: 7n, lost: 2n ** 64n - 65536n });
    // the reading after that is normal again
    stats.pushSeq(2);
    assert.deepEqual(stats.get(true), { received: 1n, lost: 0n });
  });
});
