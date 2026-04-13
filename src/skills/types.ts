import { z } from 'zod';

const NonEmptyStringSchema = z.string().min(1);

export const SkillSourceSchema = z.literal('bundled');
export type SkillSource = z.infer<typeof SkillSourceSchema>;

export const SkillFrontmatterSchema = z
  .object({
    name: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    advertise: z.boolean().optional().default(true),
  })
  .strict();
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export const ParsedSkillDocumentSchema = z
  .object({
    frontmatter: SkillFrontmatterSchema,
    body: z.string(),
  })
  .strict();
export type ParsedSkillDocument = z.infer<typeof ParsedSkillDocumentSchema>;

export const SkillSummarySchema = z
  .object({
    name: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    source: SkillSourceSchema,
  })
  .strict();
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

export const SkillListResultSchema = z
  .object({
    skills: z.array(SkillSummarySchema),
  })
  .strict();
export type SkillListResult = z.infer<typeof SkillListResultSchema>;

export const SkillGetResultSchema = z
  .object({
    name: NonEmptyStringSchema,
    source: SkillSourceSchema,
    path: NonEmptyStringSchema,
    content: NonEmptyStringSchema,
  })
  .strict();
export type SkillGetResult = z.infer<typeof SkillGetResultSchema>;

export const SkillPathResultSchema = z
  .object({
    name: NonEmptyStringSchema,
    source: SkillSourceSchema,
    path: NonEmptyStringSchema,
  })
  .strict();
export type SkillPathResult = z.infer<typeof SkillPathResultSchema>;

export const BundledSkillSchema = z
  .object({
    frontmatter: SkillFrontmatterSchema,
    source: SkillSourceSchema,
    path: NonEmptyStringSchema,
    content: NonEmptyStringSchema,
    body: NonEmptyStringSchema,
  })
  .strict();
export type BundledSkill = z.infer<typeof BundledSkillSchema>;
