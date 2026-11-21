// SPDX-License-Identifier: AGPL-3.0-only
//
// Decides WHEN the controller state goes to the console: the feedback state when sticks or motion change and at least
// every 200 ms, and one history packet for every button, trigger or touch event.
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/feedbacksender.c and
// lib/include/chiaki/feedbacksender.h (commit 43728af). The choice between the two state layouts by protocol version
// is chiaki_takion_send_feedback_state() in lib/src/takion.c, and the meaning of the event count is
// chiaki_takion_send_feedback_history() there. See NOTICE.md.
//
// How the reference works, and how it is carried over:
// - The reference runs a thread that waits on a condition variable. Here FeedbackSender.tick() is one pass of that
//   thread's loop (everything after the wait), and a replaceable scheduler stands in for the wait. Setting a state
//   never sends by itself, it wakes the loop (delay 0), so several changes made before the loop runs go out as one
//   state packet, as they do when the reference's thread has not woken up yet.
// - Every history event takes the next sequence number and gets a packet of its own, which carries the number of its
//   newest event and repeats up to 8 older events behind it. The console applies only as many events of a packet as
//   the number moved. Packets wait in a queue of 0x40; when it overflows the oldest packet is dropped.
// - History packets are not acknowledged, so the last one is sent again 20, 50, 100 and 200 ms after it went out
//   (same bytes, same number) unless something new was queued in the meantime.
// - Buttons and triggers are not in the feedback state. A change of buttons alone therefore sends NO state packet.
// - The reference defines FEEDBACK_STATE_TIMEOUT_MIN_MS (8) but never uses it ("TODO" in its loop): nothing there
//   limits how often a state packet goes out. The same holds here unless `stateMinIntervalMs` is set.
// - A quirk kept as it is: when a change of buttons alone wakes the loop at the very moment the 200 ms state is due,
//   that state is skipped in this pass and follows with the next wake-up (normally the 20 ms resend).
//
// Not in the reference: `stateMinIntervalMs`, stop({ sendNeutral: true }), copying payloads before handing them to the
// transport, and reporting an exception of the transport through `onError` instead of a log line.
//
// STATUS: checked against tests written from the same reading of the C source, with a fake clock
// (test/feedbacksender.test.ts). The reference has no test for feedbacksender.c. It has NOT been run against a real
// console, and what a console does with these packets is known here only from the reference's comments.

import { cloneControllerState, controllerMotionEquals, controllerStateEquals, createIdleControllerState, type ControllerState } from './controller.ts';
import { FeedbackHistoryBuffer, feedbackStateFormatV12, feedbackStateFormatV9, type FeedbackState } from './feedback.ts';

/** Minimum time between two state packets. Defined by the reference but not used by it; see `stateMinIntervalMs`. */
export const FEEDBACK_STATE_TIMEOUT_MIN_MS = 8;
/** Maximum time between two state packets: the state is repeated this often when nothing changes. */
export const FEEDBACK_STATE_TIMEOUT_MAX_MS = 200;

export const FEEDBACK_HISTORY_BUFFER_SIZE = 0x10;
/** Number of most recent events repeated in every history packet, behind the new one. */
export const FEEDBACK_HISTORY_RESEND_EVENT_COUNT = 0x8;
/** When the newest history packet is sent again, in ms after it went out. */
export const FEEDBACK_HISTORY_TAIL_MS: readonly number[] = [20, 50, 100, 200];

export const FEEDBACK_HISTORY_PACKET_BUF_SIZE = 0x300;
export const FEEDBACK_HISTORY_PACKET_QUEUE_SIZE = 0x40;

/**
 * Where the packets go: the transport. It adds the 12 byte header (type, sequence number, count, key position, GMAC),
 * encrypts and sends.
 */
export interface FeedbackSink {
  /** `payload` is the formatted feedback state: 0x19 bytes for protocol version 9 or lower, 0x1c bytes above. */
  sendFeedbackState(seqNum: number, payload: Uint8Array): void;
  /**
   * `payload` is the events, newest first. `eventCount` is how many there are: the reference's transport writes
   * `eventCount - 1` (0 when the count is 0) into byte 3 of the packet header. A transport that takes only the first
   * two arguments still fits this interface, but then has to find the count some other way.
   */
  sendFeedbackHistory(seqNum: number, payload: Uint8Array, eventCount: number): void;
}

/** Runs `callback` once after `delayMs` (0 means as soon as possible, but not inside the call) and returns a cancel function. */
export type FeedbackSchedule = (callback: () => void, delayMs: number) => () => void;

export interface FeedbackSenderOptions {
  sink: FeedbackSink;
  /** The Takion protocol version of the session: 9 for a PS4, 12 for a PS5 (lib/src/streamconnection.c). */
  protocolVersion: number;
  /** A monotonic clock in milliseconds. Default: performance.now(). */
  now?: () => number;
  /** Default: setImmediate for a delay of 0 and setTimeout otherwise, both unref'd. */
  schedule?: FeedbackSchedule;
  /**
   * Not in the reference. When above 0, a state packet caused by a change is held back until this many ms have passed
   * since the last state packet, and then carries the newest state. History packets are never held back.
   * Default 0: as the reference behaves. FEEDBACK_STATE_TIMEOUT_MIN_MS is the value the reference had in mind.
   */
  stateMinIntervalMs?: number;
  /** Called when the sink throws. The reference logs and carries on; so does this, whether or not a handler is given. */
  onError?: (what: 'state' | 'history', error: unknown) => void;
}

export interface FeedbackSenderStopOptions {
  /**
   * Not in the reference. Before stopping, release everything: set the idle state, send every history packet still
   * queued (including the releases this causes) and one state packet with the sticks centred, all inside the call.
   * Each packet goes out once: there are no resends after stop(), so on a lossy network a release can be lost. While
   * the session stays up, prefer setControllerState(createIdleControllerState()) and keep the sender running.
   */
  sendNeutral?: boolean;
}

interface HistoryPacket {
  payload: Uint8Array;
  eventCount: number;
  seqNum: number;
}

const defaultSchedule: FeedbackSchedule = (callback, delayMs) => {
  if (delayMs <= 0) {
    const immediate = setImmediate(callback);
    immediate.unref();
    return () => clearImmediate(immediate);
  }
  const timeout = setTimeout(callback, delayMs);
  timeout.unref();
  return () => clearTimeout(timeout);
};

/** controller_state_equals_for_feedback_state(): equal in everything the feedback state carries. */
function controllerStateEqualsForFeedbackState(a: ControllerState, b: ControllerState): boolean {
  if (!(a.leftX === b.leftX
    && a.leftY === b.leftY
    && a.rightX === b.rightX
    && a.rightY === b.rightY)) return false;
  return controllerMotionEquals(a, b);
}

/** ChiakiFeedbackSender. It starts when it is created, as chiaki_feedback_sender_init() starts the thread. */
export class FeedbackSender {
  #sink: FeedbackSink;
  #protocolVersion: number;
  #nowFn: () => number;
  #schedule: FeedbackSchedule;
  #stateMinIntervalMs: number;
  #onError: ((what: 'state' | 'history', error: unknown) => void) | undefined;

  #stateSeqNum = 0;
  /** Sequence number the next history event takes; a packet carries the number of its newest event. */
  #historySeqNum = 0;
  #historyBuf = new FeedbackHistoryBuffer(FEEDBACK_HISTORY_BUFFER_SIZE);
  #historyPackets: HistoryPacket[] = [];
  /** Last history packet sent, repeated a few times while nothing new happens. */
  #historyLast: HistoryPacket | null = null;
  #historyLastSentMs = 0;
  #historyTailResends = FEEDBACK_HISTORY_TAIL_MS.length;

  #shouldStop = false;
  /** The state of the last state packet. */
  #controllerStatePrev = createIdleControllerState();
  #controllerStateHistoryPrev = createIdleControllerState();
  #controllerState = createIdleControllerState();
  #controllerStateChanged = false;
  #historyDirty = false;

  #lastFeedbackStateMs: number;
  #cancelWake: (() => void) | null = null;
  /** Identifies the wake-up that is still wanted, so a scheduler that fires a cancelled callback does no harm. */
  #wakeToken: object | null = null;

  constructor(options: FeedbackSenderOptions) {
    if (!Number.isInteger(options.protocolVersion) || options.protocolVersion <= 0) throw new RangeError('protocolVersion must be a positive integer');
    const minInterval = options.stateMinIntervalMs ?? 0;
    if (!(minInterval >= 0) || minInterval > FEEDBACK_STATE_TIMEOUT_MAX_MS) {
      throw new RangeError(`stateMinIntervalMs must be 0..${FEEDBACK_STATE_TIMEOUT_MAX_MS}`);
    }
    this.#sink = options.sink;
    this.#protocolVersion = options.protocolVersion;
    this.#nowFn = options.now ?? (() => performance.now());
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#stateMinIntervalMs = minInterval;
    this.#onError = options.onError;
    this.#lastFeedbackStateMs = this.#now();
    this.#scheduleWake();
  }

  get stopped(): boolean {
    return this.#shouldStop;
  }

  /**
   * chiaki_feedback_sender_set_controller_state(). The state is copied. Nothing is sent inside this call: the events
   * for the change are queued and the loop is woken.
   */
  setControllerState(state: ControllerState): void {
    if (this.#shouldStop) return;
    if (!this.#applyControllerState(state)) return;
    this.#scheduleWake(); // chiaki_cond_signal()
  }

  /**
   * Run the loop now: what the reference's thread does each time its wait returns, repeated while history packets are
   * queued (the reference does not wait in between either). Calling it when nothing is due sends nothing. The
   * scheduler calls this; tests and callers with their own timing may call it directly.
   */
  tick(): void {
    if (this.#shouldStop) return;
    this.#cancel();
    do {
      this.#iterate(false);
    } while (!this.#shouldStop && this.#historyPackets.length > 0);
    if (!this.#shouldStop) this.#scheduleWake();
  }

  /**
   * chiaki_feedback_sender_fini(): nothing is sent after this, packets still queued are dropped as in the reference,
   * and later calls of setControllerState() and tick() do nothing. See FeedbackSenderStopOptions for `sendNeutral`.
   */
  stop(options: FeedbackSenderStopOptions = {}): void {
    if (this.#shouldStop) return;
    this.#cancel();
    if (options.sendNeutral) {
      this.#applyControllerState(createIdleControllerState());
      let forceState = true;
      do {
        this.#iterate(forceState);
        forceState = false;
      } while (!this.#shouldStop && this.#historyPackets.length > 0);
    }
    this.#shouldStop = true;
    this.#cancel();
  }

  /** chiaki_time_now_monotonic_ms(): whole milliseconds. */
  #now(): number {
    return Math.floor(this.#nowFn());
  }

  #cancel(): void {
    this.#wakeToken = null;
    if (this.#cancelWake !== null) {
      const cancel = this.#cancelWake;
      this.#cancelWake = null;
      cancel();
    }
  }

  #scheduleWake(): void {
    this.#cancel();
    const token = {};
    this.#wakeToken = token;
    this.#cancelWake = this.#schedule(() => {
      if (this.#wakeToken !== token) return; // replaced or cancelled in the meantime
      this.tick();
    }, this.#nextTimeout());
  }

  /** How long the reference's thread would wait now (the top of its loop). */
  #nextTimeout(): number {
    if (this.#historyPackets.length > 0) return 0; // the reference does not wait while packets are queued

    const nowMs = this.#now();
    const sinceState = nowMs - this.#lastFeedbackStateMs;
    let nextTimeout = FEEDBACK_STATE_TIMEOUT_MAX_MS;
    if (sinceState < FEEDBACK_STATE_TIMEOUT_MAX_MS) nextTimeout = FEEDBACK_STATE_TIMEOUT_MAX_MS - sinceState;
    // wake up in time for the next tail resend of the last history packet
    if (this.#historyTailResends < FEEDBACK_HISTORY_TAIL_MS.length) {
      const dueMs = this.#historyLastSentMs + FEEDBACK_HISTORY_TAIL_MS[this.#historyTailResends]!;
      const untilDue = dueMs > nowMs ? dueMs - nowMs : 0;
      if (untilDue < nextTimeout) nextTimeout = untilDue;
    }
    // a change ends the wait at once (state_cond_check), or, with a minimum interval, when that has passed
    if (this.#controllerStateChanged) {
      const hold = this.#stateMinIntervalMs > sinceState ? this.#stateMinIntervalMs - sinceState : 0;
      if (hold < nextTimeout) nextTimeout = hold;
    }
    return nextTimeout;
  }

  /** The body of chiaki_feedback_sender_set_controller_state() under its lock. @returns false when nothing changed */
  #applyControllerState(state: ControllerState): boolean {
    if (controllerStateEquals(this.#controllerState, state)) return false;

    this.#controllerState = cloneControllerState(state);
    this.#historyBuf.recordState(this.#controllerStateHistoryPrev, this.#controllerState, () => this.#historyEventPushed());
    this.#controllerStateHistoryPrev = cloneControllerState(this.#controllerState);
    this.#controllerStateChanged = true;
    return true;
  }

  /** feedback_sender_history_event_pushed() */
  #historyEventPushed(): void {
    this.#historySeqNum = (this.#historySeqNum + 1) & 0xffff;
    this.#historyDirty = true;
    this.#flushHistory();
  }

  /** feedback_sender_flush_history_locked(): turn the history buffer into a packet and queue it. */
  #flushHistory(): void {
    if (!this.#historyDirty) return;

    const payload = this.#historyBuf.format(FEEDBACK_HISTORY_PACKET_BUF_SIZE);
    if (payload === null) return; // cannot happen: 16 events of at most 5 bytes
    const eventCount = this.#historyBuf.len & 0xff;
    // the newest event in the packet took the number before the next one
    const seqNum = (this.#historySeqNum - 1) & 0xffff;

    // dropping the oldest queued packet keeps the numbering: the next packet's number still
    // moves by every event since the last packet sent
    if (this.#historyPackets.length >= FEEDBACK_HISTORY_PACKET_QUEUE_SIZE) this.#historyPackets.shift();
    this.#historyPackets.push({ payload, eventCount, seqNum });

    if (this.#historyBuf.len > FEEDBACK_HISTORY_RESEND_EVENT_COUNT) this.#historyBuf.len = FEEDBACK_HISTORY_RESEND_EVENT_COUNT;
    this.#historyDirty = false;
  }

  /**
   * One pass of the loop in feedback_sender_thread_func(), from after the wait to the end.
   * @param forceState send a state packet in this pass whatever else holds (only stop({ sendNeutral }) uses it)
   */
  #iterate(forceState: boolean): void {
    const nowMs = this.#now();
    let sendFeedbackState = nowMs - this.#lastFeedbackStateMs >= FEEDBACK_STATE_TIMEOUT_MAX_MS;
    const stateNow = cloneControllerState(this.#controllerState);
    let historyPacket: HistoryPacket | null = null;

    if (this.#controllerStateChanged) {
      this.#controllerStateChanged = false;
      sendFeedbackState = true;

      // don't need to send feedback state if nothing relevant changed
      if (controllerStateEqualsForFeedbackState(stateNow, this.#controllerStatePrev)) {
        sendFeedbackState = false;
      } else if (nowMs - this.#lastFeedbackStateMs < this.#stateMinIntervalMs) {
        // not in the reference: too soon after the last state packet, try again when the interval has passed
        sendFeedbackState = false;
        this.#controllerStateChanged = true;
      }
    } // else: timeout
    if (forceState) sendFeedbackState = true;

    if (this.#historyPackets.length > 0) {
      historyPacket = this.#historyPackets.shift()!;
      // remember it for tail resends; a new packet restarts the schedule
      this.#historyLast = historyPacket;
      this.#historyLastSentMs = nowMs;
      this.#historyTailResends = 0;
    } else if (this.#historyLast !== null
      && this.#historyTailResends < FEEDBACK_HISTORY_TAIL_MS.length
      && nowMs >= this.#historyLastSentMs + FEEDBACK_HISTORY_TAIL_MS[this.#historyTailResends]!) {
      // nothing new since the last history packet: send it again with the same sequence number
      historyPacket = this.#historyLast;
      this.#historyTailResends++;
    }

    if (sendFeedbackState) this.#sendState(stateNow);
    if (historyPacket !== null) this.#sendHistoryPacket(historyPacket);

    if (sendFeedbackState) {
      this.#controllerStatePrev = stateNow;
      this.#lastFeedbackStateMs = this.#now();
    }
  }

  /** feedback_sender_send_state(), with the formatting chiaki_takion_send_feedback_state() does. */
  #sendState(state: ControllerState): void {
    const feedbackState: FeedbackState = {
      leftX: state.leftX,
      leftY: state.leftY,
      rightX: state.rightX,
      rightY: state.rightY,
      gyroX: state.gyroX,
      gyroY: state.gyroY,
      gyroZ: state.gyroZ,
      accelX: state.accelX,
      accelY: state.accelY,
      accelZ: state.accelZ,
      orientX: state.orientX,
      orientY: state.orientY,
      orientZ: state.orientZ,
      orientW: state.orientW,
    };
    const payload = this.#protocolVersion <= 9 ? feedbackStateFormatV9(feedbackState) : feedbackStateFormatV12(feedbackState);
    const seqNum = this.#stateSeqNum;
    this.#stateSeqNum = (seqNum + 1) & 0xffff;
    try {
      this.#sink.sendFeedbackState(seqNum, payload);
    } catch (error) {
      this.#reportError('state', error);
    }
  }

  /** feedback_sender_send_history_packet(). The transport gets a copy: the same bytes may be sent again later. */
  #sendHistoryPacket(packet: HistoryPacket): void {
    try {
      this.#sink.sendFeedbackHistory(packet.seqNum, Uint8Array.from(packet.payload), packet.eventCount);
    } catch (error) {
      this.#reportError('history', error);
    }
  }

  #reportError(what: 'state' | 'history', error: unknown): void {
    if (this.#onError === undefined) return;
    try {
      this.#onError(what, error);
    } catch {
      // an error handler that throws must not stop the sender
    }
  }
}
