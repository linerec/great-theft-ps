// SPDX-License-Identifier: AGPL-3.0-only
// How long does the console stay "in use" after a session request that was accepted and then not followed up?
// Prints times only.
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (p) => import(pathToFileURL(path.join(repo, p)).href);
const { ConsoleStore, defaultStorePath } = await load('src/console/store.ts');
const { requestSession, SessionError } = await load('src/console/session.ts');
const store = new ConsoleStore(defaultStorePath());
const record = store.get(store.list()[0].mac);
const keys = { host: record.host, target: record.target, registKey: Buffer.from(record.registKey, 'hex'), rpKey: Buffer.from(record.rpKey, 'hex') };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = async () => {
  try {
    await requestSession(keys);
    return true;
  } catch (e) {
    if (!(e instanceof SessionError)) throw e;
    return false;
  }
};

const began = Date.now();
while (!(await ask())) await sleep(1000); // wait until the console is free; this accepted request is the one left alone
const t0 = Date.now();
console.log(`a session request was accepted ${((t0 - began) / 1000).toFixed(0)} s after starting to ask; leaving it alone`);
for (let i = 0; i < 150; i++) {
  await sleep(1000);
  if (await ask()) {
    console.log(`the console accepted the next one after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    process.exit(0);
  }
}
console.log('still in use after 150 s');
process.exit(0);
