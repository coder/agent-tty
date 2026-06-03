# Hero Demo GitHub video playback

The canonical Hero Demo recordings stay checked in as WebM proof artifacts, but
README-facing playback uses GitHub-uploaded H.264 MP4 attachments embedded as
inline `<video>` players.

## Why this shape

GitHub serves `user-attachments` assets only when they are embedded inline in
rendered Markdown (it rewrites them to signed `private-user-images` URLs that
anonymous visitors can stream). Two things follow, both verified against logged-out
GitHub:

1. **A thumbnail _linked_ to a `user-attachments` URL is broken for the public.**
   `https://github.com/user-attachments/assets/<uuid>` returns `404` on direct
   navigation, so `[![thumb](png)](asset-url)` lands anonymous visitors on a 404.
   Use an inline `<video>` element instead.
2. **GitHub strips the `<video poster>` attribute**, so a curated poster image
   cannot be supplied as an attribute. Instead the upload MP4 holds the curated
   thumbnail as its opening frames, so the player's natural first-frame still
   shows the end-state proof rather than a blank startup terminal.

The MP4 copies are derived playback assets, not canonical proof. They live under
`.debug/video-upload/` (git-ignored); the checked-in `*-outer.webm` files remain
the source of truth.

## Prepare upload assets

From the repository root:

```bash
mise run demo:agent-uses-agent-tty:upload-assets
```

The task uses the pinned `ffmpeg`/`ffprobe` from `mise.toml`. For each agent it
prepends ~0.3s of `artifacts/<agent>-thumbnail.png` as the opening frames, encodes
H.264 MP4, writes ffprobe metadata, and writes checksums under `.debug/video-upload/`.
The upload MP4 is encoded at the recording's own probed resolution, so it always
preserves the source aspect ratio (no squish if the recording dimensions change).

Expected constraints for the current promoted recordings (dimensions track the
recording resolution, currently 1920x900):

| Agent  | Upload file                                 | Expected codec    | Expected dimensions | Expected size |
| ------ | ------------------------------------------- | ----------------- | ------------------- | ------------- |
| Codex  | `.debug/video-upload/codex-outer-h264.mp4`  | H.264 / `yuv420p` | 1920x900            | ~3.4 MB       |
| Claude | `.debug/video-upload/claude-outer-h264.mp4` | H.264 / `yuv420p` | 1920x900            | ~4.0 MB       |

Both expected sizes are below GitHub's 10 MB video attachment limit for free plans.

## Upload through GitHub

GitHub does not expose a supported PAT-backed API for `user-attachments` uploads:
the endpoint authenticates with a browser `user_session` cookie, not a `gh` OAuth
token. Two working routes:

- **CLI (`gh-image`).** The [`drogers0/gh-image`](https://github.com/drogers0/gh-image)
  extension uploads via the same internal endpoints, reading your logged-in browser
  `user_session` cookie (treat that cookie like a password):

  ```bash
  gh extension install drogers0/gh-image
  gh image --repo coder/agent-tty .debug/video-upload/codex-outer-h264.mp4
  gh image --repo coder/agent-tty .debug/video-upload/claude-outer-h264.mp4
  ```

  Copy only the bare `https://github.com/user-attachments/assets/...` URL from each
  line (drop the `![](...)` Markdown wrapper).

- **Manual.** Drag each MP4 into any GitHub Markdown text area (a draft issue or PR
  comment) with write access to `coder/agent-tty`, wait for the `user-attachments`
  URL, and copy it. The draft does not need to be submitted.

## Apply the URLs

```bash
mise run demo:agent-uses-agent-tty:apply-video-urls -- \
  --codex-url https://github.com/user-attachments/assets/REPLACE-CODEX \
  --claude-url https://github.com/user-attachments/assets/REPLACE-CLAUDE
```

The task rewrites the `src` of the inline `<video>` elements (one per agent, in
Codex/Claude order) in the root README and this bundle README, and refreshes the
bundle manifest entry for `README.md`. Then verify:

```bash
npm run validate-bundle:canonical
```

## Verify in a logged-out browser

This is the step that catches the failure modes above. Open the rendered README on
the branch **while logged out of GitHub** and confirm each `<video>` plays:

- `https://github.com/coder/agent-tty/blob/<branch>/README.md`

Do not test by navigating directly to the `user-attachments/assets/<uuid>` URL — that
returns 404 anonymously by design even when the inline player works. Confirm the
embedded `<video>` element actually streams (it should show the curated thumbnail as
its still, then play).

## Fallback

If GitHub attachment URLs are ever rejected for maintainability, use a GitHub Pages
gallery with `<video controls>` and committed H.264 MP4 playback copies. Do not point
README playback at committed repository videos as the primary path; GitHub may show
those as raw downloads.
