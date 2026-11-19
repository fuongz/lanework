#!/usr/bin/env bash
# Blocks a WHOLE-SUITE Playwright run. Targeted runs stay allowed.
#
# The rule this enforces (AGENTS.md "Verification before done"): no tests run
# unless the user asks, and then only what they asked for: one spec file or
# one -g case. The whole suite runs only when they ask for the whole suite.
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

# The deliberate opt-in, only when the user has asked for the whole suite.
if printf '%s' "$cmd" | grep -q 'COMMIT_RUN=1'; then
  exit 0
fi

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Whole-suite Playwright runs only when the user asks for the whole suite. Run what they asked for: playwright test tests/<file>.spec.ts (or -g \"<name>\"). If they asked for the whole suite, prefix the command with COMMIT_RUN=1."}}
JSON
