import assert from 'node:assert/strict';
import process from 'node:process';

const RESET = '\u001b[0m';
const HOLD_OPEN_MS = 1_200;

const basicBackgrounds = [40, 41, 42, 43, 44, 45, 46, 47] as const;
const brightBackgrounds = [100, 101, 102, 103, 104, 105, 106, 107] as const;
const sample256Backgrounds = [
  16, 22, 28, 34, 40, 46, 82, 118, 154, 190, 196, 202,
] as const;
const truecolorSamples = [
  { label: 'TC-RED', rgb: [255, 90, 90] as const, foreground: 30 },
  { label: 'TC-GRN', rgb: [80, 220, 120] as const, foreground: 30 },
  { label: 'TC-BLU', rgb: [90, 140, 255] as const, foreground: 97 },
  { label: 'TC-GLD', rgb: [255, 190, 64] as const, foreground: 30 },
] as const;
const foregroundSamples = [
  { label: 'FG-31', sequence: '\u001b[31m' },
  { label: 'FG-92', sequence: '\u001b[92m' },
  { label: 'FG5-45', sequence: '\u001b[38;5;45m' },
  { label: 'FG5-201', sequence: '\u001b[38;5;201m' },
  { label: 'FG2-ORANGE', sequence: '\u001b[38;2;255;140;40m' },
  { label: 'FG2-CYAN', sequence: '\u001b[38;2;80;220;255m' },
] as const;

assert(
  process.stdout.writable,
  'stdout must be writable for the color-grid fixture',
);

function writeStdout(text: string): void {
  process.stdout.write(text);
}

function contrastingForeground(backgroundCode: number): number {
  return backgroundCode === 47 || backgroundCode >= 103 ? 30 : 97;
}

function renderBackgroundSwatch(
  label: string,
  backgroundSequence: string,
  foregroundCode: number,
): string {
  return `\u001b[${String(foregroundCode)}m${backgroundSequence} ${label.padEnd(8, ' ')} ${RESET}`;
}

function renderIndexedBackground(code: number): string {
  return renderBackgroundSwatch(
    `IDX-${String(code).padStart(3, '0')}`,
    `\u001b[48;5;${String(code)}m`,
    code >= 118 ? 30 : 97,
  );
}

function renderTruecolorSample(
  sample: (typeof truecolorSamples)[number],
): string {
  const [red, green, blue] = sample.rgb;
  return renderBackgroundSwatch(
    sample.label,
    `\u001b[48;2;${String(red)};${String(green)};${String(blue)}m`,
    sample.foreground,
  );
}

const lines = [
  'COLOR GRID FIXTURE',
  'Basic background colors:',
  basicBackgrounds
    .map((code) =>
      renderBackgroundSwatch(
        `BG-${String(code)}`,
        `\u001b[${String(code)}m`,
        contrastingForeground(code),
      ),
    )
    .join(' '),
  'Bright background colors:',
  brightBackgrounds
    .map((code) =>
      renderBackgroundSwatch(
        `BG-${String(code)}`,
        `\u001b[${String(code)}m`,
        contrastingForeground(code),
      ),
    )
    .join(' '),
  '256-color sample backgrounds:',
  sample256Backgrounds.map((code) => renderIndexedBackground(code)).join(' '),
  'Truecolor sample backgrounds:',
  truecolorSamples.map((sample) => renderTruecolorSample(sample)).join(' '),
  'Foreground sample labels:',
  foregroundSamples
    .map(
      (sample) => `${sample.sequence}${sample.label.padEnd(11, ' ')}${RESET}`,
    )
    .join(' '),
  `${RESET}COLOR GRID COMPLETE`,
  '',
].join('\n');

writeStdout(lines);
setTimeout(() => {
  process.exit(0);
}, HOLD_OPEN_MS);
