import { afterEach, describe, expect, it, vi } from 'vitest';

import { runHomeListCommand } from '../../../src/cli/commands/home/list.js';
import type {
  HomeListingScope,
  RegisteredHome,
} from '../../../src/storage/homeScope.js';
import type { SuccessEnvelope } from '../../helpers.js';

function getWrittenStdout(calls: readonly unknown[][]): string {
  expect(calls).toHaveLength(1);
  const [output] = calls[0] ?? [];
  if (typeof output !== 'string') {
    throw new Error('expected stdout to be written as a string');
  }
  return output;
}

const SAMPLE: RegisteredHome[] = [
  {
    path: '/homes/newest',
    activeSessions: 1,
    totalSessions: 3,
    lastSeenAt: '2026-06-08T00:00:00.000Z',
  },
  {
    path: '/homes/older',
    activeSessions: 0,
    totalSessions: 2,
    lastSeenAt: '2026-06-01T00:00:00.000Z',
  },
];

describe('home list command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('widens to all scope with --all and renders one line per Home', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const scopes: HomeListingScope[] = [];
    const listHomes = (scope: HomeListingScope): Promise<RegisteredHome[]> => {
      scopes.push(scope);
      return Promise.resolve(SAMPLE);
    };

    await runHomeListCommand({ json: false, all: true }, { listHomes });

    expect(scopes).toEqual(['all']);
    const output = getWrittenStdout(stdout.mock.calls as unknown[][]);
    expect(output).toContain(
      '/homes/newest  1/3 active  last seen 2026-06-08T00:00:00.000Z',
    );
    expect(output).toContain(
      '/homes/older  0/2 active  last seen 2026-06-01T00:00:00.000Z',
    );
  });

  it('defaults to active scope', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const scopes: HomeListingScope[] = [];

    await runHomeListCommand(
      { json: false, all: false },
      {
        listHomes: (scope) => {
          scopes.push(scope);
          return Promise.resolve([]);
        },
      },
    );

    expect(scopes).toEqual(['active']);
  });

  it('emits a JSON envelope carrying the Homes', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runHomeListCommand(
      { json: true, all: false },
      { listHomes: () => Promise.resolve(SAMPLE) },
    );

    const parsed = JSON.parse(
      getWrittenStdout(stdout.mock.calls as unknown[][]),
    ) as SuccessEnvelope<{ homes: RegisteredHome[] }>;
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('home list');
    expect(parsed.result.homes).toEqual(SAMPLE);
  });

  it('renders a friendly line when no Homes are registered', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runHomeListCommand(
      { json: false, all: false },
      { listHomes: () => Promise.resolve([]) },
    );

    expect(getWrittenStdout(stdout.mock.calls as unknown[][])).toBe(
      'No registered Homes.\n',
    );
  });
});
