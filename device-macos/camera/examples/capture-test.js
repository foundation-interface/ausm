/**
 * Capture one JPEG from the default camera (manual test; needs Camera permission).
 *
 *   npm run build            # in device-macos/camera
 *   node examples/capture-test.js
 *   open "$TMPDIR/ausm-camera-test.jpg"
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCameraStreamer } = require('..');

async function main() {
  const cam = createCameraStreamer({ debug: true, fps: 10, targetHeight: 720 });
  const ok = await cam.start();
  if (!ok) {
    console.error('start failed — grant Camera in System Settings and retry');
    process.exit(1);
  }

  const devices = await cam.getDevices();
  console.log('devices:', devices);
  const id = devices.find((d) => d.active)?.id ?? devices[0]?.id;
  if (!id) {
    console.error('no camera devices');
    await cam.cleanup();
    process.exit(1);
  }

  let frame = null;
  for (let i = 0; i < 20; i++) {
    frame = await cam.captureLatestFrame(id);
    if (frame) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!frame) {
    console.error('no frame after retries');
    await cam.cleanup();
    process.exit(1);
  }

  const out = path.join(os.tmpdir(), 'ausm-camera-test.jpg');
  fs.writeFileSync(out, frame.data, { mode: 0o600 });
  console.log(`wrote ${out} ${frame.width}x${frame.height} (${frame.jpegSize} bytes)`);
  await cam.cleanup();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
