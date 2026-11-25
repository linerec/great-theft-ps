// SPDX-License-Identifier: AGPL-3.0-only
//
// Draws the app icons (the PNGs a phone's "Add to Home Screen" and the web app manifest want) from web/icon.svg, with Chrome
// in headless mode: no image library is needed. The PNGs are square to the edge (the phone rounds them itself) and the picture
// sits well inside the middle, so that a round or squircle mask does not cut it. Run it again after changing icon.svg.
//   npm run icons

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find((p) => existsSync(p));
if (!chrome) {
  console.error('No Chrome found. Set CHROME to its path.');
  process.exit(2);
}

// The same drawing with square corners.
const svg = readFileSync(path.join(root, 'web', 'icon.svg'), 'utf8').replace(' rx="112"', '');
const dir = mkdtempSync(path.join(tmpdir(), 'gtp-icons-'));
try {
  for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
    const page = path.join(dir, `${size}.html`);
    writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#4a90ff}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    const profile = path.join(dir, `profile-${size}`);
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${profile}`, `--window-size=${size},${size}`, `--screenshot=${path.join(root, 'web', file)}`, `file://${page}`], { stdio: 'ignore' });
    if (r.status !== 0) throw new Error(`Chrome failed for ${file}`);
    console.log(`web/${file}  ${size}x${size}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
