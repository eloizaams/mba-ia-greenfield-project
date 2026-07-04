import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import type { UploadedPart } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateUploadDto } from './dto/create-upload.dto';
import { SignPartDto } from './dto/sign-part.dto';
import { VideoStatus } from './entities/video.entity';
import { VideoDeliveryService } from './video-delivery.service';
import { VideosService } from './videos.service';
import type { InitiateUploadResult } from './videos.service';

@ApiTags('videos')
@ApiBearerAuth()
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly videoDeliveryService: VideoDeliveryService,
  ) {}

  @Post('uploads')
  @ApiOperation({
    summary: 'Inicia um upload de vídeo',
    description:
      'Pré-cadastra o vídeo como rascunho no canal do usuário autenticado e cria o multipart upload no object storage. O cliente usa uploadId/storageKey para enviar as partes diretamente ao storage.',
  })
  @ApiBody({ type: CreateUploadDto })
  @ApiResponse({
    status: 201,
    description:
      'Upload iniciado — retorna videoId (publicId), uploadId e storageKey',
  })
  @ApiResponse({ status: 400, description: 'Body inválido' })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido' })
  @ApiResponse({
    status: 502,
    description:
      'STORAGE_PROVISIONING_ERROR — o storage falhou ao criar o multipart upload',
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post('uploads/:videoId/parts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assina a URL de upload de uma parte',
    description:
      'Retorna a URL presigned para o cliente enviar a parte diretamente ao object storage.',
  })
  @ApiParam({ name: 'videoId', description: 'publicId do vídeo (11 chars)' })
  @ApiBody({ type: SignPartDto })
  @ApiResponse({ status: 200, description: 'URL presigned da parte' })
  @ApiResponse({ status: 400, description: 'partNumber inválido' })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido' })
  @ApiResponse({
    status: 404,
    description: 'UPLOAD_NOT_FOUND — upload inexistente ou de outro dono',
  })
  @ApiResponse({
    status: 409,
    description: 'UPLOAD_ALREADY_COMPLETED — upload já finalizado ou abortado',
  })
  async signPart(
    @CurrentUser() user: JwtPayload,
    @Param('videoId') videoId: string,
    @Body() dto: SignPartDto,
  ): Promise<{ url: string }> {
    const url = await this.videosService.signPart(
      user.sub,
      videoId,
      dto.partNumber,
    );
    return { url };
  }

  @Get('uploads/:videoId/parts')
  @ApiOperation({
    summary: 'Lista as partes já enviadas',
    description:
      'Fonte de verdade do storage para resume-after-refresh: retorna as partes já enviadas com partNumber e eTag.',
  })
  @ApiParam({ name: 'videoId', description: 'publicId do vídeo (11 chars)' })
  @ApiResponse({ status: 200, description: 'Partes já enviadas' })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido' })
  @ApiResponse({
    status: 404,
    description: 'UPLOAD_NOT_FOUND — upload inexistente ou de outro dono',
  })
  @ApiResponse({
    status: 409,
    description: 'UPLOAD_ALREADY_COMPLETED — upload já finalizado ou abortado',
  })
  async listParts(
    @CurrentUser() user: JwtPayload,
    @Param('videoId') videoId: string,
  ): Promise<{ parts: UploadedPart[] }> {
    const parts = await this.videosService.listParts(user.sub, videoId);
    return { parts };
  }

  @Post('uploads/:videoId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Conclui o upload multipart',
    description:
      'Monta o objeto final no storage, transiciona o vídeo para processing e dispara o processamento em segundo plano.',
  })
  @ApiParam({ name: 'videoId', description: 'publicId do vídeo (11 chars)' })
  @ApiBody({ type: CompleteUploadDto })
  @ApiResponse({
    status: 200,
    description: 'Upload concluído — vídeo em processing',
  })
  @ApiResponse({ status: 400, description: 'Lista de partes inválida' })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido' })
  @ApiResponse({
    status: 404,
    description: 'UPLOAD_NOT_FOUND — upload inexistente ou de outro dono',
  })
  @ApiResponse({
    status: 409,
    description: 'UPLOAD_ALREADY_COMPLETED — upload já finalizado ou abortado',
  })
  @ApiResponse({
    status: 502,
    description:
      'STORAGE_PROVISIONING_ERROR — o storage falhou ao montar o objeto final',
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('videoId') videoId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ videoId: string; status: VideoStatus }> {
    return this.videosService.completeUpload(user.sub, videoId, dto.parts);
  }

  @Delete('uploads/:videoId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Aborta o upload em andamento',
    description:
      'Aborta o multipart upload no storage e remove o rascunho do vídeo.',
  })
  @ApiParam({ name: 'videoId', description: 'publicId do vídeo (11 chars)' })
  @ApiResponse({ status: 204, description: 'Upload abortado' })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido' })
  @ApiResponse({
    status: 404,
    description: 'UPLOAD_NOT_FOUND — upload inexistente ou de outro dono',
  })
  @ApiResponse({
    status: 409,
    description: 'UPLOAD_ALREADY_COMPLETED — upload já finalizado ou abortado',
  })
  @ApiResponse({
    status: 502,
    description:
      'STORAGE_PROVISIONING_ERROR — o storage falhou ao abortar o multipart',
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('videoId') videoId: string,
  ): Promise<void> {
    await this.videosService.abortUpload(user.sub, videoId);
  }

  @Get(':publicId/stream')
  @ApiOperation({
    summary: 'URL de reprodução via streaming',
    description:
      'Retorna a URL presigned servida diretamente pelo object storage — a reprodução usa Range requests, sem download completo e sem passar bytes pela API.',
  })
  @ApiParam({ name: 'publicId', description: 'publicId do vídeo (11 chars)' })
  @ApiResponse({ status: 200, description: 'URL presigned de streaming' })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND — vídeo inexistente ou de outro dono',
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY — vídeo ainda não processado',
  })
  async getStreamUrl(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<{ url: string }> {
    const url = await this.videoDeliveryService.getStreamUrl(
      publicId,
      user.sub,
    );
    return { url };
  }

  @Get(':publicId/download')
  @ApiOperation({
    summary: 'URL de download do vídeo',
    description:
      'Mesma mecânica presigned do streaming, com response-content-disposition=attachment embutido na assinatura para forçar download.',
  })
  @ApiParam({ name: 'publicId', description: 'publicId do vídeo (11 chars)' })
  @ApiResponse({ status: 200, description: 'URL presigned de download' })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND — vídeo inexistente ou de outro dono',
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY — vídeo ainda não processado',
  })
  async getDownloadUrl(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<{ url: string }> {
    const url = await this.videoDeliveryService.getDownloadUrl(
      publicId,
      user.sub,
    );
    return { url };
  }
}
