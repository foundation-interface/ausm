/**
 * Default Electron preload: expose `window.ausm` and nothing else.
 * Point BrowserWindow at `getAUSMPreloadPath()`.
 *
 * To add host APIs, do not use this file. Write your own preload:
 *
 *   import { exposeAUSM } from '@ausm/bridge/preload-api';
 *   import { contextBridge, ipcRenderer } from 'electron';
 *
 *   exposeAUSM({
 *     myInvoke: () => ipcRenderer.invoke('my:channel'),
 *   });
 *   contextBridge.exposeInMainWorld('myApp', { … });
 */
import { exposeAUSM } from './preload-api';

exposeAUSM();
