# Hero Demo GitHub video playback

GitHub repository file pages may show checked-in video files as raw downloads instead of a player. The canonical Hero Demo recordings stay checked in as WebM proof artifacts, but README-facing playback should use GitHub-uploaded H.264 MP4 attachment URLs.

## Current recommendation

1. Keep these checked-in proof artifacts as the source of truth:
   - `artifacts/codex-outer.webm`
   - `artifacts/claude-outer.webm`
2. Generate upload-only H.264 MP4 copies from those WebMs.
3. Upload the MP4 copies through GitHub's Markdown attachment flow.
4. Replace the README thumbnail link targets with the resulting `https://github.com/user-attachments/assets/...` URLs.

The MP4 copies are derived playback assets, not canonical proof artifacts. They should live under `.debug/video-upload/` locally unless the project later chooses a Pages gallery or another committed-media route.

## Prepare upload assets

From the repository root:

```bash
mise run demo:agent-uses-agent-tty:upload-assets
```

The task uses the pinned `ffmpeg`/`ffprobe` from `mise.toml`, converts both outer WebMs to H.264 MP4 files, writes ffprobe metadata, and writes checksums under `.debug/video-upload/`.

Expected constraints for the promoted 2026-05-21 recordings:

| Agent  | Upload file                                 | Expected codec    | Expected dimensions | Expected size |
| ------ | ------------------------------------------- | ----------------- | ------------------- | ------------- |
| Codex  | `.debug/video-upload/codex-outer-h264.mp4`  | H.264 / `yuv420p` | 1600x900            | ~3.3 MB       |
| Claude | `.debug/video-upload/claude-outer-h264.mp4` | H.264 / `yuv420p` | 1600x900            | ~3.0 MB       |

Both expected sizes are below GitHub's 10 MB video attachment limit for free plans.

## Upload through GitHub

GitHub does not expose a supported PAT-backed API for creating `user-attachments` video URLs. Use the web Markdown editor flow:

1. Open any GitHub Markdown text area with write access to `coder/agent-tty`:
   - a draft issue body,
   - a PR comment,
   - or the web editor for a Markdown file.
2. Drag `codex-outer-h264.mp4` into the text area and wait for GitHub to replace it with a `https://github.com/user-attachments/assets/...` URL.
3. Drag `claude-outer-h264.mp4` into the text area and copy its URL too.
4. The comment or draft does not need to be submitted if the URLs have been copied.
5. Verify each copied URL opens a GitHub video player before editing the README.

## README patch after upload

Apply the copied attachment URLs with the helper task:

```bash
mise run demo:agent-uses-agent-tty:apply-video-urls -- \
  --codex-url https://github.com/user-attachments/assets/REPLACE-CODEX-H264-MP4 \
  --claude-url https://github.com/user-attachments/assets/REPLACE-CLAUDE-H264-MP4
```

The task updates the root README, the bundle README, and the bundle manifest entry for `README.md`. Verify the result with:

```bash
npm run validate-bundle:canonical
```

## Fallback

If GitHub attachment URLs are rejected for maintainability, use a GitHub Pages gallery with `<video controls>` and committed H.264 MP4 playback copies. Do not point README thumbnails at committed repository videos as the primary playback path; GitHub may show those as raw downloads.
