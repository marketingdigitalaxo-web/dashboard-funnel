#!/usr/bin/env python3
"""
Arma los archivos que lee el dashboard (carpeta site/data) a partir de los
días guardados en la carpeta de datos (store).

- diario.json: tablas chicas por día (embudo, profundidad) -> el dashboard
  puede filtrar cualquier rango de fechas.
- periodo-<p>.json: tablas grandes (páginas, transiciones, productos,
  búsqueda, recorridos, fuente/medio) ya sumadas para períodos fijos, con el
  período anterior para comparar.
- hoy.json: pulso por hora del día en curso.
"""

import glob
import gzip
import json
import os
from collections import defaultdict
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Santiago")
STORE = os.environ.get("STORE_DIR", "store")
SITE = os.environ.get("SITE_DIR", "site")

# tabla -> (columnas clave, columnas "primer valor", límite de filas por marca, columna para ordenar)
GRANDES = {
    "paginas": (["marca", "path"], ["tipo"], 600, "vistas"),
    "transiciones": (["marca", "path", "sig_path"], [], None, "n"),
    "productos": (["marca", "item_id"], ["nombre"], 400, "vistas"),
    "busqueda": (["marca", "term"], [], 250, "sesiones"),
    "recorridos": (["marca", "recorrido"], [], 60, "sesiones"),
    "canales_detalle": (["marca", "canal", "src", "med"], [], 40, "sesiones"),
}
# columnas del período anterior que se agregan para comparar
COMPARAR = {
    "paginas": ["vistas", "entradas", "s_compra", "entradas_compra"],
    "productos": ["vistas", "agregados", "unidades", "ingresos"],
    "busqueda": ["sesiones", "s_clic_producto", "s_compra"],
    "recorridos": ["sesiones", "s_compra"],
    "canales_detalle": ["sesiones", "s_compra", "ingresos"],
}
DIARIAS = ["embudo", "profundidad"]


def leer(ruta):
    opener = gzip.open if ruta.endswith(".gz") else open
    with opener(ruta, "rt", encoding="utf-8") as f:
        return json.load(f)


def escribir(nombre, obj):
    os.makedirs(os.path.join(SITE, "data"), exist_ok=True)
    with open(os.path.join(SITE, "data", nombre), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def cargar_dias():
    dias = {}
    for ruta in sorted(glob.glob(os.path.join(STORE, "diario", "*.json.gz"))):
        d = leer(ruta)
        dias[date.fromisoformat(d["fecha"])] = d["tablas"]
    return dias


def sumar(tablas, clave, primeros):
    """Suma tablas (mismas columnas) agrupando por las columnas clave."""
    if not tablas:
        return None
    cols = tablas[0]["cols"]
    ik = [cols.index(c) for c in clave]
    ip = [cols.index(c) for c in primeros]
    isum = [i for i, c in enumerate(cols) if i not in ik and i not in ip]
    acc = {}
    for t in tablas:
        for r in t["rows"]:
            k = tuple(r[i] for i in ik)
            if k not in acc:
                acc[k] = [r[i] for i in ip] + [0] * len(isum)
            fila = acc[k]
            for j, i in enumerate(isum):
                fila[len(ip) + j] += r[i] or 0
    cols_out = clave + primeros + [cols[i] for i in isum]
    return {"cols": cols_out, "rows": [list(k) + v for k, v in acc.items()]}


def recortar(tabla, limite, orden):
    if limite is None or tabla is None:
        return tabla
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


def agregar_anterior(actual, anterior, clave, metricas):
    if actual is None:
        return None
    cols = actual["cols"] + [m + "_ant" for m in metricas]
    if anterior is None:
        return {"cols": cols, "rows": [r + [None] * len(metricas) for r in actual["rows"]]}
    ik = [anterior["cols"].index(c) for c in clave]
    im = [anterior["cols"].index(m) for m in metricas]
    idx = {tuple(r[i] for i in ik): [r[i] for i in im] for r in anterior["rows"]}
    ika = [actual["cols"].index(c) for c in clave]
    filas = [r + idx.get(tuple(r[i] for i in ika), [0] * len(metricas)) for r in actual["rows"]]
    return {"cols": cols, "rows": filas}


def periodos(ultimo):
    """Períodos fijos: (id, nombre, desde, hasta, desde_ant, hasta_ant)."""
    p = []
    for n in (7, 30, 90):
        hasta = ultimo
        desde = ultimo - timedelta(days=n - 1)
        p.append((f"{n}d", f"Últimos {n} días", desde, hasta,
                  desde - timedelta(days=n), desde - timedelta(days=1)))
    ini_mes = ultimo.replace(day=1)
    dias_mes = (ultimo - ini_mes).days
    ini_ant = (ini_mes - timedelta(days=1)).replace(day=1)
    fin_ant_equiv = min(ini_ant + timedelta(days=dias_mes), ini_mes - timedelta(days=1))
    p.append(("mes", "Mes en curso", ini_mes, ultimo, ini_ant, fin_ant_equiv))
    fin_ant = ini_mes - timedelta(days=1)
    ini_ant2 = (ini_ant - timedelta(days=1)).replace(day=1)
    p.append(("mes_ant", "Mes anterior", ini_ant, fin_ant, ini_ant2, ini_ant - timedelta(days=1)))
    return p


def main():
    dias = cargar_dias()
    if not dias:
        print("No hay días procesados todavía.")
        return
    fechas = sorted(dias)
    ultimo = fechas[-1]

    # Tablas diarias completas (con la fecha como primera columna).
    diario = {}
    for nombre in DIARIAS:
        cols = None
        filas = []
        for f in fechas:
            t = dias[f].get(nombre)
            if not t:
                continue
            cols = ["fecha"] + t["cols"]
            iso = f.isoformat()
            filas.extend([iso] + r for r in t["rows"])
        diario[nombre] = {"cols": cols, "rows": filas}
    escribir("diario.json", diario)

    # Tablas grandes por período.
    lista = []
    for pid, pnombre, desde, hasta, desde_ant, hasta_ant in periodos(ultimo):
        en = [f for f in fechas if desde <= f <= hasta]
        if not en:
            continue
        en_ant = [f for f in fechas if desde_ant <= f <= hasta_ant]
        completo_ant = len(en_ant) >= (hasta_ant - desde_ant).days + 1
        salida = {}
        for nombre, (clave, primeros, limite, orden) in GRANDES.items():
            act = sumar([dias[f][nombre] for f in en if nombre in dias[f]], clave, primeros)
            if nombre == "transiciones":
                salida[nombre] = act
                continue
            act = recortar(act, limite, orden)
            ant = sumar([dias[f][nombre] for f in en_ant if nombre in dias[f]], clave, primeros) if completo_ant else None
            salida[nombre] = agregar_anterior(act, ant, clave, COMPARAR.get(nombre, []))
        # transiciones: solo desde las páginas que quedaron, top 8 destinos
        paginas = {(r[0], r[1]) for r in salida["paginas"]["rows"]} if salida.get("paginas") else set()
        tr = salida.get("transiciones")
        if tr:
            agrup = defaultdict(list)
            for r in tr["rows"]:
                if (r[0], r[1]) in paginas:
                    agrup[(r[0], r[1])].append(r)
            filas = []
            for rs in agrup.values():
                rs.sort(key=lambda r: -r[3])
                filas.extend(rs[:8])
            salida["transiciones"] = {"cols": tr["cols"], "rows": filas}
        salida["periodo"] = {
            "id": pid, "nombre": pnombre, "desde": desde.isoformat(), "hasta": hasta.isoformat(),
            "dias": len(en), "desde_ant": desde_ant.isoformat(), "hasta_ant": hasta_ant.isoformat(),
            "hay_anterior": completo_ant,
        }
        escribir(f"periodo-{pid}.json", salida)
        lista.append(salida["periodo"])

    hoy = None
    ruta_hoy = os.path.join(STORE, "hoy", "hoy.json")
    if os.path.exists(ruta_hoy):
        hoy = leer(ruta_hoy)
        escribir("hoy.json", hoy)

    marcas = sorted({r[1] for r in diario["embudo"]["rows"]})
    escribir("meta.json", {
        "generado": datetime.now(TZ).isoformat(timespec="seconds"),
        "desde": fechas[0].isoformat(),
        "hasta": ultimo.isoformat(),
        "dias": len(fechas),
        "marcas": marcas,
        "periodos": lista,
        "hoy_actualizado": hoy["actualizado"] if hoy else None,
    })
    print(f"Sitio armado: {len(fechas)} días ({fechas[0]} a {ultimo}), {len(marcas)} marcas, {len(lista)} períodos.")


if __name__ == "__main__":
    main()
