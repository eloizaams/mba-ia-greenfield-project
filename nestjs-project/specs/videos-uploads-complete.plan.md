---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: test/videos-uploads-complete.e2e-spec.ts
---

# /videos/uploads/:videoId/complete + DELETE /videos/uploads/:videoId Test Plan

## Application Overview

Fecha o ciclo do upload multipart (per `phase-03-videos/TD-08`): `POST .../complete` monta o objeto final no storage, transiciona o vídeo para `processing` e dispara o job `video.processing.requested`; `DELETE /videos/uploads/:videoId` aborta o multipart e remove o rascunho. Owner-only per Authorization Matrix.

## Test Scenarios

### 1. POST /videos/uploads/:videoId/complete

**Setup:** `beforeEach` truncate test DB; bootstrap do módulo de teste NestJS; `StorageService` fake via `overrideProvider`; fila BullMQ substituída por fake/spy; upload em andamento pré-cadastrado para o dono.

#### 1.1. complete-happy-path

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. POST /videos/uploads/:videoId/complete com JWT do dono e body `{ parts: [{ partNumber: 1, eTag: "etag-1" }] }`
    - expect: status 200 com body `{ videoId, status: "processing" }`
    - expect: registro `Video` com `status = "processing"` e `uploadId` nulo
    - expect: exatamente um job publicado com payload `{ videoId, storageKey }`

#### 1.2. complete-falha-storage

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. Configurar o fake de `StorageService.completeMultipartUpload` para lançar erro
  2. POST /videos/uploads/:videoId/complete com JWT do dono e body válido
    - expect: status 502 com `errorCode: "STORAGE_PROVISIONING_ERROR"`
    - expect: `status` do vídeo permanece `draft` e nenhum job publicado

### 2. DELETE /videos/uploads/:videoId

**Setup:** mesmo setup do grupo 1.

#### 2.1. abort-happy-path

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. DELETE /videos/uploads/:videoId com JWT do dono
    - expect: status 204 sem corpo
    - expect: `abortMultipartUpload` invocado no storage
  2. GET /videos/uploads/:videoId/parts após o abort
    - expect: status 404 com `errorCode: "UPLOAD_NOT_FOUND"`

### 3. Estados de erro compartilhados

**Setup:** mesmo setup; um upload já completado também pré-cadastrado; segundo usuário não-dono com JWT válido.

#### 3.1. complete-ou-abort-de-upload-ja-finalizado

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. POST /videos/uploads/:videoId/complete sobre o upload já completado, com JWT do dono
    - expect: status 409 com `errorCode: "UPLOAD_ALREADY_COMPLETED"`
  2. DELETE /videos/uploads/:videoId sobre o mesmo upload
    - expect: status 409 com `errorCode: "UPLOAD_ALREADY_COMPLETED"`

#### 3.2. upload-inexistente-ou-de-outro-dono

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. POST /videos/uploads/:videoId/complete com `videoId` inexistente e JWT válido
    - expect: status 404 com `errorCode: "UPLOAD_NOT_FOUND"`
  2. DELETE /videos/uploads/:videoId com JWT do não-dono sobre upload do dono
    - expect: status 404 com `errorCode: "UPLOAD_NOT_FOUND"` — sem distinção do caso inexistente
