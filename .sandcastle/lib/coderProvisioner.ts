import { coder, type CoderOptions } from '../vendor/sandcastle-coder/coder.js';
import type { TriageIssue } from './eligibility.js';
import { runCoderAsync } from './gh.js';

// Production knobs for the AFK Triage Coder workspace and Triage Agent.
// These are intentionally hard-coded; if a future deployment needs to vary
// any of them, expose them through CoderProvisionerDeps.
const TRIAGE_AGENT_IDLE_TIMEOUT_SECONDS = 1800;
const CODER_TEMPLATE = 'coder';
const CODER_PRESET = 'Falkenstein';
const TRIAGE_AGENT_MODEL = 'claude-opus-4-6';
const TRIAGE_PROMPT_FILE = '.sandcastle/triage-prompt.md';

const SANDBOX_READY_HOOKS = [
  { command: 'gh auth status' },
  // Sandcastle syncs git-tracked files only; install deps before triage.
  { command: 'npm ci' },
  { command: 'npm install -g @anthropic-ai/claude-code' },
] as const;

/**
 * The minimal subset of `@ai-hero/sandcastle` the provisioner pulls in via
 * dynamic import. Tests fake this; production callers let it default to a
 * real import.
 */
export type SandcastleImports = Pick<
  typeof import('@ai-hero/sandcastle'),
  'createSandbox' | 'claudeCode'
>;

export interface ProvisionContext {
  readonly issue: TriageIssue;
  readonly runId: string;
  readonly workspaceName: string;
  readonly branchName: string;
}

export interface ProvisionedAgent {
  /** Run the Triage Agent prompt against the prepared Coder workspace. */
  run(): Promise<void>;
  /** Tear down the Coder workspace (best-effort onClose: 'delete'). */
  close(): Promise<void>;
}

export type WorkspaceDeleteResult =
  | { readonly outcome: 'deleted' }
  | {
      readonly outcome: 'failed';
      readonly status: number;
      readonly stderr: string;
    };

export interface CoderProvisioner {
  /**
   * Create a Coder workspace and prepare the Triage Agent that will run
   * inside it. Throws on workspace-name conflict so callers can map the
   * error to 'locked' via isLockError.
   */
  provision(ctx: ProvisionContext): Promise<ProvisionedAgent>;

  /**
   * Reap a workspace whose `provision()` never resolved a ProvisionedAgent
   * (in-flight workspace creates during shutdown). May reject for spawn
   * errors; non-zero exits resolve as { outcome: 'failed', status, stderr }.
   */
  deleteWorkspace(workspaceName: string): Promise<WorkspaceDeleteResult>;
}

export interface CoderProvisionerDeps {
  readonly importSandcastle?: () => Promise<SandcastleImports>;
  readonly runCoderAsync?: typeof runCoderAsync;
}

export function createCoderProvisioner(
  deps: CoderProvisionerDeps = {},
): CoderProvisioner {
  const importSandcastle =
    deps.importSandcastle ??
    (() => import('@ai-hero/sandcastle') as Promise<SandcastleImports>);
  const runCoderAsyncImpl = deps.runCoderAsync ?? runCoderAsync;

  return {
    async provision(ctx: ProvisionContext): Promise<ProvisionedAgent> {
      const { createSandbox, claudeCode } = await importSandcastle();

      const coderOptions: CoderOptions = {
        template: CODER_TEMPLATE,
        preset: CODER_PRESET,
        workspaceName: ctx.workspaceName,
        onClose: 'delete',
      };

      // Use sandcastle's HEAD default for the base branch so AFK triage sees this checkout.
      const sandbox = await createSandbox({
        branch: ctx.branchName,
        sandbox: coder(coderOptions),
        hooks: {
          sandbox: {
            onSandboxReady: [...SANDBOX_READY_HOOKS],
          },
        },
      });

      return {
        run: async (): Promise<void> => {
          await sandbox.run({
            agent: claudeCode(TRIAGE_AGENT_MODEL),
            promptFile: TRIAGE_PROMPT_FILE,
            promptArgs: {
              ISSUE_NUMBER: String(ctx.issue.number),
            },
            idleTimeoutSeconds: TRIAGE_AGENT_IDLE_TIMEOUT_SECONDS,
          });
        },
        close: async (): Promise<void> => {
          await sandbox.close();
        },
      };
    },

    async deleteWorkspace(
      workspaceName: string,
    ): Promise<WorkspaceDeleteResult> {
      // Use the async runCoderAsync (spawn) variant rather than the sync
      // runCoder (spawnSync) one: the synchronous variant blocks the event
      // loop, which would prevent a second SIGINT from being delivered to
      // the force-exit branch of the signal handler while a hung
      // `coder delete` is in progress. The async variant yields between
      // chunks so that escape hatch keeps working.
      const result = await runCoderAsyncImpl([
        'delete',
        workspaceName,
        '--yes',
      ]);
      if (result.status === 0) {
        return { outcome: 'deleted' };
      }
      return {
        outcome: 'failed',
        status: result.status,
        stderr: result.stderr,
      };
    },
  };
}
