#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="${REPO_DIR}/server"
SERVER_ENTRY="${SERVER_DIR}/index.js"

echo "=== MemoryCentral Setup ==="
echo ""

# Node.js check (>=18 required for ESM + fetch)
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found."
  echo "Install via: https://nodejs.org  or  brew install node"
  exit 1
fi

NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "ERROR: Node.js >=18 required (found v$(node --version))."
  exit 1
fi

echo "Node.js $(node --version) OK"

# Install dependencies
echo ""
echo "Installing server dependencies..."
npm install --prefix "$SERVER_DIR" --silent
echo "Done."

# Print config snippets
echo ""
echo "================================================================"
echo "  One-time config — add the block below to your MCP client(s)"
echo "================================================================"
echo ""

echo "-- Claude Code (~/.claude/settings.json) --"
cat <<EOF
{
  "mcpServers": {
    "memory-central": {
      "command": "node",
      "args": ["${SERVER_ENTRY}"]
    }
  }
}
EOF

echo ""
echo "-- OpenCode (~/.config/opencode/config.json or similar) --"
cat <<EOF
{
  "mcp": {
    "servers": {
      "memory-central": {
        "command": "node",
        "args": ["${SERVER_ENTRY}"]
      }
    }
  }
}
EOF

echo ""
echo "-- OpenWebUI (Settings → Tools → Add MCP Tool Server) --"
echo "  Command : node"
echo "  Args    : ${SERVER_ENTRY}"
echo ""
echo "================================================================"
echo ""
echo "Setup complete. Run ./sync.sh to populate project memories."
echo "Then restart your MCP client to load the server."
