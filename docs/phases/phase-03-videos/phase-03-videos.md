---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-02T17:26:28-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-02T17:27:52-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-02T17:24:35-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-02T15:02:19-03:00"
---

# Fase 03 — Upload e Processamento de Vídeos

## Objective

Entrega upload de vídeos de até 10GB sem impacto na performance, pré-cadastro automático do vídeo como rascunho ao iniciar o upload, processamento automático em segundo plano (extração de duração/metadados e geração de thumbnail), geração de URL única por vídeo, e reprodução via streaming/download — cobrindo o serviço de armazenamento de arquivos (vídeos e thumbnails) e o serviço de processamento em segundo plano (filas).

---

## Step Implementations

<!-- SIs will be written in Phase B -->

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| publicId | varchar(11) | unique, not null (per `phase-03-videos/TD-06` — `nanoid` custom alphabet, collision retry) |
| channelId | uuid | FK → Channel, not null (owner) |
| status | enum(`draft`, `processing`, `ready`, `failed`) | not null, default `draft` |
| storageKey | varchar | not null (object key in the storage bucket per `phase-03-videos/TD-01`) |
| uploadId | varchar | nullable (S3 multipart upload id per `phase-03-videos/TD-08`; cleared once the upload completes) |
| title | varchar | nullable (set by a future phase's video-info editing capability) |
| description | text | nullable (set by a future phase's video-info editing capability) |
| category | varchar | nullable (set by a future phase's video-info editing capability) |
| thumbnailKey | varchar | nullable (populated by the worker's auto-generated thumbnail per `phase-03-videos/TD-05`; overridable by a future phase's custom-thumbnail capability) |
| durationSeconds | integer | nullable (populated by `phase-03-videos/TD-05`'s ffprobe extraction) |
| metadata | jsonb | nullable (raw ffprobe output — resolution, codec, bitrate, format — per `phase-03-videos/TD-05`) |
| createdAt | timestamptz | default now() |
| updatedAt | timestamptz | default now(), auto-update on write |

**Relations:** `Video` belongs to `Channel` (many-to-one); `Channel` has many `Video` (one-to-many).
**Indexes:** unique on `publicId`; index on `channelId`; index on `status`.

### API Contracts

#### POST /videos/uploads (SI-NN.X)

**Request headers:**
- Content-Type: application/json

**Request body:**
- filename: string, required
- contentType: string, required

**Response 201:**
- videoId: string (publicId)
- uploadId: string (S3 multipart upload id)
- storageKey: string

**Error responses:**
- 502 STORAGE_PROVISIONING_ERROR: when the storage provider fails to create the multipart upload (per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`)
- 400 validation error: when the request body fails schema validation

---

#### POST /videos/uploads/:videoId/parts (SI-NN.X)

**Request headers:**
- Content-Type: application/json

**Request body:**
- partNumber: integer, required

**Response 200:**
- url: string (presigned part upload URL, per `phase-03-videos/TD-08`)

**Error responses:**
- 404 UPLOAD_NOT_FOUND: when `videoId` does not match an in-progress upload
- 409 UPLOAD_ALREADY_COMPLETED: when the upload has already been completed or aborted

---

#### GET /videos/uploads/:videoId/parts (SI-NN.X)

**Response 200:**
- parts: array of `{ partNumber: integer, eTag: string }` — the storage-provider source of truth for already-uploaded parts, enabling resume-after-refresh (per `phase-03-videos/TD-08`)

**Error responses:**
- 404 UPLOAD_NOT_FOUND: when `videoId` does not match an in-progress upload

---

#### POST /videos/uploads/:videoId/complete (SI-NN.X)

**Request headers:**
- Content-Type: application/json

**Request body:**
- parts: array of `{ partNumber: integer, eTag: string }`, required

**Response 200:**
- videoId: string (publicId)
- status: string (`processing`)

**Error responses:**
- 404 UPLOAD_NOT_FOUND: when `videoId` does not match an in-progress upload
- 409 UPLOAD_ALREADY_COMPLETED: when the upload has already been completed or aborted
- 502 STORAGE_PROVISIONING_ERROR: when the storage provider fails to complete the multipart upload

---

#### DELETE /videos/uploads/:videoId (SI-NN.X)

**Response 204:** No content.

**Error responses:**
- 404 UPLOAD_NOT_FOUND: when `videoId` does not match an in-progress upload
- 409 UPLOAD_ALREADY_COMPLETED: when the upload has already been completed or aborted

---

#### GET /videos/:publicId/stream (SI-NN.X)

**Response 200:**
- url: string (short-lived presigned GET URL served directly by the object storage, per `phase-03-videos/TD-07`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `publicId` does not match any video
- 409 VIDEO_NOT_READY: when the video's `status` is not `ready`

---

#### GET /videos/:publicId/download (SI-NN.X)

**Response 200:**
- url: string (same presigned mechanism as the stream endpoint, with `response-content-disposition=attachment` baked into the signature, per `phase-03-videos/TD-07`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `publicId` does not match any video
- 409 VIDEO_NOT_READY: when the video's `status` is not `ready`

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos/uploads | ✗ | ✗ | ✓ |
| POST /videos/uploads/:videoId/parts | ✗ | ✗ | ✓ |
| GET /videos/uploads/:videoId/parts | ✗ | ✗ | ✓ |
| POST /videos/uploads/:videoId/complete | ✗ | ✗ | ✓ |
| DELETE /videos/uploads/:videoId | ✗ | ✗ | ✓ |
| GET /videos/:publicId/stream | ✗ | ✗ | ✓ |
| GET /videos/:publicId/download | ✗ | ✗ | ✓ |

_Note: streaming/download are Owner-only in this phase because no publish/visibility state exists yet — `Video.status` only distinguishes upload/processing lifecycle, not public exposure. A future phase (`Fase 04` — publicação, `Fase 05` — página de visualização) is expected to broaden these two rows once a visibility field lands; that is out of this phase's scope._

### Error Catalog

_Error envelope shape (`{ statusCode, error, message }`) inherited from `phase-02-auth/TD-07` (Custom Domain Exception Filter) — this phase does not redefine it, only adds domain-specific codes._

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `publicId` não corresponde a nenhum vídeo |
| UPLOAD_NOT_FOUND | 404 | `videoId`/`uploadId` não corresponde a um upload em andamento |
| UPLOAD_ALREADY_COMPLETED | 409 | Tentativa de assinar/completar/abortar um upload já finalizado ou abortado |
| VIDEO_NOT_READY | 409 | Tentativa de stream/download de vídeo com `status` diferente de `ready` |
| STORAGE_PROVISIONING_ERROR | 502 | Falha ao criar, assinar ou completar o multipart upload no storage |

### Events/Messages

#### video.processing.requested

**Payload:**

```json
{ "videoId": "uuid", "storageKey": "string" }
```

**Producer:** `VideosService` (per `phase-03-videos/TD-08` — enqueues after multipart upload completion)
**Consumer:** `VideoProcessingWorker` (per `phase-03-videos/TD-04` — separate worker entrypoint, own Compose service)
**Trigger:** successful `POST /videos/uploads/:videoId/complete` (storage confirms the multipart upload assembled)
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-03` — BullMQ default retry/backoff semantics)

The worker consumes the job to run `phase-03-videos/TD-05`'s FFmpeg/ffprobe extraction (duration + metadata) and thumbnail generation, then updates `Video.status` to `ready` (or `failed` on unrecoverable error) and persists `durationSeconds`, `metadata`, and `thumbnailKey`.

---

<!-- phase-a-complete -->

## Dependency Map

<!-- Dep Map will be written in Phase B -->

---

## Deliverables

<!-- Deliverables will be written in Phase B -->
