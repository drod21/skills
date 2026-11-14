#!/usr/bin/env bash
# Link this toolkit's skills and agents in two layers. Dry run by default; pass --apply to write.
#   ~/.agents/skills/X    -> <toolkit>/skills/X       (the real home; any harness can read ~/.agents)
#   ~/.claude/skills/X    -> ../../.agents/skills/X   (Claude Code sees it through a relative symlink)
# Agents go the same way: ~/.agents/agents/X.md, then ~/.claude/agents/X.md -> ../../.agents/agents/X.md.
# Never overwrites an existing real entry. A link that points straight at this toolkit (the old layout)
# is re-pointed at the ~/.agents layer.
#   bin/link-skills.sh [--apply] [--install-pstack] [--agents-root DIR] [--claude-root DIR]
# chief-of-staff ships in this toolkit, so it is linked when missing. pstack is third-party (a Claude Code
# plugin); --install-pstack --apply installs it only if it is absent.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agents_root="${HOME}/.agents"
claude_root="${HOME}/.claude"
apply=0
install_pstack=0

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=1 ;;
    --install-pstack) install_pstack=1 ;;
    --agents-root) agents_root="$2"; shift ;;
    --claude-root) claude_root="$2"; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

link() { # src dest
  local src="$1" dest="$2" current=""
  [ -L "$dest" ] && current="$(readlink "$dest")"
  if [ "$current" = "$src" ]; then
    echo "ok       $dest"
  elif [ -n "$current" ] && case "$current" in "$root"/*) true ;; *) false ;; esac; then
    if [ "$apply" = 1 ]; then
      ln -sfn "$src" "$dest"
      echo "relinked $dest -> $src (was $current)"
    else
      echo "would    relink $dest -> $src (was $current)"
    fi
  elif [ -e "$dest" ] || [ -L "$dest" ]; then
    echo "SKIP     $dest exists (points to $(readlink "$dest" 2>/dev/null || echo 'a real file')); not overwritten"
  elif [ "$apply" = 1 ]; then
    mkdir -p "$(dirname "$dest")"
    ln -s "$src" "$dest"
    echo "linked   $dest -> $src"
  else
    echo "would    $dest -> $src"
  fi
}

for dir in "$root"/skills/*/; do
  name="$(basename "$dir")"
  link "${dir%/}" "$agents_root/skills/$name"
  # Claude's link is relative, and only when the ~/.agents entry is ours.
  if [ "$(readlink "$agents_root/skills/$name" 2>/dev/null)" = "${dir%/}" ] || [ "$apply" = 0 ]; then
    link "../../.agents/skills/$name" "$claude_root/skills/$name"
  else
    echo "SKIP     $claude_root/skills/$name: $agents_root/skills/$name is not this toolkit's"
  fi
done
for file in "$root"/agents/*.md; do
  name="$(basename "$file")"
  link "$file" "$agents_root/agents/$name"
  if [ "$(readlink "$agents_root/agents/$name" 2>/dev/null)" = "$file" ] || [ "$apply" = 0 ]; then
    link "../../.agents/agents/$name" "$claude_root/agents/$name"
  else
    echo "SKIP     $claude_root/agents/$name: $agents_root/agents/$name is not this toolkit's"
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
[ "$apply" = 1 ] || echo "dry run: pass --apply to create the links"
