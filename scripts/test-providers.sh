#!/bin/bash

# Opencode E2E Tester
# Tests basic connectivity and authentication for multiple providers/account types.

echo "=== Opencode E2E Tester ==="
# @event_2026-02-06_xdg-install: resolve binary dynamically
OPENCODE=$(which opencode 2>/dev/null || echo "/usr/local/bin/opencode")

echo "Using: $($OPENCODE --version)"
echo ""

# Configuration: Models to test for each provider type
# We use the EXACT IDs from 'opencode models'
TEST_CASES=(
    "antigravity/claude-sonnet-4-5|Antigravity Claude (Google Proxy)"
    "antigravity/claude-sonnet-4-5-thinking|Antigravity Claude (Thinking)"
    "antigravity/gemini-3-flash|Antigravity Gemini (Flash)"
)

# 1. List accounts to see what we have
echo "Current Accounts:"
$OPENCODE auth list
echo "-----------------------------------"

# 2. Run test cases
for CASE in "${TEST_CASES[@]}"; do
    IFS='|' read -r MODEL LABEL <<< "$CASE"
    
    echo "Testing $LABEL ($MODEL)..."
    
    # Run opencode with a simple prompt.
    RESULT=$(timeout 60s $OPENCODE run "say the word 'PONG_TEST' and nothing else" --model "$MODEL" 2>&1)
    EXIT_CODE=$?
    
    if [ $EXIT_CODE -eq 0 ] && [[ "$RESULT" == *"PONG_TEST"* ]]; then
        echo "✅ SUCCESS: Received proper response."
    else
        echo "❌ FAILED: Exit code $EXIT_CODE"
        echo "Full Output:"
        echo "-----------------------------------"
        echo "$RESULT"
        echo "-----------------------------------"
    fi
    echo ""
done

echo "=== Test Summary ==="
echo "Finished."
