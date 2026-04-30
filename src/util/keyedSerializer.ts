export class KeyedSerializer<K> {
  private readonly chains = new Map<K, Promise<unknown>>();

  /**
   * Runs `operation` after any in-flight operation for the same `key` has
   * settled. Operations for different keys may run concurrently.
   *
   * If the previous operation in the same key's chain rejects, this
   * operation inherits that rejection without running (cascading failure).
   * Once the chain drains, a fresh chain is started for the next call.
   *
   * **Re-entrance hazard**: do not call `run(key, ...)` from inside an
   * operation that was itself queued under the same `key`. The inner call
   * chains onto the outer call's promise, which is awaiting the inner
   * call - the returned promise hangs forever. Re-entrance with a
   * different key is safe.
   */
  public run<T>(key: K, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    // Single-argument .then() is intentional: a predecessor rejection should
    // skip this operation while the active chain drains, so callers see the
    // upstream failure instead of running on an undefined precondition.
    const queued = previous
      .then(() => operation())
      .finally(() => {
        if (this.chains.get(key) === queued) {
          this.chains.delete(key);
        }
      });
    this.chains.set(key, queued);
    return queued;
  }
}
