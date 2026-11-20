/* Dashboard de recorrido del cliente.
   Lee los archivos de data/ (los genera GitHub Actions) y arma todo en el
   navegador. Sin build step: HTML + JS + Chart.js.
   Períodos por semana comercial (domingo a sábado, numeración ISO del lunes
   siguiente: la W01 de 2026 va del 28-dic-2025 al 3-ene-2026).
   Conversión = compras (transacciones) / sesiones, en todo el dashboard. */

const CONFIG = { locale: 'es-CL', currency: 'CLP', semanasDefecto: 4 };
const fmtInt = new Intl.NumberFormat(CONFIG.locale, { maximumFractionDigits: 0 });
const fmtMoney = new Intl.NumberFormat(CONFIG.locale, { style: 'currency', currency: CONFIG.currency, maximumFractionDigits: 0 });
const pct = (x, d = 1) => (isFinite(x) ? (x * 100).toFixed(d).replace('.', ',') + '%' : '—');
const div = (a, b) => (b ? a / b : NaN);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const conv = (x) => div(x.compras, x.sesiones);

// Volúmenes mínimos para que una "oportunidad" cuente (evita alertar por 3 visitas).
const MIN = { sesionesPaso: 500, entradas: 200, sesionesProd: 300, busqSes: 30, paginaVistas: 100 };

const PASOS = [
  { k: 's_plp', label: 'PLP' },
  { k: 's_pdp', label: 'PDP' },
  { k: 's_carro', label: 'Carro' },
  { k: 's_chk', label: 'Checkout' },
];
const SIGUIENTE = [
  { k: 'sig_pdp', label: 'PDP', color: 'var(--series-1)' },
  { k: 'sig_plp', label: 'PLP', color: 'var(--series-3)' },
  { k: 'sig_busq', label: 'Búsqueda', color: 'var(--series-5)' },
  { k: 'sig_carro', label: 'Carro / checkout', color: 'var(--series-4)' },
  { k: 'sig_otra', label: 'Otra', color: 'var(--series-other)' },
  { k: 'sig_salida', label: 'Salida', color: 'var(--series-2)' },
];
// Claves para sumar las tablas semanales (lo demás se suma).
const CLAVES = {
  paginas: [['marca', 'path'], ['tipo']],
  productos: [['marca', 'item_id'], ['nombre']],
  busqueda: [['marca', 'term'], []],
  recorridos: [['marca', 'recorrido'], []],
  transiciones: [['marca', 'path', 'sig_path'], []],
  rebote: [['marca', 'canal', 'campana', 'entrada', 'tipo', 'dev'], []],
};

const state = {
  meta: null, embudo: [], hoy: null, semanas: {}, trans: {}, rebote: {}, rebMetrica: 'rr',
  semDesde: null, semHasta: null, comparar: 'anterior',
  marcas: new Set(), devs: new Set(),
  tab: 'resumen', pMarca: null, pPDP: false, abiertos: new Set(), hoyRef: 'semana',
  charts: {}, sort: {},
};

/* ---------- semanas comerciales ---------- */
const DIA = 86400000;
const aFecha = (iso) => new Date(iso + 'T00:00:00Z');
const aISO = (d) => d.toISOString().slice(0, 10);
function semanaId(d) {
  // Semana que parte el domingo de d; su número es la semana ISO del lunes siguiente.
  const lunes = new Date(d.getTime() - d.getUTCDay() * DIA + DIA);
  const t = new Date(lunes.getTime() + 3 * DIA); // jueves de esa semana ISO
  const y = t.getUTCFullYear();
  const ene4 = new Date(Date.UTC(y, 0, 4));
  const lunes1 = ene4.getTime() - ((ene4.getUTCDay() + 6) % 7) * DIA;
  const w = 1 + Math.round((lunes.getTime() - lunes1) / (7 * DIA));
  return `${y}-W${String(w).padStart(2, '0')}`;
}
function rangoSemana(sid) {
  const y = +sid.slice(0, 4), w = +sid.slice(6);
  const ene4 = new Date(Date.UTC(y, 0, 4));
  const lunes1 = ene4.getTime() - ((ene4.getUTCDay() + 6) % 7) * DIA;
  const dom = new Date(lunes1 + (w - 1) * 7 * DIA - DIA);
  return { desde: aISO(dom), hasta: aISO(new Date(dom.getTime() + 6 * DIA)) };
}
const fCorta = (iso) => `${+iso.slice(8)}/${+iso.slice(5, 7)}`;
const etiquetaSemana = (s) => `W${s.id.slice(6)} ${s.id.slice(0, 4)} · ${fCorta(s.desde)}–${fCorta(s.hasta)}${s.completa ? '' : ` (en curso, ${s.dias} días)`}`;

function idsEntre(desde, hasta) {
  const ids = state.meta.semanas.map((s) => s.id);
  const i = ids.indexOf(desde), j = ids.indexOf(hasta);
  return ids.slice(Math.min(i, j), Math.max(i, j) + 1);
}
// Período actual y de comparación: listas de semanas y fechas exactas.
function periodo() {
  const ids = idsEntre(state.semDesde, state.semHasta);
  const desde = rangoSemana(ids[0]).desde;
  const hasta = [rangoSemana(ids[ids.length - 1]).hasta, state.meta.hasta].sort()[0];
  let comp = null;
  if (state.comparar !== 'ninguna') {
    let cids;
    if (state.comparar === 'anterior') {
      cids = ids.map((_, k) => semanaId(new Date(aFecha(desde).getTime() - (ids.length - k) * 7 * DIA)));
    } else {
      cids = ids.map((id) => `${+id.slice(0, 4) - 1}-W${id.slice(6)}`);
    }
    const disponibles = new Set(state.meta.semanas.map((s) => s.id));
    if (cids.every((c) => disponibles.has(c))) {
      const largo = (aFecha(hasta) - aFecha(desde)) / DIA; // misma cantidad de días que el actual
      const cDesde = rangoSemana(cids[0]).desde;
      comp = { ids: cids, desde: cDesde, hasta: aISO(new Date(aFecha(cDesde).getTime() + largo * DIA)),
        nombre: state.comparar === 'anterior' ? 'período anterior' : 'año pasado' };
    }
  }
  return { ids, desde, hasta, comp };
}

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
async function semana(id) {
  if (!state.semanas[id]) state.semanas[id] = getJSON(`semana/${id}.json`);
  return state.semanas[id];
}
async function transSemana(id) {
  if (!state.trans[id]) state.trans[id] = getJSON(`semana/${id}-trans.json`);
  return state.trans[id];
}
async function reboteSemana(id) {
  if (!state.rebote[id]) state.rebote[id] = getJSON(`semana/${id}-rebote.json`).catch(() => ({ cols: [], rows: [] }));
  return state.rebote[id];
}
// Suma una tabla grande sobre varias semanas.
function sumarTabla(tablas, nombre) {
  const [clave, primeros] = CLAVES[nombre];
  const acc = new Map();
  let sumables = null;
  for (const t of tablas) {
    for (const o of objs(t)) {
      if (!sumables) sumables = Object.keys(o).filter((k) => !clave.includes(k) && !primeros.includes(k));
      const k = clave.map((c) => o[c]).join('\u0001');
      const a = acc.get(k);
      if (!a) acc.set(k, { ...o });
      else for (const c of sumables) a[c] = (a[c] || 0) + (o[c] || 0);
    }
  }
  return [...acc.values()];
}
async function tablaGrande(nombre, ids) {
  const ss = await Promise.all(ids.map((id) => semana(id)));
  return sumarTabla(ss.map((s) => s[nombre]), nombre);
}
// Agrega columnas *_ant con el período de comparación.
async function conComparacion(nombre, filas, comp, metricas) {
  if (!comp) return filas.map((f) => ({ ...f, ...Object.fromEntries(metricas.map((m) => [m + '_ant', null])) }));
  const ant = await tablaGrande(nombre, comp.ids);
  const clave = CLAVES[nombre][0];
  const idx = new Map(ant.map((a) => [clave.map((c) => a[c]).join('\u0001'), a]));
  return filas.map((f) => {
    const a = idx.get(clave.map((c) => f[c]).join('\u0001'));
    return { ...f, ...Object.fromEntries(metricas.map((m) => [m + '_ant', a ? a[m] : 0])) };
  });
}

const enMarcas = (m) => state.marcas.size === 0 || state.marcas.has(m);
function sumar(filas, campos) {
  const o = Object.fromEntries(campos.map((c) => [c, 0]));
  for (const f of filas) for (const c of campos) o[c] += f[c] || 0;
  return o;
}
const CAMPOS_EMBUDO = ['sesiones', 's_home', 's_plp', 's_pdp', 's_busq', 's_carro', 's_chk', 's_compra', 'compras_busq', 'compras', 'ingresos'];
function filasEmbudo(desde, hasta, { ignorarMarca = false } = {}) {
  return state.embudo.filter((f) => f.fecha >= desde && f.fecha <= hasta
    && (ignorarMarca || enMarcas(f.marca))
    && (state.devs.size === 0 || state.devs.has(f.dev)));
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
// mínimo). Así una marca muy grande o con medición distinta (VS) no mueve la vara.
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
// Desplegable con el mismo estilo para todos los filtros (el del filtro
// "Marca" del dashboard de campañas). multi = casillas; si no, una opción.
// Desplegable con el mismo estilo para todos los filtros. multi = casillas
// (conjunto vacío = todas marcadas, que es lo que se ve por defecto); si no,
// una opción. solo = botón "Solamente" al pasar el mouse por una opción.
function desplegable(cont, { opciones, multi, todos, sel, alCambiar, labelId, solo }) {
  cont.innerHTML = `<button type="button" class="multiselect-btn" aria-expanded="false"${labelId ? ` aria-labelledby="${labelId}"` : ''}></button>
    <div class="multiselect-panel" hidden>
      ${multi ? `<button type="button" class="multiselect-clear">Seleccionar ${esc(todos.toLowerCase())}</button>` : ''}
      <div class="multiselect-list">${opciones.map((o) => multi
        ? `<label class="multiselect-option"><input type="checkbox" value="${esc(o.v)}" /> <span class="op-texto">${esc(o.l)}</span>${solo ? `<button type="button" class="solo-btn" data-v="${esc(o.v)}">Solamente</button>` : ''}</label>`
        : `<button type="button" class="multiselect-option opcion-unica" data-v="${esc(o.v)}">${esc(o.l)}</button>`).join('')}</div>
    </div>`;
  const btn = cont.querySelector('.multiselect-btn'), panel = cont.querySelector('.multiselect-panel');
  const nombre = (v) => (opciones.find((o) => o.v === v) || {}).l || v;
  const todosV = opciones.map((o) => o.v);
  const pintar = () => {
    const actual = sel();
    if (multi) {
      btn.textContent = actual.size === 0 ? todos : actual.size === 1 ? nombre([...actual][0]) : `${actual.size} de ${todosV.length}`;
      cont.querySelectorAll('input').forEach((i) => { i.checked = actual.size === 0 || actual.has(i.value); });
    } else {
      btn.textContent = nombre(actual);
      cont.querySelectorAll('.opcion-unica').forEach((b) => b.classList.toggle('is-active', b.dataset.v === actual));
    }
  };
  const cerrar = () => { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', () => {
    const abrir = panel.hidden;
    document.querySelectorAll('.multiselect-panel').forEach((x) => { x.hidden = true; });
    document.querySelectorAll('.multiselect-btn').forEach((x) => x.setAttribute('aria-expanded', 'false'));
    panel.hidden = !abrir; btn.setAttribute('aria-expanded', String(abrir));
  });
  if (multi) {
    cont.querySelector('.multiselect-list').addEventListener('change', (e) => {
      if (!e.target.matches('input')) return;
      const actual = sel();
      if (actual.size === 0) todosV.forEach((v) => actual.add(v)); // "todas" pasa a lista explícita
      if (e.target.checked) actual.add(e.target.value);
      else if (actual.size > 1) actual.delete(e.target.value); // siempre queda al menos una
      if (actual.size === todosV.length) actual.clear();
      pintar(); alCambiar();
    });
    cont.querySelectorAll('.solo-btn').forEach((b) => b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const actual = sel(); actual.clear(); actual.add(b.dataset.v);
      pintar(); alCambiar();
    }));
    cont.querySelector('.multiselect-clear').addEventListener('click', () => { sel().clear(); pintar(); alCambiar(); });
  } else {
    cont.querySelectorAll('.opcion-unica').forEach((b) => b.addEventListener('click', () => { alCambiar(b.dataset.v); pintar(); cerrar(); }));
  }
  pintar();
  return { pintar };
}


const DEV_LABEL = { mobile: 'Móvil', desktop: 'Escritorio', tablet: 'Tablet', smart_tv: 'Smart TV', otro: 'Otro' };
// Qué filtros se ven en cada pestaña (los que no aplican se ocultan).
const PERIODO = ['desde', 'hasta', 'comparar'];
const FILTROS_TAB = {
  resumen: [...PERIODO, 'marca', 'dev'],
  recorrido: [...PERIODO, 'marca', 'dev'],
  canales: [...PERIODO, 'marca', 'dev'],
  paginas: [...PERIODO, 'pmarca', 'pdp'],
  productos: [...PERIODO, 'marca'],
  hoy: ['marca', 'hoyref'],
};

function armarFiltros() {
  const sems = state.meta.semanas;
  const opcSem = sems.map((s) => ({ v: s.id, l: etiquetaSemana(s) })).reverse();
  // Por defecto: las últimas semanas completas (o la última, si no hay completas).
  const completas = sems.filter((s) => s.completa);
  const ultima = (completas.length ? completas : sems)[(completas.length ? completas : sems).length - 1];
  const iUlt = sems.indexOf(ultima);
  state.semHasta = ultima.id;
  state.semDesde = sems[Math.max(0, iUlt - CONFIG.semanasDefecto + 1)].id;
  const ddDesde = desplegable(document.getElementById('dd-desde'), {
    labelId: 'l-desde', multi: false, opciones: opcSem,
    sel: () => state.semDesde,
    alCambiar: (v) => { state.semDesde = v; if (v > state.semHasta) { state.semHasta = v; ddHasta.pintar(); } render(); },
  });
  const ddHasta = desplegable(document.getElementById('dd-hasta'), {
    labelId: 'l-hasta', multi: false, opciones: opcSem,
    sel: () => state.semHasta,
    alCambiar: (v) => { state.semHasta = v; if (v < state.semDesde) { state.semDesde = v; ddDesde.pintar(); } render(); },
  });
  desplegable(document.getElementById('dd-comparar'), {
    labelId: 'l-comparar', multi: false,
    opciones: [{ v: 'anterior', l: 'Período anterior' }, { v: 'anio', l: 'Mismas semanas del año pasado' }, { v: 'ninguna', l: 'Sin comparación' }],
    sel: () => state.comparar, alCambiar: (v) => { state.comparar = v; render(); },
  });
  desplegable(document.getElementById('dd-marca'), {
    labelId: 'l-marca', multi: true, todos: 'Todas', solo: true,
    opciones: state.meta.marcas.map((m) => ({ v: m, l: m })),
    sel: () => state.marcas, alCambiar: () => render(),
  });
  desplegable(document.getElementById('dd-pmarca'), {
    labelId: 'l-pmarca', multi: false,
    opciones: state.meta.marcas.map((m) => ({ v: m, l: m })),
    sel: () => state.pMarca || state.meta.marcas[0], alCambiar: (v) => { state.pMarca = v; state.abiertos.clear(); render(); },
  });
  const devs = [...new Set(state.embudo.map((f) => f.dev))].sort((a, b) => (a === 'mobile' ? -1 : b === 'mobile' ? 1 : a.localeCompare(b)));
  desplegable(document.getElementById('dd-dev'), {
    labelId: 'l-dev', multi: true, todos: 'Todos',
    opciones: devs.map((d) => ({ v: d, l: DEV_LABEL[d] || d })),
    sel: () => state.devs, alCambiar: () => render(),
  });
  desplegable(document.getElementById('dd-hoyref'), {
    labelId: 'l-hoyref', multi: false,
    opciones: [{ v: 'semana', l: 'Mismo día de la semana pasada' }, { v: 'anio', l: 'Mismo día del año pasado' }],
    sel: () => state.hoyRef, alCambiar: (v) => { state.hoyRef = v; render(); },
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.multiselect')) {
      document.querySelectorAll('.multiselect-panel').forEach((x) => { x.hidden = true; });
      document.querySelectorAll('.multiselect-btn').forEach((x) => x.setAttribute('aria-expanded', 'false'));
    }
  });
  document.querySelectorAll('nav.tabs button').forEach((b) => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    document.querySelectorAll('nav.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== 'tab-' + state.tab; });
    render();
  }));
  document.getElementById('p-pdp').addEventListener('change', (e) => { state.pPDP = e.target.checked; render(); });
  document.getElementById('trans-cerrar').addEventListener('click', () => { document.getElementById('card-transiciones').hidden = true; });
}

function notaFiltros(p) {
  const visibles = FILTROS_TAB[state.tab] || [];
  document.querySelectorAll('#filtros [data-f]').forEach((el) => { el.hidden = !visibles.includes(el.dataset.f); });
  const n = [];
  if (state.tab !== 'hoy') {
    n.push(`Período: ${fCorta(p.desde)} al ${fCorta(p.hasta)} (${p.ids.length} ${p.ids.length === 1 ? 'semana' : 'semanas'}).`);
    if (state.comparar !== 'ninguna') n.push(p.comp ? `Comparado con ${p.comp.nombre}: ${fCorta(p.comp.desde)} al ${fCorta(p.comp.hasta)}.` : 'No hay datos cargados para el período de comparación.');
    const parcial = state.meta.semanas.find((s) => p.ids.includes(s.id) && !s.completa);
    if (parcial) n.push(`La semana W${parcial.id.slice(6)} está en curso (${parcial.dias} días).`);
  }
  if (state.tab === 'recorrido' && state.devs.size) n.push('El dispositivo aplica al embudo y a la conversión por día; recorridos y términos de búsqueda se muestran sin ese corte.');
  const conVS = state.tab === 'paginas' ? state.pMarca === 'VS' : (state.marcas.has('VS') || state.marcas.size === 0);
  if (conVS) n.push('Incluye Victoria\'s Secret, cuya medición de sesiones está incompleta.');
  document.getElementById('filtros-nota').textContent = n.join(' ');
}

/* ---------- RESUMEN ---------- */
function kpi(label, valor, d, sub, nombreComp) {
  const delta = d ? `<div class="delta ${d.up ? 'up' : 'down'}">${d.up ? '▲' : '▼'} ${esc(d.txt)} vs ${esc(nombreComp || 'anterior')}</div>` : `<div class="delta prev">${nombreComp ? 'sin datos de comparación' : 'sin comparación'}</div>`;
  return `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${esc(valor)}</div>${delta}${sub ? `<div class="sub2">${esc(sub)}</div>` : ''}</div>`;
}
function renderResumen(p) {
  const a = sumar(filasEmbudo(p.desde, p.hasta), CAMPOS_EMBUDO);
  const b = p.comp ? sumar(filasEmbudo(p.comp.desde, p.comp.hasta), CAMPOS_EMBUDO) : null;
  const nc = p.comp ? p.comp.nombre : (state.comparar === 'ninguna' ? null : 'comparación');
  document.getElementById('kpis').innerHTML = [
    kpi('Sesiones', fmtInt.format(a.sesiones), b && deltaTxt(a.sesiones, b.sesiones), null, nc),
    kpi('Conversión', pct(conv(a), 2), b && deltaTxt(conv(a), conv(b), true), 'compras / sesiones', nc),
    kpi('Ingresos', fmtMoney.format(a.ingresos), b && deltaTxt(a.ingresos, b.ingresos), null, nc),
    kpi('Ticket promedio', fMoney(div(a.ingresos, a.compras)), b && deltaTxt(div(a.ingresos, a.compras), div(b.ingresos, b.compras)), null, nc),
    kpi('Ingreso por sesión', fMoney(div(a.ingresos, a.sesiones)), b && deltaTxt(div(a.ingresos, a.sesiones), div(b.ingresos, b.sesiones)), null, nc),
  ].join('');

  // Embudo por marca: % de sesiones que llega a cada paso, y conversión.
  const porMarca = agruparPor(filasEmbudo(p.desde, p.hasta), 'marca', CAMPOS_EMBUDO);
  const ref = Object.fromEntries([...PASOS.map((s) => [s.k, medianaMarcas(porMarca, s.k, 'sesiones')]), ['conv', medianaMarcas(porMarca, 'compras', 'sesiones')]]);
  const colorear = (v, m, ses) => (!isFinite(v) || !isFinite(m) || ses < 200 ? '' : v >= m * 1.1 ? 'good' : v <= m * 0.9 ? 'bad' : '');
  tabla(document.getElementById('tabla-embudo-marca'), {
    id: 'embudo-marca', defecto: { i: 1, dir: -1 },
    cols: [
      { h: 'Marca', txt: true, v: (f) => f.key },
      { h: 'Sesiones', v: (f) => f.sesiones, f: fInt },
      ...PASOS.map((s) => ({ h: s.label, v: (f) => div(f[s.k], f.sesiones), f: (x) => pct(x, 1), cls: (f) => colorear(div(f[s.k], f.sesiones), ref[s.k], f.sesiones) })),
      { h: 'Conversión', v: conv, f: (x) => pct(x, 2), cls: (f) => colorear(conv(f), ref.conv, f.sesiones) },
      { h: 'Ingresos', v: (f) => f.ingresos, f: fMoney },
    ],
    filas: porMarca,
    totales: { key: 'Total', ...a },
  });
  renderMatrizCanal(p);
  renderOportunidades(p, porMarca);
}

// Marca × canal: cada fila (marca) tiene su propia escala de color.
function renderMatrizCanal(p) {
  const filas = filasEmbudo(p.desde, p.hasta);
  const canales = agruparPor(filas, 'canal', ['sesiones']).sort((x, y) => y.sesiones - x.sesiones).map((x) => x.key);
  const marcas = [...new Set(filas.map((f) => f.marca))].sort();
  const celdas = new Map(agruparPor(filas, (f) => f.marca + '|' + f.canal, ['sesiones', 'compras']).map((x) => [x.key, x]));
  const seq = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
  const html = marcas.map((m) => {
    const vals = canales.map((c) => { const x = celdas.get(m + '|' + c); return x && x.sesiones >= 100 ? conv(x) : NaN; });
    const ok = vals.filter(isFinite), max = Math.max(...ok, 0), min = Math.min(...ok, 0);
    return `<tr><td>${esc(m)}</td>${canales.map((c, i) => {
      const x = celdas.get(m + '|' + c), v = vals[i];
      if (!isFinite(v)) return `<td class="cell empty" title="menos de 100 sesiones">${x ? '·' : ''}</td>`;
      const k = max > min ? Math.min(seq.length - 1, Math.floor(((v - min) / (max - min)) * seq.length)) : 3;
      return `<td class="cell" style="background:${seq[k]};color:${k >= 3 ? '#fff' : '#0b0b0b'} !important" title="${esc(m)} · ${esc(c)}: ${fmtInt.format(x.sesiones)} sesiones, ${fmtInt.format(x.compras)} compras">${pct(v, 2)}</td>`;
    }).join('')}</tr>`;
  }).join('');
  document.getElementById('matriz-canal').innerHTML = `<table class="data heatmap"><thead><tr><th>Marca</th>${canales.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${html}</tbody></table>
    <p class="legend-note">Conversión (compras / sesiones). Cada marca tiene su propia escala: lo más oscuro de una fila es el canal que más convierte en esa marca. Celdas con menos de 100 sesiones quedan en gris.</p>`;
}

async function renderOportunidades(p, porMarca) {
  const ops = [];
  const pasos = [['s_plp', 'sesiones', 'PLP', 'las sesiones'], ['s_carro', 's_pdp', 'Carro', 'las sesiones que llegan a PDP'], ['s_chk', 's_carro', 'Checkout', 'las sesiones que llegan al carro']];
  for (const [k, prevK, label, nombrePrev] of pasos) {
    const ref = medianaMarcas(porMarca, k, prevK, MIN.sesionesPaso);
    for (const f of porMarca) {
      if (f[prevK] < MIN.sesionesPaso) continue;
      const v = div(f[k], f[prevK]);
      if (v < ref * 0.75) ops.push({ peso: f[prevK] * (ref - v), alta: v < ref * 0.5, tag: 'Embudo',
        t: `${f.key}: solo ${pct(v)} de ${nombrePrev} llega a ${label}`,
        d: `marca típica (mediana) ${pct(ref)} · ${fmtInt.format(f[prevK])} sesiones en el paso anterior` });
    }
  }
  const refConv = medianaMarcas(porMarca, 'compras', 'sesiones', MIN.sesionesPaso);
  for (const f of porMarca) {
    if (f.sesiones >= MIN.sesionesPaso && conv(f) < refConv * 0.6) ops.push({ peso: f.sesiones * (refConv - conv(f)), tag: 'Conversión',
      t: `${f.key}: convierte ${pct(conv(f), 2)}`, d: `marca típica (mediana) ${pct(refConv, 2)}` });
  }
  try {
    const [paginas, productos, busqueda] = await Promise.all(['paginas', 'productos', 'busqueda'].map((n) => tablaGrande(n, p.ids)));
    const base = new Map();
    for (const r of paginas) { const c = base.get(r.marca) || { e: 0, c: 0 }; c.e += r.entradas; c.c += r.entradas_compras; base.set(r.marca, c); }
    for (const r of paginas) {
      if (!enMarcas(r.marca) || r.entradas < MIN.entradas || ['Otra', 'Cuenta', 'Carro', 'Checkout'].includes(r.tipo)) continue;
      const m = base.get(r.marca), b = div(m.c, m.e), v = div(r.entradas_compras, r.entradas);
      if (v < b * 0.4) ops.push({ peso: r.entradas * (b - v), tag: 'Página de entrada',
        t: `${r.marca} ${r.path}: ${fmtInt.format(r.entradas)} entradas, convierte ${pct(v, 2)}`,
        d: `la marca convierte ${pct(b, 2)} en sus páginas de entrada` });
    }
    for (const o of productosBajaConversion(productos).slice(0, 5)) {
      ops.push({ peso: o.sesiones * (o.base - o.conv), tag: 'Producto',
        t: `${o.marca}: ${o.nombre || o.item_id} — ${fmtInt.format(o.sesiones)} sesiones lo vieron, convierte ${pct(o.conv, 2)}`,
        d: `productos de la marca convierten ${pct(o.base, 2)}` });
    }
    for (const r of busqueda) {
      if (!enMarcas(r.marca) || r.sesiones < MIN.busqSes) continue;
      const v = div(r.s_clic_producto, r.sesiones);
      if (v < 0.3) ops.push({ peso: r.sesiones * (0.5 - v), tag: 'Buscador',
        t: `${r.marca}: "${r.term}" — ${fmtInt.format(r.sesiones)} sesiones, solo ${pct(v, 0)} abre un producto`,
        d: 'posible búsqueda sin resultados relevantes' });
    }
  } catch (e) { console.warn(e); }
  ops.sort((x, y) => y.peso - x.peso);
  document.getElementById('oportunidades').innerHTML = ops.length
    ? ops.slice(0, 10).map((o) => `<div class="opp${o.alta ? ' alta' : ''}"><div class="t"><span class="tag">${esc(o.tag)}</span>${esc(o.t)}</div><div class="d">${esc(o.d)}</div></div>`).join('')
    : '<div class="empty-state">Sin oportunidades que superen los volúmenes mínimos.</div>';
}

/* ---------- RECORRIDO ---------- */
async function renderRecorrido(p) {
  const a = sumar(filasEmbudo(p.desde, p.hasta), CAMPOS_EMBUDO);
  const pasos = [{ k: 'sesiones', label: 'Sesiones' }, ...PASOS];
  document.getElementById('embudo-sub').textContent = '% del total de sesiones · relación con el paso anterior';
  document.getElementById('embudo-barras').innerHTML = pasos.map((s, i) => {
    const v = div(a[s.k], a.sesiones);
    const rel = i > 0 ? div(a[s.k], a[pasos[i - 1].k]) : null;
    return `<div class="fbar"><div class="lab">${esc(s.label)}</div><div class="track"><div class="fill" style="width:${Math.max(0, Math.min(100, v * 100))}%"></div></div>
      <div class="num">${fmtInt.format(a[s.k])} · ${pct(v, 1)}${rel != null ? `<small>${pct(rel)} del paso anterior</small>` : ''}</div></div>`;
  }).join('') + `<div class="fbar"><div class="lab">Compras</div><div class="track"><div class="fill fin" style="width:${Math.max(0.3, Math.min(100, conv(a) * 100))}%"></div></div>
      <div class="num">${fmtInt.format(a.compras)} · ${pct(conv(a), 2)}<small>conversión (compras / sesiones)</small></div></div>`
    + '<p class="legend-note">Una sesión puede llegar a PDP sin pasar por PLP (entrando directo a un producto); por eso los pasos se miden sobre el total de sesiones.</p>';

  const dias = agruparPor(filasEmbudo(p.desde, p.hasta), 'fecha', ['sesiones', 'compras']).sort((x, y) => x.key.localeCompare(y.key));
  destruir('conv');
  const o = opcionesBase();
  o.plugins.legend.display = false;
  o.scales.y.ticks.callback = (v) => pct(v, 1);
  o.plugins.tooltip.callbacks = { label: (c) => `Conversión ${pct(c.parsed.y, 2)} · ${fmtInt.format(dias[c.dataIndex].compras)} compras / ${fmtInt.format(dias[c.dataIndex].sesiones)} sesiones` };
  state.charts.conv = new Chart(document.getElementById('chart-conv-dia'), {
    type: 'line',
    data: { labels: dias.map((d) => fCorta(d.key)), datasets: [{ data: dias.map(conv), borderColor: css('--series-1'), backgroundColor: css('--series-1'), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.2 }] },
    options: o,
  });

  const sinBusq = { sesiones: a.sesiones - a.s_busq, compras: a.compras - a.compras_busq };
  document.getElementById('kpis-busqueda').innerHTML = [
    `<div class="kpi"><div class="label">Usan el buscador</div><div class="value">${pct(div(a.s_busq, a.sesiones))}</div><div class="sub2">${fmtInt.format(a.s_busq)} sesiones</div></div>`,
    `<div class="kpi"><div class="label">Conversión con búsqueda</div><div class="value">${pct(div(a.compras_busq, a.s_busq), 2)}</div></div>`,
    `<div class="kpi"><div class="label">Conversión sin búsqueda</div><div class="value">${pct(conv(sinBusq), 2)}</div></div>`,
  ].join('');

  try {
    let recs = (await tablaGrande('recorridos', p.ids)).filter((r) => enMarcas(r.marca));
    recs = agruparPor(recs, 'recorrido', ['sesiones', 'compras', 'ingresos']);
    let recsAnt = null;
    if (p.comp) recsAnt = new Map(agruparPor((await tablaGrande('recorridos', p.comp.ids)).filter((r) => enMarcas(r.marca)), 'recorrido', ['sesiones']).map((x) => [x.key, x.sesiones]));
    const totalSes = a.sesiones || 1;
    recs.sort((x, y) => y.sesiones - x.sesiones);
    tabla(document.getElementById('tabla-recorridos'), {
      id: 'recorridos', defecto: { i: 1, dir: -1 },
      cols: [
        { h: 'Recorrido', txt: true, v: (f) => f.key, html: (f) => chipsRecorrido(f.key) },
        { h: 'Sesiones', v: (f) => f.sesiones, f: fInt },
        { h: '% sesiones', v: (f) => f.sesiones / totalSes, f: fPct },
        { h: 'Compras', v: (f) => f.compras, f: fInt },
        { h: 'Conversión', v: conv, f: (x) => pct(x, 2) },
        { h: 'Ingresos', v: (f) => f.ingresos, f: fMoney },
        { h: 'Δ sesiones', v: (f) => (recsAnt ? varRel(f.sesiones, recsAnt.get(f.key) || 0) : NaN), f: fDelta, cls: (f) => clsDelta(recsAnt ? varRel(f.sesiones, recsAnt.get(f.key) || 0) : NaN) },
      ],
      filas: recs.slice(0, 60),
    });
    let terms = (await tablaGrande('busqueda', p.ids)).filter((r) => enMarcas(r.marca));
    terms = await conComparacion('busqueda', terms, p.comp, ['sesiones']);
    document.getElementById('busq-sub').textContent = terms.length ? `${fmtInt.format(terms.length)} términos` : '';
    tabla(document.getElementById('tabla-busqueda'), {
      id: 'busqueda', defecto: { i: 2, dir: -1 },
      cols: [
        { h: 'Término', txt: true, v: (f) => f.term },
        { h: 'Marca', txt: true, v: (f) => f.marca },
        { h: 'Sesiones', v: (f) => f.sesiones, f: fInt },
        { h: 'Abren producto', v: (f) => div(f.s_clic_producto, f.sesiones), f: (x) => pct(x, 0), cls: (f) => (f.sesiones >= MIN.busqSes && div(f.s_clic_producto, f.sesiones) < 0.3 ? 'bad' : '') },
        { h: 'Conversión', v: conv, f: (x) => pct(x, 1) },
        { h: 'Δ sesiones', v: (f) => varRel(f.sesiones, f.sesiones_ant), f: fDelta, cls: (f) => clsDelta(varRel(f.sesiones, f.sesiones_ant)) },
      ],
      filas: terms.sort((x, y) => y.sesiones - x.sesiones).slice(0, 300),
    });
  } catch (e) { console.warn(e); }
}

// Recorrido como pasos: "Home | PLP+PDP*3 | Carro" (o el formato antiguo "Home > PLP").
function chipsRecorrido(txt) {
  const pasos = txt.includes(' | ') || txt.includes('*') ? txt.split(' | ') : txt.split(' > ');
  return `<span class="rec">${pasos.map((p) => {
    if (p === '…') return '<span class="rec-mas" title="el recorrido sigue">…</span>';
    const [et, n] = p.split('*');
    const nombre = et.split('+').map(esc).join(' <span class="rec-sep-in">›</span> ');
    return `<span class="rec-paso${et.includes('+') ? ' par' : ''}">${nombre}${n ? `<b class="rec-n">× ${esc(n)}</b>` : ''}</span>`;
  }).join('<span class="rec-sep" aria-hidden="true">›</span>')}</span>`;
}

/* ---------- CANALES ---------- */
function renderCanales(p) {
  const act = agruparPor(filasEmbudo(p.desde, p.hasta), 'canal', CAMPOS_EMBUDO);
  const ant = p.comp ? Object.fromEntries(agruparPor(filasEmbudo(p.comp.desde, p.comp.hasta), 'canal', CAMPOS_EMBUDO).map((x) => [x.key, x])) : {};
  const tot = sumar(act, CAMPOS_EMBUDO);
  const dConv = (f) => (ant[f.key] ? conv(f) - conv(ant[f.key]) : NaN);
  tabla(document.getElementById('tabla-canales'), {
    id: 'canales', defecto: { i: 1, dir: -1 },
    cols: [
      { h: 'Canal', txt: true, v: (f) => f.key },
      { h: 'Sesiones', v: (f) => f.sesiones, f: fInt },
      { h: '% sesiones', v: (f) => div(f.sesiones, tot.sesiones), f: fPct },
      { h: 'Δ sesiones', v: (f) => (ant[f.key] ? varRel(f.sesiones, ant[f.key].sesiones) : NaN), f: fDelta, cls: (f) => clsDelta(ant[f.key] ? varRel(f.sesiones, ant[f.key].sesiones) : NaN) },
      { h: 'Llega a PDP', v: (f) => div(f.s_pdp, f.sesiones), f: fPct },
      { h: 'Llega al carro', v: (f) => div(f.s_carro, f.sesiones), f: fPct },
      { h: 'Conversión', v: conv, f: (x) => pct(x, 2) },
      { h: 'Δ conversión', v: dConv, f: (x) => (isFinite(x) ? (x >= 0 ? '+' : '') + (x * 100).toFixed(2).replace('.', ',') + ' pp' : '—'), cls: (f) => clsDelta(dConv(f)) },
      { h: 'Ingresos', v: (f) => f.ingresos, f: fMoney },
      { h: '% ingresos', v: (f) => div(f.ingresos, tot.ingresos), f: fPct },
      { h: 'Ingreso / sesión', v: (f) => div(f.ingresos, f.sesiones), f: fMoney },
    ],
    filas: act,
    totales: { key: 'Total', ...tot },
  });
  renderRebote(p);
}

/* ---------- REBOTE POR ORIGEN (en validación, próxima versión) ----------
   Reglas de la columna "Lectura" (se aplica la primera que se cumpla), con
   rebote rápido y comparando siempre dentro de la misma marca y período:
   1. Desajuste anuncio-página: la campaña en esa página rebota >= 15 pts
      más que la misma página desde otros orígenes.
   2. Revisar audiencia: la campaña rebota >= 15 pts sobre la mediana de las
      campañas de su canal, y pasa en la mayoría de sus páginas.
   3. Revisar página: la página rebota >= 15 pts sobre la mediana de su tipo.
   4. Carro vacío al llegar: entra al carro y rebota (total) más de 40%.
   Volumen mínimo: 300 sesiones en la fila y 200 en el grupo de comparación. */
const REB = { minFila: 300, minRef: 200, minPagCamp: 50, puntos: 0.15, carro: 0.40, filasTabla: 200 };
const TIPOS_REB = ['Home', 'PLP', 'PDP', 'Búsqueda', 'Carro', 'Otra'];
const CAMPOS_REB = ['sesiones', 'rebotes', 'rebotes_rapidos', 'compras', 'ingresos'];
const rr = (x) => div(x.rebotes_rapidos, x.sesiones);
const rt = (x) => div(x.rebotes, x.sesiones);
const SIN_NOMBRE = (c) => c.startsWith('(');
function mediana(xs) {
  xs = xs.filter(isFinite).sort((a, b) => a - b);
  if (!xs.length) return NaN;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}
const pts = (x) => (x >= 0 ? '+' : '') + Math.round(x * 100) + ' pts';

async function renderRebote(p) {
  let filas;
  try {
    const ts = await Promise.all(p.ids.map((id) => reboteSemana(id)));
    filas = sumarTabla(ts, 'rebote').filter((f) => enMarcas(f.marca) && (state.devs.size === 0 || state.devs.has(f.dev)));
  } catch (e) { console.warn(e); filas = []; }
  const vacio = '<div class="empty-state">Sin datos de rebote para este período (se calcula desde la próxima actualización).</div>';
  if (!filas.length) {
    ['matriz-rebote', 'tabla-campanas', 'oportunidades-rebote'].forEach((id) => { document.getElementById(id).innerHTML = vacio; });
    return;
  }

  // 1) Matriz canal x tipo de página de entrada
  const met = state.rebMetrica === 'rr' ? rr : rt;
  const canales = agruparPor(filas, 'canal', ['sesiones']).sort((a, b) => b.sesiones - a.sesiones).map((x) => x.key);
  const celdas = new Map(agruparPor(filas, (f) => f.canal + '|' + f.tipo, CAMPOS_REB).map((x) => [x.key, x]));
  const [lo, hi] = state.rebMetrica === 'rr' ? [0.08, 0.62] : [0.25, 0.8];
  const fondo = (v) => `rgba(217, 89, 38, ${(0.08 + Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * 0.72).toFixed(2)})`;
  document.getElementById('matriz-rebote').innerHTML = `<table class="data heatmap"><thead><tr><th>Canal</th>${TIPOS_REB.map((t) => `<th>${esc(t)}</th>`).join('')}</tr></thead><tbody>${canales.map((c) => `<tr><td>${esc(c)}</td>${TIPOS_REB.map((t) => {
    const x = celdas.get(c + '|' + t);
    if (!x || x.sesiones < 100) return `<td class="cell empty" title="menos de 100 sesiones">${x ? '·' : ''}</td>`;
    return `<td class="cell" style="background:${fondo(met(x))}" title="${esc(c)} → ${esc(t)}: ${fmtInt.format(x.sesiones)} sesiones · rebote ${pct(rt(x), 0)} · rebote rápido ${pct(rr(x), 0)} · conv. ${pct(conv(x), 2)}">${pct(met(x), 0)}<small>${fmtInt.format(x.sesiones)}</small></td>`;
  }).join('')}</tr>`).join('')}</tbody></table>
    <p class="legend-note">Celdas con menos de 100 sesiones quedan en gris. "Otra" incluye páginas informativas y de servicio.</p>`;
  document.querySelectorAll('#seg-rebote button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.m === state.rebMetrica));
    b.onclick = () => { state.rebMetrica = b.dataset.m; renderRebote(p); };
  });

  // 2) Campaña x página de entrada (sin dispositivo), con sus referencias
  const k = (f, ...c) => c.map((x) => f[x]).join('\u0001');
  const filasCE = agruparPor(filas.filter((f) => f.entrada !== '(otras)'), (f) => k(f, 'marca', 'canal', 'campana', 'entrada', 'tipo'), CAMPOS_REB)
    .map((x) => { const [marca, canal, campana, entrada, tipo] = x.key.split('\u0001'); return { ...x, marca, canal, campana, entrada, tipo }; });
  const porPagina = new Map(agruparPor(filasCE, (f) => k(f, 'marca', 'entrada'), CAMPOS_REB).map((x) => [x.key, x]));
  const porCamp = agruparPor(filasCE, (f) => k(f, 'marca', 'canal', 'campana'), CAMPOS_REB);
  const campIdx = new Map(porCamp.map((x) => [x.key, x]));
  // mediana de campañas por marca y canal (solo campañas con nombre y volumen)
  const medCanal = new Map();
  for (const c of porCamp) {
    const [marca, canal, campana] = c.key.split('\u0001');
    if (SIN_NOMBRE(campana) || c.sesiones < REB.minFila) continue;
    const kk = marca + '\u0001' + canal;
    if (!medCanal.has(kk)) medCanal.set(kk, []);
    medCanal.get(kk).push(rr(c));
  }
  for (const [kk, xs] of medCanal) medCanal.set(kk, xs.length >= 3 ? mediana(xs) : NaN);
  // mediana de páginas por marca y tipo
  const tipoPag = new Map(filasCE.map((f) => [k(f, 'marca', 'entrada'), f.tipo]));
  const medTipo = new Map();
  for (const [kk, x] of porPagina) {
    if (x.sesiones < REB.minFila) continue;
    const kt = kk.split('\u0001')[0] + '\u0001' + tipoPag.get(kk);
    if (!medTipo.has(kt)) medTipo.set(kt, []);
    medTipo.get(kt).push(rr(x));
  }
  for (const [kk, xs] of medTipo) medTipo.set(kk, xs.length >= 3 ? mediana(xs) : NaN);
  // páginas de cada campaña, para ver si el rebote alto se repite
  const paginasCamp = new Map();
  for (const f of filasCE) {
    if (f.sesiones < REB.minPagCamp) continue;
    const kc = k(f, 'marca', 'canal', 'campana');
    if (!paginasCamp.has(kc)) paginasCamp.set(kc, []);
    paginasCamp.get(kc).push(f);
  }

  const leer = (f) => {
    if (f.sesiones < REB.minFila) return null;
    const pag = porPagina.get(k(f, 'marca', 'entrada'));
    const otros = { sesiones: pag.sesiones - f.sesiones, rebotes_rapidos: pag.rebotes_rapidos - f.rebotes_rapidos };
    if (otros.sesiones >= REB.minRef && rr(f) - rr(otros) >= REB.puntos) {
      return { n: 1, chip: 'bad', t: 'Desajuste anuncio-página', ref: rr(otros),
        d: `rebote rápido ${pct(rr(f), 0)} vs ${pct(rr(otros), 0)} de la misma página desde otros orígenes (${pts(rr(f) - rr(otros))})` };
    }
    const kc = k(f, 'marca', 'canal', 'campana');
    const mc = medCanal.get(f.marca + '\u0001' + f.canal);
    const camp = campIdx.get(kc);
    if (!SIN_NOMBRE(f.campana) && isFinite(mc) && camp.sesiones >= REB.minFila && rr(camp) - mc >= REB.puntos) {
      const pags = paginasCamp.get(kc) || [];
      const altas = pags.filter((x) => rr(x) - mc >= REB.puntos).length;
      if (pags.length && altas > pags.length / 2) {
        return { n: 2, chip: 'warn', t: 'Revisar audiencia', ref: mc,
          d: `la campaña rebota ${pct(rr(camp), 0)} (rápido) vs ${pct(mc, 0)} de la campaña típica de ${f.canal}; alto en ${altas} de ${pags.length} páginas` };
      }
    }
    const mt = medTipo.get(f.marca + '\u0001' + f.tipo);
    if (pag.sesiones >= REB.minFila && isFinite(mt) && rr(pag) - mt >= REB.puntos) {
      return { n: 3, chip: 'warn', t: 'Revisar página', ref: mt,
        d: `la página rebota ${pct(rr(pag), 0)} (rápido) desde todos los orígenes vs ${pct(mt, 0)} de las páginas ${f.tipo} típicas de la marca` };
    }
    if (f.tipo === 'Carro' && rt(f) > REB.carro) {
      return { n: 4, chip: 'warn', t: 'Carro vacío al llegar', ref: REB.carro,
        d: `${pct(rt(f), 0)} entra al carro y se va sin ver otra página; revisar si el link llega con los productos` };
    }
    return { n: 5, chip: 'good', t: 'Dentro de lo normal', d: 'ninguna regla se cumple' };
  };
  const varias = new Set(filasCE.map((f) => f.marca)).size > 1;
  const lista = filasCE.map((f) => ({ ...f, lect: leer(f) })).sort((a, b) => b.rebotes - a.rebotes).slice(0, REB.filasTabla);
  tabla(document.getElementById('tabla-campanas'), {
    id: 'campanas', defecto: { i: 6, dir: -1 },
    cols: [
      { h: 'Canal', txt: true, v: (f) => f.canal },
      { h: 'Campaña › aterrizaje', txt: true, v: (f) => f.campana, cls: () => 'camp-cell',
        html: (f) => `<span class="camp">${varias ? `<span class="mk">${esc(f.marca)} · </span>` : ''}${esc(f.campana)}</span><span class="land" title="${esc(f.entrada)}">${esc(f.entrada)} · ${esc(f.tipo)}</span>` },
      { h: 'Sesiones', v: (f) => f.sesiones, f: fInt },
      { h: 'Rebote', v: rt, f: (x) => pct(x, 0) },
      { h: 'Rebote rápido', v: rr, f: (x) => pct(x, 0) },
      { h: 'Conv.', v: conv, f: (x) => pct(x, 2) },
      { h: 'Sesiones perdidas', v: (f) => f.rebotes, f: fInt },
      { h: 'Lectura', txt: true, v: (f) => (f.lect ? f.lect.n : 9),
        html: (f) => (f.lect ? `<span class="chip ${f.lect.chip}" title="${esc(f.lect.d)}">${esc(f.lect.t)}</span>` : '<span class="chip muted" title="menos de 300 sesiones">Poco volumen</span>') },
    ],
    filas: lista,
  });

  // 3) Oportunidades: filas con regla 1 a 4, por sesiones perdidas "de más"
  const ops = filasCE.map((f) => ({ f, l: leer(f) })).filter((x) => x.l && x.l.n <= 4)
    .map((x) => ({ ...x, peso: x.l.n === 4 ? x.f.rebotes : x.f.sesiones * Math.max(0, rr(x.f) - x.l.ref) }))
    .sort((a, b) => b.peso - a.peso).slice(0, 8);
  document.getElementById('oportunidades-rebote').innerHTML = ops.length
    ? ops.map(({ f, l }) => `<div class="opp${l.n === 1 ? ' alta' : ''}"><div class="t"><span class="tag">${esc(l.t)}</span>${esc(f.marca)} · ${esc(f.canal)} · ${esc(f.campana)} → ${esc(f.entrada)}</div><div class="d">${esc(l.d)} · ${fmtInt.format(f.sesiones)} sesiones</div></div>`).join('')
    : '<div class="empty-state">Sin oportunidades que superen los volúmenes mínimos.</div>';
}

/* ---------- PÁGINAS Y SECCIONES ---------- */
function ancestros(path) {
  const seg = path.split('/').filter(Boolean);
  return seg.map((_, i) => '/' + seg.slice(0, i + 1).join('/'));
}
function armarArbol(filas) {
  const nodos = new Map();
  const nodo = (path) => {
    if (!nodos.has(path)) nodos.set(path, { path, propio: null, hijos: new Set(), peso: 0 });
    return nodos.get(path);
  };
  for (const r of filas) {
    const cadena = r.path === '/' ? ['/'] : ancestros(r.path);
    cadena.forEach((p, i) => {
      const n = nodo(p);
      n.peso += r.vistas; // solo para ordenar: la sección con más tráfico va primero
      if (i > 0) nodo(cadena[i - 1]).hijos.add(p);
    });
    nodo(r.path).propio = r;
  }
  const raices = [...nodos.values()].filter((n) => n.path === '/' || n.path.split('/').filter(Boolean).length === 1);
  return { nodos, raices };
}
function productosBajaConversion(productos, soloMarca) {
  const base = new Map();
  for (const r of productos) { const b = base.get(r.marca) || { s: 0, c: 0 }; b.s += r.sesiones; b.c += r.compras; base.set(r.marca, b); }
  return productos.filter((r) => (soloMarca ? r.marca === soloMarca : enMarcas(r.marca)) && r.sesiones >= MIN.sesionesProd).map((r) => {
    const b = base.get(r.marca);
    return { ...r, conv: conv(r), base: div(b.c, b.s) };
  }).filter((r) => r.conv < r.base * 0.5).sort((x, y) => y.sesiones * (y.base - y.conv) - x.sesiones * (x.base - x.conv));
}
async function renderPaginas(p) {
  if (!state.pMarca || !state.meta.marcas.includes(state.pMarca)) state.pMarca = state.meta.marcas[0];
  let paginas, productos;
  try { [paginas, productos] = await Promise.all([tablaGrande('paginas', p.ids), tablaGrande('productos', p.ids)]); } catch (e) { console.warn(e); return; }
  paginas = await conComparacion('paginas', paginas.filter((r) => r.marca === state.pMarca), p.comp, ['vistas']);
  const filas = paginas.filter((r) => state.pPDP || r.tipo !== 'PDP');
  const { nodos, raices } = armarArbol(filas);

  const candidatas = filas.filter((r) => r.vistas >= MIN.paginaVistas && !['Carro', 'Checkout', 'Cuenta'].includes(r.tipo));
  // Retener: al menos 25% de las vistas termina en salida; ordena por cantidad de salidas.
  const retener = candidatas.map((r) => ({ r, v: div(r.sig_salida, r.vistas) })).filter((x) => x.v >= 0.25).sort((x, y) => y.r.sig_salida - x.r.sig_salida).slice(0, 7);
  document.getElementById('espacios-retener').innerHTML = retener.length
    ? `<ul class="mini-list">${retener.map(({ r, v }) => `<li><span class="r" title="${esc(r.path)}">${esc(r.path)} <span class="chip muted">${esc(r.tipo)}</span></span><span class="m">${fmtInt.format(r.vistas)} vistas · ${pct(v, 0)} se va</span></li>`).join('')}</ul>`
    : '<div class="empty-state">Sin páginas con suficiente tráfico.</div>';
  const bajos = productosBajaConversion(productos, state.pMarca).slice(0, 7);
  document.getElementById('productos-baja').innerHTML = bajos.length
    ? `<ul class="mini-list">${bajos.map((r) => `<li><span class="r" title="${esc(r.item_id)}">${esc(r.nombre || r.item_id)}</span><span class="m">${fmtInt.format(r.sesiones)} sesiones · convierte ${pct(r.conv, 2)}</span></li>`).join('')}</ul><p class="legend-note">Productos de ${esc(state.pMarca)} convierten en promedio ${pct(bajos[0].base, 2)} (compras que incluyen el producto / sesiones que lo vieron).</p>`
    : `<div class="empty-state">Sin productos con más de ${MIN.sesionesProd} sesiones y conversión baja.</div>`;

  const filasTabla = [];
  const agregar = (n, nivel) => {
    filasTabla.push({ n, nivel });
    if (state.abiertos.has(n.path)) [...n.hijos].map((h) => nodos.get(h)).sort((x, y) => y.peso - x.peso).forEach((h) => agregar(h, nivel + 1));
  };
  raices.sort((x, y) => y.peso - x.peso).forEach((n) => agregar(n, 0));
  const nextBar = (r) => (!r || !r.vistas ? '' : `<div class="next-bar" title="${SIGUIENTE.map((s) => `${s.label} ${pct(div(r[s.k], r.vistas), 0)}`).join(' · ')}">${SIGUIENTE.map((s) => `<span style="width:${(div(r[s.k], r.vistas) * 100).toFixed(1)}%;background:${s.color}"></span>`).join('')}</div>`);
  const cont = document.getElementById('tabla-paginas');
  const leyenda = `<div class="next-legend">Hacia dónde va después: ${SIGUIENTE.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('')}</div>`;
  cont.innerHTML = leyenda + (filasTabla.length ? `<table class="data"><thead><tr><th>Ruta</th><th class="txt">Tipo</th><th>Vistas</th><th title="Sesiones que comenzaron en esta página (página de aterrizaje)">Entradas</th><th title="Compras de las sesiones que entraron por esta página / esas sesiones">Conv. entrada</th><th title="% de las vistas tras las cuales se abrió otra página">Siguen navegando</th><th>Δ vistas</th><th class="txt">Hacia dónde va</th></tr></thead><tbody>${filasTabla.map(({ n, nivel }) => {
    const r = n.propio;
    const dv = r && p.comp ? varRel(r.vistas, r.vistas_ant) : NaN;
    return `<tr><td class="path-cell" style="padding-left:${10 + nivel * 18}px"><button class="tree-toggle" data-path="${esc(n.path)}" ${n.hijos.size ? '' : 'disabled'} aria-label="Desplegar">${state.abiertos.has(n.path) ? '▾' : '▸'}</button>${r ? `<button class="path-link" data-trans="${esc(n.path)}">${esc(n.path)}</button>` : `<span>${esc(n.path)}</span>`}</td>
      <td class="txt">${r ? esc(r.tipo) : ''}</td><td>${r ? fmtInt.format(r.vistas) : '—'}</td><td>${r ? fmtInt.format(r.entradas) : '—'}</td>
      <td>${r && r.entradas >= 20 ? pct(div(r.entradas_compras, r.entradas), 2) : '—'}</td><td>${r ? pct(1 - div(r.sig_salida, r.vistas), 0) : '—'}</td>
      <td class="${clsDelta(dv)}">${fDelta(dv)}</td><td class="txt">${nextBar(r)}</td></tr>`;
  }).join('')}</tbody></table>` : '<div class="empty-state">Sin páginas para esta marca.</div>');
  cont.querySelectorAll('.tree-toggle').forEach((b) => b.addEventListener('click', () => {
    const path = b.dataset.path;
    if (state.abiertos.has(path)) state.abiertos.delete(path); else state.abiertos.add(path);
    renderPaginas(p);
  }));
  cont.querySelectorAll('[data-trans]').forEach((b) => b.addEventListener('click', () => mostrarTransiciones(p, b.dataset.trans)));
}
async function mostrarTransiciones(p, path) {
  const ts = await Promise.all(p.ids.map((id) => transSemana(id)));
  const filas = sumarTabla(ts, 'transiciones').filter((t) => t.marca === state.pMarca && t.path === path).sort((a, b) => b.n - a.n).slice(0, 8);
  const total = filas.reduce((s, t) => s + t.n, 0);
  document.getElementById('trans-titulo').textContent = `Después de ${path} (${state.pMarca})`;
  document.getElementById('tabla-transiciones').innerHTML = filas.length
    ? `<ul class="mini-list">${filas.map((t) => `<li><span class="r">${esc(t.sig_path)}</span><span class="m">${fmtInt.format(t.n)} · ${pct(t.n / total, 0)}</span></li>`).join('')}</ul><p class="legend-note">Principales destinos desde esta página; no incluye recargas de la misma página.</p>`
    : '<div class="empty-state">Sin destinos con volumen suficiente.</div>';
  const card = document.getElementById('card-transiciones');
  card.hidden = false;
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------- PRODUCTOS ---------- */
async function renderProductos(p) {
  let prods;
  try { prods = (await tablaGrande('productos', p.ids)).filter((r) => enMarcas(r.marca)); } catch (e) { console.warn(e); return; }
  prods = await conComparacion('productos', prods, p.comp, ['vistas']);
  tabla(document.getElementById('tabla-productos'), {
    id: 'productos', defecto: { i: 3, dir: -1 },
    cols: [
      { h: 'Producto', txt: true, v: (f) => f.nombre || f.item_id },
      { h: 'SKU', txt: true, v: (f) => f.item_id },
      { h: 'Marca', txt: true, v: (f) => f.marca },
      { h: 'Vistas', v: (f) => f.vistas, f: fInt },
      { h: 'Sesiones', v: (f) => f.sesiones, f: fInt },
      { h: 'Agregados', v: (f) => f.agregados, f: fInt },
      { h: '% agrega', v: (f) => div(f.agregados, f.vistas), f: fPct },
      { h: 'Compras', v: (f) => f.compras, f: fInt },
      { h: 'Conversión', v: conv, f: (x) => pct(x, 2) },
      { h: 'Unidades', v: (f) => f.unidades, f: fInt },
      { h: 'Ingresos', v: (f) => f.ingresos, f: fMoney },
      { h: 'Δ vistas', v: (f) => (p.comp ? varRel(f.vistas, f.vistas_ant) : NaN), f: fDelta, cls: (f) => clsDelta(p.comp ? varRel(f.vistas, f.vistas_ant) : NaN) },
    ],
    filas: prods,
  });
}

/* ---------- HOY ---------- */
function renderHoy() {
  const h = state.hoy;
  const kp = document.getElementById('kpis-hoy');
  if (!h) { kp.innerHTML = '<div class="empty-state">Todavía no hay datos de hoy.</div>'; return; }
  const refInfo = h.refs ? h.refs[state.hoyRef] : null;
  const nombreRef = state.hoyRef === 'semana' ? 'semana pasada' : 'año pasado';
  const mismoDia = state.hoyRef === 'semana' ? 'Mismo día de la semana pasada' : 'Mismo día del año pasado';
  const hoy = objs(h.hoy).filter((r) => enMarcas(r.marca));
  const ref = refInfo && refInfo.datos ? objs(refInfo.datos).filter((r) => enMarcas(r.marca)) : [];
  const horaAct = +h.actualizado.slice(11, 13);
  const horaCompleta = Math.max(0, horaAct - 1);
  const campos = ['sesiones', 's_carro', 's_chk', 'compras', 'ingresos'];
  const hasta = (rs) => sumar(rs.filter((r) => r.hora <= horaCompleta), campos);
  const a = hasta(hoy), b = ref.length ? hasta(ref) : null;
  document.getElementById('hoy-sub').textContent = `hoy ${fCorta(h.fecha)} vs ${refInfo ? fCorta(refInfo.fecha) : '—'} (${nombreRef}) · actualizado ${h.actualizado.slice(11, 16)}`;
  kp.innerHTML = [
    kpi('Sesiones', fmtInt.format(a.sesiones), b && deltaTxt(a.sesiones, b.sesiones), `hasta las ${horaCompleta}:59`, nombreRef),
    kpi('Llegan al carro', fmtInt.format(a.s_carro), b && deltaTxt(a.s_carro, b.s_carro), null, nombreRef),
    kpi('Compras', fmtInt.format(a.compras), b && deltaTxt(a.compras, b.compras), null, nombreRef),
    kpi('Conversión', pct(conv(a), 2), b && deltaTxt(conv(a), conv(b), true), 'compras / sesiones', nombreRef),
    kpi('Ingresos', fmtMoney.format(a.ingresos), b && deltaTxt(a.ingresos, b.ingresos), null, nombreRef),
  ].join('');

  const horas = [...Array(24).keys()];
  const porHora = (rs) => { const m = new Map(agruparPor(rs, 'hora', ['sesiones']).map((x) => [x.key, x.sesiones])); return horas.map((x) => m.get(x) ?? null); };
  const sHoy = porHora(hoy).map((v, i) => (i <= horaAct ? v ?? 0 : null));
  destruir('hoy');
  const o = opcionesBase();
  o.plugins.tooltip.callbacks = { title: (c) => `${c[0].label}:00`, label: (c) => `${c.dataset.label}: ${fmtInt.format(c.parsed.y)}` };
  const datasets = [{ label: 'Hoy', data: sHoy, borderColor: css('--series-1'), backgroundColor: css('--series-1'), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.2 }];
  if (ref.length) datasets.push({ label: mismoDia, data: porHora(ref), borderColor: css('--series-other'), backgroundColor: css('--series-other'), borderWidth: 2, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 4, tension: 0.2 });
  state.charts.hoy = new Chart(document.getElementById('chart-hoy'), { type: 'line', data: { labels: horas.map(String), datasets }, options: o });

  const pm = (rs) => new Map(agruparPor(rs.filter((r) => r.hora <= horaCompleta), 'marca', campos).map((x) => [x.key, x]));
  const ma = pm(hoy), mb = pm(ref);
  const filas = [...ma.values()].map((x) => ({ ...x, ant: mb.get(x.key) || null }));
  document.getElementById('hoy-tabla-sub').textContent = `vs ${mismoDia.toLowerCase()}, a la misma hora`;
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
  const p = periodo();
  notaFiltros(p);
  const t = state.tab;
  if (t === 'resumen') renderResumen(p);
  else if (t === 'recorrido') await renderRecorrido(p);
  else if (t === 'canales') renderCanales(p);
  else if (t === 'paginas') await renderPaginas(p);
  else if (t === 'productos') await renderProductos(p);
  else if (t === 'hoy') renderHoy();
}

async function init() {
  try {
    state.meta = await getJSON('meta.json');
    const d = await getJSON('diario.json');
    state.embudo = objs(d.embudo);
    try { state.hoy = await getJSON('hoy.json'); } catch (e) { state.hoy = null; }
    if (!state.meta.semanas || !state.meta.semanas.length) throw new Error('sin semanas procesadas');
  } catch (e) {
    document.getElementById('actualizado').textContent = 'Todavía no hay datos publicados.';
    document.getElementById('kpis').innerHTML = `<div class="empty-state">No se pudieron cargar los datos (${esc(e.message)}).</div>`;
    return;
  }
  const g = state.meta.generado;
  document.getElementById('actualizado').textContent = `Datos hasta el ${fCorta(state.meta.hasta)} · Hoy actualizado ${state.meta.hoy_actualizado ? state.meta.hoy_actualizado.slice(11, 16) : '—'} · generado ${fCorta(g.slice(0, 10))} ${g.slice(11, 16)}`;
  armarFiltros();
  render();
}
init();
