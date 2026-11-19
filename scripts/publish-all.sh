#!/bin/sh
# Publishes every AUSM package to npm in dependency order.
#
#   npm run build                 # first: this script ships what is already built
#   sh scripts/publish-all.sh     # add --dry-run to rehearse
#
# Needs `npm login` and two-factor authentication on the npm account. A package whose
# current version is already on the registry is skipped, so the script is safe to re-run
# after a failure. --ignore-scripts keeps prepublishOnly from rebuilding, so what goes out
# is exactly what was built and tested.
set -e
cd "$(dirname "$0")/.."

PACKAGES="
@ausm/device-macos-text-selection
@ausm/device-macos-screen-stream
@ausm/device-macos-viewport-manager
@ausm/device-macos-text-input
@ausm/device-macos-cursor-plus-plus
@ausm/device-macos-camera
@ausm/detector-pipeline
@ausm/material-chat
@ausm/core
@ausm/device-macos-material-manager
@ausm/device-macos-screenshot-detector
@ausm/device-macos-clipboard-monitor
@ausm/bridge
@ausm/ausm
"

for name in $PACKAGES; do
  version=$(npm pkg get version -w "$name" | sed -n 's/.*: *"\(.*\)".*/\1/p')
  if [ -z "$version" ]; then
    echo "could not read the version of $name" >&2
    exit 1
  fi
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "skip     $name@$version (already published)"
    continue
  fi
  echo "publish  $name@$version"
  npm publish -w "$name" --ignore-scripts "$@"
done
echo "done"
