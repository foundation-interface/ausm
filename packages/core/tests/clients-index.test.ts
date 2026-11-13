/**
 * '@ausm/core/clients' must load even when optional packages (the darwin-only
 * text-input helper, the detector pipeline) are not installed: only the client
 * that needs one fails, at construction time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';

const OPTIONAL = ['@ausm/device-macos-text-input', '@ausm/detector-pipeline'];

test('clients index loads without optional packages; the dependent clients fail on construction', () => {
    const M = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
    const original = M._load;
    M._load = function (request: string, parent: unknown, isMain: boolean) {
        if (OPTIONAL.includes(request) || request.startsWith('@ausm/device-macos-')) {
            throw new Error(`Cannot find module '${request}'`);
        }
        return original.call(this, request, parent, isMain);
    };
    try {
        const clients = require('../src/runtime/clients/index') as typeof import('../src/runtime/clients/index');
        assert.equal(typeof clients.createMemoryClient, 'function');
        assert.equal(typeof clients.createMaterialClient, 'function');
        assert.throws(() => new clients.TextInputClient(), /device-macos-text-input/);
        assert.throws(() => clients.createDetectorPipelineClient({}), /detector-pipeline/);
    } finally {
        M._load = original;
    }
});
