#!/usr/bin/env python3
"""Regenerate OpenCMS Grafcet L5 SVGs with per-diagram trace logs."""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DRAWMIAT_ROOT = Path("/home/pkcs12/projects/drawmiat")
OUTPUT_DIR = REPO_ROOT / "specs" / "diagrams" / "l5"
LOG_DIR = OUTPUT_DIR / "logs"
REPORT_PATH = REPO_ROOT / "specs" / "diagrams" / "l5-regeneration-report.json"

if str(DRAWMIAT_ROOT) not in sys.path:
    sys.path.insert(0, str(DRAWMIAT_ROOT))

from webapp.grafcet_renderer import (  # noqa: E402
    GrafcetDiagnostic,
    GrafcetRenderer,
    GrafcetSemanticError,
    compact_layout_y_lanes,
    normalize_grafcet_semantics,
)


def repo_relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def diagnostic_to_json(diagnostic: GrafcetDiagnostic) -> dict[str, Any]:
    return {
        "code": getattr(diagnostic.code, "value", diagnostic.code),
        "severity": getattr(diagnostic.severity, "value", diagnostic.severity),
        "message": diagnostic.message,
        "target_ids": list(diagnostic.target_ids),
        "details": diagnostic.details,
    }


def render_one(renderer: GrafcetRenderer, source: Path) -> dict[str, Any]:
    slug = source.parent.name
    svg_path = OUTPUT_DIR / f"{slug}.l5.svg"
    trace_path = LOG_DIR / f"{slug}.l5.trace.jsonl"
    row: dict[str, Any] = {
        "slug": slug,
        "source": repo_relative(source),
        "output": repo_relative(svg_path),
        "trace_log": repo_relative(trace_path),
        "status": "error",
        "diagnostics_count": 0,
        "diagnostics": [],
    }
    try:
        raw = load_json(source)
        graph = normalize_grafcet_semantics(raw)
        layout = renderer.place_step_action_pairs(graph)
        layout = renderer.arrange_transition_gates(layout)
        layout = renderer.route_control_edges(layout)
        layout = renderer.detect_layout_violations(layout)
        layout = compact_layout_y_lanes(layout)
        repair = renderer.run_repair_loop(layout)
        diagnostics = tuple(
            GrafcetDiagnostic(
                code=diagnostic.code,
                severity=diagnostic.severity,
                message=diagnostic.message,
                target_ids=diagnostic.target_ids,
                details=diagnostic.details,
            )
            for diagnostic in repair.diagnostics
        )
        svg_text = renderer.emit_layout_svg(repair.layout_model)
        svg_path.write_text(svg_text, encoding="utf-8")
        renderer.emit_render_log(repair.layout_model, trace_path)
        row.update(
            {
                "status": "ok",
                "diagnostics_count": len(diagnostics),
                "diagnostics": [diagnostic_to_json(item) for item in diagnostics],
            }
        )
    except GrafcetSemanticError as exc:
        row["diagnostics"] = [diagnostic_to_json(item) for item in exc.diagnostics]
        row["diagnostics_count"] = len(row["diagnostics"])
    except Exception as exc:  # noqa: BLE001 - batch report must preserve failures.
        row["error"] = {
            "type": exc.__class__.__name__,
            "message": str(exc),
            "traceback": traceback.format_exc(),
        }
    return row


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    renderer = GrafcetRenderer()
    rows = [render_one(renderer, source) for source in sorted((REPO_ROOT / "specs").glob("*/grafcet.json"))]
    summary = {
        "total": len(rows),
        "ok": sum(1 for row in rows if row["status"] == "ok"),
        "error": sum(1 for row in rows if row["status"] != "ok"),
        "diagnostics_total": sum(row["diagnostics_count"] for row in rows),
    }
    REPORT_PATH.write_text(
        json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False))
    for row in rows:
        print(f"{row['status']} {row['diagnostics_count']} {row['output']} trace={row['trace_log']}")
    return 0 if summary["error"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
