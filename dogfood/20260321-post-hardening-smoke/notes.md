# 2026-03-21 post-hardening smoke

This smoke run revalidated the Week 2 plan goals after the latest hardening changes.

Verified end-to-end:

- full quality gates via `npm run verify`
- live `inspect` against a running session
- combined renderer wait: `wait --text Ready --screen-stable-ms 500`
- renderer regex wait after live `type`
- `snapshot --format structured` and `snapshot --format text`
- `screenshot` with both built-in profiles
- `doctor --json` renderer checks
- artifact manifest and copied PNG artifacts

Environment:

- AGENT_TERMINAL_HOME: /tmp/agent-terminal-dogfood-prvAiK
- Session ID: 01KM8E12G4CCE32NE70RFTS6VY
