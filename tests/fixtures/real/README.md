# Real RP2040 raw replay fixture (pending)

This folder is reserved for **one reviewed, authentic dyno recording**. We do not
substitute invented reference values or claim that a synthetic stream validates
real hardware. The current CI already exercises synthetic raw-recording
round-trips and intentionally damaged replay files with full Chromium/Playwright.

When a real recording is supplied:

1. Preserve the original `*-raw.csv` byte-for-byte outside the repository.
   Obtain permission before committing measurements or metadata publicly.
2. Select a representative, **contiguous** segment that contains both RPM
   channels and, ideally, shift/torque measurements. Keep original
   `firmware_t_us`, `seq`, `raw_value`, `edge_count`, and their arrival order.
   Do not renumber packets to make a damaged interval look clean.
3. Provide the recorded wheel tooth counts, run context and any known anomaly
   times. Include the embedded start metadata if present. If absent, record the
   viewer configuration that should be applied during playback.
4. Create `reference-run-raw.csv` and `reference-run.manifest.json`.
   The manifest must include the fixture SHA-256, source/provenance, permitted
   distribution, physical units and settings, expected packet count, and
   independently reviewed anomaly intervals. Store numerical regression
   baselines separately from physically verified quantities.
5. Add a Playwright replay test plus a non-browser analysis regression.
   Check parsing, source packet preservation, event times, derived outputs,
   chart rendering and warnings. Keep the fixture small enough for normal CI.

**Important:** this fixture is not yet provided. All current automated tests
run without it. Once available, it should be a deterministic, required part of
PR CI—not a silent `test.skip` that could conceal a missing reference.

No firmware, USB hardware, or private credentials are required for the normal
GitHub-hosted jobs. A future hardware-in-the-loop test would require a
self-hosted runner with the RP2040 attached.
