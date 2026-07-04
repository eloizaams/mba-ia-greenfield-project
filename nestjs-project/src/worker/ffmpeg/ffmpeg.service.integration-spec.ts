import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FfmpegService } from './ffmpeg.service';

const execFileAsync = promisify(execFile);

// Adapter real (per testing-guide — side-effect dep): exige ffmpeg/ffprobe
// no container. Fixtures geradas em runtime via lavfi.
describe('FfmpegService (integration — real ffmpeg/ffprobe)', () => {
  let service: FfmpegService;
  let workDir: string;
  let normalVideo: string;
  let shortVideo: string;

  const generateVideo = async (
    outPath: string,
    durationSeconds: number,
  ): Promise<void> => {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${durationSeconds}:size=320x240:rate=10`,
      '-pix_fmt',
      'yuv420p',
      outPath,
    ]);
  };

  beforeAll(async () => {
    service = new FfmpegService();
    workDir = await mkdtemp(join(tmpdir(), 'ffmpeg-spec-'));
    normalVideo = join(workDir, 'normal.mp4');
    shortVideo = join(workDir, 'short.mp4');
    await generateVideo(normalVideo, 4);
    await generateVideo(shortVideo, 0.5);
  }, 60000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('should probe duration and metadata from a real video', async () => {
    const result = await service.probe(normalVideo);

    expect(result.durationSeconds).toBeGreaterThanOrEqual(3);
    expect(result.durationSeconds).toBeLessThanOrEqual(5);
    expect(result.metadata.width).toBe(320);
    expect(result.metadata.height).toBe(240);
    expect(result.metadata.codec).toBeTruthy();
    expect(result.metadata.format).toContain('mp4');
    expect(result.metadata.bitrate).toBeGreaterThan(0);
  });

  it('should extract a non-empty thumbnail from a normal video', async () => {
    const outPath = join(workDir, 'thumb-normal.jpg');

    await service.extractThumbnail(normalVideo, outPath, 4);

    const { size } = await stat(outPath);
    expect(size).toBeGreaterThan(0);
  });

  it('should extract a thumbnail from a video shorter than the 1s floor (fallback)', async () => {
    const outPath = join(workDir, 'thumb-short.jpg');

    await service.extractThumbnail(shortVideo, outPath, 1);

    const { size } = await stat(outPath);
    expect(size).toBeGreaterThan(0);
  });

  it('should reject with an identifiable error for a missing or corrupted file', async () => {
    await expect(service.probe(join(workDir, 'missing.mp4'))).rejects.toThrow(
      /ffprobe failed/,
    );

    await expect(
      service.extractThumbnail(
        join(workDir, 'missing.mp4'),
        join(workDir, 'thumb-missing.jpg'),
        4,
      ),
    ).rejects.toThrow(/thumbnail extraction failed/);
  });
});
