import { invariant } from './assert.js';

export interface ResourceScopeFailure {
  readonly name: string;
  readonly error: unknown;
}

export class ResourceScopeCloseError extends Error {
  public readonly failures: readonly ResourceScopeFailure[];

  public constructor(failures: readonly ResourceScopeFailure[]) {
    const names = failures.map((failure) => failure.name).join(', ');
    super(`ResourceScope close failed for: ${names}`);
    this.name = 'ResourceScopeCloseError';
    this.failures = failures;
  }
}

interface ResourceRegistration {
  readonly name: string;
  readonly release: () => Promise<void> | void;
}

export class ResourceScope {
  private readonly releases: ResourceRegistration[] = [];
  private closePromise: Promise<void> | null = null;

  public add(name: string, release: () => Promise<void> | void): void {
    invariant(
      this.closePromise === null,
      'cannot add a resource to a closed ResourceScope',
    );
    invariant(
      typeof name === 'string' && name.length > 0,
      'ResourceScope.add() name must be a non-empty string',
    );
    invariant(
      typeof release === 'function',
      'ResourceScope.add() release must be a function',
    );
    this.releases.push({ name, release });
  }

  public close(): Promise<void> {
    this.closePromise ??= this.runReleases();
    return this.closePromise;
  }

  private async runReleases(): Promise<void> {
    const failures: ResourceScopeFailure[] = [];
    for (let i = this.releases.length - 1; i >= 0; i--) {
      const registration = this.releases[i];
      if (registration === undefined) {
        continue;
      }
      try {
        await registration.release();
      } catch (error) {
        failures.push({ name: registration.name, error });
      }
    }
    if (failures.length > 0) {
      throw new ResourceScopeCloseError(failures);
    }
  }
}
