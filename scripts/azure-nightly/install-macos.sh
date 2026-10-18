#!/bin/sh
# Installs the newest Azure Nightly once; the in-app updater delivers later releases.
# curl downloads carry no quarantine, so Gatekeeper never assesses the non-notarized bundle.
set -eu

repo="Jonathanm10/t3code-azure-nightly"
team="AA3JJ9YT75"
name="T3 Code (Azure Nightly).app"
destination="${1:-/Applications}"

# -a also matches this shell's ancestors, such as a terminal running inside the app.
if pgrep -ax 'T3 Code \(Azure Nightly\)' >/dev/null; then
  echo "Quit T3 Code (Azure Nightly) first." >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Releases can share a creation time, so take the highest version instead of the first listed.
tag=$(curl -fsSL "https://api.github.com/repos/$repo/releases?per_page=100" |
  grep -o '"tag_name": *"v[^"]*"' | sed 's/.*"\(v[^"]*\)"$/\1/' | sort -V | tail -n 1)
base="https://github.com/$repo/releases/download/$tag"
curl -fsSL "$base/nightly-mac.yml" -o "$work/feed.yml"
zip=$(sed -n 's/^path: //p' "$work/feed.yml")
expected=$(sed -n 's/^sha512: //p' "$work/feed.yml")
curl -fsSL "$base/$zip" -o "$work/app.zip"
actual=$(openssl dgst -sha512 -binary "$work/app.zip" | base64)
if [ "$actual" != "$expected" ]; then
  echo "Downloaded $zip does not match the $tag update feed." >&2
  exit 1
fi

ditto -x -k "$work/app.zip" "$work/extracted"
codesign --verify --deep --strict "$work/extracted/$name"
codesign --verify --strict \
  -R "=anchor apple generic and identifier \"com.jonathanm10.t3code.azure\" and certificate leaf[subject.OU] = \"$team\"" \
  "$work/extracted/$name"

# Stage on the destination volume so the app is replaced by renames, never left half-copied.
staged="$destination/.$name.installing"
previous="$destination/.$name.previous"
rm -rf "$staged" "$previous"
ditto "$work/extracted/$name" "$staged"
if [ -e "$destination/$name" ]; then mv "$destination/$name" "$previous"; fi
if ! mv "$staged" "$destination/$name"; then
  if [ -e "$previous" ]; then mv "$previous" "$destination/$name"; fi
  exit 1
fi
rm -rf "$previous"
echo "Installed $tag to $destination/$name"
