/**
 * Thin wrapper around Google Gemini for multimodal detector evaluation.
 * Sends screen frames (vision) + activity event text to evaluate detector specs.
 *
 * Uses the @google/genai SDK with Vertex AI.
 */

import { GoogleGenAI, Type, type Part, type GenerateContentConfig } from '@google/genai';

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

export interface VertexDetectorClientConfig {
    projectId: string;
    location: string;
    model: string;
    onTrace?: (trace: PromptTrace) => void;
}

export class VertexDetectorClient implements DetectorModelClient {
    private ai: GoogleGenAI;
    private config: VertexDetectorClientConfig;
    private evaluationConfig: GenerateContentConfig;

    constructor(config: VertexDetectorClientConfig) {
        this.config = config;

        this.ai = new GoogleGenAI({
            vertexai: true,
            project: config.projectId,
            location: config.location,
        });

        this.evaluationConfig = {
            systemInstruction: DETECTOR_PIPELINE_SYSTEM_PROMPT,
            maxOutputTokens: 256,
            responseMimeType: 'application/json',
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    triggered: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                name: { type: Type.STRING },
                                confidence: { type: Type.NUMBER },
                                summary: { type: Type.STRING },
                                evidence: { type: Type.STRING },
                                suggested_detectors: {
                                    type: Type.ARRAY,
                                    items: { type: Type.STRING },
                                },
                            },
                            required: ['name', 'confidence', 'summary', 'evidence'],
                        },
                    },
                },
                required: ['triggered'],
            },
            temperature: 0,
        };
    }

    /**
     * Evaluate detector specs against screen frame + activity events.
     * The imageBase64 is optional — when null, evaluation is text-only (events-based detectors).
     */
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
    ): Promise<{
        triggered: Array<{ name: string; confidence: number; summary: string; evidence: string; suggestedDetectors: string[] }>;
        rawResponse: string;
        modelLatencyMs: number;
        parseMs: number;
        attempt: number;
    }> {
        const maxRetries = 3;
        const baseDelayMs = 1500;
        const t0 = performance.now();

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const parts: Part[] = [];

                if (imageBase64) {
                    parts.push({
                        inlineData: {
                            mimeType: 'image/jpeg',
                            data: imageBase64,
                        },
                    });
                }

                parts.push({ text: prompt });

                const tSend = performance.now();
                const result = await this.ai.models.generateContent({
                    model: this.config.model,
                    contents: [{ role: 'user', parts }],
                    config: this.evaluationConfig,
                });
                const modelLatencyMs = Math.round(performance.now() - tSend);

                const rawText =
                    result.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

                const trimmed = rawText.trim();
                if (!trimmed) {
                    throw new Error('Vertex AI returned empty response');
                }

                const tParse = performance.now();
                const triggered = parseDetectorResponse(rawText);
                const parseMs = Math.round(performance.now() - tParse);

                this.emitTrace(prompt, imageBase64 != null, t0, rawText, triggered, null, modelLatencyMs);

                return { triggered, rawResponse: rawText, modelLatencyMs, parseMs, attempt };
            } catch (err) {
                const isRetryable = err instanceof Error && (
                    err.message.includes('429') ||
                    err.message.includes('RESOURCE_EXHAUSTED') ||
                    err.message.includes('not valid JSON') ||
                    err.message.includes('empty response')
                );

                if (isRetryable && attempt < maxRetries) {
                    const delay = baseDelayMs * Math.pow(2, attempt);
                    await new Promise(resolve => setTimeout(resolve, delay));
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
