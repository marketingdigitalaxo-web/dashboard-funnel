"""Semanas comerciales: de domingo a sábado, numeradas como la semana ISO del
lunes siguiente. Así la W01 de 2026 va del domingo 28-dic-2025 al sábado
3-ene-2026 (el lunes 29-dic-2025 es el primer día de la semana ISO 1)."""

from datetime import date, timedelta


def inicio(d: date) -> date:
    """Domingo en que empieza la semana de d."""
    return d - timedelta(days=(d.weekday() + 1) % 7)


def semana_id(d: date) -> str:
    y, w, _ = (inicio(d) + timedelta(days=1)).isocalendar()
    return f"{y}-W{w:02d}"


def rango(sid: str):
    """(domingo, sábado) de una semana 'AAAA-Www'."""
    y, w = int(sid[:4]), int(sid[6:])
    lunes = date.fromisocalendar(y, w, 1)
    dom = lunes - timedelta(days=1)
    return dom, dom + timedelta(days=6)
