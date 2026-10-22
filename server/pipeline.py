"""Background worker that turns one long video into short clips.

Stages: download -> transcribe -> pick highlights -> render clips.
Projects run one at a time on a single worker thread; each stage reports
progress into the store so the web page can show it.
"""

import glob
import logging
import os
import queue
import shutil
import threading

import highlights
import render

log = logging.getLogger(__name__)

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "auto")
MIN_CLIP = float(os.environ.get("MIN_CLIP_SECONDS", 15))
MAX_CLIP = float(os.environ.get("MAX_CLIP_SECONDS", 60))

# Progress budget per stage, out of 100.
DOWNLOAD, TRANSCRIBE, ANALYZE, RENDER = (0, 20), (20, 55), (55, 60), (60, 100)


def scaled(stage, fraction):
    lo, hi = stage
    return int(lo + (hi - lo) * max(0.0, min(1.0, fraction)))


class Worker:
    def __init__(self, store, media_dir):
        self.store = store
        self.media_dir = media_dir
        self.jobs = queue.Queue()
        self._whisper = None
        threading.Thread(target=self._loop, daemon=True).start()

    def project_dir(self, project_id):
        path = os.path.join(self.media_dir, project_id)
        os.makedirs(path, exist_ok=True)
        return path

    def enqueue(self, project_id):
        self.jobs.put(project_id)

    def _loop(self):
        while True:
            project_id = self.jobs.get()
            try:
                self._process(project_id)
            except Exception as exc:
                log.exception("Project %s failed", project_id)
                self.store.update_project(project_id, status="failed", stage="Feilet", error=str(exc))

    def _update(self, project_id, **fields):
        if self.store.update_project(project_id, **fields) is None:
            raise ProjectDeleted()

    def _process(self, project_id):
        project = self.store.get_project(project_id)
        if project is None:
            return
        try:
            self._run(project)
        except ProjectDeleted:
            shutil.rmtree(os.path.join(self.media_dir, project_id), ignore_errors=True)

    def _run(self, project):
        pid = project["id"]
        folder = self.project_dir(pid)

        # 1. Source video
        if project["kind"] == "url":
            self._update(pid, status="downloading", stage="Henter video", progress=0)
            src, title = self._download(pid, project["source"], folder)
            self._update(pid, title=title)
        else:
            src = next(iter(glob.glob(os.path.join(folder, "source.*"))), None)
            if not src:
                raise RuntimeError("Fant ikke den opplastede filen")
        info = render.probe(src)
        self._update(pid, duration=info["duration"], progress=DOWNLOAD[1])

        # 2. Transcript with word timestamps
        self._update(pid, status="transcribing", stage="Lager transkripsjon")
        segments, words, language = self._transcribe(pid, src, folder, info["duration"])
        if not words:
            raise RuntimeError("Fant ingen tale i videoen. Klippene bygger på det som blir sagt.")

        # 3. Highlights
        self._update(pid, status="analyzing", stage="Finner de beste øyeblikkene", progress=ANALYZE[0], language=language)
        clips, method = highlights.pick_clips(segments, words, info["duration"], MIN_CLIP, MAX_CLIP)
        if not clips:
            raise RuntimeError("Fant ingen passende klipp i videoen")
        self._update(pid, picked_by=method, progress=ANALYZE[1])

        # 4. Render
        self._update(pid, status="rendering", stage=f"Lager klipp 1 av {len(clips)}")
        done = []
        for i, clip in enumerate(clips):
            clip_id = f"clip{i + 1}"
            video, thumb, tracked = render.render_clip(src, info, clip, words, folder, clip_id)
            done.append({
                "id": clip_id,
                "title": clip["title"],
                "caption": clip["caption"],
                "hashtags": clip["hashtags"],
                "score": clip["score"],
                "reason": clip["reason"],
                "start": clip["start"],
                "end": clip["end"],
                "duration": round(clip["end"] - clip["start"], 1),
                "face_tracked": tracked,
                "video": f"/media/{pid}/{video}",
                "thumb": f"/media/{pid}/{thumb}",
            })
            stage = f"Lager klipp {i + 2} av {len(clips)}" if i + 1 < len(clips) else "Ferdig"
            self._update(pid, clips=done, stage=stage, progress=scaled(RENDER, (i + 1) / len(clips)))

        if os.environ.get("KEEP_SOURCE") != "1":
            os.remove(src)
        self._update(pid, status="ready", stage="Ferdig", progress=100)

    def _download(self, pid, url, folder):
        import yt_dlp

        def hook(d):
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                if total:
                    self._update(pid, progress=scaled(DOWNLOAD, d.get("downloaded_bytes", 0) / total))

        options = {
            "format": "bv*[height<=1080]+ba/b[height<=1080]/b",
            "merge_output_format": "mp4",
            "outtmpl": os.path.join(folder, "source.%(ext)s"),
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "progress_hooks": [hook],
        }
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
        files = glob.glob(os.path.join(folder, "source.*"))
        if not files:
            raise RuntimeError("Klarte ikke å laste ned videoen")
        return files[0], info.get("title") or url

    def _model(self):
        if self._whisper is None:
            from faster_whisper import WhisperModel

            compute = "int8" if WHISPER_DEVICE in ("cpu", "auto") else "float16"
            self._whisper = WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=compute)
        return self._whisper

    def _transcribe(self, pid, src, folder, duration):
        audio = os.path.join(folder, "audio.wav")
        render.extract_audio(src, audio)
        try:
            raw_segments, info = self._model().transcribe(audio, word_timestamps=True, vad_filter=True)
            segments, words = [], []
            for seg in raw_segments:
                segments.append({"start": seg.start, "end": seg.end, "text": seg.text})
                for w in seg.words or []:
                    words.append({"start": w.start, "end": w.end, "word": w.word})
                self._update(pid, progress=scaled(TRANSCRIBE, seg.end / duration))
        finally:
            os.remove(audio)
        return segments, words, info.language


class ProjectDeleted(Exception):
    """The project was deleted while it was being processed."""
