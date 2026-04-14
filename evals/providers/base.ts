import { invariant, unreachable } from '../../src/util/assert.js';
import type {
  NormalizedProviderOutput,
  ProviderAgentRequest,
  ProviderAgentResult,
  ProviderConfig,
  ProviderPromptRequest,
  ProviderPromptResult,
  ProviderRuntimeInfo,
} from '../lib/types.js';
import {
  FixtureProvider,
  RecordingProvider,
  StubProvider,
} from './fixtures.js';

/** Supported provider identifiers for the eval foundation. */
export const SUPPORTED_PROVIDER_IDS = ['stub', 'fixture', 'recording'] as const;

type SupportedProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];

/** Construction options shared across built-in provider factories. */
export type ProviderFactoryConfig = Partial<ProviderConfig> & {
  fixtureDir?: string;
  wrappedProvider?: EvalProvider;
  wrappedProviderId?: string;
};

/** Common interface implemented by every eval provider adapter. */
export interface EvalProvider {
  readonly id: string;
  detect(): Promise<ProviderRuntimeInfo>;
  invokePlanMode(request: ProviderPromptRequest): Promise<ProviderPromptResult>;
  invokeAgentMode(request: ProviderAgentRequest): Promise<ProviderAgentResult>;
  parse(raw: string): NormalizedProviderOutput;
}

function isSupportedProviderId(id: string): id is SupportedProviderId {
  return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(id);
}

function stripRecordingConfig(
  config: ProviderFactoryConfig,
): Omit<ProviderFactoryConfig, 'wrappedProvider' | 'wrappedProviderId'> {
  const { wrappedProvider, wrappedProviderId, ...rest } = config;
  void wrappedProvider;
  void wrappedProviderId;
  return rest;
}

/** Creates one of the built-in eval providers. */
export function createProvider(
  id: string,
  config: ProviderFactoryConfig = {},
): EvalProvider {
  if (!isSupportedProviderId(id)) {
    invariant(
      false,
      `Unknown provider id: ${id}. Supported: stub, fixture, recording`,
    );
  }

  switch (id) {
    case 'stub':
      return new StubProvider(stripRecordingConfig(config));
    case 'fixture': {
      invariant(
        typeof config.fixtureDir === 'string' && config.fixtureDir.length > 0,
        'Fixture provider requires config.fixtureDir',
      );
      return new FixtureProvider({
        ...stripRecordingConfig(config),
        fixtureDir: config.fixtureDir,
      });
    }
    case 'recording': {
      if (config.wrappedProvider !== undefined) {
        return new RecordingProvider(config.wrappedProvider);
      }

      invariant(
        typeof config.wrappedProviderId === 'string' &&
          config.wrappedProviderId.length > 0,
        'Recording provider requires config.wrappedProvider or config.wrappedProviderId',
      );
      invariant(
        config.wrappedProviderId !== 'recording',
        'Recording provider cannot wrap wrappedProviderId=recording without an explicit wrappedProvider',
      );
      return new RecordingProvider(
        createProvider(config.wrappedProviderId, stripRecordingConfig(config)),
      );
    }
    default:
      return unreachable(id, 'unsupported provider id');
  }
}
