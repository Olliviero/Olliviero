# Olliviero Spaces

Turns long videos into short vertical clips for TikTok, Reels and YouTube Shorts. Paste a YouTube link or upload a file, and the app picks the best moments, crops them to 9:16 so the speaker stays in frame, and burns in word-by-word captions. Each clip gets a title, a post caption with hashtags, and a virality score.

## How it works

1. **Download:** fetches the video with [yt-dlp](https://github.com/yt-dlp/yt-dlp). This works for YouTube, Twitch and many other sites. You can also upload a file instead.
2. **Transcribe:** [faster-whisper](https://github.com/SYSTRAN/faster-whisper) produces a transcript with timestamps for every word.
3. **Pick highlights:** Claude reads the transcript and chooses the moments that work as standalone clips. It also writes the title, caption and hashtags, and gives each clip a score from 0 to 100. Without an Anthropic API key, a simpler built-in method picks clips from how dense and lively the speech is.
4. **Render:** ffmpeg cuts each clip to 1080×1920 and burns in the captions. OpenCV face detection sets where the frame sits, and the frame only moves when the speaker moves.

## Running it

You need Python 3.10+ and ffmpeg (with libass, which most builds include).

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r server/requirements.txt

export ANTHROPIC_API_KEY=sk-ant-...   # optional, but gives much better clips
uvicorn app:app --app-dir server --port 8000
```

Open http://localhost:8000. The first transcription downloads the Whisper model, which takes a minute.

If you open `index.html` directly, without the server, the page only shows sample clips. It can't fetch or cut videos, because that work has to happen on the server.

## Putting it online

The `Dockerfile` builds an image with Python, ffmpeg and the app. Any host that runs Docker images works, for example Railway, Render or Fly.io:

1. Create a new service from this GitHub repository. The host finds the `Dockerfile` by itself.
2. Set the environment variables `ANTHROPIC_API_KEY` and `APP_PASSWORD`.
3. Attach a volume at `/data` so your clips survive restarts and redeploys.

Without `APP_PASSWORD`, anyone who finds the address can use the app, and your API key with it. When it is set, the browser asks for a username and password. The username can be anything; the password must match `APP_PASSWORD`.

Choose a plan with at least 2 GB of memory. Whisper needs it to transcribe.

### Settings

All settings are environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | Lets Claude pick clips. Without it, the built-in method picks them |
| `CLIPS_MODEL` | `claude-opus-5-5` | Claude model used to pick clips |
| `WHISPER_MODEL` | `small` | `tiny`, `base`, `small`, `medium` or `large-v3`. Larger models are more accurate but slower |
| `WHISPER_DEVICE` | `auto` | `cpu` or `cuda` |
| `MIN_CLIP_SECONDS` / `MAX_CLIP_SECONDS` | `15` / `60` | Shortest and longest clip length |
| `CAPTION_FONT` | `DejaVu Sans` | Font used for burned-in captions; must be installed on the server |
| `DATA_DIR` | `./data` | Where videos, clips and the database are stored |
| `MAX_UPLOAD_MB` | `4096` | Largest file that can be uploaded |
| `APP_PASSWORD` | unset | Requires this password before anyone can use the app |
| `KEEP_SOURCE` | unset | Set to `1` to keep the full source video after the clips are made |

On a CPU, transcribing a long video takes a while. Choose a smaller `WHISPER_MODEL` for speed, or run on a GPU with `WHISPER_DEVICE=cuda`.

## Content rights

Only process videos you own or have permission to use. YouTube's terms do not allow downloading other people's videos.

## Project layout

- `index.html`, `styles.css`, `app.js`: the web page
- `server/app.py`: HTTP API and static file server
- `server/pipeline.py`: background worker for the download, transcribe, pick and render steps
- `server/highlights.py`: picks clips, with Claude or the built-in method
- `server/render.py`: ffmpeg cutting, 9:16 reframing and captions
- `server/store.py`: JSON file storage for spaces and videos
