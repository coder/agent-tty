process.stdin.setRawMode?.(true);
process.stdin.resume();

// Any-event tracking plus SGR encoding exercises press, drag motion, release,
// and coordinates beyond the legacy X10 byte range.
process.stdout.write('\u001b[?1003h\u001b[?1006hMOUSE_READY\r\n');

process.stdin.on('data', (chunk: Buffer | string) => {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  process.stdout.write(`MOUSE_HEX:${bytes.toString('hex')}\r\n`);
});
