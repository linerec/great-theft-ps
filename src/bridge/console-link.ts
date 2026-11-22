// SPDX-License-Identifier: AGPL-3.0-only
//
// The one seam between the client/bridge and a console. A link produces video frames and consumes pad state.
// Implementations: Ps5Link (this project's TypeScript port of Remote Play, for a real PlayStation) and CoreLink
// (the native gtp-core process built on libchiaki, for the same). Tests use a test double (test/support/fake-link.ts).

import type { VirtualPadState } from '../engine/types.ts';
import type { QualityRequest } from './quality.ts';
import type { VideoHeader } from './protocol.ts';

export interface LinkFrame {
  header: VideoHeader;
  data: Uint8Array;
}

export interface LinkStatus {
  state: 'connecting' | 'streaming' | 'closed' | 'error';
  detail?: string;
}

/** What the page needs to play the console's sound (Opus). */
export interface LinkAudioHeader {
  channels: number;
  bits: number;
  /** Samples per second. */
  rate: number;
  /** Samples per channel in one Opus frame. */
  frameSize: number;
}

export interface LinkHandlers {
  onVideo(frame: LinkFrame): void;
  onStatus(status: LinkStatus): void;
  /** The sound is Opus; this says how many channels, which rate and how long a frame is. Once, before the first frame. */
  onAudioHeader?(header: LinkAudioHeader): void;
  /** The next Opus frame in order, or null for a frame that was lost (the page conceals it). Optional: a link without sound leaves it out. */
  onAudio?(frame: Uint8Array | null): void;
}

export interface LinkStartOptions {
  /** Which registered console to connect to (12 lower case hex digits). The first one when absent. */
  mac?: string;
  /** Do not let go when another of this project's clients asks for the console (see handover.ts). */
  locked?: boolean;
}

export interface ConsoleLink {
  readonly name: string;
  start(handlers: LinkHandlers, quality: QualityRequest, options?: LinkStartOptions): Promise<void>;
  /** `seq` is the client's PAD sequence number, echoed back in video headers where the source can tell. */
  sendPad(seq: number, state: VirtualPadState): void;
  setQuality(quality: QualityRequest): void;
  /** Change whether this connection lets go when another of this project's clients asks. Links that cannot be asked leave it out. */
  setLocked?(locked: boolean): void;
  requestKeyframe(): void;
  stop(): Promise<void>;
}
