export const VIDEO_PROCESSING_QUEUE = 'video-processing' as const;

export const VIDEO_PROCESSING_REQUESTED_JOB =
  'video.processing.requested' as const;

export interface VideoProcessingJobPayload {
  videoId: string;
  storageKey: string;
}
