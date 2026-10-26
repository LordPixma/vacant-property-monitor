"""VacantWatch insights Worker (Python).

Reached only through a service binding from the API Worker, never from the public
internet (workers_dev and routes are off in wrangler.jsonc). Two endpoints:

  POST /v1/assess  property + visits + enrichment -> priority, likelihood, actions, area profile
  POST /v1/area    enrichment                     -> area profile
  GET  /health
"""

import json

from workers import Response, WorkerEntrypoint

from insights.area import area_profile
from insights.scoring import MODEL_VERSION, assess

MAX_BODY = 2_000_000


def _json(data, status=200):
    return Response(json.dumps(data), status=status, headers={"content-type": "application/json"})


async def handle(method: str, path: str, read_text):
    if method == "GET" and path == "/health":
        return _json({"ok": True, "model_version": MODEL_VERSION})
    if method != "POST" or path not in ("/v1/assess", "/v1/area"):
        return _json({"error": "not found"}, 404)
    text = await read_text()
    if len(text) > MAX_BODY:
        return _json({"error": "payload too large"}, 413)
    try:
        payload = json.loads(text)
    except ValueError:
        return _json({"error": "body must be JSON"}, 400)
    if not isinstance(payload, dict):
        return _json({"error": "body must be an object"}, 400)
    if path == "/v1/assess":
        return _json(assess(payload).to_dict())
    return _json({"area_profile": area_profile(payload.get("enrichment") or {}), "model_version": MODEL_VERSION})


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        from urllib.parse import urlparse

        path = urlparse(str(request.url)).path
        try:
            return await handle(str(request.method), path, request.text)
        except Exception as err:  # noqa: BLE001 - report, never crash the binding
            print(f"insights error: {err!r}")
            return _json({"error": "internal", "detail": type(err).__name__}, 500)
