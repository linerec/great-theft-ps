// SPDX-License-Identifier: AGPL-3.0-only
// Runs before the page is drawn: a pinned light or dark choice is put on <html> at once, so the other theme never flashes.
// (Plain script, not a module, so that it runs in order. The page's own code, ui.ts, takes over from here.)
try {
  var t = localStorage.getItem('gtp.theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) {
  /* storage blocked: the device's setting decides */
}
