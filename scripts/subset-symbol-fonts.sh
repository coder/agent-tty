#!/usr/bin/env bash
# The subsets drop every Emoji_Presentation code point, so a host color emoji
# font keeps drawing emoji.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
assets=$root/src/renderer/ghosttyWeb/assets
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fonts=(
  "NotoSansSymbols2-Regular https://raw.githubusercontent.com/notofonts/notofonts.github.io/c16b117609abbe4e60b3f2bd4433bdb3d0accb2e/fonts/NotoSansSymbols2/unhinted/ttf/NotoSansSymbols2-Regular.ttf c4a0a80f0041ce4be81e2478faad22776d23edb98ae3f0d19bd37044820ecf9d 4a0c4504d6af3990b551b213772367ce97e0099c70175cdf6331047e54bafd88"
  "NotoSansMath-Regular https://raw.githubusercontent.com/notofonts/notofonts.github.io/55773c3eb233b5a0eaa07de6226da189b136b4f0/fonts/NotoSansMath/unhinted/ttf/NotoSansMath-Regular.ttf b127e84699212b6b2ef50aff58e0ebebeec04ffe6db1b9eb9e209c8c3d97b4aa 1dce18ab72e9e531adfdbc7f870570e733e947d369094efc646fda3605e44e51"
)

for entry in "${fonts[@]}"; do
  read -r name url sha256 woff2_sha256 <<<"$entry"
  ttf=$work/$name.ttf
  keep=$work/$name.keep.txt
  curl -fsSL "$url" -o "$ttf"
  echo "$sha256  $ttf" | sha256sum --check --quiet -

  (cd "$root" && node --import tsx --input-type=module --eval "
    import { readFileSync } from 'node:fs';
    import { readFontFile } from './src/renderer/fontCoverage.ts';
    const { coverage } = readFontFile(readFileSync(process.argv[1]));
    const keep = [...coverage]
      .filter((codePoint) => !/^\p{Emoji_Presentation}$/u.test(String.fromCodePoint(codePoint)))
      .sort((left, right) => left - right);
    process.stdout.write(keep.map((codePoint) => 'U+' + codePoint.toString(16).toUpperCase()).join(','));
  " "$ttf") >"$keep"

  uvx --from 'fonttools[woff]==4.68.0' --with 'brotli==1.2.1' pyftsubset "$ttf" \
    --unicodes-file="$keep" \
    --layout-features='*' \
    --name-IDs='*' \
    --name-languages='*' \
    --notdef-outline \
    --flavor=woff2 \
    --output-file="$assets/$name.woff2"
  actual=$(sha256sum "$assets/$name.woff2" | cut -d' ' -f1)
  if [ "$actual" = "$woff2_sha256" ]; then
    echo "$name.woff2 $actual matches the pinned build"
  else
    echo "$name.woff2 $actual differs from the pinned build $woff2_sha256 (Node $(node -p process.versions.node), Unicode $(node -p process.versions.unicode))"
  fi
done
