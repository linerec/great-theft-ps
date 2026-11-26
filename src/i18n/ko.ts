// SPDX-License-Identifier: AGPL-3.0-only
//
// The Korean dictionary: the English sentence of the code (or of the page) as the key, the Korean one as the value. Kept in
// parts, one for each part of the program, so that they are written and read one at a time.

import { KO_BRIDGE } from './ko-bridge.ts';
import { KO_CORE } from './ko-core.ts';
import { KO_PAGE } from './ko-page.ts';
import { KO_PLAY } from './ko-play.ts';
import { KO_STUDY } from './ko-study.ts';
import { KO_VIEWS } from './ko-views.ts';

export const KO: Record<string, string> = { ...KO_CORE, ...KO_PAGE, ...KO_PLAY, ...KO_VIEWS, ...KO_BRIDGE, ...KO_STUDY };
