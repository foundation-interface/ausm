/**
 * Helper Client - talks to the native `screen-capture-helper` process.
 *
 * The helper (Swift, ScreenCaptureKit) runs its own CFRunLoop, which is what
 * makes ScreenCaptureKit reliable. This client spawns it (or attaches to an
 * already-running one), sends one JSON command per Unix-socket connection on
 * `socketPath`, and listens for newline-delimited JSON notifications on
 * `${socketPath}.notify`. See README.md for the protocol.
 */

import { spawn, spawnSync, ChildProcess } from "child_process";
import { createConnection, Socket } from "net";
import { StringDecoder } from "string_decoder";
import * as path from "path";
import * as fs from "fs";
import { EventEmitter } from "events";

export interface DisplayInfo {
  id: string;
  name: string;
  /** Native pixel width */
  width: number;
  /** Native pixel height */
  height: number;
  isMain: boolean;
  isBuiltIn: boolean;
  /** Numeric CGDirectDisplayID */
  displayId?: number;
  /** Backing scale factor (e.g. 2.0 for Retina) */
  scaleFactor?: number;
  /** Refresh rate in Hz */
  refreshRate?: number;
  /** Logical-point origin X in the global desktop coordinate space */
  originX?: number;
  /** Logical-point origin Y in the global desktop coordinate space */
  originY?: number;
  /** Logical-point width (CSS pixels) */
  logicalWidth?: number;
  /** Logical-point height (CSS pixels) */
  logicalHeight?: number;
}

/** Result of captureLatestFrame() — JPEG-encoded frame from the live capture stream. */
export interface LatestFrameResult {
  /** JPEG-encoded image data */
  data: Buffer;
  displayId: string;
  width: number;
  height: number;
  jpegSize: number;
  /** Presentation timestamp in microseconds on the host clock (time since boot). */
  timestamp: number;
  /** Monotonic frame number assigned by the capture pipeline. */
  frameNumber: number;
}

export interface StreamConfig {
  /** Default FPS for all displays (1-120). */
  fps?: number;
  /** Capture height in pixels, width scales proportionally (0 = native). */
  targetHeight?: number;
  /** Also record each display to `${outputDirectory}/display-<id>-<yyyyMMdd-HHmmss-SSS>.mp4` (one file per capture segment). */
  enableRecording?: boolean;
  outputDirectory?: string;
  /** Base POSIX shm name, e.g. "/ausm-frames" (max 22 bytes). Empty disables SHM output. */
  sharedMemoryName?: string;
  /** Ring-buffer slots per display (1-120). SHM output requires > 0. */
  frameCount?: number;
  /** Command socket path (default "/tmp/ausm-frames.sock"). */
  socketPath?: string;
  /** Echo helper stderr and client diagnostics to the console (default: false). */
  debug?: boolean;
}

export interface DisplayConfig {
  fps?: number;
  targetHeight?: number;
}

export interface DisplayChangeEvent {
  type: "display_change";
  displayId: string;
  event: "added" | "removed" | "reconfigured";
}

/** Error pushed by the helper, e.g. Screen Recording permission revoked mid-capture. */
export interface HelperErrorEvent {
  type: "error";
  /** "permission_denied" | "no_displays" | "stream_failed" | "shm_failed" | ... */
  code: string;
  error: string;
  displayId?: string;
}

/** Result of a single-window capture via CGWindowListCreateImage. */
export interface WindowCaptureResult {
  /** JPEG-encoded image data */
  data: Buffer;
  /** Image width in pixels */
  width: number;
  /** Image height in pixels */
  height: number;
  /** JPEG data size in bytes */
  jpegSize: number;
  /** The CGWindowID that was captured */
  windowId: number;
}

interface CommandResponse {
  success?: boolean;
  error?: string;
  /** Machine-readable error code (see HelperErrorEvent.code). */
  code?: string;
  capturing?: boolean;
  streaming?: boolean;
  permission?: boolean;
  rejected?: string[];
  displays?: DisplayInfo[];
  displayConfigs?: Record<string, DisplayConfig>;
  // captureWindow / captureLatestFrame response fields
  data?: string;       // base64 JPEG
  width?: number;
  height?: number;
  jpegSize?: number;
  windowId?: number;
  displayId?: string;
  timestamp?: number;
  frameNumber?: number;
}

/** Error thrown for a failed helper command; `code` mirrors the helper's error code. */
export class HelperCommandError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "HelperCommandError";
  }
}

const DEFAULT_SOCKET_PATH = "/tmp/ausm-frames.sock";
/** Upper bound on a single command response (base64 JPEGs of large displays). */
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
const STARTUP_TIMEOUT_MS = 10_000;
const READY_MARKER = "Ready and waiting";

export class HelperClient extends EventEmitter {
  private helperProcess: ChildProcess | null = null;
  private socketPath: string;
  private notifySocketPath: string;
  private helperPath: string;
  private ready: boolean = false;
  private notifySocket: Socket | null = null;
  private notifyReconnectTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  private debug: boolean;

  // Track current state for safe reconfiguration
  private currentConfig: StreamConfig | null = null;
  private activeDisplayIds: string[] = [];

  constructor(socketPath?: string, debug = false) {
    super();
    this.socketPath = socketPath || DEFAULT_SOCKET_PATH;
    this.notifySocketPath = this.socketPath + ".notify";
    this.debug = debug;

    // Resolve the helper binary from the package root (directory containing
    // package.json) so this works from source (src/) and from dist/.
    const packageRoot = HelperClient.findPackageRoot(__dirname);
    this.helperPath = path.join(packageRoot, "build", "screen-capture-helper");
  }

  /**
   * Walk up from startDir to find the nearest directory containing package.json.
   */
  private static findPackageRoot(startDir: string): string {
    let dir = path.resolve(startDir);
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, "package.json"))) {
        return dir;
      }
      dir = path.dirname(dir);
    }
    return path.join(startDir, "..");
  }

  /**
   * Connect to an already-running helper process via its socket.
   *
   * Use this when the helper was started by another process (e.g. the
   * AUSM runtime) and you only need to send commands over the socket.
   * Unlike `start()`, this does NOT spawn a new helper subprocess.
   *
   * Verifies the socket is reachable by sending a quick status command.
   */
  async connectToExisting(): Promise<void> {
    if (this.ready) return;

    try {
      const response = await this.request({ command: "status" }, 5000);
      if (response.success === false) {
        throw new Error(response.error || "Helper returned error");
      }
    } catch (err) {
      throw new Error(`Cannot connect to helper at ${this.socketPath}: ${(err as Error).message}`);
    }

    this.ready = true;
    this.log(`Connected to existing helper at ${this.socketPath}`);
  }

  /**
   * Start the helper process. Resolves once it reports readiness; rejects
   * (and kills the process) if it exits or does not become ready in time.
   */
  async start(): Promise<void> {
    if (this.helperProcess) {
      throw new Error("Helper already running");
    }

    if (process.platform !== "darwin") {
      throw new Error("screen-capture-helper is only available on macOS");
    }
    if (!fs.existsSync(this.helperPath)) {
      throw new Error(
        `Helper binary not found at ${this.helperPath}. Run 'npm run build:helper' in @ausm/device-macos-screen-stream.`
      );
    }

    this.stopping = false;
    this.cleanupStaleResources();

    return new Promise((resolve, reject) => {
      // stdin is a pipe: the helper exits when it reads EOF, i.e. when this
      // process dies, so helpers are never orphaned.
      const proc = spawn(this.helperPath, ["--socket", this.socketPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.helperProcess = proc;

      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        if (err) {
          try { proc.kill("SIGKILL"); } catch { /* already gone */ }
          reject(err);
        } else {
          resolve();
        }
      };

      const startupTimer = setTimeout(() => {
        finish(new Error(`Helper did not become ready within ${STARTUP_TIMEOUT_MS} ms`));
      }, STARTUP_TIMEOUT_MS);

      // NSLog writes to stderr. Read line by line so the readiness marker is
      // detected even when split across chunks. Streams are always drained
      // so the helper never blocks on a full pipe.
      const onLines = (stream: NodeJS.ReadableStream | null) => {
        if (!stream) return;
        const decoder = new StringDecoder("utf8");
        let pending = "";
        stream.on("data", (chunk: Buffer) => {
          pending += decoder.write(chunk);
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          if (pending.length > 64 * 1024) pending = "";
          for (const line of lines) {
            if (this.debug && line.trim()) console.log("[Helper]", line.trim());
            if (!this.ready && line.includes(READY_MARKER)) {
              if (this.stopping) {
                // stop() was called while starting up: do not come up half-alive.
                finish(new Error("Helper stopped during startup"));
                return;
              }
              this.ready = true;
              this.connectNotifications();
              finish();
            }
          }
        });
      };
      onLines(proc.stdout);
      onLines(proc.stderr);

      proc.on("exit", (code, signal) => {
        this.log(`Process exited (code=${code}, signal=${signal})`);
        if (this.helperProcess === proc) {
          this.helperProcess = null;
          this.ready = false;
          this.closeNotifications();
        }
        finish(new Error(`Helper exited during startup (code=${code}, signal=${signal})`));
        this.emit("exit", { code, signal, expected: this.stopping });
      });

      proc.on("error", (err) => {
        if (this.helperProcess === proc) {
          this.helperProcess = null;
          this.ready = false;
        }
        finish(err);
      });
    });
  }

  /**
   * Connect to the notification socket for push events. Reconnects while
   * the helper is alive.
   */
  private connectNotifications(delayMs = 200): void {
    if (this.notifyReconnectTimer) clearTimeout(this.notifyReconnectTimer);
    this.notifyReconnectTimer = setTimeout(() => {
      this.notifyReconnectTimer = null;
      if (!this.ready || this.stopping || this.notifySocket) return;

      const sock = createConnection(this.notifySocketPath);
      this.notifySocket = sock;

      const decoder = new StringDecoder("utf8");
      let buffer = "";
      const MAX_BUFFER = 512_000;

      sock.on("data", (data: Buffer) => {
        buffer += decoder.write(data);
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        if (buffer.length > MAX_BUFFER) buffer = "";  // malformed: no newline

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            this.log(`Invalid notification: ${line.slice(0, 200)}`);
            continue;
          }
          try {
            this.handleNotification(event);
          } catch (err) {
            // A throwing listener must not escape the socket handler (uncaught in the host).
            this.log(`Notification listener threw: ${(err as Error).message}`);
          }
        }
      });

      // Notifications are optional; never surface socket errors as 'error' events.
      sock.on("error", (err) => this.log(`Notification socket error: ${err.message}`));

      sock.on("close", () => {
        if (this.notifySocket === sock) this.notifySocket = null;
        if (this.ready && !this.stopping && this.helperProcess) {
          this.connectNotifications(1000);
        }
      });
    }, delayMs);
  }

  private closeNotifications(): void {
    if (this.notifyReconnectTimer) {
      clearTimeout(this.notifyReconnectTimer);
      this.notifyReconnectTimer = null;
    }
    if (this.notifySocket) {
      this.notifySocket.removeAllListeners();
      this.notifySocket.destroy();
      this.notifySocket = null;
    }
  }

  /**
   * Handle incoming notifications from helper
   */
  private handleNotification(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const event = raw as Record<string, unknown>;
    switch (event.type) {
      case "display_change": {
        if (typeof event.displayId !== "string" || typeof event.event !== "string") return;
        const displayEvent: DisplayChangeEvent = {
          type: "display_change",
          displayId: event.displayId,
          event: event.event as DisplayChangeEvent["event"],
        };
        this.emit("displayChange", displayEvent);
        break;
      }
      case "error": {
        const errorEvent: HelperErrorEvent = {
          type: "error",
          code: typeof event.code === "string" ? event.code : "unknown",
          error: typeof event.error === "string" ? event.error : "Unknown helper error",
          ...(typeof event.displayId === "string" ? { displayId: event.displayId } : {}),
        };
        // Not emitted as "error": an unhandled EventEmitter "error" would throw.
        this.emit("helperError", errorEvent);
        break;
      }
      case "capture_started":
      case "capture_stopped":
        this.emit(event.type === "capture_started" ? "captureStarted" : "captureStopped");
        break;
      default:
        break;
    }
  }

  /**
   * Clean up stale resources from previous runs: helpers for *our* socket
   * path owned by the current user, and leftover socket files.
   */
  private cleanupStaleResources(): void {
    try {
      const escaped = this.socketPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const args = ["-f", `screen-capture-helper --socket ${escaped}$`];
      if (typeof process.getuid === "function") args.unshift("-U", String(process.getuid()));
      const result = spawnSync("pgrep", args, { encoding: "utf-8", timeout: 5000 });

      const pids = (result.stdout || "")
        .trim()
        .split("\n")
        .map((p) => parseInt(p, 10))
        .filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid);

      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
          this.log(`Killed stale helper process ${pid}`);
        } catch { /* already exited */ }
      }
      if (pids.length > 0) {
        spawnSync("sleep", ["0.5"]);
        for (const pid of pids) {
          try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
        }
      }
    } catch {
      // pgrep unavailable - fine
    }

    for (const sockPath of [this.socketPath, this.notifySocketPath]) {
      try {
        if (fs.lstatSync(sockPath).isSocket()) {
          fs.unlinkSync(sockPath);
          this.log(`Removed stale socket: ${sockPath}`);
        }
      } catch { /* missing or not ours */ }
    }
  }

  /**
   * Stop the helper process: graceful "quit", then SIGTERM, then SIGKILL.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.closeNotifications();

    const proc = this.helperProcess;
    if (!proc) {
      this.ready = false;
      return;
    }

    const exited = new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      proc.once("exit", () => resolve());
    });
    const waitExit = (ms: number) =>
      Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

    try {
      await this.sendCommand({ command: "quit" }, 2000);
    } catch {
      // unresponsive - escalate below
    }

    if (!(await waitExit(3000))) {
      try { proc.kill("SIGTERM"); } catch { /* gone */ }
      if (!(await waitExit(2000))) {
        try { proc.kill("SIGKILL"); } catch { /* gone */ }
        await waitExit(1000);
      }
    }

    if (this.helperProcess === proc) this.helperProcess = null;
    this.ready = false;
  }

  /**
   * Check if helper is running
   */
  isRunning(): boolean {
    return this.ready && this.helperProcess !== null;
  }

  /**
   * Send a command to the helper and get a response (default timeout 10 s).
   */
  private sendCommand(command: object, timeoutMs = 10000): Promise<CommandResponse> {
    // Allowed when we spawned the process and it's ready, or after connectToExisting().
    if (!this.ready) {
      return Promise.reject(new Error("Helper process is not running"));
    }
    return this.request(command, timeoutMs);
  }

  /** One request/response over a fresh connection. */
  private request(command: object, timeoutMs: number): Promise<CommandResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      let size = 0;

      const socket = createConnection(this.socketPath);
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        fn();
      };

      socket.setTimeout(timeoutMs);
      socket.on("connect", () => {
        // Newline-terminated; the helper replies and closes the connection.
        socket.write(JSON.stringify(command) + "\n");
      });
      socket.on("data", (data: Buffer) => {
        size += data.length;
        if (size > MAX_RESPONSE_BYTES) {
          settle(() => reject(new Error("Helper response too large")));
          return;
        }
        chunks.push(data);
      });
      socket.on("end", () => {
        settle(() => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== "object") throw new Error("not an object");
            resolve(parsed as CommandResponse);
          } catch {
            reject(new Error(`Invalid response from helper: ${text.slice(0, 200)}`));
          }
        });
      });
      socket.on("close", () => settle(() => reject(new Error("Helper closed the connection without a response"))));
      socket.on("error", (err) => settle(() => reject(err)));
      socket.on("timeout", () => settle(() => reject(new Error(`Command timeout after ${timeoutMs} ms`))));
    });
  }

  private static check(response: CommandResponse, fallback: string): void {
    if (response.error || response.success === false) {
      throw new HelperCommandError(response.error ?? fallback, response.code);
    }
  }

  /**
   * Configure stream settings. Invalid values are ignored by the helper and
   * reported via the debug log.
   */
  async configure(config: StreamConfig): Promise<void> {
    const response = await this.sendCommand({ command: "configure", config });
    HelperClient.check(response, "configure failed");
    if (response.rejected?.length) {
      this.log(`Helper ignored invalid config keys: ${response.rejected.join(", ")}`);
    }
    this.currentConfig = { ...config };
  }

  /**
   * Start streaming for specified displays (or all if empty). Rejects with a
   * HelperCommandError (code "permission_denied") if Screen Recording
   * permission is missing.
   */
  async startStream(displayIds?: string[]): Promise<void> {
    const response = await this.sendCommand({ command: "start", displayIds: displayIds || [] }, 30000);
    HelperClient.check(response, "start failed");
    this.activeDisplayIds = displayIds || [];
  }

  /**
   * Stop streaming
   */
  async stopStream(): Promise<void> {
    const response = await this.sendCommand({ command: "stop" });
    HelperClient.check(response, "stop failed");
    // activeDisplayIds is kept so updateConfiguration can restart with the same displays
  }

  /**
   * Get streaming status
   */
  async isStreaming(): Promise<boolean> {
    const response = await this.sendCommand({ command: "status" });
    return Boolean(response.streaming ?? response.capturing);
  }

  /**
   * Get list of available displays
   */
  async getDisplays(): Promise<DisplayInfo[]> {
    const response = await this.sendCommand({ command: "displays" });
    HelperClient.check(response, "displays failed");
    return response.displays || [];
  }

  /**
   * Update stream configuration (e.g. FPS or resolution). If streaming, the
   * helper is stopped, reconfigured and restarted; shared memory segments are
   * recreated and readers receive capture_stopped / capture_started.
   */
  async updateConfiguration(config: Partial<StreamConfig>): Promise<void> {
    if (!this.currentConfig) {
      throw new Error("No configuration set. Call configure() first.");
    }

    const newConfig: StreamConfig = { ...this.currentConfig, ...config };
    if (JSON.stringify(newConfig) === JSON.stringify(this.currentConfig)) {
      return;
    }

    const wasStreaming = await this.isStreaming();
    if (wasStreaming) {
      await this.stopStream();
    }

    await this.configure(newConfig);

    if (wasStreaming) {
      await this.startStream(this.activeDisplayIds);
    }
  }

  /**
   * Configure settings for a specific display (e.g., per-display FPS)
   * If streaming, will restart the specific display's stream
   */
  async configureDisplay(displayId: string, config: DisplayConfig): Promise<void> {
    const response = await this.sendCommand({ command: "configureDisplay", displayId, config }, 30000);
    HelperClient.check(response, "configureDisplay failed");
  }

  /**
   * Get configuration for all displays
   */
  async getDisplayConfigs(): Promise<Record<string, DisplayConfig>> {
    const response = await this.sendCommand({ command: "getDisplayConfigs" });
    HelperClient.check(response, "getDisplayConfigs failed");
    return response.displayConfigs || {};
  }

  /**
   * Capture a single window by its CGWindowID.
   *
   * Uses CGWindowListCreateImage, which reads the window's backing store, so
   * it works even when the window is behind other windows.
   *
   * @param windowId    macOS CGWindowID
   * @param jpegQuality JPEG compression quality (0.0 – 1.0, default 0.85)
   * @param displayId   Optional display ID (e.g. "display-1") for proportional scaling
   */
  async captureWindow(
    windowId: number,
    jpegQuality: number = 0.85,
    displayId?: string,
  ): Promise<WindowCaptureResult> {
    const response = await this.sendCommand(
      { command: "captureWindow", windowId, jpegQuality, ...(displayId ? { displayId } : {}) },
      10_000,
    );
    HelperClient.check(response, `captureWindow failed for window ${windowId}`);
    if (!response.data) {
      throw new Error(`captureWindow returned no data for window ${windowId}`);
    }

    return {
      data: Buffer.from(response.data, "base64"),
      width: response.width ?? 0,
      height: response.height ?? 0,
      jpegSize: response.jpegSize ?? 0,
      windowId: response.windowId ?? windowId,
    };
  }

  /**
   * Capture the most recent frame for a display from the live capture stream,
   * JPEG-encoded by the helper.
   *
   * @param displayId   Display identifier (e.g. "display-1")
   * @param jpegQuality JPEG compression quality (0.0 – 1.0, default 0.7)
   * @throws if the helper has no frame yet for this display
   */
  async captureLatestFrame(
    displayId: string,
    jpegQuality: number = 0.7,
  ): Promise<LatestFrameResult> {
    const response = await this.sendCommand(
      { command: "captureLatestFrame", displayId, jpegQuality },
      5_000,
    );
    HelperClient.check(response, `captureLatestFrame failed for ${displayId}`);
    if (!response.data) {
      throw new Error(`captureLatestFrame returned no data for ${displayId}`);
    }

    return {
      data: Buffer.from(response.data, "base64"),
      displayId: response.displayId ?? displayId,
      width: response.width ?? 0,
      height: response.height ?? 0,
      jpegSize: response.jpegSize ?? 0,
      timestamp: response.timestamp ?? 0,
      frameNumber: response.frameNumber ?? 0,
    };
  }

  /**
   * Register listener for display change events. Returns an unsubscribe function.
   */
  onDisplayChange(callback: (event: DisplayChangeEvent) => void): () => void {
    this.on("displayChange", callback);
    return () => { this.off("displayChange", callback); };
  }

  /**
   * Register listener for helper-pushed errors (e.g. permission revoked).
   * Returns an unsubscribe function.
   */
  onHelperError(callback: (event: HelperErrorEvent) => void): () => void {
    this.on("helperError", callback);
    return () => { this.off("helperError", callback); };
  }

  private log(msg: string): void {
    if (this.debug) console.log(`[HelperClient] ${msg}`);
  }
}
