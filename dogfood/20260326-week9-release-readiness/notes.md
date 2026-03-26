# 2026-03-26 dogfood — Week 9 release-readiness proof

## Bundle metadata

- **Bundle path:** `dogfood/20260326-week9-release-readiness/`
- **CLI entrypoint:** `src/cli/main.ts`
- **Lower-level run proof:** `dogfood/run-command/`
- **Isolated home record:** `isolated-home.txt`
- **Session ID record:** `session-id.txt`
- **Primary evidence:** `logs/01-doctor.json`, `logs/03-create-inspect.json`, `logs/04-run-echo.json`, `logs/05-run-sysinfo.json`, `logs/07-screenshot.json`, `logs/08-snapshot.json`, `logs/09-export-asciicast.json`, `logs/10-export-webm.json`, `logs/11-final-inspect.json`, `logs/12-destroy.json`
- **Bundle-local JSON mirrors for validation/review tooling:** `snapshots/01-doctor.json`, `snapshots/02-post-run-structured.json`, `snapshots/03-final-inspect.json`

## What this bundle proves

This bundle captures a full Week 9 release-readiness path against an isolated `--home` directory. It exercises the new isolation-aware `doctor` checks, creates a fresh PTY-backed session, runs two in-session commands through the new `run` command, waits for renderer stability, and exports screenshot, snapshot, asciicast, and WebM artifacts from the same session.

The strongest Week 9-specific proof points are:

- `logs/01-doctor.json` shows the new `home_isolation` environment check passing for the temp home recorded in `isolated-home.txt`.
- `logs/01-doctor.json` also shows `browser_cache_accessible` passing against `/home/coder/.cache/ms-playwright`, proving the renderer browser-path isolation work still finds the original Playwright cache while the agent-terminal home is isolated.
- `logs/04-run-echo.json` and `logs/05-run-sysinfo.json` show `run` accepting and completing both in-session commands with completion markers.
- `logs/06-wait-stable.json` confirms `wait --screen-stable-ms 1000` matched before visual capture.
- `logs/07-screenshot.json`, `screenshots/01-after-run.png`, `logs/09-export-asciicast.json`, `recordings/week9.cast`, `logs/10-export-webm.json`, and `videos/week9.webm` prove the renderer/export stack can still capture evidence from that isolated session.
- `logs/11-final-inspect.json` reports a healthy live renderer runtime with `usedOfflineReplay: false` plus exactly one screenshot, one snapshot, one recording, and one video artifact.

## Screenshot and recording notes

- **Screenshot:** `screenshots/01-after-run.png` is the copied renderer screenshot from `logs/07-screenshot.json`. It shows the bash session after the two `run` invocations and their completion-marker lines.
- **Snapshot:** `logs/08-snapshot.json` is the structured renderer snapshot captured from the same frame sequence (`capturedAtSeq: 5`), and `snapshots/02-post-run-structured.json` mirrors it in a validator-visible JSON location.
- **Asciicast:** `recordings/week9.cast` is the exported terminal event-log recording (`1177` bytes).
- **WebM:** `videos/week9.webm` is the browser-rendered replay video (`52509` bytes).

## Environment details

- **Node:** `v22.19.0`
- **OS:** `Linux aaaaaaa 6.8.0-94-generic #96-Ubuntu SMP PREEMPT_DYNAMIC Fri Jan 9 20:36:55 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux`
- **Neovim:** `NVIM v0.7.2`
- **Renderer browser cache used by doctor:** `/home/coder/.cache/ms-playwright`

## Known limitations / acceptable failures

- `doctor` intentionally reported `result.ok: false` in `logs/01-doctor.json` because the workspace is running Node `v22.19.0` while the project requires Node `24+`. That is a real environment mismatch, not a Week 9 regression. The new Week 9 isolation-aware checks (`home_isolation` and `browser_cache_accessible`) still passed, which is the behavior this bundle needed to prove.
- The bundle includes JSON mirrors under `snapshots/` because the review/validation tooling classifies `logs/` entries as support files rather than JSON artifacts.
- The renderer snapshot shows the echoed `run` command lines and completion markers rather than the full stdout payload for the `run` commands. That matches the existing lower-level `dogfood/run-command/` proof and still demonstrates the end-to-end `run -> wait -> renderer capture -> export` flow.
- The future Neovim/LazyVim review scenario remains out of scope for this bundle. This environment only has Neovim `0.7.2`, while the target scenario calls for Neovim `0.8+` plus Nerd Fonts.

## Suggested review order

1. Read this file for the narrative and known limitations.
2. Open `logs/01-doctor.json` and confirm `home_isolation` plus `browser_cache_accessible` passed.
3. Review `logs/02-create.json` and `logs/03-create-inspect.json` to confirm the isolated session was created and is running.
4. Review `logs/04-run-echo.json`, `logs/05-run-sysinfo.json`, and `logs/06-wait-stable.json` for the `run` and stability-wait evidence.
5. Open `screenshots/01-after-run.png` and `logs/08-snapshot.json` for the visual renderer state.
6. Play `recordings/week9.cast` and `videos/week9.webm` for replay/export proof.
7. Finish with `logs/11-final-inspect.json` and `logs/12-destroy.json` to confirm artifact health and cleanup.
8. If you want deeper `run`-specific context, compare this bundle with `dogfood/run-command/`.
