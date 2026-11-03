import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterAll } from 'vitest';

// Every CLI a test spawns inherits this, so `create` never writes the user's
// real Home Registry. A test that sets XDG_STATE_HOME itself still wins.
const stateHome = mkdtempSync(join(tmpdir(), 'agent-tty-test-state-'));
process.env.XDG_STATE_HOME = stateHome;

afterAll(() => {
  rmSync(stateHome, { recursive: true, force: true });
});
