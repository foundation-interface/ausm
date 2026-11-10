/*
 * Test entry point for the memory service: fake transformers (no model
 * download) + tsx, then the real src/memory/service.ts.
 */
require('./register-fake-transformers.cjs');
require('tsx/cjs');
require('../../service.ts');
