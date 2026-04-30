/**
 * Shared error-message helpers for the AFK Triage runner.
 *
 * Centralises:
 * - {@link errorMessage}: stringify any thrown value safely (deduped from
 *   `main.ts` and `gh.ts` so the two cannot drift).
 * - {@link conciseErrorMessage}: first-line summary for inclusion in the
 *   per-issue summary printed to stdout.
 * - {@link isLockError}: pure predicate that classifies a Coder CLI failure
 *   as a workspace-name lock vs. a genuine triage failure. Pure so the test
 *   suite can verify it against realistic Coder CLI strings without needing
 *   a live workspace.
 */

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function conciseErrorMessage(error: unknown): string {
  return errorMessage(error).split('\n')[0]?.trim() || 'unknown error';
}

/**
 * True when `error` looks like Coder CLI's workspace-name conflict, e.g.
 * `Error: A workspace named "agent-tty-triage-79" already exists ...`.
 *
 * Requires both the workspace name and the `already exists` substring in
 * the concise (first-line) error message so unrelated SSH/network/cleanup
 * errors that incidentally mention the workspace name are not silently
 * classified as locks and dropped from retry consideration.
 */
export function isLockError(error: unknown, workspaceName: string): boolean {
  const message = conciseErrorMessage(error).toLowerCase();
  return (
    message.includes(workspaceName.toLowerCase()) &&
    message.includes('already exists')
  );
}
