"""Exercise the request handler without the Workers runtime by stubbing the `workers` module."""

import asyncio
import json
import sys
import types


class _Response:
    def __init__(self, body, status=200, headers=None):
        self.body, self.status, self.headers = body, status, headers or {}


stub = types.ModuleType("workers")
stub.Response = _Response
stub.WorkerEntrypoint = object
sys.modules.setdefault("workers", stub)

import entry  # noqa: E402


def call(method, path, body=""):
    async def read():
        return body

    return asyncio.run(entry.handle(method, path, read))


def test_health():
    r = call("GET", "/health")
    assert r.status == 200 and json.loads(r.body)["ok"] is True


def test_assess_round_trip():
    r = call("POST", "/v1/assess", json.dumps({"property": {"status": "confirmed_vacant"}, "now": 0}))
    out = json.loads(r.body)
    assert r.status == 200
    assert {"priority_score", "priority_band", "vacancy_likelihood", "recommended_actions", "area_profile"} <= out.keys()


def test_bad_json_and_unknown_path():
    assert call("POST", "/v1/assess", "{nope").status == 400
    assert call("POST", "/v1/assess", "[1]").status == 400
    assert call("GET", "/v1/assess").status == 404
