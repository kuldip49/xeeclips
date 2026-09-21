import logging
import os
import asyncio
import math
from threading import Lock
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter

from fastapi import FastAPI, HTTPException, Response
from faster_whisper import WhisperModel
from faster_whisper.utils import download_model
from minio import Minio
from pydantic import BaseModel, Field

from app.visual_analysis import analyze_video_chunks
from app.edit_analysis import analyze_edit_window

logger = logging.getLogger('uvicorn.error')
visual_analysis_lock = Lock()  # One CPU-heavy video at a time per service process.

@asynccontextmanager
async def lifespan(application: FastAPI):
    application.state.whisper_model = None
    model_path = os.getenv('WHISPER_MODEL_PATH', '/models/whisper-base')
    local = bool(model_path) and Path(model_path).exists()
    source = model_path if local else os.getenv('WHISPER_MODEL', 'base')
    device = os.getenv('WHISPER_DEVICE', 'cpu')
    compute_type = os.getenv('WHISPER_COMPUTE_TYPE', 'int8')
    offline = any(
        os.getenv(name, '1').strip().upper() in {'1', 'TRUE', 'YES', 'ON'}
        for name in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE')
    )
    logger.info(
        'Whisper source=%s model=%s model_path=%s device=%s compute_type=%s offline=%s',
        'local path' if local else 'Hugging Face model name',
        source, model_path, device, compute_type, 'enabled' if offline else 'disabled',
    )
    for attempt in range(1, 4):
        logger.info('Whisper startup loading attempt %d/3', attempt)
        try:
            resolved_source = source
            if offline and not local:
                resolved_source = await asyncio.to_thread(
                    download_model, source, local_files_only=True,
                )
            if (local or offline) and not (Path(resolved_source) / 'tokenizer.json').is_file():
                raise FileNotFoundError(f'Missing tokenizer.json in {resolved_source}')
            application.state.whisper_model = await asyncio.to_thread(
                WhisperModel, resolved_source, device=device, compute_type=compute_type,
                local_files_only=offline,
            )
            logger.info('Whisper model loaded successfully')
            break
        except Exception:
            logger.exception('Whisper startup loading attempt %d/3 failed', attempt)
            if attempt < 3:
                logger.info('Retrying Whisper startup loading in 2 seconds')
                await asyncio.sleep(2)
    if application.state.whisper_model is None:
        logger.error('Whisper model not loaded. Check local model path.')
    yield
    application.state.whisper_model = None


app = FastAPI(
    title='AI Content Platform AI Service',
    description='English transcription/translation and deterministic visual intelligence service.',
    version='0.3.0',
    lifespan=lifespan,
)


class TranscriptionRequest(BaseModel):
    bucket: str = Field(min_length=1)
    object_key: str = Field(min_length=1)


class TranscriptSegment(BaseModel):
    position: int
    start: float
    end: float
    text: str
    words: list['TranscriptWord'] = Field(default_factory=list)
    confidence: float | None = None
    speaker: str | None = None


class TranscriptWord(BaseModel):
    start: float
    end: float
    text: str
    confidence: float | None = None


class TranscriptionResponse(BaseModel):
    text: str
    language: str | None
    language_probability: float | None
    duration: float | None
    segments: list[TranscriptSegment]


class VisualChunk(BaseModel):
    position: int = Field(ge=0)
    start: float = Field(ge=0)
    end: float = Field(ge=0)


class VisualAnalysisRequest(BaseModel):
    bucket: str = Field(min_length=1)
    object_key: str = Field(min_length=1)
    video_id: str | None = None
    chunks: list[VisualChunk]
    candidates: list[VisualChunk] | None = None


class VisualAnalysisResult(BaseModel):
    position: int
    sampled_frame_count: int
    yolo_frame_count: int = 0
    face_frame_count: int = 0
    ocr_frame_count: int = 0
    shot_boundaries: list[float]
    scene_change_count: int
    scene_cut_rate: float
    average_shot_duration: float
    visual_transition_score: float
    average_motion: float
    visual_novelty: float
    face_count: int
    face_tracks: list[dict[str, float]] = Field(default_factory=list)
    person_tracks: list[dict[str, float]] = Field(default_factory=list)
    largest_face_ratio: float
    face_presence_ratio: float
    average_face_count: float
    primary_face_area_ratio: float
    primary_face_centeredness: float
    face_stability: float
    talking_head_likelihood: float
    person_presence_ratio: float
    average_person_count: float
    object_activity: float
    object_diversity: int
    detected_object_classes: list[str]
    largest_person_prominence: float
    central_person_score: float
    detection_confidence_mean: float
    brightness: float
    contrast: float
    colorfulness: float
    sharpness_score: float
    black_frame_ratio: float
    ocr_text: str
    ocr_confidence: float
    text_area_ratio: float
    subtitle_detected: bool
    title_card_presence: bool


class EditAnalysisRequest(BaseModel):
    bucket: str = Field(min_length=1)
    object_key: str = Field(min_length=1)
    fps: float = Field(default=4.0, gt=0, le=10)
    max_frames: int = Field(default=480, ge=1, le=1200)


@lru_cache(maxsize=1)
def get_storage_client() -> Minio:
    return Minio(
        endpoint='{}:{}'.format(
            os.getenv('MINIO_ENDPOINT', 'localhost'),
            os.getenv('MINIO_PORT', '9000'),
        ),
        access_key=os.getenv('MINIO_ROOT_USER', 'minioadmin'),
        secret_key=os.getenv('MINIO_ROOT_PASSWORD', 'minioadmin'),
        secure=os.getenv('MINIO_USE_SSL', 'false').lower() == 'true',
    )


def get_whisper_model() -> WhisperModel:
    model = getattr(app.state, 'whisper_model', None)
    if model is None:
        raise HTTPException(
            status_code=503, detail='Whisper model not loaded. Check local model path.',
        )
    return model


@app.get('/health')
def health(response: Response) -> dict[str, str]:
    loaded = getattr(app.state, 'whisper_model', None) is not None
    if not loaded:
        response.status_code = 503
    return {
        'service': 'ai-service',
        'status': 'ok' if loaded else 'degraded',
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }


@app.post('/transcriptions', response_model=TranscriptionResponse)
def transcribe(request: TranscriptionRequest) -> TranscriptionResponse:
    whisper_model = get_whisper_model()
    started_at = perf_counter()
    logger.info('Transcription request received')
    logger.info('Bucket: %s', request.bucket)
    logger.info('Object key: %s', request.object_key)
    try:
        with TemporaryDirectory(prefix='ai-content-transcription-') as directory:
            audio_path = Path(directory) / 'audio.wav'
            logger.info('Download started')
            get_storage_client().fget_object(
                request.bucket,
                request.object_key,
                str(audio_path),
            )
            logger.info('Download completed')
            logger.info('Audio file size: %d bytes', audio_path.stat().st_size)

            logger.info('English transcription/translation started')
            raw_segments, info = whisper_model.transcribe(
                str(audio_path),
                beam_size=5,
                vad_filter=True,
                vad_parameters={
                    'min_silence_duration_ms': int(
                        os.getenv('WHISPER_VAD_MIN_SILENCE_MS', '500')
                    ),
                },
                word_timestamps=True,
                task='translate',
            )
            segments = []
            for position, segment in enumerate(raw_segments):
                if not segment.text.strip():
                    continue
                word_items = [
                    TranscriptWord(
                        start=word.start,
                        end=word.end,
                        text=word.word.strip(),
                        confidence=getattr(word, 'probability', None),
                    )
                    for word in (segment.words or [])
                    if word.word.strip()
                ]
                average_word_confidence = (
                    sum(word.confidence for word in word_items if word.confidence is not None)
                    / sum(1 for word in word_items if word.confidence is not None)
                    if any(word.confidence is not None for word in word_items)
                    else None
                )
                segment_confidence = average_word_confidence
                if segment_confidence is None and math.isfinite(segment.avg_logprob):
                    segment_confidence = max(0.0, min(1.0, math.exp(segment.avg_logprob)))
                segments.append(TranscriptSegment(
                    position=position,
                    start=segment.start,
                    end=segment.end,
                    text=segment.text.strip(),
                    words=word_items,
                    confidence=segment_confidence,
                    speaker=None,
                ))
            logger.info('English transcription/translation completed')
            logger.info('Detected source language: %s', info.language)
            logger.info('Number of segments: %d', len(segments))
            logger.info('Total duration: %s seconds', info.duration)

            return TranscriptionResponse(
                text=' '.join(segment.text for segment in segments),
                language=info.language,
                language_probability=info.language_probability,
                duration=info.duration,
                segments=segments,
            )
    except Exception as error:
        logger.exception('Transcription failed')
        raise HTTPException(status_code=500, detail=f'Transcription failed: {error}') from error
    finally:
        logger.info('Total execution time: %.3f seconds', perf_counter() - started_at)


@app.post('/visual-analysis', response_model=list[VisualAnalysisResult])
def visual_analysis(request: VisualAnalysisRequest) -> list[VisualAnalysisResult]:
    if any(chunk.end < chunk.start for chunk in request.chunks):
        raise HTTPException(status_code=422, detail='Chunk end must not precede start')
    if len({chunk.position for chunk in request.chunks}) != len(request.chunks):
        raise HTTPException(status_code=422, detail='Chunk positions must be unique')

    try:
        with TemporaryDirectory(prefix='ai-content-visual-') as directory:
            video_path = Path(directory) / 'source-video'
            get_storage_client().fget_object(
                request.bucket,
                request.object_key,
                str(video_path),
            )
            with visual_analysis_lock:
                results = analyze_video_chunks(
                    video_path,
                    [(chunk.position, chunk.start, chunk.end) for chunk in request.chunks],
                    video_id=request.video_id or request.object_key,
                    candidates=[(item.start, item.end) for item in request.candidates]
                    if request.candidates is not None else None,
                )
            return [VisualAnalysisResult(**result) for result in results]
    except Exception as error:
        logger.exception('Visual analysis failed')
        raise HTTPException(status_code=500, detail=f'Visual analysis failed: {error}') from error


@app.post('/edit-analysis')
def edit_analysis(request: EditAnalysisRequest) -> dict:
    """Dense face/person/text/shot analysis of one short edit window (times relative to its start)."""
    try:
        with TemporaryDirectory(prefix='ai-content-edit-') as directory:
            video_path = Path(directory) / 'edit-window.mp4'
            get_storage_client().fget_object(request.bucket, request.object_key, str(video_path))
            with visual_analysis_lock:
                return analyze_edit_window(video_path, fps=request.fps, max_frames=request.max_frames)
    except Exception as error:
        logger.exception('Edit analysis failed')
        raise HTTPException(status_code=500, detail=f'Edit analysis failed: {error}') from error
