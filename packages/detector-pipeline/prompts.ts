/**
 * Prompts for the detector pipeline.
 * Constructs system + user prompts for batched detector evaluation.
 */

import type { DetectorSpec, ActivityEvent } from './types';

export const DETECTOR_PIPELINE_SYSTEM_PROMPT = `You are a screen activity analyzer. You evaluate detection rules against screenshots and recent user activity events.

You will be given:
1. A screenshot of the user's current screen (when available)
2. Recent activity events (text input, window focus, cursor actions, etc.)
3. A list of detector specifications, each with a name, description, and detection rules

For each detector, evaluate whether its rules are triggered by the current evidence. Only report detectors that are clearly triggered with high confidence.

Respond ONLY with compact JSON (no markdown, no extra keys):

{"triggered":[{"name":"<detector>","confidence":<0-1>,"summary":"<short>","evidence":"<short>"}]}

(add "task_description":"<one sentence>" to an item when its detector asks for it)

If none triggered: {"triggered":[]}

Keep strings short. summary ≤ 16 words. evidence ≤ 8 words. Omit suggested_detectors unless non-empty. Do not emit action or task_label. Emit task_description (≤ 25 words) only when a detector's output format asks for it.

Guidelines:
- Trigger only when evidence clearly matches the rules. Classifiers that say they MUST fire always fire.
- If a detector specifies an output format, follow that format and stay within the word limits above.
- A Current Task State is the previous task, not a bucket. Continue only for the same specific work. A different site, app, or content type is a new task.
- Use the screenshot and the activity events. You are called incrementally — only new events are shown.`;

export function buildDetectorEvaluationPrompt(
    specs: DetectorSpec[],
    events: ActivityEvent[],
    hasScreenshot: boolean,
    maxEvents = 40,
    evaluationContext?: string | null,
): string {
    const parts: string[] = [];

    if (evaluationContext) {
        parts.push('## Current Task State');
        parts.push('');
        parts.push(evaluationContext);
        parts.push('');
    }

    parts.push('## Active Detectors');
    parts.push('');
    for (const d of specs) {
        parts.push(`[${d.name}]`);
        parts.push(`Description: ${d.description}`);
        parts.push('Rules:');
        parts.push(d.body);
        parts.push('');
    }

    // slice(-0) would return every event, so a non-positive cap means "none".
    const shownEvents = maxEvents > 0 ? events.slice(-maxEvents) : [];
    if (shownEvents.length > 0) {
        parts.push('---');
        parts.push('## Recent Activity (oldest → newest)');
        parts.push('');
        for (const e of shownEvents) {
            const date = new Date(e.timestamp);
            const time = Number.isNaN(date.getTime()) ? 'unknown time' : date.toISOString();
            parts.push(`  ${formatActivityEvent(e, time)}`);
        }
        parts.push('');
    }

    parts.push('---');
    if (hasScreenshot) {
        parts.push('Analyze the screenshot and activity events above. Which detectors are triggered?');
    } else {
        parts.push('Analyze the activity events above. Which detectors are triggered?');
    }

    return parts.join('\n');
}

function formatActivityEvent(e: ActivityEvent, time: string): string {
    const eventType = e.eventType;

    if (eventType === 'material') {
        let line = `[${time}] ${e.type}: "${e.title ?? 'untitled'}" in ${e.application ?? 'unknown'}`;
        const raw = e as Record<string, unknown>;
        const rawMeta = raw['appMetadata'];
        if (rawMeta && typeof rawMeta === 'object') {
            const entries = Object.entries(rawMeta as Record<string, unknown>)
                .filter(([, v]) => v != null)
                .map(([k, v]) => `${k}: ${v}`);
            if (entries.length > 0) {
                line += ` [${entries.join(', ')}]`;
            }
        }
        const focusWeight = raw['focusWeight'];
        if (focusWeight != null && typeof focusWeight === 'number') {
            line += ` {weight: ${focusWeight.toFixed(2)}}`;
        }
        return line;
    }
    if (eventType === 'text-input') {
        const preview = e.text ? String(e.text).slice(0, 120) : '';
        return `[${time}] text-input/${e.status}: "${preview}" in ${e.application ?? 'unknown'}`;
    }
    if (eventType === 'window-state') {
        const app = e.application ?? 'unknown';
        const suffix = e.bundleId ? ` (${e.bundleId})` : '';
        return `[${time}] window/${e.state}: "${e.title ?? 'untitled'}" in ${app}${suffix}`;
    }
    if (eventType === 'cursor') {
        const app = e.application ?? 'unknown';
        const action = e.action ?? 'unknown';
        let desc = `${action} at (${e.x ?? '?'}, ${e.y ?? '?'})`;
        if (e.uiElementRole || e.uiElementLabel) {
            desc += ` on ${e.uiElementRole ?? 'element'}${e.uiElementLabel ? ` "${e.uiElementLabel}"` : ''}`;
        }
        return `[${time}] cursor/${action}: ${desc} in ${app}`;
    }
    if (eventType === 'text-selection') {
        const preview = e.selectedText ? String(e.selectedText).slice(0, 100) : '';
        const method = e.selectionMethod ? ` via ${e.selectionMethod}` : '';
        const elemType = e.elementType ? ` (${e.elementType})` : '';
        return `[${time}] text-selection${method}: "${preview}" in ${e.application ?? 'unknown'}${elemType}`;
    }
    if (eventType === 'copy-paste') {
        return `[${time}] copy-paste/${e.action}: "${String(e.text ?? '').slice(0, 80)}"`;
    }
    if (eventType === 'screenshot') {
        const type = e.type ?? 'unknown';
        return `[${time}] screenshot/${e.status}: type=${type}`;
    }
    if (eventType === 'text-highlight') {
        const count = e.highlightCount ?? '?';
        return `[${time}] text-highlight/${e.stage}: count=${count}`;
    }

    const { eventType: _et, timestamp: _ts, ...rest } = e;
    return `[${time}] ${eventType}: ${JSON.stringify(rest)}`;
}

// ── Response Parsing ─────────────────────────────────────────────────────────

export function parseDetectorResponse(raw: string): Array<{
    name: string;
    confidence: number;
    summary: string;
    evidence: string;
    suggestedDetectors: string[];
    taskAction?: string;
    taskLabel?: string;
    taskDescription?: string;
}> {
    let cleaned = raw.trim();
    if (!cleaned) {
        throw new Error('Model returned empty response');
    }

    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
    }

    // Valid JSON that is not an object (null, a number, a string) carries no detections.
    if (cleaned === 'null') return [];

    let parsed: Record<string, unknown> | null = tryParseJSON(cleaned);

    if (!parsed) {
        parsed = tryRepairTruncatedJSON(cleaned);
    }

    if (!parsed) {
        // Models sometimes wrap the object in prose or a fence mid-message.
        const firstBrace = cleaned.indexOf('{');
        if (firstBrace > 0) {
            const inner = cleaned.slice(firstBrace).replace(/\n?```[\s\S]*$/, '');
            parsed = tryParseJSON(inner) ?? tryRepairTruncatedJSON(inner);
        }
    }

    if (!parsed) {
        throw new Error(
            `Model response is not valid JSON. First 300 chars: ${cleaned.slice(0, 300)}`,
        );
    }

    const triggered = parsed.triggered;
    if (!Array.isArray(triggered)) {
        return [];
    }

    return triggered
        .filter((item: Record<string, unknown>) => item && typeof item.name === 'string')
        .map((item: Record<string, unknown>) => ({
            name: String(item.name ?? ''),
            confidence: typeof item.confidence === 'number' && Number.isFinite(item.confidence)
                ? Math.min(1, Math.max(0, item.confidence))
                : 0.5,
            summary: item.summary != null ? String(item.summary) : '',
            evidence: item.evidence != null ? String(item.evidence) : '',
            suggestedDetectors: Array.isArray(item.suggested_detectors)
                ? (item.suggested_detectors as unknown[]).filter((d): d is string => typeof d === 'string')
                : [],
            taskAction: optionalString(item.action),
            taskLabel: optionalString(item.task_label) ?? optionalString(item.taskLabel),
            taskDescription: optionalString(item.task_description) ?? optionalString(item.taskDescription),
        }));
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function tryParseJSON(text: string): Record<string, unknown> | null {
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function tryRepairTruncatedJSON(text: string): Record<string, unknown> | null {
    let repaired = text;

    const lastCompleteItem = repaired.lastIndexOf('}');
    if (lastCompleteItem > 0) {
        repaired = repaired.slice(0, lastCompleteItem + 1);
    }

    let openBraces = 0;
    let openBrackets = 0;
    let inString = false;
    let escaped = false;
    for (const ch of repaired) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') openBraces++;
        else if (ch === '}') openBraces--;
        else if (ch === '[') openBrackets++;
        else if (ch === ']') openBrackets--;
    }

    while (openBrackets > 0) { repaired += ']'; openBrackets--; }
    while (openBraces > 0) { repaired += '}'; openBraces--; }

    return tryParseJSON(repaired);
}
