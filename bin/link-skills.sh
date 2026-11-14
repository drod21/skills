#!/usr/bin/env bash
# Install this toolkit's skills into a project's .agents folder, then try to point
# .claude at those copies. Dry run by default; pass --apply to write.
#   <project>/.agents/skills/X   <- copy of <toolkit>/skills/X
#   <project>/.claude/skills/X   -> ../../.agents/skills/X   (relative symlink)
# With --apply, replaces same-named skills and Claude links, including stale files.
# Unrelated skill names and external symlink targets are preserved.
#   bin/link-skills.sh [--apply] [--install-pstack] PROJECT_DIR
# chief-of-staff ships in this toolkit and is refreshed on apply. pstack is
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

copy_skill() { # src dest
  local src="$1" dest="$2" staged=""
  if [ "$apply" = 0 ]; then
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      echo "would    replace $dest with copy of $src"
    else
      echo "would    copy $dest"
    fi
    return
  fi
  mkdir -p "$(dirname "$dest")"
  # Copy before removing the old entry; never follow a destination symlink.
  staged="$(mktemp -d "$(dirname "$dest")/.skill-install.XXXXXX")"
  if ! cp -R "$src/." "$staged/"; then
    rm -rf "$staged"
    return 1
  fi
  rm -rf "$dest"
  mv "$staged" "$dest"
  echo "copied   $dest"
}

# Relative symlink from .claude/skills/X to ../../.agents/skills/X.
link_claude() { # relative_src dest
  local src="$1" dest="$2" current=""
  # A shared skills directory already exposes the copies; linking would loop.
  if [ -d "$claude_skills" ] && [ -d "$agents_skills" ] &&
    [ "$(cd "$claude_skills" && pwd -P)" = "$(cd "$agents_skills" && pwd -P)" ]; then
    echo "ok       $dest (shared skills directory)"
    return
  fi
  [ -L "$dest" ] && current="$(readlink "$dest")"
  if [ "$current" = "$src" ]; then
    echo "ok       $dest"
  elif [ "$apply" = 1 ]; then
    mkdir -p "$(dirname "$dest")"
    rm -rf "$dest"
    ln -s "$src" "$dest"
    echo "linked   $dest -> $src"
  else
    echo "would    replace $dest with link -> $src"
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
