import type { ZodError } from 'zod';

import { assertString, invariant } from '../util/assert.js';

import {
  ParsedSkillDocumentSchema,
  SkillFrontmatterSchema,
  type ParsedSkillDocument,
} from './types.js';

const FRONTMATTER_OPENING_DELIMITER = '---';
const FRONTMATTER_BLOCK_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

type RawFrontmatterValue = boolean | string;

function formatFrontmatterError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      if (issue.code === 'unrecognized_keys') {
        return `unrecognized frontmatter keys: ${issue.keys.join(', ')}`;
      }

      const path = issue.path.length > 0 ? issue.path.join('.') : 'frontmatter';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function parseFrontmatterLine(
  line: string,
  lineNumber: number,
): [key: string, value: RawFrontmatterValue] {
  const separatorIndex = line.indexOf(':');

  invariant(
    separatorIndex > 0,
    `Invalid skill frontmatter line ${String(lineNumber)}: expected "key: value".`,
  );

  const key = line.slice(0, separatorIndex).trim();
  const rawValue = line.slice(separatorIndex + 1).trim();

  invariant(
    key.length > 0,
    `Skill frontmatter line ${String(lineNumber)} must include a key.`,
  );

  if (key === 'advertise') {
    invariant(
      rawValue === 'true' || rawValue === 'false',
      `Skill frontmatter "advertise" must be true or false on line ${String(lineNumber)}.`,
    );
    return [key, rawValue === 'true'];
  }

  return [key, rawValue];
}

export function parseSkillFrontmatter(markdown: string): ParsedSkillDocument {
  assertString(markdown, 'skill markdown content must be a string');
  invariant(markdown.length > 0, 'skill markdown content must not be empty');
  invariant(
    markdown.startsWith(`${FRONTMATTER_OPENING_DELIMITER}\n`) ||
      markdown.startsWith(`${FRONTMATTER_OPENING_DELIMITER}\r\n`),
    'skill markdown must start with YAML frontmatter delimited by "---".',
  );

  const match = FRONTMATTER_BLOCK_PATTERN.exec(markdown);

  invariant(
    match !== null,
    'skill markdown frontmatter must end with a closing "---" line.',
  );

  const rawFrontmatter = match[1];
  invariant(
    rawFrontmatter !== undefined,
    'skill markdown frontmatter block must be present when delimiters match.',
  );

  const frontmatterValues: Record<string, RawFrontmatterValue> = {};

  for (const [index, line] of rawFrontmatter.split(/\r?\n/u).entries()) {
    const trimmedLine = line.trim();
    const lineNumber = index + 2;

    if (trimmedLine.length === 0) {
      continue;
    }

    const [key, value] = parseFrontmatterLine(trimmedLine, lineNumber);

    invariant(
      !Object.hasOwn(frontmatterValues, key),
      `Duplicate skill frontmatter key "${key}" on line ${String(lineNumber)}.`,
    );
    frontmatterValues[key] = value;
  }

  const parsedFrontmatter = SkillFrontmatterSchema.safeParse(frontmatterValues);

  if (!parsedFrontmatter.success) {
    throw new Error(
      `Invalid skill frontmatter: ${formatFrontmatterError(parsedFrontmatter.error)}`,
    );
  }

  return ParsedSkillDocumentSchema.parse({
    frontmatter: parsedFrontmatter.data,
    body: markdown.slice(match[0].length),
  });
}
