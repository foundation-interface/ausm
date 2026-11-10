#!/usr/bin/env node
/*
 * Fake frame_reader.py for FrameReader protocol tests.  Ignores its argv
 * (the real script path) and behaves according to FAKE_WORKER_MODE.
 * Never touches the screen: replies are synthetic.
 */
const readline = require('readline');
const fs = require('fs');
const mode = process.env.FAKE_WORKER_MODE || 'normal';
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
if (process.env.FAKE_WORKER_PIDFILE) fs.appendFileSync(process.env.FAKE_WORKER_PIDFILE, process.pid + '\n');

if (mode === 'exit-before-ready') process.exit(3);
if (mode === 'never-ready') { setInterval(() => {}, 1000); return; }
if (mode === 'stubborn') process.on('SIGTERM', () => {});

const readyDelay = Number(process.env.FAKE_WORKER_READY_DELAY || 0);
setTimeout(() => {
    out('this is not json');
    out({ type: 'ready' });
}, readyDelay);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const req = JSON.parse(line);
    const id = req.requestId;
    const delay = Number(process.env.FAKE_WORKER_REPLY_DELAY || 0);
    const reply = () => {
        switch (mode) {
            case 'crash-on-request': process.exit(1); break;
            case 'silent': break;
            case 'garbage':
                out('{{{');
                out('null');
                out('42');
                out({ requestId: 'unknown-id', ok: true });
                out({ requestId: id, ok: true, frameData: 12345, hash: 'h' });
                break;
            case 'bad-fields':
                out({ requestId: id, ok: true, hash: 7, width: 'wide', hammingDistance: 'far' });
                break;
            case 'error': out({ requestId: id, ok: false, error: 'No frame available for display x' }); break;
            case 'error-no-message': out({ requestId: id, ok: false }); break;
            default:
                if (req.cmd === 'crop') {
                    out({ requestId: id, ok: true, frameData: Buffer.from('jpeg:' + req.displayId).toString('base64'),
                          width: req.bounds.width, height: req.bounds.height, hash: 'abc',
                          hammingDistance: req.prevHash ? 3 : -1, frameTimestamp: 1234 });
                } else {
                    out({ requestId: id, ok: true, width: 9, height: 8, hash: 'def',
                          hammingDistance: req.prevHash ? 0 : -1 });
                }
        }
    };
    if (delay) setTimeout(reply, delay); else reply();
});
rl.on('close', () => {
    const lingering = Number(process.env.FAKE_WORKER_LINGER || 0);
    setTimeout(() => process.exit(0), lingering);
});
