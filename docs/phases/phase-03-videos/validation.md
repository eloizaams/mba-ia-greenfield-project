---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-02T17:26:28-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-02T17:24:35-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Thumbnail frame-selection strategy and edge cases (short/black video) unspecified"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Video entity field boundary between Phase 03 draft and Phase 04 editing unspecified"
    resolved_by: clarification
  - id: ICC-1
    status: resolved
    summary: "TD-02 (tus) has browser calling NestJS directly, conflicting with inherited Strict-BFF"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-1
    status: resolved
    summary: "TD-08 pending — Upload Protocol Reconsidered under Strict-BFF Constraint"
    resolved_by: phase-03-videos/TD-08
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._ _(TD-02, the source of the prior conflict, is now `superseded-by phase-03-videos/TD-08` and excluded from current-scope TD checks; TD-08's decided approach — browser talks directly to Object Storage only, never to the NestJS API — does not conflict with the inherited Strict-BFF convention.)_

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(no UI scope in this phase — `## UI Inventory` not present in context.md)_

## Resolved Issues

- **AMB-1** _(resolved_by clarification)_ — Thumbnail frame-selection strategy clarified without a new TD: extract the frame at ~10% of video duration, with a 1s floor for short videos; apply a simple fallback (e.g., re-sample a nearby offset) if the selected frame is black/blank. Treated as an implementation detail for `/plan-build` to encode in the relevant SI, not a strategic decision.

- **AMB-2** _(resolved_by clarification)_ — Video entity draft-schema boundary clarified without a new TD: at pre-registration time (Phase 03, upload start), only `channel` (from the authenticated user), the storage/upload key, and `status = draft` are populated. `título`, `descrição`, `categoria`, and custom `thumbnail` remain nullable until Fase 04's video-info editing capability sets them.

- **ICC-1** _(resolved_by phase-03-videos/TD-08)_ — TD-02's browser-direct-to-NestJS tus approach conflicted with the inherited Strict-BFF convention. Resolved by reopening research: `phase-03-videos/TD-08` was created and decided as Option A (presigned S3 multipart upload via Uppy `@uppy/aws-s3`, browser-to-storage direct) — the browser now never addresses the NestJS backend for upload bytes, eliminating the conflict by construction. `<!-- status: superseded-by: phase-03-videos/TD-08 -->` was injected on TD-02's heading.

- **OQ-1** _(resolved_by phase-03-videos/TD-08)_ — TD-08 decided: Option A (presigned S3 multipart upload via Uppy, browser-to-storage direct). `**Libraries:** @uppy/core, @uppy/aws-s3` added.
