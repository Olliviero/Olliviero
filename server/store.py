"""Small JSON-file store for spaces and projects.

Everything lives in one file, guarded by a lock and written atomically, which
is plenty for a single-user tool and keeps the setup free of a database.
"""

import json
import os
import threading
import time
import uuid
from copy import deepcopy

ACTIVE_STATUSES = {"queued", "downloading", "transcribing", "analyzing", "rendering"}


def new_id():
    return uuid.uuid4().hex[:12]


class Store:
    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()
        self.data = {"spaces": [], "projects": []}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                self.data = json.load(f)

    def _save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)

    # Spaces

    def list_spaces(self):
        with self.lock:
            spaces = deepcopy(self.data["spaces"])
            for space in spaces:
                projects = [p for p in self.data["projects"] if p["space_id"] == space["id"]]
                space["videos"] = len(projects)
                space["clips"] = sum(len(p["clips"]) for p in projects)
                space["status"] = "processing" if any(p["status"] in ACTIVE_STATUSES for p in projects) else "ready"
                space["progress"] = max((p["progress"] for p in projects if p["status"] in ACTIVE_STATUSES), default=0)
                space["updated"] = max([space["created"]] + [p["updated"] for p in projects])
                thumbs = [c["thumb"] for p in projects if p["status"] == "ready" for c in p["clips"]]
                space["thumbs"] = thumbs[-3:]
            return spaces

    def create_space(self, name, color):
        with self.lock:
            space = {"id": new_id(), "name": name, "color": color, "created": time.time() * 1000}
            self.data["spaces"].insert(0, space)
            self._save()
            return deepcopy(space)

    def delete_space(self, space_id):
        with self.lock:
            removed = [p for p in self.data["projects"] if p["space_id"] == space_id]
            self.data["spaces"] = [s for s in self.data["spaces"] if s["id"] != space_id]
            self.data["projects"] = [p for p in self.data["projects"] if p["space_id"] != space_id]
            self._save()
            return removed

    def get_space(self, space_id):
        with self.lock:
            return deepcopy(next((s for s in self.data["spaces"] if s["id"] == space_id), None))

    # Projects

    def create_project(self, space_id, source, kind):
        with self.lock:
            now = time.time() * 1000
            project = {
                "id": new_id(),
                "space_id": space_id,
                "source": source,
                "kind": kind,
                "title": source,
                "status": "queued",
                "stage": "I kø",
                "progress": 0,
                "error": None,
                "duration": None,
                "clips": [],
                "created": now,
                "updated": now,
            }
            self.data["projects"].insert(0, project)
            self._save()
            return deepcopy(project)

    def get_project(self, project_id):
        with self.lock:
            return deepcopy(next((p for p in self.data["projects"] if p["id"] == project_id), None))

    def list_projects(self, space_id):
        with self.lock:
            return deepcopy([p for p in self.data["projects"] if p["space_id"] == space_id])

    def update_project(self, project_id, **fields):
        with self.lock:
            project = next((p for p in self.data["projects"] if p["id"] == project_id), None)
            if project is None:
                return None
            project.update(fields)
            project["updated"] = time.time() * 1000
            self._save()
            return deepcopy(project)

    def delete_project(self, project_id):
        with self.lock:
            project = next((p for p in self.data["projects"] if p["id"] == project_id), None)
            self.data["projects"] = [p for p in self.data["projects"] if p["id"] != project_id]
            self._save()
            return project

    def unfinished_projects(self):
        with self.lock:
            return [p["id"] for p in self.data["projects"] if p["status"] in ACTIVE_STATUSES]
