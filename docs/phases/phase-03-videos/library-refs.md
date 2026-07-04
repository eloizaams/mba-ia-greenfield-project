---
libs:
  "@uppy/core":
    version: "unresolved — Context7 unavailable this session"
    context7_id: "unresolved — Context7 unavailable this session"
    fetched_at: "2026-07-02T17:24:35-03:00"
  "@uppy/aws-s3":
    version: "unresolved — Context7 unavailable this session"
    context7_id: "unresolved — Context7 unavailable this session"
    fetched_at: "2026-07-02T17:24:35-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-02T17:24:35-03:00"
---

### @uppy/core

Core Uppy instance/plugin-runtime library — required host for any Uppy upload plugin, including `@uppy/aws-s3`. No direct config surface specific to this phase beyond mounting the `AwsS3` plugin (see below) and wiring `upload-success` / `error` events to the pre-registered draft video row (TD-08's "initiate multipart upload" endpoint response carries the draft's ID for this purpose).

**Context7 unavailable this session** — the MCP server was not connected (same limitation noted during `/research`). This section is grounded in official documentation retrieved via web search instead of Context7; re-verify the exact API surface at implementation time.

### @uppy/aws-s3

Uppy's S3 plugin for direct-to-S3 uploads (presigned URLs, single-PUT or multipart). Relevant for TD-08's Option A implementation:

- The plugin can call a **Companion** service (a small Node signing server) or a **custom signing function** you provide from your own backend for signing requests — in this project's case, the custom-signing-function path is the natural fit, since NestJS already owns the presigned-URL orchestration per TD-01 (AWS SDK v3) and TD-08.
- Multipart-relevant methods to implement on the NestJS side and wire into the plugin's custom signer: `createMultipartUpload`, `signPart` (renamed from `prepareUploadPart` in a recent major — verify current name against the installed version at implementation time), `listParts` (enables resume-after-refresh, since S3 itself becomes the source of truth for already-uploaded parts), and `completeMultipartUpload`.
- **Note on package history:** a separate `@uppy/aws-s3-multipart` package existed historically; multipart support has since been folded into `@uppy/aws-s3` in recent Uppy majors. Confirm the installed major's package boundary at implementation time — do not assume `@uppy/aws-s3-multipart` is still the correct import.

**Context7 unavailable this session** — grounded in official Uppy docs (`https://uppy.io/docs/aws-s3/`) via web search, not Context7. Version-sensitive claims to re-verify at implementation time: exact npm version to pin, `signPart` vs `prepareUploadPart` naming for the installed major, and whether the multipart API surface still requires `@uppy/aws-s3-multipart` as a separate package.

Sources consulted:
- [Uppy AWS S3 docs](https://uppy.io/docs/aws-s3/) — plugin overview, Companion vs custom-signer paths.
- [Uppy migration guides](https://uppy.io/docs/guides/migration-guides/) — `prepareUploadPart` → `signPart` rename, `@uppy/aws-s3-multipart` merge history.
- [@uppy/aws-s3 npm](https://www.npmjs.com/package/@uppy/aws-s3) and [@uppy/aws-s3-multipart npm](https://www.npmjs.com/package/@uppy/aws-s3-multipart) — package boundary reference (check current version there at implementation time).
