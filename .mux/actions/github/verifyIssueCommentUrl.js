const {
  commentAuthorLogin,
  currentUserLogin,
  inputObject,
  optionalString,
  requiredIssueNumber,
  requiredRepository,
  requiredString,
  splitRepository,
  stringList,
} = require('../../workflow-action-lib/github.cjs');

export const metadata = {
  version: 1,
  description:
    'Verify that a GitHub issue comment URL belongs to an issue and contains expected text',
  effect: 'read',
  inputSchema: mux.schema.object(
    {
      repository: mux.schema.optional(mux.schema.string()),
      owner: mux.schema.optional(mux.schema.string()),
      repo: mux.schema.optional(mux.schema.string()),
      number: mux.schema.integer(),
      url: mux.schema.string(),
      expectedAuthor: mux.schema.optional(mux.schema.string()),
      requireAuthenticatedAuthor: mux.schema.optional(mux.schema.boolean()),
      requiredBodyIncludes: mux.schema.optional(
        mux.schema.array(mux.schema.string()),
      ),
    },
    { additionalProperties: false },
  ),
  outputSchema: mux.schema.object(
    {
      verified: mux.schema.boolean(),
      reason: mux.schema.string(),
      missing: mux.schema.optional(mux.schema.array(mux.schema.string())),
      url: mux.schema.optional(mux.schema.string()),
      commentId: mux.schema.optional(
        mux.schema.union([mux.schema.integer(), mux.schema.string()]),
      ),
    },
    { additionalProperties: false },
  ),
  permissions: [{ kind: 'command', command: 'gh api' }],
  timeoutMs: 60000,
};

function parseCommentUrl(url) {
  const match = String(url || '').match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)#issuecomment-(\d+)$/,
  );
  return match
    ? {
        owner: match[1],
        repo: match[2],
        number: Number(match[3]),
        commentId: match[4],
      }
    : null;
}

function parseIssueApiUrl(url) {
  const match = String(url || '').match(
    /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/,
  );
  return match
    ? { owner: match[1], repo: match[2], number: Number(match[3]) }
    : null;
}

function sameRepositoryPart(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function sameIssue(parts, number, parsed) {
  return Boolean(
    parsed &&
    sameRepositoryPart(parsed.owner, parts.owner) &&
    sameRepositoryPart(parsed.repo, parts.repo) &&
    parsed.number === number,
  );
}

function commentBelongsToIssue(comment, parts, number) {
  if (sameIssue(parts, number, parseIssueApiUrl(comment.issue_url)))
    return true;
  return sameIssue(parts, number, parseCommentUrl(comment.html_url));
}

async function expectedAuthor(input, ctx) {
  const explicit = optionalString(input.expectedAuthor);
  if (explicit) return explicit;
  if (input.requireAuthenticatedAuthor === false) return '';
  return await currentUserLogin(ctx);
}

export async function execute(rawInput, ctx) {
  const input = inputObject(rawInput);
  const repository = requiredRepository(input);
  const parts = splitRepository(repository);
  const number = requiredIssueNumber(input.number);
  const parsed = parseCommentUrl(requiredString(input.url, 'url'));
  if (
    !parsed ||
    !sameRepositoryPart(parsed.owner, parts.owner) ||
    !sameRepositoryPart(parsed.repo, parts.repo) ||
    parsed.number !== number
  ) {
    return { verified: false, reason: 'comment-url-does-not-match-issue' };
  }
  const comment = await ctx.execJson('gh', [
    'api',
    'repos/' +
      parts.owner +
      '/' +
      parts.repo +
      '/issues/comments/' +
      parsed.commentId,
  ]);
  if (!commentBelongsToIssue(comment, parts, number)) {
    return {
      verified: false,
      reason: 'fetched-comment-does-not-belong-to-issue',
      url: comment.html_url || input.url,
      commentId: comment.id || parsed.commentId,
    };
  }

  const author = await expectedAuthor(input, ctx);
  if (input.requireAuthenticatedAuthor !== false && !author) {
    return {
      verified: false,
      reason: 'authenticated-author-unavailable',
      url: comment.html_url || input.url,
      commentId: comment.id || parsed.commentId,
    };
  }
  if (author && commentAuthorLogin(comment) !== author) {
    return {
      verified: false,
      reason: 'comment-author-mismatch',
      url: comment.html_url || input.url,
      commentId: comment.id || parsed.commentId,
    };
  }

  const includes = stringList(input.requiredBodyIncludes);
  const missing = includes.filter(
    (text) => typeof comment.body !== 'string' || !comment.body.includes(text),
  );
  if (missing.length > 0)
    return {
      verified: false,
      reason: 'missing-required-body-text',
      missing,
      url: comment.html_url || input.url,
    };
  return {
    verified: true,
    reason: '',
    url: comment.html_url || input.url,
    commentId: comment.id || parsed.commentId,
  };
}
