import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { AUSMRuntime, createRuntime, ausmRuntime } from '../src/runtime/index';
import { MaterialEventType } from '../src/events/MaterialEvent';
import { TaskStatus, type TaskEvent } from '../src/events/TaskEvent';
import type { DetectorEvent } from '../src/detectors/types';
import {
    installStubs, quietConsole, clearDetectorEnv, QUIET_CONFIG,
    type Stubs, FakeDetectorPipelineClient,
} from './runtime-stubs';

let stubs: Stubs;
let out: ReturnType<typeof quietConsole>;
let restoreEnv: () => void;
let runtimes: AUSMRuntime[];

beforeEach(() => {
    stubs = installStubs();
    out = quietConsole();
    restoreEnv = clearDetectorEnv();
    runtimes = [];
});
afterEach(() => {
    for (const rt of runtimes) rt.shutdown();
    mock.timers.reset();
    restoreEnv();
    out.restore();
    stubs.restore();
});

function make(config: Record<string, unknown> = {}): AUSMRuntime {
    const rt = createRuntime({ ...QUIET_CONFIG, ...config } as any);
    runtimes.push(rt);
    return rt;
}

async function startPipeline(rt: AUSMRuntime): Promise<FakeDetectorPipelineClient | undefined> {
    const before = stubs.pipelineClients.length;
    await (rt as any).startDetectorPipeline();
    return stubs.pipelineClients.length > before ? stubs.pipelineClients[stubs.pipelineClients.length - 1] : undefined;
}

// ── Config resolution ───────────────────────────────────────────────────────

describe('detector pipeline config resolution', () => {
    test('no config and no env: pipeline stays off, no warning', async () => {
        assert.equal(await startPipeline(make()), undefined);
        assert.equal(out.warnings.filter((w) => w.includes('Detector pipeline')).length, 0);
    });

    test('TASK_DETECTOR_PROJECT_ID enables vertex', async () => {
        process.env.TASK_DETECTOR_PROJECT_ID = 'proj-env';
        const c = (await startPipeline(make()))!;
        assert.equal(c.options.provider, 'vertex');
        assert.equal(c.options.projectId, 'proj-env');
        assert.equal(c.started, 1);
    });

    test('AUSM_DETECTOR_PROJECT_ID is a fallback for the project id', async () => {
        process.env.AUSM_DETECTOR_PROJECT_ID = 'legacy';
        assert.equal((await startPipeline(make()))!.options.projectId, 'legacy');
        process.env.TASK_DETECTOR_PROJECT_ID = 'primary';
        assert.equal((await startPipeline(make()))!.options.projectId, 'primary');
    });

    test('CEREBRAS_API_KEY alone selects cerebras', async () => {
        process.env.CEREBRAS_API_KEY = 'fake-key';
        process.env.CEREBRAS_BASE_URL = 'http://fake.invalid/v1';
        const c = (await startPipeline(make()))!;
        assert.equal(c.options.provider, 'cerebras');
        assert.equal(c.options.apiKey, 'fake-key');
        assert.equal(c.options.apiBaseUrl, 'http://fake.invalid/v1');
    });

    test('both credentials and no provider: vertex wins; TASK_DETECTOR_PROVIDER overrides', async () => {
        process.env.CEREBRAS_API_KEY = 'k';
        process.env.TASK_DETECTOR_PROJECT_ID = 'p';
        assert.equal((await startPipeline(make()))!.options.provider, 'vertex');
        process.env.TASK_DETECTOR_PROVIDER = 'cerebras';
        assert.equal((await startPipeline(make()))!.options.provider, 'cerebras');
    });

    test('provider value is case- and whitespace-insensitive', async () => {
        process.env.CEREBRAS_API_KEY = 'k';
        process.env.TASK_DETECTOR_PROJECT_ID = 'p';
        process.env.TASK_DETECTOR_PROVIDER = '  CEREBRAS ';
        assert.equal((await startPipeline(make()))!.options.provider, 'cerebras');
    });

    test('a provider typo warns and falls back to inference', async () => {
        process.env.CEREBRAS_API_KEY = 'k';
        process.env.TASK_DETECTOR_PROVIDER = 'cerebas';
        const c = (await startPipeline(make()))!;
        assert.equal(c.options.provider, 'cerebras', 'only a key is set, so cerebras is inferred');
        assert.ok(out.warnings.some((w) => w.includes('cerebas')), 'warns about the unknown provider');
    });

    test('provider=cerebras without a key warns and does not start', async () => {
        process.env.TASK_DETECTOR_PROVIDER = 'cerebras';
        process.env.TASK_DETECTOR_PROJECT_ID = 'p';
        assert.equal(await startPipeline(make({ detectorPipeline: { enabled: true } })), undefined);
        assert.ok(out.warnings.some((w) => w.includes('no CEREBRAS_API_KEY')));
    });

    test('enabled:true without credentials warns and does not start', async () => {
        assert.equal(await startPipeline(make({ detectorPipeline: { enabled: true } })), undefined);
        assert.ok(out.warnings.some((w) => w.includes('no projectId')));
    });

    test('enabled:false wins over credentials', async () => {
        process.env.TASK_DETECTOR_PROJECT_ID = 'p';
        assert.equal(await startPipeline(make({ detectorPipeline: { enabled: false } })), undefined);
    });

    test('explicit config beats env for every field', async () => {
        Object.assign(process.env, {
            TASK_DETECTOR_PROVIDER: 'vertex', TASK_DETECTOR_PROJECT_ID: 'env-p', CEREBRAS_API_KEY: 'env-k',
            CEREBRAS_BASE_URL: 'http://env.invalid', TASK_DETECTOR_MODEL: 'env-model', TASK_DETECTOR_LOCATION: 'env-loc',
        });
        const c = (await startPipeline(make({ detectorPipeline: {
            provider: 'cerebras', projectId: 'cfg-p', apiKey: 'cfg-k', apiBaseUrl: 'http://cfg.invalid', model: 'cfg-model', location: 'cfg-loc',
        } })))!;
        assert.deepEqual(
            [c.options.provider, c.options.projectId, c.options.apiKey, c.options.apiBaseUrl, c.options.model, c.options.location],
            ['cerebras', 'cfg-p', 'cfg-k', 'http://cfg.invalid', 'cfg-model', 'cfg-loc'],
        );
    });

    test('env fallbacks for model and location', async () => {
        process.env.TASK_DETECTOR_PROJECT_ID = 'p';
        process.env.TASK_DETECTOR_MODEL = 'gemini-x';
        process.env.TASK_DETECTOR_LOCATION = 'us-central1';
        const c = (await startPipeline(make()))!;
        assert.equal(c.options.model, 'gemini-x');
        assert.equal(c.options.location, 'us-central1');
    });

    test('env vars set to empty strings are treated as unset', async () => {
        Object.assign(process.env, {
            TASK_DETECTOR_PROVIDER: '', TASK_DETECTOR_PROJECT_ID: '', AUSM_DETECTOR_PROJECT_ID: '', CEREBRAS_API_KEY: '',
            CEREBRAS_BASE_URL: '', TASK_DETECTOR_MODEL: '', TASK_DETECTOR_LOCATION: '',
        });
        assert.equal(await startPipeline(make()), undefined);
        process.env.TASK_DETECTOR_PROJECT_ID = 'p';
        const c = (await startPipeline(make()))!;
        assert.equal(c.options.model, undefined);
        assert.equal(c.options.location, undefined);
        assert.equal(c.options.apiBaseUrl, undefined);
    });

    test('whitespace-only credentials do not enable the pipeline', async () => {
        process.env.TASK_DETECTOR_PROJECT_ID = '   ';
        process.env.CEREBRAS_API_KEY = '\t';
        assert.equal(await startPipeline(make()), undefined);
    });

    test('empty-string config values fall back to env', async () => {
        process.env.TASK_DETECTOR_PROJECT_ID = 'env-p';
        const c = (await startPipeline(make({ detectorPipeline: { projectId: '', model: '' } })))!;
        assert.equal(c.options.projectId, 'env-p');
        assert.equal(c.options.model, undefined);
    });

    test('debug follows logging.detectorPipeline, then global_default, then debug', async () => {
        process.env.TASK_DETECTOR_PROJECT_ID = 'p';
        assert.equal((await startPipeline(make({ logging: { detectorPipeline: true } })))!.options.debug, true);
        assert.equal((await startPipeline(make({ logging: { global_default: true, detectorPipeline: false } })))!.options.debug, false);
        assert.equal((await startPipeline(make({ debug: true })))!.options.debug, true);
        assert.equal((await startPipeline(make()))!.options.debug, false);
    });

    test('a client that fails to start is discarded with a warning', async () => {
        process.env.TASK_DETECTOR_PROJECT_ID = 'p';
        stubs.nextPipelineStartResult = false;
        const rt = make();
        const c = (await startPipeline(rt))!;
        assert.equal((rt as any).detectorPipelineClient, null);
        assert.equal(c.cleanedUp, 1);
        assert.ok(out.warnings.some((w) => /Detector pipeline failed to start/.test(w)));
        assert.equal((rt as any).detectorPipelineWarmupTimer, null);
    });

    test('a missing clients module warns instead of throwing', async () => {
        process.env.TASK_DETECTOR_PROJECT_ID = 'p';
        stubs.failClients = true;
        const rt = make();
        await (rt as any).startDetectorPipeline();
        assert.equal((rt as any).detectorPipelineClient, null);
        assert.ok(out.warnings.some((w) => w.includes('Detector pipeline failed to start')));
    });
});

// ── Detector → pipeline → task wiring ───────────────────────────────────────

describe('detector and task wiring', () => {
    async function wired(config: Record<string, unknown> = {}) {
        process.env.TASK_DETECTOR_PROJECT_ID = 'p';
        const rt = make(config);
        await (rt as any).detectorManager.load();
        const c = (await startPipeline(rt))!;
        const detectorEvents: DetectorEvent[] = [];
        const taskEvents: TaskEvent[] = [];
        rt.onDetectorEvent((e) => detectorEvents.push(e));
        rt.onTaskEvent((e) => taskEvents.push(e));
        return { rt, c, detectorEvents, taskEvents };
    }

    const result = (over: Record<string, unknown> = {}) => ({
        detectorName: 'rapid-task', eventType: 'task', confidence: 0.9, summary: 'Writing code: runtime.ts', evidence: 'Editor',
        timestamp: 1_700_000_000_000, application: 'Editor', bundleId: 'com.editor', windowTitle: 'runtime.ts',
        suggestedDetectors: undefined, modelLatencyMs: 120, ...over,
    });

    test('loaded detectors are registered, disabled ones as dispatchOnly', async () => {
        const { c } = await wired({ detectors: { entries: { 'rapid-task': { enabled: false } } } });
        const rt = c.detectors.find((d) => d.name === 'rapid-task')!;
        assert.equal(rt.dispatchOnly, true);
        assert.equal(rt.event, 'task');
        assert.equal(rt.isolated, true);
    });

    test('initial evaluation context comes from an empty tracker', async () => {
        const { c } = await wired();
        assert.match(c.contexts[0]!, /No active task/);
    });

    test('a rapid-task result emits a DetectorEvent and a TASK_DETECTED event, and updates context', async () => {
        const { c, detectorEvents, taskEvents } = await wired();
        c.emit('detector-triggered', result());
        assert.equal(detectorEvents.length, 1);
        assert.equal(detectorEvents[0].detectorName, 'rapid-task');
        assert.equal(detectorEvents[0].modelLatencyMs, 120);
        assert.deepEqual(detectorEvents[0].suggestedDetectors, []);
        assert.equal(taskEvents.length, 1);
        assert.equal(taskEvents[0].status, TaskStatus.DETECTED);
        assert.equal(taskEvents[0].taskLabel, 'Writing code');
        assert.equal(taskEvents[0].taskDescription, 'runtime.ts');
        assert.equal(taskEvents[0].application, 'Editor');
        assert.match(c.contexts.at(-1)!, /Current task: "Writing code"/);
    });

    test('task sequence: continue then switch', async () => {
        const { c, taskEvents } = await wired();
        c.emit('detector-triggered', result());
        c.emit('detector-triggered', result());
        c.emit('detector-triggered', result({ summary: 'Watching video: cooking', application: 'Browser' }));
        assert.deepEqual(taskEvents.map((e) => e.status), [TaskStatus.DETECTED, TaskStatus.UPDATED, TaskStatus.COMPLETED, TaskStatus.DETECTED]);
        assert.equal(taskEvents[0].taskId, taskEvents[1].taskId);
        assert.equal(taskEvents[2].taskId, taskEvents[0].taskId);
        assert.notEqual(taskEvents[3].taskId, taskEvents[0].taskId);
    });

    test('any detector declaring event: task feeds the tracker; others do not', async () => {
        const { c, detectorEvents, taskEvents } = await wired();
        c.emit('detector-triggered', result({ detectorName: 'other', eventType: 'something' }));
        assert.equal(detectorEvents.length, 1);
        assert.equal(taskEvents.length, 0);
        c.emit('detector-triggered', result({ detectorName: 'custom-task', eventType: 'task' }));
        assert.equal(taskEvents.length, 1);
        assert.equal(taskEvents[0].detectorName, 'custom-task');
    });

    test('an unusable summary produces a DetectorEvent but no TaskEvent', async () => {
        const { c, detectorEvents, taskEvents } = await wired();
        c.emit('detector-triggered', result({ summary: '' }));
        assert.equal(detectorEvents.length, 1);
        assert.equal(taskEvents.length, 0);
    });

    test('callbacks are additive and a throwing callback does not block the others or task tracking', async () => {
        const { rt, c, taskEvents } = await wired();
        const seen: string[] = [];
        rt.onDetectorEvent(() => { throw new Error('bad subscriber'); });
        rt.onDetectorEvent(() => seen.push('second'));
        rt.onTaskEvent(() => { throw new Error('bad task subscriber'); });
        assert.doesNotThrow(() => c.emit('detector-triggered', result()));
        assert.deepEqual(seen, ['second']);
        assert.equal(taskEvents.length, 1);
        assert.match(c.contexts.at(-1)!, /Writing code/);
    });

    test('pipeline errors are logged as warnings', async () => {
        const { c } = await wired();
        c.emit('error', new Error('quota'));
        assert.ok(out.warnings.some((w) => w.includes('quota')));
    });

    test('activity is ignored during the startup window, then forwarded', async () => {
        mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 5_000_000 });
        const { rt, c } = await wired();
        (rt as any).textInputDetector.start();
        (rt as any).applicationStateDetector.running = true;
        rt.emitTextInputEvent({ status: 'TYPING' as any, text: 'x' });
        assert.equal(c.pushes.length, 0);
        mock.timers.tick(2500);
        rt.emitTextInputEvent({ status: 'TYPING' as any, text: 'x' });
        assert.deepEqual(c.pushes.map((p) => p.kind), ['text-input']);
        assert.equal((rt as any).detectorPipelineWarmupTimer, null, 'warm-up timer fired and cleared itself');
    });

    test('material frames are forwarded only for the focused material', async () => {
        mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 5_000_000 });
        const { rt, c } = await wired();
        (rt as any).materialDetector.start();
        mock.timers.tick(2500);
        rt.emitMaterialEvent({ materialEventType: MaterialEventType.FRAME_CAPTURED, materialId: 'a', frameDataBase64: 'AAAA' });
        assert.equal(c.pushes.length, 0, 'nothing focused yet');
        rt.emitMaterialEvent({ materialEventType: MaterialEventType.MATERIAL_FOCUSED, materialId: 'a' });
        rt.emitMaterialEvent({ materialEventType: MaterialEventType.FRAME_CAPTURED, materialId: 'b', frameDataBase64: 'BBBB' });
        rt.emitMaterialEvent({ materialEventType: MaterialEventType.FRAME_CAPTURED, materialId: 'a', title: 'Doc', frameDataBase64: 'CCCC' });
        assert.deepEqual(c.frames, ['CCCC']);
        assert.equal(c.pushes.length, 1);
        assert.equal(c.pushes[0].summary.materialId, 'a');
        // A frame without inline data reuses the cached one.
        rt.emitMaterialEvent({ materialEventType: MaterialEventType.FRAME_CAPTURED, materialId: 'a' });
        assert.deepEqual(c.frames, ['CCCC', 'CCCC']);
        rt.emitMaterialEvent({ materialEventType: MaterialEventType.MATERIAL_UNFOCUSED, materialId: 'a' });
        rt.emitMaterialEvent({ materialEventType: MaterialEventType.FRAME_CAPTURED, materialId: 'a', frameDataBase64: 'DDDD' });
        assert.equal(c.pushes.length, 2, 'unfocused material is no longer forwarded');
    });

    test('cursor events: only discrete actions are forwarded', async () => {
        mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 5_000_000 });
        const { rt, c } = await wired();
        (rt as any).cursorPlusPlusDetector.running = true;
        mock.timers.tick(2500);
        rt.emitCursorPlusPlusEvent({ action: 'MOVE' as any, x: 1, y: 1 });
        rt.emitCursorPlusPlusEvent({ action: 'CLICK' as any, x: 1, y: 1 });
        assert.deepEqual(c.pushes.map((p) => p.summary.action), ['CLICK']);
    });
});

// ── initialize / shutdown ───────────────────────────────────────────────────

describe('initialize and shutdown', () => {
    test('initialize with every optional piece unavailable resolves and warns', async () => {
        const rt = make({ enableScreenStreaming: true, enableCameraStreaming: true, cursorPlusPlus: { enabled: true }, materialManager: { enabled: true } });
        stubs.nextMemory((m) => { m.startError = new Error('sqlite missing'); });
        await rt.initialize();
        assert.ok(out.warnings.some((w) => w.includes('Memory service not available')));
        assert.ok(out.warnings.some((w) => w.includes('Screen streaming not available')));
        assert.equal(rt.isScreenStreaming(), false);
        assert.equal(rt.isCameraStreaming(), false);
        assert.equal(rt.isMaterialManagerRunning(), false);
        assert.equal(rt.getHttpUrl(), null);
        assert.ok(stubs.requested.every((r) => r === '@ausm/core/clients' || r.startsWith('@ausm/device-macos-')));
    });

    test('initialize order: memory before detectors before pipeline', async () => {
        process.env.TASK_DETECTOR_PROJECT_ID = 'p';
        const rt = make();
        await rt.initialize();
        const idx = (needle: string) => out.logs.findIndex((l) => l.includes(needle));
        assert.ok(idx('Memory service started') >= 0);
        assert.ok(idx('Memory service started') < idx('Detectors loaded'));
        assert.ok(idx('Detectors loaded') < idx('Detector pipeline started'));
        assert.equal(stubs.memoryClients[0].started, 1);
        assert.equal(stubs.pipelineClients.length, 1);
        assert.ok(stubs.pipelineClients[0].detectors.some((d) => d.name === 'rapid-task'));
    });

    test('memory.frozen freezes memory on start', async () => {
        const rt = make({ memory: { frozen: true } });
        await rt.initialize();
        assert.equal(await rt.isMemoryFrozen(), true);
        assert.equal(await rt.unfreezeMemory(), true);
        assert.equal(await rt.isMemoryFrozen(), false);
    });

    test('detectors.enabled=false skips loading; pipeline starts with no detectors', async () => {
        process.env.TASK_DETECTOR_PROJECT_ID = 'p';
        const rt = make({ detectors: { enabled: false } });
        await rt.initialize();
        assert.deepEqual(stubs.pipelineClients[0].detectors, []);
    });

    test('materialChat.enabled makes an HTTP host failure fatal; http.enabled alone only warns', async () => {
        const rt1 = make({ http: { enabled: true, port: 1 } });
        (rt1 as any).constructor; // keep reference
        const hostProto = (await import('../src/runtime/http-host')).HttpHost.prototype as any;
        const realStart = hostProto.start;
        hostProto.start = async () => { throw new Error('port in use'); };
        try {
            await rt1.initialize();
            assert.ok(out.warnings.some((w) => w.includes('HTTP host failed to start: port in use')));
            assert.equal(rt1.getHttpUrl(), null);

            const rt2 = make({ materialChat: { enabled: true } });
            await assert.rejects(rt2.initialize(), /HTTP host failed to start: port in use/);
        } finally {
            hostProto.start = realStart;
        }
    });

    test('a fatal initialize failure can be retried', async () => {
        const hostProto = (await import('../src/runtime/http-host')).HttpHost.prototype as any;
        const realStart = hostProto.start;
        let attempts = 0;
        hostProto.start = async function () { attempts++; if (attempts === 1) throw new Error('port in use'); return 'http://127.0.0.1:1'; };
        try {
            const rt = make({ materialChat: { enabled: true } });
            await assert.rejects(rt.initialize());
            await rt.initialize();
            assert.equal(attempts, 2);
        } finally {
            hostProto.start = realStart;
        }
    });

    test('screenshot persistence: FINISHED events with inline data are saved, others skipped', async () => {
        const rt = make();
        await rt.initialize();
        (rt as any).screenshotDetector.running = true;
        rt.emitScreenshotEvent({ status: 'SCREENSHOT_STARTED' as any });
        rt.emitScreenshotEvent({ status: 'SCREENSHOT_FINISHED' as any });
        rt.emitScreenshotEvent({ status: 'SCREENSHOT_FINISHED' as any, eventID: 'id with spaces/../x', imageData: { dataBase64: 'QQ==', width: 2, height: 3, mimeType: 'image/png' } as any });
        rt.emitScreenshotEvent({ status: 'SCREENSHOT_FINISHED' as any, imageData: { dataBase64: 'QQ==', width: 0, height: 3 } as any });
        const saved = stubs.memoryClients[0].screenshots;
        assert.equal(saved.length, 1);
        assert.equal(saved[0].screenshotId, 'id_with_spaces____x');
        assert.equal(saved[0].mimeType, 'image/png');
    });

    test('shutdown is idempotent, safe before initialize, and cleans up the pipeline and memory', async () => {
        const fresh = make();
        assert.doesNotThrow(() => { fresh.shutdown(); fresh.shutdown(); });

        process.env.TASK_DETECTOR_PROJECT_ID = 'p';
        const rt = make();
        await rt.initialize();
        rt.shutdown();
        rt.shutdown();
        assert.equal(stubs.pipelineClients[0].cleanedUp, 1);
        assert.equal(stubs.memoryClients[0].stopped, 1);
        assert.equal((rt as any).detectorPipelineClient, null);
        assert.equal((rt as any).detectorPipelineWarmupTimer, null);
    });

    test('shutdown during initialize stops the remaining startup and leaks nothing', async () => {
        process.env.TASK_DETECTOR_PROJECT_ID = 'p';
        let release!: () => void;
        stubs.nextMemory((m) => { m.startDelay = new Promise<void>((r) => { release = r; }); });
        const rt = make();
        const init = rt.initialize();
        await new Promise((r) => setImmediate(r));
        rt.shutdown();
        release();
        await init;
        assert.equal(stubs.pipelineClients.length, 0, 'pipeline not started after shutdown');
        assert.equal(stubs.memoryClients[0].stopped, 1, 'memory client started late is stopped');
        assert.equal((rt as any).memoryClient, null);
    });

    test('calling initialize twice concurrently initializes once', async () => {
        process.env.TASK_DETECTOR_PROJECT_ID = 'p';
        const rt = make();
        await Promise.all([rt.initialize(), rt.initialize()]);
        await rt.initialize();
        assert.equal(stubs.memoryClients.length, 1);
        assert.equal(stubs.pipelineClients.length, 1);
    });
});

// ── Query methods & subscriptions ───────────────────────────────────────────

describe('query methods and subscriptions', () => {
    test('stub query methods return empty values before initialize', async () => {
        const rt = make();
        assert.equal(rt.getImmediateContext({} as any), null);
        assert.deepEqual(rt.getRelevantMaterials({} as any), []);
        assert.deepEqual(rt.getCoveredMaterials(null), []);
        assert.equal(rt.getBounds(null, ''), null);
        const img = rt.getScreenshotImageData(null, null);
        assert.equal(img.width, 0);
        assert.equal(img.data.length, 0);
        assert.deepEqual(rt.getActiveMaterialWindows(), []);
        assert.deepEqual(await rt.getMaterials(), []);
        assert.equal(await rt.getMaterialLatestFrame('x'), null);
        assert.deepEqual(await rt.getMaterialFrames('x'), []);
        assert.equal(await rt.getMaterialContent('x'), null);
        assert.deepEqual(await rt.getScreenshots(), []);
        assert.equal(await rt.getScreenshot('x'), null);
        assert.deepEqual(await rt.getMaterialWeights(), {});
        assert.equal(await rt.freezeMemory(), false);
        assert.equal(await rt.unfreezeMemory(), false);
        assert.equal(await rt.isMemoryFrozen(), false);
        assert.deepEqual(await rt.getScreenDisplays(), []);
        assert.equal(await rt.captureLatestScreenFrame('d'), null);
        assert.deepEqual(await rt.getCameraDevices(), []);
        assert.equal(await rt.captureLatestCameraFrame('d'), null);
        assert.equal(rt.getScreenStreamingService(), null);
        assert.equal(rt.getCameraStreamingService(), null);
        assert.equal(rt.getHttpUrl(), null);
    });

    test('screenshot and weight queries go through memory; memory errors become empty values', async () => {
        const rt = make();
        await rt.initialize();
        assert.deepEqual(await rt.getScreenshots(), [{ id: 's1' }]);
        assert.equal(await rt.getScreenshot('s1'), null, 'error → null');
        assert.deepEqual(await rt.getMaterialWeights(), { m1: 0.5 });
    });

    test('every subscription method exists with the documented name', () => {
        const rt = make();
        for (const name of [
            'onTextSelectionEvent', 'onScreenshotEvent', 'onCopyPasteEvent', 'onApplicationSwitchEvent', 'onSpaceChangeEvent',
            'subscribeToTextInputEvent', 'onCursorPlusPlusEvent', 'onDetectorEvent', 'onTaskEvent', 'onMaterialEvent', 'onMaterialFrameEvent',
        ]) {
            assert.equal(typeof (rt as any)[name], 'function', name);
        }
    });

    test('emit* before initialize: detector/task emit immediately, sensor events wait for start', () => {
        const rt = make();
        const got: string[] = [];
        rt.onDetectorEvent(() => got.push('detector'));
        rt.onTaskEvent(() => got.push('task'));
        rt.onTextSelectionEvent(() => got.push('selection'));
        rt.emitDetectorEvent({ detectorName: 'x' });
        rt.emitTaskEvent({ taskLabel: 'y' });
        rt.emitTextSelectionEvent({ selectedText: 'z' });
        assert.deepEqual(got, ['detector', 'task']);
    });

    test('emitted events have defaults filled in and are delivered to every subscriber in order', () => {
        const rt = make();
        const got: Array<[number, unknown]> = [];
        rt.onTaskEvent((e) => got.push([1, e.status]));
        rt.onTaskEvent((e) => got.push([2, e.taskId]));
        rt.emitTaskEvent({ status: TaskStatus.UPDATED });
        assert.deepEqual(got, [[1, TaskStatus.UPDATED], [2, null]]);
    });

    test('a throwing subscriber does not prevent later subscribers or throw into the emitter', () => {
        const rt = make();
        const got: string[] = [];
        rt.onTaskEvent(() => { throw new Error('boom'); });
        rt.onTaskEvent(() => got.push('ok'));
        rt.onDetectorEvent(() => { throw new Error('boom'); });
        rt.onDetectorEvent(() => got.push('ok2'));
        assert.doesNotThrow(() => rt.emitTaskEvent({}));
        assert.doesNotThrow(() => rt.emitDetectorEvent({}));
        assert.deepEqual(got, ['ok', 'ok2']);
    });

    test('the default singleton exists and is not started at import', () => {
        assert.ok(ausmRuntime instanceof AUSMRuntime);
        assert.equal(ausmRuntime.isScreenStreaming(), false);
        assert.equal((ausmRuntime as any).frequencyMonitor.timer, null);
    });
});
