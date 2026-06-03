import { describe, expect, it } from 'vitest';

import { renderReadme } from '../../../src/tools/hero-demo.js';
import {
  posterConcatFilter,
  replaceVideoSrcs,
} from '../../../src/tools/hero-video-playback.js';

const URLS = {
  codex: 'https://github.com/user-attachments/assets/codex-uuid',
  claude: 'https://github.com/user-attachments/assets/claude-uuid',
};

describe('hero video playback', () => {
  it('rewrites each <video> src in Codex-then-Claude order', () => {
    const html = [
      '<video src="old-codex" controls></video>',
      '<video src="old-claude" controls width="320"></video>',
    ].join('\n');
    const rewritten = replaceVideoSrcs(html, URLS);
    expect(rewritten).toContain(`src="${URLS.codex}"`);
    expect(rewritten).toContain(`src="${URLS.claude}"`);
    // The first <video> is Codex, the second Claude (AGENTS order).
    expect(rewritten.indexOf(URLS.codex)).toBeLessThan(
      rewritten.indexOf(URLS.claude),
    );
  });

  it('throws unless the doc has exactly one <video> per agent', () => {
    expect(() => replaceVideoSrcs('<p>no videos here</p>', URLS)).toThrow(
      'expected 2 <video> src attributes, found 0',
    );
    expect(() =>
      replaceVideoSrcs('<video src="only-one"></video>', URLS),
    ).toThrow('found 1');
  });

  it('scales the poster intro and recording to the same probed dimensions', () => {
    const filter = posterConcatFilter(1920, 900);
    // Both streams scale to the SAME size so concat succeeds and the source
    // aspect ratio is preserved — a fixed 1600x900 once squished 1920x900.
    expect(filter.match(/scale=1920:900/g)).toHaveLength(2);
    expect(filter).not.toContain('1600');
    expect(filter).toContain('concat=n=2:v=1');
  });

  // Regression guard: the promote step's bundle README must keep emitting the
  // inline <video> elements that apply-video-urls rewrites. renderReadme once
  // regressed to thumbnail links, which made apply-video-urls fail with
  // "expected 2 <video> src attributes, found 0" after every regeneration.
  it('keeps renderReadme compatible with the apply-video-urls contract', () => {
    const applied = replaceVideoSrcs(renderReadme(), URLS);
    expect(applied).toContain(`src="${URLS.codex}"`);
    expect(applied).toContain(`src="${URLS.claude}"`);
  });
});
