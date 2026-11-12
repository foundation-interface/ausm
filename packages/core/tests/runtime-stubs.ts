/**
 * Test doubles for AUSMRuntime. Every native/device/service module the runtime
 * loads lazily via require() is intercepted here, so initialize() can run
 * without spawning helpers, opening databases or touching real sensors.
 */
import { EventEmitter } from 'events';
import Module from 'module';

export class FakeDetectorPipelineClient extends EventEmitter {
    options: Record<string, unknown>;
    detectors: Array<Record<string, any>> = [];
    contexts: Array<string | null> = [];
    pushes: Array<{ kind: string; summary: Record<string, unknown> }> = [];
    frames: string[] = [];
    startResult = true;
    started = 0;
    cleanedUp = 0;

    constructor(options: Record<string, unknown>) {
        super();
        this.options = options;
    }
    addDetector(spec: Record<string, any>): void { this.detectors.push(spec); }
    setEvaluationContext(ctx: string | null): void { this.contexts.push(ctx); }
    onScreenFrameAvailable(frame: string): void { this.frames.push(frame); }
    pushTextInputEvent(s: Record<string, unknown>): void { this.pushes.push({ kind: 'text-input', summary: s }); }
    pushWindowStateEvent(s: Record<string, unknown>): void { this.pushes.push({ kind: 'window-state', summary: s }); }
    pushTextSelectionEvent(s: Record<string, unknown>): void { this.pushes.push({ kind: 'text-selection', summary: s }); }
    pushMaterialEvent(s: Record<string, unknown>): void { this.pushes.push({ kind: 'material', summary: s }); }
    pushCursorEvent(s: Record<string, unknown>): void { this.pushes.push({ kind: 'cursor', summary: s }); }
    pushCopyPasteEvent(s: Record<string, unknown>): void { this.pushes.push({ kind: 'copy-paste', summary: s }); }
    pushScreenshotEvent(s: Record<string, unknown>): void { this.pushes.push({ kind: 'screenshot', summary: s }); }
    start(): boolean { this.started++; return this.startResult; }
    stop(): boolean { return true; }
    cleanup(): void { this.cleanedUp++; this.removeAllListeners(); }
}

export class FakeMemoryClient {
    started = 0;
    stopped = 0;
    frozen = false;
    screenshots: Array<Record<string, unknown>> = [];
    startError: Error | null = null;
    startDelay: Promise<void> | null = null;
    latestFrames = new Map<string, { dataBase64: string }>();

    async start(): Promise<void> {
        this.started++;
        if (this.startDelay) await this.startDelay;
        if (this.startError) throw this.startError;
    }
    async stop(): Promise<void> { this.stopped++; }
    saveScreenshot(s: Record<string, unknown>): void { this.screenshots.push(s); }
    async freezeMemory(): Promise<boolean> { this.frozen = true; return true; }
    async unfreezeMemory(): Promise<boolean> { this.frozen = false; return true; }
    async isMemoryFrozen(): Promise<boolean> { return this.frozen; }
    async getAllMaterials(): Promise<unknown[]> { return [{ id: 'm1' }]; }
    async getMaterialLatestFrame(id: string): Promise<unknown> { return this.latestFrames.get(id) ?? null; }
    async getMaterialFrames(): Promise<unknown[]> { throw new Error('db gone'); }
    async getMaterialOcr(): Promise<unknown> { return null; }
    async getScreenshots(): Promise<unknown[]> { return [{ id: 's1' }]; }
    async getScreenshot(): Promise<unknown> { throw new Error('db gone'); }
    async getMaterialWeights(): Promise<Record<string, number>> { return { m1: 0.5 }; }
}

export interface Stubs {
    pipelineClients: FakeDetectorPipelineClient[];
    memoryClients: FakeMemoryClient[];
    /** Configure the next memory client before initialize() creates it. */
    nextMemory: (configure: (m: FakeMemoryClient) => void) => void;
    /** Make the clients module (or a factory) throw on load/call. */
    failClients: boolean;
    failPipelineFactory: boolean;
    nextPipelineStartResult: boolean;
    requested: string[];
    restore: () => void;
}

/**
 * Intercept require() for '@ausm/core/clients' and every '@ausm/device-macos-*'
 * package. Device packages always throw "not available" so no helper starts.
 */
export function installStubs(): Stubs {
    const anyModule = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
    const original = anyModule._load;
    let configureMemory: ((m: FakeMemoryClient) => void) | null = null;

    const stubs: Stubs = {
        pipelineClients: [],
        memoryClients: [],
        nextMemory: (fn) => { configureMemory = fn; },
        failClients: false,
        failPipelineFactory: false,
        nextPipelineStartResult: true,
        requested: [],
        restore: () => { anyModule._load = original; },
    };

    const clients = {
        createDetectorPipelineClient: (options: Record<string, unknown>) => {
            if (stubs.failPipelineFactory) throw new Error('pipeline factory exploded');
            const c = new FakeDetectorPipelineClient(options);
            c.startResult = stubs.nextPipelineStartResult;
            stubs.pipelineClients.push(c);
            return c;
        },
        createMemoryClient: () => {
            const m = new FakeMemoryClient();
            if (configureMemory) { configureMemory(m); configureMemory = null; }
            stubs.memoryClients.push(m);
            return m;
        },
        createSelectionClient: () => { throw new Error('selection client unavailable in tests'); },
        createViewportClient: () => { throw new Error('viewport client unavailable in tests'); },
        createTextInputClient: () => { throw new Error('text input client unavailable in tests'); },
        createMaterialClient: () => { throw new Error('material client unavailable in tests'); },
    };

    anyModule._load = function (request: string, parent: unknown, isMain: boolean) {
        if (request === '@ausm/core/clients') {
            stubs.requested.push(request);
            if (stubs.failClients) throw new Error("Cannot find module '@ausm/core/clients'");
            return clients;
        }
        if (request.startsWith('@ausm/device-macos-')) {
            stubs.requested.push(request);
            throw new Error(`${request} unavailable in tests`);
        }
        return original.call(this, request, parent, isMain);
    };

    return stubs;
}

export function quietConsole(): { restore: () => void; warnings: string[]; logs: string[] } {
    const saved = { log: console.log, warn: console.warn, error: console.error };
    const warnings: string[] = [];
    const logs: string[] = [];
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    console.error = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    return {
        warnings,
        logs,
        restore: () => { console.log = saved.log; console.warn = saved.warn; console.error = saved.error; },
    };
}

/** Runtime config that keeps every optional native path off. */
export const QUIET_CONFIG = {
    textSelection: { enableNativeSelection: false },
    textInput: { enableNativeTextInput: false },
    screenshotDetector: { enabled: false },
    clipboardMonitor: { enabled: false },
} as const;

export const ENV_KEYS = [
    'TASK_DETECTOR_PROVIDER', 'TASK_DETECTOR_PROJECT_ID', 'AUSM_DETECTOR_PROJECT_ID', 'CEREBRAS_API_KEY',
    'CEREBRAS_BASE_URL', 'TASK_DETECTOR_MODEL', 'TASK_DETECTOR_LOCATION',
];

export function clearDetectorEnv(): () => void {
    const saved: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    return () => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    };
}
