# Issue 64 — Share screenshot capture and artifact persistence

This bundle compares screenshot output from the running session (live) and
exited session (offline replay) paths, before and after the refactor that
moves both paths through the shared `captureScreenshotResult(...)` helper in
`src/screenshot/capture.ts`.

## How it was generated

The same `commands.sh` was run twice:

1. **before**: against parent commit `b2d5068` (`refactor: share render wait
matching (#76)`) in a temporary `git worktree`. This still has the
   inline screenshot logic in `src/host/hostMain.ts` and a duplicate
   implementation in `src/cli/commands/screenshot.ts`.
2. **after**: against this branch, where both paths call the new
   `captureScreenshotResult(...)` helper.

Each run uses an isolated absolute `AGENT_TTY_HOME` (recorded in
`<label>/agent-tty-home.txt`) and writes its outputs under
`<label>/`.

The script is idempotent and safe to re-run:

```sh
bash dogfood/issue-64-share-screenshot-capture/commands.sh after
# or, in a worktree of the parent commit:
bash dogfood/issue-64-share-screenshot-capture/commands.sh before
```

## Scenarios captured

For both `before/` and `after/` directories:

| File                                     | Description                                         |
| ---------------------------------------- | --------------------------------------------------- |
| `03-screenshot-live-default.json`        | Live (running) screenshot, default cursor           |
| `04-screenshot-live-show-cursor.json`    | Live (running) screenshot with `--show-cursor`      |
| `12-screenshot-offline-default.json`     | Offline (exited) screenshot, default cursor         |
| `13-screenshot-offline-show-cursor.json` | Offline (exited) screenshot with `--show-cursor`    |
| `screenshot-live-default.png`            | Live default-cursor PNG                             |
| `screenshot-live-show-cursor.png`        | Live show-cursor PNG                                |
| `screenshot-offline-default.png`         | Offline default-cursor PNG                          |
| `screenshot-offline-show-cursor.png`     | Offline show-cursor PNG                             |
| `manifest-live.json`                     | Artifact manifest after live session screenshots    |
| `manifest-offline.json`                  | Artifact manifest after offline session screenshots |
| `sha256-summary.txt`                     | One-line-per-PNG SHA-256 summary                    |
| `transcript.txt`                         | Full command transcript                             |

Default profile is `reference-dark` (the only profile this refactor needs to
preserve).

## Parity verdict

| Comparison                                                                                                                           | Result                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `sha256-summary.txt` (live + offline, with and without cursor)                                                                       | **identical**          |
| All four screenshot result envelopes, excluding session IDs and the absolute `artifactPath` (which embeds the temp `AGENT_TTY_HOME`) | **identical fields**   |
| Artifact manifest entries, excluding ULID `id`, `sessionId`, and `createdAt` timestamps                                              | **identical metadata** |
| All four PNG files, byte-for-byte (`cmp -s`)                                                                                         | **identical bytes**    |

Specifically:

- Live default and live show-cursor PNGs both hash to
  `a658e720e18b2943fd6203e8947a9fe4e60fa0759cb5d0f9c74668abfe267ceb` in both
  before and after.
- Offline default and offline show-cursor PNGs both hash to
  `993fb5f9fe5b9ec7ed456b4005ec40478f5ee6bc3c6d5a65f6dbc78fbd60406d` in both
  before and after.
- All result envelopes preserve `profileName=reference-dark`,
  `cols=80`, `rows=24`, `pngSizeBytes`, `pixelWidth=640`, `pixelHeight=384`,
  `cursorVisible`, `rendererBackend=ghostty-web`, and `renderProfileHash`.

## Reviewer reproduction

To independently verify these comparisons:

```sh
node -e "
  const fs = require('node:fs');
  function strip(p) {
    const e = JSON.parse(fs.readFileSync(p, 'utf8'));
    const r = e.result; delete r.sessionId; delete r.artifactPath;
    delete e.timestamp;
    return e;
  }
  for (const f of ['03-screenshot-live-default','04-screenshot-live-show-cursor','12-screenshot-offline-default','13-screenshot-offline-show-cursor']) {
    const a = strip(\`before/\${f}.json\`);
    const b = strip(\`after/\${f}.json\`);
    console.log(f, JSON.stringify(a)===JSON.stringify(b) ? 'IDENTICAL' : 'DIFFER');
  }
"
cmp -s before/screenshot-live-default.png after/screenshot-live-default.png && echo "live-default PNG IDENTICAL"
cmp -s before/screenshot-offline-default.png after/screenshot-offline-default.png && echo "offline-default PNG IDENTICAL"
```
