FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/requirements.txt server/
RUN pip install --no-cache-dir -r server/requirements.txt

COPY index.html styles.css app.js ./
COPY server/ server/

# Videos, clips and the database live here; mount a volume to keep them.
ENV DATA_DIR=/data
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app:app --app-dir server --host 0.0.0.0 --port ${PORT:-8000}"]
