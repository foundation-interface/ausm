/**
 * Test doubles shared by the device-macos TypeScript test suites.
 *
 * Nothing here launches a real AUSM helper: helpers are replaced by
 *   - FakeChild: an in-memory ChildProcess look-alike (for injected `spawn`), or
 *   - writeFakeHelper(): a tiny Node script the code under test spawns instead of the
 *     Swift binary (it only prints scripted lines; it never touches the system).
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';

/** In-memory stand-in for a spawned ChildProcess. */
export class FakeChild extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly stdin = new PassThrough();
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    pid: number | undefined = 4242;
    readonly signals: string[] = [];
    /** When false, kill() records the signal but the process keeps running. */
    diesOnSignal = true;

    constructor(readonly command = '', readonly args: string[] = []) {
        super();
    }

    kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
        this.signals.push(String(signal));
        if (this.diesOnSignal || signal === 'SIGKILL') {
            setImmediate(() => this.exit(null, String(signal) as NodeJS.Signals));
        }
        return true;
    }

    /** Write one line to stdout (a JSON value is serialized). */
    line(value: unknown): void {
        this.stdout.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\n');
    }

    /** Simulate process exit: 'exit', then stdio end, then 'close' (Node's order). */
    exit(code: number | null, signal: NodeJS.Signals | null = null): void {
        if (this.exitCode !== null || this.signalCode !== null) return;
        this.exitCode = code;
        this.signalCode = signal;
        this.emit('exit', code, signal);
        this.stdout.end();
        this.stderr.end();
        setImmediate(() => this.emit('close', code, signal));
    }

    /** Simulate a spawn failure (ENOENT/EACCES): 'error' then 'close', never 'exit'. */
    failSpawn(code = 'ENOENT'): void {
        this.pid = undefined;
        const err = Object.assign(new Error(`spawn fake ${code}`), { code });
        this.emit('error', err);
        this.stdout.end();
        this.stderr.end();
        setImmediate(() => this.emit('close', -2, null));
    }
}

/** A spawn() replacement recording every FakeChild it hands out. */
export function fakeSpawner() {
    const children: FakeChild[] = [];
    const spawn = ((command: string, args: string[]) => {
        const child = new FakeChild(command, args);
        children.push(child);
        return child;
    }) as unknown as (command: string, args: string[], options: object) => import('child_process').ChildProcess;
    return { spawn, children, get last(): FakeChild { return children[children.length - 1]; } };
}

/** Fresh private temp directory (short path: Unix socket paths are limited to 104 bytes). */
export function makeTempDir(prefix = 'ausm-t-'): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Write an executable Node script that stands in for a Swift helper. `body` is plain
 * JavaScript run with the current Node binary.
 */
export function writeFakeHelper(dir: string, name: string, body: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!${process.execPath}\n'use strict';\n${body}\n`, { mode: 0o755 });
    return file;
}

/** Fake-helper body: print `lines` (JSON-encoded unless string), then idle or exit. */
export function scriptedLines(lines: unknown[], opts: { exitCode?: number; argvFile?: string; delayMs?: number } = {}): string {
    const encoded = JSON.stringify(lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))));
    return `
${opts.argvFile ? `require('fs').writeFileSync(${JSON.stringify(opts.argvFile)}, JSON.stringify(process.argv.slice(2)));` : ''}
const lines = ${encoded};
setTimeout(() => {
  for (const l of lines) process.stdout.write(l + '\\n');
  ${opts.exitCode === undefined ? 'setInterval(() => {}, 1000);' : `process.stdout.end(() => process.exit(${opts.exitCode}));`}
}, ${opts.delayMs ?? 0});
`;
}

/** Resolve when `cond()` is truthy; reject after `timeoutMs`. */
export async function waitFor(cond: () => unknown, timeoutMs = 3000, what = 'condition'): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

export function nextEvent<T = unknown>(emitter: EventEmitter, event: string, timeoutMs = 3000): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            emitter.off(event, onEvent);
            reject(new Error(`Timed out waiting for '${event}'`));
        }, timeoutMs);
        const onEvent = (value: T) => {
            clearTimeout(timer);
            resolve(value);
        };
        emitter.once(event, onEvent);
    });
}

export const tick = () => new Promise<void>((r) => setImmediate(r));

/** Is a process with this pid still alive? */
export function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** Silence console.warn/error/log for the duration of `fn` (keeps test output free of noise). */
export async function quietConsole<T>(fn: () => Promise<T> | T): Promise<T> {
    const saved = { warn: console.warn, error: console.error, log: console.log };
    console.warn = console.error = console.log = () => {};
    try {
        return await fn();
    } finally {
        Object.assign(console, saved);
    }
}

/** Sample strings for content-agnostic round-trip checks (never printed). */
export const tricky = {
    empty: '',
    emoji: 'ok 👍🏽 family 👨‍👩‍👧‍👦 flag 🇯🇵',
    rtl: 'שלום עולם مرحبا بالعالم',
    cjk: '日本語のテキスト 中文 한국어',
    combining: 'e\u0301 n\u0303 Z\u0351\u0352',
    controls: 'tab\tnew\nline\r\n"quote" \\back\u0000nul',
    huge: 'x'.repeat(2 * 1024 * 1024),
};
