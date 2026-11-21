// SPDX-License-Identifier: AGPL-3.0-only
//
// Walk a connection to a registered console step by step and say how far it gets. For checking the protocol port
// against real hardware. It sends no controller input and it closes the connection at the end.
//
//   npm run connect [-- --mac <id>] [--host <ip>] [--hold <seconds>]
//   npm run connect -- --stream <seconds> [--video 960x540x30x4000] [--save first-key-frame.h264] [--stats run.json]
//                      [--idr-on-fec-failure] [--loss-max 0.05] [--congestion-ms 200]
//
// Steps: is the console there and on (a direct question to its address) -> session request -> control connection ->
// session id, and with --stream: the stream connection and a few seconds of video, counted and measured.
// Nothing secret is printed: no keys, no device id, no session id (only its length).

import { discover } from '../src/console/discovery.ts';
import { Ctrl, CtrlError, CTRL_MESSAGE } from '../src/console/ctrl.ts';
import { requestSession, SessionError } from '../src/console/session.ts';
import { ConsoleStore, defaultStorePath } from '../src/console/store.ts';
import { DEFAULT_TUNING, StreamConnection } from '../src/console/streamconnection.ts';
import { takionTransport } from '../src/console/takion-transport.ts';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const step = (n, text) => console.log(`\n[${n}] ${text}`);
const ok = (text) => console.log(`    ok    ${text}`);
const bad = (text) => console.log(`    FAIL  ${text}`);

const store = new ConsoleStore(defaultStorePath());
const list = store.list();
const chosen = opt('mac') ? list.find((c) => c.mac === opt('mac').toLowerCase()) : list[0];
if (!chosen) {
  console.error(list.length ? 'That console is not registered on this computer.' : 'No console is registered on this computer. Register one first (the PS5 page, or npm run register).');
  process.exit(1);
}
const record = store.get(chosen.mac);
const host = opt('host') ?? record.host;
const holdSeconds = Number(opt('hold') ?? 3);
console.log(`Console: ${chosen.nickname || '(no name)'} (${chosen.target}) at ${host}`);

let exitCode = 1;
let ctrl;
try {
  step(1, 'Is the console there, and is it on?');
  const found = (await discover({ hosts: [host], timeoutMs: 2500 })).hosts[0];
  if (!found) {
    bad('no answer at that address (off, another network, or the address changed: try --host)');
    process.exit(1);
  }
  if (found.state !== 'ready') {
    bad(`it answers, but it is in rest mode (HTTP ${found.statusCode}). Turn it on first.`);
    process.exit(1);
  }
  ok(`on, system version ${found.systemVersion ?? '?'}`);

  step(2, 'Session request (TCP 9295)');
  const grant = await requestSession({ host, target: record.target, registKey: Buffer.from(record.registKey, 'hex'), rpKey: Buffer.from(record.rpKey, 'hex') });
  ok('accepted: the console knows this registration and sent a nonce');
  store.markVerified(record.mac, host);

  step(3, 'Control connection (TCP 9295), encrypted with the session keys');
  const seen = [];
  ctrl = new Ctrl({ host, target: record.target, crypt: grant.crypt, registKey: Buffer.from(record.registKey, 'hex') });
  let pinAsked = false;
  ctrl.events.onMessage = (type, payload) => seen.push(`0x${type.toString(16)}(${payload.length})`);
  ctrl.events.onLoginPinRequest = () => (pinAsked = true);
  await ctrl.connect();
  ok(`accepted${ctrl.serverType !== undefined ? `, console type ${ctrl.serverType} (0 = PS4, 1 = PS4 Pro, 2 = PS5)` : ' (the console did not say its type)'}`);
  ok('this is the first use of the session keys, so the key schedule matches the console');

  step(4, 'Session id from the console');
  try {
    const id = await ctrl.waitForSessionId(8000);
    const usable = /^[A-Za-z0-9]{24,78}$/.test(id);
    ok(`received, ${id.length} characters${usable ? '' : ' (not in the usual form: the reference would use a fallback, and so did this)'}`);
    exitCode = 0;
  } catch (e) {
    if (pinAsked) bad('the console asks for the login PIN of the account before it goes on. That is not supported yet.');
    else bad(`${e.message}`);
  }

  const streamSeconds = Number(opt('stream') ?? 0);
  if (exitCode === 0 && streamSeconds > 0) {
    exitCode = 1;
    step(5, 'Stream connection (UDP 9296): transport handshake, key exchange, stream info');
    const [w, h, fps, kbps] = (opt('video') ?? '960x540x30x4000').split('x').map(Number);
    const transport = takionTransport({ host, protocolVersion: record.target.startsWith('ps5') ? 12 : 9 });
    let frames = 0;
    let keyFrames = 0;
    let bytes = 0;
    let firstKey = null;
    let closedReason = '';
    const stream = new StreamConnection({
      transport, target: record.target, sessionId: ctrl.sessionId, sessionCrypt: grant.crypt,
      video: { width: w, height: h, maxFps: fps, bitrateKbps: kbps, codec: 'h264' },
      // The settings a study varies between runs. Without options: the reference's behaviour.
      tuning: {
        ...DEFAULT_TUNING,
        ...(argv.includes('--idr-on-fec-failure') ? { enableIdrOnFecFailure: true } : {}),
        ...(opt('loss-max') !== undefined ? { packetLossMax: Number(opt('loss-max')) } : {}),
        ...(opt('congestion-ms') !== undefined ? { congestionIntervalMs: Number(opt('congestion-ms')) } : {}),
      },
      onFrame: (f) => {
        frames++;
        bytes += f.data.length;
        if (f.key) {
          keyFrames++;
          firstKey ??= Buffer.from(f.data);
        }
      },
      onClosed: (reason) => (closedReason = reason),
    });
    try {
      await stream.start();
      ok(`stream set up. Profiles the console offers: ${stream.profiles.map((p) => `${p.width}x${p.height} (header ${p.header.length} bytes)`).join(', ') || 'none'}`);
      step(6, `Receiving video for ${streamSeconds} s (no input is sent)`);
      await new Promise((r) => setTimeout(r, streamSeconds * 1000));
      const s = stream.stats.snapshot();
      if (frames > 0) ok(`${frames} frames, ${keyFrames} key frames, ${(bytes / 1024).toFixed(0)} KiB, about ${(frames / streamSeconds).toFixed(1)} fps and ${((bytes * 8) / streamSeconds / 1000).toFixed(0)} kbit/s`);
      else bad(`no frame arrived${closedReason ? ` (the stream ended: ${closedReason})` : ''}`);
      console.log(`    lost frames ${s.totals.framesLost}, rebuilt by FEC ${s.totals.fecRecovered}, corrupt reports ${s.totals.corruptReports}, key frame requests ${s.totals.idrRequests}`);
      console.log(`    units received ${s.totals.unitsReceived}, lost ${s.totals.unitsLost}; longest gap between frames ${s.totals.maxFrameGapMs} ms, stutters ${s.totals.stutters}`);
      console.log(`    set-up times (ms since start): ${Object.entries(s.stages).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      if (firstKey) {
        // What kinds of NAL units the first key frame holds: 7 = SPS, 8 = PPS, 5 = IDR slice for H.264.
        const kinds = [];
        for (let i = 0; i + 4 < firstKey.length && kinds.length < 8; i++) if (firstKey[i] === 0 && firstKey[i + 1] === 0 && firstKey[i + 2] === 0 && firstKey[i + 3] === 1) kinds.push(firstKey[i + 4] & 0x1f);
        console.log(`    first key frame: ${firstKey.length} bytes, NAL unit types ${kinds.join(', ')} (7 = SPS, 8 = PPS, 5 = IDR)`);
        if (opt('save')) {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(opt('save'), firstKey);
          console.log(`    saved to ${opt('save')}`);
        }
      }
      if (opt('stats')) {
        // The whole measurement, for comparing runs: totals, one sample per second, the event list, set-up times.
        const { writeFileSync } = await import('node:fs');
        writeFileSync(opt('stats'), JSON.stringify({ video: { width: w, height: h, maxFps: fps, bitrateKbps: kbps, codec: 'h264' }, tuning: stream.tuning, seconds: streamSeconds, profiles: stream.profiles.map((p) => ({ width: p.width, height: p.height })), stream: s }, null, 1));
        console.log(`    measurements saved to ${opt('stats')}`);
      }
      if (frames > 0) exitCode = 0;
    } catch (e) {
      bad(`${e.message}${e.code ? ` [${e.code}]` : ''}`);
      const s = stream.stats.snapshot();
      console.log(`    got as far as: ${Object.keys(s.stages).join(', ') || 'nothing'}`);
    } finally {
      stream.stop();
    }
  }

  if (holdSeconds > 0 && streamSeconds === 0) {
    console.log(`\n    (keeping the connection open for ${holdSeconds} s to see what else the console sends)`);
    await new Promise((r) => setTimeout(r, holdSeconds * 1000));
  }
  const names = Object.fromEntries(Object.entries(CTRL_MESSAGE).map(([k, v]) => [`0x${v.toString(16)}`, k]));
  console.log(`    messages from the console, type(payload bytes): ${seen.map((s) => `${s}${names[s.split('(')[0]] ? `=${names[s.split('(')[0]]}` : ''}`).join(' ') || '(none)'}`);
} catch (e) {
  if (e instanceof SessionError || e instanceof CtrlError) bad(`${e.message} [${e.code}]`);
  else throw e;
} finally {
  ctrl?.close();
}

console.log(exitCode === 0 ? '\nResult: every step that was asked for went through.' : '\nResult: stopped at the step marked FAIL.');
process.exit(exitCode);
