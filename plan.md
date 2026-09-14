# CVT Dyno Viewer Implementation Plan

## Goal

Build a React + Vite browser application for the CVT dyno firmware. The viewer will connect to the firmware over Web Serial, display live telemetry, send configuration commands, support draggable graph layouts, and export logged data as CSV. The production build will be published as GitLab Pages by a GitLab CI runner.

## Working Assumptions

- The firmware uses Web Serial rather than WebUSB: the transport is a USB CDC serial device exposed through `navigator.serial`.
- Telemetry packets are 8 bytes: little-endian `0xAABB` header, one-byte channel id, one padding byte, and one little-endian signed 32-bit payload.
- Channel ids are `0..4`: primary RPM, secondary RPM, shift position, primary torque, secondary torque.
- Commands are 4 bytes: command id, channel id, and a big-endian 16-bit value. Command `0x01` enables/disables a channel, `0x02` sets its frequency, and `0x03` requests the current configuration text dump.
- Power requires a user-configurable torque-to-power conversion because the firmware currently exposes torque counts rather than a documented physical unit. The first implementation will make the conversion constants editable in the dyno configuration panel.
- Browser support is required for Chromium-based browsers with Web Serial. The app will show a clear unsupported-browser state elsewhere.
- File System Access API directory writing is optional browser functionality. CSV download will remain available as a fallback.

## Architecture

- React + TypeScript + Vite.
- `src/services/serialTransport.ts`: Web Serial connection lifecycle, byte framing, packet parsing, command encoding, and incoming text/config handling.
- `src/services/dynoSession.ts`: session state, rolling telemetry samples, start/stop/reset behavior, derived power and efficiency values, and CSV row generation.
- `src/hooks/`: React-facing hooks for serial state, session state, persisted layout, and logging.
- `src/components/`: top configuration bar, connection controls, telemetry status strip, chart workspace, chart cards, logging controls, and settings drawer.
- `src/charts/`: reusable chart configuration and derived series. Use a maintained chart library rather than hand-drawing chart primitives.
- `src/types/`: firmware protocol, telemetry, configuration, layout, and logging types.
- `src/styles/`: design tokens and responsive application styling.
- `public/`: static metadata needed by Vite/GitLab Pages.

## Product Surface

1. Header / control bar
   - Connection status and connect/disconnect action.
   - Serial device selection through Web Serial.
   - Dyno configuration for channel enabled state, target frequencies, torque conversion, and session naming.
   - Logging directory selection when supported, logging status, start/stop logging, CSV download, and reset session.
2. Live status strip
   - Primary RPM, secondary RPM, shift position, primary power, secondary power, and efficiency.
   - Stale-data indicators and serial error state.
3. Graph workspace
   - Six charts: primary vs secondary RPM scatter, primary RPM vs time, secondary RPM vs time, shift position vs time, primary power vs time, and efficiency vs time.
   - Drag-and-drop reordering with a compact chart header and per-chart visibility toggle.
   - Responsive grid layout that remains usable on a narrow screen.
4. Saved views
   - Persist chart ordering and visibility in local storage.
   - Restore the previous layout automatically on startup.
   - Reset layout to the default arrangement.
5. Logging
   - Keep a bounded live buffer for rendering while preserving the complete session log separately.
   - CSV columns include timestamp, primary RPM, secondary RPM, shift position, both torque values, both power values, and efficiency.
   - Use the File System Access API when a directory is granted; always provide a browser download fallback.

## Interaction and Visual Direction

- Dense, technical instrument-panel layout rather than a marketing landing page.
- Warm off-white canvas, near-black ink, graphite panels, and safety-orange highlights for active controls and warnings.
- Expressive display type for the product title and compact readable sans-serif for telemetry and chart labels.
- Restrained motion: connection state transitions, chart/workspace entry, and live value updates only.
- Keep controls keyboard accessible, focus-visible, and readable at mobile widths.

## Implementation Sequence

1. Scaffold the Vite React TypeScript project and install chart, drag-and-drop, and icon dependencies.
2. Add GitLab Pages configuration and verify Vite base-path behavior for project pages.
3. Implement protocol types, packet decoder, command encoder, and Web Serial transport.
4. Implement session state, rolling samples, derived metrics, CSV serialization, and local persistence helpers.
5. Build the application shell and configuration/logging controls.
6. Add chart workspace, six visualizations, drag ordering, visibility, and saved views.
7. Add responsive styling, loading/empty/error states, browser capability messaging, and accessible labels/tooltips.
8. Add focused unit tests for packet framing, command encoding, derived metrics, CSV escaping, and layout persistence.
9. Run typecheck, tests, and production build; inspect the built output and document local development/deployment commands.

## Validation Plan

- `npm run typecheck` catches protocol and component contract errors.
- `npm run test` verifies packet parsing, command bytes, metric math, CSV output, and persistence behavior.
- `npm run build` verifies the GitLab Pages production bundle.
- Manual Chromium check verifies serial permission flow, connect/disconnect, synthetic telemetry rendering, drag reorder, persisted layout, CSV download, and responsive layout.
- GitLab CI uses the Node LTS image, `npm ci`, `npm run build`, and publishes `dist/` as the Pages artifact.

## Definition Of Done

- A fresh checkout can install and build with standard npm commands.
- The UI can connect to the firmware, parse all five channels, send all documented commands, and show connection/errors clearly.
- All six requested graphs are present and reorderable.
- The previous graph layout is restored automatically.
- A session can be downloaded as CSV, with directory logging used when the browser supports it.
- GitLab CI produces a deployable Pages artifact.
- Tests and production build pass.
