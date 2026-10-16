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

## Physical WebUSB connection

The browser filters VID 0x1209 / PID 0xCD10. A dedicated worker opens/claims the vendor interface (class FF, subclass 00, protocol 00), enables the line state, and runs the bulk IN/OUT loops. Command writes now await transferOut completion/error rather than acknowledging mere postMessage delivery. Disconnect waits for interface release and device close before worker termination (bounded fallback). Unexpected disconnection closes open raw logs without a false clean-stop footer.

## Data quality and suspected missed tooth pulses

The **Run warnings** banner opens with all independent issues readable, and stays in view while you scroll through the charts. Click **Minimize** to shrink it to a thin sticky indicator showing the number and types of active issues; use **Show details** to reopen it. When a warning changes while minimized, an **Updated** hint appears without forcibly opening the panel. A new clean session starts expanded again. For example, a missing-metadata notice, a USB connection issue, and RPM edge/packet losses can coexist. The expanded banner caps its height when many issues accumulate. The small quality strip beneath the global time slider places each detected event in the complete run; time-series charts show the corresponding highlighted periods. Hover at a marker to identify the channel and issue. The plotted lines are visually broken across affected intervals.

The monitor distinguishes three cases:
- **Transmission gap (confirmed):** a jump in a channel's rolling 8-bit packet sequence number.
- **Device buffering gap (confirmed):** a jump in the 32-bit physical-edge count beyond the loss accounted for by sequence gaps.
- **Suspected missed sensor pulse (inferred):** an otherwise contiguous RPM stream has an inter-tooth period 1.7–2.3 times the median of the last 5–7 ordinary periods, followed by a period 0.75–1.25 times that baseline. The extra confirming period avoids treating a sustained abrupt deceleration as a missing tooth. This may reflect a sensor pulse missed by the RP2040 or an actual missing wheel tooth, but cannot distinguish the two reliably from this signal alone.

The suspect detector runs only in the viewer and needs **no firmware change**. A sequence/edge gap, stop report, or deliberate channel toggle clears its local baseline. Raw telemetry and physical counters are preserved exactly; suspected pulses are **not silently reconstructed, replaced, or declared confirmed loss**. The shaded intervals on plots indicate measurement confidence, not independently verified tooth damage.

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