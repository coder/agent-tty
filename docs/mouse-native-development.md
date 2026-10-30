# Testing native mouse input

Mouse input depends on [libghostty-vt-node PR #12](https://github.com/coder/libghostty-vt-node/pull/12).
The existing optional dependency remains compatible for semantic operations;
its published version does not yet encode mouse input. The adapter checks the
terminal method at runtime and reports `CAPABILITY_UNAVAILABLE` when absent.

To test the binding before publication, build and pack its exact revision with
the pinned Zig 0.15.2 toolchain, Node, and node-gyp's platform prerequisites:

```bash
git clone https://github.com/pmarreck/libghostty-vt-node.git
cd libghostty-vt-node
git checkout 8318d03cc4c5d417d988548f920a784abfde33af
npm ci
npm run build:libghostty
npm run build
npm run build:prebuild
npm run verify
npm pack --ignore-scripts
```

From the `agent-tty` checkout, install that tarball locally without changing the
published dependency or lockfile:

```bash
npm install --no-save --package-lock=false ../libghostty-vt-node/coder-libghostty-vt-node-0.1.0-beta.1.tgz
AGENT_TTY_REQUIRE_MOUSE_NATIVE=1 npm test -- test/integration/mouse.test.ts
```

The integration tests use isolated session homes and a raw-mode PTY child to
check the bytes it actually receives, including non-UTF-8 X10 bytes. They also
check event-log preservation and replay, disabled reporting, and unsupported
renderers. They run automatically when mouse support is installed; the
environment flag makes missing support a failure instead of a skip.

After the upstream package is released with this API, update the optional
dependency and lockfile together. A Git source dependency alone is insufficient:
the binding needs built TypeScript and a platform-specific native addon.
