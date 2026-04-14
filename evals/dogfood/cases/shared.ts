import { invariant } from '../../../src/util/assert.js';

export function dogfoodTaskPrompt(task: string, fixture?: string): string {
  const normalizedTask = task.trim();
  invariant(normalizedTask.length > 0, 'dogfood task prompt must not be empty');

  return [
    'ACTUALLY PERFORM this dogfood task by running agent-tty CLI commands via `npx tsx src/cli/main.ts`; do not only describe what you would test.',
    'Use the isolated `AGENT_TTY_HOME` provided for this eval so session state and artifacts stay contained.',
    fixture === undefined
      ? undefined
      : `Target the repository fixture app \`${fixture}\` from \`test/fixtures/apps/${fixture}/main.ts\` for this investigation.`,
    'Capture the requested evidence bundle artifacts in the provided proof-bundle directory, including screenshots, recordings, snapshots, WebM exports, and structured notes whenever the case requires them.',
    normalizedTask,
  ]
    .filter((section): section is string => section !== undefined)
    .join(' ');
}
