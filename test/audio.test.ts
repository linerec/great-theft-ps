// SPDX-License-Identifier: AGPL-3.0-only
//
// The console's sound on its way to the page: the wire format (MSG.AUDIO) and the bridge passing it on.

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FakeLink } from './support/fake-link.ts';
import { decodeAudio, encodeAudio, MSG } from '../src/bridge/protocol.ts';
import { startBridge, type Bridge } from '../src/bridge/server.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridges: Bridge[] = [];
after(async () => {
  for (const b of bridges) await b.close();
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the audio message', () => {
  it('carries an Opus frame after a type byte and a flag byte', () => {
    const frame = Uint8Array.from([0xfc, 0x01, 0x02, 0x03]);
    const bytes = encodeAudio(frame);
    assert.equal(bytes[0], MSG.AUDIO);
    assert.equal(bytes[0], 0x11);
    assert.equal(bytes[1], 0, 'not lost');
    assert.deepEqual([...bytes.subarray(2)], [...frame]);
    const back = decodeAudio(bytes)!;
    assert.equal(back.lost, false);
    assert.deepEqual([...back.payload], [...frame]);
  });

  it('says "lost" for a frame that never came, with nothing after the flag', () => {
    const bytes = encodeAudio(null);
    assert.equal(bytes.length, 2);
    assert.equal(bytes[1], 1);
    assert.deepEqual(decodeAudio(bytes), { lost: true, payload: new Uint8Array(0) });
  });

  it('refuses what is not a well formed audio message', () => {
    assert.equal(decodeAudio(Uint8Array.from([0x10, 0])), null, 'a video message');
    assert.equal(decodeAudio(Uint8Array.from([0x11])), null, 'too short');
    assert.equal(decodeAudio(Uint8Array.from([0x11, 0])), null, 'a frame without bytes');
    assert.equal(decodeAudio(Uint8Array.from([0x11, 1, 9])), null, 'a lost frame that has bytes');
  });
});

describe('the bridge passes the sound on', () => {
  it('tells the page the format once and then sends each Opus frame, and each gap, in order', async () => {
    let link!: FakeLink;
    const bridge = await startBridge({ host: '127.0.0.1', port: 0, root, createLink: () => (link = new FakeLink()) });
    bridges.push(bridge);
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
    ws.binaryType = 'arraybuffer';
    const json: Array<Record<string, any>> = [];
    const audio: Array<{ lost: boolean; payload: number[] }> = [];
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') return void json.push(JSON.parse(e.data));
      const bytes = new Uint8Array(e.data as ArrayBuffer);
      const a = decodeAudio(bytes);
      if (a) audio.push({ lost: a.lost, payload: [...a.payload] });
    };
    await new Promise<void>((resolve, reject) => ((ws.onopen = () => resolve()), (ws.onerror = () => reject(new Error('ws error')))));
    ws.send(JSON.stringify({ type: 'hello', client: 'test' }));
    for (let i = 0; i < 100 && !json.some((m) => m.type === 'ready'); i++) await sleep(10);

    link.audioHeader({ channels: 2, bits: 16, rate: 48000, frameSize: 480 });
    link.audio(Uint8Array.from([1, 2, 3]));
    link.audio(null);
    link.audio(Uint8Array.from([4, 5]));
    for (let i = 0; i < 100 && audio.length < 3; i++) await sleep(10);

    assert.deepEqual(json.find((m) => m.type === 'audio'), { type: 'audio', channels: 2, bits: 16, rate: 48000, frameSize: 480 });
    assert.deepEqual(audio, [{ lost: false, payload: [1, 2, 3] }, { lost: true, payload: [] }, { lost: false, payload: [4, 5] }]);
    ws.close();
  });
});
