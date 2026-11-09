/* Dashboard de recorrido del cliente.
   Lee los archivos de data/ (los genera GitHub Actions) y arma todo en el
   navegador. Sin build step: HTML + JS + Chart.js. */

const CONFIG = { locale: 'es-CL', currency: 'CLP', periodoDefecto: '30d' };
const fmtInt = new Intl.NumberFormat(CONFIG.locale, { maximumFractionDigits: 0 });
const fmtMoney = new Intl.NumberFormat(CONFIG.locale, { style: 'currency', currency: CONFIG.currency, maximumFractionDigits: 0 });
const pct = (x, d = 1) => (isFinite(x) ? (x * 100).toFixed(d).replace('.', ',') + '%' : '—');
const div = (a, b) => (b ? a / b : NaN);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Volúmenes mínimos para que una "oportunidad" cuente (evita alertar por 3 visitas).
const MIN = { sesionesPaso: 500, entradas: 200, vistasProd: 300, busqSes: 30, paginaVistas: 100 };

const PASOS = [
  { k: 's_plp', label: 'PLP' },
  { k: 's_pdp', label: 'PDP' },
  { k: 's_carro', label: 'Carro' },
  { k: 's_chk', label: 'Checkout' },
  { k: 's_compra', label: 'Compra' },
];
const TRAMOS = ['1', '2', '3', '4-5', '6-10', '10+'];
const SIGUIENTE = [
  { k: 'sig_pdp', label: 'PDP', color: 'var(--series-1)' },
  { k: 'sig_plp', label: 'PLP', color: 'var(--series-3)' },
  { k: 'sig_busq', label: 'Búsqueda', color: 'var(--series-5)' },
  { k: 'sig_carro', label: 'Carro / checkout', color: 'var(--series-4)' },
  { k: 'sig_otra', label: 'Otra', color: 'var(--series-other)' },
  { k: 'sig_salida', label: 'Salida', color: 'var(--series-2)' },
];

const state = {
  meta: null, diario: null, hoy: null, periodos: {},
  periodo: CONFIG.periodoDefecto, marcas: new Set(), canal: '', dev: '',
  tab: 'resumen', prof: 'PDP', pMarca: null, pPDP: false, abiertos: new Set(),
  charts: {}, sort: {},
};

/* ---------- utilidades de datos ---------- */
function objs(t) {
  if (!t || !t.cols) return [];
  return t.rows.map((r) => Object.fromEntries(t.cols.map((c, i) => [c, r[i]])));
}
async function getJSON(nombre) {
  const r = await fetch('data/' + nombre, { cache: 'no-cache' });
  if (!r.ok) throw new Error(nombre + ': HTTP ' + r.status);
  return r.json();
}
async function periodoData(id) {
  if (!state.periodos[id]) {
    const d = await getJSON('periodo-' + id + '.json');
    state.periodos[id] = {
      periodo: d.periodo,
      paginas: objs(d.paginas), transiciones: objs(d.transiciones), productos: objs(d.productos),
      busqueda: objs(d.busqueda), recorridos: objs(d.recorridos), canales_detalle: objs(d.canales_detalle),
    };
  }
  return state.periodos[id];
}
function periodoMeta() { return state.meta.periodos.find((p) => p.id === state.periodo) || state.meta.periodos[0]; }
const enMarcas = (m) => state.marcas.size === 0 || state.marcas.has(m);

function sumar(filas, campos) {
  const o = Object.fromEntries(campos.map((c) => [c, 0]));
  for (const f of filas) for (const c of campos) o[c] += f[c] || 0;
  return o;
}
const CAMPOS_EMBUDO = ['sesiones', 's_home', 's_plp', 's_pdp', 's_busq', 's_carro', 's_chk', 's_compra', 's_busq_compra', 'compras', 'ingresos'];

function filasEmbudo(desde, hasta, { ignorarMarca = false, ignorarCanal = false } = {}) {
  return state.diario.embudo.filter((f) => f.fecha >= desde && f.fecha <= hasta
    && (ignorarMarca || enMarcas(f.marca))
    && (ignorarCanal || !state.canal || f.canal === state.canal)
    && (!state.dev || f.dev === state.dev));
}
function agruparPor(filas, clave, campos) {
  const m = new Map();
  for (const f of filas) {
    const k = typeof clave === 'function' ? clave(f) : f[clave];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(f);
  }
  return [...m].map(([k, fs]) => ({ key: k, ...sumar(fs, campos) }));
}
// Referencia "típica" entre marcas: mediana de las tasas por marca (con un
// mínimo de sesiones). Se usa la mediana y no el promedio ponderado para que
// una marca muy grande o con medición distinta (ej. VS) no mueva la vara.
function medianaMarcas(porMarca, num, den, minDen = 200) {
  const xs = porMarca.filter((f) => f[den] >= minDen).map((f) => f[num] / f[den]).filter(isFinite).sort((a, b) => a - b);
  if (!xs.length) return NaN;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}
function deltaTxt(act, ant, esPct = false) {
  if (ant == null || !isFinite(act) || !isFinite(ant) || ant === 0) return null;
  if (esPct) {
    const dpp = (act - ant) * 100;
    return { txt: (dpp >= 0 ? '+' : '') + dpp.toFixed(2).replace('.', ',') + ' pp', up: dpp >= 0 };
  }
  const d = act / ant - 1;
  return { txt: (d >= 0 ? '+' : '') + (d * 100).toFixed(1).replace('.', ',') + '%', up: d >= 0 };
}

/* ---------- tablas ordenables ---------- */
function tabla(cont, { id, cols, filas, totales, defecto }) {
  const s = state.sort[id] || defecto || { i: null, dir: -1 };
  let fs = filas.slice();
  if (s.i != null && cols[s.i]) {
    const c = cols[s.i];
    const v = c.sort || c.v;
    fs.sort((a, b) => {
      const x = v(a), y = v(b);
      if (typeof x === 'string' || typeof y === 'string') return s.dir * String(x).localeCompare(String(y), 'es');
      return s.dir * ((isFinite(x) ? x : -Infinity) - (isFinite(y) ? y : -Infinity));
    });
  }
  const th = cols.map((c, i) => `<th class="sortable ${c.txt ? 'txt' : ''}" data-i="${i}" title="Ordenar">${esc(c.h)}${s.i === i ? (s.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('');
  const tr = fs.map((f) => `<tr${f._attrs || ''}>${cols.map((c) => {
    const cls = [c.txt ? 'txt' : '', c.cls ? c.cls(f) : ''].join(' ').trim();
    return `<td${cls ? ` class="${cls}"` : ''}>${c.html ? c.html(f) : esc(c.f ? c.f(c.v(f), f) : c.v(f))}</td>`;
  }).join('')}</tr>`).join('');
  const tf = totales ? `<tfoot><tr>${cols.map((c) => `<td class="${c.txt ? 'txt' : ''}">${c.v(totales) == null ? '' : esc(c.f ? c.f(c.v(totales), totales) : c.v(totales))}</td>`).join('')}</tr></tfoot>` : '';
  cont.innerHTML = fs.length ? `<table class="data"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody>${tf}</table>` : '<div class="empty-state">Sin datos para estos filtros.</div>';
  cont.querySelectorAll('th.sortable').forEach((el) => el.addEventListener('click', () => {
    const i = +el.dataset.i;
    const prev = state.sort[id] || defecto || {};
    state.sort[id] = { i, dir: prev.i === i ? -prev.dir : -1 };
    tabla(cont, { id, cols, filas, totales, defecto });
  }));
}
const fInt = (x) => (isFinite(x) ? fmtInt.format(x) : '—');
const fMoney = (x) => (isFinite(x) ? fmtMoney.format(x) : '—');
const fPct = (x) => pct(x);
const fDelta = (x) => (isFinite(x) ? (x >= 0 ? '+' : '') + (x * 100).toFixed(1).replace('.', ',') + '%' : '—');
const clsDelta = (x) => (isFinite(x) ? (x >= 0 ? 'delta up' : 'delta down') : 'prev');
const varRel = (a, b) => (b ? a / b - 1 : NaN);

/* ---------- gráficos ---------- */
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function destruir(id) { if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; } }
function opcionesBase() {
  const grid = css('--gridline'), txt = css('--text-secondary');
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: txt, boxWidth: 14, boxHeight: 2 } },
      tooltip: { backgroundColor: css('--text-primary'), titleColor: css('--page-plane'), bodyColor: css('--page-plane'), padding: 10 },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: txt, maxRotation: 0, autoSkip: true }, border: { color: css('--baseline') } },
      y: { grid: { color: grid }, ticks: { color: txt }, border: { display: false }, beginAtZero: true },
    },
  };
}

/* ---------- filtros ---------- */
function armarFiltros() {
  const sel = document.getElementById('f-periodo');
  sel.innerHTML = state.meta.periodos.map((p) => `<option value="${p.id}">${esc(p.nombre)} (${p.desde.slice(5).split('-').reverse().join('/')}–${p.hasta.slice(5).split('-').reverse().join('/')})</option>`).join('');
  if (!state.meta.periodos.some((p) => p.id === state.periodo)) state.periodo = state.meta.periodos[0].id;
  sel.value = state.periodo;
  sel.addEventListener('change', () => { state.periodo = sel.value; render(); });

  const canales = [...new Set(state.diario.embudo.map((f) => f.canal))].sort();
  document.getElementById('f-canal').insertAdjacentHTML('beforeend', canales.map((c) => `<option>${esc(c)}</option>`).join(''));
  document.getElementById('f-canal').addEventListener('change', (e) => { state.canal = e.target.value; render(); });
  document.getElementById('f-dev').addEventListener('change', (e) => { state.dev = e.target.value; render(); });

  const btn = document.getElementById('f-marca-btn'), panel = document.getElementById('f-marca-panel'), list = document.getElementById('f-marca-list');
  list.innerHTML = state.meta.marcas.map((m) => `<label class="multiselect-option"><input type="checkbox" value="${esc(m)}" /> ${esc(m)}</label>`).join('');
  const etiqueta = () => { btn.textContent = state.marcas.size === 0 ? 'Todas' : state.marcas.size === 1 ? [...state.marcas][0] : state.marcas.size + ' seleccionadas'; };
  list.addEventListener('change', (e) => {
    if (e.target.checked) state.marcas.add(e.target.value); else state.marcas.delete(e.target.value);
    etiqueta(); render();
  });
  document.getElementById('f-marca-clear').addEventListener('click', () => {
    state.marcas.clear(); list.querySelectorAll('input').forEach((i) => { i.checked = false; }); etiqueta(); render();
  });
  btn.addEventListener('click', () => { const abrir = panel.hidden; panel.hidden = !abrir; btn.setAttribute('aria-expanded', String(abrir)); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.multiselect')) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });

  document.querySelectorAll('nav.tabs button').forEach((b) => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    document.querySelectorAll('nav.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== 'tab-' + state.tab; });
    render();
  }));
  document.querySelectorAll('[data-prof]').forEach((b) => b.addEventListener('click', () => {
    state.prof = b.dataset.prof;
    document.querySelectorAll('[data-prof]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderProfundidad();
  }));

  const pm = document.getElementById('p-marca');
  pm.innerHTML = state.meta.marcas.map((m) => `<option>${esc(m)}</option>`).join('');
  pm.addEventListener('change', () => { state.pMarca = pm.value; state.abiertos.clear(); render(); });
  document.getElementById('p-pdp').addEventListener('change', (e) => { state.pPDP = e.target.checked; render(); });
  document.getElementById('trans-cerrar').addEventListener('click', () => { document.getElementById('card-transiciones').hidden = true; });
}

function notaFiltros() {
  const n = [];
  if (state.tab === 'paginas' || state.tab === 'productos') n.push('Canal y dispositivo no aplican a esta pestaña (las páginas y productos se resumen sin ese corte).');
  if (state.tab === 'recorrido' && (state.canal || state.dev)) n.push('Canal y dispositivo aplican al embudo, la profundidad y la conversión por día; recorridos y términos de búsqueda se muestran sin ese corte.');
  if (state.tab === 'hoy') n.push('"Hoy" muestra el día en curso; el período, el canal y el dispositivo no aplican.');
  if (state.marcas.has('VS') || state.marcas.size === 0) n.push('Incluye Victoria\'s Secret, cuya medición de sesiones está incompleta.');
  document.getElementById('filtros-nota').textContent = n.join(' ');
}

/* ---------- RESUMEN ---------- */
function kpi(label, valor, d, sub) {
  const delta = d ? `<div class="delta ${d.up ? 'up' : 'down'}">${d.up ? '▲' : '▼'} ${esc(d.txt)} vs anterior</div>` : '<div class="delta prev">sin período anterior</div>';
  return `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${esc(valor)}</div>${delta}${sub ? `<div class="sub2">${esc(sub)}</div>` : ''}</div>`;
}
function renderResumen() {
  const p = periodoMeta();
  const a = sumar(filasEmbudo(p.desde, p.hasta), CAMPOS_EMBUDO);
  const b = p.hay_anterior ? sumar(filasEmbudo(p.desde_ant, p.hasta_ant), CAMPOS_EMBUDO) : null;
  const conv = (x) => div(x.compras, x.sesiones);
  document.getElementById('kpis').innerHTML = [
    kpi('Sesiones', fmtInt.format(a.sesiones), b && deltaTxt(a.sesiones, b.sesiones)),
    kpi('Conversión', pct(conv(a), 2), b && deltaTxt(conv(a), conv(b), true)),
    kpi('Ingresos', fmtMoney.format(a.ingresos), b && deltaTxt(a.ingresos, b.ingresos)),
    kpi('Ticket promedio', fMoney(div(a.ingresos, a.compras)), b && deltaTxt(div(a.ingresos, a.compras), div(b.ingresos, b.compras))),
    kpi('Ingreso por sesión', fMoney(div(a.ingresos, a.sesiones)), b && deltaTxt(div(a.ingresos, a.sesiones), div(b.ingresos, b.sesiones))),
  ].join('');

  // Embudo por marca: % de sesiones que llega a cada paso, vs promedio del grupo.
  const porMarca = agruparPor(filasEmbudo(p.desde, p.hasta), 'marca', CAMPOS_EMBUDO);
  const prom = Object.fromEntries(PASOS.map((s) => [s.k, medianaMarcas(porMarca, s.k, 'sesiones')]));
  const colorear = (k) => (f) => {
    const v = div(f[k], f.sesiones), m = prom[k];
    if (!isFinite(v) || !isFinite(m) || f.sesiones < 200) return '';
    return v >= m * 1.1 ? 'good' : v <= m * 0.9 ? 'bad' : '';
  };
  tabla(document.getElementById('tabla-embudo-marca'), {
    id: 'embudo-marca', defecto: { i: 1, dir: -1 },
    cols: [
      { h: 'Marca', txt: true, v: (f) => f.key },
      { h: 'Sesiones', v: (f) => f.sesiones, f: fInt },
      ...PASOS.map((s) => ({ h: s.label, v: (f) => div(f[s.k], f.sesiones), f: (x) => pct(x, s.k === 's_compra' ? 2 : 1), cls: colorear(s.k) })),
      { h: 'Ingresos', v: (f) => f.ingresos, f: fMoney },
    ],
    filas: porMarca,
    totales: { key: 'Total', ...a },
  });
  renderOportunidades(porMarca, a);
}

async function renderOportunidades(porMarca, total) {
  const ops = [];
  // 1) pasos del embudo bajo el promedio
  const pasosPrev = ['sesiones', 's_plp', 's_pdp', 's_carro', 's_chk'];
  PASOS.forEach((s, i) => {
    if (s.k === 's_pdp') return; // muchas sesiones entran directo a PDP: la tasa PLP->PDP engaña
    const prevK = s.k === 's_carro' ? 's_pdp' : pasosPrev[i];
    const promedio = medianaMarcas(porMarca, s.k, prevK, MIN.sesionesPaso);
    for (const f of porMarca) {
      if (f[prevK] < MIN.sesionesPaso) continue;
      const v = div(f[s.k], f[prevK]);
      if (v < promedio * 0.75) {
        const nombrePrev = prevK === 'sesiones' ? 'las sesiones' : 'las sesiones que llegan a ' + PASOS.find((x) => x.k === prevK).label;
        ops.push({ peso: f[prevK] * (promedio - v), alta: v < promedio * 0.5, tag: 'Embudo',
          t: `${f.key}: solo ${pct(v)} de ${nombrePrev} llega a ${s.label}`,
          d: `marca típica (mediana) ${pct(promedio)} · ${fmtInt.format(f[prevK])} sesiones en el paso anterior` });
      }
    }
  });
  try {
    const pd = await periodoData(state.periodo);
    // 2) landings con mucho tráfico y baja conversión
    const convEntrada = new Map();
    for (const r of pd.paginas) {
      const c = convEntrada.get(r.marca) || { e: 0, c: 0 };
      c.e += r.entradas; c.c += r.entradas_compra; convEntrada.set(r.marca, c);
    }
    for (const r of pd.paginas) {
      if (!enMarcas(r.marca) || r.entradas < MIN.entradas) continue;
      const m = convEntrada.get(r.marca), base = div(m.c, m.e), v = div(r.entradas_compra, r.entradas);
      if (v < base * 0.4) ops.push({ peso: r.entradas * (base - v), tag: 'Página de entrada',
        t: `${r.marca} ${r.path}: ${fmtInt.format(r.entradas)} entradas, ${pct(v, 2)} convierte`,
        d: `la marca convierte ${pct(base, 2)} en sus páginas de entrada` });
    }
    // 3) productos muy vistos, poco agregados
    for (const o of productosOportunidad(pd.productos).slice(0, 5)) {
      ops.push({ peso: o.vistas * (o.base - o.tasa), tag: 'Producto',
        t: `${o.marca}: ${o.nombre || o.item_id} — ${fmtInt.format(o.vistas)} vistas, ${pct(o.tasa)} agrega al carro`,
        d: `promedio de la marca ${pct(o.base)}` });
    }
    // 4) búsquedas sin clic a producto
    for (const r of pd.busqueda) {
      if (!enMarcas(r.marca) || r.sesiones < MIN.busqSes) continue;
      const v = div(r.s_clic_producto, r.sesiones);
      if (v < 0.3) ops.push({ peso: r.sesiones * (0.5 - v), tag: 'Buscador',
        t: `${r.marca}: "${r.term}" — ${fmtInt.format(r.sesiones)} sesiones, solo ${pct(v, 0)} abre un producto`,
        d: 'posible búsqueda sin resultados relevantes' });
    }
  } catch (e) { /* sin datos de período todavía */ }
  ops.sort((x, y) => y.peso - x.peso);
  document.getElementById('oportunidades').innerHTML = ops.length
    ? ops.slice(0, 10).map((o) => `<div class="opp${o.alta ? ' alta' : ''}"><div class="t"><span class="tag">${esc(o.tag)}</span>${esc(o.t)}</div><div class="d">${esc(o.d)}</div></div>`).join('')
    : '<div class="empty-state">Sin oportunidades que superen los volúmenes mínimos.</div>';
}

/* ---------- RECORRIDO ---------- */
async function renderRecorrido() {
  const p = periodoMeta();
  const a = sumar(filasEmbudo(p.desde, p.hasta), CAMPOS_EMBUDO);
  const pasos = [{ k: 'sesiones', label: 'Sesiones' }, ...PASOS];
  document.getElementById('embudo-sub').textContent = '% del total de sesiones · relación con el paso anterior';
  document.getElementById('embudo-barras').innerHTML = pasos.map((s, i) => {
    const v = div(a[s.k], a.sesiones);
    const rel = i > 0 ? div(a[s.k], a[pasos[i - 1].k]) : null;
    return `<div class="fbar"><div class="lab">${esc(s.label)}</div><div class="track"><div class="fill${s.k === 's_compra' ? ' fin' : ''}" style="width:${Math.max(0, Math.min(100, v * 100))}%"></div></div>
      <div class="num">${fmtInt.format(a[s.k])} · ${pct(v, s.k === 's_compra' ? 2 : 1)}${rel != null ? `<small>${pct(rel)} del paso anterior</small>` : ''}</div></div>`;
  }).join('') + '<p class="legend-note">Una sesión puede llegar a PDP sin pasar por PLP (entrando directo a un producto); por eso los pasos se miden sobre el total de sesiones.</p>';

  renderProfundidad();

  // Conversión por día
  const dias = agruparPor(filasEmbudo(p.desde, p.hasta), 'fecha', ['sesiones', 'compras']).sort((x, y) => x.key.localeCompare(y.key));
  destruir('conv');
  const o = opcionesBase();
  o.plugins.legend.display = false;
  o.scales.y.ticks.callback = (v) => pct(v, 1);
  o.plugins.tooltip.callbacks = { label: (c) => `Conversión ${pct(c.parsed.y, 2)} · ${fmtInt.format(dias[c.dataIndex].sesiones)} sesiones` };
  state.charts.conv = new Chart(document.getElementById('chart-conv-dia'), {
    type: 'line',
    data: { labels: dias.map((d) => d.key.slice(8) + '/' + d.key.slice(5, 7)), datasets: [{ data: dias.map((d) => div(d.compras, d.sesiones)), borderColor: css('--series-1'), backgroundColor: css('--series-1'), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.2 }] },
    options: o,
  });

  // Buscador
  const sinBusq = a.sesiones - a.s_busq;
  document.getElementById('kpis-busqueda').innerHTML = [
    `<div class="kpi"><div class="label">Usan el buscador</div><div class="value">${pct(div(a.s_busq, a.sesiones))}</div><div class="sub2">${fmtInt.format(a.s_busq)} sesiones</div></div>`,
    `<div class="kpi"><div class="label">Conversión con búsqueda</div><div class="value">${pct(div(a.s_busq_compra, a.s_busq), 2)}</div></div>`,
    `<div class="kpi"><div class="label">Conversión sin búsqueda</div><div class="value">${pct(div(a.s_compra - a.s_busq_compra, sinBusq), 2)}</div></div>`,
  ].join('');

  try {
    const pd = await periodoData(state.periodo);
    const recs = agruparPor(pd.recorridos.filter((r) => enMarcas(r.marca)), 'recorrido', ['sesiones', 's_compra', 'ingresos', 'sesiones_ant', 's_compra_ant']);
    const totalSes = a.sesiones || 1;
    recs.sort((x, y) => y.sesiones - x.sesiones);
    tabla(document.getElementById('tabla-recorridos'), {
      id: 'recorridos', defecto: { i: 1, dir: -1 },
      cols: [
        { h: 'Recorrido', txt: true, v: (f) => f.key },
        { h: 'Sesiones', v: (f) => f.sesiones, f: fInt },
        { h: '% sesiones', v: (f) => f.sesiones / totalSes, f: fPct },
        { h: 'Conversión', v: (f) => div(f.s_compra, f.sesiones), f: (x) => pct(x, 2) },
        { h: 'Ingresos', v: (f) => f.ingresos, f: fMoney },
        { h: 'Δ sesiones', v: (f) => varRel(f.sesiones, f.sesiones_ant), f: fDelta, cls: (f) => clsDelta(varRel(f.sesiones, f.sesiones_ant)) },
      ],
      filas: recs.slice(0, 60),
    });
    const terms = pd.busqueda.filter((r) => enMarcas(r.marca));
    document.getElementById('busq-sub').textContent = terms.length ? `${fmtInt.format(terms.length)} términos con al menos 2 sesiones` : '';
    tabla(document.getElementById('tabla-busqueda'), {
      id: 'busqueda', defecto: { i: 2, dir: -1 },
      cols: [
        { h: 'Término', txt: true, v: (f) => f.term },
        { h: 'Marca', txt: true, v: (f) => f.marca },
        { h: 'Sesiones', v: (f) => f.sesiones, f: fInt },
        { h: 'Abren producto', v: (f) => div(f.s_clic_producto, f.sesiones), f: (x) => pct(x, 0), cls: (f) => (f.sesiones >= MIN.busqSes && div(f.s_clic_producto, f.sesiones) < 0.3 ? 'bad' : '') },
        { h: 'Conversión', v: (f) => div(f.s_compra, f.sesiones), f: (x) => pct(x, 1) },
        { h: 'Δ sesiones', v: (f) => varRel(f.sesiones, f.sesiones_ant), f: fDelta, cls: (f) => clsDelta(varRel(f.sesiones, f.sesiones_ant)) },
      ],
      filas: terms.sort((x, y) => y.sesiones - x.sesiones).slice(0, 300),
    });
  } catch (e) { console.warn(e); }
}

function renderProfundidad() {
  const p = periodoMeta();
  const filas = state.diario.profundidad.filter((f) => f.fecha >= p.desde && f.fecha <= p.hasta && enMarcas(f.marca) && (!state.dev || f.dev === state.dev) && f.tipo === state.prof);
  const g = agruparPor(filas, 'tramo', ['sesiones', 's_compra']);
  const m = Object.fromEntries(g.map((x) => [x.key, x]));
  const conTipo = TRAMOS.reduce((s, t) => s + (m[t] ? m[t].sesiones : 0), 0);
  const conv = TRAMOS.map((t) => (m[t] ? div(m[t].s_compra, m[t].sesiones) : NaN));
  const share = TRAMOS.map((t) => (m[t] ? m[t].sesiones / (conTipo || 1) : 0));
  const mejor = conv.indexOf(Math.max(...conv.filter(isFinite)));
  document.getElementById('prof-titulo').textContent = `Conversión según ${state.prof} vistas en la sesión`;
  const sin = m['0'] ? m['0'].sesiones : 0;
  document.getElementById('prof-nota').textContent = `Barra = conversión de las sesiones con esa cantidad de ${state.prof} distintas. Debajo, % de esas sesiones en cada tramo. ${fmtInt.format(sin)} sesiones no vieron ninguna ${state.prof} (no se grafican). El canal no aplica a este gráfico.`;
  destruir('prof');
  const o = opcionesBase();
  o.plugins.legend.display = false;
  o.interaction = { mode: 'nearest', intersect: true };
  o.scales.y.ticks.callback = (v) => pct(v, 1);
  o.plugins.tooltip.callbacks = {
    title: (c) => `${TRAMOS[c[0].dataIndex]} ${state.prof} vistas`,
    label: (c) => [`Conversión ${pct(conv[c.dataIndex], 2)}`, `${fmtInt.format(m[TRAMOS[c.dataIndex]]?.sesiones || 0)} sesiones (${pct(share[c.dataIndex])})`],
  };
  state.charts.prof = new Chart(document.getElementById('chart-prof'), {
    type: 'bar',
    data: {
      labels: TRAMOS.map((t, i) => [t, pct(share[i], 0) + ' ses.']),
      datasets: [{ data: conv, backgroundColor: conv.map((_, i) => (i === mejor ? css('--series-3') : css('--series-1'))), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 46 }],
    },
    options: o,
  });
}

/* ---------- CANALES ---------- */
async function renderCanales() {
  const p = periodoMeta();
  const act = agruparPor(filasEmbudo(p.desde, p.hasta, { ignorarCanal: true }), 'canal', CAMPOS_EMBUDO);
  const ant = p.hay_anterior ? Object.fromEntries(agruparPor(filasEmbudo(p.desde_ant, p.hasta_ant, { ignorarCanal: true }), 'canal', CAMPOS_EMBUDO).map((x) => [x.key, x])) : {};
  const tot = sumar(act, CAMPOS_EMBUDO);
  const conv = (x) => div(x.compras, x.sesiones);
  tabla(document.getElementById('tabla-canales'), {
    id: 'canales', defecto: { i: 1, dir: -1 },
    cols: [
      { h: 'Canal', txt: true, v: (f) => f.key },
      { h: 'Sesiones', v: (f) => f.sesiones, f: fInt },
      { h: '% sesiones', v: (f) => div(f.sesiones, tot.sesiones), f: fPct },
      { h: 'Llega a PDP', v: (f) => div(f.s_pdp, f.sesiones), f: fPct },
      { h: 'Llega al carro', v: (f) => div(f.s_carro, f.sesiones), f: fPct },
      { h: 'Conversión', v: conv, f: (x) => pct(x, 2) },
      { h: 'Δ conversión', v: (f) => (ant[f.key] ? conv(f) - conv(ant[f.key]) : NaN), f: (x) => (isFinite(x) ? (x >= 0 ? '+' : '') + (x * 100).toFixed(2).replace('.', ',') + ' pp' : '—'), cls: (f) => (ant[f.key] ? clsDelta(conv(f) - conv(ant[f.key])) : 'prev') },
      { h: 'Ingresos', v: (f) => f.ingresos, f: fMoney },
      { h: '% ingresos', v: (f) => div(f.ingresos, tot.ingresos), f: fPct },
      { h: 'Ingreso / sesión', v: (f) => div(f.ingresos, f.sesiones), f: fMoney },
    ],
    filas: act,
    totales: { key: 'Total', ...tot },
  });

  // Matriz marca × canal
  const filas = filasEmbudo(p.desde, p.hasta, { ignorarCanal: true });
  const canales = act.sort((x, y) => y.sesiones - x.sesiones).map((x) => x.key);
  const marcas = [...new Set(filas.map((f) => f.marca))].sort();
  const celdas = new Map(agruparPor(filas, (f) => f.marca + '|' + f.canal, ['sesiones', 'compras']).map((x) => [x.key, x]));
  const vals = [...celdas.values()].filter((x) => x.sesiones >= 100).map((x) => div(x.compras, x.sesiones));
  const max = Math.max(...vals, 0.0001);
  const seq = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
  const color = (v) => seq[Math.min(seq.length - 1, Math.floor((v / max) * seq.length))];
  document.getElementById('matriz-canal').innerHTML = `<table class="data heatmap"><thead><tr><th>Marca</th>${canales.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${marcas.map((m) => `<tr><td>${esc(m)}</td>${canales.map((c) => {
    const x = celdas.get(m + '|' + c);
    if (!x || x.sesiones < 100) return `<td class="cell empty" title="menos de 100 sesiones">${x ? '·' : ''}</td>`;
    const v = div(x.compras, x.sesiones), bg = color(v), dark = seq.indexOf(bg) >= 3;
    return `<td class="cell" style="background:${bg};color:${dark ? '#fff' : '#0b0b0b'} !important" title="${esc(m)} · ${esc(c)}: ${fmtInt.format(x.sesiones)} sesiones">${pct(v, 2)}</td>`;
  }).join('')}</tr>`).join('')}</tbody></table><p class="legend-note">Más oscuro = convierte más. Celdas con menos de 100 sesiones quedan en gris.</p>`;

  try {
    const pd = await periodoData(state.periodo);
    tabla(document.getElementById('tabla-fuentes'), {
      id: 'fuentes', defecto: { i: 4, dir: -1 },
      cols: [
        { h: 'Fuente', txt: true, v: (f) => f.src },
        { h: 'Medio', txt: true, v: (f) => f.med },
        { h: 'Canal', txt: true, v: (f) => f.canal },
        { h: 'Marca', txt: true, v: (f) => f.marca },
        { h: 'Sesiones', v: (f) => f.sesiones, f: fInt },
        { h: 'Conversión', v: (f) => div(f.compras, f.sesiones), f: (x) => pct(x, 2) },
        { h: 'Ingresos', v: (f) => f.ingresos, f: fMoney },
        { h: 'Δ sesiones', v: (f) => varRel(f.sesiones, f.sesiones_ant), f: fDelta, cls: (f) => clsDelta(varRel(f.sesiones, f.sesiones_ant)) },
      ],
      filas: pd.canales_detalle.filter((r) => enMarcas(r.marca) && (!state.canal || r.canal === state.canal)),
    });
  } catch (e) { console.warn(e); }
}

/* ---------- PÁGINAS Y SECCIONES ---------- */
function ancestros(path) {
  const seg = path.split('/').filter(Boolean);
  return seg.map((_, i) => '/' + seg.slice(0, i + 1).join('/'));
}
function armarArbol(filas) {
  const nodos = new Map();
  const nodo = (path) => {
    if (!nodos.has(path)) nodos.set(path, { path, propio: null, hijos: new Set(), vistasSeccion: 0 });
    return nodos.get(path);
  };
  for (const r of filas) {
    const cadena = r.path === '/' ? ['/'] : ancestros(r.path);
    cadena.forEach((p, i) => {
      const n = nodo(p);
      n.vistasSeccion += r.vistas;
      if (i > 0) nodo(cadena[i - 1]).hijos.add(p);
    });
    nodo(r.path).propio = r;
  }
  const raices = [...nodos.values()].filter((n) => n.path === '/' || n.path.split('/').filter(Boolean).length === 1);
  return { nodos, raices };
}
async function renderPaginas() {
  const sel = document.getElementById('p-marca');
  if (!state.pMarca || !state.meta.marcas.includes(state.pMarca)) {
    state.pMarca = state.marcas.size ? [...state.marcas][0] : state.meta.marcas[0];
  }
  sel.value = state.pMarca;
  let pd;
  try { pd = await periodoData(state.periodo); } catch (e) { return; }
  const filas = pd.paginas.filter((r) => r.marca === state.pMarca && (state.pPDP || r.tipo !== 'PDP'));
  const { nodos, raices } = armarArbol(filas);

  // Espacios para campañas
  const candidatas = filas.filter((r) => r.vistas >= MIN.paginaVistas && !['Carro', 'Checkout', 'Cuenta'].includes(r.tipo));
  // Retener: al menos 25% de las vistas termina en salida; ordena por cantidad de salidas.
  const retener = candidatas.map((r) => ({ r, v: div(r.sig_salida, r.vistas) })).filter((x) => x.v >= 0.25).sort((x, y) => y.r.sig_salida - x.r.sig_salida).slice(0, 7);
  const puente = candidatas.filter((r) => r.tipo !== 'PDP').map((r) => ({ r, v: div(r.sig_pdp + r.sig_carro, r.vistas) })).sort((x, y) => y.r.vistas * y.v - x.r.vistas * x.v).slice(0, 7);
  const lista = (xs, etiqueta) => (xs.length ? `<ul class="mini-list">${xs.map(({ r, v }) => `<li><span class="r" title="${esc(r.path)}">${esc(r.path)} <span class="chip muted">${esc(r.tipo)}</span></span><span class="m">${fmtInt.format(r.vistas)} vistas · ${pct(v, 0)} ${etiqueta}</span></li>`).join('')}</ul>` : '<div class="empty-state">Sin páginas con suficiente tráfico.</div>');
  document.getElementById('espacios-retener').innerHTML = lista(retener, 'se va');
  document.getElementById('espacios-puente').innerHTML = lista(puente, 'pasa a PDP o carro');

  const filasTabla = [];
  const agregar = (n, nivel) => {
    filasTabla.push({ n, nivel });
    if (state.abiertos.has(n.path)) {
      [...n.hijos].map((h) => nodos.get(h)).sort((a, b) => b.vistasSeccion - a.vistasSeccion).forEach((h) => agregar(h, nivel + 1));
    }
  };
  raices.sort((a, b) => b.vistasSeccion - a.vistasSeccion).forEach((n) => agregar(n, 0));

  const nextBar = (r) => {
    if (!r || !r.vistas) return '';
    return `<div class="next-bar" title="${SIGUIENTE.map((s) => `${s.label} ${pct(div(r[s.k], r.vistas), 0)}`).join(' · ')}">${SIGUIENTE.map((s) => `<span style="width:${(div(r[s.k], r.vistas) * 100).toFixed(1)}%;background:${s.color}"></span>`).join('')}</div>`;
  };
  const cont = document.getElementById('tabla-paginas');
  const leyenda = `<div class="next-legend">Hacia dónde va después: ${SIGUIENTE.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('')}</div>`;
  cont.innerHTML = leyenda + (filasTabla.length ? `<table class="data"><thead><tr><th>Ruta</th><th class="txt">Tipo</th><th>Vistas sección</th><th>Vistas página</th><th>Entradas</th><th>Conv. entrada</th><th>Siguen navegando</th><th>Δ vistas</th><th class="txt">Hacia dónde va</th></tr></thead><tbody>${filasTabla.map(({ n, nivel }) => {
    const r = n.propio;
    const dv = r ? varRel(r.vistas, r.vistas_ant) : NaN;
    return `<tr><td class="path-cell" style="padding-left:${10 + nivel * 18}px"><button class="tree-toggle" data-path="${esc(n.path)}" ${n.hijos.size ? '' : 'disabled'} aria-label="Desplegar">${state.abiertos.has(n.path) ? '▾' : '▸'}</button>${r ? `<button class="path-link" data-trans="${esc(n.path)}">${esc(n.path)}</button>` : `<span>${esc(n.path)}</span>`}</td>
      <td class="txt">${r ? esc(r.tipo) : ''}</td><td>${fmtInt.format(n.vistasSeccion)}</td><td>${r ? fmtInt.format(r.vistas) : '—'}</td><td>${r ? fmtInt.format(r.entradas) : '—'}</td>
      <td>${r && r.entradas >= 20 ? pct(div(r.entradas_compra, r.entradas), 2) : '—'}</td><td>${r ? pct(1 - div(r.sig_salida, r.vistas), 0) : '—'}</td>
      <td class="${clsDelta(dv)}">${fDelta(dv)}</td><td class="txt">${nextBar(r)}</td></tr>`;
  }).join('')}</tbody></table>` : '<div class="empty-state">Sin páginas para esta marca.</div>');
  cont.querySelectorAll('.tree-toggle').forEach((b) => b.addEventListener('click', () => {
    const p = b.dataset.path;
    if (state.abiertos.has(p)) state.abiertos.delete(p); else state.abiertos.add(p);
    renderPaginas();
  }));
  cont.querySelectorAll('[data-trans]').forEach((b) => b.addEventListener('click', () => mostrarTransiciones(pd, b.dataset.trans)));
}
function mostrarTransiciones(pd, path) {
  const filas = pd.transiciones.filter((t) => t.marca === state.pMarca && t.path === path).sort((a, b) => b.n - a.n);
  const total = filas.reduce((s, t) => s + t.n, 0);
  document.getElementById('trans-titulo').textContent = `Después de ${path} (${state.pMarca})`;
  document.getElementById('tabla-transiciones').innerHTML = filas.length
    ? `<ul class="mini-list">${filas.map((t) => `<li><span class="r">${esc(t.sig_path)}</span><span class="m">${fmtInt.format(t.n)} · ${pct(t.n / total, 0)}</span></li>`).join('')}</ul><p class="legend-note">Principales destinos (hasta 8) desde esta página; no incluye recargas de la misma página.</p>`
    : '<div class="empty-state">Sin destinos con volumen suficiente.</div>';
  const card = document.getElementById('card-transiciones');
  card.hidden = false;
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------- PRODUCTOS ---------- */
function productosOportunidad(productos) {
  const base = new Map();
  for (const r of productos) {
    const b = base.get(r.marca) || { v: 0, a: 0 };
    b.v += r.vistas; b.a += r.agregados; base.set(r.marca, b);
  }
  return productos.filter((r) => enMarcas(r.marca) && r.vistas >= MIN.vistasProd).map((r) => {
    const b = base.get(r.marca);
    return { ...r, tasa: div(r.agregados, r.vistas), base: div(b.a, b.v) };
  }).filter((r) => r.tasa < r.base * 0.5).sort((x, y) => y.vistas * (y.base - y.tasa) - x.vistas * (x.base - x.tasa));
}
async function renderProductos() {
  let pd;
  try { pd = await periodoData(state.periodo); } catch (e) { return; }
  const ops = productosOportunidad(pd.productos);
  const colsProd = [
    { h: 'Producto', txt: true, v: (f) => f.nombre || f.item_id },
    { h: 'SKU', txt: true, v: (f) => f.item_id },
    { h: 'Marca', txt: true, v: (f) => f.marca },
    { h: 'Vistas', v: (f) => f.vistas, f: fInt },
    { h: 'Agregados', v: (f) => f.agregados, f: fInt },
    { h: '% agrega', v: (f) => div(f.agregados, f.vistas), f: fPct },
    { h: 'Unidades', v: (f) => f.unidades, f: fInt },
    { h: 'Ingresos', v: (f) => f.ingresos, f: fMoney },
    { h: 'Δ vistas', v: (f) => varRel(f.vistas, f.vistas_ant), f: fDelta, cls: (f) => clsDelta(varRel(f.vistas, f.vistas_ant)) },
  ];
  tabla(document.getElementById('tabla-oportunidad-prod'), {
    id: 'prod-ops', defecto: { i: 3, dir: -1 },
    cols: [...colsProd.slice(0, 6), { h: 'Promedio marca', v: (f) => f.base, f: fPct }],
    filas: ops.slice(0, 25),
  });
  tabla(document.getElementById('tabla-productos'), {
    id: 'productos', defecto: { i: 3, dir: -1 },
    cols: colsProd,
    filas: pd.productos.filter((r) => enMarcas(r.marca)),
  });
}

/* ---------- HOY ---------- */
function renderHoy() {
  const h = state.hoy;
  const kp = document.getElementById('kpis-hoy');
  if (!h) { kp.innerHTML = '<div class="empty-state">Todavía no hay datos de hoy.</div>'; return; }
  const hoy = objs(h.hoy).filter((r) => enMarcas(r.marca));
  const ref = objs(h.ref).filter((r) => enMarcas(r.marca));
  const horaAct = new Date(h.actualizado).getHours();
  const horaCompleta = Math.max(0, horaAct - 1);
  const campos = ['sesiones', 's_carro', 's_chk', 'compras', 'ingresos'];
  const hasta = (rs) => sumar(rs.filter((r) => r.hora <= horaCompleta), campos);
  const a = hasta(hoy), b = hasta(ref);
  document.getElementById('hoy-sub').textContent = `hoy ${h.fecha.split('-').reverse().join('/')} vs ${h.referencia.split('-').reverse().join('/')} · actualizado ${h.actualizado.slice(11, 16)}`;
  const conv = (x) => div(x.compras, x.sesiones);
  kp.innerHTML = [
    kpi('Sesiones', fmtInt.format(a.sesiones), deltaTxt(a.sesiones, b.sesiones), `hasta las ${horaCompleta}:59`),
    kpi('Llegan al carro', fmtInt.format(a.s_carro), deltaTxt(a.s_carro, b.s_carro)),
    kpi('Compras', fmtInt.format(a.compras), deltaTxt(a.compras, b.compras)),
    kpi('Conversión', pct(conv(a), 2), deltaTxt(conv(a), conv(b), true)),
    kpi('Ingresos', fmtMoney.format(a.ingresos), deltaTxt(a.ingresos, b.ingresos)),
  ].join('').replaceAll('vs anterior', 'vs semana pasada');

  const horas = [...Array(24).keys()];
  const porHora = (rs) => { const m = new Map(agruparPor(rs, 'hora', ['sesiones']).map((x) => [x.key, x.sesiones])); return horas.map((x) => m.get(x) ?? null); };
  const sHoy = porHora(hoy).map((v, i) => (i <= horaAct ? v ?? 0 : null));
  destruir('hoy');
  const o = opcionesBase();
  o.plugins.tooltip.callbacks = { title: (c) => `${c[0].label}:00`, label: (c) => `${c.dataset.label}: ${fmtInt.format(c.parsed.y)}` };
  state.charts.hoy = new Chart(document.getElementById('chart-hoy'), {
    type: 'line',
    data: { labels: horas.map(String), datasets: [
      { label: 'Hoy', data: sHoy, borderColor: css('--series-1'), backgroundColor: css('--series-1'), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.2 },
      { label: 'Mismo día semana pasada', data: porHora(ref), borderColor: css('--series-other'), backgroundColor: css('--series-other'), borderWidth: 2, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 4, tension: 0.2 },
    ] },
    options: o,
  });

  const pm = (rs) => new Map(agruparPor(rs.filter((r) => r.hora <= horaCompleta), 'marca', campos).map((x) => [x.key, x]));
  const ma = pm(hoy), mb = pm(ref);
  const filas = [...ma.values()].map((x) => ({ ...x, ant: mb.get(x.key) || null }));
  tabla(document.getElementById('tabla-hoy'), {
    id: 'hoy', defecto: { i: 1, dir: -1 },
    cols: [
      { h: 'Marca', txt: true, v: (f) => f.key },
      { h: 'Sesiones', v: (f) => f.sesiones, f: fInt },
      { h: 'Δ sesiones', v: (f) => (f.ant ? varRel(f.sesiones, f.ant.sesiones) : NaN), f: fDelta, cls: (f) => clsDelta(f.ant ? varRel(f.sesiones, f.ant.sesiones) : NaN) },
      { h: 'Carro', v: (f) => f.s_carro, f: fInt },
      { h: 'Compras', v: (f) => f.compras, f: fInt },
      { h: 'Conversión', v: conv, f: (x) => pct(x, 2) },
      { h: 'Ingresos', v: (f) => f.ingresos, f: fMoney },
      { h: 'Δ ingresos', v: (f) => (f.ant ? varRel(f.ingresos, f.ant.ingresos) : NaN), f: fDelta, cls: (f) => clsDelta(f.ant ? varRel(f.ingresos, f.ant.ingresos) : NaN) },
    ],
    filas,
    totales: { key: 'Total', ...a },
  });
}

/* ---------- render general ---------- */
async function render() {
  notaFiltros();
  document.getElementById('filtros').classList.toggle('dim', state.tab === 'hoy');
  const t = state.tab;
  if (t === 'resumen') renderResumen();
  else if (t === 'recorrido') await renderRecorrido();
  else if (t === 'canales') await renderCanales();
  else if (t === 'paginas') await renderPaginas();
  else if (t === 'productos') await renderProductos();
  else if (t === 'hoy') renderHoy();
}

async function init() {
  try {
    state.meta = await getJSON('meta.json');
    const d = await getJSON('diario.json');
    state.diario = { embudo: objs(d.embudo), profundidad: objs(d.profundidad) };
    try { state.hoy = await getJSON('hoy.json'); } catch (e) { state.hoy = null; }
  } catch (e) {
    document.getElementById('actualizado').textContent = 'Todavía no hay datos publicados.';
    document.getElementById('kpis').innerHTML = `<div class="empty-state">No se pudieron cargar los datos (${esc(e.message)}).</div>`;
    return;
  }
  const g = state.meta.generado;
  document.getElementById('actualizado').textContent = `Datos hasta el ${state.meta.hasta.split('-').reverse().join('/')} · Hoy actualizado ${state.meta.hoy_actualizado ? state.meta.hoy_actualizado.slice(11, 16) : '—'} · generado ${g.slice(8, 10)}/${g.slice(5, 7)} ${g.slice(11, 16)}`;
  armarFiltros();
  render();
}
init();
