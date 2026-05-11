#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DRAWMIAT_ROOT = Path("/home/pkcs12/projects/drawmiat")
SPECS = REPO_ROOT / "specs"

if str(DRAWMIAT_ROOT) not in sys.path:
    sys.path.insert(0, str(DRAWMIAT_ROOT))

from webapp.grafcet_renderer import GrafcetRenderer, GrafcetSemanticError  # noqa: E402


def repo_relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def render_one(renderer: GrafcetRenderer, source: Path) -> dict[str, Any]:
    chapter_dir = source.parent
    output = chapter_dir / f"{chapter_dir.name}-grafcet.svg"
    row: dict[str, Any] = {
        "chapter": chapter_dir.name,
        "source": repo_relative(source),
        "output": repo_relative(output),
        "status": "error",
        "diagnostics_count": 0,
    }
    try:
        result = renderer.render(load_json(source), debug_gaps=False)
        if not result.svg_text:
            row["error"] = "renderer returned no svg_text"
            row["diagnostics_count"] = len(result.diagnostics)
            return row
        output.write_text(result.svg_text, encoding="utf-8")
        row.update({"status": "ok", "diagnostics_count": len(result.diagnostics)})
    except GrafcetSemanticError as exc:
        row["diagnostics_count"] = len(exc.diagnostics)
        row["error"] = "semantic error"
    except Exception as exc:  # noqa: BLE001
        row["error"] = {"type": exc.__class__.__name__, "message": str(exc), "traceback": traceback.format_exc()}
    return row


def main() -> int:
    renderer = GrafcetRenderer()
    rows = []
    for source in sorted(SPECS.glob("*/grafcet.json")):
        if source.parent.name == "archive":
            continue
        rows.append(render_one(renderer, source))
    summary = {
        "total": len(rows),
        "ok": sum(1 for row in rows if row["status"] == "ok"),
        "error": sum(1 for row in rows if row["status"] != "ok"),
    }
    print(json.dumps(summary, ensure_ascii=False))
    for row in rows:
        print(f"{row['status']} {row['output']}")
    return 0 if summary["error"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
