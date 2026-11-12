import { randomUUID } from 'crypto';

import { createTaskEvent, TaskStatus, type TaskEvent } from '../events/TaskEvent';

export type TaskAction = 'continue' | 'update' | 'begin' | 'end' | 'switch';

export interface TaskObservation {
    action?: string | null;
    label: string;
    description: string;
    confidence: number;
    application?: string | null;
    evidence?: string | null;
    detectorName?: string | null;
    rawModelResponse?: string | null;
    requestTimestamp?: number | null;
    responseTimestamp?: number | null;
    modelLatencyMs?: number | null;
    timestamp: number;
}

interface TrackedTask {
    taskId: string;
    label: string;
    description: string;
    application: string | null;
    startedAt: number;
}

const ACTION_ALIASES: Record<string, TaskAction> = {
    continue: 'continue',
    same: 'continue',
    unchanged: 'continue',
    update: 'update',
    evolve: 'update',
    refresh: 'update',
    begin: 'begin',
    start: 'begin',
    new: 'begin',
    detect: 'begin',
    end: 'end',
    complete: 'end',
    finish: 'end',
    switch: 'switch',
    replace: 'switch',
};

/**
 * Session-level task state for a single low-level action.
 * Maps model observations onto begin / update / end so the same
 * activity (e.g. still browsing social media) keeps one task id.
 */
export class TaskTracker {
    private current: TrackedTask | null = null;

    formatContext(): string {
        if (!this.current) {
            return 'No active task. If the screenshot shows a low-level action, begin it.';
        }
        return [
            `Current task: "${this.current.label}" — ${this.current.description} (id: ${this.current.taskId}, since ${new Date(this.current.startedAt).toISOString()})`,
            'Continue only if they are still on this same specific work. A different site, app, or content type is a new task — do not stretch this label to cover it.',
        ].join('\n');
    }

    apply(observation: TaskObservation): TaskEvent[] {
        const label = observation.label.trim();
        const description = observation.description.trim() || label;
        if (!label) return [];

        let action = normalizeAction(observation.action);
        // rapid-task no longer asks the model for an action. Infer from labels.
        // continue/update both emit TASK_UPDATED so the timeline span stays live.
        if (!action) {
            if (!this.current) {
                action = 'begin';
            } else if (sameWork(this.current.label, this.current.description, label, description)) {
                action = similarText(this.current.description, description) ? 'continue' : 'update';
            } else {
                action = 'switch';
            }
        }
        if (action === 'continue' && !this.current) {
            action = 'begin';
        }
        if ((action === 'begin' || action === 'switch') && this.current && sameWork(this.current.label, this.current.description, label, description)) {
            action = similarText(this.current.description, description) ? 'continue' : 'update';
        }
        if (action === 'continue' && this.current && !sameWork(this.current.label, this.current.description, label, description)) {
            action = 'switch';
        }
        if (action === 'update' && this.current && !sameWork(this.current.label, this.current.description, label, description)) {
            action = 'switch';
        }

        const events: TaskEvent[] = [];
        const now = observation.timestamp || Date.now();

        const emit = (status: TaskStatus, task: TrackedTask, overrides?: { label?: string; description?: string }) => {
            events.push(createTaskEvent({
                status,
                taskId: task.taskId,
                taskLabel: overrides?.label ?? task.label,
                taskDescription: overrides?.description ?? task.description,
                confidence: observation.confidence,
                // The tracked task owns its application (already merged for continue/update).
                // On a switch the COMPLETED event must not take the new observation's app.
                application: task.application,
                detectorName: observation.detectorName ?? 'rapid-task',
                evidence: observation.evidence ?? null,
                rawModelResponse: observation.rawModelResponse ?? null,
                requestTimestamp: observation.requestTimestamp ?? null,
                responseTimestamp: observation.responseTimestamp ?? null,
                modelLatencyMs: observation.modelLatencyMs ?? null,
                timestamp: now,
            }));
        };

        switch (action) {
            case 'continue': {
                if (this.current) {
                    this.current = {
                        ...this.current,
                        label,
                        description,
                        application: observation.application ?? this.current.application,
                    };
                    emit(TaskStatus.UPDATED, this.current);
                } else {
                    this.current = createTracked(label, description, observation.application, now);
                    emit(TaskStatus.DETECTED, this.current);
                }
                break;
            }

            case 'update': {
                if (this.current) {
                    this.current = {
                        ...this.current,
                        label,
                        description,
                        application: observation.application ?? this.current.application,
                    };
                    emit(TaskStatus.UPDATED, this.current);
                } else {
                    this.current = createTracked(label, description, observation.application, now);
                    emit(TaskStatus.DETECTED, this.current);
                }
                break;
            }

            case 'end': {
                if (this.current) {
                    emit(TaskStatus.COMPLETED, this.current);
                    this.current = null;
                }
                break;
            }

            case 'switch':
            case 'begin': {
                if (this.current) {
                    emit(TaskStatus.COMPLETED, this.current);
                    this.current = null;
                }
                this.current = createTracked(label, description, observation.application, now);
                emit(TaskStatus.DETECTED, this.current);
                break;
            }
        }

        return events;
    }

    reset(): void {
        this.current = null;
    }
}

export function observationFromDetectorResult(result: {
    summary: string;
    evidence: string;
    confidence: number;
    application?: string | null;
    detectorName?: string;
    rawModelResponse?: string | null;
    requestTimestamp?: number;
    responseTimestamp?: number;
    modelLatencyMs?: number | null;
    timestamp: number;
    taskAction?: string | null;
    taskLabel?: string | null;
    taskDescription?: string | null;
}): TaskObservation {
    const fromJson = parseSummaryJson(result.summary);
    const label = (
        result.taskLabel?.trim()
        || fromJson?.label
        || splitSummary(result.summary).label
    ).trim();
    const description = (
        result.taskDescription?.trim()
        || fromJson?.description
        || splitSummary(result.summary).description
        || result.evidence
        || label
    ).trim();

    return {
        action: result.taskAction || fromJson?.action || null,
        label,
        description,
        confidence: result.confidence,
        application: result.application ?? null,
        evidence: result.evidence,
        detectorName: result.detectorName,
        rawModelResponse: result.rawModelResponse ?? null,
        requestTimestamp: result.requestTimestamp ?? null,
        responseTimestamp: result.responseTimestamp ?? null,
        modelLatencyMs: result.modelLatencyMs ?? null,
        timestamp: result.timestamp,
    };
}

function createTracked(
    label: string,
    description: string,
    application: string | null | undefined,
    startedAt: number,
): TrackedTask {
    return {
        taskId: `task_${randomUUID()}`,
        label,
        description,
        application: application ?? null,
        startedAt,
    };
}

function normalizeAction(raw?: string | null): TaskAction | null {
    if (!raw) return null;
    return ACTION_ALIASES[raw.trim().toLowerCase()] ?? null;
}

function splitSummary(summary: string): { label: string; description: string } {
    const trimmed = summary.trim();
    if (trimmed.startsWith('{')) return { label: '', description: '' };
    const colon = trimmed.indexOf(':');
    if (colon < 0) return { label: trimmed, description: '' };
    return {
        label: trimmed.slice(0, colon).trim(),
        description: trimmed.slice(colon + 1).trim(),
    };
}

function parseSummaryJson(summary: string): Record<string, string> | null {
    const trimmed = summary.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string') out[key] = value;
        }
        return out;
    } catch {
        return null;
    }
}

function normalizeText(value: string): string {
    // Unicode-aware: an ASCII-only class erased non-Latin labels entirely, so they never matched.
    return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Labels made only of symbols/emoji normalize to nothing; compare them verbatim instead. */
function sameRaw(a: string, b: string): boolean {
    const ra = a.trim().toLowerCase();
    return ra.length > 0 && ra === b.trim().toLowerCase();
}

function similarLabel(a: string, b: string): boolean {
    const na = normalizeText(a);
    const nb = normalizeText(b);
    if (!na || !nb) return sameRaw(a, b);
    if (na === nb) return true;
    return tokenOverlap(na, nb) >= 0.7;
}

function sameWork(prevLabel: string, prevDescription: string, nextLabel: string, nextDescription: string): boolean {
    if (similarLabel(prevLabel, nextLabel) && similarText(prevDescription, nextDescription)) {
        return true;
    }
    if (similarLabel(prevLabel, nextLabel) && similarText(prevLabel + ' ' + prevDescription, nextLabel + ' ' + nextDescription)) {
        return true;
    }
    return false;
}

function similarText(a: string, b: string): boolean {
    const na = normalizeText(a);
    const nb = normalizeText(b);
    if (!na || !nb) return sameRaw(a, b);
    if (na === nb) return true;
    return tokenOverlap(na, nb) >= 0.6;
}

function tokenOverlap(a: string, b: string): number {
    const ta = new Set(a.split(' ').filter((w) => w.length > 2));
    const tb = new Set(b.split(' ').filter((w) => w.length > 2));
    if (ta.size === 0 || tb.size === 0) return 0;
    let inter = 0;
    for (const token of ta) {
        if (tb.has(token)) inter++;
    }
    return inter / Math.min(ta.size, tb.size);
}
