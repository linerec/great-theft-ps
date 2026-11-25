// SPDX-License-Identifier: AGPL-3.0-only
//
// The analysis of the study's scores, off the page's thread: it takes a second or two (it runs the engine for every setting that
// was tried and resamples the ratings many times), and a stream that is running must not wait for that.

import { analyzeRatings, formatReport, type FeelRating } from '../src/engine/feel-study.ts';

self.onmessage = (e: MessageEvent<{ ratings: FeelRating[] }>) => {
  const report = analyzeRatings(e.data.ratings);
  self.postMessage({ text: formatReport(report) });
};
