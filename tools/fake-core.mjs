// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for gtp-core used by the tests. Speaks the framed stdio contract:
// reads PAD / QUALITY / KEYFRAME / QUIT from stdin, writes STATUS and VIDEO to stdout.
// Behaviour switches: --crash (exit 3 after the first PAD), --split (write messages in 1-byte pieces).
import { argv, stdin, stdout } from 'node:process';

const crash = argv.includes('--crash');
const split = argv.includes('--split');

const out = (body) => {
  const framed = Buffer.alloc(4 + body.length);
  framed.writeUInt32LE(body.length, 0);
  framed.set(body, 4);
  if (split) for (let i = 0; i < framed.length; i++) stdout.write(framed.subarray(i, i + 1));
  else stdout.write(framed);
};

const json = (type, o) => out(Buffer.concat([Buffer.from([type]), Buffer.from(JSON.stringify(o))]));
const video = (frameId, inputSeq, payload) => {
  const b = Buffer.alloc(19 + payload.length);
  b[0] = 0x10; b[1] = 1; b[2] = 1;
  b.writeUInt32LE(frameId, 3); b.writeUInt32LE(inputSeq, 7); b.writeDoubleLE(5.5, 11);
  b.set(payload, 19);
  out(b);
};

json(0x13, { state: 'streaming', detail: 'fake core' });
let seq = 0;
let frame = 0;
let buf = Buffer.alloc(0);
stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const body = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    if (body[0] === 0x01) {
      seq = body.readUInt32LE(1);
      json(0x14, { }); // a log line (ignored content)
      video(++frame, seq, Buffer.from([1, 2, 3, 4, 5]));
      if (crash) process.exit(3);
    } else if (body[0] === 0x02) {
      json(0x13, { state: 'streaming', detail: 'quality ' + Buffer.from(body.subarray(1)).toString() });
    } else if (body[0] === 0x04) {
      video(++frame, seq, Buffer.from([9, 9]));
    } else if (body[0] === 0x03) {
      process.exit(0);
    }
  }
});
stdin.on('end', () => process.exit(0));
