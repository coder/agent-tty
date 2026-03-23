import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { RendererBackend } from '../renderer/backend.js';
import type { RenderProfileConfig, ReplayInput } from '../renderer/types.js';
import { invariant } from '../util/assert.js';

interface HostRendererManagerOptions {
  sessionId: string;
  sessionDir: string;
  backendFactory: (
    sessionId: string,
    profile: RenderProfileConfig,
  ) => RendererBackend;
}

function assertNonEmptyString(
  value: string,
  label: string,
): asserts value is string {
  invariant(
    typeof value === 'string' && value.length > 0,
    `${label} must be a non-empty string`,
  );
}

function assertAbsolutePath(pathValue: string, label: string): void {
  assertNonEmptyString(pathValue, label);
  invariant(isAbsolute(pathValue), `${label} must be an absolute path`);
}

export class HostRendererManager {
  private readonly sessionId: string;
  private readonly sessionDir: string;
  private readonly backendFactory: HostRendererManagerOptions['backendFactory'];

  private currentBackend: RendererBackend | null = null;
  private currentProfileName: string | null = null;
  private cachedInitialCols: number | null = null;
  private cachedInitialRows: number | null = null;
  private bootPromise: Promise<RendererBackend> | null = null;
  private lifecyclePromise: Promise<void> = Promise.resolve();
  private screenshotsDirectoryCreated = false;

  constructor(options: HostRendererManagerOptions) {
    assertNonEmptyString(options.sessionId, 'sessionId');
    assertAbsolutePath(options.sessionDir, 'sessionDir');
    invariant(
      typeof options.backendFactory === 'function',
      'backendFactory must be a function',
    );

    this.sessionId = options.sessionId;
    this.sessionDir = resolve(options.sessionDir);
    this.backendFactory = options.backendFactory;
  }

  async getBackend(
    profile: RenderProfileConfig,
    replayInput: ReplayInput | null,
  ): Promise<RendererBackend> {
    assertNonEmptyString(profile.name, 'profile name');

    if (replayInput !== null) {
      invariant(
        replayInput.sessionId === this.sessionId,
        'replay input sessionId must match manager sessionId',
      );
    }

    return this.runExclusive(async () => {
      if (
        replayInput !== null &&
        this.currentBackend !== null &&
        this.cachedInitialCols !== null &&
        this.cachedInitialRows !== null &&
        (this.cachedInitialCols !== replayInput.initialCols ||
          this.cachedInitialRows !== replayInput.initialRows)
      ) {
        await this.disposeCurrentBackend();
      }

      const backend = await this.ensureBackend(profile);

      if (replayInput !== null && replayInput.targetSeq >= 0) {
        await backend.replayTo(replayInput);
        this.cachedInitialCols = replayInput.initialCols;
        this.cachedInitialRows = replayInput.initialRows;
      }

      return backend;
    });
  }

  screenshotPath(profileName: string): string {
    assertNonEmptyString(profileName, 'profileName');
    invariant(
      !profileName.includes('/') && !profileName.includes('\\'),
      'profileName must not contain path separators',
    );

    const screenshotsDir = resolve(this.sessionDir, 'screenshots');
    this.assertPathWithinSessionDir(
      screenshotsDir,
      'screenshots directory must stay within the session directory',
    );

    if (!this.screenshotsDirectoryCreated) {
      mkdirSync(screenshotsDir, { recursive: true });
      this.screenshotsDirectoryCreated = true;
    }

    const outputPath = resolve(
      screenshotsDir,
      `${profileName}-${String(Date.now())}.png`,
    );
    this.assertPathWithinSessionDir(
      outputPath,
      'screenshot path must stay within the session directory',
    );
    invariant(
      dirname(outputPath) === screenshotsDir,
      'screenshot path must be created directly within the screenshots directory',
    );

    return outputPath;
  }

  async dispose(): Promise<void> {
    await this.runExclusive(async () => {
      await this.disposeCurrentBackend();
    });
  }

  private async ensureBackend(
    profile: RenderProfileConfig,
  ): Promise<RendererBackend> {
    const requiresReplacement =
      this.currentBackend === null ||
      this.currentProfileName !== profile.name ||
      !this.currentBackend.isBooted;

    if (requiresReplacement) {
      await this.disposeCurrentBackend();

      const backend = this.backendFactory(this.sessionId, profile);

      this.currentBackend = backend;
      this.currentProfileName = profile.name;
    }

    invariant(this.currentBackend !== null, 'current backend must exist');

    if (!this.currentBackend.isBooted) {
      await this.bootBackend(this.currentBackend);
    }

    return this.currentBackend;
  }

  private async bootBackend(
    backend: RendererBackend,
  ): Promise<RendererBackend> {
    if (this.bootPromise === null) {
      this.bootPromise = (async () => {
        try {
          await backend.boot();
          return backend;
        } catch (error: unknown) {
          try {
            await this.disposeCurrentBackend();
          } catch {
            // Preserve the original boot error; dispose is best effort here.
          }
          throw error;
        }
      })().finally(() => {
        this.bootPromise = null;
      });
    }

    const bootedBackend = await this.bootPromise;
    invariant(
      bootedBackend === backend,
      'booted backend must match the requested backend',
    );
    return bootedBackend;
  }

  private async disposeCurrentBackend(): Promise<void> {
    const backend = this.currentBackend;

    this.currentBackend = null;
    this.currentProfileName = null;
    this.cachedInitialCols = null;
    this.cachedInitialRows = null;
    this.bootPromise = null;

    if (backend === null) {
      return;
    }

    await backend.dispose();
  }

  private assertPathWithinSessionDir(pathValue: string, message: string): void {
    const relativePath = relative(this.sessionDir, resolve(pathValue));

    invariant(
      relativePath === '' ||
        (!relativePath.startsWith(`..${sep}`) &&
          relativePath !== '..' &&
          !isAbsolute(relativePath)),
      message,
    );
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const queuedOperation = this.lifecyclePromise.then(operation, operation);
    this.lifecyclePromise = queuedOperation.then(
      () => undefined,
      () => undefined,
    );
    return queuedOperation;
  }
}
