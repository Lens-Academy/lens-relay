# Ephemeral Workspace Port Design

Ephemeral agent workspaces inherit their persistent workspace's base ports and add a letter-derived offset: no suffix adds 0, `a` adds 1, `b` adds 2, through `z` adding 26. For example, `ws1a` uses Vite 5174 and Relay 8091, while `ws2b` uses Vite 5275 and Relay 8192.

Discord bridge ports use a separate lane so they cannot collide with ephemeral Relay ports: ws1 uses 8050, ws2 uses 8150, and ws3 uses 8250, with the same suffix offset. Utility ports remain workspace ranges rather than automatically assigned single ports; agents must choose a free port in the parent's 9100+/9200+/9300+ range.

Dev tooling detects persistent and ephemeral names automatically. Explicit `VITE_PORT`, `RELAY_PORT`, and `DISCORD_BRIDGE_PORT` values continue to override defaults. Ephemeral agents start servers only when verification requires them and stop owned servers before destroying the workspace.

Lens Relay stores its shared local instructions in both `CLAUDE.local.md` and `codex.local.toml`, kept synchronized. All persistent Relay workspaces consume those parent-level files.
