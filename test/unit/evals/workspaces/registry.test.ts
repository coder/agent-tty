import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearPresetsForTesting,
  listPresets,
  lookupPreset,
  registerPreset,
} from '../../../../evals/workspaces/registry.js';
import type { WorkspacePreset } from '../../../../evals/workspaces/types.js';

function createPreset(id: string): WorkspacePreset {
  return {
    id,
    mode: 'isolated',
    description: `${id || 'workspace'} preset description`,
  };
}

beforeEach(() => {
  clearPresetsForTesting();
});

describe('workspace preset registry', () => {
  it('registers a minimal valid preset and looks it up by id', () => {
    const preset = createPreset('alpha');

    registerPreset(preset);

    expect(lookupPreset('alpha')).toEqual(preset);
  });

  it('rejects duplicate preset ids', () => {
    registerPreset(createPreset('duplicate-id'));

    expect(() => registerPreset(createPreset('duplicate-id'))).toThrow(
      'Workspace preset "duplicate-id" is already registered.',
    );
  });

  it.each(['Bad-ID', '', '_leading-underscore'])(
    'rejects invalid preset id %j',
    (id) => {
      const registerInvalidPreset = () => registerPreset(createPreset(id));

      expect(registerInvalidPreset).toThrow(`Invalid workspace preset "${id}"`);
      expect(registerInvalidPreset).toThrow(
        'id must match /^[a-z0-9][a-z0-9-_]*$/',
      );
    },
  );

  it('lists sorted available ids when lookup misses', () => {
    registerPreset(createPreset('zeta'));
    registerPreset(createPreset('alpha'));
    registerPreset(createPreset('beta'));

    expect(() => lookupPreset('missing-preset')).toThrow(
      'Unknown workspace preset "missing-preset". Available: [alpha, beta, zeta]',
    );
  });

  it('reports that no presets are registered when lookup misses on an empty registry', () => {
    expect(() => lookupPreset('missing-preset')).toThrow(
      'Unknown workspace preset "missing-preset". No workspace presets are registered.',
    );
  });

  it('returns a sorted snapshot from listPresets', () => {
    const gamma = createPreset('gamma');
    const alpha = createPreset('alpha');
    const beta = createPreset('beta');

    registerPreset(gamma);
    registerPreset(alpha);
    registerPreset(beta);

    expect(listPresets()).toEqual([alpha, beta, gamma]);
  });
});
