"""HTTP API and static file server for the Spaces app.

Run from the repository root:
    uvicorn app:app --app-dir server --port 8000
"""

import base64
import hmac
import logging
import os
import shutil
from urllib.parse import urlparse

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import highlights
from pipeline import WHISPER_MODEL, Worker
from store import Store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(ROOT, "data"))
MEDIA_DIR = os.path.join(DATA_DIR, "media")
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", 4096))
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
os.makedirs(MEDIA_DIR, exist_ok=True)

store = Store(os.path.join(DATA_DIR, "db.json"))
worker = Worker(store, MEDIA_DIR)
for unfinished in store.unfinished_projects():
    worker.enqueue(unfinished)

app = FastAPI(title="Olliviero Spaces")
app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")


@app.middleware("http")
async def require_password(request, call_next):
    """When APP_PASSWORD is set, ask for it (any username) on every request."""
    if APP_PASSWORD:
        supplied = ""
        header = request.headers.get("authorization", "")
        if header.startswith("Basic "):
            try:
                supplied = base64.b64decode(header[6:]).decode().partition(":")[2]
            except ValueError:
                pass
        if not hmac.compare_digest(supplied.encode(), APP_PASSWORD.encode()):
            return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="Spaces"'})
    return await call_next(request)


class SpaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    color: int = Field(ge=0, le=20)


class LinkIn(BaseModel):
    space_id: str
    url: str = Field(max_length=2000)


def require_space(space_id):
    if store.get_space(space_id) is None:
        raise HTTPException(404, "Fant ikke dette spacet")


@app.get("/api/health")
def health():
    return {"ok": True, "ai": highlights.has_credentials(), "whisper_model": WHISPER_MODEL}


@app.get("/api/spaces")
def list_spaces():
    return store.list_spaces()


@app.post("/api/spaces", status_code=201)
def create_space(body: SpaceIn):
    return store.create_space(body.name.strip(), body.color)


@app.delete("/api/spaces/{space_id}", status_code=204)
def delete_space(space_id: str):
    require_space(space_id)
    for project in store.delete_space(space_id):
        shutil.rmtree(os.path.join(MEDIA_DIR, project["id"]), ignore_errors=True)


@app.get("/api/spaces/{space_id}/projects")
def list_projects(space_id: str):
    require_space(space_id)
    return store.list_projects(space_id)


@app.post("/api/projects", status_code=201)
def create_from_link(body: LinkIn):
    require_space(body.space_id)
    url = body.url.strip()
    if urlparse(url).scheme not in ("http", "https"):
        raise HTTPException(400, "Lenken må starte med http:// eller https://")
    project = store.create_project(body.space_id, url, "url")
    worker.enqueue(project["id"])
    return project


@app.post("/api/projects/upload", status_code=201)
def create_from_upload(space_id: str = Form(...), file: UploadFile = File(...)):
    require_space(space_id)
    ext = os.path.splitext(file.filename or "")[1].lower() or ".mp4"
    if not ext[1:].isalnum() or len(ext) > 6:
        raise HTTPException(400, "Ukjent filtype")

    project = store.create_project(space_id, file.filename or "Opplastet video", "upload")
    folder = worker.project_dir(project["id"])
    limit = MAX_UPLOAD_MB * 1024 * 1024
    written = 0
    with open(os.path.join(folder, "source" + ext), "wb") as out:
        while chunk := file.file.read(1024 * 1024):
            written += len(chunk)
            if written > limit:
                out.close()
                store.delete_project(project["id"])
                shutil.rmtree(folder, ignore_errors=True)
                raise HTTPException(413, f"Filen er større enn {MAX_UPLOAD_MB} MB")
            out.write(chunk)
    worker.enqueue(project["id"])
    return project


@app.get("/api/projects/{project_id}")
def get_project(project_id: str):
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(404, "Fant ikke denne videoen")
    return project


@app.delete("/api/projects/{project_id}", status_code=204)
def delete_project(project_id: str):
    if store.delete_project(project_id) is None:
        raise HTTPException(404, "Fant ikke denne videoen")
    shutil.rmtree(os.path.join(MEDIA_DIR, project_id), ignore_errors=True)


# The web page itself. Each route serves one fixed file; the handler takes no
# parameters so nothing from the request can choose which file is read.
def static_page(name):
    def handler():
        return FileResponse(os.path.join(ROOT, name))
    return handler


for page in ("index.html", "styles.css", "app.js"):
    app.add_api_route(
        "/" + ("" if page == "index.html" else page),
        static_page(page),
        methods=["GET"],
        include_in_schema=False,
    )
