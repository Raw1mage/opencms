# Tasks

## 1. Rewrite Planner Contract

- [ ] 1.1 Rewrite the active plan package so it becomes the authoritative `dialog_trigger_framework` planning surface
- [ ] 1.2 Record `plan_enter` active-root naming repair as an explicit in-scope slice, limited to slug derivation in v1

## 2. Specify Trigger Framework

- [ ] 2.1 Define first-version trigger taxonomy for plan enter, replan, and approval
- [ ] 2.2 Define centralized detector, policy, and action boundaries for the first version
- [ ] 2.3 Document why first version uses dirty-flag plus next-round rebuild instead of in-flight hot reload

## 3. Slice Future Build Work

- [ ] 3.1 Define the build slice for fixing `plan_enter` slug derivation
- [ ] 3.2 Define the build slice for adding centralized trigger detection/policy integration
- [ ] 3.3 Define the build slice for validation and documentation sync

## 4. Validate Planning Package

- [ ] 4.1 Replace all template placeholders in companion artifacts and diagrams
- [ ] 4.2 Cross-check plan artifacts against architecture evidence and current runtime surfaces
- [ ] 4.3 Review open decisions with the user before `plan_exit`
