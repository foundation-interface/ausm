/**
 * Interactive Producer Test
 * 
 * Run this in one terminal, then run the Python consumer in another.
 * 
 * Usage (from device-macos/screen-stream): npx tsx dev/interactive-producer.ts
 * 
 * Commands:
 *   s - Start streaming
 *   x - Stop streaming
 *   d - List displays
 *   f <fps> - Change FPS (e.g., "f 30")
 *   h <height> - Change target height (e.g., "h 1080", "h 0" for native)
 *   r - Toggle recording
 *   q - Quit
 */

import { HelperClient } from "../src/helper-client";
import * as readline from "readline";
import * as fs from "fs";
import { execSync } from "child_process";

const SHM_NAME = "/ausm-frames";
const OUTPUT_DIR = "/tmp/ausm-frames-test";

let helper: HelperClient;
let currentConfig = {
  fps: 10,
  targetHeight: 1080,
  enableRecording: false,
  outputDirectory: OUTPUT_DIR,
  sharedMemoryName: SHM_NAME,
  frameCount: 5,
};

async function main() {
  console.log("╔════════════════════════════════════════════════════════════════════╗");
  console.log("║           Interactive Screen Recording Producer Test               ║");
  console.log("╠════════════════════════════════════════════════════════════════════╣");
  console.log("║  Commands:                                                         ║");
  console.log("║    s              - Start streaming                                 ║");
  console.log("║    x              - Stop streaming                                  ║");
  console.log("║    d              - List displays                                  ║");
  console.log("║    f <fps>        - Change default FPS (e.g., 'f 30')              ║");
  console.log("║    fd <id> <fps>  - Change FPS for display (e.g., 'fd 1 60')       ║");
  console.log("║    h <height>     - Change resolution (e.g., 'h 1080', 'h 0')      ║");
  console.log("║    r              - Toggle video recording                         ║");
  console.log("║    i              - Show current status                            ║");
  console.log("║    m              - Show memory/CPU stats                          ║");
  console.log("║    q              - Quit                                           ║");
  console.log("╚════════════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("Shared Memory: " + SHM_NAME);
  console.log("  Registry:    " + SHM_NAME + "-registry");
  console.log("  Per-display: " + SHM_NAME + "-display-X");
  console.log("");

  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Initialize helper
  helper = new HelperClient();
  
  helper.onDisplayChange((event) => {
    console.log(`\n📺 Display ${event.event}: ${event.displayId}`);
    printPrompt();
  });

  console.log("Starting helper process...");
  await helper.start();
  console.log("✓ Helper started\n");

  // Configure
  await helper.configure(currentConfig);
  console.log(`✓ Configured: ${currentConfig.fps} FPS, recording=${currentConfig.enableRecording}\n`);

  // Start readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  printPrompt();

  rl.on("line", async (line) => {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();

    try {
      switch (cmd) {
        case "s":
          await startStream();
          break;
        case "x":
          await stopStream();
          break;
        case "d":
          await listDisplays();
          break;
        case "f":
          const fps = parseInt(parts[1]);
          if (fps > 0 && fps <= 120) {
            await changeFps(fps);
          } else {
            console.log("Invalid FPS. Use 1-120.");
          }
          break;
        case "fd":
          // Per-display FPS: fd <displayNum> <fps>
          const displayNum = parseInt(parts[1]);
          const displayFps = parseInt(parts[2]);
          if (displayNum >= 1 && displayFps > 0 && displayFps <= 120) {
            await changeDisplayFps(`display-${displayNum}`, displayFps);
          } else {
            console.log("Usage: fd <display#> <fps>  (e.g., 'fd 1 60')");
          }
          break;
        case "h":
          const height = parseInt(parts[1]);
          if (height === 0 || (height >= 360 && height <= 4320)) {
            await changeTargetHeight(height);
          } else {
            console.log("Invalid height. Use 0 (native) or 360-4320.");
          }
          break;
        case "r":
          await toggleRecording();
          break;
        case "i":
          await showStatus();
          break;
        case "m":
          await showMemoryStats();
          break;
        case "q":
          await quit();
          rl.close();
          return;
        case "":
          break;
        default:
          console.log("Unknown command. Use s/x/d/f/h/r/i/m/q");
      }
    } catch (e: any) {
      console.log(`Error: ${e.message}`);
    }

    printPrompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

function printPrompt() {
  process.stdout.write("\n> ");
}

async function startStream() {
  const streaming = await helper.isStreaming();
  if (streaming) {
    console.log("Already streaming");
    return;
  }

  console.log("Starting stream...");
  await helper.startStream();
  console.log("✓ Streaming started");
  console.log("");
  console.log("Read frames from another terminal, e.g.:");
  console.log(`  PYTHONPATH=../internal-lib/screen-stream-reader:../screen-visualizer python3 -m screen_visualizer`);
}

async function stopStream() {
  const streaming = await helper.isStreaming();
  if (!streaming) {
    console.log("Not streaming");
    return;
  }

  console.log("Stopping stream...");
  await helper.stopStream();
  console.log("✓ Streaming stopped");

  // List any recorded videos
  if (currentConfig.enableRecording) {
    const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith(".mp4"));
    if (files.length > 0) {
      console.log("\nRecorded videos:");
      for (const f of files) {
        const stat = fs.statSync(`${OUTPUT_DIR}/${f}`);
        console.log(`  ${f}: ${(stat.size / 1024).toFixed(1)} KB`);
      }
    }
  }
}

async function listDisplays() {
  const displays = await helper.getDisplays();
  const configs = await helper.getDisplayConfigs();
  
  console.log("\nAvailable displays:");
  for (const d of displays) {
    const flags = [
      d.isMain ? "main" : "",
      d.isBuiltIn ? "built-in" : "",
    ].filter(Boolean).join(", ");
    const config = configs[d.id];
    const fpsInfo = config ? ` @ ${config.fps} fps` : "";
    console.log(`  ${d.id}: ${d.width}x${d.height}${fpsInfo} ${flags ? `(${flags})` : ""}`);
  }
}

async function changeFps(fps: number) {
  console.log(`Changing default FPS to ${fps}...`);
  currentConfig.fps = fps;
  await helper.updateConfiguration({ fps });
  console.log(`✓ Default FPS changed to ${fps}`);
}

async function changeDisplayFps(displayId: string, fps: number) {
  console.log(`Changing FPS for ${displayId} to ${fps}...`);
  await helper.configureDisplay(displayId, { fps });
  console.log(`✓ ${displayId} FPS changed to ${fps}`);
}

async function changeTargetHeight(height: number) {
  const label = height === 0 ? "native" : `${height}p`;
  console.log(`Changing resolution to ${label}...`);
  currentConfig.targetHeight = height;
  await helper.updateConfiguration({ targetHeight: height });
  console.log(`✓ Resolution changed to ${label}`);
}

async function toggleRecording() {
  currentConfig.enableRecording = !currentConfig.enableRecording;
  
  const streaming = await helper.isStreaming();
  if (streaming) {
    // Need to restart stream with new config
    console.log(`Toggling recording ${currentConfig.enableRecording ? "ON" : "OFF"}...`);
    await helper.updateConfiguration({ enableRecording: currentConfig.enableRecording });
    console.log(`✓ Recording is now ${currentConfig.enableRecording ? "ENABLED" : "DISABLED"}`);
  } else {
    await helper.configure(currentConfig);
    console.log(`✓ Recording will be ${currentConfig.enableRecording ? "ENABLED" : "DISABLED"} on next stream`);
  }
}

async function showStatus() {
  const streaming = await helper.isStreaming();
  const displays = await helper.getDisplays();

  console.log("\n--- Current Status ---");
  console.log(`Streaming: ${streaming ? "YES" : "NO"}`);
  console.log(`FPS: ${currentConfig.fps}`);
  console.log(`Recording: ${currentConfig.enableRecording ? "ON" : "OFF"}`);
  console.log(`Target Height: ${currentConfig.targetHeight === 0 ? "native" : currentConfig.targetHeight + "p"}`);
  console.log(`Displays: ${displays.length}`);
  console.log(`Shared Memory: ${SHM_NAME}`);
  if (streaming) {
    console.log(`\nActive SHM regions:`);
    console.log(`  ${SHM_NAME}-registry`);
    for (const d of displays) {
      console.log(`  ${SHM_NAME}-${d.id}`);
    }
  }
}

function getScaledDimensions(nativeWidth: number, nativeHeight: number): { width: number; height: number } {
  let width = nativeWidth;
  let height = nativeHeight;
  if (currentConfig.targetHeight > 0 && currentConfig.targetHeight < nativeHeight) {
    const scale = currentConfig.targetHeight / nativeHeight;
    width = Math.round(nativeWidth * scale);
    height = currentConfig.targetHeight;
  }
  // Ensure even dimensions (required for video encoding)
  return { width: (width + 1) & ~1, height: (height + 1) & ~1 };
}

async function showMemoryStats() {
  console.log("\n--- Memory & CPU Stats ---");
  
  // Get helper process stats
  try {
    const helperPid = execSync("pgrep -n -f screen-capture-helper", { encoding: "utf-8" }).trim();
    const psOutput = execSync(`ps -p ${helperPid} -o pid=,%cpu=,%mem=,rss= 2>/dev/null`, { encoding: "utf-8" }).trim();
    const [pid, cpu, mem, rss] = psOutput.split(/\s+/);
    console.log(`\nHelper Process (PID ${pid}):`);
    console.log(`  CPU:    ${cpu}%`);
    console.log(`  Memory: ${mem}% (${(parseInt(rss) / 1024).toFixed(1)} MB)`);
  } catch {
    console.log("\nHelper process: Not running");
  }

  const streaming = await helper.isStreaming();
  if (!streaming) {
    console.log("\nNo active stream - no shared memory allocated");
    return;
  }

  const displays = await helper.getDisplays();
  const frameCount = currentConfig.frameCount;
  const registrySize = 48 + (8 * 240); // header + max entries
  
  console.log(`\nShared Memory Regions:`);
  console.log(`  ${SHM_NAME}-registry: ~${(registrySize / 1024).toFixed(1)} KB`);

  let totalShmBytes = registrySize;
  let totalFrameBytes = 0;

  for (const d of displays) {
    const { width, height } = getScaledDimensions(d.width, d.height);
    const frameSize = width * height * 4; // BGRA
    const displayShmSize = 72 + (frameCount * (40 + frameSize)); // header + frames
    
    console.log(`  ${SHM_NAME}-${d.id}: ~${(displayShmSize / (1024 * 1024)).toFixed(1)} MB (${width}x${height} × ${frameCount} frames)`);
    totalShmBytes += displayShmSize;
    totalFrameBytes += frameSize;
  }

  const bandwidthMBps = (totalFrameBytes * currentConfig.fps) / (1024 * 1024);
  console.log(`\n  Total SHM: ~${(totalShmBytes / (1024 * 1024)).toFixed(1)} MB`);
  console.log(`  Bandwidth: ~${bandwidthMBps.toFixed(1)} MB/s @ ${currentConfig.fps} FPS`);
}

async function quit() {
  console.log("\nShutting down...");
  
  const streaming = await helper.isStreaming();
  if (streaming) {
    await helper.stopStream();
  }
  
  await helper.stop();
  console.log("Goodbye!");
}

// Handle Ctrl+C
process.on("SIGINT", async () => {
  console.log("\n\nReceived SIGINT, cleaning up...");
  try {
    await helper.stop();
  } catch {}
  process.exit(0);
});

main().catch(console.error);
