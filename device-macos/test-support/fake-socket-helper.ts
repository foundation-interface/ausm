/**
 * Fakes for the socket-based helpers (screen-stream, camera). No ScreenCaptureKit, no
 * camera: just Unix sockets in a private temp directory speaking the JSON protocol.
 */

import net from 'net';
import fs from 'fs';

export type CommandHandler = (cmd: Record<string, any>, socket: net.Socket) => unknown;

/**
 * In-process command server: one JSON request per connection (newline-terminated or
 * not), one reply. The handler returns an object to send (then the connection closes),
 * a string to send verbatim, or undefined to take over the socket itself.
 */
export async function startCommandServer(sockPath: string, handler: CommandHandler) {
    const received: Record<string, any>[] = [];
    const server = net.createServer((socket) => {
        let buf = '';
        let handled = false;
        socket.on('error', () => {});
        socket.on('data', (d) => {
            if (handled) return;
            buf += d.toString('utf8');
            let cmd: Record<string, any>;
            try {
                cmd = JSON.parse(buf.trim());
            } catch {
                return; // wait for more
            }
            handled = true;
            received.push(cmd);
            const reply = handler(cmd, socket);
            if (reply === undefined) return;
            socket.end(typeof reply === 'string' ? reply : JSON.stringify(reply));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(sockPath, resolve);
    });
    return {
        received,
        close: () => new Promise<void>((r) => server.close(() => r())),
    };
}

/** In-process notification server; `push` writes raw text to every connected client. */
export async function startNotifyServer(sockPath: string) {
    const clients = new Set<net.Socket>();
    let connections = 0;
    const server = net.createServer((s) => {
        connections++;
        clients.add(s);
        s.on('error', () => {});
        s.on('close', () => clients.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(sockPath, resolve);
    });
    return {
        get connections() { return connections; },
        get connected() { return clients.size; },
        push(text: string | Buffer) { for (const c of clients) c.write(text); },
        dropClients() { for (const c of clients) c.destroy(); },
        close: () => new Promise<void>((r) => { for (const c of clients) c.destroy(); server.close(() => r()); }),
    };
}

export interface SocketHelperScriptOptions {
    /** JSON-lines log of received commands (for assertions). */
    commandLog: string;
    /** Extra reply fields per command name. */
    replies?: Record<string, unknown>;
    /** Delay before announcing readiness (ms). */
    readyDelayMs?: number;
    /** Exit with this code instead of becoming ready. */
    exitBeforeReady?: number;
    /** Ignore the quit command (forces SIGTERM escalation). */
    ignoreQuit?: boolean;
    /** Ignore SIGTERM as well (forces SIGKILL escalation). */
    ignoreSigterm?: boolean;
    /** Write the ready marker one character at a time. */
    splitReadyMarker?: boolean;
    /** Notification lines sent to each notify client right after it connects. */
    notifications?: string[];
}

/** Body for writeFakeHelper(): a fake socket helper process. */
export function socketHelperScript(o: SocketHelperScriptOptions): string {
    return `
const net = require('net');
const fs = require('fs');
const sock = process.argv[process.argv.indexOf('--socket') + 1];
const replies = ${JSON.stringify(o.replies ?? {})};
let streaming = false;
${o.ignoreSigterm ? "process.on('SIGTERM', () => {});" : ''}
${o.exitBeforeReady !== undefined ? `process.stderr.write('starting\\n'); setTimeout(() => process.exit(${o.exitBeforeReady}), 50);` : `
const log = (c) => fs.appendFileSync(${JSON.stringify(o.commandLog)}, JSON.stringify(c) + '\\n');
const server = net.createServer((s) => {
  let buf = '';
  s.on('error', () => {});
  s.on('data', (d) => {
    buf += d;
    let cmd; try { cmd = JSON.parse(buf.trim()); } catch { return; }
    buf = '\\u0000';
    log(cmd);
    let r = { success: true };
    if (cmd.command === 'start') streaming = true;
    if (cmd.command === 'stop') streaming = false;
    if (cmd.command === 'status') r.streaming = streaming;
    Object.assign(r, replies[cmd.command] || {});
    s.end(JSON.stringify(r));
    if (cmd.command === 'quit' && !${!!o.ignoreQuit}) setTimeout(() => process.exit(0), 20);
  });
});
const notify = net.createServer((s) => {
  s.on('error', () => {});
  for (const l of ${JSON.stringify(o.notifications ?? [])}) s.write(l + '\\n');
});
server.listen(sock, () => notify.listen(sock + '.notify', () => {
  setTimeout(() => {
    const marker = 'NSLog: Ready and waiting for commands\\n';
    ${o.splitReadyMarker ? "let i = 0; const t = setInterval(() => { process.stderr.write(marker[i++]); if (i >= marker.length) clearInterval(t); }, 2);" : 'process.stderr.write(marker);'}
  }, ${o.readyDelayMs ?? 0});
}));
`}
setInterval(() => {}, 1000);
`;
}

export function readCommandLog(file: string): Record<string, any>[] {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
