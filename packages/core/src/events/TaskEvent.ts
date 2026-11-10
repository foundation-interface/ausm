import { AUSMEvent, EventDataOf, createAUSMEvent } from '../AUSM';

export enum TaskStatus {
    DETECTED = 'TASK_DETECTED',
    UPDATED = 'TASK_UPDATED',
    COMPLETED = 'TASK_COMPLETED',
}

export type TaskLevel = 'goal' | 'leaf';

export interface TaskEvent extends AUSMEvent {
    readonly kind: 'task';
    readonly status: TaskStatus | null;
    /** Stable identifier for the detected task */
    readonly taskId: string | null;
    /** Unused: low-level actions are flat (kept for compatibility) */
    readonly parentTaskId: string | null;
    /** Unused: low-level actions are flat (kept for compatibility) */
    readonly level: TaskLevel | null;
    /** Short human-readable label, e.g. "Writing email" */
    readonly taskLabel: string | null;
    /** Longer LLM-generated description of the task */
    readonly taskDescription: string | null;
    /** Model confidence score (0-1) */
    readonly confidence: number | null;
    /** Application the task was detected in */
    readonly application: string | null;
    /** Detector that produced this task (e.g. rapid-task) */
    readonly detectorName: string | null;
    /** Concrete observations from the detector */
    readonly evidence: string | null;
    /** Raw model response for debugging */
    readonly rawModelResponse: string | null;
    /** Epoch ms when the AI model request was initiated */
    readonly requestTimestamp: number | null;
    /** Epoch ms when the AI model response was received */
    readonly responseTimestamp: number | null;
    /** Vertex generateContent wall time (send → response), ms */
    readonly modelLatencyMs: number | null;
}

export type TaskEventData = EventDataOf<TaskEvent>;

export function createTaskEvent(data: TaskEventData = {}): TaskEvent {
    return {
        ...createAUSMEvent('task', data),
        status: data.status ?? null,
        taskId: data.taskId ?? null,
        parentTaskId: data.parentTaskId ?? null,
        level: data.level ?? null,
        taskLabel: data.taskLabel ?? null,
        taskDescription: data.taskDescription ?? null,
        confidence: data.confidence ?? null,
        application: data.application ?? null,
        detectorName: data.detectorName ?? null,
        evidence: data.evidence ?? null,
        rawModelResponse: data.rawModelResponse ?? null,
        requestTimestamp: data.requestTimestamp ?? null,
        responseTimestamp: data.responseTimestamp ?? null,
        modelLatencyMs: data.modelLatencyMs ?? null,
    };
}
