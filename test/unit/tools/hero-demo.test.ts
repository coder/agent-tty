import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  buildLeakFindings,
  sanitizePromotedText,
  generateDashboardRunner,
  generateRunner,
  generateTape,
  parseHeroDemoArgs,
  selectPromotionRuns,
  selectedAgents,
} from '../../../src/tools/hero-demo.js';

describe('hero demo generator planning', () => {
  it('requires promotion to run both agents at least three times', () => {
    expect(() => parseHeroDemoArgs(['--promote', '--runs', '2'])).toThrow(
      '--promote requires --runs >= 3',
    );
    expect(() =>
      parseHeroDemoArgs(['--promote', '--runs', '3', '--agent', 'codex']),
    ).toThrow('--promote requires --agent both');

    const options = parseHeroDemoArgs(['--promote', '--runs', '3']);
    expect(options.promote).toBe(true);
    expect(options.runs).toBe(3);
    expect(selectedAgents(options.agent)).toEqual(['codex', 'claude']);
  });

  it('generates a Codex VHS tape that opens on a hidden tmux split with the dashboard', () => {
    const tape = generateTape({
      agent: 'codex',
      runnerPath: '/tmp/run-codex.sh',
      dashboardRunnerPath: '/tmp/run-codex-dashboard.sh',
      socket: 'hero-codex-1',
      recordSeconds: 120,
    });

    expect(tape).toContain('Output outer.webm');
    expect(tape).toContain('Output outer.ascii');
    expect(tape).toContain(
      'Wait+Screen@120s /Do you trust|OpenAI Codex|Codex/',
    );
    expect(tape).toContain('Set Width 1920');
    expect(tape).toContain('Set Height 900');
    expect(tape).toContain('Set FontSize 14');
    expect(tape).toContain('Set Framerate 5');
    expect(tape).toContain('Sleep 120s');
    expect(tape).toContain('Ctrl+C');
    expect(tape).toContain('Type "/quit"');

    // One tmux command builds the whole split: pane 0 (LEFT) runs the agent
    // directly (no visible `exec bash`), pane 1 (RIGHT) runs the dashboard,
    // status bar off, then attach.
    expect(tape).toContain(
      "tmux -f /dev/null -L hero-codex-1 new-session -d -s hero 'bash /tmp/run-codex.sh'",
    );
    expect(tape).toContain(
      "split-window -h -d -l 40% -t hero 'bash /tmp/run-codex-dashboard.sh'",
    );
    expect(tape).toContain('set -g status off');
    expect(tape).toContain('attach -t hero');
    expect(tape).not.toContain('exec bash');

    // The setup is hidden so the recording opens directly on the split:
    // Hide → split command → Show → (visible) agent-UI wait → record window;
    // and the teardown stays hidden (a 2nd Hide after the window, no Show after).
    const lines = tape.split('\n');
    const firstHide = lines.indexOf('Hide');
    const setupLine = lines.findIndex((line) =>
      line.includes('new-session -d -s hero'),
    );
    const showLine = lines.indexOf('Show');
    const uiWaitLine = lines.findIndex((line) =>
      line.startsWith('Wait+Screen@120s /OpenAI Codex'),
    );
    const recordLine = lines.indexOf('Sleep 120s');
    expect(firstHide).toBeGreaterThanOrEqual(0);
    expect(setupLine).toBeGreaterThan(firstHide);
    expect(showLine).toBeGreaterThan(setupLine);
    expect(uiWaitLine).toBeGreaterThan(showLine);
    expect(recordLine).toBeGreaterThan(uiWaitLine);
    expect(lines.lastIndexOf('Hide')).toBeGreaterThan(recordLine);
    expect(lines.lastIndexOf('Show')).toBeLessThan(lines.lastIndexOf('Hide'));
  });

  it('generates a Claude VHS tape with Claude-specific waits and a hidden dashboard split', () => {
    const tape = generateTape({
      agent: 'claude',
      runnerPath: '/tmp/run-claude.sh',
      dashboardRunnerPath: '/tmp/run-claude-dashboard.sh',
      socket: 'hero-claude-1',
      recordSeconds: 180,
    });

    expect(tape).toContain(
      "tmux -f /dev/null -L hero-claude-1 new-session -d -s hero 'bash /tmp/run-claude.sh'",
    );
    expect(tape).toContain(
      "split-window -h -d -l 40% -t hero 'bash /tmp/run-claude-dashboard.sh'",
    );
    expect(tape).toContain(
      'Wait+Screen@120s /Quick safety check|Claude Code|Yes, I trust|Welcome/',
    );
    expect(tape).toContain(
      'Wait+Screen@120s /Claude Code|Welcome|esc to interrupt/',
    );
    expect(tape).toContain('Sleep 180s');
    expect(tape).toContain('Type "/exit"');
  });

  it('generates a dashboard runner that shares AGENT_TTY_HOME and launches the dashboard', () => {
    const runner = generateDashboardRunner({
      installPrefix: '/tmp/install',
      innerHome: '/tmp/inner-home',
    });

    expect(runner).toContain("export PATH='/tmp/install/bin':$PATH");
    expect(runner).toContain("export AGENT_TTY_HOME='/tmp/inner-home'");
    expect(runner).toContain('exec agent-tty dashboard --all');
  });

  // The README hero tape (assets/hero.tape) is a hand-maintained static file
  // that cannot be exercised in CI (it drives a real host), so guard its
  // load-bearing invariants against silent drift here.
  it('keeps the static README hero tape splitting tmux with a shared-home dashboard', () => {
    const tape = readFileSync(
      new URL('../../../assets/hero.tape', import.meta.url),
      'utf8',
    );

    // The dashboard pane only sees the operator pane's sessions if AGENT_TTY_HOME
    // is exported into the environment tmux (and both panes) inherit — i.e.
    // before the server is started.
    const exportIndex = tape.indexOf('export AGENT_TTY_HOME=');
    const newSessionIndex = tape.indexOf(
      'tmux -f /dev/null -L hero new-session',
    );
    expect(exportIndex).toBeGreaterThanOrEqual(0);
    expect(newSessionIndex).toBeGreaterThan(exportIndex);

    // `dashboard` is unreleased, so the tape must use THIS checkout's dev CLI,
    // not a (possibly older) globally-installed agent-tty — i.e. no
    // `Require agent-tty` directive (a comment mentioning it is fine).
    expect(tape).toContain('dist/cli/main.js');
    const directives = tape
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('#'));
    expect(directives).not.toContain('Require agent-tty');

    expect(tape).toContain('set -g status off');
    expect(tape).toContain('split-window -h');
    // The panes (and the session) use `bash --norc` + a minimal `$ ` prompt so
    // the dashboard mirror stays free of personal prompt clutter (e.g. zsh
    // `%{…%}` escapes) — that was the visible-ugliness bug this guards against.
    expect(tape).toContain("'bash --norc'");
    expect(tape).toMatch(/PS1=/);
    // The dashboard is launched by *typing* the command in the right pane (so
    // viewers see how), not by baking it into the hidden split command.
    expect(tape).toContain('Type "agent-tty dashboard --all"');
    // Showcase: fire a non-blocking slow command (the SESSION expands $RANDOM
    // after sleeping), then demonstrate deterministic waiting on screen text
    // instead of sleeping/polling in the driving shell.
    expect(tape).toContain('agent-tty run --no-wait');
    expect(tape).toMatch(/sleep \d+; echo your random number is: \$RANDOM/);
    // The wait MUST match a digit via --regex, not the phrase via --text: the
    // echoed `run` command already puts "your random number is:" on screen, so a
    // --text wait would return instantly. Only the digits appear after the sleep.
    expect(tape).toMatch(/agent-tty wait .*--regex.*\[0-9\]/);
    expect(tape).not.toContain('--text "your random number is:"');
    // Teardown destroys the session, reaps the server, and removes the temp home.
    expect(tape).toContain('agent-tty destroy "$SID"');
    expect(tape).toContain('tmux -L hero kill-server');
    expect(tape).toContain('rm -rf "$AGENT_TTY_HOME"');
    // Teardown must stay hidden to the end: a `Show` after the teardown
    // `kill-server` would flash the bare outer shell tmux exits back to on the
    // final frame. Compare directive lines (so prose mentioning "Show" or the
    // setup pre-kill `… kill-server 2>/dev/null` don't interfere).
    const tapeLines = tape.split('\n');
    const lastShowLine = tapeLines.findLastIndex(
      (line) => line.trim() === 'Show',
    );
    const teardownKillLine = tapeLines.findLastIndex((line) =>
      line.includes('Type "tmux -L hero kill-server"'),
    );
    expect(lastShowLine).toBeGreaterThanOrEqual(0);
    expect(teardownKillLine).toBeGreaterThan(lastShowLine);
  });

  it('generates agent-specific runners with configurable model and effort', () => {
    const codexRunner = generateRunner({
      agent: 'codex',
      workspace: '/tmp/workspace',
      promptPath: '/tmp/prompt.md',
      installPrefix: '/tmp/install',
      innerHome: '/tmp/inner-home',
      finalFile: '/tmp/workspace/demo-note.txt',
      innerCast: '/tmp/workspace/artifacts/inner.cast',
      innerWebm: '/tmp/workspace/artifacts/inner.webm',
      expectedText: 'demo text',
      codexModel: 'gpt-demo',
      codexEffort: 'minimal',
      claudeModel: 'claude-demo',
      claudeEffort: 'low',
    });
    expect(codexRunner).toContain("--model 'gpt-demo'");
    expect(codexRunner).toContain("model_reasoning_effort='minimal'");
    expect(codexRunner).toContain('CODEX_DISABLE_UPDATE_CHECK=1');
    expect(codexRunner).toContain('AGENT_TTY_HOME');

    const claudeRunner = generateRunner({
      agent: 'claude',
      workspace: '/tmp/workspace',
      promptPath: '/tmp/prompt.md',
      installPrefix: '/tmp/install',
      innerHome: '/tmp/inner-home',
      finalFile: '/tmp/workspace/demo-note.txt',
      innerCast: '/tmp/workspace/artifacts/inner.cast',
      innerWebm: '/tmp/workspace/artifacts/inner.webm',
      expectedText: 'demo text',
      codexModel: 'gpt-demo',
      codexEffort: 'minimal',
      claudeModel: 'claude-demo',
      claudeEffort: 'medium',
    });
    expect(claudeRunner).toContain("--model 'claude-demo'");
    expect(claudeRunner).toContain("--effort 'medium'");
    for (const runner of [codexRunner, claudeRunner]) {
      expect(runner).toContain(
        "export HERO_FINAL_FILE='/tmp/workspace/demo-note.txt'",
      );
      expect(runner).toContain(
        "export HERO_INNER_CAST='/tmp/workspace/artifacts/inner.cast'",
      );
      expect(runner).toContain(
        "export HERO_INNER_WEBM='/tmp/workspace/artifacts/inner.webm'",
      );
      expect(runner).toContain("export HERO_EXPECTED_TEXT='demo text'");
    }
    expect(claudeRunner).toContain('unset ANTHROPIC_API_KEY');
  });

  it('selects the first passing promoted run per agent', () => {
    expect(
      selectPromotionRuns([
        { agent: 'codex', index: 1, passed: false },
        { agent: 'codex', index: 2, passed: true },
        { agent: 'codex', index: 3, passed: true },
        { agent: 'codex', index: 4, passed: true },
        { agent: 'claude', index: 1, passed: true },
        { agent: 'claude', index: 2, passed: false },
        { agent: 'claude', index: 3, passed: true },
        { agent: 'claude', index: 4, passed: true },
      ]),
    ).toEqual([
      { agent: 'codex', index: 2 },
      { agent: 'claude', index: 1 },
    ]);
  });

  it('rejects promotion when either agent has too few passing runs', () => {
    expect(() =>
      selectPromotionRuns([
        { agent: 'codex', index: 1, passed: true },
        { agent: 'codex', index: 2, passed: true },
        { agent: 'claude', index: 1, passed: true },
        { agent: 'claude', index: 2, passed: true },
        { agent: 'claude', index: 3, passed: true },
      ]),
    ).toThrow('codex only had 2 successful run(s)');
  });

  it('shell-quotes paths containing apostrophes in generated runners', () => {
    const runner = generateRunner({
      agent: 'claude',
      workspace: "/tmp/it's-fine",
      promptPath: '/tmp/prompt.md',
      installPrefix: '/tmp/install',
      innerHome: '/tmp/inner-home',
      finalFile: '/tmp/final.txt',
      innerCast: '/tmp/inner.cast',
      innerWebm: '/tmp/inner.webm',
      expectedText: 'demo text',
      codexModel: 'gpt-demo',
      codexEffort: 'minimal',
      claudeModel: 'claude-demo',
      claudeEffort: 'medium',
    });

    expect(runner).toContain("cd '/tmp/it'\\''s-fine'");
  });

  it('sanitizes promoted text before leak checking', () => {
    const sanitized = sanitizePromotedText(
      'Welcome back Alice\nAPI Usage Billing\n/home/alice/project\nANTHROPIC_API_KEY\n',
    );
    expect(sanitized).not.toContain('Alice');
    expect(sanitized).not.toContain('API Usage Billing');
    expect(sanitized).not.toContain('/home/alice');
    expect(buildLeakFindings(sanitized)).toEqual([]);
  });

  it('covers every account-sensitive leak pattern', () => {
    expect(
      buildLeakFindings(
        [
          '/Users/alice/project',
          'alice@example.invalid',
          'OPENAI_API_KEY',
          'Auth conflict detected',
          'tok_abcdefghijklmnop',
        ].join('\n'),
      ),
    ).toEqual([
      'absolute macOS home path',
      'email address',
      'OpenAI credential variable',
      'auth warning',
      'token-like secret',
    ]);
  });

  it('flags account-sensitive leakage but allows generic update text', () => {
    expect(
      buildLeakFindings('Update available! Run mise upgrade claude'),
    ).toEqual([]);
    expect(
      buildLeakFindings(
        'Welcome back Alice!\nAPI Usage Billing\n/home/alice/project\nANTHROPIC_API_KEY',
      ),
    ).toEqual([
      'absolute Linux home path',
      'Anthropic credential variable',
      'account/billing line',
      'account greeting',
    ]);
  });
});
