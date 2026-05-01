# Spec

## Requirement R1: Flat stream canvas

- **GIVEN** an embedded dialog/task session stream
- **WHEN** user, assistant, tool, status, and error events are rendered
- **THEN** the visible structure behaves as one downward-growing canvas of cards
- **AND** no product-visible grouping container is introduced for a runloop.

## Requirement R2: Single status surface

- **GIVEN** a live operation such as thinking, compacting, or running a tool
- **WHEN** the frontend displays progress
- **THEN** the existing turn status line is the only progress/status surface for that stream.

## Requirement R3: Frontend display only

- **GIVEN** backend session messages and parts already carry execution evidence
- **WHEN** the dialog stream is flattened
- **THEN** the frontend must not introduce new debug/retry/runloop grouping state solely for display.

## Requirement R4: Preserve data contract

- **GIVEN** existing message/part IDs and event reducers update streaming content
- **WHEN** the DOM/layout is simplified
- **THEN** those IDs and reducer semantics remain unchanged.
