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

### SI-03.1 — Infra: Storage MinIO + configuração

**Description:** Provisiona o backend de object storage (MinIO) no Compose e cria o namespace de configuração `storage`, fundação para todo upload/entrega de arquivos da fase.

**Technical actions:**

1. Adicionar serviço `storage` (MinIO) + volume ao `nestjs-project/compose.yaml` — host referenciado pelo nome de serviço Compose `storage`, nunca `localhost` (per `phase-03-videos/TD-01`)
2. Adicionar provisionamento do bucket de vídeos via `mc` (serviço one-shot `storage-init` no Compose) (per `phase-03-videos/TD-01`)
3. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` com `endpoint`, `publicEndpoint` (URL alcançável pelo browser para presigned URLs, per `phase-03-videos/TD-07`/`TD-08`), `region`, `accessKeyId`, `secretAccessKey`, `bucket`, `presignedExpirySeconds` — convenção herdada da phase 01 (namespaced `registerAs`)
4. Estender o schema Joi em `src/config/env.validation.ts` com as chaves `STORAGE_*`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Chaves `STORAGE_*` no schema Joi | Integration: env validation rejeita ausência de cada chave obrigatória | `src/config/env.validation.integration-spec.ts` (estendido) |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up` sobe o serviço `storage` e, após o provisionamento, o bucket de vídeos existe (verificável via `mc ls`)
- MinIO responde à API S3 em `http://storage:9000` a partir de containers da rede Compose
- Boot da API falha com erro de validação Joi quando qualquer variável `STORAGE_*` obrigatória está ausente

---

### SI-03.2 — StorageService (cliente S3 via AWS SDK v3)

**Description:** Entrega o módulo de storage com o cliente S3 e todas as operações de multipart e presigned URL que o ciclo de upload (TD-08) e a entrega (TD-07) consomem.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` (AWS SDK v3, per `phase-03-videos/TD-01`)
2. Criar `src/storage/storage.module.ts` — provider do `S3Client` configurado a partir de `storageConfig` (`endpoint`, credenciais, `forcePathStyle: true` para MinIO), injetado via `ConfigType<typeof storageConfig>` (convenção phase 01)
3. Criar `src/storage/storage.service.ts` — `createMultipartUpload(key, contentType)`, `getSignedPartUrl(key, uploadId, partNumber)`, `listParts(key, uploadId)`, `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)`, `getPresignedGetUrl(key, { downloadFilename? })` com `response-content-disposition=attachment` embutido na assinatura quando for download (per `phase-03-videos/TD-01`, `TD-07`, `TD-08`)
4. Assinar as URLs de parte e de GET contra o `publicEndpoint` browser-reachable (per `phase-03-videos/TD-07`/`TD-08` — o browser consome as URLs diretamente, nunca o hostname interno `storage`)
5. Registrar `StorageModule` no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test (módulo com imports configurados) | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration: bucket MinIO real — ciclo multipart completo + presigned GET | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — o serviço `storage` e o namespace de config precisam existir

**Acceptance criteria:**

- Ciclo multipart (create → sign part → upload da parte via URL assinada → list → complete) resulta em objeto íntegro no bucket
- `listParts` retorna as partes já enviadas com `partNumber` e `eTag`
- Presigned GET com `downloadFilename` serve o objeto com header `Content-Disposition: attachment`
- Presigned GET expira: requisição após `presignedExpirySeconds` é rejeitada pelo storage (403)
- URLs assinadas apontam para o `publicEndpoint`, não para o hostname interno `storage`

---

### SI-03.3 — Infra: fila BullMQ + Redis

**Description:** Provisiona o Redis e a fundação BullMQ (conexão + constantes da fila), habilitando o serviço de processamento em segundo plano.

**Technical actions:**

1. Adicionar serviço `redis` ao `nestjs-project/compose.yaml` — host referenciado como `redis` (nome de serviço Compose)
2. Instalar `@nestjs/bullmq` e `bullmq` (per `phase-03-videos/TD-03`)
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` com `host`, `port` do Redis — e estender o schema Joi com as chaves `REDIS_*`
4. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync` (connection via `queueConfig`, `inject: [queueConfig.KEY]`, convenção phase 01) e importar no `AppModule`
5. Criar `src/queue/queue.constants.ts` com `VIDEO_PROCESSING_QUEUE = 'video-processing'` e o nome do job `video.processing.requested` (per `### Events/Messages`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test (módulo com imports configurados) | `src/queue/queue.module.spec.ts` |
| Chaves `REDIS_*` no schema Joi | Integration: env validation rejeita ausência das chaves | `src/config/env.validation.integration-spec.ts` (estendido) |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up` sobe o `redis` acessível em `redis:6379` pela rede Compose
- Boot da API falha com erro de validação Joi quando `REDIS_HOST`/`REDIS_PORT` estão ausentes
- API sobe conectada ao Redis sem erros de conexão BullMQ nos logs

---

### SI-03.4 — Entidade Video + migration

**Description:** Cria a entidade `Video` com o schema completo do Data Model e a migration correspondente — a base de dados de todo o ciclo upload → processamento → entrega.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com os campos do `### Data Model` verbatim — `id` (uuid PK), `publicId` (varchar(11), unique, per `phase-03-videos/TD-06`), `channelId` (FK → Channel), `status` (enum `draft`/`processing`/`ready`/`failed`, default `draft`), `storageKey`, `uploadId` (nullable), `title`/`description`/`category` (nullable — preenchidos pela capability de edição da Fase 04, per resolução AMB-2), `thumbnailKey`/`durationSeconds`/`metadata` (nullable — populados pelo worker per `phase-03-videos/TD-05`), `createdAt`/`updatedAt`
2. Declarar relação `Video` many-to-one `Channel` (inverso one-to-many) e índices: unique em `publicId`, index em `channelId`, index em `status`
3. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e importar no `AppModule`
4. Gerar a migration via `npm run migration:generate` (tabela `videos`, tipo enum de status, constraints e índices)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` entity | Integration: constraints, defaults (unique `publicId`, default `draft`, FK `channelId`, colunas nullable) | `src/videos/entities/video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com unique em `publicId` e índices em `channelId` e `status`
- Inserir dois vídeos com o mesmo `publicId` viola a constraint unique
- Inserir vídeo sem `status` persiste com `draft`
- Inserir vídeo com `channelId` inexistente viola a FK

---

### SI-03.5 — PublicIdService (nanoid + retry de colisão)

**Description:** Entrega a geração de IDs públicos curtos e não-enumeráveis com tratamento de colisão, garantindo URL única por vídeo.

**Technical actions:**

1. Instalar `nanoid` — verificar na instalação a compatibilidade CJS/ESM da major escolhida com o build CommonJS do Nest (nanoid ≥4 é ESM-only; fixar major compatível)
2. Criar `src/videos/public-id.service.ts` — `customAlphabet` com alfabeto URL-safe sem caracteres ambíguos, comprimento 11 (alinha `publicId varchar(11)` do `### Data Model`), per `phase-03-videos/TD-06`
3. Implementar retry de colisão: gerar → persistir → em violação da unique constraint, regenerar e tentar de novo (limite de tentativas com erro explícito ao estourar), per `phase-03-videos/TD-06`
4. Registrar o provider no `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `PublicIdService` | Unit: branch logic (mock repo) — colisão regenera; limite de tentativas estoura com erro | `src/videos/public-id.service.spec.ts` |

**Dependencies:** SI-03.4 — a unique constraint em `publicId` é o mecanismo de detecção de colisão

**Acceptance criteria:**

- IDs gerados têm exatamente 11 caracteres do alfabeto configurado (URL-safe, sem `/`, `+` ou caracteres ambíguos)
- Em colisão com `publicId` existente, um novo ID é gerado e persistido sem erro para o chamador
- Estouro do limite de tentativas resulta em erro explícito, nunca em ID duplicado

---

### SI-03.6 — Exceções de domínio de vídeo

**Description:** Materializa o Error Catalog da fase como exceções de domínio consumidas pelo Custom Domain Exception Filter herdado, antes de qualquer service que precise lançá-las.

**Technical actions:**

1. Criar as exceções em `src/videos/exceptions/` seguindo o padrão de `src/common/exceptions` (per `phase-02-auth/TD-07` herdado): `VideoNotFoundException` (404 `VIDEO_NOT_FOUND`), `UploadNotFoundException` (404 `UPLOAD_NOT_FOUND`), `UploadAlreadyCompletedException` (409 `UPLOAD_ALREADY_COMPLETED`), `VideoNotReadyException` (409 `VIDEO_NOT_READY`), `StorageProvisioningException` (502 `STORAGE_PROVISIONING_ERROR`) — códigos e HTTP status verbatim do `### Error Catalog`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Exceções de domínio | Unit: `statusCode` + `errorCode` de cada exceção conforme o Error Catalog | `src/videos/exceptions/video-exceptions.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Cada exceção lançada por um endpoint produz o envelope `{ statusCode, error, message }` herdado, com o `errorCode` e o HTTP status exatos do `### Error Catalog`
- Nenhuma exceção de vídeo vaza stack trace ou detalhes internos na resposta

---

### SI-03.7 — VideosService: iniciar upload (pré-cadastro draft + multipart)

**Description:** Implementa o início do upload — pré-cadastro automático do vídeo como rascunho e criação do multipart upload no storage, o primeiro passo do protocolo TD-08.

**Technical actions:**

1. Criar `src/videos/videos.service.ts` com `initiateUpload(userId, { filename, contentType })` — resolve o `Channel` do usuário autenticado (Owner); per resolução AMB-2, o pré-cadastro popula apenas `channelId`, `storageKey`, `uploadId` e `status = draft` (título/descrição/categoria ficam nulos até a Fase 04)
2. Gerar `publicId` via `PublicIdService` e montar `storageKey` determinístico (ex.: `videos/{publicId}/{filename-sanitizado}`)
3. Chamar `StorageService.createMultipartUpload` e, com o `uploadId` retornado, persistir o draft (storage primeiro — falha no storage não deixa rascunho órfão), per `phase-03-videos/TD-08`
4. Mapear falha do provider de storage para `StorageProvisioningException` (502, per `### Error Catalog`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: branch logic (mock repo/storage) — happy path; falha de storage → 502 sem persistência | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration: DB contract — draft persistido com `status`, `uploadId`, `channelId` corretos | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2 (StorageService), SI-03.4 (entidade), SI-03.5 (publicId), SI-03.6 (exceções)

**Acceptance criteria:**

- Iniciar upload persiste um `Video` com `status = draft`, `publicId` único, `storageKey` e `uploadId` preenchidos, e `title`/`description`/`category` nulos
- Quando o storage falha ao criar o multipart, nenhum registro de vídeo é criado e o erro resulta em `STORAGE_PROVISIONING_ERROR`
- Dois uploads iniciados em paralelo pelo mesmo usuário produzem dois drafts com `publicId` distintos

---

### SI-03.8 — VideosService: partes, conclusão, abort + enfileiramento

**Description:** Completa o ciclo de vida do upload no service — assinatura/listagem de partes, conclusão com transição para `processing` e publicação do job, e abort — fechando o protocolo TD-08 no backend.

**Technical actions:**

1. Implementar `signPart(videoId, partNumber)` e `listParts(videoId)` delegando ao `StorageService` — `UploadNotFoundException` quando não há upload em andamento (inclui vídeo de outro dono, sem vazar existência); `UploadAlreadyCompletedException` quando `uploadId` já foi limpo (per `phase-03-videos/TD-08`, `### Error Catalog`)
2. Implementar `completeUpload(videoId, parts)`: `completeMultipartUpload` no storage → `status = processing`, `uploadId = null` (per `### Data Model`); falha do storage → `StorageProvisioningException`
3. Publicar `video.processing.requested` com payload `{ videoId, storageKey }` na fila `video-processing` **somente após o commit** da transação de atualização (per `phase-03-videos/TD-03` — transactional-enqueue gap; `### Events/Messages`)
4. Implementar `abortUpload(videoId)`: `abortMultipartUpload` no storage + remoção do draft
5. Registrar `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` no `VideosModule` e injetar a `Queue` no service

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (parts/complete/abort) | Unit: branch logic (mock repo/storage/queue) — estados 404/409, ordem commit→enqueue, abort | `src/videos/videos.service.spec.ts` (estendido) |
| `VideosService.completeUpload` | Integration: DB contract + contrato de publicação na fila (Redis de teste) | `src/videos/videos.service.integration-spec.ts` (estendido) |

**Dependencies:** SI-03.3 (fila), SI-03.7 (initiateUpload + service base)

**Acceptance criteria:**

- Completar upload muda `status` para `processing`, limpa `uploadId` e publica exatamente um job com `{ videoId, storageKey }`
- Nenhum job é publicado quando a transação de atualização do vídeo falha
- Assinar parte ou completar um upload já finalizado resulta em `UPLOAD_ALREADY_COMPLETED` (409)
- Operar sobre `videoId` inexistente ou de outro dono resulta em `UPLOAD_NOT_FOUND` (404), sem distinção entre os dois casos
- Abortar upload remove o draft e aborta o multipart no storage (as partes deixam de ser listáveis)

---

### SI-03.9 — Endpoint POST /videos/uploads

**Route:** POST /videos/uploads
**Test Specs:** see `nestjs-project/specs/videos-uploads.plan.md`
**Authorization:** Owner — JWT obrigatório; o upload é criado no canal do próprio usuário autenticado (per `### Authorization Matrix`)

**Description:** Expõe o início do upload — cria o controller de vídeos com a rota de pré-cadastro + criação do multipart.

**Technical actions:**

1. Criar `src/videos/videos.controller.ts` com `POST /videos/uploads` → `VideosService.initiateUpload`, resposta `201 { videoId, uploadId, storageKey }` (per `### API Contracts`; `videoId` é o `publicId`)
2. Criar `src/videos/dto/create-upload.dto.ts` — `filename` e `contentType` obrigatórios, validação class-validator (per `phase-02-auth/TD-06` herdado)
3. Proteger a rota com o guard JWT herdado da phase 02 (custom guards per `phase-02-auth/TD-02`, nota de divergência)
4. Adicionar decoradores OpenAPI explícitos — `@ApiOperation`, `@ApiResponse` por status, `@ApiBody` (per `openapi-docs-nestjs/TD-01`, revisão 2026-05-12)

**Tests:** _(empty — controller e DTO são E2E-only per testing-guide-nestjs-project; cenários E2E vivem no spec autorado por /plan-test-specs)_

**Dependencies:** SI-03.7 — o método de service precisa existir

**Acceptance criteria:**

- `POST /videos/uploads` com body válido e JWT válido retorna `201` com `videoId`, `uploadId` e `storageKey`
- `POST /videos/uploads` sem token retorna `401`
- `POST /videos/uploads` sem `filename` ou sem `contentType` retorna `400` com erro de validação
- Falha do storage ao criar o multipart retorna `502` com `errorCode: "STORAGE_PROVISIONING_ERROR"`

---

### SI-03.10 — Endpoints de partes (assinar + listar)

**Route:** POST /videos/uploads/:videoId/parts
**Route:** GET /videos/uploads/:videoId/parts
**Test Specs:** see `nestjs-project/specs/videos-uploads-parts.plan.md`
**Authorization:** Owner — JWT obrigatório; apenas o dono do upload assina/lista partes (per `### Authorization Matrix`)

**Description:** Expõe a assinatura de URL por parte e a listagem de partes já enviadas — o par de rotas que o cliente Uppy (`@uppy/aws-s3`, per `phase-03-videos/TD-08`) consome para subir e retomar uploads.

**Technical actions:**

1. Adicionar `POST /videos/uploads/:videoId/parts` → `VideosService.signPart`, resposta `200 { url }` (per `### API Contracts`)
2. Adicionar `GET /videos/uploads/:videoId/parts` → `VideosService.listParts`, resposta `200 { parts: [{ partNumber, eTag }] }` — fonte de verdade do storage para resume-after-refresh (per `phase-03-videos/TD-08`)
3. Criar `src/videos/dto/sign-part.dto.ts` — `partNumber` inteiro obrigatório, class-validator
4. Adicionar decoradores OpenAPI explícitos por rota e status (per `openapi-docs-nestjs/TD-01`)

**Tests:** _(empty — controller e DTO são E2E-only per testing-guide-nestjs-project; cenários E2E vivem no spec autorado por /plan-test-specs)_

**Dependencies:** SI-03.8 (métodos de service), SI-03.9 (controller existente)

**Acceptance criteria:**

- `POST .../parts` com `partNumber` válido retorna `200` com URL presigned utilizável para upload direto ao storage
- `GET .../parts` retorna as partes já enviadas com `partNumber` e `eTag`
- `videoId` inexistente ou de outro dono retorna `404` com `errorCode: "UPLOAD_NOT_FOUND"`, sem revelar qual dos dois casos ocorreu
- Upload já completado retorna `409` com `errorCode: "UPLOAD_ALREADY_COMPLETED"`
- `partNumber` não-inteiro retorna `400` com erro de validação

---

### SI-03.11 — Endpoints de conclusão e abort do upload

**Route:** POST /videos/uploads/:videoId/complete
**Route:** DELETE /videos/uploads/:videoId
**Test Specs:** see `nestjs-project/specs/videos-uploads-complete.plan.md`
**Authorization:** Owner — JWT obrigatório; apenas o dono conclui/aborta o próprio upload (per `### Authorization Matrix`)

**Description:** Expõe a conclusão do multipart (que dispara o processamento em segundo plano) e o abort do upload.

**Technical actions:**

1. Adicionar `POST /videos/uploads/:videoId/complete` → `VideosService.completeUpload`, resposta `200 { videoId, status: "processing" }` (per `### API Contracts`)
2. Criar `src/videos/dto/complete-upload.dto.ts` — `parts: [{ partNumber, eTag }]` obrigatório, validação aninhada class-validator
3. Adicionar `DELETE /videos/uploads/:videoId` → `VideosService.abortUpload`, resposta `204` sem corpo
4. Adicionar decoradores OpenAPI explícitos por rota e status (per `openapi-docs-nestjs/TD-01`)

**Tests:** _(empty — controller e DTO são E2E-only per testing-guide-nestjs-project; cenários E2E vivem no spec autorado por /plan-test-specs)_

**Dependencies:** SI-03.8 (métodos de service), SI-03.9 (controller existente)

**Acceptance criteria:**

- `POST .../complete` com as partes corretas retorna `200` com `status: "processing"`
- `DELETE /videos/uploads/:videoId` de um upload em andamento retorna `204` e as rotas de partes passam a responder `404`
- Completar ou abortar um upload já finalizado retorna `409` com `errorCode: "UPLOAD_ALREADY_COMPLETED"`
- `videoId` inexistente ou de outro dono retorna `404` com `errorCode: "UPLOAD_NOT_FOUND"`
- Falha do storage ao montar o objeto final retorna `502` com `errorCode: "STORAGE_PROVISIONING_ERROR"`

---

### SI-03.12 — VideoDeliveryService: URLs presigned de stream e download

**Description:** Implementa a entrega de vídeos prontos — geração de URLs presigned de streaming e download direto do storage, mantendo os bytes fora do Node (per `phase-03-videos/TD-07`). Responsabilidade de entrega separada do ciclo de upload (SRP).

**Technical actions:**

1. Criar `src/videos/video-delivery.service.ts` com `getStreamUrl(publicId, userId)` e `getDownloadUrl(publicId, userId)`
2. Validar: vídeo existe (`VideoNotFoundException` 404), pertence ao canal do usuário (Owner-only nesta fase, per nota da `### Authorization Matrix`), e `status = ready` (`VideoNotReadyException` 409)
3. Delegar ao `StorageService.getPresignedGetUrl` — download com `response-content-disposition=attachment` embutido na assinatura; stream sem disposition (per `phase-03-videos/TD-07`)
4. Registrar o provider no `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoDeliveryService` | Unit: branch logic (mock repo/storage) — 404, 409, ownership, disposition | `src/videos/video-delivery.service.spec.ts` |
| `VideoDeliveryService` | Integration: MinIO real — URL de stream serve o objeto com suporte a Range | `src/videos/video-delivery.service.integration-spec.ts` |

**Dependencies:** SI-03.2 (StorageService), SI-03.4 (entidade), SI-03.6 (exceções)

**Acceptance criteria:**

- URL de stream de um vídeo `ready` serve o conteúdo diretamente do storage, com requisições `Range` respondidas com `206 Partial Content`
- URL de download serve o mesmo objeto com `Content-Disposition: attachment`
- Vídeo com `status` diferente de `ready` resulta em `VIDEO_NOT_READY` (409)
- `publicId` inexistente resulta em `VIDEO_NOT_FOUND` (404)

---

### SI-03.13 — Endpoints GET stream + download

**Route:** GET /videos/:publicId/stream
**Route:** GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-delivery.plan.md`
**Authorization:** Owner — JWT obrigatório; entrega restrita ao dono nesta fase (per `### Authorization Matrix` e sua nota — Fases 04/05 ampliam as linhas quando o estado de visibilidade existir)

**Description:** Expõe a reprodução via streaming e o download do vídeo pelo usuário, devolvendo as URLs presigned da entrega.

**Technical actions:**

1. Adicionar `GET /videos/:publicId/stream` → `VideoDeliveryService.getStreamUrl`, resposta `200 { url }` (per `### API Contracts`)
2. Adicionar `GET /videos/:publicId/download` → `VideoDeliveryService.getDownloadUrl`, resposta `200 { url }` (per `### API Contracts`)
3. Adicionar decoradores OpenAPI explícitos por rota e status (per `openapi-docs-nestjs/TD-01`)

**Tests:** _(empty — controller é E2E-only per testing-guide-nestjs-project; cenários E2E vivem no spec autorado por /plan-test-specs)_

**Dependencies:** SI-03.12 (service de entrega), SI-03.9 (controller existente)

**Acceptance criteria:**

- `GET /videos/:publicId/stream` de vídeo `ready` do próprio canal retorna `200 { url }` com URL presigned válida
- `GET /videos/:publicId/download` retorna `200 { url }` cuja URL força download
- Vídeo em `processing` retorna `409` com `errorCode: "VIDEO_NOT_READY"`
- `publicId` inexistente retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`
- Requisição sem token retorna `401`

---

### SI-03.14 — Infra: worker (entrypoint + Compose + imagem FFmpeg)

**Description:** Provisiona a topologia do worker — entrypoint separado no mesmo projeto, serviço Compose próprio e imagem com FFmpeg de sistema — o isolamento de processo que a exigência de performance demanda (per `phase-03-videos/TD-04`).

**Technical actions:**

1. Criar `src/worker/worker.module.ts` — módulo raiz do worker: `ConfigModule` (mesmo schema Joi), `TypeOrmModule.forRootAsync` (mesma `databaseConfig`, convenção phase 01), conexão BullMQ via `queueConfig` (per `phase-03-videos/TD-04`)
2. Criar `src/worker.ts` — bootstrap via `NestFactory.createApplicationContext(WorkerModule)` (sem servidor HTTP) + script npm `start:worker` (per `phase-03-videos/TD-04` — entrypoint separado, não projeto separado)
3. Adicionar serviço `video-worker` ao `nestjs-project/compose.yaml` — mesma base de imagem com `command` próprio, `depends_on` `db`/`redis`/`storage` (hosts pelos nomes de serviço Compose)
4. Instalar `ffmpeg`/`ffprobe` na imagem do worker com versão pinada no Dockerfile (per `phase-03-videos/TD-05` — binário de sistema, sem wrapper npm)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation test (módulo com imports configurados) | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.3 — conexão BullMQ e Redis precisam existir

**Acceptance criteria:**

- `docker compose up video-worker` sobe o worker conectado a Redis e Postgres sem erros nos logs
- `ffprobe -version` executa com sucesso dentro do container do worker
- O worker não expõe porta HTTP

---

### SI-03.15 — FfmpegService (probe + thumbnail)

**Description:** Entrega o módulo fino de invocação de FFmpeg/ffprobe — extração de duração/metadados e geração de thumbnail — sem lib wrapper (per `phase-03-videos/TD-05`, `fluent-ffmpeg` arquivado).

**Technical actions:**

1. Criar `src/worker/ffmpeg/ffmpeg.service.ts` — wrapper fino via `execFile` direto sobre os binários de sistema (per `phase-03-videos/TD-05`), registrado no `WorkerModule`
2. Implementar `probe(filePath)` — `ffprobe -print_format json` → `durationSeconds` (inteiro) + `metadata` bruto (resolution, codec, bitrate, format), formato alinhado às colunas do `### Data Model`
3. Implementar `extractThumbnail(filePath, outPath, durationSeconds)` — frame a ~10% da duração com piso de 1s; se o frame selecionado for preto/em branco, re-amostrar um offset próximo; para vídeos mais curtos que o piso, cair para o primeiro frame válido (per resolução AMB-1 em `validation.md`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService` | Integration: adapter real (side-effect dep per testing-guide) — fixture de vídeo pequena: probe retorna duração/metadata; thumbnail não-vazio; fallback de vídeo curto | `src/worker/ffmpeg/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.14 — os binários FFmpeg existem na imagem do worker

**Acceptance criteria:**

- `probe` de uma fixture conhecida retorna a duração correta (±1s) e metadata contendo resolução e codec
- `extractThumbnail` gera arquivo de imagem não-vazio para vídeo normal e para vídeo mais curto que o piso de 1s
- Arquivo inexistente ou corrompido resulta em erro identificável (não trava nem retorna sucesso vazio)

---

### SI-03.16 — VideoProcessingProcessor (consumer do job)

**Description:** Implementa o consumer que processa o vídeo após o upload — baixa do storage, extrai duração/metadados, gera e sobe o thumbnail, e finaliza o status — fechando o fluxo `### Events/Messages` de ponta a ponta.

**Technical actions:**

1. Criar `src/worker/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` estendendo `WorkerHost`, consumindo `video.processing.requested` com payload `{ videoId, storageKey }` (per `### Events/Messages`, `phase-03-videos/TD-03`/`TD-04`)
2. Baixar o objeto do storage para arquivo temporário via stream (nunca buffer completo em memória — arquivos de até 10GB), usando o `StorageService`
3. Rodar `FfmpegService.probe` + `extractThumbnail` e subir o thumbnail para o bucket (`thumbnailKey` ex.: `thumbnails/{publicId}.jpg`, per `### Data Model`)
4. Atualizar o `Video`: `durationSeconds`, `metadata`, `thumbnailKey`, `status = ready`; em erro irrecuperável (após retries), `status = failed` (per `### Events/Messages`)
5. Configurar retries/backoff do job (per `phase-03-videos/TD-03`, at-least-once) e garantir idempotência — reprocessar um vídeo já `ready` é no-op seguro; limpar arquivos temporários em sucesso e em falha

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Unit: branch logic (mock storage/ffmpeg/repo) — sucesso, falha irrecuperável → `failed`, idempotência, cleanup | `src/worker/video-processing.processor.spec.ts` |
| Fluxo de processamento | Integration: adapter real — MinIO + fixture: job consumido persiste `ready` + thumbnail no bucket | `src/worker/video-processing.processor.integration-spec.ts` |

**Dependencies:** SI-03.2 (StorageService), SI-03.4 (entidade), SI-03.14 (worker), SI-03.15 (FfmpegService)

**Acceptance criteria:**

- Após o job processar um vídeo válido, o registro tem `status = ready`, `durationSeconds`, `metadata` e `thumbnailKey` preenchidos, e o thumbnail existe no bucket
- Objeto ausente/corrompido no storage, esgotados os retries, deixa o vídeo com `status = failed`
- Redelivery do mesmo job (at-least-once) não corrompe o estado nem duplica thumbnail
- Nenhum arquivo temporário permanece no filesystem do worker após sucesso ou falha

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

## Dependency Map

```
SI-03.1 (root — infra de storage)
└── SI-03.2 — depends on SI-03.1 (config e serviço MinIO antes do cliente S3)
    ├── SI-03.7 — depends on SI-03.2, SI-03.4, SI-03.5, SI-03.6 (storage + entidade + publicId + exceções antes do initiate)
    │   ├── SI-03.8 — depends on SI-03.3, SI-03.7 (fila + service base antes de complete/enqueue)
    │   │   ├── SI-03.10 — depends on SI-03.8, SI-03.9 (métodos de partes + controller existente)
    │   │   └── SI-03.11 — depends on SI-03.8, SI-03.9 (métodos complete/abort + controller existente)
    │   └── SI-03.9 — depends on SI-03.7 (initiateUpload antes do endpoint)
    ├── SI-03.12 — depends on SI-03.2, SI-03.4, SI-03.6 (presigned GET + entidade + exceções antes da entrega)
    │   └── SI-03.13 — depends on SI-03.12, SI-03.9 (service de entrega + controller existente)
    └── SI-03.16 — depends on SI-03.2, SI-03.4, SI-03.14, SI-03.15 (storage + entidade + worker + ffmpeg antes do consumer)
SI-03.3 (root — infra de fila)
├── SI-03.8 (ver acima)
└── SI-03.14 — depends on SI-03.3 (conexão BullMQ antes do worker)
    └── SI-03.15 — depends on SI-03.14 (binários FFmpeg na imagem antes do service)
        └── SI-03.16 (ver acima)
SI-03.4 (root — entidade Video)
└── SI-03.5 — depends on SI-03.4 (unique constraint é o detector de colisão)
SI-03.6 (root — exceções de domínio, independente)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: Storage MinIO + configuração
- [ ] SI-03.2 — StorageService (cliente S3 via AWS SDK v3)
- [ ] SI-03.3 — Infra: fila BullMQ + Redis
- [ ] SI-03.4 — Entidade Video + migration
- [ ] SI-03.5 — PublicIdService (nanoid + retry de colisão)
- [ ] SI-03.6 — Exceções de domínio de vídeo
- [ ] SI-03.7 — VideosService: iniciar upload (pré-cadastro draft + multipart)
- [ ] SI-03.8 — VideosService: partes, conclusão, abort + enfileiramento
- [ ] SI-03.9 — Endpoint POST /videos/uploads
- [ ] SI-03.10 — Endpoints de partes (assinar + listar)
- [ ] SI-03.11 — Endpoints de conclusão e abort do upload
- [ ] SI-03.12 — VideoDeliveryService: URLs presigned de stream e download
- [ ] SI-03.13 — Endpoints GET stream + download
- [ ] SI-03.14 — Infra: worker (entrypoint + Compose + imagem FFmpeg)
- [ ] SI-03.15 — FfmpegService (probe + thumbnail)
- [ ] SI-03.16 — VideoProcessingProcessor (consumer do job)

**Full test suites:**

- [ ] Backend unit tests pass (`cd nestjs-project && npm test`)
- [ ] Backend integration tests pass (`cd nestjs-project && npm run test:integration`)
- [ ] E2E tests pass (`cd nestjs-project && npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && npm run lint`)
