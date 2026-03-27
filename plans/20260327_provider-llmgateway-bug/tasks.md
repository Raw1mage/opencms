# Tasks

## 1. Establish Supported Provider Registry
- [x] 1.1 Add a repo-owned canonical provider registry for the cms-supported provider universe
- [x] 1.2 Encode the initial supported provider list and product metadata in the registry

## 2. Refactor Backend Provider Universe
- [x] 2.1 Rewrite canonical provider row assembly to start from the supported-provider registry
- [x] 2.2 Integrate models.dev and runtime/account overlays without allowing unsupported providers into the list

## 3. Align UI Consuming Paths
- [x] 3.1 Update primary provider hooks/components to read registry-derived canonical labels and visibility
- [x] 3.2 Verify unsupported providers no longer surface in web/TUI provider lists

## 4. Validate And Sync Docs
- [x] 4.1 Run targeted validation for backend and app provider list behavior
- [x] 4.2 Sync event log and architecture docs with the new provider SSOT boundary
