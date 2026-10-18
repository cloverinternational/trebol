#!/bin/bash
# Check a fix commit is a usable benchmark task: its shipped tests FAIL at the
# parent (with fix-commit tests overlaid) and PASS at the fix commit.
# Usage: tools/bench/validate-fix.sh SHA  -> prints "SHA parent=<summary> fix=<summary>"
set -u; repo=$(cd "$(dirname "$0")/../.." && pwd); c=$1; W=/private/tmp/fixval/$c
cd "$repo"
if [ ! -d "$W" ]; then git worktree add -q --detach -f "$W" "$c^" >/dev/null 2>&1; ln -s "$repo/node_modules" "$W/node_modules"; for d in packages/*/*/dist; do [ -e "$W/$d" ] || ln -s "$repo/$d" "$W/$d"; done; fi
T=($(git --no-pager show --name-only --format= "$c" | grep -E '\.test\.ts$'))
[ ${#T[@]} -eq 0 ] && { echo "$c no-vitest"; exit 0; }
cd "$W" && git checkout -q -f --detach "$c^" && git checkout -q "$c" -- "${T[@]}"
p=$(npx vitest run "${T[@]}" 2>&1 | grep -E "Tests +" | head -1 | tr -s ' ')
git checkout -q -f --detach "$c"; f=$(npx vitest run "${T[@]}" 2>&1 | grep -E "Tests +" | head -1 | tr -s ' ')
echo "$c tests=${T[*]} parent=[$p] fix=[$f]"
