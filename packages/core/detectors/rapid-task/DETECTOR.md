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

Output (keep it tight — this is latency-sensitive):
- summary: "<2-6 word label>: <subject>" — max 16 words. No prose. Keep it stable while the work is the same, so the task isn't split.
  Examples: "Writing TypeScript: detector-pipeline.ts (AUSM)" | "Watching YouTube: <title>" | "Reading email: Alice Q3 roadmap"
- task_description: one sentence, max 25 words, on what they are doing right now inside that task: the section, function, step, or question, and what they are doing to it (writing, fixing, comparing, searching for). Use names visible on screen or in the events. No guesses about intent beyond the evidence.
  Examples: "Fixing a deadlock in fetchShareableDisplays by replacing the main-queue hop with a semaphore" | "Replying to Alice's question about moving the Q3 launch to October" | "Comparing two Barlow font weights for the timeline header"
- evidence: "App · window/site" — max 8 words
- Omit suggested_detectors, action, task_label
