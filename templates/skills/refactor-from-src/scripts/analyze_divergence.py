#!/usr/bin/env python3
import subprocess
import sys
import os
import json

# Critical paths that indicate a high risk of conflict with CMS branch architecture
CRITICAL_PATHS = [
    "src/provider/",
    "src/account/",
    "src/session/llm.ts",
    "src/plugin/antigravity/",
    "src/plugin/gemini-cli/",
    "src/auth/",
    "src/cli/cmd/admin.ts",
    "src/cli/cmd/tui/",
]


def run_command(command):
    try:
        result = subprocess.run(
            command, cwd=os.getcwd(), check=True, capture_output=True, text=True
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        print(f"Error running command {' '.join(command)}: {e.stderr}")
        sys.exit(1)


def fetch_dev():
    print("Fetching origin/dev...")
    run_command(["git", "fetch", "origin", "dev"])


def get_divergent_commits():
    # Get list of commits in origin/dev that are not in HEAD
    # Format: hash subject
    output = run_command(["git", "log", "HEAD..origin/dev", "--oneline", "--no-merges"])
    if not output:
        return []
    return output.split("\n")


def get_changed_files(commit_hash):
    # Get list of files changed in a specific commit
    output = run_command(["git", "show", "--name-only", "--format=", commit_hash])
    if not output:
        return []
    return output.split("\n")


def assess_risk(files):
    risk_level = "LOW"
    reasons = []

    for f in files:
        for critical in CRITICAL_PATHS:
            if f.startswith(critical):
                risk_level = "HIGH"
                reasons.append(f"Touches critical path: {critical}")
                break
        if risk_level == "HIGH":
            break

    if risk_level == "LOW":
        # Check for other src changes that might be medium risk
        if any(f.startswith("src/") for f in files):
            risk_level = "MEDIUM"
            reasons.append("Touches source code (non-critical)")

    return risk_level, reasons


def main():
    # Ensure we are in a git repo
    if not os.path.isdir(".git"):
        print("Error: Current directory is not a git repository.")
        sys.exit(1)

    fetch_dev()

    commits = get_divergent_commits()

    if not commits:
        print("\n✅ No new commits in origin/dev to analyze.")
        return

    print(f"\nFound {len(commits)} commits in origin/dev not in HEAD.\n")
    print("# Refactor Analysis Report\n")
    print("| Risk | Commit | Subject | Reason |")
    print("| :--- | :--- | :--- | :--- |")

    report_data = []

    for line in commits:
        parts = line.split(" ", 1)
        commit_hash = parts[0]
        subject = parts[1] if len(parts) > 1 else "(no subject)"

        files = get_changed_files(commit_hash)
        risk, reasons = assess_risk(files)

        report_data.append(
            {
                "commit_hash": commit_hash,
                "subject": subject,
                "risk": risk,
                "reasons": reasons,
                "changed_files": files,
            }
        )

        reason_str = "<br>".join(reasons) if reasons else "Safe (UI/Docs/Tests)"

        # Escape pipe characters in subject to avoid breaking markdown table
        subject = subject.replace("|", "\|")

        print(f"| **{risk}** | `{commit_hash}` | {subject} | {reason_str} |")

    # Write JSON report
    with open("divergence.json", "w") as f:
        json.dump(report_data, f, indent=2)
    print("\nReport saved to divergence.json")

    print("\n## Instructions")
    print(
        "1. **HIGH RISK**: These commits touch critical architecture (Providers, Accounts, Rotation3D). DO NOT direct merge. Analyze the code and manually port logic if needed."
    )
    print(
        "2. **MEDIUM RISK**: Likely safe, but verify logic doesn't assume single-provider or single-account."
    )
    print("3. **LOW RISK**: Generally safe to cherry-pick.")


if __name__ == "__main__":
    main()
