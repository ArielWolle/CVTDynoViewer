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

Command `0x04` controls firmware bench mode. Send `[0x04, 0x00, 0x00, 0x01]` to generate synthetic RPM, shift, and torque values on the firmware without reading attached sensors. Send `[0x04, 0x00, 0x00, 0x00]` to restore the real sensor path. The website's **Bench mode** button sends these packets after a serial connection is established.

## Logging

Choose a directory in Chromium to save CSV files directly through the File System Access API. Browsers without that API use a normal CSV download. Torque scale and zero are editable because the firmware exposes torque counts rather than a documented physical unit.

CSV columns are exported in SI units, with the unit encoded in the header name:

```
timestamp_s, primary_angular_velocity_rad_s, secondary_angular_velocity_rad_s,
shift_position_percent, primary_torque_nm, secondary_torque_nm,
primary_power_w, secondary_power_w, efficiency_percent
```

RPM is converted to rad/s, power to watts, and torque counts to newton-meters using the current torque scale/zero calibration. Loading a CSV back in (playback, below) detects the unit from each column name and converts it back automatically -- older exports (`timestamp_ms`, `primary_rpm`, `primary_power_kw`, raw torque counts) are still read correctly.

## Inertia mode

Power mode defaults to **Inertia mode**, which estimates primary power from an editable RPM-vs-torque engine curve and secondary power from shaft acceleration. Use the **Inertia settings** dropdown in the control room to:

- Edit the secondary shaft inertia (kg·m²) used for the acceleration-based power estimate.
- Reshape the primary engine torque curve by dragging its points on the spline graph. Double-click empty space to add a point, double-click a point to remove it. The curve persists in local storage and can be restored with **Reset curve**.

## CSV playback

Use **Load CSV** to replay a previously logged CSV file (or any file matching the export header) as if it were live telemetry. Playback controls include play/pause, a speed selector (0.25×–4×), and a scrub bar. Loading a file pauses demo/live telemetry until playback is cleared or a device is connected.

## Moving averages

Each RPM, power, efficiency, and shift-ratio chart has a **Moving avg** checkbox in its header (the power chart has separate Primary/Secondary checkboxes) that overlays a dashed trailing moving-average trace. Primary RPM and secondary power are on by default; the rest are off. The **MA points** field next to **Reset layout** sets how many trailing samples are averaged (default 5) and applies to every enabled trace.

## Chart workspace controls

Instead of a per-chart time window, the workspace has a single **Pause** button (next to **Reset layout**) that freezes all charts for inspection, and a dual-handle time range slider beneath the workspace header. Drag the two handles to select the start and end time shown across every chart; drag both to the edges (or use **Full range**) to see the whole buffered session.

## GitHub Pages

`.github/workflows/deploy-pages.yml` installs dependencies, runs checks, builds the Vite output, and publishes `dist/` through the GitHub Pages environment on the `main` branch. Enable GitHub Pages with the **GitHub Actions** source in the repository settings. The Vite base path is relative so the bundle works under a project-page URL.