# Release-it prep dogfood

This bundle captures the release prep and finalization scripts running against a disposable git repository with a disposable bare origin.

- Transcript: `transcript.txt`
- Screenshot: `screenshot.png`
- WebM: `release-it-prep.webm`
- Asciicast: `release-it-prep.cast`

The flow runs `npm run release:prep -- --version 999.0.0-dogfood.0 --changelog ci`, fast-forwards the disposable `main`, then runs `npm run release:finalize`.

Key transcript checks:

- `branch=release/999.0.0-dogfood.0`
- `commit-count=1`
- `changed-files=package-lock.json,package.json`
- `versions=999.0.0-dogfood.0,999.0.0-dogfood.0,999.0.0-dogfood.0`
- `refs/tags/v999.0.0-dogfood.0`
