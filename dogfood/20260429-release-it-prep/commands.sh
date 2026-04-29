set -euo pipefail
PROOF_DIR="${PROOF_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
SOURCE_ROOT="${SOURCE_ROOT:-$(git -C "$PROOF_DIR/../.." rev-parse --show-toplevel)}"
TRANSCRIPT="$PROOF_DIR/transcript.txt"
exec > >(tee "$TRANSCRIPT") 2>&1
printf 'DOGFOOD: release-it prep/finalize flow\n'
printf 'source=%s\n' "$SOURCE_ROOT"
WORK_ROOT=$(mktemp -d)
printf 'work-root=%s\n' "$WORK_ROOT"
ORIGIN="$WORK_ROOT/origin.git"
REPO="$WORK_ROOT/repo"
git init -q --bare "$ORIGIN"
git init -q -b main "$REPO"
cd "$REPO"
git remote add origin "$ORIGIN"
git config user.name 'Agent TTY Dogfood'
git config user.email 'agent-tty-dogfood@example.invalid'
export SOURCE_ROOT
node --input-type=module <<'EOF_NODE'
import { writeFileSync } from 'node:fs';
const sourceRoot = process.env.SOURCE_ROOT;
if (!sourceRoot) throw new Error('SOURCE_ROOT missing');
writeFileSync('package.json', `${JSON.stringify({
  name: 'agent-tty',
  version: '0.1.1-beta.4',
  type: 'module',
  private: true,
  scripts: {
    'release:prep': `node ${sourceRoot}/scripts/release-prep.mjs`,
    'release:finalize': `node ${sourceRoot}/scripts/release-finalize.mjs`,
  },
})}\n`);
writeFileSync('package-lock.json', `${JSON.stringify({
  name: 'agent-tty',
  version: '0.1.1-beta.4',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': {
      name: 'agent-tty',
      version: '0.1.1-beta.4',
      license: 'Apache-2.0',
    },
  },
})}\n`);
writeFileSync('CHANGELOG.md', '# Changelog\n');
EOF_NODE
git add package.json package-lock.json CHANGELOG.md
git commit -q -m init
git push -q -u origin main
printf '\nDOGFOOD: initial graph\n'
git log --oneline --decorate --graph --all
printf '\nDOGFOOD: release prep\n'
npm run release:prep -- --version 999.0.0-dogfood.0 --changelog ci
printf '\nDOGFOOD: after prep\n'
printf 'branch=%s\n' "$(git branch --show-current)"
printf 'status=%s\n' "$(git status --short)"
printf 'commit-count=%s\n' "$(git rev-list --count origin/main..HEAD)"
printf 'changed-files=%s\n' "$(git diff --name-only HEAD^..HEAD | paste -sd ',' -)"
node -e "const p=require('./package.json'); const l=require('./package-lock.json'); console.log('versions=' + [p.version,l.version,l.packages[''].version].join(','))"
printf '\nDOGFOOD: merge prep to main and finalize\n'
git push -q -u origin release/999.0.0-dogfood.0
git switch -q main
git merge -q --ff-only release/999.0.0-dogfood.0
git push -q origin main
npm run release:finalize
printf '\nDOGFOOD: final graph\n'
git log --oneline --decorate --graph --all
printf '\nDOGFOOD: remote tags\n'
git ls-remote --tags origin
printf '\nDOGFOOD: success\n'
