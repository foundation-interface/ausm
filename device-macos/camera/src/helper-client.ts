/**
 * Helper Client - Communicates with the native camera helper process.
 * The helper runs with a proper NSRunLoop so AVFoundation capture is reliable.
 *
 * Transport:
 *   - commands: one JSON request / one JSON response per connection on `socketPath`
 *   - notifications: newline-delimited JSON on `${socketPath}.notify`
 *   - frames: POSIX shared memory (see README), not touched by this client
 *
 * Events (EventEmitter):
 *   - "deviceChange" (DeviceChangeEvent)  camera plugged / unplugged
 *   - "captureError" (CaptureErrorEvent)  session failed or interrupted (e.g. camera taken by another app)
 *   - "exit" ({ code, signal })           helper exited unexpectedly (not via stop())
 */

import { spawn, spawnSync, ChildProcess } from "child_process";
import { createConnection, Socket } from "net";
import * as path from "path";
import * as fs from "fs";
import { EventEmitter } from "events";

export interface CameraDeviceInfo {
  id: string;
  name: string;
  position: "front" | "back" | "unspecified";
  active: boolean;
  manufacturer?: string;
}

/** Result of captureLatestFrame() — JPEG-encoded frame from the live capture stream. */
export interface LatestFrameResult {
  data: Buffer;
  deviceId: string;
  width: number;
  height: number;
  jpegSize: number;
  timestamp: number;
  frameNumber: number;
}

export interface StreamConfig {
  fps?: number;
  targetHeight?: number;
  sharedMemoryName?: string;
  frameCount?: number;
  socketPath?: string;
  deviceId?: string;
  debug?: boolean;
}

export interface DeviceConfig {
  fps?: number;
  targetHeight?: number;
}

export interface DeviceChangeEvent {
  type: "device_change";
  deviceId: string;
  event: "added" | "removed" | "reconfigured";
}

export interface CaptureErrorEvent {
  type: "capture_error";
  deviceId: string;
  error: string;
}

export interface HelperExitEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const READY_MARKER = "Ready and waiting";
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

interface CommandResponse {
  success?: boolean;
  error?: string;
  streaming?: boolean;
  devices?: CameraDeviceInfo[];
  deviceConfigs?: Record<string, DeviceConfig>;
  data?: string;
  width?: number;
  height?: number;
  jpegSize?: number;
  deviceId?: string;
  timestamp?: number;
  frameNumber?: number;
}

export class HelperClient extends EventEmitter {
  private helperProcess: ChildProcess | null = null;
  private socketPath: string;
  private notifySocketPath: string;
  private helperPath: string;
  private ready: boolean = false;
  private stopping = false;
  private notifySocket: Socket | null = null;

  private debug: boolean;

  private currentConfig: StreamConfig | null = null;
  private activeDeviceIds: string[] = [];

  constructor(socketPath?: string, debug = false) {
    super();
    this.socketPath = socketPath || "/tmp/ausm-camera.sock";
    this.notifySocketPath = this.socketPath + ".notify";
    this.debug = debug;

    const packageRoot = HelperClient.findPackageRoot(__dirname);
    this.helperPath = path.join(packageRoot, "build", "camera-helper");
  }

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

  async connectToExisting(): Promise<void> {
    if (this.ready) return;

    try {
      const response = await this.sendCommandDirect({ command: "status" });
      if (response.success === false) {
        throw new Error(response.error || "Helper returned error");
      }
    } catch (err) {
      throw new Error(`Cannot connect to helper at ${this.socketPath}: ${(err as Error).message}`);
    }

    this.ready = true;
    if (this.debug) console.log(`[CameraHelperClient] Connected to existing helper at ${this.socketPath}`);
  }

  private sendCommandDirect(command: object, timeoutMs = 5000): Promise<CommandResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) { settled = true; fn(); }
      };

      const socket = createConnection(this.socketPath);
      // Collect raw bytes: decoding per chunk would corrupt multi-byte UTF-8 split across chunks.
      const chunks: Buffer[] = [];
      let received = 0;

      socket.setTimeout(timeoutMs);
      socket.on("connect", () => { socket.write(JSON.stringify(command)); });
      socket.on("data", (data: Buffer) => {
        received += data.length;
        if (received > MAX_RESPONSE_BYTES) {
          socket.destroy();
          settle(() => reject(new Error("Response too large")));
          return;
        }
        chunks.push(data);
      });
      socket.on("end", () => {
        settle(() => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            const parsed: unknown = JSON.parse(text);
            if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
            resolve(parsed as CommandResponse);
          } catch {
            reject(new Error(`Invalid response from camera helper (${text.length} bytes)`));
          }
        });
      });
      socket.on("close", () => { settle(() => reject(new Error("Connection closed without response"))); });
      socket.on("error", (err) => { settle(() => reject(err)); });
      socket.on("timeout", () => { socket.destroy(); settle(() => reject(new Error("Command timeout"))); });
    });
  }

  async start(): Promise<void> {
    if (this.helperProcess) {
      throw new Error("Helper already running");
    }

    if (!fs.existsSync(this.helperPath)) {
      throw new Error(
        `Helper binary not found at ${this.helperPath}. Run 'npm run build:helper' to build it.`
      );
    }

    this.cleanupStaleResources();
    this.stopping = false;

    return new Promise((resolve, reject) => {
      // stdin is a pipe so the helper sees EOF (and exits) if this process dies.
      const child = spawn(this.helperPath, ["--socket", this.socketPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.helperProcess = child;

      let settled = false;
      let startupTail = "";
      const startupTimeout = setTimeout(() => {
        fail(new Error("Helper startup timeout"));
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, 10000);

      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimeout);
        this.ready = true;
        this.connectNotifications();
        resolve();
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimeout);
        reject(err);
      };

      const onOutput = (data: Buffer) => {
        const msg = data.toString();
        if (this.debug) console.log("[CameraHelper]", msg.trim());
        if (settled) return;
        // Keep a short tail so a marker split across chunks is still detected.
        startupTail = (startupTail + msg).slice(-4096);
        if (startupTail.includes(READY_MARKER)) succeed();
      };
      child.stdout?.on("data", onOutput);
      child.stderr?.on("data", onOutput);
      // Never let a write to a dead helper crash the host.
      child.stdin?.on("error", () => {});

      child.on("exit", (code, signal) => {
        if (this.debug) console.log(`[CameraHelper] Process exited with code ${code} signal ${signal}`);
        if (this.helperProcess === child) {
          this.helperProcess = null;
          this.ready = false;
          this.notifySocket?.destroy();
          this.notifySocket = null;
        }
        fail(new Error(`Helper exited during startup (code=${code}, signal=${signal})`));
        if (!this.stopping) {
          const evt: HelperExitEvent = { code, signal };
          this.emit("exit", evt);
        }
      });

      child.on("error", (err) => {
        if (this.helperProcess === child) {
          this.helperProcess = null;
          this.ready = false;
        }
        fail(err);
      });
    });
  }

  private connectNotifications(): void {
    setTimeout(() => {
      if (!this.ready || this.notifySocket) return;
      try {
        const sock = createConnection(this.notifySocketPath);
        this.notifySocket = sock;
        sock.setEncoding("utf8");

        let buffer = "";
        const MAX_BUFFER = 512_000;
        sock.on("data", (data: string) => {
          buffer += data;

          if (buffer.length > MAX_BUFFER) {
            const lastNl = buffer.lastIndexOf("\n");
            buffer = lastNl >= 0 ? buffer.slice(lastNl + 1) : "";
          }

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            let event: unknown;
            try {
              event = JSON.parse(line);
            } catch {
              if (this.debug) console.error("[CameraHelper] Invalid notification line");
              continue;
            }
            if (event && typeof event === "object") {
              try {
                this.handleNotification(event as Record<string, unknown>);
              } catch (err) {
                // A throwing user listener must not kill the notification stream.
                if (this.debug) console.error("[CameraHelper] Listener error:", err);
              }
            }
          }
        });

        sock.on("error", () => {});
        sock.on("close", () => {
          if (this.notifySocket === sock) this.notifySocket = null;
        });
      } catch {
        // Notification socket is optional
      }
    }, 500);
  }

  private handleNotification(event: Record<string, unknown>): void {
    const deviceId = typeof event.deviceId === "string" ? event.deviceId : "";
    if (event.type === "device_change") {
      const kind = event.event;
      const deviceEvent: DeviceChangeEvent = {
        type: "device_change",
        deviceId,
        event: kind === "added" || kind === "removed" ? kind : "reconfigured",
      };
      this.emit("deviceChange", deviceEvent);
    } else if (event.type === "capture_error") {
      const errEvent: CaptureErrorEvent = {
        type: "capture_error",
        deviceId,
        error: typeof event.error === "string" ? event.error : "Unknown capture error",
      };
      this.emit("captureError", errEvent);
    }
  }

  private cleanupStaleResources(): void {
    try {
      const result = spawnSync("pgrep", ["-f", `camera-helper.*${this.socketPath}`], {
        encoding: "utf-8",
        timeout: 5000,
      });

      if (result.stdout) {
        const pids = result.stdout.trim().split("\n").filter(Boolean);
        for (const pid of pids) {
          const pidNum = parseInt(pid, 10);
          if (isNaN(pidNum)) continue;
          try {
            process.kill(pidNum, "SIGTERM");
            if (this.debug) console.log(`[CameraHelperClient] Killed stale helper process ${pid}`);
          } catch {
            // Process may have already exited
          }
        }

        if (pids.length > 0) {
          spawnSync("sleep", ["0.5"]);
          for (const pid of pids) {
            const pidNum = parseInt(pid, 10);
            if (isNaN(pidNum)) continue;
            try {
              process.kill(pidNum, "SIGKILL");
            } catch {
              // Already dead
            }
          }
        }
      }
    } catch {
      // pgrep not available or no matches
    }

    for (const sockPath of [this.socketPath, this.notifySocketPath]) {
      if (fs.existsSync(sockPath)) {
        try {
          fs.unlinkSync(sockPath);
          if (this.debug) console.log(`[CameraHelperClient] Removed stale socket: ${sockPath}`);
        } catch {
          // Ignore
        }
      }
    }
  }

  async stop(): Promise<void> {
    const child = this.helperProcess;
    if (!child) {
      return;
    }
    this.stopping = true;

    if (this.notifySocket) {
      this.notifySocket.destroy();
      this.notifySocket = null;
    }

    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
    });
    const waitExit = (ms: number) =>
      Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

    try {
      await this.sendCommand({ command: "quit" }, 2000);
    } catch {
      // Ignore errors when quitting
    }

    if (!(await waitExit(1500))) {
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      if (!(await waitExit(1500))) {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
      }
    }

    if (this.helperProcess === child) this.helperProcess = null;
    this.ready = false;
  }

  isRunning(): boolean {
    return this.ready && this.helperProcess !== null;
  }

  private sendCommand(command: object, timeoutMs = 10000): Promise<CommandResponse> {
    if (!this.ready) {
      return Promise.reject(new Error("Helper process is not running"));
    }

    return this.sendCommandDirect(command, timeoutMs);
  }

  async configure(config: StreamConfig): Promise<void> {
    const response = await this.sendCommand({
      command: "configure",
      config,
    });

    if (response.error) {
      throw new Error(response.error);
    }

    this.currentConfig = { ...config };
  }

  async startStream(deviceIds?: string[]): Promise<void> {
    const response = await this.sendCommand({
      command: "start",
      deviceIds: deviceIds || [],
    }, 30000);

    if (response.error) {
      throw new Error(response.error);
    }

    this.activeDeviceIds = deviceIds || [];
  }

  async stopStream(): Promise<void> {
    const response = await this.sendCommand({
      command: "stop",
    });

    if (response.error) {
      throw new Error(response.error);
    }
  }

  async isStreaming(): Promise<boolean> {
    const response = await this.sendCommand({
      command: "status",
    });

    return response.streaming || false;
  }

  async getDevices(): Promise<CameraDeviceInfo[]> {
    const response = await this.sendCommand({
      command: "devices",
    });

    if (response.error) {
      throw new Error(response.error);
    }

    return response.devices || [];
  }

  async updateConfiguration(config: Partial<StreamConfig>): Promise<void> {
    const wasStreaming = await this.isStreaming();

    if (!this.currentConfig) {
      throw new Error("No configuration set. Call configure() first.");
    }

    const newConfig: StreamConfig = {
      ...this.currentConfig,
      ...config,
    };

    if (JSON.stringify(newConfig) === JSON.stringify(this.currentConfig)) {
      return;
    }

    if (wasStreaming) {
      await this.stopStream();
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    await this.configure(newConfig);

    if (wasStreaming) {
      await new Promise(resolve => setTimeout(resolve, 50));
      await this.startStream(this.activeDeviceIds);
    }
  }

  async configureDevice(deviceId: string, config: DeviceConfig): Promise<void> {
    const response = await this.sendCommand({
      command: "configureDevice",
      deviceId,
      config,
    });

    if (response.error) {
      throw new Error(response.error);
    }
  }

  async getDeviceConfigs(): Promise<Record<string, DeviceConfig>> {
    const response = await this.sendCommand({
      command: "getDeviceConfigs",
    });

    if (response.error) {
      throw new Error(response.error);
    }

    return response.deviceConfigs || {};
  }

  async captureLatestFrame(
    deviceId: string,
    jpegQuality: number = 0.7,
  ): Promise<LatestFrameResult> {
    const response = await this.sendCommand(
      { command: "captureLatestFrame", deviceId, jpegQuality },
      5_000,
    );

    if (response.error || !response.success) {
      throw new Error(response.error ?? `captureLatestFrame failed for ${deviceId}`);
    }

    if (!response.data) {
      throw new Error(`captureLatestFrame returned no data for ${deviceId}`);
    }

    return {
      data: Buffer.from(response.data, "base64"),
      deviceId: response.deviceId ?? deviceId,
      width: response.width ?? 0,
      height: response.height ?? 0,
      jpegSize: response.jpegSize ?? 0,
      timestamp: response.timestamp ?? 0,
      frameNumber: response.frameNumber ?? 0,
    };
  }

  onDeviceChange(callback: (event: DeviceChangeEvent) => void): void {
    this.on("deviceChange", callback);
  }

  onCaptureError(callback: (event: CaptureErrorEvent) => void): void {
    this.on("captureError", callback);
  }
}
