# Errors

## Error Catalogue

| Code       | Layer                   | Message                                                                          | Recovery                                                                           |
| ---------- | ----------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| CET-HF-001 | codex-provider boundary | WS observation snapshot omitted `wsFrameCount` before classifier input assembly. | Normalize `transport-ws.ts:getSnapshot()` output and add regression test.          |
| CET-HF-002 | forensic evidence       | Historical empty-turn JSONL rows lack frame count.                               | Do not mutate history; mark rows as partial evidence and rely on post-hotfix logs. |
