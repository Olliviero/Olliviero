"""Cut, reframe to 9:16 and caption clips with ffmpeg."""

import json
import logging
import os
import subprocess

log = logging.getLogger(__name__)

OUT_W, OUT_H = 1080, 1920
CAPTION_FONT = os.environ.get("CAPTION_FONT", "DejaVu Sans")
# ASS colours are &HBBGGRR.
CAPTION_HIGHLIGHT = "&H0055E6FF"


def run(cmd):
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {result.stderr.strip()[-800:]}")
    return result.stdout


def probe(path):
    info = json.loads(run([
        "ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path,
    ]))
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    width, height = int(video["width"]), int(video["height"])
    rotation = abs(int(video.get("tags", {}).get("rotate", 0)))
    for side in video.get("side_data_list", []):
        rotation = abs(int(side.get("rotation", rotation)))
    if rotation in (90, 270):
        width, height = height, width
    return {"duration": float(info["format"]["duration"]), "width": width, "height": height}


def extract_audio(src, dst):
    run(["ffmpeg", "-y", "-v", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000", dst])


# Reframing


def crop_box(width, height):
    """Largest 9:16 box that fits in the source frame (even sizes for x264)."""
    if width / height > 9 / 16:
        crop_h = height - height % 2
        crop_w = int(crop_h * 9 / 16) // 2 * 2
    else:
        crop_w = width - width % 2
        crop_h = min(height, int(crop_w * 16 / 9)) // 2 * 2
    return crop_w, crop_h


def face_track(src, start, end, width, sample_fps=2.0):
    """Return [(t, face_center_x)] samples relative to the clip start."""
    try:
        import cv2
    except ImportError:
        return []

    cascade = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml"))
    cap = cv2.VideoCapture(src)
    samples = []
    t = start
    while t < end:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            break
        scale = 480 / frame.shape[1]
        small = cv2.resize(frame, None, fx=scale, fy=scale)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(24, 24))
        if len(faces):
            x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
            samples.append((t - start, (x + w / 2) / scale))
        t += 1 / sample_fps
    cap.release()
    return samples


def crop_segments(samples, duration, frame_w, crop_w, min_hold=1.5, tolerance=None):
    """Turn face samples into a few steady camera positions.

    The camera only moves when the face drifts out of a dead zone, and each
    position is held for at least `min_hold` seconds, which reads like a human
    operator rather than a shaky tracker.
    """
    centre = frame_w / 2
    if not samples:
        return [(0.0, duration, int(centre - crop_w / 2))]

    tolerance = tolerance or crop_w * 0.18
    segments = []
    seg_start, seg_xs = 0.0, [samples[0][1]]
    for t, x in samples[1:]:
        current = sorted(seg_xs)[len(seg_xs) // 2]
        if abs(x - current) > tolerance and t - seg_start >= min_hold:
            segments.append([seg_start, t, current])
            seg_start, seg_xs = t, [x]
        else:
            seg_xs.append(x)
    segments.append([seg_start, duration, sorted(seg_xs)[len(seg_xs) // 2]])
    # Fold a short final move into the previous position instead of jumping at the end.
    if len(segments) > 1 and duration - segments[-1][0] < min_hold:
        segments[-2][1] = duration
        segments.pop()

    result = []
    for s, e, x in segments:
        left = int(min(max(x - crop_w / 2, 0), frame_w - crop_w))
        result.append((s, e, left))
    return result


def crop_x_expr(segments):
    """ffmpeg expression that switches crop x per segment, using the frame time t."""
    expr = str(segments[-1][2])
    for start, end, x in reversed(segments[:-1]):
        expr = f"if(lt(t,{end:.2f}),{x},{expr})"
    return expr


# Captions


def ass_time(seconds):
    seconds = max(0.0, seconds)
    h = int(seconds // 3600)
    m = int(seconds % 3600 // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def ass_escape(text):
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", " ")


def caption_chunks(words, max_words=3, max_gap=0.6):
    chunks, current = [], []
    for word in words:
        if current and (len(current) >= max_words or word["start"] - current[-1]["end"] > max_gap):
            chunks.append(current)
            current = []
        current.append(word)
    if current:
        chunks.append(current)
    return chunks


def write_captions(words, clip_start, clip_end, path):
    """Write an ASS file with short word groups and the spoken word highlighted."""
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {OUT_W}
PlayResY: {OUT_H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,{CAPTION_FONT},88,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,2,2,80,80,520,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    clip_words = [
        {**w, "start": w["start"] - clip_start, "end": w["end"] - clip_start}
        for w in words
        if w["start"] >= clip_start - 0.05 and w["end"] <= clip_end + 0.05
    ]
    for chunk in caption_chunks(clip_words):
        tokens = [ass_escape(w["word"].strip().upper()) for w in chunk]
        for i, word in enumerate(chunk):
            start = word["start"]
            end = chunk[i + 1]["start"] if i + 1 < len(chunk) else word["end"]
            text = " ".join(
                f"{{\\c{CAPTION_HIGHLIGHT}}}{t}{{\\c&H00FFFFFF&}}" if j == i else t
                for j, t in enumerate(tokens)
            )
            lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Caption,,0,0,0,,{text}")

    with open(path, "w", encoding="utf-8") as f:
        f.write(header + "\n".join(lines) + "\n")


# Rendering


def render_clip(src, info, clip, words, out_dir, clip_id, captions=True):
    """Render one 1080x1920 clip and its thumbnail. Returns the file names."""
    start, end = clip["start"], clip["end"]
    duration = end - start
    crop_w, crop_h = crop_box(info["width"], info["height"])
    samples = face_track(src, start, end, info["width"])
    segments = crop_segments(samples, duration, info["width"], crop_w)
    crop_y = (info["height"] - crop_h) // 2

    filters = [
        f"crop={crop_w}:{crop_h}:'{crop_x_expr(segments)}':{crop_y}",
        f"scale={OUT_W}:{OUT_H}:flags=lanczos",
        "setsar=1",
    ]
    ass_name = f"{clip_id}.ass"
    if captions and words:
        write_captions(words, start, end, os.path.join(out_dir, ass_name))
        filters.append(f"subtitles={ass_name}")

    video_name = f"{clip_id}.mp4"
    thumb_name = f"{clip_id}.jpg"
    # Paths are relative to out_dir so the subtitles filter needs no escaping.
    subprocess_cwd = out_dir
    src_abs = os.path.abspath(src)
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-ss", f"{start:.3f}", "-i", src_abs, "-t", f"{duration:.3f}",
        "-vf", ",".join(filters),
        "-c:v", "libx264", "-preset", os.environ.get("X264_PRESET", "veryfast"), "-crf", "20",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
        video_name,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=subprocess_cwd)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.strip()[-800:]}")

    run([
        "ffmpeg", "-y", "-v", "error", "-ss", f"{min(1.0, duration / 2):.2f}",
        "-i", os.path.join(out_dir, video_name), "-frames:v", "1", "-vf", "scale=360:-2",
        os.path.join(out_dir, thumb_name),
    ])
    ass_path = os.path.join(out_dir, ass_name)
    if os.path.exists(ass_path):
        os.remove(ass_path)
    return video_name, thumb_name, bool(samples)
