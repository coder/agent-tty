# Week 2 remaining gaps

The Week 2 renderer-backed inspection slice is complete, but the following work is still intentionally out of scope or not yet delivered:

## Export and packaging

- **Asciicast export** is not implemented yet.
- **WebM video export** is not implemented yet.
- **MCP wrapper** is not implemented yet.

## Renderer backends and platform coverage

- **Native renderer adapters** are not implemented yet; the current slice is centered on the reference `ghostty-web` path.
- **Cross-platform rendering parity** is not guaranteed yet.

## Input and topology

- **Mouse input support** is not implemented yet.
- **Remote/network sessions** are not implemented yet.

## Fidelity and determinism

- **Screenshot pixel-perfect determinism** is not guaranteed; font rendering can still vary by environment.
- **Scrollback in snapshots** is not implemented; snapshots currently report the visible viewport only.
- **Cursor blink animation in screenshots** is not captured; screenshots represent a static frame.
