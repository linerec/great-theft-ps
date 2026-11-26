// SPDX-License-Identifier: AGPL-3.0-only
//
// Look at, back up and move the registered consoles, so a registration never has to be done twice (no new 8 digit code
// on the console, no new PSN login).
//
//   npm run consoles -- list                      what is registered on this computer (no secrets shown)
//   npm run consoles -- path                      where the registrations are kept
//   npm run consoles -- export <file> [--force]   write a passphrase-protected copy
//   npm run consoles -- import <file>             add the consoles of such a copy to this computer
//
// The passphrase is asked for on the terminal (not shown). For scripts, set GTP_PASSPHRASE instead.
// The copy is encrypted, but it holds the keys to your console: move it by USB stick or a private channel and delete it
// after importing.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { BackupError, decryptBackup, encryptBackup, MIN_PASSPHRASE } from '../src/console/backup.ts';
import { ConsoleStore, defaultStorePath } from '../src/console/store.ts';

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const positional = rest.filter((a) => !a.startsWith('--'));
const store = new ConsoleStore(defaultStorePath());

/** Read a line without echoing it. Falls back to a plain line when stdin is not a terminal. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      const rl = createInterface({ input: stdin });
      rl.once('line', (line) => {
        rl.close();
        resolve(line);
      });
      rl.once('close', () => resolve(''));
      return;
    }
    let text = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (value, error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(text);
        if (ch === '\u0003') return finish('', new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else if (ch >= ' ') text += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

function describe(c) {
  return `  ${c.nickname || '(no name)'}  ${c.target}  ${c.host}  id ${c.mac}${c.verifiedAt ? '  verified ' + c.verifiedAt.slice(0, 10) : ''}`;
}

try {
  if (command === 'path') {
    console.log(store.file);
  } else if (command === 'list') {
    const list = store.list();
    if (list.length === 0) console.log(`No consoles registered on this computer (${store.file}).`);
    else {
      console.log(`${list.length} registered in ${store.file}:`);
      for (const c of list) console.log(describe(c));
    }
    console.log(`PSN account id saved: ${store.accountId ? 'yes' : 'no'}`);
  } else if (command === 'export') {
    const file = positional[0];
    if (!file) fail('usage: npm run consoles -- export <file> [--force]');
    if (store.list().length === 0) fail('Nothing to export: no console is registered on this computer.');
    if (existsSync(file) && !flags.has('--force')) fail(`${file} already exists. Choose another name, or add --force to replace it.`);
    let pass = process.env.GTP_PASSPHRASE;
    if (pass === undefined) {
      pass = await askHidden(`Passphrase for the copy (at least ${MIN_PASSPHRASE} characters): `);
      if (pass !== (await askHidden('Again: '))) fail('The two passphrases differ. Nothing was written.');
    }
    writeFileSync(file, encryptBackup(store.snapshot(), pass), { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* not supported here */
    }
    console.log(`Wrote ${store.list().length} console(s)${store.accountId ? ' and the PSN account id' : ''} to ${file}, encrypted.`);
    console.log('Take it to the other computer, run `npm run consoles -- import <file>` there, then delete the file. Do not keep or share it.');
  } else if (command === 'import') {
    const file = positional[0];
    if (!file) fail('usage: npm run consoles -- import <file>');
    if (!existsSync(file)) fail(`${file} does not exist.`);
    const pass = process.env.GTP_PASSPHRASE ?? (await askHidden('Passphrase of the copy: '));
    const result = store.merge(decryptBackup(readFileSync(file, 'utf8'), pass));
    for (const c of result.added) console.log(`added   ${describe(c).trim()}`);
    for (const c of result.updated) console.log(`updated ${describe(c).trim()}`);
    for (const c of result.kept) console.log(`kept    ${describe(c).trim()}  (this computer already has the same or a newer registration)`);
    if (result.accountId === 'taken') console.log('PSN account id: taken from the copy.');
    if (!result.added.length && !result.updated.length && result.accountId !== 'taken') console.log('Nothing new in that copy.');
    console.log('Next: open the PS5 page and connect to the console once. That proves the console accepts this registration from this computer.');
    console.log('Then delete the copy file.');
  } else {
    console.log('usage: npm run consoles -- list | path | export <file> [--force] | import <file>');
    process.exit(command ? 2 : 0);
  }
} catch (e) {
  if (e instanceof BackupError) fail(`${e.message}.`);
  if (e instanceof Error && e.message === 'cancelled') fail('Cancelled.');
  throw e;
}
