// SPDX-License-Identifier: AGPL-3.0-only
//
// The launch spec text and its encryption. The expected text is the reference's format string (launchspec.c) with its
// arguments filled in by hand, so a single wrong character shows up here.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encryptLaunchSpec, formatLaunchSpec, type LaunchSpec } from '../src/console/launchspec.ts';
import { encrypt, initAuth } from '../src/console/rpcrypt.ts';

const KEY = Uint8Array.from({ length: 16 }, (_, i) => i);
const KEY_B64 = 'AAECAwQFBgcICQoLDA0ODw==';
const base: LaunchSpec = { target: 'ps5-1', width: 1280, height: 720, maxFps: 60, bitrateKbps: 10000, codec: 'h264', mtu: 1454, rttMs: 1, handshakeKey: KEY };

describe('launch spec', () => {
  it('is the reference\'s text for a PS5 asking for 720p60 H.264', () => {
    assert.equal(
      formatLaunchSpec(base),
      '{"sessionId":"sessionId4321","streamResolutions":[{"resolution":{"width":1280,"height":720},"maxFps":60,"score":10}],' +
        '"network":{"bwKbpsSent":10000,"bwLoss":0.001000,"mtu":1454,"rtt":1,"ports":[53,2053]},"slotId":1,' +
        '"appSpecification":{"minFps":30,"minBandwidth":0,"extTitleId":"ps3","version":1,"timeLimit":1,"startTimeout":100,"afkTimeout":100,"afkTimeoutDisconnect":100},' +
        '"konan":{"ps3AccessToken":"accessToken","ps3RefreshToken":"refreshToken"},' +
        '"requestGameSpecification":{"model":"bravia_tv","platform":"android","audioChannels":"5.1","language":"sp","acceptButton":"X","connectedControllers":["xinput","ds3","ds4"],' +
        '"yuvCoefficient":"bt601","videoEncoderProfile":"hw4.1","audioEncoderProfile":"audio1","adaptiveStreamMode": "resize"},' +
        '"userProfile":{"onlineId":"psnId","npId":"npId","region":"US","languagesUsed":["en","jp"]},' +
        `"videoCodec":"avc","dynamicRange":"SDR","handshakeKey":"${KEY_B64}"}`,
    );
  });

  it('is valid JSON and carries what was asked', () => {
    const j = JSON.parse(formatLaunchSpec({ ...base, width: 960, height: 540, maxFps: 30, bitrateKbps: 4000, mtu: 1400, rttMs: 12 }));
    assert.deepEqual(j.streamResolutions[0], { resolution: { width: 960, height: 540 }, maxFps: 30, score: 10 });
    assert.equal(j.network.bwKbpsSent, 4000);
    assert.equal(j.network.mtu, 1400);
    assert.equal(j.network.rtt, 12);
    assert.equal(j.handshakeKey, KEY_B64);
  });

  it('names the codec and the dynamic range only on PS5', () => {
    assert.match(formatLaunchSpec({ ...base, codec: 'h265' }), /"videoCodec":"hevc","dynamicRange":"SDR",/);
    assert.match(formatLaunchSpec({ ...base, codec: 'h265-hdr' }), /"videoCodec":"hevc","dynamicRange":"HDR",/);
    const ps4 = formatLaunchSpec({ ...base, target: 'ps4-10' });
    assert.ok(!ps4.includes('videoCodec') && !ps4.includes('dynamicRange') && !ps4.includes('adaptiveStreamMode'));
    assert.match(ps4, /"audioEncoderProfile":"audio1"\},"userProfile"/);
    assert.throws(() => formatLaunchSpec({ ...base, handshakeKey: new Uint8Array(8) }), RangeError);
  });

  it('is XORed with the key stream of counter 0, with its terminating zero, the way the reference does it', () => {
    const crypt = initAuth('ps5-1', Uint8Array.from({ length: 16 }, (_, i) => 0x10 + i), Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i));
    const json = formatLaunchSpec(base);
    const out = Buffer.from(encryptLaunchSpec(json, crypt), 'base64');
    assert.equal(out.length, json.length + 1, 'the terminating zero is included');
    const stream = encrypt(crypt, 0, new Uint8Array(out.length));
    const back = Buffer.from(out.map((b, i) => b ^ stream[i]!));
    assert.equal(back.subarray(0, -1).toString('latin1'), json);
    assert.equal(back[back.length - 1], 0);
    // It must differ from plain encryption after the first block: that is exactly the trap this function avoids.
    const plainEncrypted = encrypt(crypt, 0, Buffer.from(`${json}\0`, 'latin1'));
    assert.deepEqual(out.subarray(0, 16), plainEncrypted.subarray(0, 16));
    assert.notDeepEqual(out.subarray(16, 48), plainEncrypted.subarray(16, 48));
  });
});
