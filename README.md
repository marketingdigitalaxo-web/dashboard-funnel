# Dashboard de recorrido del cliente (GA4 → BigQuery → GitHub Pages)

Panel para ver cómo navegan los clientes en los 17 ecommerce: de qué canal
llegan, qué páginas y secciones ven, hacia dónde siguen, dónde se caen en el
embudo (home → PLP → PDP → carro → checkout → compra), qué buscan y qué
productos miran. Pensado para los equipos comercial, SXO y campañas on-site.

## Cómo fluyen los datos

```
GA4 (17 propiedades) --[exportación nativa, ya activa]--> BigQuery (magento-integracion-326020)
BigQuery --[scripts/actualizar.py, GitHub Actions cada hora]--> rama "datos" (un archivo por día)
rama "datos" --[scripts/construir.py]--> archivos resumen --> GitHub Pages (index.html + app.js)
```

- El dashboard nunca consulta BigQuery: solo lee archivos resumen ya calculados.
- Nada se escribe en BigQuery. La cuenta robot (`dashboard-lector@reporteria-cos`)
  solo tiene permisos de lectura (Visor de datos + Usuario de trabajo).
- La rama `datos` se reescribe en cada corrida con un solo commit, así el
  repositorio no crece con el tiempo.

## Qué hace el robot (`.github/workflows/actualizar.yml`)

Corre cada hora (minuto 17):

1. **Hoy**: pulso por hora del día en curso por marca, comparado con el mismo
   día de la semana pasada.
2. **Diario** (una vez al día, desde las 7:00 hora Chile): recalcula los
   últimos 3 días completos, por si GA4 corrigió datos recientes.
3. **Historial**: si se indica `historial_desde` al correrlo a mano, completa
   los días que falten desde esa fecha, de a 30 por corrida. La carga acordada
   es desde la W01 de 2026 (domingo 28-dic-2025) y se hace solo cuando el
   equipo lo pida.

Los datos se guardan por **semana comercial** (domingo a sábado, numerada
como la semana ISO del lunes siguiente: la W01 de 2026 va del 28-dic-2025 al
3-ene-2026). El embudo se guarda por día; páginas, productos, búsqueda,
recorridos y transiciones se suman por semana y se recortan a las filas más
relevantes de cada marca.

Cada consulta tiene un tope de seguridad (`MAX_GB_DIARIO` y `MAX_GB_HOY` en
`scripts/bq.py`): si una consulta fuera a leer más que eso, BigQuery la
rechaza sin cobrar.

## Puesta en marcha

1. **Secreto**: Settings → Secrets and variables → Actions →
   `GOOGLE_SERVICE_ACCOUNT_JSON` con el JSON completo de la cuenta robot.
2. **Pages**: Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. **Primera corrida**: Actions → *Actualizar dashboard* → Run workflow, con
   `historial_desde` = `2025-12-28` para cargar desde la W01 de 2026 (se
   completa en varias corridas, de a 30 días).

`Prueba de consultas` (workflow manual) corre un día de prueba sin guardar
nada: sirve para revisar costos y cifras después de un cambio en el SQL.

## Definiciones

- **Sesión**: `user_pseudo_id` + `ga_session_id`.
- **Conversión**: compras (transacciones) / sesiones, en todo el dashboard.
- **Países**: solo se cuenta el tráfico de Chile, Perú y Argentina (`PAISES` en `scripts/sql.py`).
- **Tipo de página** (por URL dentro de la sesión): Home = `/`; Carro =
  `/checkout/cart`; Checkout = resto de `/checkout`; Búsqueda = página con
  `view_search_results` o `/catalogsearch`; PDP = página con `view_item`;
  PLP = página con `view_item_list`; Cuenta = `/customer`, `/sales`; Otra = el resto.
- **Pasos del embudo**: una sesión "llega al carro" si agregó algo al carro o
  vio el carro; "llega a checkout" si inició checkout o vio `/checkout`.
- **Canal**: desde la fuente/medio del inicio de sesión, en minúsculas. Si hay `gclid` cuenta
  como Google CPC. Las auto-referencias (el propio sitio como referido) cuentan
  como Directo.
- **Rutas**: se limpian parámetros (`?utm=...`), mayúsculas y la barra final.
  `/hombre` y `/hombre/chaquetas` son rutas distintas.
- **Recorridos**: secuencia de tipos de página de la sesión, juntando los
  pasos repetidos seguidos (PDP, PDP, PDP = PDP), primeros 6 pasos.

## Limitaciones conocidas

- **Victoria's Secret**: ~49% de sus eventos llega sin `ga_session_id`; esas
  visitas se agrupan como una sesión por usuario y día. Sus métricas por
  sesión no son comparables con las otras marcas hasta corregir el tagging.
- Solo hay exportación *streaming* (`events_intraday_*`); el campo de
  atribución oficial de GA4 viene vacío, por eso el canal se arma desde el
  inicio de sesión. Puede diferir levemente de lo que muestra la interfaz de GA4.
- "Sin resultados" en el buscador no se mide directo: se aproxima como
  búsquedas tras las cuales la sesión no abrió ningún producto.
- Las tablas grandes (páginas, productos, búsqueda, recorridos) vienen
  resumidas por semana y con un máximo de filas por marca y semana (páginas
  800, productos 600, términos 300, recorridos 80). Al sumar varias semanas,
  una fila que no entró en el máximo de alguna semana suma de menos.

## Estructura

```
web/index.html, web/app.js, web/style.css, web/funnel.css   el dashboard
scripts/sql.py         consultas a BigQuery (embudo, páginas, productos, etc.)
scripts/bq.py          conexión con la cuenta robot y topes de costo
scripts/actualizar.py  qué se consulta en cada corrida
scripts/construir.py   arma los archivos que lee el dashboard
.github/workflows/     el robot (cada hora) y la prueba manual
```

## Rebote por origen (en validación, próxima versión)

En la pestaña Canales, debajo del resumen por canal. Tabla diaria `rebote`:
marca × canal × campaña × página de entrada × dispositivo, con sesiones,
rebotes (vio una sola página), rebotes rápidos (además sin interacción: menos
de 10 s, criterio GA4), compras e ingresos. Campaña = utm_campaign; Google Ads
con autoetiquetado sin nombre queda como "(google ads sin nombre)".

Reglas de "Lectura" (rebote rápido, misma marca y período, mín. 300 sesiones
en la fila y 200 en la referencia): 1) desajuste anuncio-página (+15 pts vs la
misma página desde otros orígenes); 2) revisar audiencia (+15 pts vs mediana
de campañas del canal, en la mayoría de sus páginas); 3) revisar página (+15
pts vs mediana de su tipo); 4) carro vacío al llegar (carro con rebote > 40%).
Sección y umbrales a validar con el equipo.
