"""Pick the moments of a transcript that work as standalone short clips.

Claude reads the timestamped transcript and returns clip suggestions with a
title, a social caption and a virality score. Without Anthropic credentials,
or if the request fails, a simple heuristic picks clips instead so the rest of
the pipeline still runs.
"""

import json
import logging
import os
import re

log = logging.getLogger(__name__)

MODEL = os.environ.get("CLIPS_MODEL", "claude-opus-5-5")

CLIP_SCHEMA = {
    "type": "object",
    "properties": {
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start": {"type": "number"},
                    "end": {"type": "number"},
                    "title": {"type": "string"},
                    "caption": {"type": "string"},
                    "hashtags": {"type": "array", "items": {"type": "string"}},
                    "score": {"type": "integer"},
                    "reason": {"type": "string"},
                },
                "required": ["start", "end", "title", "caption", "hashtags", "score", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["clips"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You are a short-form video editor. You turn long videos (podcasts, interviews, \
streams, talks) into vertical clips for TikTok, Instagram Reels and YouTube Shorts.

From the timestamped transcript, choose the moments most likely to perform well as standalone clips. \
A good clip opens with a hook in the first seconds, makes sense without the rest of the video, \
covers one complete idea or story, and ends on a natural sentence boundary. Prefer strong opinions, \
surprising facts, emotional moments, humour and practical advice. Never cut mid-sentence.

For each clip return:
- start and end in seconds, taken from the transcript timestamps
- title: a short hook-style title (max 60 characters)
- caption: a social media post text for the clip, 1-2 sentences
- hashtags: 3-5 relevant hashtags without the # sign
- score: predicted virality from 0 to 100, using the full range honestly
- reason: one sentence on why this moment works

Write title, caption and hashtags in the same language as the transcript."""


def has_credentials():
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def format_transcript(segments):
    return "\n".join(f"[{s['start']:.1f}-{s['end']:.1f}] {s['text'].strip()}" for s in segments)


def target_clip_count(duration):
    # Roughly one clip per 40 seconds of video, between 1 and 12.
    return max(1, min(12, round(duration / 40)))


def pick_with_claude(segments, duration, min_len, max_len):
    import anthropic

    client = anthropic.Anthropic()
    count = target_clip_count(duration)
    prompt = (
        f"Video length: {duration:.0f} seconds.\n"
        f"Choose up to {count} clips, each between {min_len} and {max_len} seconds long, "
        f"without overlaps.\n\n<transcript>\n{format_transcript(segments)}\n</transcript>"
    )
    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=SYSTEM_PROMPT,
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": CLIP_SCHEMA}},
        messages=[{"role": "user", "content": prompt}],
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("Claude declined to pick clips for this transcript")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("Claude's answer was cut off before it finished")
    text = next(b.text for b in response.content if b.type == "text")
    return json.loads(text)["clips"]


def pick_with_heuristic(segments, duration, min_len, max_len):
    """Score windows of consecutive segments by speech density and energy."""
    candidates = []
    for i in range(len(segments)):
        text = ""
        for j in range(i, len(segments)):
            text += " " + segments[j]["text"].strip()
            length = segments[j]["end"] - segments[i]["start"]
            if length > max_len:
                break
            if length < min_len:
                continue
            words = len(text.split())
            gaps = sum(
                max(0.0, segments[k + 1]["start"] - segments[k]["end"]) for k in range(i, j)
            )
            energy = text.count("!") * 2 + text.count("?") * 1.5
            score = words / length * 10 + energy - gaps * 2
            candidates.append((score, segments[i]["start"], segments[j]["end"], text.strip()))

    candidates.sort(reverse=True)
    picked = []
    for score, start, end, text in candidates:
        if len(picked) >= target_clip_count(duration):
            break
        if any(start < p["end"] and end > p["start"] for p in picked):
            continue
        first_sentence = re.split(r"(?<=[.!?])\s", text, maxsplit=1)[0]
        title = first_sentence if len(first_sentence) <= 60 else first_sentence[:57].rstrip() + "…"
        picked.append({
            "start": start,
            "end": end,
            "title": title,
            "caption": text[:140].rstrip() + ("…" if len(text) > 140 else ""),
            "hashtags": [],
            "score": score,
            "reason": "Valgt ut fra hvor tett og engasjert praten er.",
        })

    # Map raw heuristic scores onto a 55-90 range so they read like the AI scores.
    if picked:
        lo = min(p["score"] for p in picked)
        hi = max(p["score"] for p in picked)
        for p in picked:
            p["score"] = round(55 + (p["score"] - lo) / (hi - lo) * 35) if hi > lo else 70
    return sorted(picked, key=lambda p: p["start"])


def snap_to_words(clip, words, min_len, max_len):
    """Move clip edges onto word boundaries so nothing starts or ends mid-word."""
    inside = [w for w in words if w["end"] > clip["start"] - 0.3 and w["start"] < clip["end"] + 0.3]
    if not inside:
        return None
    start = max(0.0, inside[0]["start"] - 0.15)
    end = inside[-1]["end"] + 0.25
    if end - start > max_len:
        end = start + max_len
    if end - start < min(min_len, 5):
        return None
    return {**clip, "start": round(start, 2), "end": round(end, 2)}


def pick_clips(segments, words, duration, min_len=15, max_len=60):
    """Return (clips, method) where method says who picked them."""
    if not segments:
        return [], "none"

    clips, method = None, "heuristic"
    if has_credentials():
        try:
            clips, method = pick_with_claude(segments, duration, min_len, max_len), "claude"
        except Exception:
            log.exception("Claude clip selection failed, falling back to the heuristic")
    if clips is None:
        clips = pick_with_heuristic(segments, duration, min_len, max_len)

    result = []
    for clip in sorted(clips, key=lambda c: c["start"]):
        clip["score"] = max(0, min(100, int(clip["score"])))
        clip["hashtags"] = [h.lstrip("#") for h in clip["hashtags"]][:5]
        snapped = snap_to_words(clip, words, min_len, max_len)
        if snapped and not any(snapped["start"] < r["end"] and snapped["end"] > r["start"] for r in result):
            result.append(snapped)
    return result, method
