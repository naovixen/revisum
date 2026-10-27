#!/usr/bin/env bash
# Runs inside the dev container; tools/session.ps1 calls it from Windows.
# Fills in a session prompt's placeholders and opens Claude with it, so nothing is pasted by hand.
# Usage: bash tools/session-start.sh <prompt-file> [NAME=value ...]
set -euo pipefail

prompt_file="$1"
shift

# The prompt is everything below the first '---' line; above it are notes for the founder.
prompt="$(sed '1,/^---$/d' "$prompt_file")"

for placeholder in "$@"; do
  name="${placeholder%%=*}"
  value="${placeholder#*=}"
  prompt="${prompt//<$name>/$value}"
done

unfilled="$(grep -oE '<(PART|COMMIT|NN|TESTS-COMMIT)>' <<<"$prompt" | sort -u || true)"
if [ -n "$unfilled" ]; then
  echo "Placeholders left unfilled in $prompt_file: $unfilled" >&2
  exit 1
fi

exec claude "$prompt"
