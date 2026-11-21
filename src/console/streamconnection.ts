// SPDX-License-Identifier: AGPL-3.0-only
//
// The stream connection: what turns an accepted control connection into a picture and a way to send input.
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/streamconnection.c,
// lib/src/congestioncontrol.c and lib/src/audio.c (the audio header) (commit 43728af). The order of the messages,
// their channels and chunk flags, the splitting of the first message over the MTU, the key indices and the intervals
// are transcribed from there.
//
// The sequence, over the Takion transport (UDP 9296):
//   1. BIG   client -> console: protocol version, the session id from the control connection, the launch spec
//            (resolution, frame rate, bitrate, codec; encrypted with the session keys), an ECDH public key and its
//            signature.
//   2. BANG  console -> client: its ECDH public key. Both sides derive a secret; from it and the handshake key come the
//            two packet ciphers (index 2 for what the client sends, index 3 for what the console sends).
//   3. STREAMINFO console -> client: the video profiles with their stream headers, and the audio header. The client
//            acknowledges, announces a controller and sends its own audio header.
//   4. From then on: video and audio packets arrive; the client sends a heartbeat every second, a congestion report
//            every 200 ms, controller input, and reports of broken frames or requests for a key frame.
//
// It is written against a small transport interface (StreamTransport) rather than a concrete class, so it can be tested
// with a simulated console and joined to the Takion port by a thin adapter.
//
// STATUS: checked against a simulated console in tests. NOT yet run against a real console.
// Secrets: nothing here logs keys, the session id or the launch spec.

import { randomBytes } from 'node:crypto';

import type { VirtualPadState } from '../engine/types.ts';
import type { TakionAvPacket } from './av-packet.ts';
import { controllerStateFromPad, createIdleControllerState, type ControllerState } from './controller.ts';
import { Ecdh } from './ecdh.ts';
import { FeedbackSender } from './feedbacksender.ts';
import { GKCrypt, GKCRYPT_BLOCK_SIZE } from './gkcrypt.ts';
import { encryptLaunchSpec, formatLaunchSpec, type LaunchCodec } from './launchspec.ts';
import { PacketStats } from './packetstats.ts';
import { isPs5Target, type KnownTarget, type RpCrypt } from './rpcrypt.ts';
import { StreamStats } from './streamstats.ts';
import { CONTROLLER_TYPE, decodeTakionMessage, encodeTakionMessage, TAKION_PAYLOAD_TYPE, type TakionMessage } from './takion-proto.ts';
import { VideoReceiver, type VideoFrameInfo, type VideoProfile } from './videoreceiver.ts';

export const STREAM_PORT = 9296;
const EXPECT_TIMEOUT_MS = 5000;
const AUDIO_HEADER_SIZE = 0xe;
/** What the reference sends as its own (microphone) audio header: chiaki_audio_header_set(16, 1, 48000, 480), saved. */
const MIC_AUDIO_HEADER = Uint8Array.from([0x01, 0x10, 0x00, 0x00, 0xbb, 0x80, 0x00, 0x00, 0x01, 0xe0, 0x00, 0x00, 0x00, 0x01]);

export type StreamErrorCode = 'transport' | 'timeout' | 'rejected' | 'disconnected' | 'invalid-response' | 'stopped';

export class StreamError extends Error {
  code: StreamErrorCode;
  constructor(code: StreamErrorCode, message: string) {
    super(message);
    this.name = 'StreamError';
    this.code = code;
  }
}

/** What the stream connection needs from the transport. The Takion port provides it through an adapter. */
export interface StreamTransport {
  /** Protocol version in use: 12 for a PS5, 9 for a PS4. */
  readonly version: number;
  /** Complete the transport handshake. */
  connect(): Promise<void>;
  /** A reliable message. `chunkFlags` is 1 for a whole message or the last piece of one, 0 for a piece that is continued. */
  sendMessageData(chunkFlags: number, channel: number, payload: Uint8Array): void;
  /** A further piece of a message started with sendMessageData(0, ...). */
  sendMessageDataCont(chunkFlags: number, channel: number, payload: Uint8Array): void;
  setCrypt(local: GKCrypt, remote: GKCrypt): void;
  sendCongestion(received: number, lost: number): void;
  sendFeedbackState(seqNum: number, payload: Uint8Array): void;
  sendFeedbackHistory(seqNum: number, payload: Uint8Array, eventCount: number): void;
  close(): void;
  events: {
    /** A protobuf message from the console (data type 0). */
    onProtobuf?: (payload: Uint8Array) => void;
    onAv?: (packet: TakionAvPacket) => void;
    onClosed?: (reason: string) => void;
  };
}

export interface StreamVideoRequest {
  width: number;
  height: number;
  maxFps: number;
  bitrateKbps: number;
  codec: LaunchCodec;
}

/** Things that can be changed to study how the stream behaves. Defaults are the reference's. */
export interface StreamTuning {
  /** Ask for a key frame when a frame cannot be rebuilt, and drop P frames until it arrives. */
  enableIdrOnFecFailure: boolean;
  /** Never report more than this share of units as lost in a congestion report (the reference clamps the same way). */
  packetLossMax: number;
  /** How often a congestion report is sent, ms. */
  congestionIntervalMs: number;
  /** How often a heartbeat is sent, ms. */
  heartbeatIntervalMs: number;
}

export const DEFAULT_TUNING: StreamTuning = { enableIdrOnFecFailure: false, packetLossMax: 0.05, congestionIntervalMs: 200, heartbeatIntervalMs: 1000 };

export interface StreamFrame {
  /** Annex B bytes. On a key frame the stream header (SPS/PPS, or VPS/SPS/PPS) is in front of the frame. */
  data: Uint8Array;
  key: boolean;
  frameIndex: number;
  width: number;
  height: number;
  info: VideoFrameInfo;
}

export interface StreamConnectionOptions {
  transport: StreamTransport;
  target: KnownTarget;
  /** The session id the console sent on the control connection. */
  sessionId: string;
  /** The session cipher state (as used by the control connection): the launch spec is encrypted with it. */
  sessionCrypt: RpCrypt;
  video: StreamVideoRequest;
  tuning?: Partial<StreamTuning>;
  /** Incoming and outgoing MTU and the round trip time. The reference's fallbacks when not measured: 1454, 1454, 1 ms. */
  mtuIn?: number;
  mtuOut?: number;
  rttMs?: number;
  /** The reference never checks the console's ECDH signature. Off by default for that reason. */
  verifyEcdhSignature?: boolean;
  onFrame?: (frame: StreamFrame) => void;
  /** The stream ended after it had started (the console disconnected, or the transport closed). */
  onClosed?: (reason: string) => void;
  /** Progress lines. Never contains a key, the session id or the launch spec. */
  log?: (line: string) => void;
  /** How long to wait for each answer of the console during set-up. The reference waits 5000 ms. */
  expectTimeoutMs?: number;
  /** Replaced only by tests. */
  handshakeKey?: Uint8Array;
  ecdh?: Ecdh;
  stats?: StreamStats;
}

type State = 'new' | 'connecting' | 'expect-bang' | 'expect-streaminfo' | 'streaming' | 'closed';

export class StreamConnection {
  readonly stats: StreamStats;
  tuning: StreamTuning;
  /** The profiles the console announced. Empty until the stream info arrived. */
  profiles: VideoProfile[] = [];

  #o: StreamConnectionOptions;
  #state: State = 'new';
  #handshakeKey: Uint8Array;
  #ecdh: Ecdh;
  #gkLocal: GKCrypt | null = null;
  #gkRemote: GKCrypt | null = null;
  #packetStats = new PacketStats();
  #video: VideoReceiver;
  #feedback: FeedbackSender | null = null;
  #controller: ControllerState = createIdleControllerState();
  #timers: Array<ReturnType<typeof setInterval>> = [];
  #earlyStreamInfo: Uint8Array | null = null;
  #wait: { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  #header: Uint8Array | null = null;
  #profileIndex = -1;

  constructor(o: StreamConnectionOptions) {
    this.#o = o;
    this.tuning = { ...DEFAULT_TUNING, ...o.tuning };
    this.stats = o.stats ?? new StreamStats();
    // A gap of more than two and a half frame times is what a viewer sees as a hitch: 83 ms at 30 fps, 42 ms at 60.
    if (o.video.maxFps > 0) this.stats.stutterThresholdMs = Math.round(2500 / o.video.maxFps);
    this.#handshakeKey = o.handshakeKey ?? randomBytes(16);
    this.#ecdh = o.ecdh ?? new Ecdh();
    this.#video = new VideoReceiver({
      codec: o.video.codec,
      enableIdrOnFecFailure: this.tuning.enableIdrOnFecFailure,
      packetStats: this.#packetStats,
      onFrame: (frame, info) => this.#frame(frame, info),
      onCorruptFrames: (start, end) => this.#send(2, { type: TAKION_PAYLOAD_TYPE.CORRUPTFRAME, corruptPayload: { start, end } }, () => this.stats.corruptReport(start, end)),
      onIdrRequest: () => this.#send(2, { type: TAKION_PAYLOAD_TYPE.IDRREQUEST }, () => this.stats.idrRequest()),
      onFecFailure: (e) => this.stats.event('fec-failure', `frame ${e.frameIndex}${e.idrRequestSent ? ', key frame requested' : ''}`),
    });
    const t = o.transport;
    t.events.onProtobuf = (payload) => this.#protobuf(payload);
    t.events.onAv = (packet) => this.#av(packet);
    t.events.onClosed = (reason) => this.#ended(new StreamError('transport', reason));
  }

  get state(): State {
    return this.#state;
  }

  #log(line: string): void {
    this.#o.log?.(line);
  }

  /** Run the whole set-up. Resolves when the stream info has been handled and input and heartbeats are running. */
  async start(): Promise<void> {
    if (this.#state !== 'new') throw new StreamError('stopped', 'the stream connection was already started');
    try {
      await this.#setUp();
    } catch (e) {
      this.#abort(); // whatever stage failed: no timer, no input sender and no open transport may be left behind
      throw e;
    }
  }

  #abort(): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#stopTimers();
    this.#feedback?.stop();
    try {
      this.#o.transport.close();
    } catch {
      /* already closed */
    }
  }

  async #setUp(): Promise<void> {
    const o = this.#o;
    this.#state = 'connecting';
    this.#log('connecting the stream transport');
    try {
      await o.transport.connect();
    } catch (e) {
      throw new StreamError('transport', `The stream transport did not connect: ${(e as Error).message}`);
    }
    this.#checkOpen();
    this.stats.stage('transport');
    this.#startCongestionReports();

    this.#state = 'expect-bang';
    this.#log('sending the stream request (BIG)');
    const bang = this.#expect('the console did not answer the stream request (no BANG)');
    this.#sendBig();
    await bang;
    this.stats.stage('bang');
    this.#log('key exchange done');

    this.#state = 'expect-streaminfo';
    const info = this.#expect('the console did not send the stream info');
    if (this.#earlyStreamInfo) {
      const early = this.#earlyStreamInfo;
      this.#earlyStreamInfo = null;
      this.#protobuf(early);
    }
    await info;
    this.stats.stage('streaminfo');
    this.#log(`stream info received: ${this.profiles.map((p) => `${p.width}x${p.height}`).join(', ') || 'no video profile'}`);

    this.#feedback = new FeedbackSender({
      sink: { sendFeedbackState: (seq, payload) => o.transport.sendFeedbackState(seq, payload), sendFeedbackHistory: (seq, payload, count) => o.transport.sendFeedbackHistory(seq, payload, count) },
      protocolVersion: o.transport.version,
    });
    this.#feedback.setControllerState(this.#controller);
    this.#state = 'streaming';
    this.#timers.push(setInterval(() => this.#send(1, { type: TAKION_PAYLOAD_TYPE.HEARTBEAT }), this.tuning.heartbeatIntervalMs));
    this.#timers.push(setInterval(() => this.stats.tick(), 1000));
  }

  #checkOpen(): void {
    if (this.#state === 'closed') throw new StreamError('stopped', 'the stream connection was closed');
  }

  /** A promise for the current stage, failed after the reference's 5 s. */
  #expect(timeoutMessage: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#wait = null;
        reject(new StreamError('timeout', timeoutMessage));
      }, this.#o.expectTimeoutMs ?? EXPECT_TIMEOUT_MS);
      this.#wait = { resolve, reject, timer };
    });
  }

  #stageDone(): void {
    const w = this.#wait;
    this.#wait = null;
    if (w) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  #stageFailed(e: StreamError): void {
    const w = this.#wait;
    this.#wait = null;
    if (w) {
      clearTimeout(w.timer);
      w.reject(e);
    }
  }

  /** Port of stream_connection_send_big(), including the way it is split over the MTU. */
  #sendBig(): void {
    const o = this.#o;
    const mtuIn = o.mtuIn ?? 1454;
    const mtuOut = o.mtuOut ?? 1454;
    const json = formatLaunchSpec({
      target: o.target, width: o.video.width, height: o.video.height, maxFps: o.video.maxFps, bitrateKbps: o.video.bitrateKbps, codec: o.video.codec,
      mtu: mtuIn, rttMs: o.rttMs ?? 1, handshakeKey: this.#handshakeKey,
    });
    const key = this.#ecdh.getLocalPubKey(this.#handshakeKey);
    const buf = encodeTakionMessage({
      type: TAKION_PAYLOAD_TYPE.BIG,
      bigPayload: {
        clientVersion: o.transport.version,
        sessionKey: o.sessionId,
        launchSpec: encryptLaunchSpec(json, o.sessionCrypt),
        encryptedKey: new Uint8Array(4),
        ecdhPubKey: key.publicKey,
        ecdhSig: key.signature,
      },
    });
    const mtu = Math.min(mtuIn, mtuOut) - 50; // the reference's allowance for the network's own overhead
    let total = buf.length;
    let pos = 0;
    let first = true;
    while (mtu < total + 26 || (mtu < total + 25 && !first)) {
      const size = first ? mtu - 26 : mtu - 25;
      if (first) o.transport.sendMessageData(0, 1, buf.subarray(pos, pos + size));
      else o.transport.sendMessageDataCont(0, 1, buf.subarray(pos, pos + size));
      first = false;
      pos += size;
      total -= size;
    }
    if (total > 0) {
      if (first) o.transport.sendMessageData(1, 1, buf.subarray(pos));
      else o.transport.sendMessageDataCont(1, 1, buf.subarray(pos));
    }
  }

  #send(channel: number, msg: TakionMessage, sent?: () => void): boolean {
    if (this.#state === 'closed') return false;
    try {
      this.#o.transport.sendMessageData(1, channel, encodeTakionMessage(msg));
      sent?.();
      return true;
    } catch (e) {
      this.#log(`sending a stream message failed: ${(e as Error).message}`);
      return false;
    }
  }

  #protobuf(payload: Uint8Array): void {
    let msg: TakionMessage;
    try {
      msg = decodeTakionMessage(payload);
    } catch (e) {
      this.#log(`a stream message could not be decoded: ${(e as Error).message}`);
      return;
    }
    if (msg.type === TAKION_PAYLOAD_TYPE.DISCONNECT) {
      const reason = msg.disconnectPayload?.reason ?? 'no reason given';
      this.stats.event('console-disconnect', reason);
      return this.#ended(new StreamError('disconnected', `The console ended the stream: ${reason}`));
    }
    if (this.#state === 'expect-bang') this.#bang(msg, payload);
    else if (this.#state === 'expect-streaminfo') this.#streamInfo(msg);
    // While streaming the reference only acts on DISCONNECT; the other messages are informational.
  }

  /** Port of stream_connection_takion_data_expect_bang() and stream_connection_init_crypt(). */
  #bang(msg: TakionMessage, raw: Uint8Array): void {
    if (msg.type !== TAKION_PAYLOAD_TYPE.BANG || !msg.bangPayload) {
      if (msg.type === TAKION_PAYLOAD_TYPE.STREAMINFO && !this.#earlyStreamInfo) this.#earlyStreamInfo = Uint8Array.from(raw);
      return;
    }
    const b = msg.bangPayload;
    if (!b.versionAccepted) return this.#stageFailed(new StreamError('rejected', 'The console did not accept the protocol version'));
    if (!b.encryptedKeyAccepted) return this.#stageFailed(new StreamError('rejected', 'The console did not accept the stream request (encrypted key refused)'));
    if (!b.ecdhPubKey?.length || !b.ecdhSig?.length) return this.#stageFailed(new StreamError('invalid-response', 'The console sent no key for the key exchange'));
    let secret: Uint8Array;
    try {
      secret = this.#ecdh.deriveSecret(b.ecdhPubKey, this.#handshakeKey, b.ecdhSig, { verifySignature: this.#o.verifyEcdhSignature ?? false });
    } catch (e) {
      return this.#stageFailed(new StreamError('invalid-response', `The key exchange failed: ${(e as Error).message}`));
    }
    this.#gkLocal = new GKCrypt(2, this.#handshakeKey, secret);
    this.#gkRemote = new GKCrypt(3, this.#handshakeKey, secret);
    this.#o.transport.setCrypt(this.#gkLocal, this.#gkRemote);
    this.#stageDone();
  }

  /** Port of stream_connection_takion_data_expect_streaminfo(). */
  #streamInfo(msg: TakionMessage): void {
    if (msg.type !== TAKION_PAYLOAD_TYPE.STREAMINFO || !msg.streamInfoPayload) return;
    const s = msg.streamInfoPayload;
    if (s.audioHeader.length !== AUDIO_HEADER_SIZE) return this.#stageFailed(new StreamError('invalid-response', 'The console sent an audio header of the wrong size'));
    this.profiles = s.resolution.filter((r) => r.videoHeader.length > 0).map((r) => ({ width: r.width, height: r.height, header: Uint8Array.from(r.videoHeader) }));
    this.#video.streamInfo(this.profiles);
    // The acknowledgement goes on channel 9; the controller and the audio header on channel 1, as in the reference.
    this.#send(9, { type: TAKION_PAYLOAD_TYPE.STREAMINFOACK });
    const ok =
      this.#send(1, { type: TAKION_PAYLOAD_TYPE.CONTROLLERCONNECTION, controllerConnectionPayload: { connected: true, controllerType: CONTROLLER_TYPE.DUALSHOCK4 } }) &&
      this.#send(1, { type: TAKION_PAYLOAD_TYPE.STREAMINFO, streamInfoPayload: { resolution: [], audioHeader: MIC_AUDIO_HEADER, audioChannel: [] } });
    if (!ok) return this.#stageFailed(new StreamError('transport', 'Could not answer the stream info'));
    this.#stageDone();
  }

  /** Port of stream_connection_takion_av(): decrypt with the console's cipher, then hand to the receiver. */
  #av(packet: TakionAvPacket): void {
    if (!this.#gkRemote || this.#state === 'closed') return;
    this.#gkRemote.decrypt(packet.keyPos + BigInt(GKCRYPT_BLOCK_SIZE), packet.data);
    if (packet.isVideo) this.#video.avPacket(packet);
    // Audio and haptics are not handled yet.
  }

  #frame(frame: Uint8Array, info: VideoFrameInfo): boolean {
    if (info.isHeader) {
      this.#header = Uint8Array.from(frame);
      this.#profileIndex = info.profileIndex;
      this.stats.event('profile', `${this.profiles[info.profileIndex]?.width ?? '?'}x${this.profiles[info.profileIndex]?.height ?? '?'}`);
      return true;
    }
    const profile = this.profiles[this.#profileIndex >= 0 ? this.#profileIndex : info.profileIndex];
    // A decoder needs the parameter sets with the key frame, so they are put in front of it.
    const data = info.keyFrame && this.#header ? Buffer.concat([this.#header, frame]) : Uint8Array.from(frame);
    this.stats.frame(data.length, { keyFrame: info.keyFrame, fecRecovered: info.fecRecovered, framesLost: info.framesLost });
    this.#o.onFrame?.({ data, key: info.keyFrame, frameIndex: info.frameIndex, width: profile?.width ?? 0, height: profile?.height ?? 0, info });
    return true;
  }

  /** Port of the congestion control thread: count, clamp, report. */
  #startCongestionReports(): void {
    this.#timers.push(
      setInterval(() => {
        if (this.#state === 'closed') return;
        const { received, lost } = this.#packetStats.get(true);
        let r = Number(received);
        let l = Number(lost);
        const total = r + l;
        const measuredLost = l;
        if (total > 0 && l / total > this.tuning.packetLossMax) {
          l = Math.floor(total * this.tuning.packetLossMax);
          r = total - l;
        }
        this.stats.congestion(Number(received), measuredLost, l);
        try {
          this.#o.transport.sendCongestion(r & 0xffff, l & 0xffff);
        } catch {
          /* the next report will try again */
        }
      }, this.tuning.congestionIntervalMs),
    );
  }

  /** The pad state to send. Sticks and motion go as state, buttons and triggers as history events. */
  setPad(pad: VirtualPadState): void {
    controllerStateFromPad(pad, this.#controller);
    this.#feedback?.setControllerState(this.#controller);
  }

  requestKeyframe(): void {
    this.#send(2, { type: TAKION_PAYLOAD_TYPE.IDRREQUEST }, () => this.stats.idrRequest());
  }

  #stopTimers(): void {
    for (const t of this.#timers.splice(0)) clearInterval(t);
  }

  #ended(e: StreamError): void {
    if (this.#state === 'closed') return;
    const wasStreaming = this.#state === 'streaming';
    this.#state = 'closed';
    this.#stopTimers();
    this.#feedback?.stop();
    this.#stageFailed(e);
    try {
      this.#o.transport.close();
    } catch {
      /* already closed */
    }
    if (wasStreaming && e.code !== 'stopped') this.#o.onClosed?.(e.message); // the owner knows when it stopped it itself
  }

  /** Let go of every button, tell the console, and close. */
  stop(): void {
    if (this.#state === 'closed') return;
    if (this.#state === 'streaming') {
      this.#feedback?.stop({ sendNeutral: true });
      this.#send(1, { type: TAKION_PAYLOAD_TYPE.DISCONNECT, disconnectPayload: { reason: 'Client Disconnecting' } });
    }
    this.stats.event('stopped');
    this.#ended(new StreamError('stopped', 'stopped by this side'));
  }
}
