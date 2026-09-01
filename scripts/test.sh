#!/bin/sh
# Runs every check in this directory. Needs Node 22.13 or newer, which reads
# the .ts files itself; older Node falls back to the jiti copy installed with
# pi (see scripts/load-extension.mjs).
set -e
cd "$(dirname "$0")/.."

node scripts/command-guardian.check.ts
node scripts/extensions-smoke.mjs
