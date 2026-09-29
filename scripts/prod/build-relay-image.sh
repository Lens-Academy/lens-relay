#!/usr/bin/env bash
# Build relay-server:custom from crates/relay-binary, refusing a stale binary.
#
# Run on prod from the lens-relay checkout after `git pull` and after copying a
# fresh binary to crates/relay-binary (AGENTS.md, "Deploying to production").
# The binary is accepted only if no Rust source under crates/ (the crate
# directories, Cargo.toml, Cargo.lock) differs between the commit it was built
# from and this checkout, uncommitted edits included. Editor-only commits, or
# changes to files that are copied rather than compiled (run.sh, relay.toml,
# Dockerfiles), are fine; any other crates/ change means the binary is stale.
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

if ! built="$(docker run --rm -v "$PWD/$BIN:/relay:ro" "$RUNNER_IMAGE" /relay version --commit)"; then
  die "could not run '$BIN version --commit' in $RUNNER_IMAGE (error above). If it rejects '--commit', the binary predates this check and is stale: rebuild it. Otherwise fix docker or the binary's architecture first."
fi
built="$(printf '%s' "$built" | tr -d '[:space:]')"
[ -n "$built" ] && [ "$built" != unknown ] \
  || die "$BIN does not know which commit it was built from. Rebuild it inside a git checkout."

commit="$(git rev-parse --verify --quiet "${built}^{commit}")" \
  || die "$BIN was built from '$built', which this checkout does not have. Push that commit and git pull, or rebuild the binary from HEAD."

# What the binary is compiled from. Compared against the working tree, so an
# uncommitted edit on the box also counts as a change.
SOURCE=(crates/Cargo.toml crates/Cargo.lock ':(glob)crates/*/**')
if ! git diff --quiet "$commit" -- "${SOURCE[@]}"; then
  echo "build-relay-image: $BIN is stale: relay source differs between its commit $built and this checkout (HEAD $(git rev-parse --short=12 HEAD), plus uncommitted edits):" >&2
  git diff --stat "$commit" -- "${SOURCE[@]}" >&2
  die "commit, rebuild the binary from HEAD and copy it to $BIN."
fi

echo "build-relay-image: $BIN built from $built; relay source unchanged since. Building relay-server."
docker compose -f "$COMPOSE_FILE" build --build-arg RELAY_EXPECTED_COMMIT="$built" relay-server
