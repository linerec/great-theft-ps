// SPDX-License-Identifier: AGPL-3.0-only
//
// The words of the console calibration panel (web/calibrate-console.ts): what it says while it measures and when it is done,
// in English and, when the page is Korean, in Korean.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CalibrationResult } from '../src/engine/lookcalibrate.ts';
import { setLang } from '../src/i18n/index.ts';
import { plotSvg, progressText, resultText } from '../web/calibrate-console.ts';

const RESULT = {
  innerDeadzone: 0.1234,
  fullStickRate: 312.4,
  verticalRateRatio: null,
  latencyMs: 80,
  scaleSource: 'turn',
  warnings: [{ code: 'low-support' }],
  table: [[0, 0], [1, 300]],
  levels: [{ ok: true, stick: 0.5, degPerSec: 100 }],
} as unknown as CalibrationResult;

/** Runs `body` with the page in Korean, and puts English back whatever happens. */
function inKorean(body: () => void): void {
  setLang('ko');
  try {
    body();
  } finally {
    setLang('en');
  }
}

describe('what the calibration panel says', () => {
  it('names the step it is on, with the stick when there is one', () => {
    assert.equal(progressText({ phase: 'yaw', stick: 0.5, step: 2, steps: 9 }), 'Measuring horizontal response (stick 0.50) · 2/9');
    assert.equal(progressText({ phase: 'build', step: 9, steps: 9 }), 'Building the table · 9/9');
  });

  it('gives the numbers, the delay, and what to watch out for, one line each', () => {
    assert.deepEqual(resultText(RESULT).split('\n'), [
      'Value where the stick starts to register (dead zone) 0.12 · 312°/s at full push · vertical/horizontal not measured',
      'Delay before it shows on screen 80 ms · angle basis: measured from a full camera turn',
      'Note: Some steps could not be measured because the picture was unclear.',
    ]);
  });

  it('says the same in Korean when the page is Korean, each time it is asked', () => {
    inKorean(() => {
      assert.equal(progressText({ phase: 'yaw', stick: 0.5, step: 2, steps: 9 }), '가로 반응 측정 (스틱 0.50) · 2/9');
      assert.equal(progressText({ phase: 'build', step: 9, steps: 9 }), '표 만드는 중 · 9/9');
      assert.deepEqual(resultText({ ...RESULT, scaleSource: 'assumed' }).split('\n'), [
        '스틱이 움직이기 시작하는 값(데드존) 0.12 · 최대 편향에서 312°/s · 세로/가로 측정 못 함',
        '화면에 나타나기까지 지연 80 ms · 각도 기준: 시야각 가정',
        '주의: 일부 단계는 화면이 불분명해 측정하지 못했습니다.',
      ]);
    });
  });

  it('labels the drawing in the language of the page', () => {
    assert.match(plotSvg(RESULT), /aria-label="Turn speed by stick value".*>Stick 0</);
    inKorean(() => assert.match(plotSvg(RESULT), /aria-label="스틱 값에 따른 회전 속도".*>스틱 0</));
  });
});
