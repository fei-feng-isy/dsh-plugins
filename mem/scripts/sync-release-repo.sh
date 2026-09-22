#!/usr/bin/env bash
#
# Merge this checkout into the release repository (project, verify, optionally commit).
#
#   scripts/sync-release-repo.sh [--rc <dir>] [--version <v>] [--dry-run] [--yes] [--commit] [--gate]
#
# The release repo is a projection of this one, so "merging" is one command:
# `scripts/make-release-tree.mjs --into <rc> --apply`. This wrapper exists to make that command safe
# and repeatable: it previews the drift, preserves the release version unless you are cutting a new
# one, re-checks afterwards that rc really equals the projection, and prints the rc-side follow-up
# (commit → release gate → tag/publish).
#
# Defaults
#   --rc        $AVANTF_RC, else <repo>/../avantf-mem-rc
#   --version   the version rc currently carries (so re-syncing never silently moves it); pass
#               --version X.Y.Z to stamp a new release version into all seven manifests
#
# What it never does
#   - touch `~/.avantf` or anything outside the two checkouts;
#   - delete files rc does not track (`node_modules/`, `packages/*/lib/`, `dist/`) — the projection
#     only manages tracked files;
#   - commit in rc unless you ask (`--commit`), or run rc's gate unless you ask (`--gate`).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RC_DIR="${AVANTF_RC:-$REPO/../avantf-mem-rc}"
VERSION=""
DRY_RUN=0
ASSUME_YES=0
DO_COMMIT=0
DO_GATE=0

usage() {
  cat <<'EOF'
usage: scripts/sync-release-repo.sh [options]

  --rc <dir>          release checkout to sync (default: $AVANTF_RC or ../avantf-mem-rc)
  --version <v>       stamp this version into the release manifests (default: keep rc's current)
  --dry-run           print the drift and exit (exit 1 when there is any), change nothing
  --yes, -y           do not ask for confirmation
  --commit            commit in rc after a clean sync: "release: sync from avantf-mem@<sha>"
  --gate              run rc's `pnpm release:check` before committing (needs a global dsh)
  --help, -h          this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rc) RC_DIR="${2:-}"; shift 2 ;;
    --rc=*) RC_DIR="${1#*=}"; shift ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --commit) DO_COMMIT=1; shift ;;
    --gate) DO_GATE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "sync-release-repo: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "sync-release-repo: node is required" >&2; exit 1; }
# Resolve through a temporary: a failed `cd` would otherwise blank the variable before the message.
RESOLVED_RC="$(cd "$RC_DIR" 2>/dev/null && pwd)" || { echo "sync-release-repo: release checkout not found: ${RC_DIR:-(empty)}" >&2; exit 1; }
RC_DIR="$RESOLVED_RC" 
[[ -d "$RC_DIR/.git" ]] || { echo "sync-release-repo: $RC_DIR is not a git checkout" >&2; exit 1; }
if [[ "$RC_DIR" == "$REPO" ]]; then
  echo "sync-release-repo: refusing to sync the development repository onto itself" >&2
  exit 2
fi

GENERATOR="$REPO/scripts/make-release-tree.mjs"
DEV_VERSION="$(node -e "console.log(require('$REPO/package.json').version)")"
RC_VERSION="$(node -e "console.log(require('$RC_DIR/package.json').version)")"
DEV_SHA="$(git -C "$REPO" rev-parse --short HEAD)"

# Preserving rc's version by default is the point: re-syncing must not silently move the release
# version (and moving it is a release cut, which is what --version is for).
VERSION_ARGS=()
if [[ -n "$VERSION" ]]; then
  VERSION_ARGS=(--version "$VERSION")
  echo "release version : $VERSION (stamped; rc currently has $RC_VERSION, this checkout has $DEV_VERSION)"
else
  VERSION_ARGS=(--version "$RC_VERSION")
  echo "release version : $RC_VERSION (kept — pass --version X.Y.Z to cut a new one)"
fi
# What the release tree will carry AFTER this run — the closing hint tags and names the tarball, so
# using `$RC_VERSION` there printed a stale version whenever `--version` moved it.
EFFECTIVE_VERSION="${VERSION:-$RC_VERSION}"
echo "development     : $REPO @ $DEV_SHA (version $DEV_VERSION)"
echo "release         : $RC_DIR (version $RC_VERSION → $EFFECTIVE_VERSION)"

if git -C "$REPO" status --porcelain | grep -q .; then
  echo "note: this checkout has uncommitted changes — the projection uses the WORKING TREE content"
fi

# ── 1. what would change ────────────────────────────────────────────────────────────────────────
echo
echo "▶ drift"
PLAN_RC=0
node "$GENERATOR" --into "$RC_DIR" "${VERSION_ARGS[@]}" || PLAN_RC=$?
case "$PLAN_RC" in
  0) ;;
  1) echo "  (drift above; a sync would apply it)" ;;
  *) echo "  the generator failed (exit $PLAN_RC)" >&2; exit "$PLAN_RC" ;;
esac

if [[ "$DRY_RUN" == 1 ]]; then
  echo
  echo "dry-run: nothing was changed."
  exit "$PLAN_RC"
fi

# ── 2. confirm ──────────────────────────────────────────────────────────────────────────────────
if [[ "$ASSUME_YES" != 1 ]]; then
  echo
  printf 'apply this projection to %s' "$RC_DIR"
  [[ "$DO_COMMIT" == 1 ]] && printf ' AND commit there'
  [[ "$DO_GATE" == 1 ]] && printf ' (gate runs first)'
  printf '? [y/N] '
  read -r reply || reply=""
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "aborted."; exit 1 ;;
  esac
fi

# ── 3. apply ────────────────────────────────────────────────────────────────────────────────────
echo
echo "▶ apply"
node "$GENERATOR" --into "$RC_DIR" --apply "${VERSION_ARGS[@]}"

# ── 4. re-check: rc must now equal the projection ───────────────────────────────────────────────
echo
echo "▶ verify"
if ! node "$GENERATOR" --into "$RC_DIR" "${VERSION_ARGS[@]}"; then
  echo "sync-release-repo: rc still differs from the projection — investigate before committing" >&2
  exit 1
fi

echo
echo "rc working tree:"
git -C "$RC_DIR" status --short | head -20
[[ "$(git -C "$RC_DIR" status --short | wc -l)" -gt 20 ]] && echo "  …and more (git -C $RC_DIR status)"

# ── 5. rc's own gate, then an optional commit ───────────────────────────────────────────────────
if [[ "$DO_GATE" == 1 ]]; then
  echo
  echo "▶ rc release gate (install / build / typecheck / plugin gates / pack --mount)"
  (cd "$RC_DIR" && pnpm release:check)
fi

if [[ "$DO_COMMIT" == 1 ]]; then
  echo
  echo "▶ commit in rc"
  if [[ -z "$(git -C "$RC_DIR" status --porcelain)" ]]; then
    echo "  nothing to commit — rc already equals the projection"
  else
    git -C "$RC_DIR" add -A
    git -C "$RC_DIR" commit -m "release: sync from avantf-mem@$DEV_SHA"
    git -C "$RC_DIR" --no-pager log --oneline -1
  fi
fi

cat <<EOF

done — release checkout: $RC_DIR
next (if you did not pass --commit/--gate):
  git -C $RC_DIR add -A
  git -C $RC_DIR commit -m "release: sync from avantf-mem@$DEV_SHA"
  (cd $RC_DIR && pnpm release:check)          # install / build / typecheck / plugin gate / pack --mount
then tag and publish the ONE package:
  git -C $RC_DIR tag -a v$EFFECTIVE_VERSION -m "avantf-mem $EFFECTIVE_VERSION" && git -C $RC_DIR push --follow-tags
  pnpm --filter @avantf/dsh-mem publish --access public --no-git-checks
EOF
