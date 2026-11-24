#!/usr/bin/env python3
"""Modele 3D, chmury punktów i rysunek DXF pisane ręcznie wg specyfikacji formatów.

Wywołanie: python3 make-models.py <katalog-wyjściowy>. Wynik jest deterministyczny (stałe ziarno).
Wszystko powstaje w tym repo, bez plików z internetu.
"""
import base64
import io
import json
import os
import struct
import sys
import zipfile

import numpy as np

OUT = sys.argv[1]
RNG_SEED = 42

# Sześcian 10 x 10 x 10: 8 wierzchołków, 6 ścian (czworokąty, zgodnie z ruchem wskazówek zegara z zewnątrz).
VERTS = [(0, 0, 0), (10, 0, 0), (10, 10, 0), (0, 10, 0), (0, 0, 10), (10, 0, 10), (10, 10, 10), (0, 10, 10)]
QUADS = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (0, 4, 7, 3), (1, 2, 6, 5)]
NORMALS = [(0, 0, -1), (0, 0, 1), (0, -1, 0), (0, 1, 0), (-1, 0, 0), (1, 0, 0)]
TRIS = [t for quad in QUADS for t in ((quad[0], quad[1], quad[2]), (quad[0], quad[2], quad[3]))]


def path(name):
    return os.path.join(OUT, name)


def write_text(name, text):
    with open(path(name), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def write_bytes(name, data):
    with open(path(name), "wb") as f:
        f.write(data)


def fixed_zip(entries):
    """ZIP z ustalonymi datami wpisów, żeby wynik był powtarzalny. entries: [(nazwa, bajty)]."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)
    return buf.getvalue()


def obj():
    lines = ["# Sześcian (plik testowy)", "o Szescian"]
    lines += ["v %g %g %g" % v for v in VERTS]
    lines += ["f " + " ".join(str(i + 1) for i in quad) for quad in QUADS]
    write_text("model.obj", "\n".join(lines) + "\n")


def stl_binary():
    body = b"Szescian binarny STL".ljust(80, b"\x00")
    body += struct.pack("<I", len(TRIS))
    for tri in TRIS:
        a, b, c = (np.array(VERTS[i], dtype=np.float32) for i in tri)
        n = np.cross(b - a, c - a)
        n = n / np.linalg.norm(n)
        values = [*n, *a, *b, *c]
        body += struct.pack("<12fH", *[float(v) for v in values], 0)
    write_bytes("model.stl", body)


def stl_ascii():
    lines = ["solid szescian"]
    for tri in TRIS:
        a, b, c = (np.array(VERTS[i], dtype=np.float64) for i in tri)
        n = np.cross(b - a, c - a)
        n = n / np.linalg.norm(n)
        lines.append("  facet normal %g %g %g" % tuple(n))
        lines.append("    outer loop")
        for p in (a, b, c):
            lines.append("      vertex %g %g %g" % tuple(p))
        lines.append("    endloop")
        lines.append("  endfacet")
    lines.append("endsolid szescian")
    write_text("model-ascii.stl", "\n".join(lines) + "\n")


def ply_mesh():
    lines = [
        "ply", "format ascii 1.0", "comment Szescian (plik testowy)",
        "element vertex %d" % len(VERTS),
        "property float x", "property float y", "property float z",
        "element face %d" % len(QUADS),
        "property list uchar int vertex_indices", "end_header",
    ]
    lines += ["%g %g %g" % v for v in VERTS]
    lines += ["4 " + " ".join(str(i) for i in quad) for quad in QUADS]
    write_text("model.ply", "\n".join(lines) + "\n")


def cloud_points(n):
    rng = np.random.default_rng(RNG_SEED)
    xyz = rng.random((n, 3)).astype(np.float32) * np.array([100, 60, 20], dtype=np.float32)
    rgb = np.stack([
        (xyz[:, 0] / 100 * 255).astype(np.uint8),
        (xyz[:, 1] / 60 * 255).astype(np.uint8),
        (xyz[:, 2] / 20 * 255).astype(np.uint8),
    ], axis=1)
    return xyz, rgb


def ply_cloud():
    xyz, rgb = cloud_points(20000)
    header = "\n".join([
        "ply", "format binary_little_endian 1.0", "comment point cloud (test file)",
        "element vertex %d" % len(xyz),
        "property float x", "property float y", "property float z",
        "property uchar red", "property uchar green", "property uchar blue",
        "end_header", "",
    ])
    dtype = np.dtype([("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("r", "u1"), ("g", "u1"), ("b", "u1")])
    rec = np.zeros(len(xyz), dtype=dtype)
    rec["x"], rec["y"], rec["z"] = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    rec["r"], rec["g"], rec["b"] = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    write_bytes("chmura.ply", header.encode("ascii") + rec.tobytes())


def pcd_cloud():
    """PCD ASCII, pola x y z rgb; rgb spakowane w float jak w PCL (bity 0x00RRGGBB odczytane jako float32)."""
    xyz, rgb = cloud_points(10000)
    lines = [
        "# .PCD v0.7 - Point Cloud Data (plik testowy)", "VERSION 0.7", "FIELDS x y z rgb",
        "SIZE 4 4 4 4", "TYPE F F F F", "COUNT 1 1 1 1", "WIDTH %d" % len(xyz), "HEIGHT 1",
        "VIEWPOINT 0 0 0 1 0 0 0", "POINTS %d" % len(xyz), "DATA ascii",
    ]
    for (x, y, z), (r, g, b) in zip(xyz.tolist(), rgb.tolist()):
        packed = (r << 16) | (g << 8) | b
        color = struct.unpack("<f", struct.pack("<I", packed))[0]
        lines.append("%r %r %r %r" % (x, y, z, color))
    write_text("chmura.pcd", "\n".join(lines) + "\n")


def las_cloud():
    """LAS 1.2, format punktu 2 (x y z, intensywność, klasyfikacja, RGB), skala 0.01, nagłówek 227 B."""
    xyz, rgb = cloud_points(20000)
    scale = 0.01
    ints = np.round(xyz.astype(np.float64) / scale).astype(np.int32)
    dtype = np.dtype([
        ("x", "<i4"), ("y", "<i4"), ("z", "<i4"), ("intensity", "<u2"), ("bits", "u1"),
        ("classification", "u1"), ("scan_angle", "i1"), ("user_data", "u1"), ("source_id", "<u2"),
        ("r", "<u2"), ("g", "<u2"), ("b", "<u2"),
    ])
    rec = np.zeros(len(xyz), dtype=dtype)
    rec["x"], rec["y"], rec["z"] = ints[:, 0], ints[:, 1], ints[:, 2]
    rec["intensity"] = (np.arange(len(xyz)) % 65535).astype(np.uint16)
    rec["bits"] = 0x09  # jeden zwrot z jednego
    rec["classification"] = 2
    rec["r"], rec["g"], rec["b"] = rgb[:, 0].astype(np.uint16) * 256, rgb[:, 1].astype(np.uint16) * 256, rgb[:, 2].astype(np.uint16) * 256

    h = bytearray(227)
    struct.pack_into("<4s", h, 0, b"LASF")
    struct.pack_into("<BB", h, 24, 1, 2)
    struct.pack_into("<32s", h, 26, b"notes-testy")
    struct.pack_into("<32s", h, 58, b"make-models.py")
    struct.pack_into("<HH", h, 90, 1, 2026)  # dzień roku utworzenia, rok
    struct.pack_into("<I", h, 96, 227)  # offset do danych punktów
    struct.pack_into("<I", h, 100, 0)  # liczba VLR
    struct.pack_into("<B", h, 104, 2)
    struct.pack_into("<H", h, 105, 26)
    struct.pack_into("<I", h, 107, len(xyz))
    struct.pack_into("<5I", h, 111, len(xyz), 0, 0, 0, 0)
    struct.pack_into("<3d", h, 131, scale, scale, scale)
    struct.pack_into("<3d", h, 155, 0.0, 0.0, 0.0)
    struct.pack_into("<6d", h, 179, float(ints[:, 0].max()) * scale, float(ints[:, 0].min()) * scale,
                     float(ints[:, 1].max()) * scale, float(ints[:, 1].min()) * scale,
                     float(ints[:, 2].max()) * scale, float(ints[:, 2].min()) * scale)
    assert len(h) == 227
    write_bytes("chmura.las", bytes(h) + rec.tobytes())


def gltf_buffers():
    """Pozycje, normale (po jednej na ścianę, 4 wierzchołki na ścianę) i indeksy uint16."""
    positions, normals, indices = [], [], []
    for f, quad in enumerate(QUADS):
        for i in quad:
            positions.append(VERTS[i])
            normals.append(NORMALS[f])
        base = f * 4
        indices += [base, base + 1, base + 2, base, base + 2, base + 3]
    pos = np.array(positions, dtype="<f4").tobytes()
    nrm = np.array(normals, dtype="<f4").tobytes()
    idx = np.array(indices, dtype="<u2").tobytes()
    return pos + nrm + idx, len(positions), len(indices)


def gltf_json(data, count, index_count, buffer_entry):
    doc = {
        "asset": {"version": "2.0", "generator": "make-models.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "Sześcian"}],
        "meshes": [{"name": "Sześcian", "primitives": [
            {"attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 2, "material": 0}]}],
        "materials": [{"name": "Czerwony", "pbrMetallicRoughness": {
            "baseColorFactor": [0.8, 0.2, 0.2, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.5}}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": count, "type": "VEC3",
             "min": [0, 0, 0], "max": [10, 10, 10]},
            {"bufferView": 1, "componentType": 5126, "count": count, "type": "VEC3"},
            {"bufferView": 2, "componentType": 5123, "count": index_count, "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": count * 12, "target": 34962},
            {"buffer": 0, "byteOffset": count * 12, "byteLength": count * 12, "target": 34962},
            {"buffer": 0, "byteOffset": count * 24, "byteLength": index_count * 2, "target": 34963},
        ],
        "buffers": [buffer_entry],
    }
    return json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8")


def gltf():
    data, count, index_count = gltf_buffers()
    uri = "data:application/octet-stream;base64," + base64.b64encode(data).decode("ascii")
    js = gltf_json(data, count, index_count, {"byteLength": len(data), "uri": uri})
    write_bytes("model.gltf", js)


def glb():
    data, count, index_count = gltf_buffers()
    js = gltf_json(data, count, index_count, {"byteLength": len(data)})
    js = js + b" " * (-len(js) % 4)
    bin_chunk = data + b"\x00" * (-len(data) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_chunk)
    out = struct.pack("<4sII", b"glTF", 2, total)
    out += struct.pack("<I4s", len(js), b"JSON") + js
    out += struct.pack("<I4s", len(bin_chunk), b"BIN\x00") + bin_chunk
    write_bytes("model.glb", out)


def off():
    lines = ["OFF", "%d %d 0" % (len(VERTS), len(QUADS))]
    lines += ["%g %g %g" % v for v in VERTS]
    lines += ["4 " + " ".join(str(i) for i in quad) for quad in QUADS]
    write_text("model.off", "\n".join(lines) + "\n")


def threemf():
    verts = "".join('<vertex x="%g" y="%g" z="%g"/>' % v for v in VERTS)
    tris = "".join('<triangle v1="%d" v2="%d" v3="%d"/>' % t for t in TRIS)
    model = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<model unit="millimeter" xml:lang="pl-PL" '
        'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
        '<resources><object id="1" type="model"><mesh>'
        "<vertices>" + verts + "</vertices><triangles>" + tris + "</triangles>"
        "</mesh></object></resources><build><item objectid=\"1\"/></build></model>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
        'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
        "</Relationships>"
    )
    write_bytes("model.3mf", fixed_zip([
        ("[Content_Types].xml", content_types.encode("utf-8")),
        ("_rels/.rels", rels.encode("utf-8")),
        ("3D/3dmodel.model", model.encode("utf-8")),
    ]))


def amf():
    verts = "".join(
        "<vertex><coordinates><x>%g</x><y>%g</y><z>%g</z></coordinates></vertex>" % v for v in VERTS)
    tris = "".join("<triangle><v1>%d</v1><v2>%d</v2><v3>%d</v3></triangle>" % t for t in TRIS)
    body = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<amf unit="millimeter"><metadata type="name">Sześcian</metadata>'
        '<object id="0"><mesh><vertices>' + verts + "</vertices>"
        "<volume>" + tris + "</volume></mesh></object>"
        "<constellation id=\"1\"><instance objectid=\"0\"/></constellation></amf>"
    )
    write_text("model.amf", body)


def collada():
    pos = " ".join("%g %g %g" % v for v in VERTS)
    prim = " ".join("%d %d %d" % t for t in TRIS)
    body = f"""<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><contributor><authoring_tool>make-models.py</authoring_tool></contributor>
    <created>2026-01-01T00:00:00</created><modified>2026-01-01T00:00:00</modified>
    <up_axis>Z_UP</up_axis><unit name="millimeter" meter="0.001"/></asset>
  <library_effects>
    <effect id="czerwony-fx"><profile_COMMON><technique sid="common"><phong>
      <diffuse><color>0.8 0.2 0.2 1</color></diffuse></phong></technique></profile_COMMON></effect>
  </library_effects>
  <library_materials>
    <material id="czerwony" name="Czerwony"><instance_effect url="#czerwony-fx"/></material>
  </library_materials>
  <library_geometries>
    <geometry id="szescian-geom" name="Szescian">
      <mesh>
        <source id="szescian-pos">
          <float_array id="szescian-pos-array" count="{len(VERTS) * 3}">{pos}</float_array>
          <technique_common><accessor source="#szescian-pos-array" count="{len(VERTS)}" stride="3">
            <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
          </accessor></technique_common>
        </source>
        <vertices id="szescian-verts"><input semantic="POSITION" source="#szescian-pos"/></vertices>
        <triangles count="{len(TRIS)}" material="czerwony">
          <input semantic="VERTEX" source="#szescian-verts" offset="0"/>
          <p>{prim}</p>
        </triangles>
      </mesh>
    </geometry>
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="scena" name="Scena">
      <node id="szescian" name="Szescian">
        <instance_geometry url="#szescian-geom">
          <bind_material><technique_common>
            <instance_material symbol="czerwony" target="#czerwony"/>
          </technique_common></bind_material>
        </instance_geometry>
      </node>
    </visual_scene>
  </library_visual_scenes>
  <scene><instance_visual_scene url="#scena"/></scene>
</COLLADA>
"""
    write_text("model.dae", body)


def vrml():
    points = ", ".join("%g %g %g" % v for v in VERTS)
    index = " ".join("%d %d %d %d -1" % q for q in QUADS)
    body = f"""#VRML V2.0 utf8
# Sześcian (plik testowy)
Shape {{
  appearance Appearance {{ material Material {{ diffuseColor 0.2 0.6 0.9 }} }}
  geometry IndexedFaceSet {{
    solid TRUE
    coord Coordinate {{ point [ {points} ] }}
    coordIndex [ {index} ]
  }}
}}
"""
    write_text("model.wrl", body)


def dxf():
    """DXF R12 (AC1009), kodowanie ANSI_1250 (polskie znaki); 3 warstwy z kolorami; linie, okrąg, łuk,
    polilinia, tekst. Grupy kodów: wartość w osobnym wierszu."""
    pairs = []

    def add(code, value):
        pairs.append((str(code), str(value)))

    add(0, "SECTION"); add(2, "HEADER")
    add(9, "$ACADVER"); add(1, "AC1009")
    add(9, "$DWGCODEPAGE"); add(3, "ANSI_1250")
    add(9, "$INSUNITS"); add(70, 4)
    add(0, "ENDSEC")
    add(0, "SECTION"); add(2, "TABLES")
    add(0, "TABLE"); add(2, "LAYER"); add(70, 4)
    layers = [("0", 7), ("SCIANY", 1), ("WYMIARY", 3), ("TEKST", 5)]
    for name, color in layers:
        add(0, "LAYER"); add(2, name); add(70, 0); add(62, color); add(6, "CONTINUOUS")
    add(0, "ENDTAB")
    add(0, "ENDSEC")
    add(0, "SECTION"); add(2, "ENTITIES")
    add(0, "LINE"); add(8, "SCIANY"); add(10, 0); add(20, 0); add(11, 1000); add(21, 0)
    add(0, "LINE"); add(8, "SCIANY"); add(10, 1000); add(20, 0); add(11, 1000); add(21, 600)
    add(0, "LINE"); add(8, "SCIANY"); add(10, 1000); add(20, 600); add(11, 0); add(21, 600)
    add(0, "LINE"); add(8, "SCIANY"); add(10, 0); add(20, 600); add(11, 0); add(21, 0)
    add(0, "CIRCLE"); add(8, "WYMIARY"); add(10, 500); add(20, 300); add(40, 120)
    add(0, "ARC"); add(8, "WYMIARY"); add(10, 1400); add(20, 300); add(40, 180)
    add(50, 0); add(51, 90)
    add(0, "POLYLINE"); add(8, "TEKST"); add(66, 1); add(10, 0); add(20, 0); add(70, 0)
    for x, y in [(0, 700), (300, 900), (600, 700), (1000, 900)]:
        add(0, "VERTEX"); add(8, "TEKST"); add(10, x); add(20, y); add(70, 0)
    add(0, "SEQEND"); add(8, "TEKST")
    add(0, "TEXT"); add(8, "TEKST"); add(10, 0); add(20, -150); add(40, 60); add(1, "Rzut parteru")
    add(0, "ENDSEC")
    add(0, "EOF")
    text = "".join(f"{code}\n{value}\n" for code, value in pairs)
    write_bytes("rysunek.dxf", text.encode("cp1250"))


def main():
    os.makedirs(OUT, exist_ok=True)
    obj()
    stl_binary()
    stl_ascii()
    ply_mesh()
    ply_cloud()
    pcd_cloud()
    las_cloud()
    gltf()
    glb()
    off()
    threemf()
    amf()
    collada()
    vrml()
    dxf()


if __name__ == "__main__":
    main()
