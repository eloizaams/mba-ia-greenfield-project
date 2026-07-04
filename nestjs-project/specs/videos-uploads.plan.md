---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-uploads.e2e-spec.ts
---

# POST /videos/uploads Test Plan

## Application Overview

Endpoint de início de upload de vídeo (per `phase-03-videos/TD-08` — presigned S3 multipart). Pré-cadastra automaticamente o vídeo como rascunho no canal do usuário autenticado e cria o multipart upload no object storage, retornando `videoId` (publicId), `uploadId` e `storageKey` para o cliente Uppy prosseguir com as partes.

## Test Scenarios

### 1. POST /videos/uploads

**Setup:** `beforeEach` truncate test DB; bootstrap do módulo de teste NestJS (`Test.createTestingModule` com `AppModule`); `StorageService` substituído via `overrideProvider` por fake determinístico; usuário + canal criados e JWT válido emitido.

#### 1.1. initiate-upload-happy-path

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. POST /videos/uploads com JWT válido e body `{ filename: "video.mp4", contentType: "video/mp4" }`
    - expect: status 201
    - expect: body contém `videoId` (11 chars), `uploadId` e `storageKey` não-vazios
    - expect: registro `Video` persistido com `status = "draft"`, `title`/`description`/`category` nulos e `channelId` do usuário autenticado

#### 1.2. initiate-upload-sem-token

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. POST /videos/uploads sem header Authorization com body válido
    - expect: status 401
    - expect: nenhum registro `Video` criado

#### 1.3. initiate-upload-body-invalido

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. POST /videos/uploads com JWT válido e body sem `filename`
    - expect: status 400 com erro de validação
  2. POST /videos/uploads com JWT válido e body sem `contentType`
    - expect: status 400 com erro de validação
    - expect: nenhum registro `Video` criado em ambos os casos

#### 1.4. initiate-upload-falha-storage

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. Configurar o fake de `StorageService.createMultipartUpload` para lançar erro
  2. POST /videos/uploads com JWT válido e body válido
    - expect: status 502 com envelope `{ statusCode, error, message }` e `errorCode: "STORAGE_PROVISIONING_ERROR"`
    - expect: nenhum registro `Video` persistido (sem rascunho órfão)
