// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { setLang, t } from '../src/i18n/index.ts';
import {
  captureName, DEFAULT_LOOK, describeClosed, formatClock, HudVisibility, initialOf, lookFilter, pickClipFormat, QUALITY_TEXT, rateConnection, readLook, Series, timeLeft, warningsCrossed, warningText,
} from '../web/player-logic.ts';

/** Runs `body` with the page in Korean, and puts English back whatever happens. */
function inKorean(body: () => void): void {
  setLang('ko');
  try {
    body();
  } finally {
    setLang('en');
  }
}

describe('the controls over the picture (HudVisibility)', () => {
  it('are not there before there is a picture', () => {
    const h = new HudVisibility(1000);
    h.poke(0);
    assert.equal(h.visible(10), false);
  });

  it('show when the picture starts, and hide after the quiet time', () => {
    const h = new HudVisibility(1000);
    h.setLive(true, 100);
    assert.equal(h.visible(100), true);
    assert.equal(h.visible(1099), true);
    assert.equal(h.visible(1100), false);
  });

  it('come back with every movement and stay while it goes on', () => {
    const h = new HudVisibility(1000);
    h.setLive(true, 0);
    h.poke(900);
    assert.equal(h.visible(1500), true);
    assert.equal(h.visible(1900), false);
  });

  it('stay while the pointer is on them or a panel is open', () => {
    const h = new HudVisibility(1000);
    h.setLive(true, 0);
    h.hovering = true;
    assert.equal(h.visible(60_000), true);
    h.hovering = false;
    h.panelOpen = true;
    assert.equal(h.visible(60_000), true);
    h.panelOpen = false;
    assert.equal(h.visible(60_000), false);
  });

  it('are hidden while the mouse is captured by the game, whatever else is true', () => {
    const h = new HudVisibility(1000);
    h.setLive(true, 0);
    h.setLocked(true, 10);
    h.hovering = true;
    h.panelOpen = true;
    h.poke(20);
    assert.equal(h.visible(30), false);
  });

  it('come back at once when the mouse is let go, even after a long time locked', () => {
    const h = new HudVisibility(1000);
    h.setLive(true, 0);
    h.setLocked(true, 10);
    assert.equal(h.visible(600_000), false);
    h.setLocked(false, 600_000);
    assert.equal(h.visible(600_001), true);
    assert.equal(h.visible(601_001), false);
  });

  it('go away when the connection ends', () => {
    const h = new HudVisibility(1000);
    h.setLive(true, 0);
    h.hovering = true;
    h.setLive(false, 5);
    assert.equal(h.visible(6), false);
  });
});

describe('rateConnection', () => {
  const ok = { fps: 60, wantFps: 60, rttMs: 12, hitchesLast10s: 0 };
  it('is great when it is smooth and close', () => assert.equal(rateConnection(ok), 'great'));
  it('is none with no frames', () => assert.equal(rateConnection({ ...ok, fps: 0 }), 'none'));
  it('gets worse with delay', () => {
    assert.equal(rateConnection({ ...ok, rttMs: 50 }), 'good');
    assert.equal(rateConnection({ ...ok, rttMs: 100 }), 'fair');
    assert.equal(rateConnection({ ...ok, rttMs: 200 }), 'poor');
  });
  it('gets worse with stutter', () => {
    assert.equal(rateConnection({ ...ok, hitchesLast10s: 1 }), 'good');
    assert.equal(rateConnection({ ...ok, hitchesLast10s: 3 }), 'fair');
    assert.equal(rateConnection({ ...ok, hitchesLast10s: 6 }), 'poor');
  });
  it('gets worse with frames that do not arrive', () => {
    assert.equal(rateConnection({ ...ok, fps: 45 }), 'fair'); // 75 %
    assert.equal(rateConnection({ ...ok, fps: 25 }), 'poor'); // 42 %
    assert.equal(rateConnection({ ...ok, fps: 54 }), 'great'); // 90 %: a frame or two short is not worth a word
  });
  it('does not judge the frame rate when the wanted one is not known', () => {
    assert.equal(rateConnection({ ...ok, wantFps: 0, fps: 20 }), 'great');
  });
  it('has a word for each rating, in the language of the page when it is shown', () => {
    assert.deepEqual(Object.values(QUALITY_TEXT).map((w) => t(w)), ['Excellent', 'Good', 'Fair', 'Poor', 'No signal']);
    inKorean(() => assert.deepEqual(Object.values(QUALITY_TEXT).map((w) => t(w)), ['매우 좋음', '좋음', '보통', '나쁨', '신호 없음']));
  });
});

describe('Series', () => {
  it('keeps the last values, oldest first', () => {
    const s = new Series(3);
    for (const v of [1, 2, 3, 4, 5]) s.push(v);
    assert.deepEqual([...s.values], [3, 4, 5]);
    assert.equal(s.last, 5);
    assert.equal(s.max, 5);
    assert.equal(s.sumLast(2), 9);
    s.clear();
    assert.equal(s.last, 0);
    assert.equal(s.max, 0);
  });
});

describe('formatClock', () => {
  it('writes minutes and seconds, and hours when there are some', () => {
    assert.equal(formatClock(5), '0:05');
    assert.equal(formatClock(754), '12:34');
    assert.equal(formatClock(3723), '1:02:03');
    assert.equal(formatClock(-4), '0:00');
    assert.equal(formatClock(59.9), '0:59');
  });
});

describe('captureName', () => {
  it('is the person\'s own date and time, with the extension', () => {
    assert.equal(captureName(new Date(2026, 10, 24, 9, 5, 7), 'png'), 'gtp-20261124-090507.png');
    assert.equal(captureName(new Date(2026, 0, 2, 23, 59, 0), 'webm'), 'gtp-20260102-235900.webm');
  });
});

describe('pickClipFormat', () => {
  it('takes the first format the browser can record, best first', () => {
    assert.deepEqual(pickClipFormat(() => true), { type: 'video/webm;codecs=vp9,opus', ext: 'webm' });
    assert.deepEqual(pickClipFormat((t) => t === 'video/webm'), { type: 'video/webm', ext: 'webm' });
  });
  it('falls back to mp4 where only that exists (Safari)', () => {
    assert.deepEqual(pickClipFormat((t) => t.startsWith('video/mp4')), { type: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4' });
  });
  it('says so when nothing can be recorded', () => assert.equal(pickClipFormat(() => false), null));
});

describe('the picture look', () => {
  it('changes nothing by default, and says "none" so the browser does no work', () => {
    assert.equal(lookFilter(DEFAULT_LOOK), 'none');
  });
  it('writes a filter for what was changed', () => {
    assert.equal(lookFilter({ ...DEFAULT_LOOK, brightness: 110, saturation: 120 }), 'brightness(110%) contrast(100%) saturate(120%)');
  });
  it('makes a saved look safe: bad values go back, good ones stay, extremes are held in range', () => {
    assert.deepEqual(readLook(null), DEFAULT_LOOK);
    assert.deepEqual(readLook({ fit: 'nonsense', brightness: 'x', contrast: null, saturation: undefined }), DEFAULT_LOOK);
    assert.deepEqual(readLook({ fit: 'cover', brightness: 120, contrast: 90, saturation: 0 }), { fit: 'cover', brightness: 120, contrast: 90, saturation: 0 });
    assert.deepEqual(readLook({ brightness: 9999, contrast: -5, saturation: 500 }), { fit: 'contain', brightness: 150, contrast: 50, saturation: 200 });
  });
});

describe('the time left', () => {
  it('warns once, at the point passed while counting down', () => {
    assert.deepEqual(warningsCrossed(400, 290), [300]);
    assert.deepEqual(warningsCrossed(290, 280), []);
    assert.deepEqual(warningsCrossed(70, 55), [60]);
    assert.deepEqual(warningsCrossed(310, 50), [300, 60]);
  });
  it('does not warn when the time goes up (a new day), and the points work again afterwards', () => {
    assert.deepEqual(warningsCrossed(10, 7200), []);
    assert.deepEqual(warningsCrossed(7200, 299), [300]);
  });
  it('does not warn for a reading exactly at the point it started on', () => {
    assert.deepEqual(warningsCrossed(300, 299), []);
  });
  it('says it in words', () => {
    assert.equal(warningText(300), '5 min left today.');
    assert.equal(warningText(60), '1 min left. The connection will end soon.');
  });
  it('says it in the language of the page', () => {
    inKorean(() => {
      assert.equal(warningText(300), '오늘 남은 시간이 5분입니다.');
      assert.equal(warningText(60), '1분 남았습니다. 곧 연결이 끝납니다.');
    });
  });
});

describe('initialOf', () => {
  it('is the first letter, upper case, or a question mark', () => {
    assert.equal(initialOf('owner'), 'O');
    assert.equal(initialOf('  aiden'), 'A');
    assert.equal(initialOf('민지'), '민');
    assert.equal(initialOf(''), '?');
  });
});

describe('describeClosed', () => {
  it('turns the connection\'s English reasons into words, and passes anything else on as it is', () => {
    assert.equal(describeClosed('disconnected'), 'Disconnected.');
    assert.equal(describeClosed(''), 'Disconnected.');
    assert.match(describeClosed('connection failed'), /^Could not reach the server\./);
    assert.match(describeClosed('another client is connected'), /^Another device is using this PS5/);
    assert.equal(describeClosed('Your time for today is up'), 'Your time for today is up');
  });
  it('says the reasons in Korean when the page is Korean, and still passes anything else on', () => {
    inKorean(() => {
      assert.match(describeClosed('disconnected'), /끊었습니다/);
      assert.match(describeClosed('connection failed'), /서버에 연결하지 못했습니다/);
      assert.match(describeClosed('another client is connected'), /다른 기기/);
      assert.equal(describeClosed('오늘 사용할 수 있는 시간이 끝났습니다'), '오늘 사용할 수 있는 시간이 끝났습니다');
    });
  });
});

describe('timeLeft', () => {
  const base = { remaining: 600, heardAt: 1_000, now: 61_000 };
  it('does not count down while no stream is running (the bridge has used nothing)', () => {
    assert.equal(timeLeft({ ...base, streaming: false }), 600);
  });
  it('counts down from what the bridge said while a stream runs', () => {
    assert.equal(timeLeft({ ...base, streaming: true }), 540);
  });
  it('never goes below zero, and has no number where there is no limit', () => {
    assert.equal(timeLeft({ ...base, now: 9_999_999, streaming: true }), 0);
    assert.equal(timeLeft({ remaining: null, heardAt: 0, now: 5, streaming: true }), null);
  });
});
