// "Connect your apps": ready-to-paste MCP registrations for the common AI tools.
//
// Every tool registers a local stdio MCP server the same way underneath — a
// command and its arguments — but each wants it in its own file and format
// (verified against each tool's docs, 2026-10-09). The snippets use this machine's
// absolute paths: apps launched from a GUI often don't inherit the shell's PATH,
// so a bare `node` can fail to start where an absolute path cannot.
//
// The server name stays "memoryCentral" so existing registrations, and the tool
// names agents already use (mcp__memoryCentral__…), keep working.

import { join } from 'path';
import { homedir } from 'os';

export const SERVER_NAME = 'memoryCentral';

// Quotes a path for a shell command line. Windows shells (cmd, PowerShell) take
// double quotes; POSIX shells take single quotes, which need no inner escaping
// except for a literal single quote.
export function shellQuote(s, platform = process.platform) {
  if (platform === 'win32') return /[\s&()^%!"']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  return /[^\w@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}

// TOML literal strings ('...') take backslashes verbatim — Windows paths need no
// escaping. A path containing a single quote falls back to a basic string.
export function tomlString(s) {
  return s.includes("'") ? JSON.stringify(s) : `'${s}'`;
}

// Where each tool keeps its user-level config, per platform.
function configPaths(platform, home) {
  const win = platform === 'win32';
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  return {
    claude: win ? '%USERPROFILE%\\.claude.json' : '~/.claude.json',
    vscode: platform === 'darwin' ? '~/Library/Application Support/Code/User/mcp.json'
      : win ? join(appData, 'Code', 'User', 'mcp.json') : '~/.config/Code/User/mcp.json',
    codex: win ? '%USERPROFILE%\\.codex\\config.toml' : '~/.codex/config.toml',
    opencode: win ? '%USERPROFILE%\\.config\\opencode\\opencode.json' : '~/.config/opencode/opencode.json',
  };
}

// One entry per tool: where it goes, how to add it, and the exact text.
export function connectSnippets({ node, server, sync, platform = process.platform, home = homedir() }) {
  const q = s => shellQuote(s, platform);
  const paths = configPaths(platform, home);
  const json = obj => JSON.stringify(obj, null, 2);
  return [
    {
      id: 'claude',
      name: 'Claude Code',
      note: 'Covers the Claude Code CLI and its VS Code / JetBrains extensions — they share one MCP configuration. Run once in a terminal.',
      steps: [
        { label: 'Terminal', lang: 'shell', text: `claude mcp add --transport stdio --scope user ${SERVER_NAME} -- ${q(node)} ${q(server)}` },
        { label: `Or add to ${paths.claude} under "mcpServers"`, lang: 'json',
          text: json({ mcpServers: { [SERVER_NAME]: { type: 'stdio', command: node, args: [server] } } }) },
        { label: 'Optional: sync the moment a session ends (the server also syncs every few minutes on its own). Merge into ~/.claude/settings.json', lang: 'json',
          text: json({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `${q(node)} ${q(sync)}`, async: true }] }] } }) },
      ],
    },
    {
      id: 'vscode',
      name: 'VS Code (GitHub Copilot)',
      note: 'Command Palette → "MCP: Open User Configuration", then merge this in. The top-level key is "servers".',
      steps: [
        { label: paths.vscode, lang: 'json', text: json({ servers: { [SERVER_NAME]: { type: 'stdio', command: node, args: [server] } } }) },
      ],
    },
    {
      id: 'codex',
      name: 'OpenAI Codex',
      note: 'One configuration covers the Codex CLI, its IDE extension and the desktop app.',
      steps: [
        { label: 'Terminal', lang: 'shell', text: `codex mcp add ${SERVER_NAME} -- ${q(node)} ${q(server)}` },
        { label: `Or add to ${paths.codex}`, lang: 'toml', text: `[mcp_servers.${SERVER_NAME}]\ncommand = ${tomlString(node)}\nargs = [${tomlString(server)}]` },
      ],
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      note: 'Note the differences from other tools: "type" is "local", and command is one array (no separate args).',
      steps: [
        { label: paths.opencode, lang: 'json', text: json({ $schema: 'https://opencode.ai/config.json', mcp: { [SERVER_NAME]: { type: 'local', command: [node, server], enabled: true } } }) },
      ],
    },
    {
      id: 'other',
      name: 'Anything else',
      note: 'Any app that supports local (stdio) MCP servers takes the same two things. See its documentation for where they go.',
      steps: [{ label: 'Command and arguments', lang: 'text', text: `command: ${node}\nargs:    ${server}` }],
    },
  ];
}
