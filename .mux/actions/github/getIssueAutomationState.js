const {
  getIssueView,
  inputObject,
  isMatchingMarker,
  listComments,
  markerStatus,
  normalizeIssue,
  optionalString,
  requiredIssueNumber,
  requiredRepository,
  requiredString,
  splitRepository,
  stringList,
} = require('../../workflow-action-lib/github.cjs');

export const metadata = {
  version: 1,
  description: 'Read GitHub issue automation marker comments and done labels',
  effect: 'read',
  inputSchema: mux.schema.object(
    {
      repository: mux.schema.optional(mux.schema.string()),
      owner: mux.schema.optional(mux.schema.string()),
      repo: mux.schema.optional(mux.schema.string()),
      number: mux.schema.integer(),
      doneLabels: mux.schema.optional(mux.schema.array(mux.schema.string())),
      marker: mux.schema.string(),
      markerKey: mux.schema.string(),
      promptVersion: mux.schema.optional(mux.schema.string()),
    },
    { additionalProperties: false },
  ),
  outputSchema: mux.schema.object(
    {
      done: mux.schema.boolean(),
      promptStarted: mux.schema.boolean(),
      reportPosted: mux.schema.boolean(),
      labelNames: mux.schema.array(mux.schema.string()),
      markerComments: mux.schema.array(
        mux.schema.object(
          {
            id: mux.schema.integer(),
            url: mux.schema.nullable(mux.schema.string()),
            status: mux.schema.string(),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  permissions: [
    { kind: 'command', command: 'gh api' },
    { kind: 'command', command: 'gh issue view' },
  ],
  timeoutMs: 60000,
};

export async function execute(rawInput, ctx) {
  const input = inputObject(rawInput);
  const repository = requiredRepository(input);
  const parts = splitRepository(repository);
  const number = requiredIssueNumber(input.number);
  const doneLabels = stringList(input.doneLabels);
  const marker = requiredString(input.marker, 'marker');
  const markerKey = requiredString(input.markerKey, 'markerKey');
  const promptVersion = optionalString(input.promptVersion) || 'v1';
  const [issue, comments] = await Promise.all([
    getIssueView(ctx, repository, number, ['labels']),
    listComments(ctx, parts.owner, parts.repo, number),
  ]);
  const labelNames = normalizeIssue(issue).labelNames;
  const matching = comments.filter((comment) =>
    isMatchingMarker(comment.body, marker, markerKey, promptVersion),
  );
  const statuses = matching
    .map((comment) => markerStatus(comment.body))
    .filter(Boolean);
  return {
    done:
      doneLabels.length > 0 &&
      doneLabels.every((label) => labelNames.includes(label)),
    promptStarted: statuses.includes('prompt-started'),
    reportPosted: statuses.includes('report-posted'),
    labelNames,
    markerComments: matching.map((comment) => ({
      id: comment.id,
      url: comment.html_url || null,
      status: markerStatus(comment.body),
    })),
  };
}
