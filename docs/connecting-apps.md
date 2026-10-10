# Connecting your AI tools

MemoryCentral is a standard local (stdio) MCP server. Each AI tool needs to know one command and its arguments:

```
command:  <absolute path to node>
args:     <absolute path to MemoryCentral>/server/index.js
```

**The easiest way:** run `node setup.js`, finish setup, and open **Connect your apps**. It shows each snippet below with this machine's real paths filled in and escaped correctly, with a copy button. You can reopen it any time from **Settings**.

Use the **absolute** path to `node`. Apps launched from the Dock, Start menu or an IDE often don't inherit your terminal's `PATH`, so a bare `node` can fail to start. If you later upgrade Node (or switch versions with nvm), re-copy the snippets.

The server name is `memoryCentral`.

After adding it, restart the app or reload its MCP servers.

## Claude Code

This covers the CLI **and** the VS Code / JetBrains extensions, which share one configuration.

```bash
claude mcp add --transport stdio --scope user memoryCentral -- /path/to/node /path/to/MemoryCentral/server/index.js
```

Or add it to `~/.claude.json` (on Windows, `%USERPROFILE%\.claude.json`) under `mcpServers`:

```json
{ "mcpServers": { "memoryCentral": { "type": "stdio", "command": "/path/to/node", "args": ["/path/to/MemoryCentral/server/index.js"] } } }
```

**Optional:** sync the moment a session ends. The server already syncs every few minutes, so this is only for immediacy. Merge into `~/.claude/settings.json`:

```json
{ "hooks": { "Stop": [ { "matcher": "", "hooks": [ { "type": "command", "command": "/path/to/node /path/to/MemoryCentral/sync.js", "async": true } ] } ] } }
```

## VS Code (GitHub Copilot)

Command Palette → **MCP: Open User Configuration**, then merge this in. The top-level key is `servers`, not `mcpServers`.

```json
{ "servers": { "memoryCentral": { "type": "stdio", "command": "/path/to/node", "args": ["/path/to/MemoryCentral/server/index.js"] } } }
```

The user file lives at:

- macOS: `~/Library/Application Support/Code/User/mcp.json`
- Windows: `%APPDATA%\Code\User\mcp.json`
- Linux: `~/.config/Code/User/mcp.json`

For a single repository only, use `.vscode/mcp.json` in that repository instead.

## OpenAI Codex

One configuration covers the Codex CLI, its IDE extension and the desktop app.

```bash
codex mcp add memoryCentral -- /path/to/node /path/to/MemoryCentral/server/index.js
```

Or add it to `~/.codex/config.toml` (on Windows, `%USERPROFILE%\.codex\config.toml`):

```toml
[mcp_servers.memoryCentral]
command = '/path/to/node'
args = ['/path/to/MemoryCentral/server/index.js']
```

Single-quoted TOML strings take Windows backslashes as-is: `'C:\Program Files\nodejs\node.exe'`.

## OpenCode

In `~/.config/opencode/opencode.json`. Note the differences from the other tools: `type` is `local`, and `command` is one array holding the program and its arguments.

```json
{ "$schema": "https://opencode.ai/config.json", "mcp": { "memoryCentral": { "type": "local", "command": ["/path/to/node", "/path/to/MemoryCentral/server/index.js"], "enabled": true } } }
```

## Anything else

Any app that supports local (stdio) MCP servers takes the same command and arguments. Look up where that app keeps its MCP configuration.

## Getting the AI to use it

Connecting makes the tools available. To have the AI reach for them without being asked, MemoryCentral sends instructions to every app that supports them. For per-project guidance, add a [project block](project-block.md) to the instructions file your tool reads.
