# Week 4 failure-recovery bundle index

Inventory for `dogfood/20260322-week4-failure-recovery/`.

| File                            | Description                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `01-create.json`                | JSON envelope from session creation against the `crash-demo` fixture.             |
| `02-wait-exit.json`             | JSON envelope from waiting for the fixture to exit with code `1`.                 |
| `03-inspect-failed.json`        | JSON envelope proving the crashed session persisted in `exited` state.            |
| `04-snapshot-post-crash.json`   | JSON envelope for the post-crash text snapshot.                                   |
| `05-screenshot-post-crash.json` | JSON envelope for the post-crash screenshot capture.                              |
| `06-record-asciicast.json`      | JSON envelope for the post-crash asciicast export.                                |
| `07-destroy.json`               | JSON envelope for session destruction.                                            |
| `notes.md`                      | Scenario summary, reviewer guide, verification claims, and live capture commands. |
| `index.md`                      | File inventory for this proof bundle.                                             |
