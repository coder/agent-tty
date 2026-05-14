/**
 * Returns `true` when the thrown value is a Node-style error whose `code`
 * matches the given identifier (e.g. `'ENOENT'`, `'EACCES'`, `'ESRCH'`).
 *
 * Accepts any unknown value and falls back to `false` when the value is not
 * an Error or lacks a `code` property, so callers can use this in catch
 * blocks without further type guards.
 */
export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === code;
}
