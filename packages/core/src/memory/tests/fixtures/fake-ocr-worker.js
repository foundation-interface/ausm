#!/usr/bin/env node
/*
 * Fake py/ocr_worker.py: the "image" is UTF-8 text and each of its lines is
 * returned as a recognized line.  Behaviour is selected with OCR_FAKE_MODE.
 * Never runs real OCR.
 */
const readline = require('readline');
const fs = require('fs');
const mode = process.env.OCR_FAKE_MODE || 'normal';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (process.env.OCR_FAKE_PIDFILE) fs.appendFileSync(process.env.OCR_FAKE_PIDFILE, process.pid + '\n');
if (mode === 'exit-before-ready') process.exit(2);
setTimeout(() => out({ type: 'ready' }), Number(process.env.OCR_FAKE_READY_DELAY || 0));
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const req = JSON.parse(line);
    const text = Buffer.from(req.imageData || '', 'base64').toString('utf8');
    const reply = () => {
        if (mode === 'crash') process.exit(1);
        if (mode === 'silent') return;
        if (text === 'FAIL') return out({ requestId: req.requestId, ok: false, error: 'bad frame' });
        if (mode === 'non-array') return out({ requestId: req.requestId, ok: true, lines: 'not an array' });
        if (mode === 'mixed') return out({ requestId: req.requestId, ok: true, lines: ['ok line', null, 42, { x: 1 }, 'another line'] });
        out({ requestId: req.requestId, ok: true, lines: text ? text.split('\n') : [] });
    };
    const d = Number(process.env.OCR_FAKE_DELAY || 0);
    if (d) setTimeout(reply, d); else reply();
});
rl.on('close', () => process.exit(0));
