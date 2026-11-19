#!/usr/bin/env python3
"""
Trae los datos de GA4 (BigQuery) y los guarda en la carpeta de datos
("store"), organizados por semana comercial (domingo a sábado).

Qué se guarda:
  store/dias/AAAA-MM-DD.json.gz    todas las tablas de un día (solo los
                                   últimos DIAS_DETALLE días: sirven para
                                   rearmar la semana si un día se reprocesa)
  store/chico/AAAA-MM-DD.json.gz   embudo del día (chico; se guarda siempre)
  store/semanas/AAAA-Www.json.gz   tablas grandes sumadas por semana y
                                   recortadas a las filas más relevantes
  store/hoy/                       pulso por hora de hoy y sus referencias

Modos:
  python scripts/actualizar.py prueba
      Corre un día de prueba con todas las marcas. No guarda nada.
  python scripts/actualizar.py normal
      Lo que corre el robot:
        - "Hoy": pulso por hora del día en curso, con el mismo día de la
          semana pasada y del año pasado como referencia.
        - Diario: reprocesa los últimos 3 días completos, una vez al día
          (desde las 7:00 hora Chile).
        - Historial: completa los días que falten desde HISTORIAL_DESDE,
          de a MAX_DIAS_POR_CORRIDA por corrida.
"""

import glob
import gzip
import json
import os
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(__file__))
import bq  # noqa: E402
import semanas  # noqa: E402
import sql  # noqa: E402

TZ = ZoneInfo("America/Santiago")
STORE = os.environ.get("STORE_DIR", "store")
# Desde qué día se guarda historia. Vacío = no se completa historial (solo
# los días que el robot reprocesa). La carga completa acordada es desde la
# W01 de 2026 (domingo 28-dic-2025), y solo se hace cuando el equipo lo pida.
HISTORIAL_DESDE = os.environ.get("HISTORIAL_DESDE", "").strip()
DIAS_REPROCESO = 3
DIAS_DETALLE = 21
MAX_DIAS_POR_CORRIDA = int(os.environ.get("MAX_DIAS_POR_CORRIDA", "30"))
HORA_DIARIO = 7

# Recorte por marca y semana de las tablas grandes (para que el dashboard
# cargue rápido). (columnas clave, columnas "primer valor", máx. filas por
# marca, columna para ordenar)
RECORTE = {
    "paginas": (["marca", "path"], ["tipo"], 800, "vistas"),
    "productos": (["marca", "item_id"], ["nombre"], 600, "vistas"),
    "busqueda": (["marca", "term"], [], 300, "sesiones"),
    "recorridos": (["marca", "recorrido"], [], 80, "sesiones"),
}
TRANS_PAGINAS, TRANS_DESTINOS = 300, 6


def ahora():
    return datetime.now(TZ)


def ymd(d):
    return d.strftime("%Y%m%d")


def ruta(*partes):
    return os.path.join(STORE, *partes)


def guardar_json(r, obj):
    os.makedirs(os.path.dirname(r), exist_ok=True)
    tmp = r + ".tmp"
    opener = gzip.open if r.endswith(".gz") else open
    with opener(tmp, "wt", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, r)


def leer_json(r, defecto=None):
    if not os.path.exists(r):
        return defecto
    opener = gzip.open if r.endswith(".gz") else open
    with opener(r, "rt", encoding="utf-8") as f:
        return json.load(f)


# ---------- suma y recorte de tablas ----------

def sumar(tablas, clave, primeros):
    tablas = [t for t in tablas if t and t.get("cols")]
    if not tablas:
        return None
    cols = tablas[0]["cols"]
    ik = [cols.index(c) for c in clave]
    ip = [cols.index(c) for c in primeros]
    isum = [i for i in range(len(cols)) if i not in ik and i not in ip]
    acc = {}
    for t in tablas:
        for r in t["rows"]:
            k = tuple(r[i] for i in ik)
            if k not in acc:
                acc[k] = [r[i] for i in ip] + [0] * len(isum)
            fila = acc[k]
            for j, i in enumerate(isum):
                fila[len(ip) + j] += r[i] or 0
    return {"cols": clave + primeros + [cols[i] for i in isum],
            "rows": [list(k) + v for k, v in acc.items()]}


def recortar(tabla, limite, orden):
    if tabla is None:
        return None
    cols = tabla["cols"]
    im, io = cols.index("marca"), cols.index(orden)
    por_marca = defaultdict(list)
    for r in tabla["rows"]:
        por_marca[r[im]].append(r)
    filas = []
    for rs in por_marca.values():
        rs.sort(key=lambda r: -(r[io] or 0))
        filas.extend(rs[:limite])
    return {"cols": cols, "rows": filas}


def armar_semana(sid):
    """Suma los días guardados de la semana y deja el archivo semanal."""
    dom, sab = semanas.rango(sid)
    dias = [dom + timedelta(days=i) for i in range(7)]
    datos = [leer_json(ruta("dias", f"{d.isoformat()}.json.gz")) for d in dias]
    datos = [x for x in datos if x]
    if not datos:
        return
    salida = {"semana": sid, "desde": dom.isoformat(), "hasta": sab.isoformat(),
              "dias": sorted(x["fecha"] for x in datos)}
    for nombre, (clave, primeros, limite, orden) in RECORTE.items():
        salida[nombre] = recortar(sumar([x["tablas"].get(nombre) for x in datos], clave, primeros), limite, orden)
    # transiciones: solo desde las páginas más vistas, sus destinos principales
    tr = sumar([x["tablas"].get("transiciones") for x in datos], ["marca", "path", "sig_path"], [])
    top = recortar(salida["paginas"], TRANS_PAGINAS, "vistas")
    keep = {(r[0], r[1]) for r in top["rows"]} if top else set()
    agrup = defaultdict(list)
    for r in (tr["rows"] if tr else []):
        if (r[0], r[1]) in keep:
            agrup[(r[0], r[1])].append(r)
    filas = []
    for rs in agrup.values():
        rs.sort(key=lambda r: -r[3])
        filas.extend(rs[:TRANS_DESTINOS])
    salida["transiciones"] = {"cols": ["marca", "path", "sig_path", "n"], "rows": filas}
    guardar_json(ruta("semanas", f"{sid}.json.gz"), salida)


# ---------- consultas ----------

def procesar_dia(client, d):
    t0 = time.time()
    marcas = bq.marcas_con_tabla(client, sql.PROPIEDADES, ymd(d))
    if not marcas:
        print(f"  {d}: ninguna marca tiene datos ese día")
        return 0.0
    faltan = sorted(set(sql.PROPIEDADES) - set(marcas))
    script, nombres = sql.script_diario(ymd(d), marcas)
    tablas, gb = bq.correr_script(client, script, nombres)
    if faltan:
        print(f"  {d}: sin datos de {', '.join(faltan)}")
    guardar_json(ruta("dias", f"{d.isoformat()}.json.gz"),
                 {"fecha": d.isoformat(), "procesado": ahora().isoformat(timespec="seconds"), "tablas": tablas})
    guardar_json(ruta("chico", f"{d.isoformat()}.json.gz"), {"fecha": d.isoformat(), "embudo": tablas["embudo"]})
    filas = {k: len(v["rows"]) for k, v in tablas.items()}
    print(f"  {d} ({semanas.semana_id(d)}): {gb:.2f} GB, {time.time() - t0:.0f}s, filas {filas}")
    return gb


def procesar_hoy(client, hoy):
    gb_total = 0.0
    tabla, gb = bq.correr_consulta(client, sql.consulta_hoy(ymd(hoy), bq.marcas_con_tabla(client, sql.PROPIEDADES, ymd(hoy))))
    gb_total += gb
    refs = {}
    # Mismo día de la semana: hace 7 días y hace 364 días (52 semanas).
    for clave, dias in (("semana", 7), ("anio", 364)):
        d = hoy - timedelta(days=dias)
        r = ruta("hoy", f"ref-{d.isoformat()}.json")
        t = leer_json(r)
        if t is None:
            try:
                marcas = bq.marcas_con_tabla(client, sql.PROPIEDADES, ymd(d))
                t, gb = bq.correr_consulta(client, sql.consulta_hoy(ymd(d), marcas))
                gb_total += gb
                guardar_json(r, t)
            except Exception as e:  # p. ej. la tabla de ese día no existe
                print(f"Sin referencia {clave} ({d}): {e}")
                t = None
        refs[clave] = {"fecha": d.isoformat(), "datos": t}
    guardar_json(ruta("hoy", "hoy.json"), {
        "fecha": hoy.isoformat(),
        "actualizado": ahora().isoformat(timespec="seconds"),
        "hoy": tabla,
        "refs": refs,
    })
    vigentes = {f"ref-{v['fecha']}.json" for v in refs.values()}
    for nombre in os.listdir(ruta("hoy")):
        if nombre.startswith("ref-") and nombre not in vigentes:
            os.remove(ruta("hoy", nombre))
    print(f"Hoy {hoy}: {gb_total:.2f} GB")
    return gb_total


def modo_normal():
    client = bq.cliente()
    t = ahora()
    hoy = t.date()
    meta = leer_json(ruta("meta.json"), {})
    gb = procesar_hoy(client, hoy)
    tocadas = set()

    if meta.get("ultimo_diario") != hoy.isoformat() and t.hour >= HORA_DIARIO:
        print("Diario: reprocesando últimos días")
        for i in range(DIAS_REPROCESO, 0, -1):
            d = hoy - timedelta(days=i)
            gb += procesar_dia(client, d)
            tocadas.add(semanas.semana_id(d))
        meta["ultimo_diario"] = hoy.isoformat()

    if HISTORIAL_DESDE:
        desde = date.fromisoformat(HISTORIAL_DESDE)
        todos = [desde + timedelta(days=i) for i in range((hoy - desde).days)]
        faltan = [d for d in reversed(todos) if not os.path.exists(ruta("chico", f"{d.isoformat()}.json.gz"))]
        if faltan:
            print(f"Historial desde {desde}: faltan {len(faltan)} días, se procesan hasta {MAX_DIAS_POR_CORRIDA}")
            for d in faltan[:MAX_DIAS_POR_CORRIDA]:
                gb += procesar_dia(client, d)
                tocadas.add(semanas.semana_id(d))

    for sid in sorted(tocadas):
        armar_semana(sid)
        print(f"Semana {sid} armada")

    # Los días con detalle completo solo se guardan un tiempo (la semana ya
    # quedó armada); el embudo diario se guarda siempre.
    limite = (hoy - timedelta(days=DIAS_DETALLE)).isoformat()
    for r in glob.glob(ruta("dias", "*.json.gz")):
        if os.path.basename(r)[:10] < limite:
            os.remove(r)

    meta["ultima_corrida"] = t.isoformat(timespec="seconds")
    meta["gb_ultima_corrida"] = round(gb, 2)
    guardar_json(ruta("meta.json"), meta)
    print(f"Total facturado en esta corrida: {gb:.2f} GB")


def modo_prueba():
    client = bq.cliente()
    hoy = ahora().date()
    ayer = hoy - timedelta(days=1)
    script, nombres = sql.script_diario(ymd(ayer))
    t0 = time.time()
    tablas, gb = bq.correr_script(client, script, nombres)
    print(f"Prueba 17 marcas {ayer}: {gb:.2f} GB facturados, {time.time() - t0:.0f}s")
    for nombre, t in tablas.items():
        print(f"== {nombre}: {len(t['rows'])} filas")


if __name__ == "__main__":
    modo = sys.argv[1] if len(sys.argv) > 1 else "normal"
    {"prueba": modo_prueba, "normal": modo_normal}[modo]()
