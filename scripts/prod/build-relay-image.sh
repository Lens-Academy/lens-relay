#!/usr/bin/env bash
# Build relay-server:custom from crates/relay-binary, refusing a stale binary.
#
# Run on prod from the lens-relay checkout after `git pull` and after copying a
# fresh binary to crates/relay-binary (AGENTS.md, "Deploying to production").
# The binary is accepted only if no file under crates/ differs between the
# commit it was built from and HEAD. Editor-only commits since then are fine;
# any crates/ change means the binary is stale and must be rebuilt.
#
# Builds the image only; recreate the container yourself afterwards.
set -euo pipefail

cd "$(dirname "$0")/../.."

BIN=crates/relay-binary
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yaml}"
# Run the binary in the image it will ship in, so the host's libc does not matter.
RUNNER_IMAGE="${RELAY_BINARY_RUNNER_IMAGE:-debian:trixie-slim}"

die() {
  echo "build-relay-image: $*" >&2
  exit 1
}

[ -f "$BIN" ] || die "no $BIN. Build the binary off-prod and copy it there first."
chmod +x "$BIN"

built="$(docker run --rm -v "$PWD/$BIN:/relay:ro" "$RUNNER_IMAGE" /relay version --commit)" \
  || die "$BIN does not support 'relay version --commit', so it predates this check and is stale. Rebuild it."
built="$(printf '%s' "$built" | tr -d '[:space:]')"
[ -n "$built" ] && [ "$built" != unknown ] \
  || die "$BIN does not know which commit it was built from. Rebuild it inside a git checkout."

commit="$(git rev-parse --verify --quiet "${built}^{commit}")" \
  || die "$BIN was built from '$built', which this checkout does not have. Push that commit and git pull, or rebuild the binary from HEAD."

if ! git diff --quiet "$commit" HEAD -- crates/; then
  echo "build-relay-image: $BIN is stale: crates/ differs between its commit $built and HEAD $(git rev-parse --short=12 HEAD):" >&2
  git diff --stat "$commit" HEAD -- crates/ >&2
  die "rebuild the binary from HEAD and copy it to $BIN."
fi

echo "build-relay-image: $BIN built from $built; crates/ unchanged since. Building relay-server."
docker compose -f "$COMPOSE_FILE" build --build-arg RELAY_EXPECTED_COMMIT="$built" relay-server
