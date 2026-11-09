#!/usr/bin/env python3
"""
Trae los datos de GA4 (BigQuery) y los deja en la carpeta de datos
("store"), un archivo por día.

Modos:
  python scripts/actualizar.py prueba
      Estima costos y corre un día de prueba con 2 marcas. No guarda nada.
  python scripts/actualizar.py normal
      Lo que corre el robot cada hora:
        - "Hoy": pulso por hora del día en curso (siempre).
        - Diario: reprocesa los últimos 3 días completos, una vez al día
          (desde las 7:00 hora Chile).
        - Historial: completa los días que falten hasta DIAS_HISTORIAL,
          de a MAX_DIAS_POR_CORRIDA por vez.
"""

import gzip
import json
import os
import sys
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(__file__))
import bq  # noqa: E402
import sql  # noqa: E402

TZ = ZoneInfo("America/Santiago")
STORE = os.environ.get("STORE_DIR", "store")
DIAS_HISTORIAL = int(os.environ.get("DIAS_HISTORIAL", "90"))
DIAS_REPROCESO = 3
MAX_DIAS_POR_CORRIDA = int(os.environ.get("MAX_DIAS_POR_CORRIDA", "10"))
HORA_DIARIO = 7


def ahora():
    return datetime.now(TZ)


def ymd(d):
    return d.strftime("%Y%m%d")


def ruta_dia(d):
    return os.path.join(STORE, "diario", f"{d.isoformat()}.json.gz")


def guardar_json(ruta, obj):
    os.makedirs(os.path.dirname(ruta), exist_ok=True)
    tmp = ruta + ".tmp"
    if ruta.endswith(".gz"):
        with gzip.open(tmp, "wt", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    else:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, ruta)


def leer_json(ruta, defecto=None):
    if not os.path.exists(ruta):
        return defecto
    opener = gzip.open if ruta.endswith(".gz") else open
    with opener(ruta, "rt", encoding="utf-8") as f:
        return json.load(f)


def procesar_dia(client, d):
    t0 = time.time()
    script, nombres = sql.script_diario(ymd(d))
    tablas, gb = bq.correr_script(client, script, nombres)
    guardar_json(ruta_dia(d), {
        "fecha": d.isoformat(),
        "procesado": ahora().isoformat(timespec="seconds"),
        "tablas": tablas,
    })
    filas = {k: len(v["rows"]) for k, v in tablas.items()}
    print(f"  {d}: {gb:.2f} GB, {time.time() - t0:.0f}s, filas {filas}")
    return gb


def procesar_hoy(client, hoy, meta):
    gb_total = 0.0
    tabla, gb = bq.correr_consulta(client, sql.consulta_hoy(ymd(hoy)))
    gb_total += gb
    ref_dia = hoy - timedelta(days=7)
    ruta_ref = os.path.join(STORE, "hoy", f"ref-{ref_dia.isoformat()}.json")
    ref = leer_json(ruta_ref)
    if ref is None:
        ref, gb = bq.correr_consulta(client, sql.consulta_hoy(ymd(ref_dia)))
        gb_total += gb
        guardar_json(ruta_ref, ref)
    guardar_json(os.path.join(STORE, "hoy", "hoy.json"), {
        "fecha": hoy.isoformat(),
        "referencia": ref_dia.isoformat(),
        "actualizado": ahora().isoformat(timespec="seconds"),
        "hoy": tabla,
        "ref": ref,
    })
    # limpia referencias viejas
    for nombre in os.listdir(os.path.join(STORE, "hoy")):
        if nombre.startswith("ref-") and nombre != f"ref-{ref_dia.isoformat()}.json":
            os.remove(os.path.join(STORE, "hoy", nombre))
    print(f"Hoy {hoy}: {gb_total:.2f} GB")
    return gb_total


def modo_normal():
    client = bq.cliente()
    t = ahora()
    hoy = t.date()
    meta = leer_json(os.path.join(STORE, "meta.json"), {})
    gb = procesar_hoy(client, hoy, meta)

    # Diario: una vez al día, reprocesa los últimos días completos.
    if meta.get("ultimo_diario") != hoy.isoformat() and t.hour >= HORA_DIARIO:
        print("Diario: reprocesando últimos días")
        for i in range(DIAS_REPROCESO, 0, -1):
            gb += procesar_dia(client, hoy - timedelta(days=i))
        meta["ultimo_diario"] = hoy.isoformat()

    # Historial: completa días faltantes (más recientes primero).
    faltan = [hoy - timedelta(days=i) for i in range(1, DIAS_HISTORIAL + 1)
              if not os.path.exists(ruta_dia(hoy - timedelta(days=i)))]
    if faltan:
        print(f"Historial: faltan {len(faltan)} días, se procesan hasta {MAX_DIAS_POR_CORRIDA}")
        for d in faltan[:MAX_DIAS_POR_CORRIDA]:
            gb += procesar_dia(client, d)

    # Borra días fuera de la ventana.
    limite = hoy - timedelta(days=DIAS_HISTORIAL)
    carpeta = os.path.join(STORE, "diario")
    for nombre in os.listdir(carpeta) if os.path.isdir(carpeta) else []:
        if nombre[:10] < limite.isoformat():
            os.remove(os.path.join(carpeta, nombre))

    meta["ultima_corrida"] = t.isoformat(timespec="seconds")
    meta["gb_ultima_corrida"] = round(gb, 2)
    guardar_json(os.path.join(STORE, "meta.json"), meta)
    print(f"Total facturado en esta corrida: {gb:.2f} GB")


def modo_prueba():
    client = bq.cliente()
    hoy = ahora().date()
    ayer = hoy - timedelta(days=1)
    script, nombres = sql.script_diario(ymd(ayer))
    print(f"Estimación hoy ({hoy}): {bq.estimar_gb(client, sql.consulta_hoy(ymd(hoy))):.2f} GB")

    t0 = time.time()
    tablas, gb = bq.correr_script(client, script, nombres)
    print(f"\nPrueba 17 marcas {ayer}: {gb:.2f} GB facturados, {time.time() - t0:.0f}s")
    for nombre, t in tablas.items():
        print(f"== {nombre}: {len(t['rows'])} filas")
    emb = tablas["embudo"]; c = emb["cols"]
    tot = {}
    for r in emb["rows"]:
        m = r[c.index("marca")]; tot.setdefault(m, [0, 0, 0])
        tot[m][0] += r[c.index("sesiones")]; tot[m][1] += r[c.index("compras")]; tot[m][2] += r[c.index("ingresos")]
    print("\nTotales por marca (para comparar con GA4): marca, sesiones, compras, ingresos")
    for m, v in sorted(tot.items()):
        print("  ", m, v)

    tabla, gb = bq.correr_consulta(client, sql.consulta_hoy(ymd(hoy), ["Andes", "VS"]))
    print(f"\n== hoy Andes+VS: {gb:.2f} GB, {len(tabla['rows'])} filas")
    for r in tabla["rows"][:6]:
        print("  ", r)


if __name__ == "__main__":
    modo = sys.argv[1] if len(sys.argv) > 1 else "normal"
    {"prueba": modo_prueba, "normal": modo_normal}[modo]()
