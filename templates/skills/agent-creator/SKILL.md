---
name: agent-creator
description: Creates specialized AI agents with optimized system prompts using the official 4-phase SOP methodology. Use this skill when creating production-ready agents for specific domains, workflows, or tasks requiring consistent high-quality performance.
---

# Agent Creator - Enhanced with 4-Phase SOP Methodology

This skill provides the **official comprehensive framework** for creating specialized AI agents, integrating the proven 4-phase methodology from Desktop .claude-flow with Claude Agent SDK implementation and evidence-based prompting techniques.

## When to Use This Skill

Use agent-creator for:

- Creating project-specialized agents with deeply embedded domain knowledge
- Building agents for recurring tasks requiring consistent behavior
- Rewriting existing agents to optimize performance
- Creating multi-agent workflows with sequential or parallel coordination

## The 4-Phase Agent Creation Methodology

### Phase 1: Initial Analysis & Intent Decoding (30-60 minutes)

**Objective**: Deep domain understanding through systematic research.

1. **Domain Breakdown**: Define problems, challenges, and expert patterns.
2. **Technology Stack Mapping**: Inventory tools, frameworks, and formats.
3. **Integration Points**: Map MCP servers, agent coordination, and data flows.

### Phase 2: Meta-Cognitive Extraction (30-45 minutes)

**Objective**: Identify cognitive expertise domains.

1. **Expertise Domain Identification**: Heuristics, decision frameworks, rules-of-thumb.
2. **Agent Specification Creation**: Define role, core capabilities, and quality standards.
3. **Supporting Artifacts**: Document examples of good/bad outputs and edge cases.

### Phase 3: Agent Architecture Design (45-60 minutes)

**Objective**: Transform specification into production-ready system prompt.

1. **System Prompt Structure**: Core Identity, Universal Commands, Specialist Commands, Cognitive Framework.
2. **Evidence-Based Techniques**: Self-consistency, Program-of-Thought, Plan-and-Solve.
3. **Quality Standards & Guardrails**: Explicit constraints based on failure modes.

### Phase 4: Deep Technical Enhancement (60-90 minutes)

**Objective**: Reverse-engineer exact implementation patterns.

1. **Code Pattern Extraction**: Document exact syntax and implementation details.
2. **Critical Failure Mode Documentation**: Define severity, symptoms, root cause, and prevention.
3. **Integration Patterns**: Document MCP tool usage and namespace conventions.
4. **Performance Metrics**: Define success criteria and tracking methods.

## System Prompt Template Structure

```markdown
# [AGENT NAME] - SYSTEM PROMPT

## 🎭 CORE IDENTITY

I am a [Role] with expertise in [Domain]...

## 📋 UNIVERSAL PROTOCOLS

- Absolute Paths Only
- Read Before Write
- Safety First

## 🎯 SPECIALIST CAPABILITIES

[Domain Specific Skills]

## 🧠 COGNITIVE FRAMEWORK

1. Analysis
2. Planning
3. Execution
4. Verification

## 🚧 GUARDRAILS

- NEVER [Bad Action]
- ALWAYS [Good Action]
```
