# prompts/

All system prompts for Material Chat live here as `.txt` files you
can edit directly. Restart the server (`npm start`, or restart the AUSM runtime) to pick up changes.

## File format

Each file has a **header block** of `#` comment lines + metadata, then a
`---` separator line, then the actual prompt content. The loader (`src/engine/prompts.ts`)
strips everything up to and including the `---` so headers don't waste tokens
on the model.

```
# What this prompt is
# Used by: src/some/file.ts
# Purpose: ...
---
<the real prompt content the LLM sees>
```

## What each file is for

| File | Status | Used by | Purpose |
|---|---|---|---|
| `agent_system.txt` | **live** | `src/engine/agent.ts` | Main system prompt for the agent tool-use loop. Controls parallel tool calls, no-asking discipline, multi-hop grounding pattern, trip-planning pattern. The biggest knob. |
| `subagent_web_system.txt` | **live** | `src/engine/subagent-web.ts` | System prompt for `deep_research_web` — the Haiku-powered subagent that fans out web queries + fetches in parallel and returns a digest. |
| `user_context_template.txt` | **live** | `src/engine/user.ts` | Identity block appended to system prompts. Has `{USER_NAME}` and `{USER_ALIASES_NOTE}` placeholders. Lets the agent resolve pronouns and know whose data it's serving. |

## Editing rules

- Header lines start with `#` or are blank. Everything between the start of
  the file and the first `---` line is **stripped** and never sent to the model.
- Anything after `---` is sent to the model verbatim. If you use `#` in the
  prompt body itself (Markdown headings), that's fine — only the header block
  before `---` gets stripped.
- Placeholders in `user_context_template.txt`: `{USER_NAME}`, `{USER_ALIASES_NOTE}`.
  Other prompts are pure literal text.
- The loader caches per-process. Restart the backend after edits.
