"""Pure planning and durable reservation ledger for classifier backfills.

This module deliberately has no model or network client.  It plans work and
validates model-shaped results; a caller owns execution and review.
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass, asdict
from enum import Enum
from pathlib import Path
from typing import Any, Iterable, Mapping


class Destination(str, Enum):
    MEMORY = "memory"
    PROCEDURE = "procedure"
    MIXED = "mixed"
    TEMPORARY = "temporary"
    NOISE = "noise"
    UNRESOLVED = "unresolved"


@dataclass(frozen=True)
class Record:
    record_id: str
    source_hash: str
    text: str
    context: str = ""
    task_subject: str = ""
    task_status: str = ""
    time: str = ""
    heading_ancestry: tuple[str, ...] = ()
    archive_placement: str = ""
    ownership: str = "unresolved"

    def input(self) -> dict[str, Any]:
        d = asdict(self)
        d["heading_ancestry"] = list(self.heading_ancestry)
        return d


@dataclass(frozen=True)
class Classification:
    destination: Destination
    project_attribution: str | None
    evidence_needed: bool
    review_needed: bool
    rationale: str = ""


def _digest(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()


def batch_id(records: Iterable[Record], prompt_version: str, model: str) -> str:
    """Stable ID; changing any record input, prompt, or model creates new work."""
    inputs = [r.input() for r in records]
    return "batch-" + _digest({"prompt_version": prompt_version, "model": model,
                               "input_hash": _digest(inputs)})[:32]


class InvalidClassification(ValueError):
    pass


def parse_classification(value: Mapping[str, Any]) -> Classification:
    """Strictly parse a result, rejecting unknown/missing fields and invented IDs."""
    allowed = {"destination", "project_attribution", "evidence_needed", "review_needed", "rationale"}
    if set(value) - allowed or not {"destination", "evidence_needed", "review_needed"}.issubset(value):
        raise InvalidClassification("classification schema mismatch")
    try:
        destination = Destination(value["destination"])
        evidence = value["evidence_needed"]
        review = value["review_needed"]
        if not isinstance(evidence, bool) or not isinstance(review, bool):
            raise TypeError
        project = value.get("project_attribution")
        if project is not None and not isinstance(project, str):
            raise TypeError
        rationale = value.get("rationale", "")
        if not isinstance(rationale, str):
            raise TypeError
    except (KeyError, TypeError, ValueError) as exc:
        raise InvalidClassification("invalid classification value") from exc
    return Classification(destination, project, evidence, review, rationale)


class ReservationError(RuntimeError):
    pass


class BudgetExhausted(ReservationError):
    pass


class ReservationLedger:
    """Append-only JSONL ledger. Reservations are charged even when failed."""
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock_path = self.path.with_suffix(self.path.suffix + ".lock")

    def _events(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        return [json.loads(line) for line in self.path.read_text().splitlines() if line.strip()]

    def summary(self) -> dict[str, int]:
        events = self._events()
        return {"reserved": sum(e["status"] == "reserved" for e in events),
                "failed": sum(e["status"] == "failed" for e in events),
                "incomplete": sum(e["status"] == "incomplete" for e in events),
                "completed": sum(e["status"] == "completed" for e in events)}

    def reserve(self, batch: str, *, cap: int, legacy_reserved: int = 0,
                reviewer: bool = False, reviewer_cap: int | None = None, legacy_reviewers: int = 0) -> bool:
        """Atomically reserve once; retries of an existing ID never spend again."""
        import fcntl
        self.lock_path.touch(exist_ok=True)
        with self.lock_path.open("r+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            events = self._events()
            if any(e["batch"] == batch for e in events):
                return False
            kind = "reviewer" if reviewer else "classification"
            spent = sum(e["status"] in {"reserved", "failed", "incomplete", "completed"}
                        and e.get("kind") == kind for e in events)
            ceiling = reviewer_cap if reviewer else cap
            if ceiling is None or spent + (legacy_reserved if not reviewer else legacy_reviewers) >= ceiling:
                raise BudgetExhausted(f"{kind} budget exhausted")
            event = {"batch": batch, "kind": kind, "status": "reserved"}
            with self.path.open("a", encoding="utf-8") as out:
                out.write(json.dumps(event, sort_keys=True) + "\n")
                out.flush(); os.fsync(out.fileno())
            fcntl.flock(lock, fcntl.LOCK_UN)
            return True

    def mark(self, batch: str, status: str) -> None:
        if status not in {"failed", "incomplete", "completed"}:
            raise ValueError("status must be durable terminal state")
        import fcntl
        with self.lock_path.open("r+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if not any(e["batch"] == batch and e["status"] == "reserved" for e in self._events()):
                raise ReservationError("unknown reservation")
            with self.path.open("a", encoding="utf-8") as out:
                out.write(json.dumps({"batch": batch, "status": status}, sort_keys=True) + "\n")
                out.flush(); os.fsync(out.fileno())
            fcntl.flock(lock, fcntl.LOCK_UN)


def estimate_tokens(records: Iterable[Record]) -> int:
    """Conservative labelled heuristic; intentionally does not estimate dollars."""
    return sum(max(1, (len(r.text) + len(r.context) + len(r.task_subject)) // 4) + 80 for r in records)


def plan(records: Iterable[Record], *, prompt_version: str, model: str,
         ledger: ReservationLedger | None = None, dry_run: bool = True, cap: int | None = None, legacy_reserved: int = 0) -> dict[str, Any]:
    records = list(records)
    bid = batch_id(records, prompt_version, model)
    result = {"batch_id": bid, "record_ids": [r.record_id for r in records],
              "prompt_version": prompt_version, "model": model,
              "input_hash": _digest([r.input() for r in records])}
    if dry_run:
        result["estimated_tokens_heuristic"] = estimate_tokens(records)
        result["reservation"] = "not_reserved"
    elif ledger:
        if cap is None: raise ValueError("Explicit budget cap required")
        result["reserved"] = ledger.reserve(bid, cap=cap, legacy_reserved=legacy_reserved)
    return result

