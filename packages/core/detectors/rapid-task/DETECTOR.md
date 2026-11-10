---
name: rapid-task
description: Classifies the current user task from the focused material and recent activity
event: task
cooldown: 0
interval: 0
debounce: 0
trigger: interval
enabled: true
sources: [screen, events]
events: [material, window-state, text-input, text-selection, copy-paste, cursor, screenshot]
isolated: true
---
This is a task classifier — ALWAYS report it as triggered.

Classify what the user is doing from the focused-material screenshot and recent activity. Be specific: app/site + the file, thread, video, or page. A different site, app, or content type is a NEW task.

Output (keep short — this is latency-sensitive):
- summary: "<2-6 word label>: <subject>" — max 16 words. No prose.
  Examples: "Writing TypeScript: detector-pipeline.ts (AUSM)" | "Watching YouTube: <title>" | "Reading email: Alice Q3 roadmap"
- evidence: "App · window/site" — max 8 words
- Omit suggested_detectors, action, task_label, task_description
