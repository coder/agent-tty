export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function conciseErrorMessage(error: unknown): string {
  return errorMessage(error).split('\n')[0]?.trim() || 'unknown error';
}

// Match only first-line Coder workspace-name conflicts.
export function isLockError(error: unknown, workspaceName: string): boolean {
  const message = conciseErrorMessage(error).toLowerCase();
  return (
    message.includes(workspaceName.toLowerCase()) &&
    message.includes('already exists')
  );
}
