import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { TaskTracker, observationFromDetectorResult, type TaskObservation } from '../src/detectors/TaskTracker';
import { TaskStatus, type TaskEvent } from '../src/events/TaskEvent';

let tracker: TaskTracker;
let clock: number;

beforeEach(() => {
    tracker = new TaskTracker();
    clock = 1_700_000_000_000;
});

function obs(label: string, description = '', extra: Partial<TaskObservation> = {}): TaskObservation {
    clock += 1000;
    return { label, description, confidence: 0.8, timestamp: clock, ...extra };
}

const statuses = (events: TaskEvent[]) => events.map((e) => e.status);

describe('TaskTracker.apply — inferred actions', () => {
    test('first observation begins a task', () => {
        const ev = tracker.apply(obs('Writing email', 'Reply to Alice'));
        assert.deepEqual(statuses(ev), [TaskStatus.DETECTED]);
        assert.match(ev[0].taskId!, /^task_[0-9a-f-]{36}$/);
        assert.equal(ev[0].taskLabel, 'Writing email');
        assert.equal(ev[0].taskDescription, 'Reply to Alice');
        assert.equal(ev[0].detectorName, 'rapid-task');
        assert.equal(ev[0].kind, 'task');
    });

    test('same label and description continues the same task (UPDATED, same id)', () => {
        const [a] = tracker.apply(obs('Writing email', 'Reply to Alice'));
        const ev = tracker.apply(obs('Writing email', 'Reply to Alice'));
        assert.deepEqual(statuses(ev), [TaskStatus.UPDATED]);
        assert.equal(ev[0].taskId, a.taskId);
    });

    test('same work with a changed description updates in place', () => {
        const [a] = tracker.apply(obs('Editing detector pipeline', 'fix tests'));
        const ev = tracker.apply(obs('Editing detector pipeline', 'add docs'));
        assert.deepEqual(statuses(ev), [TaskStatus.UPDATED]);
        assert.equal(ev[0].taskId, a.taskId);
        assert.equal(ev[0].taskDescription, 'add docs');
    });

    test('different work switches: COMPLETED for the old task, DETECTED for the new', () => {
        const [a] = tracker.apply(obs('Writing email', 'Reply to Alice'));
        const ev = tracker.apply(obs('Watching YouTube', 'Cooking video'));
        assert.deepEqual(statuses(ev), [TaskStatus.COMPLETED, TaskStatus.DETECTED]);
        assert.equal(ev[0].taskId, a.taskId);
        assert.equal(ev[0].taskLabel, 'Writing email');
        assert.notEqual(ev[1].taskId, a.taskId);
    });

    test('empty or whitespace label produces nothing and keeps state', () => {
        const [a] = tracker.apply(obs('Reading docs', 'API'));
        assert.deepEqual(tracker.apply(obs('', 'x')), []);
        assert.deepEqual(tracker.apply(obs('   ', 'x')), []);
        assert.equal(tracker.apply(obs('Reading docs', 'API'))[0].taskId, a.taskId);
    });

    test('empty description falls back to the label', () => {
        const [a] = tracker.apply(obs('Reading docs', '   '));
        assert.equal(a.taskDescription, 'Reading docs');
    });

    test('labels and descriptions are trimmed', () => {
        const [a] = tracker.apply(obs('  Reading docs  ', '  API  '));
        assert.equal(a.taskLabel, 'Reading docs');
        assert.equal(a.taskDescription, 'API');
    });

    test('flip-flopping A,B,A,B yields a fresh task each time with matching completions', () => {
        const all: TaskEvent[] = [];
        for (const [l, d] of [['Writing email', 'Alice'], ['Watching YouTube', 'Cats'], ['Writing email', 'Alice'], ['Watching YouTube', 'Cats']]) {
            all.push(...tracker.apply(obs(l, d)));
        }
        const detected = all.filter((e) => e.status === TaskStatus.DETECTED);
        const completed = all.filter((e) => e.status === TaskStatus.COMPLETED);
        assert.equal(detected.length, 4);
        assert.equal(completed.length, 3);
        assert.equal(new Set(detected.map((e) => e.taskId)).size, 4);
        completed.forEach((c, i) => assert.equal(c.taskId, detected[i].taskId));
    });

    test('rapid alternation with the same label but unrelated descriptions keeps switching', () => {
        const ids = new Set<string>();
        for (let i = 0; i < 6; i++) {
            const ev = tracker.apply(obs('Browsing', i % 2 ? 'zebra yak walrus' : 'apple banana cherry'));
            ev.filter((e) => e.status === TaskStatus.DETECTED).forEach((e) => ids.add(e.taskId!));
        }
        // "Browsing" is a 1-token label; with unrelated descriptions, combined overlap 1/4 < 0.6.
        assert.equal(ids.size, 6);
    });
});

describe('TaskTracker.apply — similarity thresholds', () => {
    const LABEL10 = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';

    test('label overlap of exactly 0.7 counts as the same label', () => {
        const [a] = tracker.apply(obs(LABEL10, 'same description here'));
        const ev = tracker.apply(obs('alpha beta gamma delta epsilon zeta eta lambda omicron sigma', 'same description here'));
        assert.equal(ev[0].status, TaskStatus.UPDATED);
        assert.equal(ev[0].taskId, a.taskId);
    });

    test('label overlap of 0.6 is a different label', () => {
        tracker.apply(obs(LABEL10, 'same description here'));
        const ev = tracker.apply(obs('alpha beta gamma delta epsilon zeta lambda omicron sigma upsilon', 'same description here'));
        assert.deepEqual(statuses(ev), [TaskStatus.COMPLETED, TaskStatus.DETECTED]);
    });

    test('description overlap of exactly 0.6 continues; 0.4 switches (short label adds no tokens)', () => {
        const [a] = tracker.apply(obs('Go', 'apple banana cherry damson elder'));
        const cont = tracker.apply(obs('Go', 'apple banana cherry fig grape'));
        assert.equal(cont[0].status, TaskStatus.UPDATED);
        assert.equal(cont[0].taskId, a.taskId);
        const sw = tracker.apply(obs('Go', 'apple banana kiwi lemon mango'));
        assert.deepEqual(statuses(sw), [TaskStatus.COMPLETED, TaskStatus.DETECTED]);
    });

    test('overlap is measured against the shorter token set (subset label matches)', () => {
        const [a] = tracker.apply(obs('Writing email', 'Alice roadmap'));
        const ev = tracker.apply(obs('Writing email to Alice about roadmap', 'Alice roadmap'));
        assert.equal(ev[0].taskId, a.taskId);
    });

    test('case and punctuation differences do not matter', () => {
        const [a] = tracker.apply(obs('Writing E-mail!', 'Reply: Alice'));
        const ev = tracker.apply(obs('writing e mail', 'reply alice'));
        assert.equal(ev[0].taskId, a.taskId);
    });

    test('non-ASCII labels repeated verbatim stay one task', () => {
        for (const [l, d] of [['写代码', '调试检测器'], ['Écrire un courriel', 'Réponse à Élodie'], ['Читаю почту', 'Письмо от Анны']]) {
            const t = new TaskTracker();
            const [a] = t.apply(obs(l, d));
            const ev = t.apply(obs(l, d));
            assert.deepEqual(statuses(ev), [TaskStatus.UPDATED], l);
            assert.equal(ev[0].taskId, a.taskId, l);
        }
    });

    test('punctuation-only or emoji-only labels repeated verbatim stay one task', () => {
        for (const l of ['!!!', '🎵🎵', '—']) {
            const t = new TaskTracker();
            const [a] = t.apply(obs(l, l));
            const ev = t.apply(obs(l, l));
            assert.deepEqual(statuses(ev), [TaskStatus.UPDATED], l);
            assert.equal(ev[0].taskId, a.taskId, l);
        }
    });

    test('different non-ASCII labels still switch', () => {
        tracker.apply(obs('写代码', '调试检测器'));
        const ev = tracker.apply(obs('看视频', '烹饪节目'));
        assert.deepEqual(statuses(ev), [TaskStatus.COMPLETED, TaskStatus.DETECTED]);
    });
});

describe('TaskTracker.apply — explicit actions', () => {
    test('end completes the current task; end with no task is a no-op', () => {
        assert.deepEqual(tracker.apply(obs('X', 'y', { action: 'end' })), []);
        const [a] = tracker.apply(obs('Reading docs', 'API'));
        const ev = tracker.apply(obs('Anything', 'z', { action: 'end' }));
        assert.deepEqual(statuses(ev), [TaskStatus.COMPLETED]);
        assert.equal(ev[0].taskId, a.taskId);
        assert.equal(ev[0].taskLabel, 'Reading docs', 'completion reports the ended task, not the observation');
        assert.match(tracker.formatContext(), /No active task/);
    });

    test('aliases are case- and whitespace-insensitive', () => {
        for (const alias of ['complete', 'FINISH', ' End ']) {
            const t = new TaskTracker();
            t.apply(obs('A task', 'desc'));
            assert.deepEqual(statuses(t.apply(obs('A task', 'desc', { action: alias }))), [TaskStatus.COMPLETED], alias);
        }
    });

    test('begin/start/new/detect on the same work continue instead of restarting', () => {
        for (const alias of ['begin', 'start', 'new', 'detect', 'switch', 'replace']) {
            const t = new TaskTracker();
            const [a] = t.apply(obs('Reading docs', 'API'));
            const ev = t.apply(obs('Reading docs', 'API', { action: alias }));
            assert.deepEqual(statuses(ev), [TaskStatus.UPDATED], alias);
            assert.equal(ev[0].taskId, a.taskId, alias);
        }
    });

    test('begin on different work switches', () => {
        tracker.apply(obs('Reading docs', 'API'));
        assert.deepEqual(statuses(tracker.apply(obs('Gaming', 'Chess', { action: 'start' }))), [TaskStatus.COMPLETED, TaskStatus.DETECTED]);
    });

    test('continue/same/unchanged with no current task begins one', () => {
        for (const alias of ['continue', 'same', 'unchanged']) {
            const t = new TaskTracker();
            assert.deepEqual(statuses(t.apply(obs('A', 'b', { action: alias }))), [TaskStatus.DETECTED], alias);
        }
    });

    test('continue/update on different work become a switch', () => {
        for (const alias of ['continue', 'update', 'evolve', 'refresh']) {
            const t = new TaskTracker();
            t.apply(obs('Reading docs', 'API'));
            assert.deepEqual(statuses(t.apply(obs('Gaming', 'Chess', { action: alias }))), [TaskStatus.COMPLETED, TaskStatus.DETECTED], alias);
        }
    });

    test('update with no current task begins one', () => {
        assert.deepEqual(statuses(tracker.apply(obs('A', 'b', { action: 'update' }))), [TaskStatus.DETECTED]);
    });

    test('unknown, empty or null actions fall back to inference', () => {
        for (const action of ['dance', '', null, undefined]) {
            const t = new TaskTracker();
            const [a] = t.apply(obs('Reading docs', 'API', { action }));
            assert.equal(a.status, TaskStatus.DETECTED);
            assert.equal(t.apply(obs('Reading docs', 'API', { action }))[0].taskId, a.taskId);
        }
    });

    test('end followed by the same label starts a new task id', () => {
        const [a] = tracker.apply(obs('Reading docs', 'API'));
        tracker.apply(obs('Reading docs', 'API', { action: 'end' }));
        const [b] = tracker.apply(obs('Reading docs', 'API'));
        assert.equal(b.status, TaskStatus.DETECTED);
        assert.notEqual(b.taskId, a.taskId);
    });
});

describe('TaskTracker — event fields', () => {
    test('observation metadata is copied onto events', () => {
        const [e] = tracker.apply(obs('A', 'b', {
            confidence: 0.42, application: 'Editor', evidence: 'ev', detectorName: 'custom', rawModelResponse: 'raw',
            requestTimestamp: 10, responseTimestamp: 20, modelLatencyMs: 10,
        }));
        assert.equal(e.confidence, 0.42);
        assert.equal(e.application, 'Editor');
        assert.equal(e.evidence, 'ev');
        assert.equal(e.detectorName, 'custom');
        assert.equal(e.rawModelResponse, 'raw');
        assert.deepEqual([e.requestTimestamp, e.responseTimestamp, e.modelLatencyMs], [10, 20, 10]);
        assert.equal(e.timestamp, clock);
        assert.equal(e.parentTaskId, null);
        assert.equal(e.level, null);
    });

    test('timestamp 0 falls back to now', () => {
        const before = Date.now();
        const [e] = tracker.apply({ label: 'A', description: 'b', confidence: 1, timestamp: 0 });
        assert.ok(e.timestamp >= before);
    });

    test('continuing without an application keeps the previous one', () => {
        tracker.apply(obs('A task', 'desc', { application: 'Editor' }));
        const [e] = tracker.apply(obs('A task', 'desc', { application: null }));
        assert.equal(e.application, 'Editor');
    });

    test('on a switch, the COMPLETED event keeps the old task\'s application', () => {
        tracker.apply(obs('Writing code', 'detector', { application: 'Editor' }));
        const [done, started] = tracker.apply(obs('Watching video', 'cats', { application: 'Browser' }));
        assert.equal(done.status, TaskStatus.COMPLETED);
        assert.equal(done.application, 'Editor');
        assert.equal(started.application, 'Browser');
    });

    test('formatContext describes the current task and reset clears it', () => {
        assert.match(tracker.formatContext(), /^No active task/);
        const [e] = tracker.apply(obs('Reading docs', 'API reference'));
        const ctx = tracker.formatContext();
        assert.ok(ctx.includes('"Reading docs" — API reference'));
        assert.ok(ctx.includes(e.taskId!));
        assert.ok(ctx.includes(new Date(clock).toISOString()));
        tracker.reset();
        assert.match(tracker.formatContext(), /^No active task/);
        assert.equal(tracker.apply(obs('Reading docs', 'API reference'))[0].status, TaskStatus.DETECTED);
    });
});

describe('observationFromDetectorResult', () => {
    const base = { summary: '', evidence: 'App · window', confidence: 0.7, timestamp: 123 };

    test('"label: subject" summaries split on the first colon', () => {
        const o = observationFromDetectorResult({ ...base, summary: 'Reading docs: https://example.com/a:b' });
        assert.equal(o.label, 'Reading docs');
        assert.equal(o.description, 'https://example.com/a:b');
    });

    test('no colon: whole summary is the label, evidence the description', () => {
        const o = observationFromDetectorResult({ ...base, summary: 'Coding' });
        assert.equal(o.label, 'Coding');
        assert.equal(o.description, 'App · window');
    });

    test('no colon and no evidence: description falls back to the label', () => {
        const o = observationFromDetectorResult({ ...base, summary: 'Coding', evidence: '' });
        assert.equal(o.description, 'Coding');
    });

    test('JSON summaries supply label, description and action', () => {
        const o = observationFromDetectorResult({ ...base, summary: ' {"label":"L","description":"D","action":"end","extra":5} ' });
        assert.deepEqual([o.label, o.description, o.action], ['L', 'D', 'end']);
    });

    test('invalid JSON-looking summaries give an empty label (tracker ignores them)', () => {
        const o = observationFromDetectorResult({ ...base, summary: '{not json: x}' });
        assert.equal(o.label, '');
        assert.deepEqual(new TaskTracker().apply(o), []);
    });

    test('JSON with non-string label falls through to an empty label', () => {
        assert.equal(observationFromDetectorResult({ ...base, summary: '{"label":5}' }).label, '');
    });

    test('explicit task fields win over the summary', () => {
        const o = observationFromDetectorResult({
            ...base, summary: '{"label":"J","description":"JD","action":"begin"}', taskLabel: 'T', taskDescription: 'TD', taskAction: 'end',
        });
        assert.deepEqual([o.label, o.description, o.action], ['T', 'TD', 'end']);
    });

    test('blank task fields do not override the summary', () => {
        const o = observationFromDetectorResult({ ...base, summary: 'Reading: docs', taskLabel: '   ', taskDescription: '' });
        assert.equal(o.label, 'Reading');
        assert.equal(o.description, 'docs');
    });

    test('empty summary and no task fields yields an empty label', () => {
        assert.equal(observationFromDetectorResult(base).label, '');
        assert.equal(observationFromDetectorResult({ ...base, summary: ':only subject' }).label, '');
    });

    test('metadata mapping and null defaults', () => {
        const o = observationFromDetectorResult({ ...base, summary: 'A: b' });
        assert.equal(o.action, null);
        assert.equal(o.application, null);
        assert.equal(o.rawModelResponse, null);
        assert.equal(o.requestTimestamp, null);
        assert.equal(o.responseTimestamp, null);
        assert.equal(o.modelLatencyMs, null);
        assert.equal(o.confidence, 0.7);
        assert.equal(o.timestamp, 123);
        assert.equal(o.evidence, 'App · window');
        const full = observationFromDetectorResult({
            ...base, summary: 'A: b', application: 'App', detectorName: 'rapid-task', rawModelResponse: 'r',
            requestTimestamp: 1, responseTimestamp: 2, modelLatencyMs: 1,
        });
        assert.deepEqual([full.application, full.detectorName, full.rawModelResponse, full.requestTimestamp, full.responseTimestamp, full.modelLatencyMs], ['App', 'rapid-task', 'r', 1, 2, 1]);
    });
});
