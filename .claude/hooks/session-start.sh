#!/bin/bash
# SessionStart hook: install the coding-agent CLIs this project is configured for
# so their commands work in Claude Code on the web sessions.
#
#   jury -> ai-jury        (PyPI: ai-jury)
#   keel -> keel-workflow  (PyPI: keel-workflow — provides the `keel` command)
#
# Both are first-party PyPI packages owned by berkayturanci. Idempotent and
# non-interactive; safe to run on every session start.
set -euo pipefail

# Only run in the remote (web) environment; manage your own tools locally.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# pip --user installs console scripts here; keep them on PATH for the session.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
fi
export PATH="$HOME/.local/bin:$PATH"

echo "[session-start] installing ai-jury + keel-workflow from PyPI…"
pip3 install --user --quiet --upgrade ai-jury keel-workflow

echo "[session-start] done."
command -v jury >/dev/null 2>&1 && echo "  jury -> $(jury --version 2>&1 | head -1)"
command -v keel >/dev/null 2>&1 && echo "  keel -> $(keel --version 2>&1 | head -1)"
