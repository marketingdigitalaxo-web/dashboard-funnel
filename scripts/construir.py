#!/usr/bin/env python3
"""
Arma los archivos que lee el dashboard (carpeta site/data) a partir de la
carpeta de datos (store).

- meta.json: semanas disponibles, marcas y fechas.
- diario.json: embudo por día (chico) -> el dashboard suma exactamente los
  días de las semanas elegidas.
- semana/AAAA-Www.json: páginas, productos, búsqueda y recorridos de la
  semana; semana/AAAA-Www-trans.json: hacia dónde va la gente desde cada
  página (se carga solo al pedirlo).
- semana/AAAA-Www-rebote.json: rebote por canal, campaña y página de
  entrada (se carga solo en la pestaña Canales).
- hoy.json: pulso por hora del día en curso con sus referencias.
"""

import glob
import gzip
import json
import os
import shutil
import sys
from datetime import date, datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(__file__))
import semanas  # noqa: E402

TZ = ZoneInfo("America/Santiago")
STORE = os.environ.get("STORE_DIR", "store")
SITE = os.environ.get("SITE_DIR", "site")


def leer(r):
    opener = gzip.open if r.endswith(".gz") else open
    with opener(r, "rt", encoding="utf-8") as f:
        return json.load(f)


def escribir(nombre, obj):
    r = os.path.join(SITE, "data", nombre)
    os.makedirs(os.path.dirname(r), exist_ok=True)
    with open(r, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def main():
    # Embudo diario
    cols, filas, fechas = None, [], []
    for r in sorted(glob.glob(os.path.join(STORE, "chico", "*.json.gz"))):
        d = leer(r)
        t = d["embudo"]
        cols = ["fecha"] + t["cols"]
        filas.extend([d["fecha"]] + x for x in t["rows"])
        fechas.append(d["fecha"])
    if not fechas:
        print("No hay días procesados todavía.")
        return
    escribir("diario.json", {"embudo": {"cols": cols, "rows": filas}})

    # Semanas
    lista = []
    for r in sorted(glob.glob(os.path.join(STORE, "semanas", "*.json.gz"))):
        s = leer(r)
        sid = s["semana"]
        trans = s.pop("transiciones", None)
        rebote = s.pop("rebote", None)
        escribir(f"semana/{sid}.json", s)
        escribir(f"semana/{sid}-trans.json", trans or {"cols": [], "rows": []})
        escribir(f"semana/{sid}-rebote.json", rebote or {"cols": [], "rows": []})
        dom, sab = semanas.rango(sid)
        dias_embudo = [f for f in fechas if dom.isoformat() <= f <= sab.isoformat()]
        lista.append({"id": sid, "desde": dom.isoformat(), "hasta": sab.isoformat(),
                      "dias": len(dias_embudo), "completa": len(dias_embudo) == 7})

    ruta_hoy = os.path.join(STORE, "hoy", "hoy.json")
    hoy = leer(ruta_hoy) if os.path.exists(ruta_hoy) else None
    if hoy:
        escribir("hoy.json", hoy)

    marcas = sorted({x[1] for x in filas})
    escribir("meta.json", {
        "generado": datetime.now(TZ).isoformat(timespec="seconds"),
        "desde": fechas[0], "hasta": fechas[-1], "dias": len(fechas),
        "marcas": marcas, "semanas": lista,
        "hoy_actualizado": hoy["actualizado"] if hoy else None,
    })
    print(f"Sitio armado: {len(fechas)} días ({fechas[0]} a {fechas[-1]}), {len(lista)} semanas, {len(marcas)} marcas.")


if __name__ == "__main__":
    main()
