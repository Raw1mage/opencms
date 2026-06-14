# Bug: Mobile drawer project switch opens last session instead of session list

**Date**: 2026-06-05
**Area**: Web UI / Mobile drawer / project switcher
**Severity**: Medium
**Status**: CLOSED (2026-06-11, soak passed since 2026-06-05, no recurrence) — was OBSERVING — fix deployed/restarted 2026-06-05; mobile project tile now routes to the selected project's session list instead of last-session restore.
**Observing since**: 2026-06-05
**Exit → closed/**: no recurrence after soak / user confirms mobile project switching consistently shows the existing session list.
**Regress → open**: mobile project switching opens last/new session instead of the selected project's session list.

## Symptom

On mobile, switching projects from the drawer opens the last session content instead of showing the selected project's session list.

Example behavior:

1. Open the app in a mobile viewport.
2. Open the navigation drawer.
3. Select a different project.
4. The next screen shows the last session content.
5. Expected next screen is the selected project's session list.

## Expected behavior

After selecting a project from the mobile drawer, navigation should land on that project's session list so the user can choose the intended session.

## Actual behavior

The app opens the last session content after the project is selected.

## Impact

- Breaks the expected mobile project-switch flow.
- Can land users in an unrelated or stale session.
- Makes mobile navigation inconsistent with project-level intent.

## Likely root cause

The mobile drawer project-switch action likely reuses session restore / last-session routing instead of explicitly routing to the project session-list view after changing the active project.

## Suggested fix direction

- Treat mobile project selection as a project-level navigation event.
- Clear or bypass last-session auto-open for this interaction.
- Route to the selected project's session list after the active project changes.

## Acceptance criteria

- On mobile, selecting a project from the drawer shows that project's session list.
- The flow does not auto-open the last session content immediately after project switch.
- Existing direct session restore behavior remains unchanged for non-project-switch entry points.
