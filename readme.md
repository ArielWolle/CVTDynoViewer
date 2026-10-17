# CVT Dyno Viewer

Browser-based React / TypeScript / Vite viewer for the CVT dynamometer, deployed to GitHub Pages.

## Run locally

Requires Node.js 22+ and a Chromium browser for real hardware WebUSB (HTTPS or localhost). The RP2040 exposes a vendor-class USB interface, **not a virtual COM port**.

```bash
npm ci
npm run dev
npm run typecheck
npm run test
npm run build
```

## Hardware-free WebUSB integration tests

Click **Simulate RP2040** instead of Connect device. No board, driver, USB permission, or cable is required. The virtual USBDevice goes through the **same** worker code: open, selectConfiguration, find and claim vendor interface, controlTransferOut, transferIn, transferOut, byte framing/CRC decoding, packet delivery/credits, live analysis, graphs and raw logging.

The simulated protocol matches protocol v2 from ArielWolle/CVTDynoFirmware/src/main.cpp: 21-byte AA 55 telemetry packets, per-channel sequence, uint64 timestamp, uint32 RPM physical-edge count, CRC-8; C0-prefixed five-byte commands; per-tooth RPM periods on channels 0 and 1; independent polled shift/torque channels 2-4; change-driven throttle channel 5; configuration and diagnostics replies.

The scenario selector offers normal operation, **loss / fragmentation** (deterministic damaged CRC and pre-transmit missed RPM edges), **unplug after 5s** (read error and UI recovery), and **claim failure** (startup cleanup). Real and virtual connections remain visibly distinct; synthetic CSV files start with SIMULATED- and contain captureSource=virtual metadata. Press Read configuration, toggle channels/bench mode, record a raw log and try reconnecting repeatedly.

**Limitations:** The virtual USBDevice does not reproduce physical USB enumeration, browser hardware permissions, WinUSB driver binding, actual bus latency/power, cable faults or RP2040 electrical/hardware behaviour. Physical reconnection must still be validated with the board. It is significantly more faithful than feeding fake values straight into the plots.

## Automated virtual-USB and browser tests

The pull-request workflow runs **two independent jobs in parallel**:

- **checks** — TypeScript, fast Vitest tests, and production build. The simulator
  supports independent, exact injection of a CRC-corrupt frame, dropped
  transmitted packet, lost firmware-ring edge, missed sensor tooth and stalled
  USB OUT transfer; targeted tests assert expected counters and recovery.
- **Chromium / virtual WebUSB** — five Playwright tests against the built viewer,
  using its actual production USB and analysis workers. They verify drawn
  canvas plots, hover, resize, freeze, settings and chart layout; loss warnings
  and markers; claim errors/unplug/reconnection; live raw-file logging; and
  clean/faulty CSV replay. Failures upload screenshots and browser traces.

The browser job runs **only the Chromium headless shell** and is bounded by a
five-minute job timeout. Normal tests run on every PR and `main` push, without
hardware. We measured approximately one minute end to end on GitHub-hosted
Ubuntu, with the five browser scenarios taking about 12 seconds.

To run the browser tests locally (Node.js 22+):

```bash
npm ci
npm install --no-save --no-package-lock --ignore-scripts @playwright/test@1.56.1
npx playwright install --with-deps --only-shell chromium
npm run build
npx playwright test --config=tests/e2e/playwright.config.mjs
```

The Playwright runner is pinned and installed for the browser job, rather than
changing the app's existing npm lockfile. `npm run test` runs the fast Vitest
tests under `src` only.

A **real RP2040 recording** has now been added as a small, contiguous
six-second fixture: `tests/fixtures/real/reference-run-raw.csv`. It contains
7,119 unmodified recorded RPM packets and 35 suspected primary missed-pulse
events. We prepended the user's requested **reconstructed default metadata**:
16/12 wheel teeth, 100 ms analysis window and default engine curve/inertia.
These are reproducibility assumptions, **not verified historical settings**.
The manifest documents the original recording's hash, the excerpt's hash and
exact anomaly anchors. Both the fast quality regression and a full Chromium
raw replay test run on PR CI. See `tests/fixtures/real/README.md` for the
provenance and limitations. Browser simulation does not validate physical USB,
sensor timing or electrical behavior.

## Physical WebUSB connection

The browser filters VID 0x1209 / PID 0xCD10. A dedicated worker opens/claims the vendor interface (class FF, subclass 00, protocol 00), enables the line state, and runs the bulk IN/OUT loops. Command writes now await transferOut completion/error rather than acknowledging mere postMessage delivery. Disconnect waits for interface release and device close before worker termination (bounded fallback). Unexpected disconnection closes open raw logs without a false clean-stop footer.

## Data quality and suspected missed tooth pulses

The **Run warnings** banner opens with all independent issues readable, and stays in view while you scroll through the charts. Click **Minimize** to shrink it to a thin sticky indicator showing the number and types of active issues; use **Show details** to reopen it. When a warning changes while minimized, an **Updated** hint appears without forcibly opening the panel. A new clean session starts expanded again. For example, a missing-metadata notice, a USB connection issue, and RPM edge/packet losses can coexist. The expanded banner caps its height when many issues accumulate. The small quality strip beneath the global time slider places each detected event in the complete run; time-series charts show the corresponding highlighted periods. Hover at a marker to identify the channel and issue. The plotted lines are visually broken across affected intervals.

The monitor distinguishes three cases:
- **Transmission gap (confirmed):** a jump in a channel's rolling 8-bit packet sequence number.
- **Device buffering gap (confirmed):** a jump in the 32-bit physical-edge count beyond the loss accounted for by sequence gaps.
- **Suspected missed sensor pulses (inferred):** an otherwise contiguous RPM stream has an inter-tooth period near **2×–5×** the median of the last 5–7 ordinary periods, followed by a period 0.75–1.25 times that baseline. The multiple must be near an integer (with bounded tolerance), and the confirming period avoids mistaking a sustained abrupt deceleration for a missing tooth. One detection means one suspect time interval; it does not establish exactly how many physical sensor pulses or wheel teeth were missed.

The suspect detector runs only in the viewer and needs **no firmware change**. A sequence/edge gap, stop report, or deliberate channel toggle clears its local baseline. Raw telemetry and physical counters are preserved exactly; suspected pulses are **not silently reconstructed, replaced, or declared confirmed loss**. The shaded intervals on plots indicate measurement confidence, not independently verified tooth damage.

**Derived-data handling:** RPM processing holds one tooth packet for a single-pulse lookahead, using the same quality detector as the warnings. A confirmed recovered multi-tooth period is excluded **before** it can influence sliding one-revolution RPM estimates. The next valid revolution begins a new analysis epoch. Power, ratio and efficiency calculations never interpolate across that epoch; e.g., if a suspect interval lies within a 250 ms power integration window, that window's derived power is omitted. This affects only the involved shaft and relevant joined quantities, not an entire session. Raw captures are never modified.

**RPM gaps display:** The analysis workspace has an **RPM gaps** selector. The default is **Show gaps**, retaining visible discontinuities. **Dashed interpolation (visual only)** draws a short, dashed straight-line bridge between existing trustworthy RPM endpoints around a detected quality interval. It is never treated as a measured point and is **not** used by the engine, power, ratio, efficiency or CSV exports. Gaps from stops and extended outages are not bridged. In *Per tooth* observation mode the faint raw dots can still expose physical timing anomalies; the cleaned numerical RPM curve is separate.

The real 23CVT regression fixture includes **89** recovered anomalous tooth intervals (35 near 2×, 31 near 3×, 20 near 4×, 3 near 5×), all on the primary shaft; these are not verified tooth-damage counts.

To exercise all three categories without the RP2040, use **Virtual: loss / fragmentation**. Saved raw runs recreate the quality events when replayed because their source fields contain timestamps, packet sequences and physical-edge counts.

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

## Ratio reference lines

The **Primary vs. secondary RPM** chart has **Low ratio** / **High ratio** number inputs in its header (defaults 2.5 and 0.9). Each draws a straight `y = ratio * x` reference line through the origin, giving a visual band for the expected/acceptable shift ratio range independent of the live telemetry trace.

## Moving averages

Each RPM, power, efficiency, and shift-ratio chart has a **Moving avg** checkbox in its header (the power chart has separate Primary/Secondary checkboxes) that overlays a dashed trailing moving-average trace. Primary RPM and secondary power are on by default; the rest are off. The **MA points** field next to **Reset layout** sets how many trailing samples are averaged (default 5) and applies to every enabled trace.

## Chart workspace controls

Instead of a per-chart time window, the workspace has a single **Pause** button (next to **Reset layout**) that freezes all charts for inspection, and a dual-handle time range slider beneath the workspace header. Drag the two handles to select the start and end time shown across every chart; drag both to the edges (or use **Full range**) to see the whole buffered session.

## GitHub Pages

`.github/workflows/deploy-pages.yml` installs dependencies, runs checks, builds the Vite output, and publishes `dist/` through the GitHub Pages environment on the `main` branch. Enable GitHub Pages with the **GitHub Actions** source in the repository settings. The Vite base path is relative so the bundle works under a project-page URL.