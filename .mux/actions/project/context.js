export const metadata = {
  version: 1,
  description: 'Resolve the current Mux project path and GitHub repository',
  effect: 'read',
  inputSchema: mux.schema.object({}, { additionalProperties: false }),
  outputSchema: mux.schema.object(
    {
      cwd: mux.schema.nullable(mux.schema.string()),
      gitRoot: mux.schema.nullable(mux.schema.string()),
      projectPath: mux.schema.nullable(mux.schema.string()),
      projectPathSource: mux.schema.string(),
      repository: mux.schema.nullable(mux.schema.string()),
      repositorySource: mux.schema.string(),
    },
    { additionalProperties: false },
  ),
  permissions: [
    { kind: 'command', command: 'pwd' },
    { kind: 'command', command: 'git rev-parse' },
    { kind: 'command', command: 'git remote get-url' },
    { kind: 'command', command: 'gh repo view' },
  ],
  timeoutMs: 30000,
};

function cleanString(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

async function execStdout(ctx, command, args) {
  try {
    const result = await ctx.execChecked(command, args);
    return cleanString(result.stdout);
  } catch {
    return null;
  }
}

async function repoFromGh(ctx) {
  try {
    const result = await ctx.execJson('gh', [
      'repo',
      'view',
      '--json',
      'nameWithOwner',
    ]);
    return cleanString(result && result.nameWithOwner);
  } catch {
    return null;
  }
}

function repoFromRemoteUrl(url) {
  const text = cleanString(url);
  if (!text) return null;
  const match = text.match(
    /(?:github\.com[:/])([^/]+)\/([^/.]+)(?:\.git)?(?:\/?$)/,
  );
  return match ? match[1] + '/' + match[2] : null;
}

export async function execute(_input, ctx) {
  const cwd = cleanString(ctx.cwd) || (await execStdout(ctx, 'pwd', []));
  const gitRoot = await execStdout(ctx, 'git', [
    'rev-parse',
    '--show-toplevel',
  ]);
  const envProjectPath = cleanString(process.env.MUX_PROJECT_PATH);
  const repositoryFromGh = await repoFromGh(ctx);
  const remoteUrl = repositoryFromGh
    ? null
    : await execStdout(ctx, 'git', ['remote', 'get-url', 'origin']);
  const repositoryFromGit = repoFromRemoteUrl(remoteUrl);

  return {
    cwd,
    gitRoot,
    projectPath: envProjectPath || gitRoot || cwd,
    projectPathSource: envProjectPath
      ? 'MUX_PROJECT_PATH'
      : gitRoot
        ? 'git-root'
        : cwd
          ? 'cwd'
          : 'unresolved',
    repository: repositoryFromGh || repositoryFromGit,
    repositorySource: repositoryFromGh
      ? 'gh-repo-view'
      : repositoryFromGit
        ? 'git-origin'
        : 'unresolved',
  };
}
