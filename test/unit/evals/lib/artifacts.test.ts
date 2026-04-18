import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeTokenUsageArtifact } from '../../../../evals/lib/artifacts.js';

const VALID_TOKEN_USAGE = {
  inputTokens: 12,
  outputTokens: 8,
  totalTokens: 20,
  cachedTokens: 4,
} as const;

let tempRoot: string | undefined;

async function createTempRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), 'agent-tty-token-usage-artifact-'));
  return tempRoot;
}

afterEach(async () => {
  if (tempRoot !== undefined) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe('writeTokenUsageArtifact', () => {
  it('writes token-usage artifacts at the expected path', async () => {
    const artifactsDir = await createTempRoot();

    const artifactPath = await writeTokenUsageArtifact({
      artifactsDir,
      caseId: 'wait-for-output',
      lane: 'prompt',
      condition: 'none',
      provider: 'fixture',
      model: 'fixture-model',
      trialIndex: 0,
      tokenUsage: VALID_TOKEN_USAGE,
      createdAtMs: 123,
    });

    expect(artifactPath).toBe(
      join(
        artifactsDir,
        'prompt',
        'wait-for-output',
        'none',
        'token-usage.json',
      ),
    );
    expect(JSON.parse(await readFile(artifactPath, 'utf8'))).toEqual({
      caseId: 'wait-for-output',
      lane: 'prompt',
      condition: 'none',
      provider: 'fixture',
      model: 'fixture-model',
      trialIndex: 0,
      tokenUsage: VALID_TOKEN_USAGE,
      createdAtMs: 123,
    });
  });

  it('rejects invalid payloads without leaving partial files behind', async () => {
    const artifactsDir = await createTempRoot();
    const artifactPath = await writeTokenUsageArtifact({
      artifactsDir,
      caseId: 'hello-prompt',
      lane: 'execution',
      condition: 'none',
      provider: 'fixture',
      model: 'fixture-model',
      trialIndex: 0,
      tokenUsage: VALID_TOKEN_USAGE,
      createdAtMs: 456,
    });
    const initialContents = await readFile(artifactPath, 'utf8');

    const invalidArtifact = {
      artifactsDir,
      caseId: 'hello-prompt',
      lane: 'execution',
      condition: 'none',
      provider: 'fixture',
      model: 'fixture-model',
      trialIndex: 0,
      tokenUsage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        unexpected: 99,
      },
      createdAtMs: 789,
    } as unknown as Parameters<typeof writeTokenUsageArtifact>[0];

    await expect(writeTokenUsageArtifact(invalidArtifact)).rejects.toThrow(
      /Token usage artifact validation failed/,
    );
    expect(await readFile(artifactPath, 'utf8')).toBe(initialContents);
    expect(
      await readdir(join(artifactsDir, 'execution', 'hello-prompt', 'none')),
    ).toEqual(['token-usage.json']);
  });
});
