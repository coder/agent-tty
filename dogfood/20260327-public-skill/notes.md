# Public skill packaging smoke

- Node: v24.14.0
- npm: 10.9.3
- Tarball: agent-terminal-0.1.0.tgz
- Installed prefix: /tmp/tmp.tgxMDfYxl6
- Isolated home: /tmp/tmp.JSj3HFOAzD
- Smoke token: public-skill smoke
- Installed skill copy: /home/coder/.mux/src/agent-terminal/agent-terminal-ejrg/dogfood/20260327-public-skill/installed-skill/SKILL.md
- Screenshot proof: /home/coder/.mux/src/agent-terminal/agent-terminal-ejrg/dogfood/20260327-public-skill/packaged-smoke.png
- WebM proof: /home/coder/.mux/src/agent-terminal/agent-terminal-ejrg/dogfood/20260327-public-skill/packaged-smoke.webm
- Asciicast proof: /home/coder/.mux/src/agent-terminal/agent-terminal-ejrg/dogfood/20260327-public-skill/packaged-smoke.cast

Commands executed:

1. npm pack --json --dry-run
2. npm pack --json
3. npm install -g --prefix <temp> ./<tarball>
4. agent-terminal --home <temp> doctor/create/run/wait/snapshot/screenshot/record export/destroy
