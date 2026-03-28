# Tasks

## 1. Rewrite Planner Contract

- [x] 1.1 Rewrite the active plan package so it becomes the authoritative `dialog_trigger_framework` planning surface
- [x] 1.2 Record `plan_enter` active-root naming repair as an explicit in-scope slice, limited to slug derivation in v1

## 2. Specify Trigger Framework

- [x] 2.1 Define first-version trigger taxonomy for plan enter, replan, and approval
- [x] 2.2 Define centralized detector, policy, and action boundaries for the first version
- [x] 2.3 Define the v1 replan threshold: active execution context plus material direction change only
- [x] 2.4 Define the v1 approval boundary: centralized detection/routing only, deeper runtime stop orchestration deferred
- [x] 2.5 Document why first version uses dirty-flag plus next-round rebuild instead of in-flight hot reload

## 3. Slice Future Build Work

- [x] 3.1 Define the build slice for fixing `plan_enter` slug derivation
- [x] 3.2 Define the build slice for adding centralized trigger detection/policy integration
- [x] 3.3 Define the build slice for validation and documentation sync

## 4. Validate Planning Package

- [x] 4.1 Replace all template placeholders in companion artifacts and diagrams
- [x] 4.2 Cross-check plan artifacts against architecture evidence and current runtime surfaces
- [x] 4.3 Review open decisions with the user before `plan_exit`
