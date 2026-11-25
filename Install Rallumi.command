#!/bin/zsh
set -eu
umask 077

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
source_dir=${0:A:h}
app_dir="$HOME/Library/Application Support/Rallumi Preview"
label=local.rallumi.preview
launch_domain="gui/$(id -u)"
launch_plist="$HOME/Library/LaunchAgents/$label.plist"

fail() {
  print -u2 -- "$1"
  exit 1
}

[[ "$(/usr/bin/uname -s)" == Darwin ]] || fail "This preview installer runs on macOS."
print -r -- "Install Rallumi for Codex"
print -r -- "Preparing the local chat service. Your Rallumi groups and messages will be kept."

desktop_cli='Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
codex_cli=
for candidate in "/Applications/ChatGPT.app/$desktop_cli" "/Applications/Codex.app/$desktop_cli" \
                 "$HOME/Applications/ChatGPT.app/$desktop_cli" "$HOME/Applications/Codex.app/$desktop_cli" \
                 "$(command -v codex || true)"; do
  if [[ -x "$candidate" ]] && "$candidate" plugin add --help >/dev/null 2>&1; then
    codex_cli=$candidate
    break
  fi
done
[[ -n "$codex_cli" ]] || fail "Codex plugin installation is unavailable. Update the Codex desktop app and run this installer again."

node_cli=
for candidate in "$app_dir/runtime/node" "$(command -v node || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [[ -x "$candidate" ]] && "$candidate" -e 'if (+process.versions.node.split(".")[0] < 24) process.exit(1); require("node:sqlite")' >/dev/null 2>&1; then
    node_cli=$candidate
    break
  fi
done
if [[ -z "$node_cli" ]]; then
  print -r -- "Downloading the Node.js runtime…"
  version=v24.14.0
  case "$(/usr/bin/uname -m)" in
    arm64) architecture=arm64 ;;
    x86_64) architecture=x64 ;;
    *) fail "This Mac processor is unsupported." ;;
  esac
  archive="node-$version-darwin-$architecture.tar.gz"
  download_dir=$(/usr/bin/mktemp -d)
  trap '/bin/rm -rf -- "$download_dir"' EXIT
  for filename in SHASUMS256.txt "$archive"; do
    /usr/bin/curl --proto '=https' --proto-redir '=https' -fsSL --retry 2 --connect-timeout 12 --max-time 180 \
      "https://nodejs.org/dist/$version/$filename" -o "$download_dir/$filename" ||
      fail "Could not download Node.js. Check your connection and try again."
  done
  (
    cd "$download_dir"
    /usr/bin/awk -v archive="$archive" '$2 == archive { print; found=1 } END {if (!found) exit 1}' SHASUMS256.txt > checksum
    /usr/bin/shasum -a 256 -c checksum
    /usr/bin/tar -xzf "$archive" "node-$version-darwin-$architecture/bin/node"
  ) || fail "Could not verify or extract the Node.js runtime."
  /bin/mkdir -p "$app_dir/runtime"
  /usr/bin/install -m 700 "$download_dir/node-$version-darwin-$architecture/bin/node" "$app_dir/runtime/node"
  node_cli="$app_dir/runtime/node"
fi

"$node_cli" "$source_dir/setup.mjs" "$codex_cli"
print -r -- "Registering the Codex sidebar plugin…"
"$codex_cli" plugin marketplace add "$app_dir/install" --json ||
  fail "Codex could not register the source. Check local plugin permissions in Codex."
"$codex_cli" plugin add rallumi@rallumi-preview --json ||
  fail "Codex could not enable Rallumi. Check local plugin permissions in Codex."

# Version 0.1.0 used a login service. The plugin now starts the service itself.
if /bin/launchctl print "$launch_domain/$label" >/dev/null 2>&1; then
  /bin/launchctl bootout "$launch_domain/$label" ||
    fail "Could not stop the previous Rallumi login service."
fi
/bin/rm -f -- "$launch_plist"

print -r -- "Installation complete. Open Codex and select Rallumi in the sidebar."
print -r -- "If Codex was open during installation, quit and reopen it to load the updated plugin."
