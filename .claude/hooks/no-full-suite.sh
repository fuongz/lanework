#!/usr/bin/env bash
# Blocks a WHOLE-SUITE Playwright run. Targeted runs stay allowed.
#
# The rule this enforces (AGENTS.md "Verification before done"): the suite runs
# when fuongz says "commit", not after every task. While iterating, a spec is
# run on its own.
set -u
cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

case "$cmd" in
  *"playwright test"*) ;;
  *) exit 0 ;;
esac

# ⚠️ A command that MENTIONS the suite is not a run of it. This hook reads the
# whole command string, so a commit message quoting the rule matched — which is
# exactly how it blocked the commit that introduced it, and then blocked the
# shell line written to verify the fix.
case "$cmd" in
  *"git commit"*) exit 0 ;;
esac

# Narrowed already: a named spec file, or a -g/--grep filter.
if printf '%s' "$cmd" | grep -qE '\.spec\.[tj]s|(^| )-g( |=)|--grep'; then
  exit 0
fi

# The deliberate opt-in, used only once fuongz has said "commit".
if printf '%s' "$cmd" | grep -q 'COMMIT_RUN=1'; then
  exit 0
fi

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Whole-suite Playwright runs are reserved for a commit. While iterating, run one spec: playwright test tests/<file>.spec.ts (or -g \"<name>\"). Once fuongz has said commit, prefix the command with COMMIT_RUN=1."}}
JSON
