# Social preview (Open Graph) image spec

This is the image GitHub shows when `github.com/coder/agent-tty` is shared on
Hacker News, X, Slack, LinkedIn, etc. The repo currently has **no custom image**
(`usesCustomOpenGraphImage: false`), so it falls back to GitHub's auto-generated
avatar+stats card. Replacing it is the single highest-leverage pre-launch task —
it's what people see *before* they click.

Target output: **`assets/social-preview.png`** (generated — see "How to produce"
below) → upload via **repo Settings → General → Social preview → Edit → Upload an
image**.

## Hard specs

| Property | Value |
| --- | --- |
| Dimensions | **1200 × 630 px** (universal OG 1.91:1 — passes opengraph.xyz; GitHub also accepts it. GitHub's own rec is 1280×640, but 1200×630 is the safer cross-platform card for X/Slack/LinkedIn) |
| File size | **< 1 MB** (a flat dark bg + text exports well under this; run `pngquant` if needed) |
| Format | PNG, sRGB (JPG/GIF also accepted) |
| Min accepted | 640 × 320 px |

**Safe area:** keep the wordmark and tagline inside a centered **~1120 × 500**
region (≈80 px side / ≈70 px top-bottom margins). X/LinkedIn/Facebook re-crop to
1.91:1, so anything near the edges can get clipped.

## Layout

```
┌──────────────────────────────────────────────────────────────┐
│  (dark terminal background — #11111b / #0d1117, flat)          │
│                                                                │
│   agent-tty                                  ▏ ← optional       │
│   ─────────                                    block cursor     │
│   Drive and inspect terminal sessions from the CLI —           │
│   reviewable snapshots, screenshots & recordings.              │
│                                                                │
│   $ agent-tty snapshot $SID --format text                      │
│   ┌ hello from agent-tty ───────────────────┐  ← faux captured │
│   │ user@host:~$ █                           │     screen, dim  │
│   └──────────────────────────────────────────┘                 │
│                                                                │
│   github.com/coder/agent-tty      Apache-2.0 · Ghostty VT      │
└──────────────────────────────────────────────────────────────┘
```

## Copy (use verbatim — matches the README + repo description)

- **Wordmark:** `agent-tty`
- **Tagline (one line):** `Drive and inspect terminal sessions from the CLI — reviewable snapshots, screenshots & recordings.`
  - If it's too long at your font size, shorten to: `Scriptable terminal sessions with reviewable snapshots, screenshots & recordings.`
- **Footer:** `github.com/coder/agent-tty` · optional honest credit `Powered by Ghostty's VT engine`
- Do **not** put "for AI agents" in the image headline (saturated/risky per the launch research); the agent angle lives in the README body and your HN first comment.

## Type & color

- **Monospace throughout** (JetBrains Mono / Berkeley Mono / IBM Plex Mono / Geist Mono). It reads as an authentic terminal tool, not a marketing site.
- High contrast: light text (`#cdd6f4` / `#e6edf3`) on a dark base. One accent color max (e.g. a green `#a6e3a1` for the prompt `$`).
- Wordmark large (~96–120 px), tagline ~34–40 px, footer ~24 px.

## Do / Don't

- ✅ Flat dark terminal aesthetic, monospace, a real command + a snippet of captured screen.
- ✅ Let the *artifact* (a text snapshot of a real screen) be the visual idea.
- ❌ Gradient hero blobs, neon glows, glassmorphism, "pulsing live" pills, emoji, 3D shapes, stock dev illustrations. These read as AI-generated "slop" and HN calls them out within minutes — the image must not undercut a launch built on "honest, inspectable tooling."

## How to produce it

**Implemented (HTML/CSS → Playwright screenshot):** edit [`social-preview.html`](./social-preview.html) and run `node assets/render-social-preview.mjs`. It renders at 2× and downscales with `sips` to a crisp 1200×630 PNG. This is the source of truth for the card.

Other approaches if you'd rather start over:

1. **Figma / design tool** — 1200×630 frame, paste the copy, export PNG.
2. **VHS still** — a one-frame `.tape` (`Output assets/social-preview.png`, `Set Width 1200`, `Set Height 630`, type the command + snapshot, no playback) gives a real captured screen as the card.

## Verify before launch

Paste the repo URL into <https://www.opengraph.xyz> (or just DM yourself the link
in Slack) and confirm the card renders with no clipped text. GitHub can take a
few minutes to refresh its cache after upload.
