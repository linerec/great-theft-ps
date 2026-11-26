// SPDX-License-Identifier: AGPL-3.0-only
//
// The analysis of the study's scores, off the page's thread: it takes a second or two (it runs the engine for every setting that
// was tried and resamples the ratings many times), and a stream that is running must not wait for that.

import { analyzeRatings, formatReport, type FeelRating } from '../src/engine/feel-study.ts';
import { langOf } from '../src/i18n/index.ts';

// The page's language comes with the ratings: a worker has no page, and so no language of its own.
self.onmessage = (e: MessageEvent<{ ratings: FeelRating[]; lang?: string }>) => {
  const report = analyzeRatings(e.data.ratings);
  self.postMessage({ text: formatReport(report, langOf(e.data.lang)) });
};
