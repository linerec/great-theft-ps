// SPDX-License-Identifier: AGPL-3.0-only
//
// Bridge tests: wire protocol, WebSocket server, authentication and safety behaviour, the simulated console,
// and the gtp-core contract through a fake core process.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUTTON, emptyPadState } from '../src/engine/types.ts';
import { CoreLink, FrameReader, writeFrame } from '../src/bridge/core-link.ts';
import type { ConsoleLink } from '../src/bridge/console-link.ts';
import { findSpsCodec, hasIdr } from '../src/bridge/h264.ts';
import { MockConsole } from '../src/bridge/mock-console.ts';
import {
  CODEC, decodePad, decodePing, decodePong, decodeVideo, encodePad, encodePing, encodePong, encodeVideo, isNeutral, MSG,
} from '../src/bridge/protocol.ts';
import { megabytesPerHour, parseQuality, QUALITY_PRESETS } from '../src/bridge/quality.ts';
import { startBridge, type Bridge } from '../src/bridge/server.ts';
import { acceptKey } from '../src/bridge/ws.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fakeCore = path.join(root, 'tools', 'fake-core.mjs');
const TOKEN = 'test-token-123';

// ------------------------------------------------------------------ helpers

class Client {
  ws!: WebSocket;
  queue: Array<string | Uint8Array> = [];
  closeCode: number | null = null;
  #wake: Array<() => void> = [];

  static async open(port: number, authenticate = true): Promise<Client> {
    const c = new Client();
    c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    c.ws.binaryType = 'arraybuffer';
    c.ws.onmessage = (e) => {
      c.queue.push(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
      c.#wake.splice(0).forEach((f) => f());
    };
    c.ws.onclose = (e) => {
      c.closeCode = e.code;
      c.#wake.splice(0).forEach((f) => f());
    };
    await new Promise<void>((resolve, reject) => {
      c.ws.onopen = () => resolve();
      c.ws.onerror = () => reject(new Error('websocket error'));
    });
    if (authenticate) c.ws.send(JSON.stringify({ type: 'hello', token: TOKEN, client: 'test' }));
    return c;
  }

  /** Wait for a message matching `pred`, remove and return it. */
  async next<T extends string | Uint8Array>(pred: (m: string | Uint8Array) => boolean, ms = 4000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.queue.findIndex(pred);
      if (i >= 0) return this.queue.splice(i, 1)[0] as T;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timeout waiting for a message');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.#wake.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
  json = async (type: string, ms = 4000): Promise<Record<string, unknown>> =>
    JSON.parse(await this.next<string>((m) => typeof m === 'string' && (JSON.parse(m) as { type: string }).type === type, ms));
  video = (ms = 4000): Promise<Uint8Array> => this.next<Uint8Array>((m) => typeof m !== 'string' && m[0] === MSG.VIDEO, ms);
  async closed(ms = 3000): Promise<number> {
    const deadline = Date.now() + ms;
    while (this.closeCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.notEqual(this.closeCode, null, 'expected the connection to close');
    return this.closeCode as number;
  }
  close(): void {
    if (this.ws.readyState <= 1) this.ws.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const bridges: Bridge[] = [];

async function bridgeWith(createLink: () => ConsoleLink): Promise<Bridge> {
  const b = await startBridge({ host: '127.0.0.1', port: 0, token: TOKEN, root, createLink });
  bridges.push(b);
  return b;
}

function mockBridge(): Promise<{ bridge: Bridge; mocks: MockConsole[] }> {
  const mocks: MockConsole[] = [];
  return bridgeWith(() => {
    const m = new MockConsole();
    mocks.push(m);
    return m;
  }).then((bridge) => ({ bridge, mocks }));
}

after(async () => {
  for (const b of bridges) await b.close();
});

const padWith = (patch: (s: ReturnType<typeof emptyPadState>) => void): ReturnType<typeof emptyPadState> => {
  const s = emptyPadState();
  patch(s);
  return s;
};
const pngWidth = (png: Uint8Array): number => new DataView(png.buffer, png.byteOffset + 16, 4).getUint32(0, false);

// ------------------------------------------------------------------ protocol

describe('wire protocol', () => {
  it('round-trips a pad state with and without motion, within stick quantisation', () => {
    const s = padWith((p) => {
      p.buttons = BUTTON.cross | BUTTON.r1 | BUTTON.ps;
      p.l2 = 17;
      p.r2 = 255;
      p.leftX = -1;
      p.leftY = 0.5;
      p.rightX = 0.123;
      p.rightY = -0.987;
      p.gyro = { x: 1.5, y: -2.5, z: 0.25 };
      p.orient = { x: 0, y: 0.5, z: 0, w: 0.5 };
    });
    for (const motion of [false, true]) {
      const bytes = encodePad(70000, s, motion);
      assert.equal(bytes.length, motion ? 58 : 18);
      const d = decodePad(bytes)!;
      assert.equal(d.seq, 70000);
      assert.equal(d.state.buttons, s.buttons);
      assert.equal(d.state.l2, 17);
      assert.equal(d.state.r2, 255);
      assert.ok(Math.abs(d.state.leftX + 1) < 1e-4 && Math.abs(d.state.rightY + 0.987) < 1e-4);
      if (motion) assert.ok(Math.abs(d.state.gyro.y + 2.5) < 1e-6 && Math.abs(d.state.orient.w - 0.5) < 1e-6);
    }
  });

  it('clamps out-of-range values and rejects malformed pads', () => {
    const d = decodePad(encodePad(1, padWith((p) => ((p.leftX = 9), (p.l2 = 999), (p.rightY = Number.NaN))), false))!;
    assert.ok(Math.abs(d.state.leftX - 1) < 1e-4);
    assert.equal(d.state.l2, 255);
    assert.equal(d.state.rightY, 0);
    assert.equal(decodePad(new Uint8Array(5)), null);
    const bad = encodePad(1, emptyPadState(), true);
    bad[17] = 0; // says "no motion" but carries it
    assert.equal(decodePad(bad), null);
    assert.equal(decodePad(Uint8Array.of(0x55, ...new Array(17).fill(0))), null);
  });

  it('video, ping and pong messages round-trip', () => {
    const v = decodeVideo(encodeVideo({ codec: CODEC.H264, key: true, frameId: 4000000000, inputSeq: 7, ptsMs: 1234.5 }, Uint8Array.of(1, 2, 3)))!;
    assert.deepEqual(v.header, { codec: 1, key: true, frameId: 4000000000, inputSeq: 7, ptsMs: 1234.5 });
    assert.deepEqual([...v.payload], [1, 2, 3]);
    assert.equal(decodeVideo(new Uint8Array(5)), null);
    assert.equal(decodePing(encodePing(42.5)), 42.5);
    assert.deepEqual(decodePong(encodePong(1, 2)), { clientTime: 1, bridgeTime: 2 });
    assert.equal(decodePing(new Uint8Array(3)), null);
  });

  it('knows a neutral pad', () => {
    assert.equal(isNeutral(emptyPadState()), true);
    assert.equal(isNeutral(padWith((p) => (p.buttons = BUTTON.cross))), false);
    assert.equal(isNeutral(padWith((p) => (p.leftY = -0.4))), false);
  });
});

describe('quality requests', () => {
  it('presets and custom values are validated', () => {
    assert.equal(parseQuality({ preset: 'saver' })!.bitrateKbps, 1000);
    assert.deepEqual(parseQuality({ preset: 'quality' }), QUALITY_PRESETS.quality);
    const custom = parseQuality({ preset: 'saver', bitrateKbps: 600, fps: 24 })!;
    assert.equal(custom.preset, 'custom');
    assert.equal(custom.bitrateKbps, 600);
    for (const bad of [{ preset: 'nope' }, { fps: 500 }, { width: 10 }, { bitrateKbps: 1.5 }, { codec: 'vp9' }, { height: '1080' }, null, 'x']) {
      assert.equal(parseQuality(bad), null, JSON.stringify(bad));
    }
  });

  it('shows what a bitrate costs per hour', () => {
    assert.equal(megabytesPerHour(1000), 450);
    assert.equal(megabytesPerHour(15000), 6750);
  });
});

// ------------------------------------------------------------------ websocket and server

describe('websocket server', () => {
  it('matches the RFC 6455 example handshake key', () => {
    assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  const rawUpgrade = (port: number, headers: Record<string, string>): Promise<{ status?: number; upgraded: boolean; socket?: net.Socket }> =>
    new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/ws', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
      req.on('upgrade', (_res, socket) => resolve({ upgraded: true, socket: socket as net.Socket }));
      req.on('response', (res) => resolve({ status: res.statusCode, upgraded: false }));
      req.on('error', () => resolve({ upgraded: false }));
      req.end();
    });

  it('refuses cross-origin and wrongly addressed upgrades, and accepts same-origin', async () => {
    const { bridge } = await mockBridge();
    assert.equal((await rawUpgrade(bridge.port, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await rawUpgrade(bridge.port, { Host: 'evil.example' })).status, 421);
    const ok = await rawUpgrade(bridge.port, { Origin: `http://127.0.0.1:${bridge.port}` });
    assert.equal(ok.upgraded, true);
    ok.socket?.destroy();
  });

  it('closes on an unmasked client frame (1002) and on an oversized one (1009)', async () => {
    const { bridge } = await mockBridge();
    const readClose = (socket: net.Socket): Promise<number> =>
      new Promise((resolve) => {
        socket.on('data', (d) => {
          if (d[0] === 0x88) resolve(d.readUInt16BE(2));
        });
        setTimeout(() => resolve(-1), 2000);
      });
    const a = (await rawUpgrade(bridge.port, {})).socket!;
    const p1 = readClose(a);
    a.write(Buffer.from([0x81, 0x02, 0x68, 0x69])); // text "hi", NOT masked
    assert.equal(await p1, 1002);
    const b = (await rawUpgrade(bridge.port, {})).socket!;
    const p2 = readClose(b);
    b.write(Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 0x10, 0, 0, 1, 2, 3, 4])); // masked, claims 1 MiB
    assert.equal(await p2, 1009);
    a.destroy();
    b.destroy();
  });

  it('serves the web client files and refuses everything else', async () => {
    const { bridge } = await mockBridge();
    const get = async (p: string): Promise<number> => (await fetch(`http://127.0.0.1:${bridge.port}${p}`)).status;
    assert.equal(await get('/'), 200);
    assert.equal(await get('/src/bridge/protocol.ts'), 200);
    assert.equal(await get('/package.json'), 404);
    assert.equal(await get('/src/../package.json'), 404);
    const js = await (await fetch(`http://127.0.0.1:${bridge.port}/src/bridge/protocol.ts`)).text();
    assert.ok(!js.includes('export interface'), 'types are stripped');
  });
});

describe('bridge without a token (the default on this computer)', () => {
  it('lets a client in with a plain hello, and still ignores input sent before it', async () => {
    const mocks: MockConsole[] = [];
    const b = await startBridge({
      host: '127.0.0.1', port: 0, root,
      createLink: () => {
        const m = new MockConsole();
        mocks.push(m);
        return m;
      },
    });
    bridges.push(b);

    const early = await Client.open(b.port, false);
    early.ws.send(encodePad(1, padWith((p) => (p.buttons = BUTTON.cross)), false));
    await sleep(150);
    assert.equal(mocks.length, 0, 'no link may be created before the hello');
    early.close();

    const c = await Client.open(b.port, false);
    c.ws.send(JSON.stringify({ type: 'hello', client: 'test' })); // no token field at all
    assert.equal((await c.json('ready')).link, 'mock');
    c.close();
  });

  it('still refuses another web page (cross-origin) and a wrong Host, token or not', async () => {
    const b = await startBridge({ host: '127.0.0.1', port: 0, root, createLink: () => new MockConsole() });
    bridges.push(b);
    const status = (headers: Record<string, string>): Promise<number> =>
      new Promise((resolve) => {
        const req = request(
          { host: '127.0.0.1', port: b.port, path: '/ws', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } },
          (res) => resolve(res.statusCode ?? 0),
        );
        req.on('upgrade', (res, socket) => {
          socket.destroy();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', () => resolve(0));
        req.end();
      });
    assert.equal(await status({ Origin: 'https://evil.example' }), 403, 'another web page cannot drive it');
    assert.equal(await status({ Host: 'evil.example' }), 421, 'DNS rebinding is refused');
    assert.equal(await status({ Origin: `http://127.0.0.1:${b.port}` }), 101, 'same-origin page is accepted');
  });

  it('refuses to listen beyond this computer without a token (before opening any port)', async () => {
    await assert.rejects(startBridge({ host: '0.0.0.0', port: 0, root, createLink: () => new MockConsole() }), /requires a token/);
  });

  it('with a token set, a hello that has none is refused', async () => {
    const b = await startBridge({ host: '127.0.0.1', port: 0, token: 'abc', root, createLink: () => new MockConsole() });
    bridges.push(b);
    const c = await Client.open(b.port, false);
    c.ws.send(JSON.stringify({ type: 'hello', client: 'test' }));
    assert.equal((await c.json('error')).code, 'unauthorized', 'with a token set, a hello without it is refused');
    c.close();
  });
});

describe('bridge with a simulated console', () => {
  it('rejects a wrong token and ignores input sent before authentication', async () => {
    const { bridge, mocks } = await mockBridge();
    const bad = await Client.open(bridge.port, false);
    bad.ws.send(JSON.stringify({ type: 'hello', token: 'wrong', client: 'test' }));
    assert.equal((await bad.json('error')).code, 'unauthorized');
    assert.equal(await bad.closed(), 4401);

    const early = await Client.open(bridge.port, false);
    early.ws.send(encodePad(1, padWith((p) => (p.buttons = BUTTON.cross)), false));
    await sleep(150);
    assert.equal(mocks.length, 0, 'no link may be created before authentication');
    early.close();
  });

  it('streams PNG frames at the requested rate and echoes the input sequence', async () => {
    const { bridge, mocks } = await mockBridge();
    const c = await Client.open(bridge.port);
    const ready = await c.json('ready');
    assert.equal(ready.link, 'mock');
    c.ws.send(encodePad(41, padWith((p) => ((p.buttons = BUTTON.cross), (p.r2 = 255), (p.leftY = -1))), false));
    await sleep(1100);
    const frames = c.queue.filter((m) => typeof m !== 'string' && m[0] === MSG.VIDEO) as Uint8Array[];
    assert.ok(frames.length >= 22 && frames.length <= 36, `${frames.length} frames in about 1.1 s at 30 fps`);
    const last = decodeVideo(frames[frames.length - 1]!)!;
    assert.equal(last.header.codec, CODEC.PNG);
    assert.equal(last.header.inputSeq, 41);
    assert.deepEqual([...last.payload.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(mocks[0]!.lastSeq, 41);
    assert.equal(mocks[0]!.lastPad.r2, 255);
    assert.ok(mocks[0]!.lastPad.leftY < -0.99);
    c.close();
  });

  it('answers pings and reports stats once a second', async () => {
    const { bridge } = await mockBridge();
    const c = await Client.open(bridge.port);
    await c.json('ready');
    c.ws.send(encodePing(123.5));
    const pong = await c.next<Uint8Array>((m) => typeof m !== 'string' && m[0] === MSG.PONG);
    assert.equal(decodePong(pong)!.clientTime, 123.5);
    const stats = await c.json('stats', 2500);
    assert.equal(stats.link, 'mock');
    assert.ok(typeof stats.kbps === 'number' && (stats.kbps as number) > 0);
    c.close();
  });

  it('applies a quality change: resolution and rate follow, an invalid request is refused', async () => {
    const { bridge, mocks } = await mockBridge();
    const c = await Client.open(bridge.port);
    await c.json('ready');
    const w1 = pngWidth(decodeVideo(await c.video())!.payload);
    c.ws.send(JSON.stringify({ type: 'quality', preset: 'saver', fps: 15 }));
    await c.next((m) => typeof m === 'string' && m.includes('"state":"quality"'));
    assert.equal(mocks[0]!.quality.fps, 15);
    c.queue.length = 0;
    await sleep(100);
    c.queue.length = 0;
    const w2 = pngWidth(decodeVideo(await c.video())!.payload);
    assert.ok(w2 < w1, `${w2} < ${w1}`);
    await sleep(1000);
    const n = c.queue.filter((m) => typeof m !== 'string' && m[0] === MSG.VIDEO).length;
    assert.ok(n >= 10 && n <= 20, `${n} frames in 1 s at 15 fps`);
    c.ws.send(JSON.stringify({ type: 'quality', fps: 9999 }));
    assert.equal((await c.json('error')).code, 'bad-quality');
    c.close();
  });

  it('allows one client at a time', async () => {
    const { bridge } = await mockBridge();
    const a = await Client.open(bridge.port);
    await a.json('ready');
    const b = await Client.open(bridge.port);
    assert.equal((await b.json('error')).code, 'busy');
    assert.equal(await b.closed(), 4409);
    a.close();
    await sleep(200);
    const c = await Client.open(bridge.port);
    assert.equal((await c.json('ready')).link, 'mock');
    c.close();
  });

  it('releases every button when the client disconnects', async () => {
    const { bridge, mocks } = await mockBridge();
    const c = await Client.open(bridge.port);
    await c.json('ready');
    c.ws.send(encodePad(5, padWith((p) => ((p.buttons = BUTTON.cross | BUTTON.r1), (p.r2 = 255), (p.leftY = -1))), false));
    await sleep(100);
    assert.equal(isNeutral(mocks[0]!.lastPad), false);
    c.close();
    await sleep(300);
    assert.equal(isNeutral(mocks[0]!.lastPad), true, 'the pad must be released');
  });

  it('releases the pad when the client goes silent while holding something', async () => {
    const { bridge, mocks } = await mockBridge();
    const c = await Client.open(bridge.port);
    await c.json('ready');
    c.ws.send(encodePad(9, padWith((p) => (p.buttons = BUTTON.cross)), false));
    await sleep(300);
    assert.equal(isNeutral(mocks[0]!.lastPad), false);
    await sleep(2700);
    assert.equal(isNeutral(mocks[0]!.lastPad), true, 'a silent client must not leave a button held');
    c.close();
  });

  it('limits how fast pads are accepted', async () => {
    const { bridge, mocks } = await mockBridge();
    const c = await Client.open(bridge.port);
    await c.json('ready');
    for (let i = 1; i <= 3000; i++) c.ws.send(encodePad(i, emptyPadState(), false));
    await sleep(600);
    assert.ok(mocks[0]!.padCount <= 2000, `${mocks[0]!.padCount} accepted`);
    assert.ok(mocks[0]!.padCount > 1000);
    c.close();
  });
});

describe('starting on a port', () => {
  const listenOnLoopback = (server: net.Server): Promise<number> =>
    new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));

  it('refuses a port that something already answers on, with a message that says what to do', async () => {
    const other = net.createServer((s) => s.end());
    const port = await listenOnLoopback(other);
    try {
      await assert.rejects(
        startBridge({ host: '127.0.0.1', port, token: TOKEN, root, createLink: () => new MockConsole() }),
        /already in use.*--port/,
      );
    } finally {
      other.close();
    }
  });

  it('starts on an explicit free port', async () => {
    const probe = net.createServer();
    const port = await listenOnLoopback(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const b = await startBridge({ host: '127.0.0.1', port, token: TOKEN, root, createLink: () => new MockConsole() });
    try {
      assert.equal(b.port, port);
    } finally {
      await b.close();
    }
  });
});

describe('H.264 helpers', () => {
  const sps = [0x67, 0x42, 0xc0, 0x1f, 0xda, 0x01, 0x40];
  it('finds the codec string in the SPS, with 3 and 4 byte start codes', () => {
    assert.equal(findSpsCodec(Uint8Array.of(0, 0, 0, 1, ...sps, 0, 0, 0, 1, 0x68, 0xce)), 'avc1.42c01f');
    assert.equal(findSpsCodec(Uint8Array.of(0, 0, 1, ...sps)), 'avc1.42c01f');
    assert.equal(findSpsCodec(Uint8Array.of(0, 0, 0, 1, 0x65, 1, 2, 3)), null);
    assert.equal(findSpsCodec(new Uint8Array(0)), null);
    assert.equal(findSpsCodec(Uint8Array.of(0, 0, 0, 1, 0x67, 0x42)), null, 'a truncated SPS must not read past the end');
  });
  it('tells keyframes (IDR) from other access units', () => {
    assert.equal(hasIdr(Uint8Array.of(0, 0, 0, 1, ...sps, 0, 0, 0, 1, 0x65, 0x88)), true);
    assert.equal(hasIdr(Uint8Array.of(0, 0, 0, 1, 0x41, 0x9a, 0x01)), false);
  });
});

// ------------------------------------------------------------------ gtp-core contract

describe('gtp-core contract (fake core process)', () => {
  const coreBridge = (...extra: string[]): Promise<Bridge> =>
    bridgeWith(() => new CoreLink({ command: process.execPath, args: [fakeCore, ...extra] }));

  it('frames survive any chunking', () => {
    const got: number[][] = [];
    const reader = new FrameReader(1000, (b) => got.push([...b]), () => assert.fail('no error expected'));
    const bytes = Buffer.concat([writeFrame(Uint8Array.of(7, 1, 2)), writeFrame(Uint8Array.of(8)), writeFrame(Uint8Array.of(9, 9, 9, 9))]);
    for (let i = 0; i < bytes.length; i++) reader.push(bytes.subarray(i, i + 1));
    assert.deepEqual(got, [[7, 1, 2], [8], [9, 9, 9, 9]]);
    let error = '';
    new FrameReader(10, () => {}, (e) => (error = e)).push(Buffer.from([255, 255, 0, 0]));
    assert.match(error, /bad message length/);
  });

  it('relays status, pads and video, and passes quality and keyframe requests', async () => {
    const bridge = await coreBridge();
    const c = await Client.open(bridge.port);
    await c.next((m) => typeof m === 'string' && m.includes('fake core'));
    await c.json('ready');
    c.ws.send(encodePad(77, padWith((p) => (p.buttons = BUTTON.cross)), false));
    const v = decodeVideo(await c.video())!;
    assert.equal(v.header.inputSeq, 77);
    assert.deepEqual([...v.payload], [1, 2, 3, 4, 5]);
    c.ws.send(JSON.stringify({ type: 'quality', preset: 'saver' }));
    // The core's reply to the quality it was started with (balanced) may arrive first; wait for the saver one.
    const status = await c.next<string>((m) => typeof m === 'string' && m.includes('quality') && m.includes('saver'));
    assert.ok(status.includes('640'));
    c.ws.send(JSON.stringify({ type: 'keyframe' }));
    assert.deepEqual([...decodeVideo(await c.video())!.payload], [9, 9]);
    c.close();
  });

  it('works when the core writes one byte at a time', async () => {
    const bridge = await coreBridge('--split');
    const c = await Client.open(bridge.port);
    await c.json('ready');
    c.ws.send(encodePad(3, emptyPadState(), false));
    assert.equal(decodeVideo(await c.video(6000))!.header.inputSeq, 3);
    c.close();
  });

  it('reports a core that dies', async () => {
    const bridge = await coreBridge('--crash');
    const c = await Client.open(bridge.port);
    await c.json('ready');
    c.ws.send(encodePad(1, emptyPadState(), false));
    const err = await c.next<string>((m) => typeof m === 'string' && m.includes('exited'));
    assert.ok(err.includes('error'));
    c.close();
  });

  it('shuts the core down when the client leaves', async () => {
    let link!: CoreLink;
    const bridge = await bridgeWith(() => (link = new CoreLink({ command: process.execPath, args: [fakeCore] })));
    const c = await Client.open(bridge.port);
    await c.json('ready');
    c.close();
    const started = Date.now();
    await sleep(300);
    await link.stop(); // returns once the child has exited
    assert.ok(Date.now() - started < 3000);
  });
});
