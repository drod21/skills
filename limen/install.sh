#!/bin/sh
# Install limen: an execute-only binary that appends to a root-owned,
# append-only log agents cannot read. Run as root: sudo sh limen/install.sh
#
# The log path is random, compiled into the binary and kept in /etc/limen.path
# (root-only). This script never prints it. Read the log with: limen-read
set -eu

[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }

here=$(cd "$(dirname "$0")" && pwd)
pathfile=/etc/limen.path

if [ -s "$pathfile" ]; then
  log=$(cat "$pathfile")
else
  log="/Library/Application Support/.$(openssl rand -hex 8)/complain.md"
  umask 077
  printf '%s\n' "$log" > "$pathfile"
fi
chown root:wheel "$pathfile"
chmod 0600 "$pathfile"

dir=$(dirname "$log")
mkdir -p "$dir"
chown root:wheel "$dir"
chmod 0711 "$dir"

if [ ! -e "$log" ]; then
  printf '# complain\n\nOne line per annoyance: time | session | project | sentence.\n\n' > "$log"
fi
chown root:wheel "$log"
chmod 0622 "$log"
chflags sappnd "$log"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
/usr/bin/clang -O2 -Wall -Werror -DLIMEN_FILE="\"$log\"" "$here/limen.c" -o "$tmp/limen"
install -o root -g wheel -m 0111 "$tmp/limen" /usr/local/bin/limen

cat > "$tmp/limen-read" <<'EOF'
#!/bin/sh
# Print the limen log. Needs your sudo password, which agents do not have.
exec sudo sh -c 'cat "$(cat /etc/limen.path)"'
EOF
install -o root -g wheel -m 0755 "$tmp/limen-read" /usr/local/bin/limen-read

echo "limen installed: /usr/local/bin/limen (execute-only), log append-only. Read it with: limen-read"
