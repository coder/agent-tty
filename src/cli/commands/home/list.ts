import { emitSuccess } from '../../output.js';
import {
  listRegisteredHomes,
  type HomeListingScope,
  type RegisteredHome,
} from '../../../storage/homeScope.js';

const COMMAND_NAME = 'home list';

export interface HomeListResult {
  homes: RegisteredHome[];
}

export interface HomeListCommandOptions {
  json: boolean;
  all: boolean;
}

export interface HomeListCommandDependencies {
  listHomes?: (scope: HomeListingScope) => Promise<RegisteredHome[]>;
}

function buildHomeListLines(homes: RegisteredHome[]): string[] {
  if (homes.length === 0) {
    return ['No registered Homes.'];
  }

  return homes.map(
    (home) =>
      `${home.path}  ${String(home.activeSessions)}/${String(home.totalSessions)} active  last seen ${home.lastSeenAt}`,
  );
}

export async function runHomeListCommand(
  options: HomeListCommandOptions,
  dependencies: HomeListCommandDependencies = {},
): Promise<void> {
  const scope: HomeListingScope = options.all ? 'all' : 'active';
  const listHomes = dependencies.listHomes ?? listRegisteredHomes;
  const homes = await listHomes(scope);

  const result: HomeListResult = { homes };
  emitSuccess({
    command: COMMAND_NAME,
    json: options.json,
    result,
    lines: buildHomeListLines(homes),
  });
}
