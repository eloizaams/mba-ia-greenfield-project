---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-uploads-parts.e2e-spec.ts
---

# /videos/uploads/:videoId/parts Test Plan

## Application Overview

Par de endpoints do protocolo de partes (per `phase-03-videos/TD-08`): `POST .../parts` assina a URL presigned de uma parte específica; `GET .../parts` lista as partes já enviadas (fonte de verdade do storage, habilitando resume-after-refresh do Uppy). Ambos Owner-only per Authorization Matrix.

## Test Scenarios

### 1. POST /videos/uploads/:videoId/parts

**Setup:** `beforeEach` truncate test DB; bootstrap do módulo de teste NestJS; `StorageService` fake via `overrideProvider`; dois usuários com canais (dono e não-dono); upload em andamento pré-cadastrado para o dono.

#### 1.1. sign-part-happy-path

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. POST /videos/uploads/:videoId/parts com JWT do dono e body `{ partNumber: 1 }`
    - expect: status 200
    - expect: body `{ url }` com URL presigned não-vazia

#### 1.2. sign-part-part-number-invalido

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. POST /videos/uploads/:videoId/parts com JWT do dono e body `{ partNumber: "abc" }`
    - expect: status 400 com erro de validação
  2. POST /videos/uploads/:videoId/parts com body sem `partNumber`
    - expect: status 400 com erro de validação

### 2. GET /videos/uploads/:videoId/parts

**Setup:** mesmo setup do grupo 1; fake de `listParts` retorna partes conhecidas.

#### 2.1. list-parts-happy-path

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. GET /videos/uploads/:videoId/parts com JWT do dono
    - expect: status 200
    - expect: body `{ parts: [{ partNumber, eTag }] }` refletindo as partes já enviadas

### 3. Estados de erro compartilhados

**Setup:** mesmo setup; um upload já completado (`status != draft`, `uploadId` nulo) também pré-cadastrado.

#### 3.1. upload-inexistente-ou-de-outro-dono

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. POST /videos/uploads/:videoId/parts com `videoId` inexistente e JWT válido
    - expect: status 404 com `errorCode: "UPLOAD_NOT_FOUND"`
  2. POST /videos/uploads/:videoId/parts com `videoId` do dono mas JWT do não-dono
    - expect: status 404 com `errorCode: "UPLOAD_NOT_FOUND"` — resposta idêntica ao caso inexistente (não vaza existência)
  3. GET /videos/uploads/:videoId/parts nos mesmos dois casos
    - expect: status 404 com `errorCode: "UPLOAD_NOT_FOUND"` em ambos

#### 3.2. upload-ja-completado

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-03T11:58:30Z

**Steps:**
  1. POST /videos/uploads/:videoId/parts sobre o upload já completado, com JWT do dono
    - expect: status 409 com `errorCode: "UPLOAD_ALREADY_COMPLETED"`
