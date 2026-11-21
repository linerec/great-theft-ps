// SPDX-License-Identifier: AGPL-3.0-only
//
// From video packets to frames a decoder can take. Follows the frame numbers, collects each frame's units (see
// frameprocessor.ts), decides when a frame is complete or lost, keeps track of which frames a decoder has seen so
// that a frame referring to a lost one is not handed out, and says which frames the console should treat as corrupt.
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/videoreceiver.c and
// lib/include/chiaki/videoreceiver.h, ChiakiVideoProfile from lib/include/chiaki/video.h, and the limit on the number
// of profiles as enforced in lib/src/streamconnection.c, pb_decode_resolution() (commit 43728af).
//
// The reference reaches into the session and the stream connection; here those are callbacks in the options:
//   session->video_sample_cb(buf, size, frames_lost, recovered)      -> onFrame(frame, info)
//   stream_connection_send_corrupt_frame(start, end)                 -> onCorruptFrames(start, end)
//   stream_connection_send_idr_request()                             -> onIdrRequest()
//   chiaki_session_send_event(CHIAKI_EVENT_VIDEO_FEC_FAILURE)        -> onFecFailure(event)
//   session->connect_info.video_profile.codec                        -> codec
//   session->connect_info.enable_idr_on_fec_failure                  -> enableIdrOnFecFailure
//   the ChiakiPacketStats shared with the congestion control         -> packetStats
//   chiaki_time_now_monotonic_ms()                                   -> now
// The mutexes of the reference are not needed (one thread).
//
// What onFrame gets, as in the reference:
//   - Once per profile switch (so also before the very first frame): the profile's stream header exactly as the
//     console sent it in the stream info (info.isHeader is true). The header is NOT put in front of any frame.
//   - Then each frame that is complete and whose reference frame was delivered: the payloads of its source units one
//     after another, nothing added and nothing removed. The one change ever made to a frame is the reference frame
//     of an H.265 P slice whose own reference frame was lost (info.recovered).
// Kept as in the reference although they look odd (each is pinned by a test in test/videoreceiver.test.ts):
//   - The unit with the highest index ends its frame the moment it arrives. If it overtakes the other units of its
//     frame on the way, the frame is given up although nothing was lost.
//   - A frame that cannot be rebuilt is reported as corrupt when it is given up and again with every later frame
//     until a frame is delivered. The very first frame failing is reported as "frames 1 to 0".
//   - The number of lost frames after a failed FEC step is a plain difference of frame numbers and is wrong (it can
//     be negative) when the frame number wraps around between the last complete frame and the lost one.
//   - A frame of which no packet arrives is reported as corrupt but not counted in the lost frames.
//   - A frame whose slice header cannot be read is handed out without any check of its reference frame.
//   - While waiting for a requested key frame, P frames are dropped without being counted as lost.
//
// Not in the reference: a callback that throws. The receiver finishes its own bookkeeping for the packet as if the
// callback had reported a failure, and then throws the error on to the caller of avPacket().
//
// STATUS: the reference has no test for this file. Checked by tests written for this port (test/videoreceiver.test.ts):
// frames built there, cut into units with FEC units from this port's encoder, with units and frames dropped,
// reordered and repeated. What a real console sends has not been seen: not run against a real console.

import type { TakionAvPacket } from './av-packet.ts';
import {
  BITSTREAM_SLICE, bitstreamHeader, bitstreamInit, bitstreamSlice, bitstreamSliceSetReferenceFrame,
  type Bitstream, type BitstreamCodec, type BitstreamSlice, type BitstreamSliceType,
} from './bitstream.ts';
import { FRAME_PROCESSOR_FLUSH_RESULT, FrameProcessor } from './frameprocessor.ts';
import type { PacketStats } from './packetstats.ts';
import { seqNum16Gt, seqNum16Lt } from './seqnum.ts';

/** CHIAKI_VIDEO_PROFILES_MAX. */
export const VIDEO_PROFILES_MAX = 8;

// While waiting for a requested IDR frame, request it again this often, in case the request
// or the IDR frame itself was lost; otherwise the picture would stay frozen
const VIDEO_IDR_RETRY_INTERVAL_MS = 1000;

/** ChiakiVideoProfile: one resolution the console may send, with its stream header (header_sz is header.length). */
export interface VideoProfile {
  width: number;
  height: number;
  /** H.264: SPS and PPS; H.265: VPS, SPS and PPS. Each with its start code, as the console sent them. */
  header: Uint8Array;
}

export interface VideoFrameInfo {
  /** True for the stream header of the profile the stream has just switched to; false for a frame. */
  isHeader: boolean;
  /** The frame's 16 bit index. For a header: the index of the frame whose packet caused the switch. */
  frameIndex: number;
  /** Frames lost since the last frame that was handed out (the reference's frames_lost). 0 for a header. */
  framesLost: number;
  /** The frame referred to a lost frame and was rewritten to refer to an older one (H.265 only). */
  recovered: boolean;
  /** Index into the profiles given to streamInfo(). */
  profileIndex: number;
  /** Type of the frame's first slice as the reference's parser reads it; UNKNOWN when it could not be read. */
  sliceType: BitstreamSliceType;
  /** sliceType is I. This is what the reference takes for the key frame it asked for. */
  keyFrame: boolean;
  /** Source units of this frame were lost and rebuilt from FEC units. */
  fecRecovered: boolean;
}

export interface VideoFecFailureEvent {
  frameIndex: number;
  idrRequestSent: boolean;
}

export interface VideoReceiverOptions {
  /** The codec asked for when the session was set up. Decides how headers and slices are read. */
  codec: BitstreamCodec;
  /** Ask for a key frame when a frame cannot be rebuilt, and drop P frames until it arrives. Off in the reference by default. */
  enableIdrOnFecFailure?: boolean;
  /** Where the units received and lost per frame are counted (the object the congestion control reads). */
  packetStats?: PacketStats | null;
  /**
   * A stream header or a frame. `frame` is a view into the receiver's buffer and only good during the call: copy it
   * to keep it. Return false when the frame could not be processed; it then does not count as delivered (it is not
   * remembered as a reference frame). Without this callback no frame is remembered as a reference frame, so every P
   * frame is dropped as lost.
   */
  onFrame?: (frame: Uint8Array, info: VideoFrameInfo) => boolean | void;
  /** Frames start..end (16 bit indices, inclusive) are missing or broken: tell the console. Return false if that failed. */
  onCorruptFrames?: (start: number, end: number) => boolean | void;
  /** Ask the console for a key frame. Return false if the request could not be sent. */
  onIdrRequest?: () => boolean | void;
  /** A frame could not be rebuilt (only reported when enableIdrOnFecFailure is set, as in the reference). */
  onFecFailure?: (event: VideoFecFailureEvent) => void;
  /** Monotonic clock in milliseconds. Changed only by tests. */
  now?: () => number;
  /** The reference's log lines. Never contains stream data. */
  log?: (line: string) => void;
}

/** ChiakiVideoReceiver. */
export class VideoReceiver {
  profiles: VideoProfile[] = [];
  /** < 0 if no profile selected yet, else index in profiles */
  profileCur = -1;

  /** frame that is currently being filled */
  frameIndexCur = -1;
  /** last frame that has been at least partially decoded */
  frameIndexPrev = -1;
  /** last frame that has been completely decoded */
  frameIndexPrevComplete = 0;
  frameProcessor: FrameProcessor;
  packetStats: PacketStats | null;

  framesLost = 0;
  framesLostTotal = 0;
  referenceFrames: Int32Array = new Int32Array(16).fill(-1);
  bitstream: Bitstream;
  waitingForIdr = false;
  /** when the IDR being waited for was last requested */
  idrRequestLastMs = 0;

  #opts: VideoReceiverOptions;
  #now: () => number;
  #thrown: { error: unknown } | null = null;

  /** chiaki_video_receiver_init. */
  constructor(opts: VideoReceiverOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? ((): number => Math.floor(performance.now()));
    this.frameProcessor = new FrameProcessor(opts.log);
    this.packetStats = opts.packetStats ?? null;
    this.bitstream = bitstreamInit(opts.codec, opts.log);
  }

  #log(line: string): void {
    this.#opts.log?.(line);
  }

  /** Runs a callback. True unless it returned false or threw; what it threw is kept for the end of avPacket(). */
  #call(fn: () => boolean | void): boolean {
    try {
      return fn() !== false;
    } catch (error) {
      if (this.#thrown === null) this.#thrown = { error };
      return false;
    }
  }

  #addRefFrame(frame: number): void {
    const r = this.referenceFrames;
    if (r[0] !== -1) {
      r.copyWithin(1, 0, 15); // memmove(&reference_frames[1], &reference_frames[0], sizeof(int32_t) * 15)
      r[0] = frame;
      return;
    }
    for (let i = 15; i >= 0; i--) {
      if (r[i] === -1) {
        r[i] = frame;
        return;
      }
    }
  }

  #haveRefFrame(frame: number): boolean {
    for (let i = 0; i < 16; i++) {
      if (this.referenceFrames[i] === frame) return true;
    }
    return false;
  }

  /** chiaki_video_receiver_set_waiting_for_idr. Call with true after asking the console for a key frame yourself. */
  setWaitingForIdr(waitingForIdr: boolean): void {
    this.waitingForIdr = waitingForIdr;
    if (waitingForIdr) this.idrRequestLastMs = this.#now();
  }

  /**
   * While waiting for an IDR frame, request it again once VIDEO_IDR_RETRY_INTERVAL_MS has passed
   * since it was last requested.
   */
  #retryIdrRequest(): void {
    const nowMs = this.#now();
    const due = this.waitingForIdr && nowMs - this.idrRequestLastMs >= VIDEO_IDR_RETRY_INTERVAL_MS;
    if (due) this.idrRequestLastMs = nowMs;
    if (!due) return;

    if (this.#sendIdrRequest()) this.#log('Still waiting for IDR frame, requested it again');
    else this.#log('Still waiting for IDR frame and the request could not be sent again');
  }

  #sendIdrRequest(): boolean {
    const cb = this.#opts.onIdrRequest;
    return cb !== undefined && this.#call(cb);
  }

  #sendCorruptFrame(start: number, end: number): boolean {
    const cb = this.#opts.onCorruptFrames;
    return cb !== undefined && this.#call(() => cb(start & 0xffff, end & 0xffff));
  }

  /** chiaki_video_receiver_get_waiting_for_idr. */
  getWaitingForIdr(): boolean {
    return this.waitingForIdr;
  }

  /** chiaki_video_receiver_get_frames_lost_total. */
  getFramesLostTotal(): number {
    return this.framesLostTotal;
  }

  /**
   * chiaki_video_receiver_stream_info: called once, after the console's stream info has arrived, with the video
   * profiles it lists (resolution and stream header each). The headers are copied. A second call is ignored, and so
   * are profiles beyond the first eight, as in the reference.
   */
  streamInfo(profiles: readonly VideoProfile[]): void {
    if (this.profiles.length > 0) {
      this.#log('Video Receiver profiles already set');
      return;
    }
    if (profiles.length > VIDEO_PROFILES_MAX) this.#log('Received more resolutions than the maximum');

    this.profiles = profiles.slice(0, VIDEO_PROFILES_MAX).map((p) => ({ width: p.width, height: p.height, header: Uint8Array.from(p.header) }));

    this.#log('Video Profiles:');
    for (const [i, profile] of this.profiles.entries()) this.#log(`  ${i}: ${profile.width}x${profile.height}`);
  }

  /**
   * chiaki_video_receiver_av_packet: one video packet (packet.isVideo; the caller sorts out audio and haptics, as the
   * reference's stream connection does), already decrypted. The packet's data is copied, so a view into a datagram is fine.
   */
  avPacket(packet: TakionAvPacket): void {
    try {
      this.#avPacket(packet);
    } finally {
      const thrown = this.#thrown;
      this.#thrown = null;
      if (thrown !== null) throw thrown.error;
    }
  }

  #avPacket(packet: TakionAvPacket): void {
    // old frame?
    const frameIndex = packet.frameIndex & 0xffff;
    if (this.frameIndexCur >= 0 && seqNum16Lt(frameIndex, this.frameIndexCur & 0xffff)) {
      this.#log('Video Receiver received old frame packet');
      return;
    }

    // check adaptive stream index
    if (this.profileCur < 0 || this.profileCur !== packet.adaptiveStreamIndex) {
      if (packet.adaptiveStreamIndex >= this.profiles.length) {
        this.#log(`Packet has invalid adaptive stream index ${packet.adaptiveStreamIndex} >= ${this.profiles.length}`);
        return;
      }
      this.profileCur = packet.adaptiveStreamIndex;

      const profile = this.profiles[this.profileCur]!;
      this.#log(`Switched to profile ${this.profileCur}, resolution: ${profile.width}x${profile.height}`);
      const onFrame = this.#opts.onFrame;
      if (onFrame) {
        // The reference hands the header to the same callback as the frames (frames_lost 0, not recovered) and ignores the answer.
        const info: VideoFrameInfo = {
          isHeader: true, frameIndex, framesLost: 0, recovered: false, profileIndex: this.profileCur,
          sliceType: BITSTREAM_SLICE.UNKNOWN, keyFrame: false, fecRecovered: false,
        };
        this.#call(() => onFrame(profile.header, info));
      }
      if (!bitstreamHeader(this.bitstream, profile.header)) this.#log('Failed to parse video header');
    }

    // next frame?
    if (this.frameIndexCur < 0 || seqNum16Gt(frameIndex, this.frameIndexCur & 0xffff)) {
      if (this.packetStats) this.frameProcessor.reportPacketStats(this.packetStats);

      // last frame not flushed yet?
      let ok = true;
      if (this.frameIndexCur >= 0 && this.frameIndexPrev !== this.frameIndexCur) ok = this.#flushFrame();

      if (!ok) this.#log('Video receiver could not flush frame.');

      const nextFrameExpected = (this.frameIndexPrevComplete + 1) & 0xffff;
      if (seqNum16Gt(frameIndex, nextFrameExpected) && !(frameIndex === 1 && this.frameIndexCur < 0)) {
        // ok for frame 1
        this.#log(`Detected missing or corrupt frame(s) from ${nextFrameExpected} to ${frameIndex}`);
        if (!this.#sendCorruptFrame(nextFrameExpected, frameIndex - 1)) this.#log('Error sending corrupt frame.');
      }

      this.frameIndexCur = frameIndex;
      if (this.frameProcessor.allocFrame(packet) !== 'success') this.#log('Video receiver could not allocate frame for packet.');
    }

    if (this.frameProcessor.putUnit(packet) !== 'success') this.#log('Video receiver could not put unit.');

    // if we are currently building up a frame
    if (this.frameIndexCur !== this.frameIndexPrev) {
      // if we already have enough for the whole frame, flush it already
      let ok = true;
      if (this.frameProcessor.flushPossible() || packet.unitIndex === packet.unitsInFrameTotal - 1) ok = this.#flushFrame();
      if (!ok) this.#log('Video receiver could not flush frame.');
    }
  }

  /** chiaki_video_receiver_flush_frame. False where the reference returns an error (the frame could not be completed). */
  #flushFrame(): boolean {
    const { result: flushResult, frame } = this.frameProcessor.flush();

    if (flushResult === FRAME_PROCESSOR_FLUSH_RESULT.FAILED || flushResult === FRAME_PROCESSOR_FLUSH_RESULT.FEC_FAILED) {
      if (flushResult === FRAME_PROCESSOR_FLUSH_RESULT.FEC_FAILED) {
        const nextFrameExpected = (this.frameIndexPrevComplete + 1) & 0xffff;
        this.#sendCorruptFrame(nextFrameExpected, this.frameIndexCur);
        if (this.#opts.enableIdrOnFecFailure) {
          const waitingForIdr = this.getWaitingForIdr();
          let idrRequestSent = waitingForIdr;
          if (!waitingForIdr) {
            idrRequestSent = this.#sendIdrRequest();
            if (idrRequestSent) {
              this.setWaitingForIdr(true);
              this.#log('FEC failed, waiting for IDR frame');
            } else {
              this.#log('FEC failed and IDR request could not be sent');
            }
          } else {
            this.#log('Video FEC failure, already waiting for requested IDR');
            this.#retryIdrRequest();
          }
          const onFecFailure = this.#opts.onFecFailure;
          if (onFecFailure) {
            const event: VideoFecFailureEvent = { frameIndex: this.frameIndexCur, idrRequestSent };
            this.#call(() => onFecFailure(event));
          }
        }
        // A plain difference, as in the reference: wrong when the frame index wrapped around in between.
        const lost = this.frameIndexCur - nextFrameExpected + 1;
        this.framesLost += lost;
        this.framesLostTotal += lost;
        this.frameIndexPrev = this.frameIndexCur;
      }
      this.#log(`Failed to complete frame ${this.frameIndexCur}`);
      return false;
    }

    let succ = true;
    let recovered = false;

    const slice: BitstreamSlice = { sliceType: BITSTREAM_SLICE.UNKNOWN, referenceFrame: 0 };
    const sliceParsed = bitstreamSlice(this.bitstream, frame, slice);
    if (sliceParsed) {
      if (this.getWaitingForIdr()) {
        if (slice.sliceType === BITSTREAM_SLICE.I) {
          this.setWaitingForIdr(false);
          this.#log('Received IDR frame, resuming decode');
        } else {
          this.#log(`Skipping P-frame ${this.frameIndexCur} while waiting for IDR`);
          this.#retryIdrRequest();
          this.frameIndexPrev = this.frameIndexCur;
          return true;
        }
      }

      if (slice.sliceType === BITSTREAM_SLICE.P) {
        const refFrameIndex = (this.frameIndexCur - slice.referenceFrame - 1) & 0xffff;
        if (slice.referenceFrame !== 0xff && !this.#haveRefFrame(refFrameIndex)) {
          for (let i = (slice.referenceFrame + 1) >>> 0; i < 16; i++) {
            const refFrameIndexNew = (this.frameIndexCur - i - 1) & 0xffff;
            if (this.#haveRefFrame(refFrameIndexNew)) {
              if (bitstreamSliceSetReferenceFrame(this.bitstream, frame, i)) {
                recovered = true;
                this.#log(`Missing reference frame ${refFrameIndex} for decoding frame ${this.frameIndexCur} -> changed to ${refFrameIndexNew}`);
              }
              break;
            }
          }
          if (!recovered) {
            succ = false;
            this.framesLost++;
            this.framesLostTotal++;
            this.#log(`Missing reference frame ${refFrameIndex} for decoding frame ${this.frameIndexCur}`);
          }
        }
      }
    }

    const onFrame = this.#opts.onFrame;
    if (succ && onFrame) {
      const info: VideoFrameInfo = {
        isHeader: false, frameIndex: this.frameIndexCur, framesLost: this.framesLost, recovered, profileIndex: this.profileCur,
        sliceType: sliceParsed ? slice.sliceType : BITSTREAM_SLICE.UNKNOWN,
        keyFrame: sliceParsed && slice.sliceType === BITSTREAM_SLICE.I,
        fecRecovered: flushResult === FRAME_PROCESSOR_FLUSH_RESULT.FEC_SUCCESS,
      };
      const cbSucc = this.#call(() => onFrame(frame, info));
      this.framesLost = 0;
      if (!cbSucc) {
        succ = false;
        this.#log('Video callback did not process frame successfully.');
      } else {
        this.#addRefFrame(this.frameIndexCur);
        this.#log(`Added reference ${sliceParsed && slice.sliceType === BITSTREAM_SLICE.I ? 'I' : 'P'} frame ${this.frameIndexCur}`);
      }
    }

    this.frameIndexPrev = this.frameIndexCur;

    if (succ) this.frameIndexPrevComplete = this.frameIndexCur;

    return true;
  }
}
