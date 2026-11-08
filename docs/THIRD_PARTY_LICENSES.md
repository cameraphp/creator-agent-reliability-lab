# Third-party licenses

Read from installed `node_modules/*/package.json` and `package-lock.json` on 2026-11-07. This lists
dependency licenses only; the project's own license is not yet chosen (owner decision).

## Direct dependencies (pinned)

| Package           | Version | License    | Use     |
| ----------------- | ------- | ---------- | ------- |
| fastify           | 5.12.7  | MIT        | runtime |
| pg                | 8.23.1  | MIT        | runtime |
| zod               | 4.6.7   | MIT        | runtime |
| typescript        | 6.0.3   | Apache-2.0 | dev     |
| vitest            | 5.0.5   | MIT        | dev     |
| eslint            | 10.14.0 | MIT        | dev     |
| @eslint/js        | 10.0.1  | MIT        | dev     |
| typescript-eslint | 8.72.1  | MIT        | dev     |
| prettier          | 3.9.10  | MIT        | dev     |
| tsx               | 4.23.15 | MIT        | dev     |
| @types/node       | 24.19.2 | MIT        | dev     |
| @types/pg         | 8.23.1  | MIT        | dev     |

## Transitive packages (250 entries in package-lock, 68 runtime)

MIT 199, Apache-2.0 15, ISC 9, BSD-3-Clause 8, BSD-2-Clause 6, MPL-2.0 12, BlueOak-1.0.0 1.
The MPL-2.0 entries are `lightningcss` and its optional platform binaries and the BlueOak-1.0.0 entry is
`minimatch`; all are **dev-only** (test/lint tooling), not part of the runtime dependency set.

## Container image

`postgres:17.11-alpine` (PostgreSQL License; Alpine base packages under their own licenses). Used locally and
in CI only; not redistributed by this project.
