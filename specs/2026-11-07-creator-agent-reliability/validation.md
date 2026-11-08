# Validation (observed 2026-11-07, local Windows 11, Postgres 17.11 in Docker)

| Req | Evidence (test / scenario)                                                                      | Result                        |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------- |
| R1  | T-J4, T-A1 (unknown fields, foreign selectors, unknown actor → 400/404/401)                     | pass                          |
| R2  | T-J1 (job visible from an independent connection before work), smoke "202 after durable commit" | pass                          |
| R3  | T-J1, F03-01 (close app, poll, worker completes independently)                                  | pass                          |
| R4  | T-V1, T-V2, T-K1 (7 invalid output kinds → repair), F03-06, F03-07                              | pass                          |
| R5  | T-V3 (unapproved, unknown, mismatched, superseded, fake source, unclaimed digits)               | pass                          |
| R6  | T-K5, T-V4, F02-06                                                                              | pass                          |
| R7  | T-U3, T-K3, F03-05 (checkpoints/receipts reused)                                                | pass                          |
| R8  | T-C1..T-C6, F01-09, F03-08                                                                      | pass                          |
| R9  | T-J2, T-J3, T-A1, F03-02, F01-05 (semantic dedupe of user retry)                                | pass                          |
| R10 | T-K3, T-X (real process crash inside the final transaction), F03-03, F03-04                     | pass                          |
| R11 | T-J1, F03-01, smoke reopen checks (0 provider invocations during reopen)                        | pass                          |
| R12 | T-C3, T-U1..T-U3, T-X, smoke                                                                    | pass                          |
| R13 | T-U1..T-U3, T-C4 (receipt guard)                                                                | pass                          |
| R14 | T-U2, T-U4, T-U7, T-I1, F01-02, F01-03, F01-05                                                  | pass                          |
| R15 | T-U5, T-U6, C06, F01-08                                                                         | pass                          |
| R16 | T-P1, T-U8, routing cases RT01–RT08 (8/8 hardened, 4/8 baseline)                                | pass                          |
| R17 | T-K1, T-K2                                                                                      | pass                          |
| R18 | T-R1..T-R5 (non-superuser roles, FORCE RLS, cross-creator, no context, pool reuse)              | pass                          |
| R19 | T-A1 (trace sanitized), T-P4                                                                    | pass                          |
| R20 | `npm run evaluate:*` over 32 scenarios (6 controls, F01 10, F02 6, F03 10)                      | pass                          |
| R21 | baseline exit 3; hardened exit 0; T-S sentinels F01/F02/F03                                     | pass                          |
| R22 | `ci.yml`; hosted run #1 succeeded on `55aae03` (step conclusions only); smoke 13/13 locally     | pass (hosted: initial commit) |

Totals: `npm test` 8 files, 55 tests passed (local build; 58 after the demo-label regressions T-D1..T-D3).
Exit codes and timings: see `BUILD_REPORT.md`.

R22 hosted evidence (publication note, 2026-11-07): run
[#1](https://github.com/cameraphp/creator-agent-reliability-lab/actions/runs/42429152724) on commit
[`55aae03`](https://github.com/cameraphp/creator-agent-reliability-lab/commit/55aae0308b5fe15d2a32fff39f8c919c00a84d10);
hosted job logs were not read, so hosted counts are not independently confirmed.
