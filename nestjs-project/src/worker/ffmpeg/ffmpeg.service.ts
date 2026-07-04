import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface VideoProbeResult {
  durationSeconds: number;
  metadata: {
    format: string;
    bitrate: number | null;
    width: number | null;
    height: number | null;
    codec: string | null;
  };
}

interface FfprobeOutput {
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
  };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }>;
}

// Wrapper fino via execFile direto sobre os binários de sistema
// (per phase-03-videos/TD-05 — sem lib wrapper; fluent-ffmpeg arquivado).
@Injectable()
export class FfmpegService {
  async probe(filePath: string): Promise<VideoProbeResult> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ]));
    } catch (error) {
      throw new Error(
        `ffprobe failed for ${filePath}: ${(error as Error).message}`,
        { cause: error },
      );
    }

    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const rawDuration = parseFloat(parsed.format?.duration ?? '');
    if (Number.isNaN(rawDuration)) {
      throw new Error(`ffprobe returned no duration for ${filePath}`);
    }

    const videoStream = parsed.streams?.find(
      (stream) => stream.codec_type === 'video',
    );
    const rawBitrate = parseInt(parsed.format?.bit_rate ?? '', 10);

    return {
      durationSeconds: Math.round(rawDuration),
      metadata: {
        format: parsed.format?.format_name ?? 'unknown',
        bitrate: Number.isNaN(rawBitrate) ? null : rawBitrate,
        width: videoStream?.width ?? null,
        height: videoStream?.height ?? null,
        codec: videoStream?.codec_name ?? null,
      },
    };
  }

  // Frame a ~10% da duração com piso de 1s (per resolução AMB-1 em
  // validation.md). O filtro `thumbnail` re-amostra uma janela de frames a
  // partir do offset e escolhe o mais representativo — cobre o fallback de
  // frame preto/em branco. Vídeos mais curtos que o piso caem para o
  // primeiro frame válido (offset 0).
  async extractThumbnail(
    filePath: string,
    outPath: string,
    durationSeconds: number,
  ): Promise<void> {
    const offset =
      durationSeconds > 1.2 ? Math.max(1, durationSeconds * 0.1) : 0;

    try {
      await this.runThumbnailExtraction(filePath, outPath, offset);
    } catch {
      // Fallback: offset pode cair além do último frame decodificável;
      // re-amostra do início.
      await this.runThumbnailExtraction(filePath, outPath, 0);
    }
  }

  private async runThumbnailExtraction(
    filePath: string,
    outPath: string,
    offsetSeconds: number,
  ): Promise<void> {
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss',
        offsetSeconds.toFixed(2),
        '-i',
        filePath,
        '-vf',
        'thumbnail=n=30',
        '-frames:v',
        '1',
        '-q:v',
        '2',
        outPath,
      ]);
    } catch (error) {
      throw new Error(
        `ffmpeg thumbnail extraction failed for ${filePath} at ${offsetSeconds}s: ${(error as Error).message}`,
        { cause: error },
      );
    }

    const { size } = await stat(outPath);
    if (size === 0) {
      throw new Error(
        `ffmpeg produced an empty thumbnail for ${filePath} at ${offsetSeconds}s`,
      );
    }
  }
}
