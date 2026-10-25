"""Smoke test for anytype-render against a running daemon.

Builds LIVETEST objects of several kinds with the anytype-extension-mcp
live-test harness, renders each through the daemon's API, and checks:

  - the frontend logged in and opened the object
  - no RPC was refused (a refusal means the allowlist needs a decision)
  - nothing outside localhost was reached except the known Sentry endpoint
  - every content block from block-list has a DOM node
  - block-list of each page is identical before and after rendering
  - MCP calls keep working while the renderer is busy
  - the layout report per kind: table widths and the part cut off at the
    side, query and collection grids with their source, view, rows and
    cut-off cells, Load more for all rows, toggles opened, images loaded,
    whether the picture holds the whole object, and a report without image

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
API_PORT = os.environ.get("AR_API_PORT", "31097")
OUT = pathlib.Path(os.environ.get("AR_SMOKE_OUT", pathlib.Path(__file__).resolve().parent.parent / "out"))
EXPECTED_BLOCKED = {"https://sentry.anytype.io"}
STRUCTURAL = {"smartblock", "layout", "table_column", "table_row"}

FETCH = (
    'let d="";process.stdin.on("data",c=>d+=c).on("end",async()=>{'
    'const r=await fetch("http://127.0.0.1:"+process.env.API_PORT+"/render",{method:"POST",body:d});'
    'process.stdout.write(JSON.stringify({status:r.status,body:await r.json()}))})'
)


def render(request):
    proc = subprocess.run(
        ["docker", "exec", "-i", "-e", f"API_PORT={API_PORT}", DAEMON, "node", "-e", FETCH],
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


def write_pdf(path, text="Render-Smoke PDF"):
    """A one-page PDF with a line of text, xref offsets computed."""
    stream = f"BT /F1 24 Tf 72 720 Td ({text}) Tj ET".encode()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    path.write_bytes(bytes(out))


def stage_file_block(s, obj, kind, name, writer):
    staged = pathlib.Path(IN_ROOT) / name
    writer(staged)
    try:
        s.c.call("block-file-create", space_id=s.space_id, object_id=obj, kind=kind, staged_path=staged.name)
    finally:
        staged.unlink(missing_ok=True)
    for b in s.blocks(obj):
        if b.get("kind") == "file" and b.get("target_object_id"):
            s.track(b["target_object_id"])


def expect(**checks):
    """A check on the response body: each value maps the body to (ok, detail)."""
    def run(body):
        out = []
        for name, fn in checks.items():
            try:
                ok, detail = fn(body)
            except Exception as exc:  # noqa: BLE001
                ok, detail = False, f"{type(exc).__name__}: {exc}"
            if not ok:
                out.append(f"{name}: {json.dumps(detail, ensure_ascii=False)[:300]}")
        return out
    return run


def lay(body):
    return body["layout"]


def grid(body, i=0):
    return lay(body)["dataviews"][i]


def snapshot(s, obj):
    keep = ("id", "kind", "style", "text", "checked", "children_ids", "width", "width_px", "is_header")
    return [{k: b.get(k) for k in keep if b.get(k) is not None} for b in s.blocks(obj)]


def build(s):
    """Objects to render: dicts with label, object id, extra request fields,
    whether it is a page (block-list is compared), and checks on the report."""
    call, sp = s.c.call, s.space_id
    objects = []

    def add(label, obj, request=None, page=True, check=None):
        objects.append({"label": label, "obj": obj, "request": request or {}, "page": page, "check": check})

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
    add("basic", basic, {"expand_ids": [toggle]}, check=expect(
        widths=lambda b: (lay(b)["tables"][0]["column_widths_px"] == [120, 360, 90], lay(b)["tables"]),
        toggle_open=lambda b: (lay(b)["toggles_not_open"] == [], lay(b)["toggles_not_open"]),
        complete=lambda b: (b["complete"] is True, (b["complete"], b["height"], lay(b)["content_height_px"])),
        settled=lambda b: (b["unsettled"] == [], b["unsettled"]),
    ))
    # The same page in a short window: the picture must say it is not all of it.
    add("basic, first 400 px", basic, {"full_height": False, "height": 400}, check=expect(
        incomplete=lambda b: (b["complete"] is False and lay(b)["content_height_px"] > 400,
                              (b["complete"], lay(b)["content_height_px"])),
    ))

    # The same page narrow: the long cell has to wrap there, the short ones not.
    narrow = s.page("render narrow")
    call("block-create", space_id=sp, object_id=narrow, kind="table", rows=2, columns=2)
    call("table-set-cells", space_id=sp, object_id=narrow, cells=[
        {"row": 0, "column": 0, "text": "kurz"},
        {"row": 0, "column": 1, "text": "ein deutlich längerer Zelltext, der in 140 px nicht passt"},
        {"row": 1, "column": 0, "text": "x"}, {"row": 1, "column": 1, "text": "y"}])
    add("narrow table", narrow, check=expect(
        wrapped=lambda b: (lay(b)["tables"][0]["cells_wrapped"] == 1, lay(b)["tables"]),
        fits=lambda b: (lay(b)["tables"][0]["cut_off_px"] == 0, lay(b)["tables"]),
    ))

    # Wider than the text column: the GUI scrolls it sideways, the report says
    # by how much. 3 x 400 px in a 1100 px window.
    wide = s.page("render wide table")
    call("block-create", space_id=sp, object_id=wide, kind="table", rows=2, columns=3)
    call("table-column-width", space_id=sp, object_id=wide, columns=[
        {"column": c, "width_px": 400} for c in range(3)])
    add("wide table", wide, check=expect(
        cut=lambda b: (0 < lay(b)["tables"][0]["cut_off_px"] < lay(b)["tables"][0]["width_px"], lay(b)["tables"]),
    ))
    add("wide table, report only", wide, {"image": False}, check=expect(
        no_image=lambda b: (b["image_bytes"] == 0 and lay(b)["tables"], (b["image_bytes"], lay(b)["tables"])),
    ))

    nested = s.page("render nested toggles")
    outer = call("block-create", space_id=sp, object_id=nested, style="toggle", text="Toggle A")["block_id"]
    call("block-create", space_id=sp, object_id=nested, target_id=outer, position="inner", text="Text in A")
    inner = call("block-create", space_id=sp, object_id=nested, target_id=outer, position="inner", style="toggle", text="Toggle A.1")["block_id"]
    call("block-create", space_id=sp, object_id=nested, target_id=inner, position="inner", text="Text in A.1")
    heading = call("block-create", space_id=sp, object_id=nested, style="toggle_header2", text="Toggle B")["block_id"]
    call("block-create", space_id=sp, object_id=nested, target_id=heading, position="inner", text="Text in B")
    add("nested toggles", nested, {"expand_ids": [outer, inner, heading]}, check=expect(
        all_open=lambda b: (lay(b)["toggles_not_open"] == [], lay(b)["toggles_not_open"]),
    ))

    empty = s.page("render empty")
    add("empty page", empty, check=expect(
        complete=lambda b: (b["complete"] is True, (b["complete"], b["height"], lay(b)["content_height_px"])),
    ))

    columns = s.page("render columns")
    left = call("block-create", space_id=sp, object_id=columns, text="Linke Spalte")["block_id"]
    right = call("block-create", space_id=sp, object_id=columns, text="Rechte Spalte")["block_id"]
    call("block-move", space_id=sp, object_id=columns, block_ids=[right], drop_target_id=left, position="right")
    call("block-column-width", space_id=sp, object_id=columns, block_id=left, widths=[2, 1])
    call("block-create", space_id=sp, object_id=columns, kind="link", linked_object_id=basic)
    call("block-relation-add", space_id=sp, object_id=columns, property_key="createdDate")
    add("columns+link+relation", columns)

    media = s.page("render media")
    stage_file_block(s, media, "image", "livetest render bild.png", write_png)
    add("image", media, check=expect(
        loaded=lambda b: (lay(b)["images_failed"] == [] and lay(b)["images_loading"] == [],
                          (lay(b)["images_failed"], lay(b)["images_loading"], b["unsettled"])),
    ))

    pdf = s.page("render pdf")
    stage_file_block(s, pdf, "pdf", "livetest render dokument.pdf", write_pdf)
    add("pdf embed", pdf, check=expect(
        settled=lambda b: (b["unsettled"] == [], b["unsettled"]),
    ))

    archived = s.page("render archived")
    call("block-create", space_id=sp, object_id=archived, text="Im Papierkorb")
    s.settle(1)
    call("object-set-archived", space_id=sp, object_ids=[archived], archived=True)
    add("archived page", archived, page=False)

    page_type = s.type_by_key("page")
    query = call("query-create", space_id=sp, name=s.probe("render query"), source=[page_type["id"]])["object_id"]
    s.track(query)
    embed = s.page("render embedded query")
    call("block-embed-query", space_id=sp, object_id=embed, query_object_id=query)
    add("embedded query", embed, check=expect(
        grid=lambda b: (grid(b)["kind"] == "query" and grid(b)["view"] == "grid" and grid(b)["columns"], lay(b)["dataviews"]),
        source=lambda b: (grid(b)["source_id"] == query and grid(b)["query_of"] == ["Page"]
                          and grid(b)["view_name"] and isinstance(grid(b)["filters"], int), lay(b)["dataviews"]),
    ))
    # A second view, shown as a click on its tab shows it (nothing is saved).
    call("query-view-create", space_id=sp, object_id=query, name="Galerie", layout="gallery")
    add("query object, other view", query, {"views": [{"view": "Galerie"}]}, page=False, check=expect(
        view=lambda b: (grid(b)["view"] == "gallery" and grid(b)["view_name"] == "Galerie"
                        and "Galerie" in grid(b)["views"], lay(b)["dataviews"]),
    ))
    # A board counts its columns' cards; a calendar has no totals of its own
    # (it loads day by day), only the month it shows and the entries there.
    call("query-view-create", space_id=sp, object_id=query, name="Board", layout="kanban", group_property_key="done")
    call("query-view-create", space_id=sp, object_id=query, name="Kalender", layout="calendar", group_property_key="created_date")
    # A board's column shows a page of cards (here 10) above its own Load more.
    add("query object, board", query, {"views": [{"view": "Board"}]}, page=False, check=expect(
        board=lambda b: (grid(b)["view"] == "board" and grid(b)["load_more"] is True
                         and 0 < grid(b)["rows_loaded"] < grid(b)["rows_total"], lay(b)["dataviews"]),
    ))
    add("query object, board, all rows", query, {"views": [{"view": "Board"}], "all_rows": True}, page=False, check=expect(
        board=lambda b: ("load_more" not in grid(b) and grid(b)["rows_loaded"] == grid(b)["rows_total"],
                         (lay(b)["dataviews"], b["unsettled"])),
    ))
    add("query object, calendar", query, {"views": [{"view": "Kalender"}]}, page=False, check=expect(
        calendar=lambda b: (grid(b)["view"] == "calendar" and "rows_total" not in grid(b) and "rows_loaded" not in grid(b)
                            and grid(b)["month"] == time.strftime("%Y-%m", time.gmtime()) and grid(b)["rows_shown"] >= 1,
                            lay(b)["dataviews"]),
    ))
    add("query object", query, page=False, check=expect(
        layout=lambda b: (lay(b)["layout"] == "set", lay(b)["layout"]),
        grid=lambda b: (grid(b)["kind"] == "query" and grid(b)["view"] == "grid" and grid(b)["rows_total"] >= 1, lay(b)["dataviews"]),
    ))

    nothing = call("query-create", space_id=sp, name=s.probe("render empty query"), source=[page_type["id"]])["object_id"]
    s.track(nothing)
    view = (call("query-inspect", space_id=sp, object_id=nothing).get("views") or [{}])[0].get("id")
    call("query-filter-add", space_id=sp, object_id=nothing, view_id=view, property_key="name",
         condition="equal", value="kein Objekt heisst so")
    add("empty query", nothing, page=False, check=expect(
        empty=lambda b: (grid(b)["rows_total"] == 0 and grid(b)["rows_shown"] == 0, lay(b)["dataviews"]),
    ))

    # A collection of 14, one with a name too long for its column.
    items = [s.page(f"eintrag {i}") for i in range(13)]
    items.append(s.page("ein Eintrag mit einem Namen, der für die Namensspalte der Tabelle eindeutig zu lang ist"))
    coll = call("object-to-collection", space_id=sp, object_id=s.page("render collection"))["object_id"]
    call("add-list-objects", space_id=sp, list_id=coll, objects=items)
    add("collection", coll, page=False, check=expect(
        layout=lambda b: (lay(b)["layout"] == "collection", lay(b)["layout"]),
        rows=lambda b: (grid(b)["kind"] == "collection" and grid(b)["rows_total"] == 14 and grid(b)["rows_shown"] == 14, lay(b)["dataviews"]),
        # Every name is long (LIVETEST prefix), the type column is not: one cut
        # cell per row, all in Name, none elsewhere.
        truncated=lambda b: (grid(b)["cells_truncated"] == grid(b)["rows_shown"]
                             and {c["name"] for c in grid(b)["columns"] if c.get("cells_truncated")} == {"Name"}, lay(b)["dataviews"]),
        # The width the longest name needs is more than the column has.
        needs=lambda b: (all(c["needs_px"] > c["width_px"] for c in grid(b)["columns"] if c.get("cells_truncated")),
                         grid(b)["columns"]),
        complete=lambda b: (b["complete"] is True, (b["complete"], b["height"], lay(b)["content_height_px"])),
    ))
    # Its grid is virtualized: a short window holds a few rows, the rest is not in the DOM.
    add("collection, first 400 px", coll, {"full_height": False, "height": 400}, page=False, check=expect(
        incomplete=lambda b: (b["complete"] is False and grid(b)["rows_shown"] < 14, (b["complete"], lay(b)["dataviews"])),
    ))
    embed_coll = s.page("render embedded collection")
    call("block-embed-query", space_id=sp, object_id=embed_coll, query_object_id=coll)
    add("embedded collection", embed_coll, check=expect(
        more=lambda b: (grid(b)["rows_total"] == 14 and grid(b)["rows_shown"] == grid(b)["rows_loaded"] < 14, lay(b)["dataviews"]),
        source=lambda b: (grid(b)["source_id"] == coll and "render collection" in grid(b)["source_name"]
                          and "query_of" not in grid(b), lay(b)["dataviews"]),
    ))
    # Two embedded views on one page: switching one leaves the other alone,
    # and in a short window the lower one is not in the picture.
    two = s.page("render zwei eingebettete")
    upper = call("block-embed-query", space_id=sp, object_id=two, query_object_id=query)["block_id"]
    lower = call("block-embed-query", space_id=sp, object_id=two, query_object_id=coll)["block_id"]
    call("query-view-create", space_id=sp, object_id=two, block_id=lower, name="Liste", layout="list")
    by_block = lambda b, i: next(d for d in lay(b)["dataviews"] if d["block_id"] == i)
    add("two embedded views, one switched", two, {"views": [{"block_id": lower, "view": "Liste"}]}, check=expect(
        switched=lambda b: (by_block(b, lower)["view"] == "list" and by_block(b, upper)["view"] == "grid", lay(b)["dataviews"]),
    ))
    add("two embedded views, first 400 px", two, {"full_height": False, "height": 400}, check=expect(
        outside=lambda b: (by_block(b, lower).get("in_image") is False and "in_image" not in by_block(b, upper),
                           lay(b)["dataviews"]),
    ))
    # Load more pressed until every row is there; the picture grows with them.
    add("embedded collection, all rows", embed_coll, {"all_rows": True}, check=expect(
        all=lambda b: (grid(b)["rows_shown"] == grid(b)["rows_loaded"] == grid(b)["rows_total"] == 14, lay(b)["dataviews"]),
        complete=lambda b: (b["complete"] is True and b["unsettled"] == [], (b["complete"], b["unsettled"])),
    ))

    s.settle(3)
    return objects


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    client = Client()
    s = Suite(client, "render-smoke")
    results, failures, refused_all = [], [], set()
    try:
        for item in build(s):
            label, obj, is_page = item["label"], item["obj"], item["page"]
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
            res = render({"space_id": s.space_id, "object_id": obj, "width": 1100, **item["request"]})
            th.join()
            body = res["body"]
            if res["status"] != 200:
                failures.append(f"{label}: render failed ({res['status']}): {body.get('error')}")
                continue

            name = "".join(ch if ch.isalnum() else "_" for ch in label)
            image = base64.b64decode(body.pop("image"))
            (OUT / f"{name}.jpg").write_bytes(image)
            body["image_bytes"] = len(image)
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
            if item["check"]:
                failures.extend(f"{label}: {f}" for f in item["check"](body))
            if is_page:
                content = [b for b in s.blocks(obj) if b.get("kind") not in STRUCTURAL]
                if dom < len(content):
                    failures.append(f"{label}: {dom} block nodes in the DOM for {len(content)} content blocks")
                after = snapshot(s, obj)
                if before != after:
                    failures.append(f"{label}: block-list changed by rendering")
            results.append({
                "object": label, "ms": body["ms"], "size": f"{body['width']}x{body['height']}",
                "complete": body["complete"], "unsettled": body["unsettled"],
                "layout": body["layout"]["layout"], "refused": refused,
                "local": body["rpc"]["answered_locally"], "page_errors": len(body["page_errors"]),
                "tables": body["layout"]["tables"], "dataviews": body["layout"]["dataviews"],
                "images_failed": body["layout"]["images_failed"],
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
