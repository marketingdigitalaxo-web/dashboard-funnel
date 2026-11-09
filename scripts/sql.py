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
       COALESCE(collected_traffic_source.manual_source, {_param('source')}), NULL) AS src,
    IF(event_name = 'session_start',
       COALESCE(collected_traffic_source.manual_medium, {_param('medium')}), NULL) AS med,
    IF(event_name = 'session_start', collected_traffic_source.gclid, NULL) AS gclid,
    IF(event_name = 'view_search_results',
       LOWER(TRIM({_param('search_term')})), NULL) AS term,
    IF(event_name = 'purchase', ecommerce.purchase_revenue, NULL) AS rev,
    IF(event_name = 'purchase', ecommerce.transaction_id, NULL) AS tid,
    IF(event_name IN ('view_item', 'add_to_cart', 'purchase'),
       ARRAY(SELECT AS STRUCT item_id, item_name, quantity, item_revenue FROM UNNEST(items)),
       NULL) AS it
  FROM {_tabla(prop_id, dia)}
  WHERE event_name IN ({', '.join(repr(e) for e in EVENTOS)})"""


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


def script_diario(dia, marcas=None):
    """Script multi-sentencia para un día (YYYYMMDD). Devuelve (sql, nombres)
    donde nombres es la lista de tablas resumen, en el mismo orden en que
    aparecen los SELECT finales del script."""
    props = PROPIEDADES if marcas is None else {m: PROPIEDADES[m] for m in marcas}
    union = "\n  UNION ALL".join(_eventos_marca(m, p, dia) for m, p in props.items())

    sql = f"""
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
    WHEN path = '/' THEN 'Home'
    WHEN STARTS_WITH(path, '/checkout/cart') THEN 'Carro'
    WHEN STARTS_WITH(path, '/checkout') THEN 'Checkout'
    WHEN LOGICAL_OR(ev = 'view_search_results') OR STARTS_WITH(path, '/catalogsearch') THEN 'Búsqueda'
    WHEN LOGICAL_OR(ev = 'view_item') THEN 'PDP'
    WHEN LOGICAL_OR(ev = 'view_item_list') THEN 'PLP'
    WHEN STARTS_WITH(path, '/customer') OR STARTS_WITH(path, '/sales') THEN 'Cuenta'
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
  IFNULL(LAG(p.tipo) OVER w, '') != p.tipo AS cambia_tipo
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
      STRING_AGG(IF(cambia_tipo, tipo, NULL), ' > ' ORDER BY n LIMIT 6) AS seq6,
      COUNTIF(cambia_tipo) AS pasos
    FROM pv GROUP BY marca, sk
  )
SELECT
  evs.marca, evs.sk, evs.dev,
  IFNULL(inicio.s.src, '(direct)') AS src,
  IFNULL(inicio.s.med, '(none)') AS med,
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
  CONCAT(secs.seq6, IF(secs.pasos > 6, ' > …', ''),
         IF(evs.compras > 0, ' > Compra', ' > Salida')) AS recorrido
FROM evs
LEFT JOIN inicio USING (marca, sk)
LEFT JOIN pags USING (marca, sk)
LEFT JOIN secs USING (marca, sk)
);

-- ===== tablas resumen (en este orden) =====

-- embudo
SELECT marca, canal, IFNULL(dev, 'otro') AS dev,
  COUNT(*) AS sesiones, COUNTIF(home) AS s_home, COUNTIF(plp) AS s_plp,
  COUNTIF(pdp) AS s_pdp, COUNTIF(busq) AS s_busq, COUNTIF(carro) AS s_carro,
  COUNTIF(chk) AS s_chk, COUNTIF(compro) AS s_compra,
  SUM(compras) AS compras, ROUND(SUM(ingresos)) AS ingresos
FROM ses GROUP BY 1, 2, 3;

-- canales_detalle
SELECT marca, canal, src, med, COUNT(*) AS sesiones, COUNTIF(compro) AS s_compra,
  SUM(compras) AS compras, ROUND(SUM(ingresos)) AS ingresos
FROM ses GROUP BY 1, 2, 3, 4 HAVING sesiones >= 3;

-- profundidad
SELECT marca, IFNULL(dev, 'otro') AS dev, tipo, tramo,
  COUNT(*) AS sesiones, COUNTIF(compro) AS s_compra
FROM ses,
  UNNEST([STRUCT('PDP' AS tipo, n_pdp AS n), STRUCT('PLP', n_plp)]) AS x,
  UNNEST([CASE WHEN x.n = 0 THEN '0' WHEN x.n <= 3 THEN CAST(x.n AS STRING)
               WHEN x.n <= 5 THEN '4-5' WHEN x.n <= 10 THEN '6-10' ELSE '10+' END]) AS tramo
GROUP BY 1, 2, 3, 4;

-- recorridos
SELECT marca, recorrido, COUNT(*) AS sesiones, COUNTIF(compro) AS s_compra,
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
  COUNT(DISTINCT IF(ses.compro, pv.sk, NULL)) AS s_compra,
  COUNTIF(pv.n = 1 AND ses.compro) AS entradas_compra,
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
  COUNTIF(ses.compro) AS s_compra
FROM b LEFT JOIN vi USING (marca, sk) JOIN ses USING (marca, sk)
GROUP BY 1, 2 HAVING sesiones >= 2;

-- productos
SELECT marca, i.item_id, ANY_VALUE(i.item_name) AS nombre,
  COUNTIF(ev = 'view_item') AS vistas,
  SUM(IF(ev = 'add_to_cart', IFNULL(i.quantity, 1), 0)) AS agregados,
  SUM(IF(ev = 'purchase', IFNULL(i.quantity, 1), 0)) AS unidades,
  ROUND(SUM(IF(ev = 'purchase', IFNULL(i.item_revenue, 0), 0))) AS ingresos
FROM eventos, UNNEST(it) AS i
WHERE i.item_id IS NOT NULL
GROUP BY 1, 2 HAVING vistas >= 3 OR unidades > 0;
"""
    nombres = ["embudo", "canales_detalle", "profundidad", "recorridos", "paginas",
               "transiciones", "busqueda", "productos"]
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
  WHERE event_name IN ('session_start', 'page_view', 'add_to_cart', 'begin_checkout', 'purchase')"""
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
