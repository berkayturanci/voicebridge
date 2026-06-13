#!/usr/bin/env bash
# Register a GitHub Actions *self-hosted* runner for voicebridge on this machine.
# Self-hosted runners are free, including for private repositories.
#
# 1. Get a one-time registration token:
#      GitHub → repo → Settings → Actions → Runners → "New self-hosted runner".
#    Copy the token shown in the `./config.sh --token <TOKEN>` line.
# 2. Run:  ./scripts/setup-self-hosted-runner.sh <TOKEN>
#
# Then start it with `./run.sh` (foreground) or install it as a service
# (`sudo ./svc.sh install && sudo ./svc.sh start`) from the runner directory.
set -euo pipefail

REPO_URL="https://github.com/berkayturanci/speak-with-claude-code"
TOKEN="${1:-${RUNNER_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  echo "Usage: $0 <registration-token>"
  echo "Get the token from: repo → Settings → Actions → Runners → New self-hosted runner"
  exit 1
fi

# Latest runner version.
VER="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest \
  | grep -o '"tag_name": *"v[^"]*"' | head -1 | sed 's/.*"v//;s/"//')"
[ -n "$VER" ] || { echo "Could not determine the latest runner version."; exit 1; }

case "$(uname -s)" in
  Darwin) OS=osx ;;
  Linux)  OS=linux ;;
  *) echo "Unsupported OS: $(uname -s)"; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) echo "Unsupported arch: $(uname -m)"; exit 1 ;;
esac

DIR="$HOME/actions-runner-voicebridge"
TARBALL="actions-runner-${OS}-${ARCH}-${VER}.tar.gz"
mkdir -p "$DIR" && cd "$DIR"

if [ ! -f "$TARBALL" ]; then
  echo "Downloading runner v${VER} (${OS}-${ARCH})…"
  curl -fsSL -o "$TARBALL" "https://github.com/actions/runner/releases/download/v${VER}/${TARBALL}"
fi
tar xzf "$TARBALL"

./config.sh --url "$REPO_URL" --token "$TOKEN" --unattended \
  --labels self-hosted --name "$(hostname)-voicebridge" --replace

echo
echo "Runner configured in: $DIR"
echo "Start it:            (cd \"$DIR\" && ./run.sh)"
echo "Or as a service:     (cd \"$DIR\" && sudo ./svc.sh install && sudo ./svc.sh start)"
