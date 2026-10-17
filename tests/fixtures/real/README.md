# Real 23CVT hardware regression fixture

**reference-run-raw.csv** is a contiguous six-second excerpt from a real, user-supplied
RP2040 recording (not synthetic telemetry). The accompanying
**reference-run.manifest.json** provides SHA-256 checksums, source provenance,
the selection window, packet counts, reconstructed settings, and expected
data-quality event anchors.

## Source integrity

- Original: `23CVT_Run-3-raw.csv`, 25,202 rows over 26.177 seconds.
- Selection: 17–23 seconds relative to the original first firmware timestamp.
- Excerpt: 7,119 packets; 4,289 primary RPM and 2,830 secondary RPM.
- Every selected packet retains its original row and byte contents, including
  firmware timestamp, sequence, physical edge count, and source arrival order.
- The *full original* is not stored in GitHub. The smaller excerpt is public
  with the user's permission and loads directly with **Load raw replay**.
- There is no clean-stop footer, because this excerpt is not a complete capture.

## Reconstructed default metadata: not an original device measurement

The source had **no embedded metadata**. With the user's permission, we
prepended an ordinary `# cvt-dyno-meta-v1` header so replay uses fixed defaults
instead of whatever an operator previously set in their browser. It contains:

- `captureSource: hardware`; unknown firmware version and commit SHA.
- 16 primary / 12 secondary teeth (current viewer defaults, **unverified**).
- 100 ms analysis window, inertia mode, 0.3134 kg m² secondary inertia.
- The viewer's default engine torque curve and torque calibration/offset.
- UTC start time inferred from the excerpt's first wall-clock timestamp.

These assumptions do not establish power, torque, efficiency, tooth-count
or physical calibration accuracy. This is a **reproducible software regression**,
not experimental verification of those quantities. Shift and torque channels
are absent from the source and are not invented in the fixture.

## Observed anomalies

The original run has continuous per-channel packet and physical-edge counters.
The selected interval contains 89 isolated near-integer-multiple tooth periods
on **primary RPM**: 35 near 2×, 31 near 3×, 20 near 4×, and 3 near 5×
the local median. Each required the following tooth period to return near the
preceding baseline. Zero suspect intervals occur on secondary; both channels
have zero confirmed transmission or firmware buffering losses. The manifest contains exact event-time anchors. These are **89 suspect intervals**, not a measured count of physically missing teeth or pulses.
The original CSV is not altered: the viewer's numerical analysis now rejects
confirmed suspect periods and waits for one uncontaminated revolution before
resuming affected RPM and power windows.

## Tests

- `src/quality/realCaptureRegression.test.ts`: fixture checksum, provenance,
  packet preservation, exact quality counts/timestamps and RPM reconstruction.
- `tests/e2e/virtual-usb.spec.mjs`: full Chromium replay with restored defaults,
  warnings, chart annotations and actual canvas rendering.

Both are required in PR CI. Any change to recorded expected results must be
reviewed as an algorithm or evidence change, not silently regenerated.
Physical USB and electrical behavior still require testing on actual hardware.
