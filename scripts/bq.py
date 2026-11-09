"""Conexión a BigQuery con la cuenta robot (secreto GOOGLE_SERVICE_ACCOUNT_JSON)."""

import json
import os
import sys

from google.cloud import bigquery
from google.oauth2.service_account import Credentials

from sql import PROJECT

# Tope de seguridad: ninguna consulta puede facturar más que esto. Si una
# consulta lo superara, BigQuery la rechaza sin cobrar.
MAX_GB_DIARIO = 15
MAX_GB_HOY = 2


def cliente():
    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not raw:
        sys.exit("Falta el secreto GOOGLE_SERVICE_ACCOUNT_JSON.")
    try:
        info = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.exit(f"GOOGLE_SERVICE_ACCOUNT_JSON no es un JSON válido: {e}")
    creds = Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/bigquery"])
    # Las consultas se ejecutan (y se facturan) en el proyecto donde están los datos.
    return bigquery.Client(project=PROJECT, credentials=creds)


def _config(max_gb, dry_run=False):
    return bigquery.QueryJobConfig(
        maximum_bytes_billed=int(max_gb * 1024 ** 3),
        dry_run=dry_run,
        use_query_cache=not dry_run,
        labels={"app": "dashboard-funnel"},
    )


def estimar_gb(client, sql):
    job = client.query(sql, job_config=_config(1000, dry_run=True))
    return job.total_bytes_processed / 1e9


def _tabla(rows, schema):
    cols = [f.name for f in schema]
    return {"cols": cols, "rows": [[_valor(r[c]) for c in cols] for r in rows]}


def _valor(v):
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def correr_script(client, sql, nombres, max_gb=MAX_GB_DIARIO):
    """Corre un script multi-sentencia y devuelve {nombre: tabla} con los
    resultados de cada SELECT final, en orden. También devuelve los GB
    facturados."""
    job = client.query(sql, job_config=_config(max_gb))
    job.result()
    hijos = list(client.list_jobs(parent_job=job.job_id))
    hijos.sort(key=lambda j: j.created)
    selects = [j for j in hijos if j.statement_type == "SELECT"]
    if len(selects) != len(nombres):
        raise RuntimeError(f"Se esperaban {len(nombres)} resultados y llegaron {len(selects)}")
    salida = {}
    for nombre, hijo in zip(nombres, selects):
        res = hijo.result()
        salida[nombre] = _tabla(list(res), res.schema)
    gb = (job.total_bytes_billed or 0) / 1e9
    return salida, gb


def correr_consulta(client, sql, max_gb=MAX_GB_HOY):
    job = client.query(sql, job_config=_config(max_gb))
    res = job.result()
    return _tabla(list(res), res.schema), (job.total_bytes_billed or 0) / 1e9
