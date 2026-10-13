# Legacy editor tier compatibility

Release preflight for `4dfe99f` found that existing generated EditProjects did not store an origin tier. The new fail-closed editor policy would therefore treat older Pro projects as Free and disable their Pro AI route.

The minimal fix projects missing provenance in memory from the project's server-owned generated-clip relation. The clip must belong to the same owner. Clip telemetry takes precedence; otherwise the original completed processing job supplies its recorded effective mode. Historical clips without a job link may use only a completed job created and started before the clip. A later rerun cannot promote an older Free clip. Unknown lineage remains fail-closed. Explicitly recorded tiers and standalone-editor consent behavior stay unchanged.

The editor getter and consent guard share this projection. No migration, database backfill, provider threshold, generation engine, renderer or credit behavior changes.

Validation: 10 compatibility checks; 59 Free engine and 14 provider-policy checks; backend type check; six affected editor suites; 28 isolated database auth/ownership/credit integration cases. A read-only audit of 78 existing production generated projects resolved 70 Pro and 8 Free projects with zero database writes. Tests cover a newer Pro job following an original Free job, foreign source records, tier injection, consent enforcement and effective-Free precedence.

Preflight artifacts are retained in the ignored `.real-qa-preview/xeefree/deployment-4dfe99f/` folder in the original project. Real media must be reported separately: a two-person StyleTwo framing failure reproduces with the current production backend image, and the long credentials clip has the identical 5.46–52.38-second selection on that baseline. A withheld Free hook is not a passing automatic-hook result. Earlier authored speech/title-card fixtures do not certify human speakers. Hindi/Hinglish and the optional incomplete local medium ASR model remain uncertified.
