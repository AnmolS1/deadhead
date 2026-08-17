#!/usr/bin/env bash
#
# Fail if package-lock.json does not match package.json.
#
# CI runs `npm ci`, which refuses a lockfile that disagrees with the workspace
# set. Locally `npm install` has usually already been run, so node_modules is
# linked and every other check passes — which means adding a workspace and
# forgetting the lockfile is invisible until it reaches CI. That happened once,
# when tools/simrun was added; this is the guard.
#
# It checks the lockfile against package.json, NOT against git. An in-progress
# lockfile change is fine; an inconsistent one is not.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

before="$(cat package-lock.json)"
npm install --package-lock-only --silent

if [ "$before" != "$(cat package-lock.json)" ]; then
  printf '\033[31m✗ package-lock.json did not match package.json. It has been regenerated — commit it.\033[0m\n' >&2
  exit 1
fi

printf '\033[32m✓\033[0m package-lock.json matches package.json\n'
