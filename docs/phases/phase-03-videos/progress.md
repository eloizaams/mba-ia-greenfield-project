# phase-03-videos — Progress

**Status:** completed
**SIs:** 16/16 completed

### SI-03.1 — Infra: Storage MinIO + configuração
- **Status:** completed
- **Tests:** 9 passing (env.validation.integration-spec.ts)
- **Observations:**
  - Jest 30: filtrar um arquivo na suíte de integração exige `--testPathPatterns '<path>'` — o path posicional é ignorado quando `--testRegex` vem da CLI (o script `test:integration` usa `--testRegex`).
  - Falha pré-existente e não relacionada observada na suíte completa: `src/database/migrations.integration-spec.ts` — `type "verification_tokens_type_enum" already exists` (migration 1777579850478-CreateAuthTokens). Follow-up fora do escopo da fase.

### SI-03.2 — StorageService (cliente S3 via AWS SDK v3)
- **Status:** completed
- **Tests:** 6 passing (1 unit compilation + 5 integration contra MinIO real)
- **Observations:**
  - Instalado `@aws-sdk/client-s3@^3.1079.0` e `@aws-sdk/s3-request-presigner@^3.1079.0`.
  - Dois S3Client providers (interno + público): o host faz parte da assinatura SigV4, então URLs presigned para o browser precisam ser assinadas contra o `publicEndpoint`. No teste de integração dentro do container, `STORAGE_PUBLIC_ENDPOINT` é sobrescrito para `http://storage:9000` (localhost do host não é alcançável de dentro do container).

### SI-03.3 — Infra: fila BullMQ + Redis
- **Status:** completed
- **Tests:** 13 passing (1 unit compilation + 12 integration env validation)
- **Observations:**
  - Instalado `@nestjs/bullmq@^11.0.4` e `bullmq@^5.79.2`.
  - `queue.constants.ts` também exporta o tipo `VideoProcessingJobPayload` — contrato do payload consumido pelo producer (SI-03.8) e pelo worker (SI-03.16).

### SI-03.4 — Entidade Video + migration
- **Status:** completed
- **Tests:** 4 passing (video.entity.integration-spec.ts — default draft, unique publicId, FK, relation load)
- **Observations:**
  - Dev DB tinha a tabela `migrations` vazia com schema já existente (resíduo de estado pré-existente; causa raiz da falha do `migrations.integration-spec.ts` anotada no SI-03.1). Correção: baseline-stamp das 2 migrations antigas via INSERT na tabela `migrations` — sem mudança de schema. `migration:run` voltou a funcionar.
  - Propriedades da entidade em camelCase (verbatim do Data Model do plano) com `name:` snake_case nas colunas, conciliando o padrão do banco herdado (users/channels usam snake_case).
  - Adicionado lado inverso `Channel.videos` (OneToMany) — relação bidirecional per regra do projeto.

### SI-03.5 — PublicIdService (nanoid + retry de colisão)
- **Status:** completed
- **Tests:** 7 passing (public-id.service.spec.ts)
- **Observations:**
  - Fixado `nanoid@^3.3.15` (branch 3.x, CJS, oficialmente suportada) — nanoid ≥4 é ESM-only e incompatível com o build CommonJS do Nest/ts-jest.
  - Retry só dispara em violação unique (23505) da coluna `public_id`; outras violações (FK 23503, uniques de outras colunas) são rethrow imediato — evita mascarar erros não relacionados à colisão.

### SI-03.6 — Exceções de domínio de vídeo
- **Status:** completed
- **Tests:** 6 passing (video-exceptions.spec.ts)
- **Observations:**
  - As 5 exceções estendem `DomainException` (base herdada da phase-02) — o `DomainExceptionFilter` global já as serializa no envelope `{ statusCode, error, message }` sem alteração no filter.

### SI-03.7 — VideosService: iniciar upload (pré-cadastro draft + multipart)
- **Status:** completed
- **Tests:** 9 passing (6 unit + 3 integration)
- **Observations:**
  - Adicionado `ChannelsService.findByUserId` — lookup de canal pertence ao domínio de channels (SRP); o VideosService consome via import do ChannelsModule.
  - Ordem storage-first + compensação: falha de persistência aborta o multipart recém-criado (best-effort) antes de propagar o erro; colisão de publicId regenera id e refaz o ciclo completo (novo multipart, abort do órfão).

### SI-03.8 — VideosService: partes, conclusão, abort + enfileiramento
- **Status:** completed
- **Tests:** 22 passing (16 unit + 6 integration com Redis real)
- **Observations:**
  - Payload do job usa `video.id` (uuid interno) per Events/Messages — o worker atualiza por PK, não por publicId.
  - Falha do storage no abort também mapeia para `STORAGE_PROVISIONING_ERROR` e mantém o draft (retryável) — o Error Catalog só lista criar/assinar/completar, decisão de consistência anotada.
  - Transição de estado usa update de statement único (autocommit) — "enqueue após commit" garantido por ordenação sequencial dos awaits, verificado em teste via invocationCallOrder.

### SI-03.9 — Endpoint POST /videos/uploads
- **Status:** completed
- **Tests:** 4 passing (test/videos-uploads.e2e-spec.ts, autorado do spec, exit limpo sem forceExit)
- **Observations:**
  - O E2E expôs bug de wiring do SI-03.3: `queueConfig` não estava no `load` do `ConfigModule.forRoot` — `BULLMQ_CONFIG` não resolvia `CONFIGURATION(queue)` no contexto da app completa (testes anteriores carregavam o config explicitamente). Corrigido no app.module.ts; também corrige boot latente do `start:dev`.
  - E2E com fila precisa de `queue.close()` explícito no afterAll antes de `app.close()` — sem isso o ioredis do BullMQ segura o event loop e o Jest não encerra. Padrão a repetir nos próximos e2e de videos.
  - `cleanAllTables` (src/test) agora limpa `videos` antes de `channels` (FK nova).

### SI-03.10 — Endpoints de partes (assinar + listar)
- **Status:** completed
- **Tests:** 5 passing (test/videos-uploads-parts.e2e-spec.ts, autorado do spec, exit limpo)
- **Observations:** none

### SI-03.11 — Endpoints de conclusão e abort do upload
- **Status:** completed
- **Tests:** 5 passing (test/videos-uploads-complete.e2e-spec.ts, autorado do spec, exit limpo)
- **Observations:** none

### SI-03.12 — VideoDeliveryService: URLs presigned de stream e download
- **Status:** completed
- **Tests:** 7 passing (5 unit + 2 integration com MinIO real — Range 206 e Content-Disposition verificados)
- **Observations:**
  - Ownership da entrega segue o mesmo padrão do upload: inexistente e outro dono retornam VIDEO_NOT_FOUND idêntico (Owner-only nesta fase; Fases 04/05 ampliam quando houver estado de visibilidade).

### SI-03.13 — Endpoints GET stream + download
- **Status:** completed
- **Tests:** 5 passing (test/videos-delivery.e2e-spec.ts, autorado do spec, exit limpo)
- **Observations:** none

### SI-03.14 — Infra: worker (entrypoint + Compose + imagem FFmpeg)
- **Status:** completed
- **Tests:** 1 passing (worker.module.spec.ts) + ACs verificados manualmente (worker up conectado, ffprobe 5.1.9-0+deb12u1 no container, sem porta HTTP)
- **Observations:**
  - Watch build do worker expôs TS1272 no videos.controller.ts (`JwtPayload` precisa de `import type` com isolatedModules+emitDecoratorMetadata) — o ts-jest não aplica essa regra, o tsc do `nest start` sim. Corrigido; `npx tsc --noEmit` global passa.
  - Pinning do ffmpeg é no nível da imagem (base `node:25.6.0-slim` fixa a release Debian → ffmpeg 5.1.x), sem pin exato de pacote apt — pin exato quebra o build quando o repo Debian atualiza.
  - `Dockerfile.dev` é compartilhado entre `nestjs-api` e `video-worker` — a API também ganha ffmpeg na próxima rebuild (inócuo).

### SI-03.15 — FfmpegService (probe + thumbnail)
- **Status:** completed
- **Tests:** 4 passing (ffmpeg.service.integration-spec.ts — ffmpeg/ffprobe reais, fixtures lavfi geradas em runtime)
- **Observations:**
  - Seleção de frame usa o filtro `thumbnail=n=30` a partir do offset (~10% com piso 1s per AMB-1) — o filtro escolhe o frame mais representativo da janela, cobrindo o fallback de frame preto/em branco sem detecção manual.
  - `nestjs-api` rebuildado para a imagem com ffmpeg — necessário para a suíte de integração completa rodar no container da API.

### SI-03.16 — VideoProcessingProcessor (consumer do job)
- **Status:** completed
- **Tests:** 9 passing (6 unit + 3 integration end-to-end com MinIO + Postgres + ffmpeg reais)
- **Observations:**
  - `StorageService` ganhou `getObjectStream` e `putObject` (operações do worker) — extensão do artefato do SI-03.2 exigida pelas ações deste SI.
  - `defaultJobOptions` (attempts 3, backoff exponencial 5s, removeOnComplete) definidos no `registerQueue` do VideosModule (lado producer) per TD-03.
  - `failed` só é gravado na última tentativa (`attemptsMade + 1 >= attempts`); tentativas intermediárias fazem rethrow puro para o retry da fila.
