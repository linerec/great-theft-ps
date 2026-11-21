// SPDX-License-Identifier: AGPL-3.0-only
//
// When the controller state goes out (src/console/feedbacksender.ts, from chiaki-ng lib/src/feedbacksender.c and
// lib/include/chiaki/feedbacksender.h, commit 43728af).
//
// The reference has no test for feedbacksender.c. Every expectation here was worked out from its thread loop by the
// same reading that produced the port, and runs on a fake clock against a recording transport: it shows that the port
// does what that reading says, not that a console agrees.
//
// STATUS: checked against these self-made tests only. Never run against a real console.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONTROLLER_BUTTON, controllerStateFromPad, controllerStateStartTouch, createIdleControllerState, type ControllerState,
} from '../src/console/controller.ts';
import { FEEDBACK_STATE_BUF_SIZE_V12, FEEDBACK_STATE_BUF_SIZE_V9 } from '../src/console/feedback.ts';
import {
  FEEDBACK_HISTORY_BUFFER_SIZE, FEEDBACK_HISTORY_PACKET_BUF_SIZE, FEEDBACK_HISTORY_PACKET_QUEUE_SIZE, FEEDBACK_HISTORY_RESEND_EVENT_COUNT,
  FEEDBACK_HISTORY_TAIL_MS, FEEDBACK_STATE_TIMEOUT_MAX_MS, FEEDBACK_STATE_TIMEOUT_MIN_MS, FeedbackSender,
  type FeedbackSchedule, type FeedbackSenderOptions, type FeedbackSink,
} from '../src/console/feedbacksender.ts';
import { BUTTON, emptyPadState } from '../src/engine/types.ts';

/** 0xa0, gyro (0, 0, 0), accelerometer (0, 1, 0) and the identity orientation, as test/feedback.test.ts works them out. */
const MOTION_AT_REST = ['a0', 'ff7f', 'ff7f', 'ff7f', 'ff7f', '9999', 'ff7f', 'fef7ef1f'].join('');
const int16be = (v: number): string => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(v);
  return b.toString('hex');
};
/** The feedback state with the controller at rest except for the sticks, in the PS5 layout unless told otherwise. */
const stateHex = (leftX: number, leftY: number, rightX: number, rightY: number, ps5 = true): string =>
  MOTION_AT_REST + int16be(leftX) + int16be(leftY) + int16be(rightX) + int16be(rightY) + (ps5 ? '000001' : '');
const IDLE_V9 = stateHex(0, 0, 0, 0, false);
const IDLE_V12 = stateHex(0, 0, 0, 0);

interface Sent {
  kind: 'state' | 'history';
  at: number;
  seq: number;
  hex: string;
  count?: number;
}

interface FakeTimer {
  at: number;
  order: number;
  callback: () => void;
}

/** A clock that only moves when told to, and the timers that hang on it. */
function fakeClock() {
  let t = 0;
  let order = 0;
  let timers: FakeTimer[] = [];
  const now = (): number => t;
  const schedule: FeedbackSchedule = (callback, delayMs) => {
    const timer: FakeTimer = { at: t + Math.max(0, delayMs), order: order++, callback };
    timers.push(timer);
    return () => {
      timers = timers.filter((x) => x !== timer);
    };
  };
  /** Move the clock forward, running every timer that comes due on the way, in order. */
  const advance = (ms: number): void => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.order - b.order)[0];
      if (due === undefined) break;
      timers = timers.filter((x) => x !== due);
      t = Math.max(t, due.at);
      due.callback();
    }
    t = end;
  };
  /** Move the clock forward WITHOUT running timers, as when the event loop is busy; advance(0) then runs what is overdue. */
  const jump = (ms: number): void => {
    t += ms;
  };
  return { now, schedule, advance, jump, pending: (): number => timers.length };
}

function setup(options: Partial<FeedbackSenderOptions> = {}) {
  const clock = fakeClock();
  const sent: Sent[] = [];
  const sink: FeedbackSink = {
    sendFeedbackState(seqNum, payload) {
      sent.push({ kind: 'state', at: clock.now(), seq: seqNum, hex: Buffer.from(payload).toString('hex') });
    },
    sendFeedbackHistory(seqNum, payload, eventCount) {
      sent.push({ kind: 'history', at: clock.now(), seq: seqNum, hex: Buffer.from(payload).toString('hex'), count: eventCount });
    },
  };
  const sender = new FeedbackSender({ sink, protocolVersion: 12, now: clock.now, schedule: clock.schedule, ...options });
  /** What went out since the last call. */
  const take = (): Sent[] => sent.splice(0, sent.length);
  return { clock, sender, sent, take };
}

const pressed = (...buttons: number[]): ControllerState => {
  const state = createIdleControllerState();
  for (const b of buttons) state.buttons |= b;
  return state;
};
const state = (at: number, seq: number, hex: string): Sent => ({ kind: 'state', at, seq, hex });
const history = (at: number, seq: number, hex: string, count: number): Sent => ({ kind: 'history', at, seq, hex, count });

describe('feedback sender: constants of feedbacksender.c and feedbacksender.h', () => {
  it('are the reference values', () => {
    assert.equal(FEEDBACK_STATE_TIMEOUT_MIN_MS, 8);
    assert.equal(FEEDBACK_STATE_TIMEOUT_MAX_MS, 200);
    assert.equal(FEEDBACK_HISTORY_BUFFER_SIZE, 0x10);
    assert.equal(FEEDBACK_HISTORY_RESEND_EVENT_COUNT, 0x8);
    assert.deepEqual([...FEEDBACK_HISTORY_TAIL_MS], [20, 50, 100, 200]);
    assert.equal(FEEDBACK_HISTORY_PACKET_BUF_SIZE, 0x300);
    assert.equal(FEEDBACK_HISTORY_PACKET_QUEUE_SIZE, 0x40);
  });
});

describe('feedback sender: a button press', () => {
  it('queues a history event; nothing goes out inside setControllerState', () => {
    const { clock, sender, take } = setup();
    sender.setControllerState(pressed(CONTROLLER_BUTTON.cross));
    assert.deepEqual(take(), [], 'the loop has not run yet');
    clock.advance(0);
    assert.deepEqual(take(), [history(0, 0, '8088ff', 1)]);
  });

  it('sends no state packet by itself: buttons are not part of the state (as in the reference)', () => {
    const { clock, sender, take } = setup();
    clock.advance(30);
    sender.setControllerState(pressed(CONTROLLER_BUTTON.cross));
    clock.advance(0);
    assert.deepEqual(take(), [history(30, 0, '8088ff', 1)]);
    clock.advance(1);
    assert.deepEqual(take(), []);
  });

  it('is repeated 20, 50, 100 and 200 ms later with the same number, and the state follows at the keep-alive', () => {
    const { clock, sender, take } = setup();
    sender.setControllerState(pressed(CONTROLLER_BUTTON.cross));
    clock.advance(0);
    take();
    clock.advance(19);
    assert.deepEqual(take(), []);
    clock.advance(181);
    assert.deepEqual(take(), [
      history(20, 0, '8088ff', 1),
      history(50, 0, '8088ff', 1),
      history(100, 0, '8088ff', 1),
      state(200, 0, IDLE_V12), // the reference sends the state before the history packet of the same pass
      history(200, 0, '8088ff', 1),
    ]);
    clock.advance(2000);
    assert.deepEqual(take().filter((p) => p.kind === 'history'), [], 'four resends, then no more');
  });

  it('a press together with a stick movement sends the state and the event at once, state first', () => {
    const { clock, sender, take } = setup();
    clock.advance(10);
    const s = pressed(CONTROLLER_BUTTON.cross);
    s.leftX = 0x1234;
    sender.setControllerState(s);
    clock.advance(0);
    assert.deepEqual(take(), [
      state(10, 0, stateHex(0x1234, 0, 0, 0)),
      history(10, 0, '8088ff', 1),
    ]);
  });

  it('the release carries the press behind it: newest first, the number of the newest', () => {
    const { clock, sender, take } = setup();
    sender.setControllerState(pressed(CONTROLLER_BUTTON.cross));
    clock.advance(5);
    sender.setControllerState(createIdleControllerState());
    clock.advance(0);
    assert.deepEqual(take(), [history(0, 0, '8088ff', 1), history(5, 1, '8088008088ff', 2)]);
    // the resend schedule starts again from the newest packet
    clock.advance(20);
    assert.deepEqual(take(), [history(25, 1, '8088008088ff', 2)]);
  });

  it('works from a VirtualPadState', () => {
    const { clock, sender, take } = setup();
    const pad = emptyPadState();
    pad.buttons = BUTTON.options | BUTTON.dpad_left;
    pad.r2 = 255;
    pad.rightX = -1;
    sender.setControllerState(controllerStateFromPad(pad));
    clock.advance(0);
    assert.deepEqual(take(), [
      state(0, 0, stateHex(0, 0, -32767, 0)),
      history(0, 0, '8082ff', 1), // dpad left (bit 4)
      history(0, 1, '80ac8082ff', 2), // options (bit 12)
      history(0, 2, '8087ff80ac8082ff', 3), // R2
    ]);
  });

  it('a trigger sends its value with every change', () => {
    const { clock, sender, take } = setup();
    const s = createIdleControllerState();
    s.l2State = 0x80;
    sender.setControllerState(s);
    clock.advance(0);
    s.l2State = 0xff;
    sender.setControllerState(s);
    clock.advance(0);
    assert.deepEqual(take(), [history(0, 0, '808680', 1), history(0, 1, '8086ff808680', 2)]);
  });

  it('the same state again does nothing', () => {
    const { clock, sender, take } = setup();
    const s = pressed(CONTROLLER_BUTTON.moon);
    sender.setControllerState(s);
    clock.advance(0);
    take();
    const pendingBefore = clock.pending();
    sender.setControllerState(pressed(CONTROLLER_BUTTON.moon));
    assert.equal(clock.pending(), pendingBefore);
    clock.advance(1);
    assert.deepEqual(take(), []);
  });

  it('copies the state it is given', () => {
    const { clock, sender, take } = setup();
    const s = pressed(CONTROLLER_BUTTON.cross);
    sender.setControllerState(s);
    s.buttons = 0; // the caller reuses its object
    s.leftX = 99;
    clock.advance(0);
    assert.deepEqual(take(), [history(0, 0, '8088ff', 1)]);
    sender.setControllerState(s);
    clock.advance(0);
    assert.deepEqual(take().map((p) => p.kind), ['state', 'history'], 'the change is still seen');
  });
});

describe('feedback sender: touches', () => {
  it('a finger down, moving and up gives one event each', () => {
    const { clock, sender, take } = setup();
    const s = createIdleControllerState();
    const id = controllerStateStartTouch(s, 100, 200);
    sender.setControllerState(s);
    clock.advance(0);
    s.touches[0]!.x = 101;
    sender.setControllerState(s);
    clock.advance(0);
    s.touches[0]!.id = -1;
    sender.setControllerState(s);
    clock.advance(0);
    assert.equal(id, 0);
    assert.deepEqual(take(), [
      history(0, 0, 'd0000640c8', 1),
      history(0, 1, 'd0000650c8d0000640c8', 2),
      history(0, 2, 'c0000650c8d0000650c8d0000640c8', 3),
    ]);
  });
});

describe('feedback sender: keep-alive', () => {
  it('holding nothing still sends the state every 200 ms (PS5 layout, 0x1c bytes)', () => {
    const { clock, take } = setup();
    clock.advance(199);
    assert.deepEqual(take(), []);
    clock.advance(1);
    assert.deepEqual(take(), [state(200, 0, IDLE_V12)]);
    clock.advance(800);
    assert.deepEqual(take(), [state(400, 1, IDLE_V12), state(600, 2, IDLE_V12), state(800, 3, IDLE_V12), state(1000, 4, IDLE_V12)]);
    assert.equal(IDLE_V12.length / 2, FEEDBACK_STATE_BUF_SIZE_V12);
  });

  it('protocol version 9 and lower gets the PS4 layout (0x19 bytes), anything above the PS5 one', () => {
    for (const [version, expected] of [[9, IDLE_V9], [7, IDLE_V9], [10, IDLE_V12], [12, IDLE_V12]] as Array<[number, string]>) {
      const { clock, take } = setup({ protocolVersion: version });
      clock.advance(200);
      assert.deepEqual(take(), [state(200, 0, expected)], `version ${version}`);
    }
    assert.equal(IDLE_V9.length / 2, FEEDBACK_STATE_BUF_SIZE_V9);
  });

  it('repeats the current state, counted from the last state packet', () => {
    const { clock, sender, take } = setup();
    clock.advance(50);
    const s = createIdleControllerState();
    s.rightY = -32768;
    sender.setControllerState(s);
    clock.advance(0);
    const held = stateHex(0, 0, 0, -32768);
    assert.deepEqual(take(), [state(50, 0, held)]);
    clock.advance(199);
    assert.deepEqual(take(), []);
    clock.advance(1);
    assert.deepEqual(take(), [state(250, 1, held)]);
    clock.advance(200);
    assert.deepEqual(take(), [state(450, 2, held)]);
  });

  it('a motion change is a state change', () => {
    const { clock, sender, take } = setup();
    const s = createIdleControllerState();
    s.gyroX = 15;
    sender.setControllerState(s);
    clock.advance(0);
    // 15 rad/s is three quarters of the range: 0xbfff, little endian, in the first gyro field
    assert.deepEqual(take(), [state(0, 0, IDLE_V12.replace(/^a0ff7f/, 'a0ffbf'))]);
  });

  it('as in the reference: a button-only change that wakes the loop when the keep-alive is due delays it to the next wake-up', () => {
    const { clock, sender, take } = setup();
    clock.jump(200); // the keep-alive is due, but the change gets in before the timer runs
    sender.setControllerState(pressed(CONTROLLER_BUTTON.box));
    clock.advance(0);
    assert.deepEqual(take(), [history(200, 0, '808aff', 1)], 'no state in this pass');
    clock.advance(19);
    assert.deepEqual(take(), []);
    clock.advance(1);
    assert.deepEqual(take(), [state(220, 0, IDLE_V12), history(220, 0, '808aff', 1)], 'it follows with the first resend');
    clock.advance(200);
    assert.deepEqual(take().filter((p) => p.kind === 'state'), [state(420, 1, IDLE_V12)]);
  });

  it('a late timer does not send twice: the keep-alive is counted from when the state really went out', () => {
    const { clock, take } = setup();
    clock.jump(260); // the event loop was busy for 60 ms past the keep-alive
    clock.advance(0);
    assert.deepEqual(take(), [state(260, 0, IDLE_V12)]);
    clock.advance(199);
    assert.deepEqual(take(), []);
    clock.advance(1);
    assert.deepEqual(take(), [state(460, 1, IDLE_V12)]);
  });

  it('a timer that fires early sends nothing and waits for the rest', () => {
    const { clock, sender, take } = setup();
    clock.advance(150);
    sender.tick(); // as if the timer had fired 50 ms early
    assert.deepEqual(take(), []);
    clock.advance(49);
    assert.deepEqual(take(), []);
    clock.advance(1);
    assert.deepEqual(take(), [state(200, 0, IDLE_V12)]);
  });
});

describe('feedback sender: rapid changes', () => {
  const withStick = (x: number): ControllerState => {
    const s = createIdleControllerState();
    s.leftX = x;
    return s;
  };
  const stickHex = (x: number): string => stateHex(x, 0, 0, 0);

  it('changes made before the loop runs go out as one state packet with the newest values', () => {
    const { clock, sender, take } = setup();
    for (let x = 1; x <= 10; x++) sender.setControllerState(withStick(x * 100));
    assert.equal(clock.pending(), 1, 'one wake-up, not ten');
    clock.advance(0);
    assert.deepEqual(take(), [state(0, 0, stickHex(1000))]);
  });

  it('a stick that returns to where the last packet had it sends nothing', () => {
    const { clock, sender, take } = setup();
    sender.setControllerState(withStick(500));
    sender.setControllerState(withStick(0));
    clock.advance(0);
    assert.deepEqual(take(), []);
  });

  it('as in the reference there is no minimum interval: FEEDBACK_STATE_TIMEOUT_MIN_MS is defined but not applied', () => {
    const { clock, sender, take } = setup();
    for (let i = 1; i <= 5; i++) {
      sender.setControllerState(withStick(i));
      clock.advance(1); // one loop pass per millisecond
    }
    assert.deepEqual(take(), [1, 2, 3, 4, 5].map((i) => state(i - 1, i - 1, stickHex(i))));
  });

  it('with stateMinIntervalMs (not in the reference) state packets are at least that far apart and carry the newest state', () => {
    const { clock, sender, take } = setup({ stateMinIntervalMs: FEEDBACK_STATE_TIMEOUT_MIN_MS });
    clock.advance(100);
    sender.setControllerState(withStick(1));
    clock.advance(0);
    assert.deepEqual(take(), [state(100, 0, stickHex(1))], 'long after the last one: at once');
    for (let i = 2; i <= 7; i++) {
      clock.advance(1);
      sender.setControllerState(withStick(i)); // at 101..106
    }
    assert.deepEqual(take(), []);
    clock.advance(2);
    assert.deepEqual(take(), [state(108, 1, stickHex(7))]);
    clock.advance(7);
    sender.setControllerState(withStick(8)); // at 115
    clock.advance(1);
    assert.deepEqual(take(), [state(116, 2, stickHex(8))]);
    clock.advance(200);
    assert.deepEqual(take(), [state(316, 3, stickHex(8))], 'the keep-alive is unaffected');
  });

  it('with stateMinIntervalMs history packets are still sent at once', () => {
    const { clock, sender, take } = setup({ stateMinIntervalMs: 8 });
    clock.advance(100);
    sender.setControllerState(withStick(1));
    clock.advance(1);
    take();
    const s = withStick(2);
    s.buttons = CONTROLLER_BUTTON.cross;
    sender.setControllerState(s); // at 101
    clock.advance(0);
    assert.deepEqual(take(), [history(101, 0, '8088ff', 1)]);
    clock.advance(7);
    assert.deepEqual(take(), [state(108, 1, stickHex(2))]);
  });

  it('every event gets a packet of its own, numbered in order, all sent in one pass', () => {
    const { clock, sender, take } = setup();
    const s = createIdleControllerState();
    s.l2State = 0xff;
    s.r2State = 0xff;
    sender.setControllerState(s);
    clock.advance(0);
    assert.deepEqual(take(), [history(0, 0, '8086ff', 1), history(0, 1, '8087ff8086ff', 2)]);
  });

  it('a packet repeats at most the 8 events before its own', () => {
    const { clock, sender, take } = setup();
    const packets: Sent[] = [];
    for (let i = 0; i < 12; i++) {
      sender.setControllerState(i % 2 === 0 ? pressed(CONTROLLER_BUTTON.cross) : createIdleControllerState());
      clock.advance(0);
      packets.push(...take());
    }
    assert.deepEqual(packets.map((p) => p.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(packets.map((p) => p.count), [1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 9]);
    assert.equal(packets[11]!.hex, '808800' + '8088ff808800'.repeat(4), 'the release of the 12th change first, then 8 older events');
    assert.equal(packets[11]!.hex.length / 2, (1 + FEEDBACK_HISTORY_RESEND_EVENT_COUNT) * 3);
  });

  it('more than 0x40 events before the loop runs: the oldest packets are dropped, the numbering goes on', () => {
    const { clock, sender, take } = setup();
    const total = FEEDBACK_HISTORY_PACKET_QUEUE_SIZE + 6;
    for (let i = 0; i < total; i++) sender.setControllerState(i % 2 === 0 ? pressed(CONTROLLER_BUTTON.cross) : createIdleControllerState());
    clock.advance(0);
    const packets = take();
    assert.equal(packets.length, FEEDBACK_HISTORY_PACKET_QUEUE_SIZE);
    assert.ok(packets.every((p) => p.kind === 'history'));
    assert.deepEqual(packets.map((p) => p.seq), Array.from({ length: FEEDBACK_HISTORY_PACKET_QUEUE_SIZE }, (_, i) => i + 6));
    assert.equal(packets.at(-1)!.count, 9);
    // only the newest one is repeated afterwards
    clock.advance(20);
    assert.deepEqual(take().map((p) => [p.kind, p.seq]), [['history', total - 1]]);
  });

  it('sequence numbers are 16 bit and wrap', () => {
    const { clock, sender, take } = setup();
    let last: Sent | undefined;
    for (let i = 0; i < 0x10002; i++) {
      const s = i % 2 === 0 ? pressed(CONTROLLER_BUTTON.cross) : createIdleControllerState();
      s.leftX = (i % 2) + 1; // a state packet with every change as well
      sender.setControllerState(s);
      clock.advance(0);
      const out = take();
      assert.equal(out.length, 2);
      assert.equal(out[0]!.kind, 'state');
      assert.equal(out[0]!.seq, i & 0xffff);
      assert.equal(out[1]!.kind, 'history');
      assert.equal(out[1]!.seq, i & 0xffff);
      last = out[1];
    }
    assert.equal(last!.seq, 1);
  });
});

describe('feedback sender: stop', () => {
  it('stops everything: no resend, no keep-alive, no effect of later calls', () => {
    const { clock, sender, take } = setup();
    sender.setControllerState(pressed(CONTROLLER_BUTTON.cross));
    clock.advance(0);
    assert.equal(take().length, 1);
    assert.equal(sender.stopped, false);
    sender.stop();
    assert.equal(sender.stopped, true);
    assert.equal(clock.pending(), 0, 'no timer left behind');
    clock.advance(10_000);
    sender.setControllerState(pressed(CONTROLLER_BUTTON.moon));
    sender.tick();
    clock.advance(10_000);
    assert.deepEqual(take(), []);
    assert.equal(clock.pending(), 0);
    sender.stop(); // twice is fine
    sender.stop({ sendNeutral: true }); // and sends nothing once stopped
    assert.deepEqual(take(), []);
  });

  it('drops what was queued but not sent yet, as the reference does', () => {
    const { clock, sender, take } = setup();
    sender.setControllerState(pressed(CONTROLLER_BUTTON.cross));
    sender.stop();
    clock.advance(1000);
    assert.deepEqual(take(), []);
  });

  it('with sendNeutral releases every button, trigger and touch and centres the sticks, inside the call', () => {
    const { clock, sender, take } = setup();
    const s = pressed(CONTROLLER_BUTTON.cross, CONTROLLER_BUTTON.l1);
    s.l2State = 200;
    s.leftX = 1000;
    s.gyroZ = 3;
    controllerStateStartTouch(s, 100, 200);
    sender.setControllerState(s);
    clock.advance(3);
    assert.deepEqual(take().map((p) => [p.kind, p.seq]), [['state', 0], ['history', 0], ['history', 1], ['history', 2], ['history', 3]]);

    sender.stop({ sendNeutral: true });
    const out = take();
    assert.deepEqual(out, [
      state(3, 1, IDLE_V12),
      history(3, 4, '808800' + '8086c8' + '8084ff' + '8088ff' + 'd0000640c8', 5), // cross up
      history(3, 5, '808400' + '808800' + '8086c8' + '8084ff' + '8088ff' + 'd0000640c8', 6), // L1 up
      history(3, 6, 'c0000640c8' + '808400' + '808800' + '8086c8' + '8084ff' + '8088ff' + 'd0000640c8', 7), // touch up
      history(3, 7, '808600' + 'c0000640c8' + '808400' + '808800' + '8086c8' + '8084ff' + '8088ff' + 'd0000640c8', 8), // L2 to 0
    ]);
    assert.equal(sender.stopped, true);
    assert.equal(clock.pending(), 0);
    clock.advance(10_000);
    assert.deepEqual(take(), [], 'nothing after it, not even resends');
  });

  it('with sendNeutral also sends what was still waiting, in order', () => {
    const { sender, take } = setup();
    sender.setControllerState(pressed(CONTROLLER_BUTTON.cross)); // queued, the loop has not run
    sender.stop({ sendNeutral: true });
    assert.deepEqual(take(), [
      state(0, 0, IDLE_V12),
      history(0, 0, '8088ff', 1),
      history(0, 1, '8088008088ff', 2),
    ]);
  });

  it('with sendNeutral and nothing held sends exactly one idle state', () => {
    const { clock, sender, take } = setup({ protocolVersion: 9 });
    clock.advance(7);
    sender.stop({ sendNeutral: true });
    assert.deepEqual(take(), [state(7, 0, IDLE_V9)]);
  });
});

describe('feedback sender: the transport', () => {
  it('gets its own copy of every payload: changing one does not change a resend', () => {
    const clock = fakeClock();
    const seen: string[] = [];
    const sink: FeedbackSink = {
      sendFeedbackState(_seqNum, payload) {
        payload.fill(0);
      },
      sendFeedbackHistory(_seqNum, payload) {
        seen.push(Buffer.from(payload).toString('hex'));
        payload.fill(0xee); // for instance a transport that encrypts in place
      },
    };
    const sender = new FeedbackSender({ sink, protocolVersion: 12, now: clock.now, schedule: clock.schedule });
    sender.setControllerState(pressed(CONTROLLER_BUTTON.cross));
    clock.advance(200);
    sender.stop();
    assert.deepEqual(seen, ['8088ff', '8088ff', '8088ff', '8088ff', '8088ff']);
  });

  it('a transport that takes two arguments for history fits the interface', () => {
    const clock = fakeClock();
    const calls: Array<[number, number]> = [];
    const sink: FeedbackSink = {
      sendFeedbackState(): void {},
      sendFeedbackHistory(seqNum: number, payload: Uint8Array): void {
        calls.push([seqNum, payload.length]);
      },
    };
    const sender = new FeedbackSender({ sink, protocolVersion: 12, now: clock.now, schedule: clock.schedule });
    sender.setControllerState(pressed(CONTROLLER_BUTTON.ps));
    clock.advance(0);
    sender.stop();
    assert.deepEqual(calls, [[0, 2]]);
  });

  it('an exception of the transport is reported and does not stop the sender', () => {
    const clock = fakeClock();
    const errors: Array<[string, string]> = [];
    let fail = true;
    let delivered = 0;
    const sink: FeedbackSink = {
      sendFeedbackState() {
        if (fail) throw new Error('socket closed');
        delivered++;
      },
      sendFeedbackHistory() {
        if (fail) throw new Error('socket closed');
        delivered++;
      },
    };
    const sender = new FeedbackSender({
      sink, protocolVersion: 12, now: clock.now, schedule: clock.schedule,
      onError: (what, error) => errors.push([what, (error as Error).message]),
    });
    const s = pressed(CONTROLLER_BUTTON.cross);
    s.leftX = 1;
    sender.setControllerState(s);
    clock.advance(0);
    assert.deepEqual(errors, [['state', 'socket closed'], ['history', 'socket closed']]);
    fail = false;
    clock.advance(20);
    assert.equal(delivered, 1, 'the resend of the history packet');
    sender.stop();

    // without a handler the exception is swallowed, as the reference only logs
    const quiet = new FeedbackSender({ sink: { sendFeedbackState() { throw new Error('x'); }, sendFeedbackHistory() { throw new Error('x'); } }, protocolVersion: 12, now: clock.now, schedule: clock.schedule });
    quiet.setControllerState(s);
    assert.doesNotThrow(() => clock.advance(500));
    quiet.stop();
  });

  it('tick() can drive the sender without the scheduler', () => {
    let t = 0;
    const sent: string[] = [];
    const sender = new FeedbackSender({
      sink: {
        sendFeedbackState: (seq) => void sent.push(`state ${seq}`),
        sendFeedbackHistory: (seq, payload, count) => void sent.push(`history ${seq} ${Buffer.from(payload).toString('hex')} ${count}`),
      },
      protocolVersion: 12,
      now: () => t,
      schedule: () => () => {}, // never calls back
    });
    sender.tick();
    assert.deepEqual(sent, [], 'nothing is due');
    sender.setControllerState(pressed(CONTROLLER_BUTTON.r3));
    sender.tick();
    assert.deepEqual(sent, ['history 0 80b0 1']);
    sender.tick();
    assert.deepEqual(sent, ['history 0 80b0 1'], 'a second call sends nothing new');
    t = 200;
    sender.tick();
    assert.deepEqual(sent, ['history 0 80b0 1', 'state 0', 'history 0 80b0 1']);
    sender.stop();
  });

  it('refuses options that make no sense', () => {
    const sink: FeedbackSink = { sendFeedbackState() {}, sendFeedbackHistory() {} };
    const never: FeedbackSchedule = () => () => {};
    assert.throws(() => new FeedbackSender({ sink, protocolVersion: 0, schedule: never }), RangeError);
    assert.throws(() => new FeedbackSender({ sink, protocolVersion: 12.5, schedule: never }), RangeError);
    assert.throws(() => new FeedbackSender({ sink, protocolVersion: 12, schedule: never, stateMinIntervalMs: -1 }), RangeError);
    assert.throws(() => new FeedbackSender({ sink, protocolVersion: 12, schedule: never, stateMinIntervalMs: 201 }), RangeError);
    assert.throws(() => new FeedbackSender({ sink, protocolVersion: 12, schedule: never, stateMinIntervalMs: Number.NaN }), RangeError);
  });
});

describe('feedback sender: with the real clock and timers (no waiting)', () => {
  it('a change goes out on the next turn of the event loop, and stop() leaves no timer running', async () => {
    const sent: string[] = [];
    const sender = new FeedbackSender({
      sink: {
        sendFeedbackState: () => void sent.push('state'),
        sendFeedbackHistory: (seq, payload) => void sent.push(`history ${seq} ${Buffer.from(payload).toString('hex')}`),
      },
      protocolVersion: 12,
    });
    sender.setControllerState(pressed(CONTROLLER_BUTTON.pyramid));
    assert.deepEqual(sent, []);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, ['history 0 808bff']);
    sender.stop({ sendNeutral: true });
    assert.deepEqual(sent, ['history 0 808bff', 'state', 'history 1 808b00808bff']);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 3);
  });
});
