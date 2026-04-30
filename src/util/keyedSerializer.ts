export class KeyedSerializer<K> {
  private readonly chains = new Map<K, Promise<unknown>>();

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
