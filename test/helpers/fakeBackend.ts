import { writeFile } from 'node:fs/promises';

import { vi } from 'vitest';

import type { RendererBackend } from '../../src/renderer/backend.js';
import type {
  ReplayInput,
  ReplayState,
  ScreenshotResult,
  SemanticSnapshot,
} from '../../src/renderer/types.js';

type MockFn = ReturnType<typeof vi.fn>;

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export interface FakeBackendOptions {
  rendererBackend?: string;
  bootImplementation?: () => Promise<void>;
  resultOverrides?: Partial<ScreenshotResult>;
  writePng?: boolean;
  fail?: Error;
  onScreenshot?: (
    outputPath: string,
    options?: { showCursor?: boolean },
  ) => void;
}

export type FakeRendererBackend = RendererBackend & {
  bootMock: MockFn;
  replayToMock: MockFn;
  snapshotMock: MockFn;
  screenshotMock: MockFn;
  getVisibleTextMock: MockFn;
  disposeMock: MockFn;
  setBooted: (value: boolean) => void;
};

export function createFakeBackend(
  options: FakeBackendOptions = {},
): FakeRendererBackend {
  const rendererBackend = options.rendererBackend ?? 'fake-renderer';
  const writePng = options.writePng ?? true;
  let booted = false;

  const bootMock = vi.fn((): Promise<void> => {
    if (options.bootImplementation !== undefined) {
      return options.bootImplementation();
    }
    booted = true;
    return Promise.resolve();
  });

  const replayToMock = vi.fn(
    (input: ReplayInput): Promise<ReplayState> =>
      Promise.resolve({
        lastSeq: input.targetSeq,
        cols: input.initialCols,
        rows: input.initialRows,
        cursorRow: 0,
        cursorCol: 0,
      }),
  );

  const snapshotMock = vi.fn(
    (): Promise<SemanticSnapshot> =>
      Promise.resolve({
        sessionId: 'session-01',
        capturedAtSeq: 0,
        cols: 80,
        rows: 24,
        cursorRow: 0,
        cursorCol: 0,
        isAltScreen: false,
        visibleLines: [],
      }),
  );

  const screenshotMock = vi.fn(
    async (
      outputPath: string,
      screenshotOptions?: { showCursor?: boolean },
    ): Promise<ScreenshotResult> => {
      options.onScreenshot?.(outputPath, screenshotOptions);
      if (options.fail !== undefined) {
        throw options.fail;
      }
      if (writePng) {
        await writeFile(outputPath, PNG_HEADER);
      }
      return {
        sessionId: 'session-01',
        capturedAtSeq: 5,
        profileName: 'reference-dark',
        cols: 80,
        rows: 24,
        artifactPath: outputPath,
        pngSizeBytes: 4,
        cursorVisible: screenshotOptions?.showCursor === true,
        rendererBackend,
        pixelWidth: 800,
        pixelHeight: 600,
        sha256: 'a'.repeat(64),
        renderProfileHash: 'b'.repeat(64),
        ...options.resultOverrides,
      };
    },
  );

  const getVisibleTextMock = vi.fn((): Promise<string> => Promise.resolve(''));

  const disposeMock = vi.fn((): Promise<void> => {
    booted = false;
    return Promise.resolve();
  });

  return {
    rendererBackend,
    get isBooted() {
      return booted;
    },
    setBooted(value: boolean) {
      booted = value;
    },
    boot: bootMock,
    bootMock,
    replayTo: replayToMock,
    replayToMock,
    snapshot: snapshotMock,
    snapshotMock,
    screenshot: screenshotMock,
    screenshotMock,
    getVisibleText: getVisibleTextMock,
    getVisibleTextMock,
    dispose: disposeMock,
    disposeMock,
  };
}
