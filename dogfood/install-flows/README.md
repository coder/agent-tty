# Install flow proof bundle

This bundle captures a 2026-04-07 review pass for the prerelease install paths.

## Environment

- Node runtime used for installed-binary checks: v24.14.0
- npm used for packaging/install commands: 11.9.0
- Tarball artifact: /home/coder/.mux/src/agent-terminal/npm-install-5r2j/dogfood/install-flows/tarball-artifact/agent-terminal-0.1.0.tgz
- Git source revision: 4443b7a66dcf91e9798773abdf363eda746358aa
- Git source URL: git+file:///tmp/tmp.6ZtZ24ucrQ/src#4443b7a66dcf91e9798773abdf363eda746358aa

## What is included

### Tarball route (`tarball/`)

- `pack.json` records the built package contents.
- `install.log`, `version.json`, and `doctor.json` capture the successful install + verification outputs.
- `install.png`, `version.png`, and `doctor.png` are reviewer-facing screenshots.
- `install-flow.webm` and `install-flow.cast` are the corresponding terminal recordings.

### Git route (`git/`)

- `install.log` captures a representative direct git install attempt from this workspace.
- `install.png` and `install-flow.webm` render that transcript for review.
- `blocker.md` documents why this workspace could not produce installed-binary `version --json` / `doctor --json` outputs for the git route.

## Important review note

The tarball route is the fully verified private-distribution path in this bundle.
The git route evidence is intentionally a blocker transcript rather than a successful install proof: the smoke check now accepts a narrow family of known git-install caveats in environments like this one, while keeping the tarball route as the required passing path.
That caveat is also reflected in the updated installation docs, which keep the tarball route as the guaranteed fallback.
