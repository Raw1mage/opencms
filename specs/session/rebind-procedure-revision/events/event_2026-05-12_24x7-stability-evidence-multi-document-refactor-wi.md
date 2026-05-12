---
date: 2026-05-12
summary: "24x7 stability evidence: multi-document refactor without跳針"
---

# 24x7 stability evidence: multi-document refactor without跳針

During post-fix observation period, the AI on the same session that previously reproduced the 11-round read-loop performed sustained multi-document work without跳針 symptoms:
- 9 distinct files touched in last 30 mutations: chapters/04_risk_assessment, chapters/05_business_impact_analysis, chapters/05_controls, chapters/06_controls, chapters/06_dlp_implementation, chapters/07_business_impact_response, chapters/07_poc_plan, chapters/README, appendix_iso27002_controls_zh.md (new file)
- Patch sizes: 632–2637 bytes (average ~1.5 KB)
- Cadence: ~1 patch per 1.5 minutes for ~15 minutes continuous
- All 30 patches `completed`, zero failures
- File sizes 1.5–17 KB per chapter — substantial content accumulation, not re-pumping the same bytes

This is the failure mode the chain-init protocol was designed to prevent. The post-fix evidence supports the framing that opencode has reached an early threshold of "24x7 capable" agent stability — at least on the failure class addressed here. Distinct from full 24x7 (still needs subagent termination, OAuth refresh, tool-catalog staleness, etc., per the Follow-ups section in design.md).
