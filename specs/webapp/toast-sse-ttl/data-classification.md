# Data Classification

| Data | Classification | Boundary |
| --- | --- | --- |
| System restart notice | Operational public-within-instance | `scope: system` |
| Rotation/rate-limit message | User/workspace/session operational data | `scope: user`, `workspace`, or `session` |
| Toast timing metadata | Non-sensitive operational telemetry | Same SSE event envelope |
