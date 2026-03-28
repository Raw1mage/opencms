# Spec

## Purpose

- 定義 `dialog_trigger_framework` 第一版的行為需求，讓對話觸發邏輯從隱性 prompt 習慣收斂為可驗證的系統合約。

## Requirements

### Requirement: Rule-First Trigger Detection

The system SHALL use deterministic programmatic detectors for first-version dialog trigger decisions before considering any future semantic expansion.

#### Scenario: Detect planning trigger without background AI governor

- **GIVEN** 使用者提出多步驟、architecture-sensitive、或需要 plan/replan 的需求
- **WHEN** 系統評估下一輪對話控制面
- **THEN** 系統以 rule-based detectors 決定是否進入或維持 planning flow，而不是另外啟動背景 AI classifier

### Requirement: Next-Round Surface Rebuild

The system SHALL apply tool/capability visibility changes through a dirty-flag plus next-round rebuild contract.

#### Scenario: Tool surface changes after policy or MCP state update

- **GIVEN** MCP tool list、planner mode、或 trigger policy 造成可用工具集合變動
- **WHEN** 目前 round 結束並進入下一輪 processing
- **THEN** 系統在下一輪重新 resolve tools，而不是在同一輪執行中做 in-flight hot swap

### Requirement: Explicit Planner Root Naming

The system SHALL derive a planner root name that matches the actual task topic and SHALL fail fast on invalid naming inputs.

#### Scenario: Enter plan mode for dialog_trigger_framework

- **GIVEN** 使用者要求為 `dialog_trigger_framework` 開 plan
- **WHEN** `plan_enter` 建立 active `/plans/` root
- **THEN** 產生的 root slug 必須反映 `dialog_trigger_framework` 主題，而不是殘留錯誤或無關的名稱

### Requirement: No Silent Fallback On Trigger Contracts

The system SHALL stop for approval, product decision, or architecture review when a trigger outcome would cross a protected boundary.

#### Scenario: Trigger would require architecture-sensitive behavior change

- **GIVEN** 某個 trigger 需要改變 planner lifecycle、beta workflow、或 runtime mutation contract
- **WHEN** 系統發現這已超出第一版既定 scope
- **THEN** 系統停止自動續跑並要求重新規劃或取得明確決策

## Acceptance Checks

- 規格明確要求第一版不使用背景 AI governor。
- 規格明確要求 surface 變更走 dirty flag + next-round rebuild。
- 規格明確要求 `plan_enter` 命名與任務主題對齊。
- 規格明確要求 protected boundary 一律 fail fast，不靠 silent fallback。
