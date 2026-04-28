<!--
AGENTS.md is intentionally NOT imported here.

AGENTS.md governs the opencode runtime's own AI agent (the prompts opencode
ships to its sessions). It is not a Claude Code instruction file. Pulling it
in via `@AGENTS.md` caused Claude Code to misapply opencode-runtime rules
(XDG backup, daemon-spawn denylist, prompt-pipeline conventions) as if they
were its own constraints.

When working on this repo, read AGENTS.md as project context (with a Read
tool call) when relevant — but do not load it as governing instructions.
-->
