#!/usr/bin/env npx tsx
/**
 * AUSM Service Manager — DEV-ONLY.
 *
 * Convenience launcher for poking at the screen-stream pipeline from a repo
 * checkout. It is not shipped in any npm package and is not used by the
 * runtime (`createRuntime()` manages its own helpers).
 *
 * Usage (from the repo root):
 *   npx tsx device-macos/service-manager.ts [options]
 *
 * Options:
 *   --screen-stream    Start the interactive screen-stream producer
 *   --visualizer       Start the screen visualizer (Python + OpenCV)
 *   --all              Start all of the above
 *   --list             List available services
 *   --help             Show help
 *
 * Environment:
 *   AUSM_PYTHON        Python interpreter for the visualizer (default: python3).
 *                      Needs numpy + opencv-python.
 *
 * Children are spawned with argv arrays (no shell) and are terminated with
 * SIGTERM (then SIGKILL after a grace period) when this process exits.
 */

import { spawn, ChildProcess } from "child_process";
import * as path from "path";

const SERVICES_DIR = __dirname;
const STOP_GRACE_MS = 3000;

interface ServiceConfig {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  description: string;
}

function prependPythonPath(...dirs: string[]): string {
  const existing = process.env.PYTHONPATH;
  return [...dirs, ...(existing ? [existing] : [])].join(path.delimiter);
}

const SERVICES: Record<string, ServiceConfig> = {
  "screen-stream": {
    name: "Screen Stream Producer",
    // Resolve tsx through npx so no global install is required.
    command: "npx",
    args: ["tsx", "dev/interactive-producer.ts"],
    cwd: path.join(SERVICES_DIR, "screen-stream"),
    description: "Captures the screen and shares frames via shared memory (needs Screen Recording permission)",
  },
  visualizer: {
    name: "Screen Visualizer",
    command: process.env.AUSM_PYTHON || "python3",
    args: ["-m", "screen_visualizer"],
    cwd: path.join(SERVICES_DIR, "screen-visualizer"),
    // Run from the checkout without `pip install -e`.
    env: {
      PYTHONPATH: prependPythonPath(
        path.join(SERVICES_DIR, "screen-visualizer"),
        path.join(SERVICES_DIR, "internal-lib", "screen-stream-reader"),
      ),
    },
    description: "Real-time visualization of captured frames",
  },
};

class ServiceManager {
  private processes: Map<string, ChildProcess> = new Map();
  private shuttingDown = false;

  startService(serviceId: string): boolean {
    const config = SERVICES[serviceId];
    if (!config) {
      console.error(`Unknown service: ${serviceId}`);
      return false;
    }

    if (this.processes.has(serviceId)) {
      console.log(`[${config.name}] Already running`);
      return true;
    }

    console.log(`\nStarting ${config.name}...`);
    console.log(`   ${config.description}`);
    console.log(`   Command: ${config.command} ${config.args.join(" ")}`);
    console.log(`   Directory: ${config.cwd}\n`);

    // argv array, no shell: nothing here is interpreted by /bin/sh.
    const proc = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: "inherit",
    });

    proc.on("error", (err) => {
      console.error(`[${config.name}] Error: ${err.message}`);
    });

    proc.on("exit", (code, signal) => {
      if (!this.shuttingDown) {
        console.log(`[${config.name}] Exited (code=${code}, signal=${signal})`);
      }
      this.processes.delete(serviceId);
      if (!this.shuttingDown && this.processes.size === 0) {
        console.log("All services exited.");
        process.exit(code ?? 0);
      }
    });

    this.processes.set(serviceId, proc);
    return true;
  }

  /** SIGTERM the child, SIGKILL it if it hasn't exited after STOP_GRACE_MS. */
  stopService(serviceId: string): Promise<void> {
    const proc = this.processes.get(serviceId);
    if (!proc) return Promise.resolve();
    const config = SERVICES[serviceId];
    console.log(`\nStopping ${config?.name || serviceId}...`);

    return new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve();
        return;
      }
      const killTimer = setTimeout(() => proc.kill("SIGKILL"), STOP_GRACE_MS);
      proc.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      proc.kill("SIGTERM");
    });
  }

  async stopAll(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    console.log("\nStopping all services...");
    await Promise.all([...this.processes.keys()].map((id) => this.stopService(id)));
  }

  listServices(): void {
    console.log("\nAvailable services:\n");
    for (const [id, config] of Object.entries(SERVICES)) {
      console.log(`  ${id}`);
      console.log(`    ${config.name}`);
      console.log(`    ${config.description}\n`);
    }
  }
}

function printHelp(): void {
  console.log(`
AUSM Service Manager (dev-only)

Usage:
  npx tsx device-macos/service-manager.ts [options]

Options:
  --screen-stream    Start the interactive screen-stream producer
  --visualizer       Start the screen visualizer (set AUSM_PYTHON to pick the interpreter)
  --all              Start all services
  --list             List available services
  --help             Show this help

Examples:
  # Start screen capture producer
  npx tsx device-macos/service-manager.ts --screen-stream

  # Start screen stream and visualizer together
  npx tsx device-macos/service-manager.ts --screen-stream --visualizer
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const manager = new ServiceManager();

  if (args.includes("--list")) {
    manager.listServices();
    process.exit(0);
  }

  const known = new Set(["--screen-stream", "--visualizer", "--all"]);
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    console.error(`Unknown option(s): ${unknown.join(" ")}. Use --help for usage.`);
    process.exit(1);
  }

  // Handle shutdown signals
  const shutdown = async () => {
    await manager.stopAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start requested services
  const servicesToStart: string[] = [];

  if (args.includes("--all")) {
    servicesToStart.push(...Object.keys(SERVICES));
  } else {
    if (args.includes("--screen-stream")) servicesToStart.push("screen-stream");
    if (args.includes("--visualizer")) servicesToStart.push("visualizer");
  }

  console.log("AUSM Service Manager (dev-only) — press Ctrl+C to stop all services");

  for (const serviceId of servicesToStart) {
    manager.startService(serviceId);
    // Small delay so the producer is up before consumers connect
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log("\nServices started. Press Ctrl+C to stop.\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
