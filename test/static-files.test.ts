// SPDX-License-Identifier: AGPL-3.0-only
//
// The files the page is made of that are not scripts: the web app manifest, the icons, and that images arrive byte for byte.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FakeLink } from './support/fake-link.ts';
import { startBridge, type Bridge } from '../src/bridge/server.ts';
import { ConsoleStore } from '../src/console/store.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let bridge: Bridge;
let dir = '';

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'gtp-static-'));
  bridge = await startBridge({ host: '127.0.0.1', port: 0, root, store: new ConsoleStore(path.join(dir, 'consoles.json')), createLink: () => new FakeLink() });
});
after(async () => {
  await bridge.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('static files', () => {
  it('serves the web app manifest as a manifest, and every icon it names exists', async () => {
    const res = await fetch(`${bridge.url}web/manifest.webmanifest`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^application\/manifest\+json/);
    const manifest = (await res.json()) as { name: string; start_url: string; icons: Array<{ src: string; type: string }> };
    assert.equal(manifest.start_url, '/');
    assert.ok(manifest.icons.length >= 2);
    for (const icon of manifest.icons) {
      const r = await fetch(new URL(icon.src, bridge.url));
      assert.equal(r.status, 200, icon.src);
      assert.equal(r.headers.get('content-type'), icon.type, icon.src);
    }
  });

  it('sends a PNG byte for byte (read as text it would be damaged)', async () => {
    const res = await fetch(`${bridge.url}web/icon-192.png`);
    const got = Buffer.from(await res.arrayBuffer());
    const want = readFileSync(path.join(root, 'web', 'icon-192.png'));
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(got.length, want.length);
    assert.ok(got.equals(want));
    assert.equal(got.subarray(1, 4).toString('latin1'), 'PNG');
  });

  it('answers a HEAD request for an image without a body', async () => {
    const res = await fetch(`${bridge.url}web/apple-touch-icon.png`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal((await res.arrayBuffer()).byteLength, 0);
  });

  it('serves the page icon as SVG', async () => {
    const res = await fetch(`${bridge.url}web/icon.svg`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.match(await res.text(), /<svg/);
  });

  it('still serves nothing outside web/ and src/, and no other file types', async () => {
    assert.equal((await fetch(`${bridge.url}package.json`)).status, 404);
    assert.equal((await fetch(`${bridge.url}web/..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${bridge.url}web/nothing.png`)).status, 404);
    assert.equal((await fetch(`${bridge.url}web/theme-init.js`)).status, 200);
  });
});
