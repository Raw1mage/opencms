#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
import traceback
from copy import deepcopy
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


def layer_ref(path: Path) -> str:
    match = re.fullmatch(r"idef0\.(a[0-9]+)\.svg", path.name)
    if not match:
        raise ValueError(path.name)
    return match.group(1).upper()


def matching_steps(raw: list[dict[str, Any]], layer: str) -> list[dict[str, Any]]:
    keep = {
        step["StepNumber"]
        for step in raw
        if str(step.get("ModuleRef", "")).upper().startswith(layer)
    }
    if layer == "A0" and not keep:
        keep = {
            step["StepNumber"]
            for step in raw
            if str(step.get("ModuleRef", "")).upper().startswith("A")
        }
    if not keep:
        return []

    subgraph: list[dict[str, Any]] = []
    local_roots: list[int] = []
    for step in raw:
        if step["StepNumber"] not in keep:
            continue
        item = deepcopy(step)
        inputs = [number for number in item.get("LinkInputNumber", []) if number in keep]
        if not inputs:
            local_roots.append(item["StepNumber"])
        item["StepType"] = "normal"
        item["LinkInputNumber"] = inputs

        outputs = item.get("LinkOutputNumber", [])
        conditions = item.get("Condition", [])
        kept_pairs = [
            (output, conditions[index] if index < len(conditions) else "")
            for index, output in enumerate(outputs)
            if output in keep
        ]
        item["LinkOutputNumber"] = [output for output, _condition in kept_pairs]
        item["Condition"] = [condition for _output, condition in kept_pairs]
        subgraph.append(item)
    if not local_roots:
        local_roots = [subgraph[0]["StepNumber"]]
    initial_step = local_roots[0]
    for item in subgraph:
        if item["StepNumber"] == initial_step:
            item["StepType"] = "initial"
    return subgraph


def render_layer(renderer: GrafcetRenderer, source: Path, layer: str) -> dict[str, Any]:
    chapter_dir = source.parent
    output = chapter_dir / f"grafcet.{layer.lower()}.svg"
    row: dict[str, Any] = {
        "chapter": chapter_dir.name,
        "layer": layer,
        "source": repo_relative(source),
        "output": repo_relative(output),
        "status": "error",
        "diagnostics_count": 0,
        "steps": 0,
    }
    try:
        raw = load_json(source)
        graph = matching_steps(raw, layer)
        if not graph:
            row["error"] = f"no ModuleRef-mapped GRAFCET steps for {layer}"
            if output.exists():
                output.unlink()
                row["removed"] = True
            return row
        row["steps"] = len(graph)
        result = renderer.render(graph, debug_gaps=False)
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
        layers = sorted({layer_ref(path) for path in source.parent.glob("idef0.a*.svg")}, key=lambda value: (len(value), value))
        for layer in layers:
            rows.append(render_layer(renderer, source, layer))
    summary = {
        "total": len(rows),
        "ok": sum(1 for row in rows if row["status"] == "ok"),
        "error": sum(1 for row in rows if row["status"] != "ok"),
    }
    print(json.dumps(summary, ensure_ascii=False))
    for row in rows:
        print(f"{row['status']} {row['output']} steps={row['steps']} diagnostics={row['diagnostics_count']}")
    return 0 if summary["error"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
