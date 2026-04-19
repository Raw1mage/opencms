# Spec — web connection stale status fix

## Purpose

- Define the user-visible and authority-safe behavior of web runtime status surfaces when transport quality degrades and later recovers.

## Requirements

### Requirement: degrade stale runtime surfaces when authority is uncertain

The frontend must not continue presenting active-child and running indicators as authoritative once the event stream is degraded or reconnecting.

#### Scenario: active-child footer becomes stale during transport loss

- Given a visible subagent footer
- When the event stream becomes unhealthy or uncertain
- Then the footer must downgrade to a stale/degraded presentation or clear pending revalidation

### Requirement: restore status from authoritative state after recovery

After reconnect, reload, foreground resume, or network return, the frontend must rehydrate runtime status from server truth.

#### Scenario: stale counter is replaced after reconnect

- Given a local elapsed/stale counter was running while transport was degraded
- When authoritative session and active-child state are fetched successfully
- Then the counter must stop using stale local accumulation and recompute from server truth

### Requirement: block unsafe input while authority is degraded

The frontend must prevent new prompt submission while connection state is degraded/reconnecting/blocked.

#### Scenario: user attempts to submit during degraded transport

- Given the connection state is degraded or reconnecting
- When the user tries to type or submit a prompt
- Then prompt input must be blocked until revalidation succeeds

## Acceptance Checks

- A degraded connection does not leave a phantom running footer indefinitely.
- Reload/reconnect replaces stale counters with authoritative state.
- Prompt input remains blocked until runtime authority is re-established.
