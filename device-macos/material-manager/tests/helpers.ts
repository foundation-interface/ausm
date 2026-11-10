/**
 * Test fakes for MaterialManager: a controllable frame reader (no Python),
 * a controllable per-window capture helper (no screen access) and small
 * async utilities.  Everything here is synthetic.
 */
import { MaterialManager, type WindowStateEventLike } from '../material-manager';
import type { CropResult, ImageAnalysisResult } from '../frame-reader';
import type { MaterialManagerConfig, MaterialFrame, Material } from '../types';

export interface Deferred<T> {
    promise: Promise<T>;
    resolve: (v: T) => void;
    reject: (e: Error) => void;
}

export function deferred<T>(): Deferred<T> {
    let resolve!: (v: T) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Let pending promise callbacks run. */
export async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}

export interface CropCall {
    displayId: string;
    bounds: { x: number; y: number; width: number; height: number };
    prevHash: string | null;
    d: Deferred<CropResult>;
}

export interface ImageCall {
    data: Buffer;
    prevHash: string | null;
    d: Deferred<ImageAnalysisResult>;
}

/** Stand-in for FrameReader: every request is parked until the test settles it. */
export class FakeFrameReader {
    ready = true;
    crops: CropCall[] = [];
    images: ImageCall[] = [];
    stopped = false;

    isReady(): boolean {
        return this.ready;
    }
    async start(): Promise<void> {}
    stop(): void {
        this.stopped = true;
        // Mirror the real reader: pending requests reject on stop.
        for (const c of this.crops) c.d.reject(new Error('Frame reader stopped'));
        for (const c of this.images) c.d.reject(new Error('Frame reader stopped'));
    }
    requestFrame(
        displayId: string,
        bounds: CropCall['bounds'],
        _scale: number,
        prevHash: string | null,
    ): Promise<CropResult> {
        const d = deferred<CropResult>();
        this.crops.push({ displayId, bounds: { ...bounds }, prevHash, d });
        return d.promise;
    }
    processImage(data: Buffer, prevHash: string | null): Promise<ImageAnalysisResult> {
        const d = deferred<ImageAnalysisResult>();
        this.images.push({ data, prevHash, d });
        return d.promise;
    }
}

export function crop(hash: string, hammingDistance: number, frameTimestamp = 0): CropResult {
    return { data: Buffer.from(hash), width: 4, height: 3, hash, hammingDistance, frameTimestamp };
}

export function analysis(hash: string, hammingDistance: number): ImageAnalysisResult {
    return { width: 4, height: 3, hash, hammingDistance };
}

export interface CaptureCall {
    windowId: number;
    displayId: string | undefined;
    d: Deferred<{ data: Buffer; width: number; height: number }>;
}

/** Stand-in for the screen-stream helper's per-window capture. */
export class FakeHelper {
    calls: CaptureCall[] = [];
    captureWindow(windowId: number, _q?: number, displayId?: string) {
        const d = deferred<{ data: Buffer; width: number; height: number }>();
        this.calls.push({ windowId, displayId, d });
        return d.promise;
    }
}

export function ev(state: string, over: Partial<WindowStateEventLike> = {}): WindowStateEventLike {
    return {
        windowId: 7,
        bounds: { x: 0, y: 0, width: 400, height: 300 },
        displayId: 1,
        title: 'Doc 1',
        application: 'Editor',
        bundleId: 'com.example.editor',
        pid: 10,
        state,
        documentPath: null,
        ...over,
    };
}

const live = new Set<MaterialManager>();

/** Stop every harness created so far (use in afterEach so a failing test cannot leak timers). */
export function stopAll(): void {
    for (const mm of live) {
        (mm as unknown as { running: boolean }).running = true;
        mm.stop();
    }
    live.clear();
}

export interface Harness {
    mm: MaterialManager;
    reader: FakeFrameReader;
    helper: FakeHelper | null;
    frames: MaterialFrame[];
    events: string[];
    errors: Error[];
    saved: Material[];
}

/**
 * A MaterialManager marked running with a fake frame reader.  No subprocess
 * is spawned and nothing touches the screen.
 */
export function harness(
    config: MaterialManagerConfig = {},
    opts: { helper?: boolean } = {},
): Harness {
    const helper = opts.helper ? new FakeHelper() : null;
    const mm = new MaterialManager({
        storageMode: 'remote',
        captureDelayMs: 1,
        captureIntervalMs: 60_000,
        freshnessRetryBaseMs: 1,
        ...(helper ? { screenStreamHelper: helper } : {}),
        ...config,
    });
    const reader = new FakeFrameReader();
    const internals = mm as unknown as { frameReader: FakeFrameReader; running: boolean };
    internals.frameReader = reader;
    internals.running = true;
    live.add(mm);

    const frames: MaterialFrame[] = [];
    const events: string[] = [];
    const errors: Error[] = [];
    const saved: Material[] = [];
    mm.on('material-frame', (f) => frames.push(f));
    mm.on('material-created', (m) => events.push(`created:${m.title}`));
    mm.on('material-focused', (w, m) => events.push(`focused:${w}:${m.title}`));
    mm.on('material-unfocused', (w, m) => events.push(`unfocused:${w}:${m.title}`));
    mm.on('error', (e) => errors.push(e));
    mm.on('storage:save-material', (m) => saved.push(m));
    return { mm, reader, helper, frames, events, errors, saved };
}
