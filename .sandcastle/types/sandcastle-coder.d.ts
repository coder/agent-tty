// Local type stub for the unreleased @ai-hero/sandcastle Coder provider.
// mattpocock/sandcastle#495 (commit 4c5ddb8821d7ba8287a08c4950dc8e886a0e3e3a)
// adds the @ai-hero/sandcastle/sandboxes/coder export, but it is not present
// in the published ^0.5.6 package yet. Delete this stub and point the
// dependency at a released package once that export ships upstream.

declare module '@ai-hero/sandcastle/sandboxes/coder' {
  /** From mattpocock/sandcastle#495. */
  export type CoderOnClose = 'delete' | 'stop' | 'leave';

  /** Discriminated union of create-from-template and attach-existing options. */
  export type CoderSandboxOptions =
    | {
        readonly template: string;
        readonly onClose: CoderOnClose;
        readonly workspaceName?: string;
        readonly templateVersion?: string;
        readonly parameters?: Readonly<
          Record<string, string | number | boolean>
        >;
        readonly parameterFile?: string;
        readonly preset?: string;
        readonly organization?: string;
        readonly url?: string;
        readonly token?: string;
        readonly env?: Readonly<Record<string, string>>;
        readonly workspaceAgent?: string;
        readonly workdir?: string;
      }
    | {
        readonly workspace: string;
        readonly onClose: CoderOnClose;
        readonly owner?: string;
        readonly url?: string;
        readonly token?: string;
        readonly env?: Readonly<Record<string, string>>;
        readonly workspaceAgent?: string;
        readonly workdir?: string;
      };

  // Sandcastle's IsolatedSandboxProvider is opaque to consumers; re-declare it
  // narrowly so the runner can type the return value without importing the
  // private internal symbol.
  export type IsolatedSandboxProvider = unknown & {
    readonly __coderProvider: unique symbol;
  };

  export function coder(options: CoderSandboxOptions): IsolatedSandboxProvider;
}
