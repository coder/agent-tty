const {
  boundedCharBudget,
  boundedLimit,
  inputObject,
  normalizeIssue,
  optionalString,
  repositoryFromInput,
  stringList,
  truncateText,
} = require('../../workflow-action-lib/github.cjs');

export const metadata = {
  version: 1,
  description: 'List GitHub issues with reusable label/state filters',
  effect: 'read',
  inputSchema: mux.schema.object(
    {
      repository: mux.schema.optional(mux.schema.string()),
      owner: mux.schema.optional(mux.schema.string()),
      repo: mux.schema.optional(mux.schema.string()),
      state: mux.schema.optional(mux.schema.string()),
      includeLabels: mux.schema.optional(mux.schema.array(mux.schema.string())),
      excludeLabels: mux.schema.optional(mux.schema.array(mux.schema.string())),
      limit: mux.schema.optional(mux.schema.integer()),
      includeBody: mux.schema.optional(mux.schema.boolean()),
      bodyCharBudget: mux.schema.optional(mux.schema.integer()),
    },
    { additionalProperties: false },
  ),
  outputSchema: mux.schema.object(
    {
      repository: mux.schema.nullable(mux.schema.string()),
      filters: mux.schema.object(
        {
          state: mux.schema.string(),
          includeLabels: mux.schema.array(mux.schema.string()),
          excludeLabels: mux.schema.array(mux.schema.string()),
          limit: mux.schema.integer(),
          includeBody: mux.schema.boolean(),
          bodyCharBudget: mux.schema.integer(),
        },
        { additionalProperties: false },
      ),
      issues: mux.schema.array(
        mux.schema.object(
          {
            number: mux.schema.integer(),
            safeId: mux.schema.string(),
            title: mux.schema.string(),
            url: mux.schema.string(),
            state: mux.schema.string(),
            body: mux.schema.string(),
            author: mux.schema.nullable(mux.schema.string()),
            createdAt: mux.schema.nullable(mux.schema.string()),
            updatedAt: mux.schema.nullable(mux.schema.string()),
            labelNames: mux.schema.array(mux.schema.string()),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  permissions: [{ kind: 'command', command: 'gh issue list' }],
  timeoutMs: 60000,
};

export async function execute(rawInput, ctx) {
  const input = inputObject(rawInput);
  const repository = repositoryFromInput(input);
  const state = optionalString(input.state) || 'open';
  const includeLabels = stringList(input.includeLabels);
  const excludeLabels = stringList(input.excludeLabels);
  const limit = boundedLimit(input.limit, 1000);
  const includeBody = input.includeBody === true;
  const bodyCharBudget = boundedCharBudget(input.bodyCharBudget, 2000);
  const jsonFields =
    'number,title,url,state,labels,author,createdAt,updatedAt' +
    (includeBody ? ',body' : '');
  const fetchLimit = excludeLabels.length > 0 ? 1000 : limit;
  const args = [
    'issue',
    'list',
    '--state',
    state,
    '--limit',
    String(fetchLimit),
    '--json',
    jsonFields,
  ];
  if (repository) args.push('--repo', repository);
  for (const label of includeLabels) args.push('--label', label);
  const issues = (await ctx.execJson('gh', args))
    .map(normalizeIssue)
    .map((issue) => ({
      ...issue,
      body: includeBody ? truncateText(issue.body, bodyCharBudget) : '',
    }))
    .filter((issue) =>
      includeLabels.every((label) => issue.labelNames.includes(label)),
    )
    .filter((issue) =>
      excludeLabels.every((label) => !issue.labelNames.includes(label)),
    )
    .sort((a, b) => a.number - b.number)
    .slice(0, limit);
  return {
    repository: repository || null,
    filters: {
      state,
      includeLabels,
      excludeLabels,
      limit,
      includeBody,
      bodyCharBudget,
    },
    issues,
  };
}
