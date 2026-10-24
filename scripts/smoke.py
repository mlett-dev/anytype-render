"""Smoke test for anytype-render against a running daemon.

Builds LIVETEST objects of several kinds with the anytype-extension-mcp
live-test harness, renders each through the daemon's API, and checks:

  - the frontend logged in and opened the object
  - no RPC was refused (a refusal means the allowlist needs a decision)
  - nothing outside localhost was reached except the known Sentry endpoint
  - every content block from block-list has a DOM node
  - block-list of each page is identical before and after rendering
  - MCP calls keep working while the renderer is busy

Only ids created here are erased afterwards (the harness's narrow cleanup).
Run after every frontend update: scripts/smoke.sh.
"""

import base64
import json
import os
import pathlib
import struct
import subprocess
import sys
import threading
import time
import zlib

sys.path.insert(0, os.environ["AEM_LIVETEST_DIR"])

from harness import IN_ROOT, Client, Suite  # noqa: E402
import run as livetest_run  # noqa: E402

DAEMON = os.environ.get("AR_NAME", "anytype-render")
OUT = pathlib.Path(os.environ.get("AR_SMOKE_OUT", pathlib.Path(__file__).resolve().parent.parent / "out"))
EXPECTED_BLOCKED = {"https://sentry.anytype.io"}
STRUCTURAL = {"smartblock", "layout", "table_column", "table_row"}

FETCH = (
    'let d="";process.stdin.on("data",c=>d+=c).on("end",async()=>{'
    'const r=await fetch("http://127.0.0.1:31097/render",{method:"POST",body:d});'
    'process.stdout.write(JSON.stringify({status:r.status,body:await r.json()}))})'
)


def render(request):
    proc = subprocess.run(
        ["docker", "exec", "-i", DAEMON, "node", "-e", FETCH],
        input=json.dumps(request), capture_output=True, text=True, timeout=180,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip()[-500:])
    return json.loads(proc.stdout)


def write_png(path, size=96, rgb=(90, 140, 200)):
    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def snapshot(s, obj):
    keep = ("id", "kind", "style", "text", "checked", "children_ids", "width", "width_px", "is_header")
    return [{k: b.get(k) for k in keep if b.get(k) is not None} for b in s.blocks(obj)]


def build(s):
    """Objects to render: (label, object_id, expand_ids, is_page)."""
    call, sp = s.c.call, s.space_id
    objects = []

    basic = s.page("render basic")
    call("block-create", space_id=sp, object_id=basic, style="header1", text="Render-Smoke")
    call("block-create", space_id=sp, object_id=basic, text="Ein Absatz, lang genug, dass er bei schmaler Breite umbricht und so die Breite sichtbar macht.")
    callout = call("block-create", space_id=sp, object_id=basic, style="callout", text="Hinweis")["block_id"]
    call("block-style", space_id=sp, object_id=basic, block_ids=[callout], icon_emoji="💡")
    toggle = call("block-create", space_id=sp, object_id=basic, style="toggle", text="Abschnitt")["block_id"]
    call("block-create", space_id=sp, object_id=basic, target_id=toggle, position="inner", text="Im Toggle")
    call("block-create", space_id=sp, object_id=basic, style="checkbox", text="Erledigt", checked=True)
    call("block-create", space_id=sp, object_id=basic, kind="divider")
    call("block-create", space_id=sp, object_id=basic, kind="table", rows=3, columns=3)
    call("table-set-cells", space_id=sp, object_id=basic, cells=[
        {"row": r, "column": c, "text": t}
        for r, row in enumerate([["Kapitel", "Inhalt", "Seiten"], ["1", "Einleitung", "12"], ["2", "Methoden", "30"]])
        for c, t in enumerate(row)
    ])
    call("table-column-width", space_id=sp, object_id=basic, columns=[
        {"column": 0, "width_px": 120}, {"column": 1, "width_px": 360}, {"column": 2, "width_px": 90}])
    objects.append(("basic", basic, [toggle], True))
    # The same page narrow: the long cell has to wrap there, the short ones not.
    narrow = s.page("render narrow")
    call("block-create", space_id=sp, object_id=narrow, kind="table", rows=2, columns=2)
    call("table-set-cells", space_id=sp, object_id=narrow, cells=[
        {"row": 0, "column": 0, "text": "kurz"},
        {"row": 0, "column": 1, "text": "ein deutlich längerer Zelltext, der in 140 px nicht passt"},
        {"row": 1, "column": 0, "text": "x"}, {"row": 1, "column": 1, "text": "y"}])
    objects.append(("narrow table", narrow, [], True))

    columns = s.page("render columns")
    left = call("block-create", space_id=sp, object_id=columns, text="Linke Spalte")["block_id"]
    right = call("block-create", space_id=sp, object_id=columns, text="Rechte Spalte")["block_id"]
    call("block-move", space_id=sp, object_id=columns, block_ids=[right], drop_target_id=left, position="right")
    call("block-column-width", space_id=sp, object_id=columns, block_id=left, widths=[2, 1])
    call("block-create", space_id=sp, object_id=columns, kind="link", linked_object_id=basic)
    call("block-relation-add", space_id=sp, object_id=columns, property_key="createdDate")
    objects.append(("columns+link+relation", columns, [], True))

    media = s.page("render media")
    staged = pathlib.Path(IN_ROOT) / "livetest render bild.png"
    write_png(staged)
    try:
        call("block-file-create", space_id=sp, object_id=media, kind="image", staged_path=staged.name)
    finally:
        staged.unlink(missing_ok=True)
    for b in s.blocks(media):
        if b.get("kind") == "file" and b.get("target_object_id"):
            s.track(b["target_object_id"])
    objects.append(("image", media, [], True))

    page_type = s.type_by_key("page")
    query = call("query-create", space_id=sp, name=s.probe("render query"), source=[page_type["id"]])["object_id"]
    s.track(query)
    embed = s.page("render embedded query")
    call("block-embed-query", space_id=sp, object_id=embed, query_object_id=query)
    objects.append(("embedded query", embed, [], True))
    objects.append(("query object", query, [], False))

    s.settle(3)
    return objects


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    client = Client()
    s = Suite(client, "render-smoke")
    results, failures, refused_all = [], [], set()
    try:
        for label, obj, expand, is_page in build(s):
            before = snapshot(s, obj) if is_page else None

            during = {}

            def probe():
                time.sleep(2)
                try:
                    during["ok"] = bool(s.blocks(obj))
                except Exception as exc:  # noqa: BLE001
                    during["ok"] = False
                    during["error"] = str(exc)[:200]

            th = threading.Thread(target=probe)
            th.start()
            res = render({"space_id": s.space_id, "object_id": obj, "width": 1100, "expand_ids": expand})
            th.join()
            body = res["body"]
            if res["status"] != 200:
                failures.append(f"{label}: render failed ({res['status']}): {body.get('error')}")
                continue

            name = label.replace(" ", "_").replace("+", "_")
            (OUT / f"{name}.jpg").write_bytes(base64.b64decode(body["image"]))
            body.pop("image")
            (OUT / f"{name}.json").write_text(json.dumps(body, indent=1, ensure_ascii=False))

            refused = body["rpc"]["refused"]
            refused_all.update(refused)
            blocked = set(body["blocked"]) - EXPECTED_BLOCKED
            dom = body["layout"]["blocks_in_dom"]
            if refused:
                failures.append(f"{label}: refused RPCs {refused}")
            if blocked:
                failures.append(f"{label}: reached outside localhost {sorted(blocked)}")
            if body.get("direct_heart_requests"):
                failures.append(f"{label}: {body['direct_heart_requests']} requests went to heart past the proxy")
            if not during.get("ok"):
                failures.append(f"{label}: MCP call during render failed {during}")
            if is_page:
                content = [b for b in s.blocks(obj) if b.get("kind") not in STRUCTURAL]
                if dom < len(content):
                    failures.append(f"{label}: {dom} block nodes in the DOM for {len(content)} content blocks")
                after = snapshot(s, obj)
                if before != after:
                    failures.append(f"{label}: block-list changed by rendering")
            results.append({
                "object": label, "ms": body["ms"], "size": f"{body['width']}x{body['height']}",
                "layout": body["layout"]["layout"], "refused": refused,
                "local": body["rpc"]["answered_locally"], "page_errors": len(body["page_errors"]),
                "tables": body["layout"]["tables"], "images_failed": body["layout"]["images_failed"],
                "methods": sorted(body["rpc"].get("methods", {})),
            })
    finally:
        livetest_run.archive(client, s.space_id, s.created)
        livetest_run.purge(client, s.space_id, s.created)
        client.close()

    # A wrong space id must fail, not quietly show another object.
    bad = render({"space_id": "kein-space", "object_id": "kein-objekt"})
    if bad["status"] == 200:
        failures.append("a wrong space and object id rendered something instead of failing")

    print(json.dumps({"results": results, "refused_all": sorted(refused_all), "failures": failures},
                     indent=1, ensure_ascii=False))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
