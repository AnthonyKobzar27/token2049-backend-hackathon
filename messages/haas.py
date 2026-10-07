"""HaasClient: the only class that knows the TS core's HTTP routes."""

import httpx

from config import HAAS_TOKEN, HAAS_URL


class HaasClient:
    def __init__(self, base_url: str = HAAS_URL, token: str = HAAS_TOKEN):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        self._http = httpx.Client(base_url=base_url, headers=headers, timeout=30)

    def _get(self, path: str, **params) -> dict | list:
        res = self._http.get(path, params=params or None)
        res.raise_for_status()
        return res.json()

    def _post(self, path: str, body: dict) -> dict:
        res = self._http.post(path, json=body)
        if res.status_code >= 400:
            detail = res.json().get("error", res.text) if res.headers.get("content-type", "").startswith("application/json") else res.text
            raise RuntimeError(detail)
        return res.json()

    def overview(self) -> dict:
        return self._get("/api/overview")

    def jobs(self) -> list[dict]:
        """Newest first, as the API returns them."""
        return self._get("/api/jobs")

    def job_detail(self, job_id: str) -> dict:
        return self._get(f"/api/jobs/{job_id}")

    def converse(self, text: str) -> dict:
        """Send a text to the agent: it asks a follow-up question or starts the search."""
        return self._post("/api/converse", {"text": text, "ref": "imessage"})

    def create_job(self, task: str) -> dict:
        return self._post("/api/jobs", {"brief": {"task": task}})

    def provide_input(self, job_id: str, payload: dict) -> dict:
        return self._post(f"/api/jobs/{job_id}/input", payload)

    def send_job_message(self, job_id: str, text: str) -> dict:
        return self._post(f"/api/jobs/{job_id}/message", {"text": text})

    def pending_approvals(self) -> list[dict]:
        return self._get("/api/approvals", status="pending")

    def decide(self, approval_id: str, approved: bool) -> dict:
        return self._post(f"/api/approvals/{approval_id}/decide", {"approved": approved, "by": "imessage"})

    def bookings(self) -> list[dict]:
        """Newest first."""
        return self._get("/api/bookings")

    def accept_booking(self, booking_id: str) -> dict:
        return self._post(f"/api/bookings/{booking_id}/accept", {})

    def history(self) -> dict:
        return self._get("/api/history")
