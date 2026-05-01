# Implementation Spec

Refactor the embedded frontend dialog stream toward a flat display model:

- Public mental model: `DialogStreamCanvas` containing stream cards.
- Card types: user input, assistant text, tool call, tool result, error, metadata/status as needed.
- Live state: existing turn status line only.
- Backend semantics: unchanged.
- Data reducers and streaming IDs: unchanged.

Primary implementation target is the task detail embedded session stream. Avoid touching global Dialog accessibility structure in this plan.
