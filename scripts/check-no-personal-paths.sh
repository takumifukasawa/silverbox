#!/usr/bin/env bash
# Blocks commits whose staged additions leak out-of-project paths or private folder names.
# Extra patterns (one ERE per line) may live in .harness/private-patterns.local, which is
# gitignored so private names never land in the repo themselves.
set -u
root="$(git rev-parse --show-toplevel)"
patterns='/Users/|my_photos|Desktop/'
local_file="$root/.harness/private-patterns.local"
if [ -f "$local_file" ]; then
  while IFS= read -r p; do
    [ -n "$p" ] && patterns="$patterns|$p"
  done < "$local_file"
fi

hits="$(git diff --cached -U0 --no-color -- . ':(exclude)scripts/check-no-personal-paths.sh' \
  | grep -E '^\+' | grep -vE '^\+\+\+ ' | grep -E "$patterns" || true)"
if [ -n "$hits" ]; then
  echo "Staged changes contain personal/out-of-project paths or private folder names:"
  echo "$hits" | head -20
  echo "Fix: reach test photos only via the gitignored test-assets/ symlinks or SILVERBOX_TEST_* env vars; remove the path from the diff."
  exit 1
fi
