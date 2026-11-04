import assert from 'node:assert/strict';
import process from 'node:process';

// Fills the whole screen with cells that each have their own truecolor
// foreground, background and bold, the largest per-cell snapshot data.
const MARKER = 'FILL-DONE';
const HOLD_OPEN_MS = 60_000;

const cols = process.stdout.columns;
const rows = process.stdout.rows;
assert(
  Number.isInteger(cols) && Number.isInteger(rows) && cols > MARKER.length,
  'styled-fill needs a TTY wider than its marker',
);

let output = '\u001b[2J';
for (let row = 0; row < rows; row += 1) {
  output += `\u001b[${String(row + 1)};1H`;
  const isLastRow = row === rows - 1;
  // Leave the last cell of the screen empty so the screen does not scroll.
  const width = isLastRow ? cols - 1 - MARKER.length : cols;
  for (let col = 0; col < width; col += 1) {
    const fg = `${String(col % 256)};${String(row % 256)};${String((col * 7) % 256)}`;
    const bg = `${String((row * 3) % 256)};${String((col * 5) % 256)};${String(255 - (col % 256))}`;
    const char = String.fromCharCode(97 + ((row * cols + col) % 26));
    output += `\u001b[1;38;2;${fg}m\u001b[48;2;${bg}m${char}`;
  }
  if (isLastRow) {
    output += `\u001b[0m${MARKER}`;
  }
}
process.stdout.write(output);

setTimeout(() => {
  process.exit(0);
}, HOLD_OPEN_MS);
