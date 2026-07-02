---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-02
scope_description: "Backend foundation for video upload and processing: object storage backend, resumable 10GB upload protocol, background job queue, worker process topology, FFmpeg integration for metadata/thumbnail extraction, unique public video ID generation, and streaming/download delivery."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the storage service, upload endpoints, video draft pre-registration, processing queue, worker, metadata/thumbnail extraction, unique URL generation, and streaming/download delivery. All seven TDs below cover it.
- `next-frontend/` — affected only through the two Cross-layer contracts (TD-02 upload protocol, TD-07 streaming/download delivery), which fix the client-side library and handshake. Phase 03 has no screen capability bullets (upload/management UI arrives with Fase 04's panel); no Frontend-only open decision exists in this document.

---

## TD-01: Object Storage Backend (dev/prod S3-compatible store)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The C4 architecture fixes the container type as "Object Storage (S3/MinIO)" — an S3-compatible API — but not which implementation runs in the local Docker Compose environment, nor which SDK the API/worker use to talk to it. Videos up to 10GB rule out DB storage; the choice must support multipart uploads, Range reads, and presigned URLs, since TD-02 and TD-07 build on those primitives.

**Options:**

### Option A: MinIO container + AWS SDK v3 (`@aws-sdk/client-s3`)
- Single-binary S3-compatible server, official Docker image, first-class multipart and presigned URL support. The app talks pure S3 API via AWS SDK v3, so swapping to real S3 (or any compatible store) in production is a config change.
- **Pros:** De-facto standard for local S3 development; matches the architecture diagram verbatim. AWS SDK v3 is modular and actively maintained. Fully supported as a `@tus/s3-store` and presigned-URL target. Admin via `mc` CLI works fine headless.
- **Cons:** In 2025 MinIO stripped nearly all management features from the Community Edition web console (object browser only) — admin tasks must go through the `mc` CLI or IaC; the community expressed trust concerns about the project's direction. AGPL license (irrelevant for internal dev use).

### Option B: Alternative self-hosted S3-compatible store (Garage or SeaweedFS)
- Community-driven S3-compatible servers that gained adoption after the MinIO console controversy. Same integration path (AWS SDK v3).
- **Pros:** No commercial upsell pressure; Garage is lightweight and designed for self-hosting.
- **Cons:** Less complete S3 API coverage (multipart edge cases, presigned URL semantics) — riskier as the substrate under `@tus/s3-store`; far less documentation and community examples; not named in the project's architecture diagram.

### Option C: Local filesystem volume served by the API
- Store files on a Docker volume; the NestJS API reads/writes the filesystem directly and serves bytes itself.
- **Pros:** Zero new containers; simplest possible dev setup.
- **Cons:** Diverges from the architecture diagram (dedicated Object Storage container); no multipart/presigned primitives, forcing all upload and streaming traffic through the API process — directly conflicts with the "sem impacto na performance" requirement; a prod migration to S3 later would rewrite the storage layer.

**Recommendation:** **Option A (MinIO + AWS SDK v3)** — it is the literal store named in the architecture diagram, the only option with battle-tested multipart/presigned behavior under `@tus/s3-store` (TD-02) and presigned Range reads (TD-07). The 2025 Community Edition console gutting does not affect programmatic S3 API usage, which is all this project needs; bucket provisioning is scriptable via `mc` in the Compose setup. Per Docker networking convention, the service host is the Compose service name (e.g., `storage`), never `localhost`.

**Decision:** A (MinIO + AWS SDK v3)

---

## TD-02: Upload Protocol for 10GB Resumable Uploads
<!-- status: superseded-by: phase-03-videos/TD-08 -->

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The project plan's "Pontos de Atenção" makes resumability an explicit requirement ("permita retomar em caso de falha de conexão") for files up to 10GB. The protocol is a cross-layer contract: it fixes the client library and handshake on the frontend and the endpoint/storage wiring on the backend. It also determines *where* the draft pre-registration hook lives (the video row must be created as `draft` when the upload starts). Depends on TD-01 (assumes an S3-compatible store).

**Options:**

### Option A: tus protocol — `@tus/server` + `@tus/s3-store` mounted in NestJS; `tus-js-client`/Uppy on the frontend
- The open resumable-upload standard over HTTP. The Node server mounts as a request handler inside the existing Express-based Nest app; `@tus/s3-store` translates tus chunks into S3 multipart parts (auto-computing part size to respect S3's 10,000-part limit). Client uses `tus-js-client` (or Uppy's tus plugin) with automatic retry/resume.
- **Pros:** Resumability is the protocol's core feature, not custom code. Battle-tested at scale (Supabase Storage uses tus-node-server for 50GB files). Server-side hooks (`onUploadCreate`/`onUploadFinish`) are the natural seams for draft pre-registration and for enqueueing the processing job. v2.0.0 (2025) is actively maintained; ESM-only but consumable from the CommonJS Nest build on Node ≥20.19 via `require(esm)` — the project runs Node 25.6.
- **Cons:** Upload bytes flow through the API container (mitigated: the store streams parts to S3 with bounded buffering, so memory stays flat; CPU-bound processing is elsewhere per TD-04). One more protocol concept in the codebase. ESM-only dependency is a first for `nestjs-project`.

### Option B: S3 presigned multipart URLs — API orchestrates, browser uploads parts directly to storage
- API exposes endpoints to initiate a multipart upload, mint presigned part URLs, and complete/abort; the browser PUTs each part straight to MinIO/S3. Draft pre-registration happens in the "initiate" endpoint.
- **Pros:** Upload bytes bypass the API entirely — best raw scalability; no new server dependency.
- **Cons:** Resume, part bookkeeping, retry, and abort-cleanup logic must be hand-built on both sides (a substantial custom protocol). The storage endpoint must be directly reachable from the browser with a hostname valid both for signature and network path — awkward under the project's Docker networking (service-name vs. host-published URL). CORS configuration on the store becomes part of the contract.

### Option C: Custom chunked upload endpoints through the API
- Hand-rolled REST endpoints (`POST /uploads`, `PATCH /uploads/:id` with chunk offsets) persisting chunk state in PostgreSQL and assembling to storage.
- **Pros:** Full control; no new dependencies beyond what exists.
- **Cons:** Reimplements tus poorly — offset tracking, integrity, expiry, and resume semantics are exactly what the tus spec standardizes; highest maintenance and bug surface for zero differentiated value.

**Recommendation:** **Option A (tus)** — resumability for 10GB files is a hard requirement, and tus delivers it as a standardized, maintained protocol with an S3 store that already solves part-sizing, plus server hooks that map one-to-one onto the phase's draft pre-registration capability. Option B's direct-to-storage scalability is not worth hand-building resume logic and solving browser-reachable presigned hostnames at this project's scale.

**Decision:** A (tus — `@tus/server` + `@tus/s3-store` + `tus-js-client`)

---

## TD-03: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture lists "Message Queue (TBD)" — this TD resolves the TBD. After upload completion, a processing job (metadata extraction, thumbnail generation) must run in the background with retries. The choice determines whether a new infrastructure container (Redis/RabbitMQ) joins the Compose stack or the existing PostgreSQL doubles as the queue.

**Options:**

### Option A: BullMQ + Redis, via `@nestjs/bullmq`
- Redis-backed job queue with the official NestJS integration (`@Processor`/`@InjectQueue` decorators, documented in NestJS's own techniques guide). Supports retries with backoff, job progress, delayed jobs, and flows.
- **Pros:** Canonical NestJS queue solution — first-party docs and decorators match the project's module conventions. Rich retry/backoff/progress semantics fit long-running video jobs. Mature observability (Bull Board). Redis is a small, standard container.
- **Cons:** Adds Redis as new infrastructure (one more Compose service, one more thing in CI/test env). Job state lives outside PostgreSQL — enqueue-after-commit discipline needed to avoid jobs referencing uncommitted rows.

### Option B: pg-boss (queue on the existing PostgreSQL)
- Job queue implemented on PostgreSQL with `SKIP LOCKED`; no new infrastructure. Jobs can be enqueued inside the same DB transaction that updates the video row (ACID).
- **Pros:** Zero new containers; transactional enqueue eliminates the commit/enqueue race by construction; one less moving part in tests.
- **Cons:** No official NestJS integration — custom provider/wiring, diverging from framework idiom. Fewer features (no native progress reporting, weaker dashboard story). Couples queue throughput to the primary database.

### Option C: RabbitMQ (Nest microservices transport or `@golevelup/nestjs-rabbitmq`)
- Full message broker with exchanges/routing; the worker consumes over AMQP.
- **Pros:** True broker semantics, language-agnostic if a non-Node worker ever appears; solid delivery guarantees.
- **Cons:** Heaviest option — broker concepts (exchanges, acks, DLX) are overkill for a single job type; job-queue niceties (retries with backoff, progress) must be assembled from primitives; heavier container than Redis.

**Recommendation:** **Option A (BullMQ + Redis via `@nestjs/bullmq`)** — it is the framework-idiomatic choice with first-party NestJS documentation, and its retry/backoff/progress model matches long-running FFmpeg jobs. pg-boss is honestly viable at this project's scale and avoids Redis, but the official integration, ecosystem examples, and the architecture's explicit "Message Queue" container tip the balance to BullMQ; the transactional-enqueue gap is handled by enqueueing only after commit.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

---

## TD-04: Video Worker Process Topology

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The C4 diagram shows a dedicated "Video Worker (FFmpeg)" container, but how that container is implemented is open: same codebase or separate project, same process as the API or isolated. FFmpeg work is CPU-heavy — running it inside the API process would violate the "sem impacto na performance" requirement. Depends on TD-03 (the worker consumes whatever queue is chosen).

**Options:**

### Option A: Queue processors registered in the API process
- The `@Processor` classes live in the same NestJS app that serves HTTP; one container does both.
- **Pros:** Simplest wiring — no second entrypoint or Compose service; shared DI, entities, and config for free.
- **Cons:** FFmpeg saturates CPU in the same process/container serving requests — directly contradicts the phase's performance requirement and the C4 diagram; cannot scale worker and API independently.

### Option B: Separate worker entrypoint in `nestjs-project` (standalone Nest application context, own Compose service)
- A second entrypoint (e.g., `src/worker.ts` bootstrapping `NestFactory.createApplicationContext` with a `WorkerModule`) compiled from the same codebase, run as a distinct Compose service with FFmpeg installed in its image.
- **Pros:** Full process/container isolation of CPU load, matching the C4 diagram; reuses entities, TypeORM config, and the storage/queue modules with zero duplication; independent scaling and restart policy; stays one subproject (no monorepo tooling changes).
- **Cons:** Two entrypoints in one project — build and Compose config must distinguish them; care needed to keep HTTP-only providers out of the worker's module graph.

### Option C: Separate subproject (e.g., `video-worker/`)
- A new top-level project with its own `package.json`, sharing nothing (or a future shared package) with `nestjs-project`.
- **Pros:** Hard boundary; worker dependencies (FFmpeg, queue consumer) fully separate from the API's.
- **Cons:** Entities, DB config, and storage client would be duplicated or require introducing monorepo workspace tooling — a Repo-wide decision Phase 03 doesn't need; highest setup cost for no current benefit.

**Recommendation:** **Option B (separate entrypoint, same codebase, own Compose service)** — it delivers the process isolation the performance requirement and the C4 diagram demand, at the cost of one extra bootstrap file instead of a whole new project. Option C's boundary only pays off if the worker ever leaves TypeScript/Nest, which nothing on the roadmap suggests.

**Decision:** B (separate worker entrypoint in `nestjs-project`, own Compose service)

---

## TD-05: FFmpeg/ffprobe Integration Strategy

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must run `ffprobe` (duration/metadata as JSON) and `ffmpeg` (extract one frame as thumbnail). The decision is how the Node process obtains and invokes the binaries — a maintained wrapper library no longer exists, so this is now a real choice with a deprecated default.

**Options:**

### Option A: System FFmpeg installed in the worker Docker image + direct `child_process.execFile`
- The worker's Dockerfile installs the distro `ffmpeg` package; the code spawns `ffprobe -print_format json -show_format -show_streams` and `ffmpeg -ss <t> -i <in> -frames:v 1 <out>` directly via `execFile`, parsing stdout.
- **Pros:** No dependency on any (un)maintained npm wrapper; binary version pinned by the image, identical in dev/CI/prod — canonical for a Docker-first project; `execFile` avoids shell-injection risk; trivial to add flags later.
- **Cons:** Command lines and JSON parsing are hand-written (small, but ours to own); binary availability is invisible to `package.json` — it lives in the Dockerfile.

### Option B: `fluent-ffmpeg` wrapper
- The historical de-facto Node API over ffmpeg/ffprobe (chainable command builder, `ffprobe()` helper).
- **Pros:** Ergonomic API; enormous body of existing examples.
- **Cons:** **Archived May 2025 and explicitly phased out by its maintainers** — no fixes for incompatibilities with recent FFmpeg releases; adopting a dead dependency in a greenfield phase creates immediate legacy.

### Option C: npm-distributed static binaries (`ffmpeg-static` + `ffprobe-static`) + direct spawn
- Binaries ship as npm packages; code spawns them by resolved path.
- **Pros:** Binary presence tracked by `package.json`; works on hosts without FFmpeg installed.
- **Cons:** Redundant in this project — all execution happens inside containers, so the Dockerfile already controls the environment; static builds lag distro security updates and bloat `node_modules` by ~70MB per platform.

**Recommendation:** **Option A (system FFmpeg in the worker image + direct `execFile`)** — with `fluent-ffmpeg` archived, a thin in-house invocation module (~2 commands) is smaller than any wrapper's risk surface, and the Docker-only development rule in this repo makes image-level binary pinning the natural distribution channel. The npm-static route (C) solves a "no Docker" problem this project doesn't have.

**Decision:** A (system FFmpeg in worker image + direct `execFile`)

---

## TD-06: Public Video ID / Unique URL Generation

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a short, unique, never-conflicting public URL. The plan's "Pontos de Atenção" adds "curta e única". A forward constraint from Fase 04/05: unlisted videos are reachable *only* by link — so the public ID must be non-enumerable (guessing IDs must be infeasible). The internal primary key (existing convention: UUID) stays; this TD decides the public-facing identifier. The frontend consumes it as an opaque string, so no cross-layer contract beyond "string in the URL path".

**Options:**

### Option A: `nanoid` with custom alphabet (~11 chars, YouTube-style) + unique column + collision retry
- Generate an 11-char ID from a URL-safe alphabet using `nanoid`'s `customAlphabet`, store it in a unique-indexed column, retry on the (astronomically rare) unique-violation.
- **Pros:** Short URLs like YouTube's; cryptographically random → non-enumerable, satisfying the unlisted-video constraint; collision probability negligible at this scale, with the DB unique constraint as an absolute guarantee; nanoid v5 is ESM-only but works from the CommonJS Nest build on Node 25.6 via `require(esm)` (v3 remains a CJS fallback).
- **Cons:** One extra column + index beside the PK; theoretical retry path to test.

### Option B: Expose the UUIDv4 primary key in the URL
- Reuse the row's UUID as the public identifier.
- **Pros:** Zero new code or columns; uniqueness guaranteed by the PK; non-enumerable (122 random bits).
- **Cons:** 36-char URLs directly contradict the plan's "URL curta" attention point; ugly to share; couples the public contract to the internal PK forever.

### Option C: DB sequence encoded as base62
- A `BIGSERIAL` encoded to a short string (like early URL shorteners).
- **Pros:** Shortest possible IDs; zero collision handling.
- **Cons:** Sequential → fully enumerable, which **breaks the unlisted-video requirement** of Fase 04/05 (anyone can crawl `/videos/1..n`); mitigating with encryption/obfuscation re-adds the complexity Option A already solves cleanly.

**Recommendation:** **Option A (`nanoid` custom alphabet + unique constraint)** — the only option that is simultaneously short (plan requirement) and non-enumerable (unlisted-link requirement inherited by Fases 04/05), at the cost of one column. Option C is disqualified by enumerability; Option B by URL length.

**Decision:** A (`nanoid` custom alphabet + unique constraint)

---

## TD-07: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file — for progressive MP4 over HTTP this means Range-request support end-to-end — and the user must be able to download the file. The C4 diagram already draws the frontend "streaming from Object Storage" directly. Cross-layer: the choice fixes what URL the player/download button receives and who serves the bytes. Depends on TD-01.

**Options:**

### Option A: Presigned GET URLs served directly by the object storage
- The API endpoint returns a short-lived presigned URL; the `<video>` tag streams straight from MinIO/S3, which handles `Range` natively. Download reuses the same mechanism with `response-content-disposition=attachment` baked into the signature.
- **Pros:** Matches the C4 diagram verbatim; video bytes never transit the API (Node process stays free for requests — the phase's performance theme); Range/206 handling is the storage server's, not ours; download is a one-parameter variant of the same code path.
- **Cons:** The storage's public endpoint must be reachable from the browser AND match the signed hostname — under Docker Compose this requires publishing the storage port and signing against the host-visible endpoint (a known MinIO dev-setup point, solvable with a dedicated public-endpoint config, but it must be configured deliberately); access-control granularity is "whoever holds a fresh URL".

### Option B: Proxy streaming through the NestJS API
- An API endpoint reads from storage and pipes to the response, parsing `Range` headers and emitting 206 responses itself (`StreamableFile`).
- **Pros:** Single origin (no storage exposure, no CORS/hostname concerns); per-request auth checks on every byte range — finest access control.
- **Cons:** Every video byte flows through Node — for 10GB files and concurrent viewers this is exactly the load the phase mandates keeping off the API; hand-rolled Range/206 logic is subtle and easy to get wrong; doubles internal network traffic.

### Option C: HLS packaging (transcode to segments + playlist; player streams segments)
- The worker transcodes uploads into HLS renditions; playback uses an HLS-capable player.
- **Pros:** The industry standard for adaptive streaming; enables quality switching and CDN-friendly segments.
- **Cons:** Requires a full transcoding pipeline (multi-rendition FFmpeg jobs, segment storage, playlist management) and an HLS player — far beyond this phase's capabilities, which require only "playback without full download"; progressive MP4 + Range already satisfies that. Best treated as a future phase if adaptive quality ever becomes a requirement.

**Recommendation:** **Option A (presigned GET direct from storage)** — it is the architecture the C4 diagram already draws, keeps 10GB byte streams off the Node process, and gets correct Range semantics for free from the storage server; the browser-reachable-endpoint caveat is a one-time Compose/config task. Download rides the same mechanism via `response-content-disposition`. HLS is deliberately out of scope for this phase.

**Decision:** A (presigned GET direct from storage)

---

## TD-08: Upload Protocol — Reconsidered under Strict-BFF Constraint

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** During `/plan-validate 03`, an Inherited Constraint Conflict (`ICC-1`) was raised: TD-02's chosen approach (tus, with `tus-js-client` running in the browser talking directly to the NestJS backend's `@tus/server` endpoint) contradicts the **Strict-BFF** convention decided in `next-frontend-config-base/TD-03` and inherited from Phase 02. That constraint is not merely a stylistic convention — it is structural: `API_URL` is deliberately kept a **server-only** env key (never `NEXT_PUBLIC_API_URL`), so the browser has no way to address the NestJS backend at all under the current env-key contract. For `tus-js-client` to reach NestJS directly, a new public key exposing the backend's URL would have to be introduced, reversing the exact guarantee TD-03 was designed to provide (no CORS exposure, no public backend URL, single BFF entrypoint). This TD reconsiders TD-02's network topology — not the "must be resumable" requirement, which stands unchanged. Depends on TD-01 (assumes an S3-compatible store).

**Options:**

### Option A: Presigned S3 multipart upload, browser-to-storage direct (Uppy `@uppy/aws-s3`)
- Drop tus. The browser uploads parts directly to MinIO/S3 via presigned part URLs, using Uppy's `@uppy/aws-s3` plugin (mature multipart support: resume, retry, and part-listing for resume-after-refresh, since S3 itself is the source of truth for uploaded parts). NestJS exposes only small JSON control-plane endpoints (initiate multipart upload + create draft row, sign each part, complete/abort) — all trivially proxied through existing Next.js Route Handlers, matching the Strict-BFF model with zero exceptions. This is the same "browser talks directly to Object Storage" pattern the architecture already uses for TD-07 (streaming) and already anticipates in its env-key model (a future public storage/CDN host key).
- **Pros:** Zero conflict with Strict-BFF — reuses an already-accepted architectural pattern instead of inventing a new exception. No new hop, no proxying of multi-GB streams through Next.js or NestJS — matches the phase's "sem impacto na performance" requirement even more cleanly than TD-02's original tus approach. Uppy's `@uppy/aws-s3` is actively maintained with real resume/retry semantics.
- **Cons:** Loses tus's protocol-level standardization (resumability logic lives in Uppy's plugin + a purpose-built NestJS multipart-orchestration endpoint, not an off-the-shelf spec-compliant server). Draft pre-registration hook moves from a tus server hook (`onUploadCreate`) to the "initiate multipart upload" endpoint — a small design shift, not a new capability gap.

### Option B: tus proxied through Next.js Route Handlers (BFF relay)
- Keep tus and `@tus/server`, but the browser's `tus-js-client` talks to a Next.js Route Handler, which forwards (streams) PATCH/HEAD/POST requests — including tus-specific headers (`Upload-Offset`, `Tus-Resumable`, `Upload-Length`) — to NestJS's tus endpoint over the internal Docker network.
- **Pros:** Preserves TD-02's original protocol choice and its resumability guarantees unchanged; fully compliant with Strict-BFF (browser never learns the NestJS URL).
- **Cons:** Next.js Route Handlers are not designed as raw byte relays — the framework's request-body model (Web Streams API) can technically stream, but doubles internal network traffic for the full 10GB (ingress → Next.js → NestJS) for zero functional benefit (Next.js does not process the bytes, only relays them); tus's incremental PATCH semantics and header set must be forwarded byte-for-byte and header-for-header without introducing buffering, which is easy to get subtly wrong and hard to test. This project is self-hosted (not a serverless deployment with hard payload-size ceilings), which makes the relay *feasible*, but it is meaningfully more implementation and testing surface than Option A for a protocol whose only purpose (resumability) Option A already delivers via Uppy.

### Option C: Narrow public upload-only key (keep tus, expose a scoped endpoint, not the full API)
- Keep TD-02's original tus approach, but instead of reusing the server-only `API_URL`, introduce a new, narrowly-scoped public key (e.g., `NEXT_PUBLIC_UPLOAD_URL`) that exposes only the tus ingress path — not the full NestJS API surface.
- **Pros:** Zero extra network hop; tus's resumability semantics stay exactly as originally researched; the "leak" is scoped to one upload endpoint rather than the whole backend.
- **Cons:** Still a documented exception to Strict-BFF (the browser gains a second way to reach the NestJS container, even if narrow) — the same trust-boundary and CORS-configuration concerns TD-03 was written to eliminate reappear, just smaller in surface. Sets a precedent that future phases may be tempted to extend ("just one more narrow public endpoint").

**Recommendation:** **Option A (presigned S3 multipart via Uppy, browser-to-storage direct)** — it is the only option that resolves the Strict-BFF conflict by construction rather than by exception, reusing the exact pattern the architecture already accepts for TD-07 and already anticipates in its env-key model. It also removes 10GB of byte traffic from both Next.js and NestJS entirely, which is a strictly better fit for the phase's performance requirement than even TD-02's original tus design. Option B is technically feasible in this self-hosted project but adds a full relay layer for no functional gain over Option A. Option C keeps tus's semantics but only shrinks the Strict-BFF exception instead of eliminating it.

**Decision:** A (presigned S3 multipart upload, browser-to-storage direct via Uppy `@uppy/aws-s3`)
**Libraries:** @uppy/core, @uppy/aws-s3

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Object storage backend | **A** (MinIO + AWS SDK v3) | **A** |
| TD-02 | Cross-layer | Upload protocol for 10GB resumable uploads | **A** (tus — `@tus/server` + `@tus/s3-store` + `tus-js-client`) | _superseded by TD-08_ |
| TD-03 | Backend | Background job queue technology | **A** (BullMQ + Redis via `@nestjs/bullmq`) | **A** |
| TD-04 | Backend | Video worker process topology | **B** (separate entrypoint in `nestjs-project`, own Compose service) | **B** |
| TD-05 | Backend | FFmpeg/ffprobe integration strategy | **A** (system FFmpeg in worker image + direct `execFile`) | **A** |
| TD-06 | Backend | Public video ID / unique URL generation | **A** (`nanoid` custom alphabet + unique constraint) | **A** |
| TD-07 | Cross-layer | Streaming and download delivery | **A** (presigned GET direct from storage) | **A** |
| TD-08 | Cross-layer | Upload protocol — reconsidered under Strict-BFF constraint | **A** (presigned S3 multipart via Uppy, browser-to-storage direct) | **A** |

---

## Notes for downstream pipeline

- **Dependency chain:** TD-02 and TD-07 depend on TD-01 (both assume an S3-compatible store with multipart + presigned support). TD-04 depends on TD-03 (the worker consumes the chosen queue). If TD-01 swings away from an S3-compatible store (Option C), TD-02 Option A and TD-07 Option A become unavailable and both TDs must be revisited.
- **Draft pre-registration** (capability "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload") is deliberately not a separate TD: under TD-02's recommendation it is the `onUploadCreate` hook; under Option B it would be the "initiate" endpoint. The mechanism follows the protocol choice. **If TD-08 is decided in favor of Option A, this hook moves to the "initiate multipart upload" endpoint described in TD-08 — TD-02's `onUploadCreate` reference becomes moot.**
- **Compose surface if recommendations are accepted:** new services `storage` (MinIO) and `redis`, plus a `video-worker` service built from `nestjs-project` with FFmpeg in its image. Per repo convention, all inter-service hosts use Compose service names, never `localhost`. TD-07's presigned URLs are the one place a host-visible endpoint (browser-facing) must be configured explicitly. **If TD-08 Option A is chosen, this host-visible endpoint requirement extends to TD-08 as well — both TD-07 and TD-08 then share the same public storage endpoint.**
- **ESM note:** `@tus/server` v2 and `nanoid` v5 are ESM-only; both are consumable from the CommonJS Nest build on the project's Node 25.6 via `require(esm)`. If this proves problematic in practice, `nanoid` v3 is a CJS fallback; tus has no CJS fallback in v2 (v1.x would be the pin). **This note becomes moot for the upload path if TD-08 Option A (drop tus) is chosen — it would still apply to `nanoid` (TD-06) regardless.**
- **Env/config surface:** new namespaced configs (per `phase-01-configuracao-base/TD-03`) for storage (endpoint, public endpoint, credentials, bucket) and queue (Redis host/port), validated in the existing Joi schema (`phase-01-configuracao-base/TD-02`), mirrored in `.env.example` and `compose.yaml`.
- **Context7 was unavailable in this session** (MCP server not connected); research was grounded in official documentation via web search instead. Version-sensitive claims to re-verify at implementation time: `@tus/server`/`@tus/s3-store` v2.x APIs, `@nestjs/bullmq` current major against NestJS 11, `nanoid` v5 `require(esm)` behavior, `@uppy/aws-s3` current multipart/resume API (TD-08).
- **TD-08 reconsiders TD-02** (raised as `ICC-1` by `/plan-validate 03`, resolved via `/plan-resolve 03` on 2026-07-02 by reopening research rather than patching TD-02 in place). TD-02's own `**Decision:** A` field is left untouched — it remains the historical record of the original decision. If TD-08 is decided in favor of an option that changes the effective network topology (Options A or B both effectively change or clarify what TD-02 originally specified), `/plan-resolve` should inject `<!-- status: superseded-by: phase-03-videos/TD-08 -->` immediately after the `## TD-02:` heading per the standard supersede convention — this document does not inject that marker itself (owned by `/plan-resolve`, not `/research`).

Sources consulted during research (TD-01..TD-07):

- [tus-node-server v2.0.0 announcement](https://tus.io/blog/2025/03/25/tus-node-server-v200) — ESM-only, Node ≥20.19, framework-agnostic handler.
- [tus-node-server repository](https://github.com/tus/tus-node-server) and [@tus/s3-store](https://www.npmjs.com/package/@tus/s3-store) — S3 store part-sizing and 10,000-part handling; Supabase production usage.
- [NestJS Queues documentation](https://docs.nestjs.com/techniques/queues) — official `@nestjs/bullmq` integration.
- [BullMQ](https://bullmq.io/) and [pg-boss vs alternatives discussion](https://github.com/timgit/pg-boss/issues/94) — queue trade-offs.
- [fluent-ffmpeg phase-out issue](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/issues/1324) — archived May 2025, explicitly not recommended for new projects.
- [MinIO Community Edition web UI removal](https://github.com/minio/minio/issues/21584) and [Blocks & Files coverage](https://www.blocksandfiles.com/ai-ml/2025/06/19/minio-users-complain-after-admin-ui-removed-from-community-edition/1610856) — scope of the 2025 console changes (API unaffected).
- [nanoid](https://github.com/ai/nanoid) — v5 ESM-only status, CJS guidance, custom alphabets.

Sources consulted during research (TD-08):

- [Uppy AWS S3 plugin docs](https://uppy.io/docs/aws-s3/) — multipart upload, presigned URL signing.
- [Uppy S3 multipart resume/retry discussion](https://github.com/transloadit/uppy/issues/2121) and [resume-after-refresh via S3-as-source-of-truth](https://community.transloadit.com/t/resumable-aws-s3-multipart-integration/14888) — resumability implementation pattern.
- [Next.js `proxyClientMaxBodySize` config](https://nextjs.org/docs/app/api-reference/config/next-config-js/proxyClientMaxBodySize) — default 10MB request-body buffering limit relevant to Option B's relay feasibility.
- [Next.js Route Handlers reference](https://nextjs.org/docs/app/api-reference/file-conventions/route) — Web Streams API body handling, runtime constraints.
- `next-frontend-config-base/TD-03` (in-repo) — Strict-BFF env-key contract (`API_URL` server-only) that TD-08 reconciles against.
