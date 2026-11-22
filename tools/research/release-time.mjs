// SPDX-License-Identifier: AGPL-3.0-only
// How long does the console keep saying "in use" after a connection ends? Prints times only, nothing secret.
//   node tools/research/release-time.mjs ctrl     end after the control connection (no stream), close the socket
//   node tools/research/release-time.mjs stream   end after 3 s of stream, with the DISCONNECT message
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const kind = process.argv[2] ?? 'ctrl';
const load = (p) => import(pathToFileURL(path.join(repo, p)).href);
const { ConsoleStore, defaultStorePath } = await load('src/console/store.ts');
const { requestSession, SessionError } = await load('src/console/session.ts');
const { Ctrl } = await load('src/console/ctrl.ts');
const { StreamConnection } = await load('src/console/streamconnection.ts');
const { takionTransport } = await load('src/console/takion-transport.ts');

const store = new ConsoleStore(defaultStorePath());
const record = store.get(store.list()[0].mac);
const keys = { host: record.host, target: record.target, registKey: Buffer.from(record.registKey, 'hex'), rpKey: Buffer.from(record.rpKey, 'hex') };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const grant = await requestSession(keys);
const ctrl = new Ctrl({ host: record.host, target: record.target, crypt: grant.crypt, registKey: keys.registKey });
await ctrl.connect();
const sessionId = await ctrl.waitForSessionId(8000);
if (kind === 'stream') {
  const stream = new StreamConnection({ transport: takionTransport({ host: record.host, protocolVersion: 12 }), target: record.target, sessionId, sessionCrypt: grant.crypt, video: { width: 960, height: 540, maxFps: 30, bitrateKbps: 4000, codec: 'h264' } });
  await stream.start();
  await sleep(3000);
  stream.stop();
}
ctrl.close();
const ended = Date.now();
console.log(`${kind}: connection ended, asking again every 500 ms`);
for (let i = 0; i < 120; i++) {
  await sleep(500);
  const at = ((Date.now() - ended) / 1000).toFixed(1);
  try {
    await requestSession(keys);
    console.log(`  accepted again after ${at} s`);
    break;
  } catch (e) {
    if (!(e instanceof SessionError)) throw e;
    if (i % 4 === 0) console.log(`  ${at} s: ${e.reason !== undefined ? '0x' + e.reason.toString(16) : e.code}`);
  }
}
process.exit(0);
