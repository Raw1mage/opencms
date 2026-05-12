# miatdiagram Release Gate Checklist

- [ ] Requirement summary captured
- [ ] MVP priority order confirmed
- [ ] Missing critical fields clarified via `mcp_question`
- [ ] Clarification loop stayed within default 12 questions (or documented why extended)
- [ ] IDEF0 JSON validates schema
- [ ] GRAFCET JSON validates schema
- [ ] Every IDEF0 activity has at least one Input arrow AND at least one Output arrow
- [ ] IDEF0 ICOM semantics consistent
- [ ] GRAFCET branch/sync semantics consistent
- [ ] Every GRAFCET module has valid IDEF0 parent/module reference
- [ ] No orphan GRAFCET state machine outside IDEF0 hierarchy
- [ ] IDEF0 IDs follow convention (`A0`, `A1..A9`, `A11..A19`, ...)
- [ ] Each IDEF0 parent has <= 9 direct children
- [ ] Minimum decomposition artifacts exist: `a0`, `a1`, `a2`
- [ ] Output files written to target path
- [ ] File naming follows `<repo>_aX_idef0.json` / `<repo>_aX_grafcet.json`
- [ ] `decision_trace` and assumptions included
- [ ] If available, run drawmiat-side JSON compile/validation API and record result
