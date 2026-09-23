#!/usr/bin/env bash
#
# Merge this checkout into the release repository (project, verify, optionally commit).
#
#   scripts/sync-release-repo.sh [--rc <dir>] [--version <group>=<v>]… [--dry-run] [--yes] [--commit] [--gate]
#
# The release repo is a WHOLE-REPOSITORY projection of this one, so "merging" is one command:
# `scripts/make-release-tree.mjs --into <rc> --apply`. This wrapper makes that safe and repeatable: it
# previews the drift, PRESERVES each version group's release version unless you are cutting a new one,
# re-checks afterwards that rc really equals the projection, and prints the rc-side follow-up
# (commit → release gate → tag/publish).
#
# Defaults
#   --rc        $AVANTF_RC, else <repo>/../dsh-plugins-rc (created + `git init`ed if missing)
#   --version   by default the DEV TREE decides: every group is stamped with the version its publishable
#               manifest records (`pnpm version:set <group> <version>` is the one-file bump). Pass
#               --version <group>=<v> (base | mem | work) to stamp something else into rc only, or
#               --keep-rc-versions to keep whatever versions rc already carries (the old default: useful
#               when rc is ahead of the development tree).
#
# What it never does
#   - touch anything outside the two checkouts;
#   - delete files rc does not track (`node_modules/`, `*/lib/`, `dist/`, `release/*.tgz`) — the
#     projection only manages tracked files;
#   - commit in rc unless you ask (`--commit`), or run rc's gate unless you ask (`--gate`).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RC_DIR="${AVANTF_RC:-$REPO/../dsh-plugins-rc}"
VERSION_ARGS=()
KEEP_RC_VERSIONS=0
DRY_RUN=0
ASSUME_YES=0
DO_COMMIT=0
DO_GATE=0

usage() {
  cat <<'EOF'
usage: scripts/sync-release-repo.sh [options]

  --rc <dir>              release checkout to sync (default: $AVANTF_RC or ../dsh-plugins-rc)
  --version <group>=<v>   stamp this version into one group: base | mem | work (repeatable)
  --version <v>           stamp this version into all three groups
  --keep-rc-versions      keep rc's current versions instead of taking them from the development tree
  --dry-run               print the drift and exit (exit 1 when there is any), change nothing
  --yes, -y               do not ask for confirmation
  --commit                commit in rc after a clean sync: "release: sync from dsh-plugins@<sha>"
  --gate                  run rc's release gate before committing (artifact-level: mem runs with
                          --allow-uncut, because a sync is not a release cut)
  --help, -h              this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rc) RC_DIR="${2:-}"; shift 2 ;;
    --rc=*) RC_DIR="${1#*=}"; shift ;;
    --version) VERSION_ARGS+=(--version "${2:-}"); shift 2 ;;
    --version=*) VERSION_ARGS+=(--version "${1#*=}"); shift ;;
    --keep-rc-versions) KEEP_RC_VERSIONS=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --commit) DO_COMMIT=1; shift ;;
    --gate) DO_GATE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "sync-release-repo: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "sync-release-repo: node is required" >&2; exit 1; }
GENERATOR="$REPO/scripts/make-release-tree.mjs"
DEV_SHA="$(git -C "$REPO" rev-parse --short HEAD)"

# The release checkout is created on first use: the whole point of a fixed default path is that a fresh
# machine (or a fresh session) needs one command, not a manual `git init` first.
if [[ ! -d "$RC_DIR" ]]; then
  if [[ "$DRY_RUN" == 1 ]]; then
    echo "sync-release-repo: release checkout not found: $RC_DIR (nothing to compare against)" >&2
    exit 1
  fi
  mkdir -p "$RC_DIR"
  git -C "$RC_DIR" init -q
  echo "sync-release-repo: created $RC_DIR and initialised an empty git repository"
fi
# Resolve through a temporary: a failed `cd` would otherwise blank the variable before the message.
RESOLVED_RC="$(cd "$RC_DIR" 2>/dev/null && pwd)" || { echo "sync-release-repo: release checkout not found: ${RC_DIR:-(empty)}" >&2; exit 1; }
RC_DIR="$RESOLVED_RC"
[[ -d "$RC_DIR/.git" ]] || { echo "sync-release-repo: $RC_DIR is not a git checkout" >&2; exit 1; }
if [[ "$RC_DIR" == "$REPO" ]]; then
  echo "sync-release-repo: refusing to sync the development repository onto itself" >&2
  exit 2
fi

# ── 1. which version each group goes in with ─────────────────────────────────────────────────────
# The generator owns the facts (which manifests belong to a group, whether the tree agrees with
# its publishable manifest, what rc carries), so the shell never re-derives them. The default is "whatever
# the development tree records" — bumping a version is `pnpm version:set <group> <version>`, one file — and
# `--keep-rc-versions` restores the older "rc decides" behaviour for a release checkout that is ahead.
echo "▶ versions"
PREFER_RC=()
[[ "$KEEP_RC_VERSIONS" == 1 ]] && PREFER_RC=(--prefer-rc-versions)
RESOLVED=()
while IFS='|' read -r group dev rc effective source; do
  [[ -z "${group:-}" ]] && continue
  printf '  %-5s dev %-8s rc %-8s → %-8s (%s)\n' "$group" "$dev" "$rc" "$effective" "$source"
  RESOLVED+=(--version "$group=$effective")
done < <(node "$GENERATOR" --print-versions --rc "$RC_DIR" "${PREFER_RC[@]+"${PREFER_RC[@]}"}" "${VERSION_ARGS[@]+"${VERSION_ARGS[@]}"}")

echo "development     : $REPO @ $DEV_SHA"
echo "release         : $RC_DIR"
if git -C "$REPO" status --porcelain | grep -q .; then
  echo "note: this checkout has uncommitted changes — the projection uses the WORKING TREE content"
fi

# ── 2. what would change ──────────────────────────────────────────────────────────────────────────
echo
echo "▶ drift"
PLAN_RC=0
node "$GENERATOR" --into "$RC_DIR" "${RESOLVED[@]}" || PLAN_RC=$?
case "$PLAN_RC" in
  0) ;;
  1) echo "  (drift above; a sync would apply it)" ;;
  *) echo "  the generator CRASHED (exit $PLAN_RC) — this is not drift; fix the generator before syncing" >&2; exit "$PLAN_RC" ;;
esac

if [[ "$DRY_RUN" == 1 ]]; then
  echo
  echo "dry-run: nothing was changed."
  exit "$PLAN_RC"
fi

# ── 3. confirm ────────────────────────────────────────────────────────────────────────────────────
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

# ── 4. apply ──────────────────────────────────────────────────────────────────────────────────────
echo
echo "▶ apply"
node "$GENERATOR" --into "$RC_DIR" --apply "${RESOLVED[@]}"

# ── 5. re-check: rc must now equal the projection ─────────────────────────────────────────────────
echo
echo "▶ verify"
if ! node "$GENERATOR" --into "$RC_DIR" "${RESOLVED[@]}"; then
  echo "sync-release-repo: rc still differs from the projection — investigate before committing" >&2
  exit 1
fi

echo
echo "rc working tree:"
git -C "$RC_DIR" status --short | head -20
[[ "$(git -C "$RC_DIR" status --short | wc -l)" -gt 20 ]] && echo "  …and more (git -C $RC_DIR status)"

# ── 6. rc's own gate, then an optional commit ─────────────────────────────────────────────────────
if [[ "$DO_GATE" == 1 ]]; then
  echo
  echo "▶ rc release gate (install → boundary → publish surface → the three package gates → base-swap)"
  echo "  note: mem runs with --allow-uncut — this validates the ARTIFACT, not the release bookkeeping"
  echo "        (version bumped + CHANGELOG cut). A sync is not a release cut; before publishing, run"
  echo "        \`cd $RC_DIR && pnpm release:check:mem\` without the flag."
  (
    cd "$RC_DIR"
    pnpm install --frozen-lockfile
    pnpm guard
    pnpm release:check --offline
    pnpm release:check:base
    pnpm release:check:mem --allow-uncut
    pnpm release:check:work
    pnpm proof:base-swap
  )
fi

if [[ "$DO_COMMIT" == 1 ]]; then
  echo
  echo "▶ commit in rc"
  if [[ -z "$(git -C "$RC_DIR" status --porcelain)" ]]; then
    echo "  nothing to commit — rc already equals the projection"
  else
    git -C "$RC_DIR" add -A
    git -C "$RC_DIR" commit -m "release: sync from dsh-plugins@$DEV_SHA"
    git -C "$RC_DIR" --no-pager log --oneline -1
  fi
fi

cat <<EOF

done — release checkout: $RC_DIR
next (if you did not pass --commit/--gate):
  git -C $RC_DIR add -A
  git -C $RC_DIR commit -m "release: sync from dsh-plugins@$DEV_SHA"
  (cd $RC_DIR && pnpm install --frozen-lockfile && pnpm release:check:base && pnpm release:check:mem && pnpm release:check:work)
then tag and publish the three packages, base FIRST (each plugin's required peer):
  pnpm -C $RC_DIR/base/plugin-base publish --access public
  pnpm -C $RC_DIR/mem/packages/plugin publish --access public
  pnpm -C $RC_DIR/work/packages/plugin publish --access public
EOF
