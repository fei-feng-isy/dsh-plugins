#!/usr/bin/env bash
#
# Uninstall the avantf-mem DSH plugin from a profile and clean its configuration.
#
#   scripts/cleanup.sh [--profile web] [--dry-run] [--yes] [--keep-deps]
#
# What it does
#   1. surgically removes every `- id: avantf-mem` list item from the profile's
#      cordis.patch.yml and from the home-level `$DSH_HOME/cordis.patch.yml` (which
#      dsh layers over EVERY profile), plus an `- insert:` parent that our removal
#      left with no children. Other plugins' items, comments, ordering and
#      indentation are copied verbatim, and the edit is refused unless the set of
#      remaining `- id:` values is exactly "before minus avantf-mem" AND the result
#      still parses as YAML;
#   2. removes the four `@avantf/mem*` dependencies from the profile — through
#      `dsh plugin --profile <profile> remove …` (the official pnpm forwarder), which
#      also drops node_modules/@avantf/* and updates package.json + lockfile. Only
#      those four names are ever passed to it.
#
# What it deliberately does NOT touch
#   ~/.avantf/**            memory.db, knowledge.db, config.yaml, models/  (your data)
#   the repository          sources, packages/*/lib, the @deepseek-ai peer links
#   the harness checkout    <harness>/packages/client/avantf-dsh-mem (link-dsh stub)
#   ~/.cache/huggingface    a shared model cache
#   Every one of them is only reported at the end, with the command to clean it.
#
# The running dsh unmounts the plugin as soon as a patch changes (the profile sets
# `patchReload: live`), so a restart is optional — but cold-start once to confirm a
# clean boot.
set -euo pipefail

PROFILE="${DSH_PROFILE:-web}"
ENTRY_ID="avantf-mem"
PACKAGES=('@avantf/dsh-mem' '@avantf/mem' '@avantf/mem-contract' '@avantf/mem-retrieval')
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"

DRY_RUN=0
ASSUME_YES=0
KEEP_DEPS=0

usage() {
  cat <<'EOF'
usage: scripts/cleanup.sh [options]

  --profile <name>   dsh profile to clean (default: $DSH_PROFILE or "web")
  --dry-run          print the plan and the patch diffs, change nothing
  --yes, -y          do not ask for confirmation
  --keep-deps        only edit the patch file(s); keep the profile dependencies
  --help, -h         this help

Removes the avantf-mem plugin entry from the dsh patch config and the @avantf/mem*
dependencies from the profile. Never touches ~/.avantf (data), the repository, the
harness stub, or ~/.cache/huggingface.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --profile=*) PROFILE="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --keep-deps) KEEP_DEPS=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "cleanup: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! "$PROFILE" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "cleanup: refusing suspicious profile name '$PROFILE'" >&2
  exit 2
fi

PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
PROFILE_PATCH="$PROFILE_DIR/cordis.patch.yml"
HOME_PATCH="$DSH_HOME_DIR/cordis.patch.yml"
MANIFEST="$PROFILE_DIR/package.json"

[[ -d "$PROFILE_DIR" ]] || { echo "cleanup: profile directory not found: $PROFILE_DIR" >&2; exit 1; }
[[ -f "$PROFILE_PATCH" ]] || { echo "cleanup: patch not found: $PROFILE_PATCH" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── 1. plan ───────────────────────────────────────────────────────────────────
PRESENT=()
if [[ -f "$MANIFEST" ]]; then
  for pkg in "${PACKAGES[@]}"; do
    if grep -qF "\"$pkg\"" "$MANIFEST"; then PRESENT+=("$pkg"); fi
  done
fi

echo "profile : $PROFILE_DIR"
echo "patch   : $PROFILE_PATCH"
[[ -f "$HOME_PATCH" ]] && echo "patch   : $HOME_PATCH (home layer, applied over every profile)"
if [[ "$KEEP_DEPS" == 1 ]]; then
  echo "deps    : kept (--keep-deps)"
elif [[ ${#PRESENT[@]} -eq 0 ]]; then
  echo "deps    : none of the four @avantf/mem* packages are in package.json"
else
  echo "deps    : ${PRESENT[*]}"
fi

# Removes exactly the list item(s) whose `id:` is ENTRY_ID, plus a parent `- key:`
# item that our removal left childless. Everything else is copied verbatim.
clean_patch() {
  awk -v entry="$ENTRY_ID" '
    function ind(s,   m) { m = s; sub(/[^ \t].*$/, "", m); return length(m) }

    { line[NR] = $0; n = NR }

    END {
      for (i = 1; i <= n; i++) keep[i] = 1
      while (1) {
        start = 0
        for (i = 1; i <= n; i++) {
          if (!keep[i]) continue
          if (line[i] ~ ("^[[:space:]]*-[[:space:]]*id:[[:space:]]*[\047\"]?" entry "[\047\"]?[[:space:]]*$")) {
            start = i; entryInd = ind(line[i]); break
          }
        }
        if (start == 0) break

        # the item runs until the next surviving non-blank line at the same or shallower indent
        end = n
        for (i = start + 1; i <= n; i++) {
          if (!keep[i]) continue
          if (line[i] ~ /^[[:space:]]*$/) continue
          if (ind(line[i]) <= entryInd) { end = i - 1; break }
        }
        while (end > start && line[end] ~ /^[[:space:]]*$/) end--
        for (i = start; i <= end; i++) keep[i] = 0

        # our nearest shallower, surviving parent list item (`- insert:` / `- include:` …)
        parent = 0
        for (i = start - 1; i >= 1; i--) {
          if (!keep[i]) continue
          if (line[i] ~ /^[[:space:]]*$/) continue
          if (ind(line[i]) >= entryInd) continue
          if (line[i] ~ /^[[:space:]]*-[[:space:]]*[A-Za-z_][A-Za-z0-9_-]*:[[:space:]]*$/) parent = i
          break
        }
        if (parent > 0) {
          pInd = ind(line[parent]); hasChild = 0
          for (i = parent + 1; i <= n; i++) {
            if (!keep[i]) continue
            if (line[i] ~ /^[[:space:]]*$/) continue
            if (ind(line[i]) <= pInd) break
            if (line[i] ~ /^[[:space:]]*-[[:space:]]/) { hasChild = 1; break }
          }
          if (!hasChild) keep[parent] = 0
        }
      }
      for (i = 1; i <= n; i++) if (keep[i]) print line[i]
    }
  ' "$1"
}

ids_of() {
  { grep -oE "^[[:space:]]*-[[:space:]]*id:[[:space:]]*['\"]?[^'\"[:space:]]+" "$1" || true; } \
    | sed -E "s/.*id:[[:space:]]*['\"]?//" | sort
}

# dsh parses these files with `parsePatchList`, which throws unless the document is a
# top-level YAML ARRAY ("must be a top-level YAML array of loader patch entries"), and a
# file that is nothing but comments parses as null. So when our removal emptied the file,
# put the empty-array literal back — otherwise dsh would refuse to boot.
restore_empty_array() {
  local file="$1"
  if python3 -c 'import yaml' 2>/dev/null; then
    local kind
    kind="$(python3 - "$file" <<'PYCHECK'
import sys, yaml
value = yaml.safe_load(open(sys.argv[1], encoding='utf8'))
if value is None:
    print('empty')          # comments/blank lines only → dsh needs the [] literal back
elif isinstance(value, list):
    print('list')           # already an array (empty [] or real entries) → leave it alone
else:
    print('other')
PYCHECK
)"
    [[ "$kind" == 'empty' ]] && printf '[]\n' >> "$file"
    return 0
  fi
  # No parser: only the unambiguous "nothing but comments/blank lines" case.
  if ! grep -qE '^[[:space:]]*-' "$file" && ! grep -qE '^[^[:space:]#]' "$file"; then
    printf '[]\n' >> "$file"
  fi
}

# Guard-rail helper (written to $WORK): the cleaned file must parse to a top-level array.
check_patch_array() {
  python3 - "$1" <<'PYCHECK'
import sys, yaml
value = yaml.safe_load(open(sys.argv[1], encoding='utf8'))
if not isinstance(value, list):
    raise SystemExit(f'cleaned patch is {type(value).__name__}, not a top-level YAML array')
PYCHECK
}

# Candidate patch files, in the order dsh layers them.
PATCH_FILES=("$PROFILE_PATCH")
if [[ -f "$HOME_PATCH" && "$HOME_PATCH" != "$PROFILE_PATCH" ]]; then PATCH_FILES+=("$HOME_PATCH"); fi

N=${#PATCH_FILES[@]}
CHANGED=()
NEWFILE=()
for ((i = 0; i < N; i++)); do
  src="${PATCH_FILES[$i]}"
  out="$WORK/patch.$i.yml"
  clean_patch "$src" > "$out"
  restore_empty_array "$out"

  # guard rail 1: only OUR item may disappear
  expected="$(ids_of "$src" | grep -vx "$ENTRY_ID" || true)"
  actual="$(ids_of "$out")"
  if [[ "$actual" != "$expected" ]]; then
    echo "cleanup: ABORT — editing $src would change other plugin entries" >&2
    diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") >&2 || true
    exit 1
  fi
  if printf '%s\n' "$actual" | grep -qx "$ENTRY_ID"; then
    echo "cleanup: ABORT — the $ENTRY_ID entry survives in $src" >&2
    exit 1
  fi

  # guard rail 2: the result must still load in dsh — which requires a top-level YAML
  # ARRAY — or every plugin breaks, not just this one
  if python3 -c 'import yaml' 2>/dev/null; then
    if ! yaml_err="$(check_patch_array "$out" 2>&1)"; then
      echo "cleanup: ABORT — the cleaned $src would not load in dsh:" >&2
      echo "$yaml_err" >&2
      exit 1
    fi
  fi

  if diff -q "$src" "$out" >/dev/null; then CHANGED+=("0"); else CHANGED+=("1"); fi
  NEWFILE+=("$out")
done

for ((i = 0; i < N; i++)); do
  if [[ "${CHANGED[$i]}" == 1 ]]; then
    echo
    echo "--- ${PATCH_FILES[$i]} (current → cleaned) ---"
    diff -u "${PATCH_FILES[$i]}" "${NEWFILE[$i]}" || true
  fi
done

ANY_PATCH_CHANGE=0
for c in "${CHANGED[@]}"; do [[ "$c" == 1 ]] && ANY_PATCH_CHANGE=1; done

# ── 2. dry run / confirmation ─────────────────────────────────────────────────
if [[ "$DRY_RUN" == 1 ]]; then
  echo
  [[ "$ANY_PATCH_CHANGE" == 0 ]] && echo "dry-run: no patch change needed."
  [[ "$ANY_PATCH_CHANGE" == 1 ]] && echo "dry-run: the patch edit(s) above would be applied."
  if [[ "$KEEP_DEPS" == 0 && ${#PRESENT[@]} -gt 0 ]]; then echo "dry-run: deps would be removed: ${PRESENT[*]}"; fi
  echo "dry-run: nothing was changed."
  exit 0
fi

if [[ "$ANY_PATCH_CHANGE" == 0 && ( "$KEEP_DEPS" == 1 || ${#PRESENT[@]} -eq 0 ) ]]; then
  echo
  echo "already clean — nothing to do."
  exit 0
fi

if [[ "$ASSUME_YES" != 1 ]]; then
  echo
  printf 'apply the changes above? [y/N] '
  read -r reply || reply=""
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "aborted."; exit 1 ;;
  esac
fi

# ── 3. apply ──────────────────────────────────────────────────────────────────
for ((i = 0; i < N; i++)); do
  if [[ "${CHANGED[$i]}" == 1 ]]; then
    src="${PATCH_FILES[$i]}"
    backup="$src.bak.$(date +%Y%m%d-%H%M%S)"
    cp -p "$src" "$backup"
    cat "${NEWFILE[$i]}" > "$src"
    echo "patched : $src (backup: $backup)"
  fi
done

if [[ "$KEEP_DEPS" == 0 && ${#PRESENT[@]} -gt 0 ]]; then
  if command -v dsh >/dev/null 2>&1; then
    echo "removing dependencies via: dsh plugin --profile $PROFILE remove ${PRESENT[*]}"
    dsh plugin --profile "$PROFILE" remove "${PRESENT[@]}"
  elif command -v pnpm >/dev/null 2>&1; then
    echo "removing dependencies via: pnpm --dir $PROFILE_DIR remove ${PRESENT[*]}"
    pnpm --dir "$PROFILE_DIR" remove "${PRESENT[@]}"
  else
    echo "cleanup: neither dsh nor pnpm found — remove ${PRESENT[*]} from $MANIFEST by hand" >&2
    exit 1
  fi
fi

# ── 4. report ─────────────────────────────────────────────────────────────────
echo
echo "done. Left untouched on purpose:"
echo "  ~/.avantf/{memory,knowledge,config.yaml,models}   your data (back it up, then delete if you want)"
echo "  the repository                                    sources, packages/*/lib, packages/plugin/node_modules/@deepseek-ai"
echo "  <harness>/packages/client/avantf-dsh-mem          link-dsh stub (only the client bundle build needs it)"
echo "  ~/.cache/huggingface                              shared model cache"
for src in "${PATCH_FILES[@]}"; do
  if grep -q "$ENTRY_ID" "$src" 2>/dev/null; then
    echo
    echo "note: $src still mentions $ENTRY_ID in comments (left alone so other plugins' text is never touched):"
    grep -n "$ENTRY_ID" "$src" | sed 's/^/  /'
  fi
done
echo
echo "next: the running dsh unmounts the plugin as soon as a patch changed (patchReload: live);"
echo "      cold-start dsh once to confirm a clean boot."
