import type { SessionRecord } from '../protocol/schemas.js';
import { invariant } from '../util/assert.js';

export class SessionState {
  readonly #record: SessionRecord;

  public constructor(initialRecord: SessionRecord) {
    this.#record = {
      ...initialRecord,
      command: [...initialRecord.command],
    };
  }

  public snapshot(): SessionRecord {
    return {
      ...this.#record,
      command: [...this.#record.command],
    };
  }

  public setHostPid(pid: number): void {
    invariant(
      this.#record.status === 'running',
      'Cannot set host PID unless session is running',
    );
    invariant(this.#record.hostPid === null, 'Host PID has already been set');
    invariant(
      Number.isInteger(pid) && pid > 0,
      'Host PID must be a positive integer',
    );

    this.#record.hostPid = pid;
    this.touch();
  }

  public setChildPid(pid: number): void {
    invariant(
      this.#record.status === 'running',
      'Cannot set child PID unless session is running',
    );
    invariant(this.#record.childPid === null, 'Child PID has already been set');
    invariant(
      Number.isInteger(pid) && pid > 0,
      'Child PID must be a positive integer',
    );

    this.#record.childPid = pid;
    this.touch();
  }

  public setDimensions(cols: number, rows: number): void {
    invariant(
      this.#record.status === 'running',
      'Cannot set dimensions unless session is running',
    );
    invariant(
      Number.isInteger(cols) && cols > 0,
      'Columns must be a positive integer',
    );
    invariant(
      Number.isInteger(rows) && rows > 0,
      'Rows must be a positive integer',
    );

    this.#record.cols = cols;
    this.#record.rows = rows;
    this.touch();
  }

  public requestDestroy(): void {
    invariant(
      this.#record.status !== 'destroyed',
      'Cannot destroy an already destroyed session',
    );
    invariant(
      this.#record.status !== 'destroying',
      'Session is already being destroyed',
    );
    invariant(
      ['running', 'exited', 'failed'].includes(this.#record.status),
      `Cannot request destroy in current state: ${this.#record.status}`,
    );

    this.#record.status = 'destroying';
    this.touch();
  }

  // There are two valid paths to the terminal `destroyed` state:
  // 1. recordDestroyed() for the graceful host-managed destroy flow.
  // 2. reconcileSession() writing `destroyed` directly if the host dies mid-destroy.
  public recordDestroyed(exitInfo?: {
    exitCode: number | null;
    exitSignal: string | null;
  }): void {
    invariant(
      this.#record.status === 'destroying',
      `Cannot record destroyed unless session is destroying, current status: ${this.#record.status}`,
    );
    if (exitInfo !== undefined) {
      invariant(
        exitInfo.exitCode === null || Number.isInteger(exitInfo.exitCode),
        'Exit code must be an integer or null',
      );
      invariant(
        exitInfo.exitSignal === null || typeof exitInfo.exitSignal === 'string',
        'Exit signal must be a string or null',
      );
      this.#record.exitCode = exitInfo.exitCode;
      this.#record.exitSignal = exitInfo.exitSignal;
    }

    this.#record.status = 'destroyed';
    this.touch();
  }

  public recordExit(exitCode: number | null, exitSignal: string | null): void {
    // `exiting` remains part of the state machine for compatibility with
    // reconcileSession(), which upgrades stranded `exiting` manifests to `exited`.
    invariant(
      this.#record.status === 'running' || this.#record.status === 'exiting',
      'Cannot record exit after session has exited',
    );
    invariant(
      this.#record.exitCode === null && this.#record.exitSignal === null,
      'Session exit has already been recorded',
    );
    invariant(
      exitCode === null || Number.isInteger(exitCode),
      'Exit code must be an integer or null',
    );
    invariant(
      exitSignal === null || typeof exitSignal === 'string',
      'Exit signal must be a string or null',
    );

    this.#record.exitCode = exitCode;
    this.#record.exitSignal = exitSignal;
    this.#record.status = 'exited';
    this.touch();
  }

  private touch(): void {
    this.#record.updatedAt = new Date().toISOString();
  }
}
