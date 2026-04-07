# Git install blocker in this workspace

The direct git install transcript in `install.log` is a representative run from this workspace.
It fails before the installed binary exists because npm's git-dependency preparation path is still fragile here: in this capture, the temp clone could not resolve `tsc`/dependency state cleanly during `npm run build`, though related runs in this environment have also failed in native-dependency paths such as `node-pty`.

Because the install never produced a binary, there are no `version --json` or `doctor --json` outputs for the git route in this local proof bundle.
The supported fallback proof is the tarball route, and the README installation section documents the tarball path as the guaranteed private-distribution route.
