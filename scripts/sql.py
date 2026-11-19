"""
Construye las consultas de BigQuery para el dashboard de recorrido.

Todo se calcula sobre la exportación GA4 -> BigQuery (tablas
events_intraday_YYYYMMDD, una por marca). El resultado de cada consulta es
chico (tablas resumen); nunca se guarda nada en BigQuery.
"""

PROJECT = "magento-integracion-326020"

# Marca -> property ID de GA4 (mismo listado que Codigo.gs del dashboard de
# campañas).
PROPIEDADES = {
    "Kliper": "286349547",
    "TNF": "359152452",
    "Kipling": "291020747",
    "Brooks": "291021462",
    "Marmot": "359148289",
    "Andes": "289606263",
    "DC": "289522253",
    "Banana": "289575716",
    "GAP": "289615940",
    "UGG": "289622581",
    "Mammut": "289580976",
    "Surprice": "289618242",
    "Stoked": "359131028",
    "Guess": "263971040",
    "BBW": "263966736",
    "VS": "252082503",
    "Lacoste": "543934765",
}

# Solo se cuenta el tráfico de estos países (nombres en inglés, como los
# guarda GA4 en geo.country). Decisión del equipo, 19-nov-2026.
PAISES = ("Chile", "Peru", "Argentina")
PAISES_SQL = ", ".join(f"'{p}'" for p in PAISES)

EVENTOS = (
    "session_start", "page_view", "view_item_list", "view_item",
    "add_to_cart", "begin_checkout", "purchase", "view_search_results",
)


def _param(key, tipo="string"):
    return f"(SELECT value.{tipo}_value FROM UNNEST(event_params) WHERE key = '{key}')"


def _tabla(prop_id, dia):
    return f"`{PROJECT}.analytics_{prop_id}.events_intraday_{dia}`"


def _eventos_marca(marca, prop_id, dia):
    sid = _param("ga_session_id", "int")
    return f"""
  SELECT
    '{marca}' AS marca,
    event_name AS ev,
    event_timestamp AS ts,
    CONCAT(user_pseudo_id, '.', IFNULL(CAST({sid} AS STRING), 'nosid')) AS sk,
    device.category AS dev,
    {_param('page_location')} AS loc,
    IF(event_name = 'session_start', {_param('page_referrer')}, NULL) AS ref,
    IF(event_name = 'session_start',
       LOWER(TRIM(COALESCE(collected_traffic_source.manual_source, {_param('source')}))), NULL) AS src,
    IF(event_name = 'session_start',
       LOWER(TRIM(COALESCE(collected_traffic_source.manual_medium, {_param('medium')}))), NULL) AS med,
    IF(event_name = 'session_start', collected_traffic_source.gclid, NULL) AS gclid,
    IF(event_name = 'view_search_results',
       LOWER(TRIM({_param('search_term')})), NULL) AS term,
    IF(event_name = 'purchase', ecommerce.purchase_revenue, NULL) AS rev,
    IF(event_name = 'purchase', ecommerce.transaction_id, NULL) AS tid,
    IF(event_name IN ('view_item', 'add_to_cart', 'purchase'),
       ARRAY(SELECT AS STRUCT item_id, item_name, quantity, item_revenue FROM UNNEST(items)),
       NULL) AS it
  FROM {_tabla(prop_id, dia)}
  WHERE event_name IN ({', '.join(repr(e) for e in EVENTOS)})
    AND geo.country IN ({PAISES_SQL})"""


# Rutas que son listados (PLP) aunque la página no envíe view_item_list.
# Primer tramo de la URL = categoría o sección comercial; cubre sus derivados
# (/hombre, /hombre/chaquetas, /hombre/chaquetas/termicas...). Validado con el
# equipo sobre las páginas "Otra" del 2 al 8 de noviembre de 2026.
RUTAS_PLP = (r"^/(hombre|mujer|nino|nina|ninos|kids|zapatos|calzado|equipamiento|equipamiento-mammut"
             r"|accesorios|carteras|lenceria|sale|ofertas|catalogo|tendencias|nueva-temporada"
             r"|new-arrivals|novedades|especiales|especialestnf|plp|plp-general)(/|$)")


# Canal agrupado, a partir de la fuente/medio del inicio de sesión.
CANAL_SQL = r"""
  CASE
    WHEN gclid IS NOT NULL OR REGEXP_CONTAINS(med, r'^(cpc|ppc|paid)')
      THEN IF(REGEXP_CONTAINS(src, r'facebook|instagram|^ig$|meta|tiktok'),
              'Social pagado',
              IF(REGEXP_CONTAINS(src, r'google|bing|yahoo'), 'Búsqueda pagada', 'Otros pagados'))
    WHEN REGEXP_CONTAINS(med, r'email|mail') OR REGEXP_CONTAINS(src, r'emarsys|transaccional|mail')
      THEN 'Email'
    WHEN med = 'organic' THEN 'Búsqueda orgánica'
    WHEN REGEXP_CONTAINS(med, r'social') OR REGEXP_CONTAINS(src, r'facebook|instagram|^ig$|t\.co|tiktok|linkedin|pinterest|youtube')
      THEN 'Social orgánico'
    WHEN med = 'referral' AND (src = host OR ENDS_WITH(src, REGEXP_REPLACE(host, r'^www\.', '')))
      THEN 'Directo'
    WHEN med = 'referral' AND REGEXP_CONTAINS(src, r'google|bing|yahoo|duckduckgo|googlequicksearchbox')
      THEN 'Búsqueda orgánica'
    WHEN med = 'referral' THEN 'Referidos'
    WHEN src = '(direct)' OR src IS NULL THEN 'Directo'
    ELSE 'Otros'
  END"""


UDF_RECORRIDO = r'''-- 0) resumen del recorrido como en GA4: las repeticiones seguidas de PDP, de
--    PLP, y de los pares PLP > PDP / PDP > PLP se juntan en un paso "× n".
--    Formato: pasos separados por " | ", un par como "PLP+PDP", la cantidad
--    tras "*" (ej. "Home | PLP+PDP*3 | Carro"). Máximo 8 pasos; luego "…".
CREATE TEMP FUNCTION comprimir_recorrido(t ARRAY<STRING>) RETURNS STRING LANGUAGE js AS r"""
  if (!t || !t.length) return null;
  const R = new Set(['PDP', 'PLP']);
  const out = [];
  let i = 0;
  while (i < t.length && out.length < 9) {
    const a = t[i];
    if (R.has(a)) {
      let r = 1;
      while (i + r < t.length && t[i + r] === a) r++;
      if (r >= 2) { out.push(a + '*' + r); i += r; continue; }
      const b = t[i + 1];
      if (R.has(b) && b !== a) {
        let k = 1;
        while (t[i + 2 * k] === a && t[i + 2 * k + 1] === b) k++;
        if (k >= 2) { out.push(a + '+' + b + '*' + k); i += 2 * k; continue; }
      }
    }
    out.push(a); i++;
  }
  if (out.length > 8) { out.length = 8; out.push('…'); }
  return out.join(' | ');
""";
'''


def script_diario(dia, marcas=None):
    """Script multi-sentencia para un día (YYYYMMDD). Devuelve (sql, nombres)
    donde nombres es la lista de tablas resumen, en el mismo orden en que
    aparecen los SELECT finales del script."""
    props = PROPIEDADES if marcas is None else {m: PROPIEDADES[m] for m in marcas}
    union = "\n  UNION ALL".join(_eventos_marca(m, p, dia) for m, p in props.items())

    sql = f"""
{UDF_RECORRIDO}
-- 1) eventos relevantes del día, con la ruta de la URL limpia
CREATE TEMP TABLE eventos AS
SELECT
  * EXCEPT (loc),
  NET.HOST(loc) AS host,
  IFNULL(NULLIF(RTRIM(REGEXP_EXTRACT(LOWER(loc), r'^https?://[^/]+(/[^?#]*)'), '/'), ''), '/') AS path
FROM ({union}
);

-- 2) una fila por página dentro de cada sesión, con su tipo
CREATE TEMP TABLE pg AS
SELECT
  marca, sk, path,
  MIN(ts) AS t0,
  CASE
    WHEN path IN ('/', '/pink') THEN 'Home'
    WHEN REGEXP_CONTAINS(path, r'/checkout/cart') THEN 'Carro'
    WHEN REGEXP_CONTAINS(path, r'/checkout(/|$)') THEN 'Checkout'
    WHEN LOGICAL_OR(ev = 'view_search_results') OR REGEXP_CONTAINS(path, r'/catalogsearch') THEN 'Búsqueda'
    WHEN LOGICAL_OR(ev = 'view_item') THEN 'PDP'
    WHEN LOGICAL_OR(ev = 'view_item_list') THEN 'PLP'
    WHEN REGEXP_CONTAINS(path, r'/(customer|sales)(/|$)') THEN 'Cuenta'
    -- Listados que no envían view_item_list (validado con el equipo el 19-nov):
    -- toda ruta bajo una categoría o sección comercial, con sus derivados.
    WHEN REGEXP_CONTAINS(path, r'{RUTAS_PLP}') THEN 'PLP'
    ELSE 'Otra'
  END AS tipo
FROM eventos
WHERE path IS NOT NULL
GROUP BY marca, sk, path;

-- 3) secuencia de vistas de página por sesión
CREATE TEMP TABLE pv AS
SELECT
  e.marca, e.sk, e.path, p.tipo,
  ROW_NUMBER() OVER w AS n,
  COUNT(*) OVER (PARTITION BY e.marca, e.sk) AS total,
  LEAD(e.path) OVER w AS sig_path,
  LEAD(p.tipo) OVER w AS sig_tipo,
  IFNULL(LAG(e.path) OVER w, '') = e.path AS recarga
FROM eventos e
JOIN pg p USING (marca, sk, path)
WHERE e.ev = 'page_view'
WINDOW w AS (PARTITION BY e.marca, e.sk ORDER BY e.ts);

-- 4) una fila por sesión
CREATE TEMP TABLE ses AS
SELECT * EXCEPT (gclid, host), {CANAL_SQL} AS canal FROM (
WITH
  inicio AS (
    SELECT marca, sk,
      ARRAY_AGG(STRUCT(src, med, gclid, host) ORDER BY ts LIMIT 1)[OFFSET(0)] AS s
    FROM eventos WHERE ev = 'session_start' GROUP BY marca, sk
  ),
  evs AS (
    SELECT marca, sk,
      ANY_VALUE(dev) AS dev,
      LOGICAL_OR(ev = 'add_to_cart') AS atc,
      LOGICAL_OR(ev = 'begin_checkout') AS bc,
      LOGICAL_OR(ev = 'view_search_results') AS busco,
      COUNT(DISTINCT IF(ev = 'purchase', IFNULL(tid, CAST(ts AS STRING)), NULL)) AS compras,
      IFNULL(SUM(rev), 0) AS ingresos
    FROM eventos GROUP BY marca, sk
  ),
  pags AS (
    SELECT marca, sk,
      LOGICAL_OR(tipo = 'Home') AS home,
      LOGICAL_OR(tipo = 'PLP') AS plp,
      LOGICAL_OR(tipo = 'PDP') AS pdp,
      LOGICAL_OR(tipo = 'Búsqueda') AS busq_pag,
      LOGICAL_OR(tipo = 'Carro') AS carro,
      LOGICAL_OR(tipo = 'Checkout') AS chk,
      COUNTIF(tipo = 'PDP') AS n_pdp,
      COUNTIF(tipo = 'PLP') AS n_plp
    FROM pg GROUP BY marca, sk
  ),
  secs AS (
    SELECT marca, sk,
      ANY_VALUE(IF(n = 1, path, NULL)) AS entrada,
      comprimir_recorrido(ARRAY_AGG(IF(recarga, NULL, tipo) IGNORE NULLS ORDER BY n LIMIT 60)) AS recorrido
    FROM pv GROUP BY marca, sk
  )
SELECT
  evs.marca, evs.sk, evs.dev,
  IF(inicio.s.gclid IS NOT NULL, 'google', IFNULL(inicio.s.src, '(direct)')) AS src,
  IF(inicio.s.gclid IS NOT NULL, 'cpc', IFNULL(inicio.s.med, '(none)')) AS med,
  inicio.s.gclid AS gclid,
  inicio.s.host AS host,
  IFNULL(pags.home, FALSE) AS home,
  IFNULL(pags.plp, FALSE) AS plp,
  IFNULL(pags.pdp, FALSE) AS pdp,
  evs.busco OR IFNULL(pags.busq_pag, FALSE) AS busq,
  evs.atc OR IFNULL(pags.carro, FALSE) AS carro,
  evs.bc OR IFNULL(pags.chk, FALSE) AS chk,
  evs.compras > 0 AS compro,
  evs.compras, evs.ingresos,
  IFNULL(pags.n_pdp, 0) AS n_pdp,
  IFNULL(pags.n_plp, 0) AS n_plp,
  secs.entrada,
  secs.recorrido
FROM evs
LEFT JOIN inicio USING (marca, sk)
LEFT JOIN pags USING (marca, sk)
LEFT JOIN secs USING (marca, sk)
);

-- ===== tablas resumen (en este orden) =====
-- Conversión en todo el dashboard = compras (transacciones) / sesiones.

-- embudo
SELECT marca, canal, IFNULL(dev, 'otro') AS dev,
  COUNT(*) AS sesiones, COUNTIF(home) AS s_home, COUNTIF(plp) AS s_plp,
  COUNTIF(pdp) AS s_pdp, COUNTIF(busq) AS s_busq, COUNTIF(carro) AS s_carro,
  COUNTIF(chk) AS s_chk, COUNTIF(compro) AS s_compra,
  SUM(IF(busq, compras, 0)) AS compras_busq,
  SUM(compras) AS compras, ROUND(SUM(ingresos)) AS ingresos
FROM ses GROUP BY 1, 2, 3;

-- recorridos
SELECT marca, recorrido, COUNT(*) AS sesiones, SUM(compras) AS compras,
  ROUND(SUM(ingresos)) AS ingresos
FROM ses WHERE recorrido IS NOT NULL
GROUP BY 1, 2
QUALIFY ROW_NUMBER() OVER (PARTITION BY marca ORDER BY sesiones DESC) <= 80;

-- paginas
SELECT pv.marca, pv.path, ANY_VALUE(pv.tipo) AS tipo,
  COUNT(*) AS vistas,
  COUNT(DISTINCT pv.sk) AS sesiones,
  COUNTIF(pv.n = 1) AS entradas,
  COUNTIF(pv.n = pv.total) AS salidas,
  SUM(IF(pv.n = 1, ses.compras, 0)) AS entradas_compras,
  ROUND(SUM(IF(pv.n = 1, ses.ingresos, 0))) AS ingresos_entrada,
  COUNTIF(pv.sig_tipo = 'PDP') AS sig_pdp,
  COUNTIF(pv.sig_tipo = 'PLP') AS sig_plp,
  COUNTIF(pv.sig_tipo = 'Búsqueda') AS sig_busq,
  COUNTIF(pv.sig_tipo IN ('Carro', 'Checkout')) AS sig_carro,
  COUNTIF(pv.sig_tipo IN ('Home', 'Cuenta', 'Otra')) AS sig_otra,
  COUNTIF(pv.sig_tipo IS NULL) AS sig_salida
FROM pv JOIN ses USING (marca, sk)
GROUP BY 1, 2 HAVING vistas >= 3;

-- transiciones
SELECT marca, path, IFNULL(sig_path, '(salida)') AS sig_path, COUNT(*) AS n
FROM pv WHERE path != IFNULL(sig_path, '')
GROUP BY 1, 2, 3 HAVING n >= 3;

-- busqueda
WITH b AS (
  SELECT marca, sk, term, MIN(ts) AS t FROM eventos
  WHERE ev = 'view_search_results' AND term IS NOT NULL AND term != ''
  GROUP BY 1, 2, 3
), vi AS (
  SELECT marca, sk, MAX(ts) AS t_ult FROM eventos WHERE ev = 'view_item' GROUP BY 1, 2
)
SELECT b.marca, b.term, COUNT(*) AS sesiones,
  COUNTIF(vi.t_ult > b.t) AS s_clic_producto,
  SUM(ses.compras) AS compras
FROM b LEFT JOIN vi USING (marca, sk) JOIN ses USING (marca, sk)
GROUP BY 1, 2 HAVING sesiones >= 2;

-- productos: sesiones que vieron el producto y transacciones que lo incluyen
SELECT marca, i.item_id, ANY_VALUE(i.item_name) AS nombre,
  COUNTIF(ev = 'view_item') AS vistas,
  COUNT(DISTINCT IF(ev = 'view_item', sk, NULL)) AS sesiones,
  SUM(IF(ev = 'add_to_cart', IFNULL(i.quantity, 1), 0)) AS agregados,
  COUNT(DISTINCT IF(ev = 'purchase', IFNULL(tid, CAST(ts AS STRING)), NULL)) AS compras,
  SUM(IF(ev = 'purchase', IFNULL(i.quantity, 1), 0)) AS unidades,
  ROUND(SUM(IF(ev = 'purchase', IFNULL(i.item_revenue, 0), 0))) AS ingresos
FROM eventos, UNNEST(it) AS i
WHERE i.item_id IS NOT NULL
GROUP BY 1, 2 HAVING vistas >= 3 OR unidades > 0;
"""
    nombres = ["embudo", "recorridos", "paginas", "transiciones", "busqueda", "productos"]
    return sql, nombres


def consulta_hoy(dia, marcas=None):
    """Pulso por hora de un día (YYYYMMDD): sesiones, carros, checkouts,
    compras e ingresos por marca y hora (hora Chile)."""
    props = PROPIEDADES if marcas is None else {m: PROPIEDADES[m] for m in marcas}
    sid = _param("ga_session_id", "int")
    partes = [f"""
  SELECT '{m}' AS marca, event_name AS ev, event_timestamp AS ts,
    CONCAT(user_pseudo_id, '.', IFNULL(CAST({sid} AS STRING), 'nosid')) AS sk,
    ecommerce.purchase_revenue AS rev, ecommerce.transaction_id AS tid
  FROM {_tabla(p, dia)}
  WHERE event_name IN ('session_start', 'page_view', 'add_to_cart', 'begin_checkout', 'purchase')
    AND geo.country IN ({PAISES_SQL})"""
              for m, p in props.items()]
    return f"""
WITH e AS ({' UNION ALL'.join(partes)}
)
SELECT marca,
  EXTRACT(HOUR FROM DATETIME(TIMESTAMP_MICROS(ts), 'America/Santiago')) AS hora,
  COUNT(DISTINCT sk) AS sesiones,
  COUNT(DISTINCT IF(ev = 'add_to_cart', sk, NULL)) AS s_carro,
  COUNT(DISTINCT IF(ev = 'begin_checkout', sk, NULL)) AS s_chk,
  COUNT(DISTINCT IF(ev = 'purchase', IFNULL(tid, CAST(ts AS STRING)), NULL)) AS compras,
  ROUND(IFNULL(SUM(rev), 0)) AS ingresos
FROM e GROUP BY 1, 2 ORDER BY 1, 2
"""
