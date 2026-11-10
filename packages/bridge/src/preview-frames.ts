import { intervalMsForFps } from './stream-fps-ipc';

/** Preview encode — lower than archival so IPC + decode stay cheap. */
export function previewJpegQuality(fps: number): number {
    if (fps >= 45) return 0.4;
    if (fps >= 24) return 0.5;
    return 0.6;
}

export function scheduleNextTick(
    tick: () => void,
    startedAt: number,
    fps: number,
): ReturnType<typeof setTimeout> {
    const elapsed = Date.now() - startedAt;
    return setTimeout(tick, Math.max(0, intervalMsForFps(fps) - elapsed));
}

export function sendPreviewFrame(
    subscribers: Set<Electron.WebContents>,
    channel: string,
    payload: Record<string, unknown>,
): void {
    for (const wc of subscribers) {
        if (!wc.isDestroyed()) {
            wc.send(channel, payload);
        }
    }
}
