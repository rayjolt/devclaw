# Contributing

Thanks for helping improve DevClaw.

## Prerequisites

- **Node.js >= 22** (see `package.json#engines`)
- npm (bundled with Node)

## Install

```bash
npm ci
```

If `npm ci` fails during a native `postinstall` step (for example, due to missing `cmake`), you can either:

- install the missing system dependency (recommended), or
- for running the TypeScript/test toolchain only, install with scripts disabled:

```bash
npm ci --ignore-scripts
```

## Common scripts

### Typecheck / lint

DevClaw uses TypeScript typechecking as its primary lint step:

```bash
npm run lint
# or
npm run check
```

### Tests

Run the default (core) test suite:

```bash
npm test
# or
npm run test:core
```

Run the extended / slower tests:

```bash
npm run test:extended
```

Run everything:

```bash
npm run test:all
```

### Build

```bash
npm run build
```

### Formatting

Prettier is used for formatting a small curated set of files.

```bash
npm run format
```

Check formatting (CI-friendly):

```bash
npm run format-check
```

### Full local validation

This is the closest approximation of what CI expects:

```bash
npm run validate
```

## Notes

- `npm run build` produces the `dist/` output consumed by OpenClaw.
- If you add new files that should be formatted, update the `format` / `format-check` scripts in `package.json` accordingly.
