/**
 * OpenAI-compatible Cerebras client for multimodal detector evaluation.
 * Chat Completions at https://api.cerebras.ai/v1 — images as JPEG data URIs.
 */

import type {
    PromptTrace,
    DetectorSpec,
    ActivityEvent,
    DetectorEvaluateResult,
    DetectorModelClient,
} from './types';
import {
    DETECTOR_PIPELINE_SYSTEM_PROMPT,
    buildDetectorEvaluationPrompt,
    parseDetectorResponse,
} from './prompts';

export const CEREBRAS_DEFAULT_BASE_URL = 'https://api.cerebras.ai/v1';
export const CEREBRAS_DEFAULT_MODEL = 'gemma-4-31b';

export interface CerebrasDetectorClientConfig {
    apiKey: string;
    model: string;
    baseUrl?: string;
    /** Per-attempt request timeout in ms (default: 30000). */
    timeoutMs?: number;
    onTrace?: (trace: PromptTrace) => void;
}

export const CEREBRAS_DEFAULT_TIMEOUT_MS = 30_000;

interface ChatMessageContentPart {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: { url: string };
}

interface ChatCompletionResponse {
    choices?: Array<{
        message?: {
            content?: string | Array<{ type?: string; text?: string }>;
        };
    }>;
    error?: { message?: string };
}

export class CerebrasDetectorClient implements DetectorModelClient {
    private config: CerebrasDetectorClientConfig;
    private endpoint: string;

    constructor(config: CerebrasDetectorClientConfig) {
        this.config = config;
        const base = (config.baseUrl || CEREBRAS_DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.endpoint = `${base}/chat/completions`;
    }

    async evaluate(
        detectors: DetectorSpec[],
        events: ActivityEvent[],
        imageBase64: string | null,
        maxEvents?: number,
        evaluationContext?: string | null,
    ): Promise<DetectorEvaluateResult> {
        const t0 = performance.now();
        const prompt = buildDetectorEvaluationPrompt(
            detectors,
            events,
            imageBase64 != null,
            maxEvents,
            evaluationContext,
        );
        const promptBuildMs = Math.round(performance.now() - t0);

        const result = await this.callModel(prompt, imageBase64);
        return { ...result, rawPrompt: prompt, promptBuildMs };
    }

    private async callModel(
        prompt: string,
        imageBase64: string | null,
    ): Promise<Omit<DetectorEvaluateResult, 'rawPrompt' | 'promptBuildMs'>> {
        const maxRetries = 3;
        const baseDelayMs = 1500;
        const t0 = performance.now();

        const userContent: ChatMessageContentPart[] = [];
        if (imageBase64) {
            userContent.push({
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
            });
        }
        userContent.push({ type: 'text', text: prompt });

        const body = {
            model: this.config.model,
            temperature: 0,
            // Room for a one-sentence task_description, plus models that spend tokens reasoning first.
            max_tokens: 512,
            response_format: { type: 'json_object' as const },
            messages: [
                { role: 'system', content: DETECTOR_PIPELINE_SYSTEM_PROMPT },
                { role: 'user', content: userContent },
            ],
        };

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const tSend = performance.now();
                const timeoutMs = this.config.timeoutMs ?? CEREBRAS_DEFAULT_TIMEOUT_MS;
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                let response: Response;
                let rawBody: string;
                try {
                    response = await fetch(this.endpoint, {
                        method: 'POST',
                        headers: {
                            // Keyless local servers get no Authorization header.
                            ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(body),
                        signal: controller.signal,
                    });
                    rawBody = await response.text();
                } catch (fetchErr) {
                    if (controller.signal.aborted) {
                        throw flagRetryable(new Error(`Cerebras request timed out after ${timeoutMs}ms`), false);
                    }
                    throw fetchErr;
                } finally {
                    clearTimeout(timer);
                }
                const modelLatencyMs = Math.round(performance.now() - tSend);

                if (!response.ok) {
                    // Decide retry from the status code, not from digits that may appear in the body.
                    throw flagRetryable(
                        new Error(formatHttpError(response.status, rawBody)),
                        RETRYABLE_HTTP_STATUS.has(response.status),
                    );
                }

                const parsed = parseChatResponse(rawBody);
                const trimmed = parsed.trim();
                if (!trimmed) {
                    throw new Error('Cerebras returned empty response');
                }

                const tParse = performance.now();
                const triggered = parseDetectorResponse(parsed);
                const parseMs = Math.round(performance.now() - tParse);

                this.emitTrace(prompt, imageBase64 != null, t0, parsed, triggered, null, modelLatencyMs);

                return { triggered, rawResponse: parsed, modelLatencyMs, parseMs, attempt };
            } catch (err) {
                const flagged = (err as { retryable?: unknown } | null)?.retryable;
                const isRetryable = err instanceof Error && (
                    typeof flagged === 'boolean'
                        ? flagged
                        : /\b(429|502|503)\b/.test(err.message)
                            || err.message.includes('RESOURCE_EXHAUSTED')
                            || err.message.includes('not valid JSON')
                            || err.message.includes('empty response')
                );

                if (isRetryable && attempt < maxRetries) {
                    const delay = baseDelayMs * Math.pow(2, attempt);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    continue;
                }

                const wrapped = err instanceof Error ? err : new Error(String(err));
                this.emitTrace(prompt, imageBase64 != null, t0, null, null, wrapped.message);
                throw wrapped;
            }
        }
        throw new Error('Unreachable');
    }

    private emitTrace(
        userPrompt: string,
        hasImage: boolean,
        t0: number,
        rawResponse: string | null,
        parsedResult: Array<{ name: string; confidence: number; summary: string; evidence: string; suggestedDetectors: string[] }> | null,
        error: string | null,
        modelLatencyMs?: number,
    ): void {
        if (!this.config.onTrace) return;

        const latencyMs = Math.round(performance.now() - t0);

        const trace: PromptTrace = {
            traceId: `dp_trace_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            timestamp: Date.now(),
            model: this.config.model,
            systemPrompt: DETECTOR_PIPELINE_SYSTEM_PROMPT,
            userPrompt,
            hasImage,
            rawResponse,
            parsedResult: parsedResult?.map((r) => ({
                detectorName: r.name,
                eventType: '',
                confidence: r.confidence,
                summary: r.summary,
                evidence: r.evidence,
                timestamp: Date.now(),
                requestTimestamp: 0,
                responseTimestamp: 0,
                modelLatencyMs,
            })) ?? null,
            latencyMs,
            modelLatencyMs,
            error,
        };

        try {
            this.config.onTrace(trace);
        } catch {
            // Observer errors must not break evaluation
        }
    }
}

const RETRYABLE_HTTP_STATUS = new Set([429, 502, 503]);

function flagRetryable(err: Error, retryable: boolean): Error {
    (err as Error & { retryable?: boolean }).retryable = retryable;
    return err;
}

function parseChatResponse(rawBody: string): string {
    let data: ChatCompletionResponse;
    try {
        data = JSON.parse(rawBody) as ChatCompletionResponse;
    } catch {
        throw new Error(`Cerebras response is not valid JSON. First 300 chars: ${rawBody.slice(0, 300)}`);
    }

    if (data.error?.message) {
        throw new Error(data.error.message);
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => part.text ?? '').join('');
    }
    return '';
}

function formatHttpError(status: number, rawBody: string): string {
    let detail = rawBody.slice(0, 400);
    try {
        const parsed = JSON.parse(rawBody) as { error?: { message?: string } | string };
        if (typeof parsed.error === 'string') detail = parsed.error;
        else if (parsed.error?.message) detail = parsed.error.message;
    } catch {
        /* keep raw slice */
    }
    return `Cerebras HTTP ${status}: ${detail}`;
}
