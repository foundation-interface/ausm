/**
 * @ausm/bridge
 * 
 * Electron bridge for forwarding AUSM runtime events to the renderer process.
 * 
 * Service clients have moved to @ausm/core/clients.
 */

// Electron Bridge
export { 
    setupAUSMElectronBridge, 
    setupAUSMIPCHandlers,
    getAUSMPreloadPath,
    AUSM_IPC_CHANNELS,
    AUSM_SCREENSHOT_SCHEME,
    AUSM_SCREENSHOT_SCHEME_PRIVILEGES,
    registerAUSMScreenshotScheme,
    serveAUSMScreenshotCache,
} from './electron-bridge';
export type { ElectronBridgeOptions, ElectronBridge, BridgeLoggingConfig } from './electron-bridge';
