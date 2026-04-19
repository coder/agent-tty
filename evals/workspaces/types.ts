import { z } from 'zod';

const NonEmptyStringSchema = z.string().min(1);
const WorkspacePresetIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-_]*$/, 'id must match /^[a-z0-9][a-z0-9-_]*$/');
const StringRecordSchema = z.record(NonEmptyStringSchema, z.string());

const WorkspaceBootstrapStepSchema = z
  .object({
    command: NonEmptyStringSchema,
    args: z.array(z.string()).optional(),
    description: NonEmptyStringSchema.optional(),
  })
  .strict();

export const WorkspacePresetSchema = z
  .object({
    id: WorkspacePresetIdSchema,
    mode: z.enum(['isolated', 'shared']),
    description: NonEmptyStringSchema,
    templateDir: NonEmptyStringSchema.optional(),
    bootstrap: z.array(WorkspaceBootstrapStepSchema).optional(),
    cwd: NonEmptyStringSchema.optional(),
    env: StringRecordSchema.optional(),
  })
  .strict();

export type WorkspacePreset = z.infer<typeof WorkspacePresetSchema>;

type ResolvedWorkspaceBootstrapStep = {
  command: string;
  args: readonly string[];
  description?: string;
};

export type ResolvedWorkspacePlan = {
  presetId: string;
  mode: 'isolated' | 'shared';
  description: string;
  templateDir?: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  bootstrap: ReadonlyArray<ResolvedWorkspaceBootstrapStep>;
  bootstrapCount: number;
};
