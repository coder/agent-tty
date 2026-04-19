import process from 'node:process';

import { registerPreset } from './registry.js';
import type { WorkspacePreset } from './types.js';

const AGENT_TTY_SMOKE_PRESET: WorkspacePreset = {
  id: 'agent-tty-smoke',
  mode: 'isolated',
  description: 'Deterministic local smoke preset for agent-tty evals.',
  bootstrap: [
    {
      command: process.execPath,
      args: ['-e', 'process.stdout.write("agent-tty-smoke bootstrap ok\\n")'],
      description: 'agent-tty-smoke smoke-probe',
    },
  ],
};

let registered = false;

export function registerBuiltinPresets(): void {
  if (registered) {
    return;
  }

  registerPreset(AGENT_TTY_SMOKE_PRESET);
  registered = true;
}
