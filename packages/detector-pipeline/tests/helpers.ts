import type { DetectorSpec, ActivityEvent } from '../types';

export function spec(overrides: Partial<DetectorSpec> = {}): DetectorSpec {
    return {
        name: 'det',
        description: 'A test detector',
        event: 'test-event',
        body: 'Fire when the test condition holds.',
        cooldownMs: 0,
        intervalMs: 0,
        debounceMs: 0,
        trigger: 'interval',
        sources: ['events'],
        ...overrides,
    };
}

export function event(eventType: string, fields: Record<string, unknown> = {}, timestamp = 1_700_000_000_000): ActivityEvent {
    return { eventType, timestamp, ...fields };
}

/** Make every fetch fail loudly so no test can reach the network by accident. */
export function blockNetwork(): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
        throw new Error('network access is blocked in tests');
    }) as typeof fetch;
    return () => {
        globalThis.fetch = original;
    };
}

/** Silence console output from the code under test (it logs model summaries). */
export function quietConsole(): () => void {
    const log = console.log;
    const warn = console.warn;
    const error = console.error;
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    return () => {
        console.log = log;
        console.warn = warn;
        console.error = error;
    };
}
