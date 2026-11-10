/*
 * Preload (node --require) that redirects @huggingface/transformers to the
 * local fake for both require() and import(), so tests can never trigger a
 * model download.
 */
const Module = require('module');
const path = require('path');
const { pathToFileURL } = require('url');
const FAKE = path.join(__dirname, 'fake-transformers.mjs');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === '@huggingface/transformers') return FAKE;
    return origResolve.call(this, request, ...rest);
};
const hook = `
export async function resolve(specifier, context, next) {
  if (specifier === '@huggingface/transformers') return { url: ${JSON.stringify(pathToFileURL(FAKE).href)}, shortCircuit: true };
  return next(specifier, context);
}`;
Module.register('data:text/javascript,' + encodeURIComponent(hook));
