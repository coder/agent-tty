import { WorkspacePresetSchema } from './types.js';
import type { WorkspacePreset } from './types.js';

const presetRegistry = new Map<string, WorkspacePreset>();

type SchemaIssue = {
  path: readonly PropertyKey[];
  message: string;
};

function formatSchemaIssues(issues: readonly SchemaIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function getCandidatePresetId(preset: WorkspacePreset): string {
  return preset.id;
}

export function registerPreset(preset: WorkspacePreset): void {
  const parsedPreset = WorkspacePresetSchema.safeParse(preset);
  if (!parsedPreset.success) {
    throw new Error(
      `Invalid workspace preset "${getCandidatePresetId(preset)}": ${formatSchemaIssues(parsedPreset.error.issues)}`,
    );
  }

  if (presetRegistry.has(parsedPreset.data.id)) {
    throw new Error(
      `Workspace preset "${parsedPreset.data.id}" is already registered.`,
    );
  }

  presetRegistry.set(parsedPreset.data.id, parsedPreset.data);
}

export function lookupPreset(id: string): WorkspacePreset {
  const preset = presetRegistry.get(id);
  if (preset !== undefined) {
    return preset;
  }

  const availableIds = Array.from(presetRegistry.keys()).sort((left, right) =>
    left.localeCompare(right),
  );
  if (availableIds.length === 0) {
    throw new Error(
      `Unknown workspace preset "${id}". No workspace presets are registered.`,
    );
  }

  throw new Error(
    `Unknown workspace preset "${id}". Available: [${availableIds.join(', ')}]`,
  );
}

// For unit tests only.
export function clearPresetsForTesting(): void {
  presetRegistry.clear();
}

export function listPresets(): readonly WorkspacePreset[] {
  return Array.from(presetRegistry.values()).sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}
