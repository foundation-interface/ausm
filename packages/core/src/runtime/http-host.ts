/**
 * Spawns the Material Chat HTTP host (memory search + agent) as a
 * child of the runtime so better-sqlite3 stays out of Electron.
 *
 * Started from AUSMRuntime.initialize() when http/materialChat is enabled.
 * Do not start this process by hand in the product path.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface HttpHostOptions {
    enabled?: boolean;
    port?: number;
    dbPath?: string;
    nodePath?: string;
    materialChat?: {
        enabled?: boolean;
        dataDir?: string;
        /** Browser origins besides localhost and file:// allowed to call the host (e.g. 'app://my-app'). */
        allowedOrigins?: string[];
    };
}

export class HttpHost {
    private process: ChildProcess | null = null;
    private url: string | null = null;
    private options: HttpHostOptions;

    constructor(options: HttpHostOptions = {}) {
        this.options = options;
    }

    getUrl(): string | null {
        return this.url;
    }

    async start(): Promise<string> {
        if (this.url) return this.url;

        const port = this.options.port ?? 8788;
        const dbPath = this.options.dbPath ?? ':memory:';
        const nodePath = this.options.nodePath ?? resolveSystemNode();
        const { cwd, args } = resolveServer();

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            PATH: prependPath(process.env.PATH, path.dirname(nodePath)),
            AUSM_DB: dbPath,
            AUSM_PORT: String(port),
        };
        const nodePathExtra = collectNodePath(cwd);
        if (nodePathExtra) {
            env.NODE_PATH = [nodePathExtra, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
        }
        if (this.options.materialChat?.dataDir) {
            env.MATERIAL_CHAT_DATA_DIR = this.options.materialChat.dataDir;
        }
        if (this.options.materialChat?.allowedOrigins?.length) {
            env.MATERIAL_CHAT_ALLOWED_ORIGINS = this.options.materialChat.allowedOrigins.join(',');
        }

        console.log(`[AUSM] Starting HTTP host: ${nodePath} ${args.join(' ')} (cwd=${cwd})`);

        const child = spawn(nodePath, args, {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.process = child;

        const ready = waitForListen(child, port);
        child.on('error', (err) => {
            console.warn('[AUSM] HTTP host error:', err.message);
        });
        child.on('exit', (code) => {
            if (code && code !== 0) {
                console.warn(`[AUSM] HTTP host exited with code ${code}`);
            }
            // A previous child exiting late must not clear a newer one.
            if (this.process === child) {
                this.url = null;
                this.process = null;
            }
        });

        try {
            await ready;
        } catch (err) {
            // Do not leave an orphaned server behind when start() fails (e.g. listen timeout).
            if (this.process === child) this.process = null;
            if (child.pid !== undefined && child.exitCode === null && !child.killed) {
                child.kill('SIGTERM');
            }
            throw err;
        }
        this.url = `http://127.0.0.1:${port}`;
        console.log(`[AUSM] HTTP host listening on ${this.url} (db=${dbPath})`);
        return this.url;
    }

    async stop(): Promise<void> {
        const child = this.process;
        this.process = null;
        this.url = null;
        if (!child || child.killed) return;
        await new Promise<void>((resolve) => {
            const t = setTimeout(() => {
                child.kill('SIGKILL');
                resolve();
            }, 3000);
            child.once('exit', () => {
                clearTimeout(t);
                resolve();
            });
            child.kill('SIGTERM');
        });
    }
}

function resolveSystemNode(): string {
    if (process.env.npm_node_execpath && fs.existsSync(process.env.npm_node_execpath)) {
        return process.env.npm_node_execpath;
    }
    if (process.execPath && !/electron/i.test(process.execPath) && fs.existsSync(process.execPath)) {
        return process.execPath;
    }
    const candidates = [
        '/opt/homebrew/bin/node',
        '/usr/local/bin/node',
        '/usr/bin/node',
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return 'node';
}

function prependPath(existing: string | undefined, dir: string): string {
    const parts = (existing ?? '').split(path.delimiter).filter(Boolean);
    if (!parts.includes(dir)) parts.unshift(dir);
    return parts.join(path.delimiter);
}

function collectNodePath(fromDir: string): string {
    const dirs: string[] = [];
    let dir = fromDir;
    for (let i = 0; i < 6; i++) {
        const nm = path.join(dir, 'node_modules');
        if (fs.existsSync(nm)) dirs.push(nm);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return dirs.join(path.delimiter);
}

function resolveServer(): { cwd: string; args: string[] } {
    let pkgDir: string | null = null;
    try {
        const pkg = require.resolve('@ausm/material-chat/package.json');
        pkgDir = path.dirname(pkg);
    } catch {
        pkgDir = path.resolve(__dirname, '../../../material-chat');
    }

    const dist = path.join(pkgDir, 'dist', 'server.js');
    if (fs.existsSync(dist)) {
        return { cwd: pkgDir, args: [dist] };
    }
    const src = path.join(pkgDir, 'src', 'server.ts');
    if (fs.existsSync(src)) {
        return { cwd: pkgDir, args: ['--import', 'tsx', src] };
    }
    throw new Error(`material-chat server not found under ${pkgDir} (tried dist/server.js and src/server.ts)`);
}

function waitForListen(child: ChildProcess, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`HTTP host did not start on port ${port} within 15s`));
        }, 15000);

        const onData = (chunk: Buffer | string) => {
            const text = chunk.toString();
            process.stderr.write(text);
            if (text.includes('listening on')) {
                cleanup();
                resolve();
            }
        };
        const onExit = (code: number | null) => {
            cleanup();
            reject(new Error(`HTTP host exited before listen (code ${code})`));
        };
        // A spawn failure (e.g. ENOENT for nodePath) emits 'error' but never 'exit'.
        const onError = (err: Error) => {
            cleanup();
            reject(new Error(`HTTP host failed to spawn: ${err.message}`));
        };

        const cleanup = () => {
            clearTimeout(timeout);
            child.stderr?.off('data', onData);
            child.stdout?.off('data', onData);
            child.off('exit', onExit);
            child.off('error', onError);
        };

        child.stderr?.on('data', onData);
        child.stdout?.on('data', onData);
        child.once('exit', onExit);
        child.once('error', onError);
    });
}
