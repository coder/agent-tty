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
      ongoingLabels: mux.schema.optional(mux.schema.array(mux.schema.string())),
      includeComments: mux.schema.optional(mux.schema.boolean()),
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

function labelsIncludeAll(labels, labelNames) {
  return (
    labels.length > 0 && labels.every((label) => labelNames.includes(label))
  );
}

function labelsIncludeAny(labels, labelNames) {
  return labels.some((label) => labelNames.includes(label));
}

export async function execute(rawInput, ctx) {
  const input = inputObject(rawInput);
  const repository = requiredRepository(input);
  const number = requiredIssueNumber(input.number);
  const doneLabels = stringList(input.doneLabels);
  const ongoingLabels = stringList(input.ongoingLabels);
  const includeComments = input.includeComments !== false;
  const issuePromise = getIssueView(ctx, repository, number, ['labels']);

  if (!includeComments) {
    const issue = await issuePromise;
    const labelNames = normalizeIssue(issue).labelNames;
    return {
      done: labelsIncludeAll(doneLabels, labelNames),
      promptStarted: labelsIncludeAny(ongoingLabels, labelNames),
      reportPosted: false,
      labelNames,
      markerComments: [],
    };
  }

  const parts = splitRepository(repository);
  const marker = requiredString(input.marker, 'marker');
  const markerKey = requiredString(input.markerKey, 'markerKey');
  const promptVersion = optionalString(input.promptVersion) || 'v1';
  const [issue, comments] = await Promise.all([
    issuePromise,
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
    done: labelsIncludeAll(doneLabels, labelNames),
    promptStarted:
      labelsIncludeAny(ongoingLabels, labelNames) ||
      statuses.includes('prompt-started'),
    reportPosted: statuses.includes('report-posted'),
    labelNames,
    markerComments: matching.map((comment) => ({
      id: comment.id,
      url: comment.html_url || null,
      status: markerStatus(comment.body),
    })),
  };
}
