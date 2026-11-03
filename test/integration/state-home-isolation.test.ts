import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSession, destroySession } from '../helpers.js';
import { isWithinRoot } from '../../src/util/isWithinRoot.js';

describe('test state isolation', () => {
  let testHome = '';

  beforeEach(() => {
    // oxfmt-ignore
    testHome = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tty-state-isolation-')));
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    testHome = '';
  });

  it('keeps the Home Registry of a create through runCli out of the real state folder', () => {
    const stateHome = process.env.XDG_STATE_HOME;
    expect(stateHome).toBeDefined();
    expect(
      isWithinRoot(realpathSync(tmpdir()), realpathSync(stateHome ?? '')),
    ).toBe(true);

    const sessionId = createSession(testHome);
    destroySession(testHome, sessionId);

    const testRegistry = join(stateHome ?? '', 'agent-tty', 'homes.json');
    expect(readFileSync(testRegistry, 'utf8')).toContain(testHome);

    const realRegistry = join(
      homedir(),
      '.local',
      'state',
      'agent-tty',
      'homes.json',
    );
    if (existsSync(realRegistry)) {
      expect(readFileSync(realRegistry, 'utf8')).not.toContain(testHome);
    }
  });
});
