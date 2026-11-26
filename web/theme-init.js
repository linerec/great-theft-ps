// SPDX-License-Identifier: AGPL-3.0-only
// Runs before the page is drawn: a pinned light or dark choice is put on <html> at once, so the other theme never flashes.
// (Plain script, not a module, so that it runs in order. The page's own code, ui.ts, takes over from here.)
try {
  var t = localStorage.getItem('gtp.theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) {
  /* storage blocked: the device's setting decides */
}
// A Korean choice: hold the page back until lang.ts has put the words in, so that English does not flash first.
try {
  var l = new URLSearchParams(location.search).get('lang') || localStorage.getItem('gtp.lang');
  if (l === 'ko') {
    document.documentElement.setAttribute('data-lang-pending', '');
    // If the page's code never runs, the English page is better than none.
    setTimeout(function () {
      document.documentElement.removeAttribute('data-lang-pending');
    }, 2500);
  }
} catch (e) {
  /* storage blocked: English */
}
