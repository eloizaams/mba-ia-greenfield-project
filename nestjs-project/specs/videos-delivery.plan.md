---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.13
target_file: test/videos-delivery.e2e-spec.ts
---

# GET /videos/:publicId/stream + /download Test Plan

## Application Overview

Endpoints de entrega (per `phase-03-videos/TD-07` — presigned GET direto do storage): `stream` retorna URL presigned para reprodução via streaming; `download` retorna a mesma mecânica com `response-content-disposition=attachment` embutido na assinatura. Owner-only nesta fase per Authorization Matrix (sem estado de visibilidade até a Fase 04/05).

## Test Scenarios

### 1. GET /videos/:publicId/stream

**Setup:** `beforeEach` truncate test DB; bootstrap do módulo de teste NestJS; `StorageService` fake via `overrideProvider` retornando URLs determinísticas; vídeos pré-cadastrados: um `ready` e um `processing`, ambos do dono autenticado.

#### 1.1. stream-happy-path

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. GET /videos/:publicId/stream do vídeo `ready` com JWT do dono
    - expect: status 200 com body `{ url }` presigned não-vazia
    - expect: URL sem `response-content-disposition=attachment`

### 2. GET /videos/:publicId/download

**Setup:** mesmo setup do grupo 1.

#### 2.1. download-happy-path

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. GET /videos/:publicId/download do vídeo `ready` com JWT do dono
    - expect: status 200 com body `{ url }`
    - expect: URL contém `response-content-disposition=attachment` (força download)

### 3. Estados de erro compartilhados

**Setup:** mesmo setup dos grupos anteriores.

#### 3.1. video-nao-pronto

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. GET /videos/:publicId/stream do vídeo em `processing` com JWT do dono
    - expect: status 409 com `errorCode: "VIDEO_NOT_READY"`
  2. GET /videos/:publicId/download do mesmo vídeo
    - expect: status 409 com `errorCode: "VIDEO_NOT_READY"`

#### 3.2. video-inexistente

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. GET /videos/:publicId/stream com `publicId` inexistente e JWT válido
    - expect: status 404 com `errorCode: "VIDEO_NOT_FOUND"`
  2. GET /videos/:publicId/download com o mesmo `publicId`
    - expect: status 404 com `errorCode: "VIDEO_NOT_FOUND"`

#### 3.3. sem-token

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. GET /videos/:publicId/stream do vídeo `ready` sem header Authorization
    - expect: status 401
  2. GET /videos/:publicId/download do mesmo vídeo sem header Authorization
    - expect: status 401
