# Headless verification harness

Drives the REAL game in headless Chrome (SwiftShader WebGL) and fails on any page error.
Used to verify physics tackles, animation slices, and locomotion after asset/code changes.

```bash
npm i -D puppeteer   # one-time, downloads a local Chrome (not a committed dependency)
npm run test:headless
```

What it does:
- boots `vite dev` on a scratch port,
- waits for the skinned character + clips to load,
- drives scripted plays through the dev handle (`window.__app`, dev builds only):
  run + gang tackles, pass + catch, kickoff return, repeated rushes (ragdoll piles),
- **asserts zero `pageerror`s** across the whole suite,
- writes timestamped contact-sheet screenshots to `/tmp/rigqc/headless/`.

Exit code 0 = clean. Non-zero = page errors (printed) or a scenario failed to reach its phase.
