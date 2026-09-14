# CVT Dyno Viewer

Browser-based live viewer for the CVT dyno firmware. The app uses React, TypeScript, Vite, and Recharts, and deploys to GitHub Pages.

## Run locally

Requires Node.js 22 or newer and a Chromium-based browser for Web Serial.

```bash
npm install
npm run dev
```

The app starts with synthetic telemetry so the workspace can be inspected without hardware. Use **Connect device** to request the firmware's USB serial port.

## Build and test

```bash
npm run typecheck
npm run test
npm run build
```

## Firmware protocol

Telemetry packets are 8 bytes: little-endian header `0xAABB`, channel id, padding, and a little-endian signed 32-bit value. Channels `0..4` are primary RPM, secondary RPM, shift position, primary torque, and secondary torque.

Commands are 4 bytes: command id, channel id, and a big-endian 16-bit value. Command `0x01` toggles a channel, `0x02` sets its frequency, and `0x03` requests the text configuration report.

## Logging

Choose a directory in Chromium to save CSV files directly through the File System Access API. Browsers without that API use a normal CSV download. Torque scale and zero are editable because the firmware exposes torque counts rather than a documented physical unit.

## GitHub Pages

`.github/workflows/deploy-pages.yml` installs dependencies, runs checks, builds the Vite output, and publishes `dist/` through the GitHub Pages environment on the `main` branch. Enable GitHub Pages with the **GitHub Actions** source in the repository settings. The Vite base path is relative so the bundle works under a project-page URL.