#!/usr/bin/env bash
# Install this toolkit's skills into a project's .agents folder, then try to point
# .claude at those copies. Dry run by default; pass --apply to write.
#   <project>/.agents/skills/X   <- copy of <toolkit>/skills/X
#   <project>/.claude/skills/X   -> ../../.agents/skills/X   (relative symlink)
# Never overwrites an existing real entry. A link that still points at this toolkit
# is replaced with a fresh copy under .agents.
#   bin/link-skills.sh [--apply] [--install-pstack] PROJECT_DIR
# chief-of-staff ships in this toolkit, so it is installed when missing. pstack is
# third-party (a Claude Code plugin); --install-pstack --apply installs it only if absent.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
apply=0
install_pstack=0
project_dir=""

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=1 ;;
    --install-pstack) install_pstack=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    -*) echo "unknown argument: $1" >&2; exit 2 ;;
    *)
      if [ -n "$project_dir" ]; then
        echo "unexpected argument: $1 (project directory already set to $project_dir)" >&2
        exit 2
      fi
      project_dir="$1"
      ;;
  esac
  shift
done

if [ -z "$project_dir" ]; then
  echo "usage: bin/link-skills.sh [--apply] [--install-pstack] PROJECT_DIR" >&2
  exit 2
fi

project_dir="$(cd "$project_dir" && pwd)"
agents_skills="$project_dir/.agents/skills"
claude_skills="$project_dir/.claude/skills"

# True when dest is a symlink into this toolkit (old layout).
points_at_toolkit() {
  local dest="$1" current=""
  [ -L "$dest" ] || return 1
  current="$(readlink "$dest")"
  case "$current" in
    "$root"/*) return 0 ;;
    *) return 1 ;;
  esac
}

copy_skill() { # src dest
  local src="$1" dest="$2"
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
    # Still the old absolute link; replace with a copy under --apply.
    if [ "$apply" = 1 ]; then
      rm "$dest"
      cp -R "$src" "$dest"
      echo "copied   $dest (was link -> $src)"
    else
      echo "would    copy $dest (replace link -> $src)"
    fi
  elif points_at_toolkit "$dest"; then
    local current
    current="$(readlink "$dest")"
    if [ "$apply" = 1 ]; then
      rm "$dest"
      cp -R "$src" "$dest"
      echo "copied   $dest (was link -> $current)"
    else
      echo "would    copy $dest (replace link -> $current)"
    fi
  elif [ -e "$dest" ] || [ -L "$dest" ]; then
    echo "SKIP     $dest exists; not overwritten"
  elif [ "$apply" = 1 ]; then
    mkdir -p "$(dirname "$dest")"
    cp -R "$src" "$dest"
    echo "copied   $dest"
  else
    echo "would    copy $dest"
  fi
}

# Relative symlink from .claude/skills/X to ../../.agents/skills/X.
# Re-points an old absolute toolkit link; otherwise skips real conflicts.
link_claude() { # relative_src dest
  local src="$1" dest="$2" current=""
  [ -L "$dest" ] && current="$(readlink "$dest")"
  if [ "$current" = "$src" ]; then
    echo "ok       $dest"
  elif [ -n "$current" ] && case "$current" in "$root"/*) true ;; *) false ;; esac; then
    if [ "$apply" = 1 ]; then
      if ln -sfn "$src" "$dest" 2>/dev/null; then
        echo "relinked $dest -> $src (was $current)"
      else
        echo "SKIP     $dest: could not relink"
      fi
    else
      echo "would    relink $dest -> $src (was $current)"
    fi
  elif [ -e "$dest" ] || [ -L "$dest" ]; then
    echo "SKIP     $dest exists (points to ${current:-a real file}); not overwritten"
  elif [ "$apply" = 1 ]; then
    mkdir -p "$(dirname "$dest")"
    if ln -s "$src" "$dest" 2>/dev/null; then
      echo "linked   $dest -> $src"
    else
      echo "SKIP     $dest: could not create symlink"
    fi
  else
    echo "would    $dest -> $src"
  fi
}

for dir in "$root"/skills/*/; do
  name="$(basename "$dir")"
  agents_dest="$agents_skills/$name"
  copy_skill "${dir%/}" "$agents_dest"

  # Point Claude at the .agents copy when that entry is present (or will be).
  if [ -e "$agents_dest" ] || [ -L "$agents_dest" ] || [ "$apply" = 0 ]; then
    link_claude "../../.agents/skills/$name" "$claude_skills/$name"
  else
    echo "SKIP     $claude_skills/$name: $agents_dest is missing"
  fi
done

if [ "$install_pstack" = 1 ]; then
  if ! command -v claude >/dev/null 2>&1; then
    echo "SKIP     pstack: the claude CLI is not on PATH"
  elif claude plugin list 2>/dev/null | grep -q 'pstack@'; then
    echo "ok       pstack plugin already installed"
  elif [ "$apply" = 1 ]; then
    claude plugin marketplace add cursor/plugins || true
    claude plugin install pstack@cursor-plugins
  else
    echo "would    install plugin pstack@cursor-plugins (marketplace cursor/plugins)"
  fi
fi
[ "$apply" = 1 ] || echo "dry run: pass --apply to copy into .agents and link .claude"
