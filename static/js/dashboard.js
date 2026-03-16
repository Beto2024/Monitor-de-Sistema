/**
 * Monitor de Sistema — Lógica do dashboard
 * Gerencia conexão WebSocket, atualização de métricas e gráficos de histórico.
 */

// ============================================================
// Constantes de estilo (espelham as variáveis CSS)
// ============================================================
const CORES = {
  cpu:      { primary: '#f59e0b', light: '#fbbf24', grad: ['#f59e0b', '#fbbf24'] },
  ram:      { primary: '#a855f7', light: '#8b5cf6', grad: ['#a855f7', '#8b5cf6'] },
  disk:     { primary: '#ec4899', light: '#d946ef', grad: ['#ec4899', '#d946ef'] },
  danger:   '#ef4444',
  success:  '#22c55e',
  border:   '#2d2755',
  text:     '#a09cb5',
  bg:       '#1a1730',
};

// Raio e circunferência do gauge (r=56, cx=cy=70)
const GAUGE_R   = 56;
const GAUGE_C   = 2 * Math.PI * GAUGE_R; // ≈ 351.86

// ============================================================
// Estado global da aplicação
// ============================================================
let alertasConfig = { cpu: 80, ram: 80, disco: 80 };
let charts = {};           // Referências às instâncias Chart.js
let historicoLocal = [];   // Cache local do histórico

// Seleção de partição no card de Disco
let discoSelecionadoIdx = 0;
// Seleção de partição no gráfico de Disco
let chartDiscoSelecionadoIdx = 0;
// Cache da última lista de partições recebida
let _particoesCache = [];
// Flags de inicialização dos seletores de disco (para aplicar default C:\ apenas uma vez)
let _diskSelectorInitialized      = false;
let _chartDiskSelectorInitialized = false;

// ============================================================
// Inicialização — aguarda o DOM estar pronto
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  inicializarGraficos();
  inicializarSliders();
  conectarWebSocket();
  buscarHistoricoInicial();

  // Seletor de partição — card Disco
  document.getElementById('disk-selector')?.addEventListener('change', (e) => {
    discoSelecionadoIdx = parseInt(e.target.value) || 0;
    if (_particoesCache.length > 0) _renderizarDisco(_particoesCache);
  });

  // Seletor de partição — gráfico Disco
  document.getElementById('chart-disk-selector')?.addEventListener('change', (e) => {
    chartDiscoSelecionadoIdx = parseInt(e.target.value) || 0;
    _recalcularGraficoDisco();
  });
});

// ============================================================
// WebSocket (Socket.IO)
// ============================================================
function conectarWebSocket() {
  const socket = io({ transports: ['websocket', 'polling'] });

  const dot  = document.getElementById('conn-dot');
  const text = document.getElementById('conn-text');

  socket.on('connect', () => {
    dot.classList.add('connected');
    text.textContent = 'Conectado';
  });

  socket.on('disconnect', () => {
    dot.classList.remove('connected');
    text.textContent = 'Desconectado';
  });

  socket.on('metricas', (dados) => {
    atualizarDashboard(dados);
  });

  socket.on('alertas', (alertas) => {
    renderizarAlertasAtivos(alertas);
  });

  socket.on('alertas_config', (config) => {
    alertasConfig = config;
    sincronizarSliders(config);
  });

  socket.on('historico', (historico) => {
    historicoLocal = historico;
    reconstruirGraficos(historico);
  });
}

// ============================================================
// Busca inicial via REST (fallback para o primeiro load)
// ============================================================
async function buscarHistoricoInicial() {
  try {
    const [resMetricas, resAlertas] = await Promise.all([
      fetch('/api/metrics'),
      fetch('/api/alerts'),
    ]);
    const metricas = await resMetricas.json();
    const alertas  = await resAlertas.json();

    atualizarDashboard(metricas);
    alertasConfig = alertas;
    sincronizarSliders(alertas);
  } catch (e) {
    console.warn('Falha ao buscar dados iniciais:', e);
  }
}

// ============================================================
// Atualização principal do dashboard
// ============================================================
function atualizarDashboard(dados) {
  if (!dados) return;

  atualizarCPU(dados.cpu);
  atualizarRAM(dados.ram);
  atualizarDisco(dados.disco);
  atualizarSistema(dados.sistema);
  atualizarProcessos(dados.processos);
  atualizarHardware(dados.hardware);

  // Adiciona ponto ao histórico dos gráficos
  const ts = new Date(dados.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  adicionarPontoGrafico('cpu',  ts, dados.cpu?.total ?? 0);
  adicionarPontoGrafico('ram',  ts, dados.ram?.percentual ?? 0);

  // Usa a partição selecionada pelo usuário para o gráfico de disco
  const disco = dados.disco || [];
  adicionarPontoGrafico('disk', ts, _percentualDisco(disco, chartDiscoSelecionadoIdx));
}

// ── CPU ───────────────────────────────────────────────────────
function atualizarCPU(cpu) {
  if (!cpu) return;

  const pct = cpu.total ?? 0;
  setGauge('cpu', pct);
  setText('cpu-pct', pct.toFixed(1) + '%');
  setText('cpu-cores-logic', cpu.nucleos_logicos ?? '--');
  setText('cpu-cores-phys',  cpu.nucleos_fisicos ?? '--');
  setText('cpu-freq',        cpu.frequencia?.atual ? cpu.frequencia.atual + ' MHz' : '--');

  // Destaque vermelho quando alerta
  const card = document.getElementById('card-cpu');
  const badge = document.getElementById('badge-cpu');
  const alerta = pct >= alertasConfig.cpu;
  card?.classList.toggle('alert-active', alerta);
  if (badge) badge.classList.toggle('visible', alerta);

  // Cores dos núcleos por core
  const coresEl = document.getElementById('cpu-cores-list');
  if (coresEl && cpu.por_core?.length) {
    coresEl.innerHTML = cpu.por_core.map((v, i) => `
      <div class="core-item">
        <div class="core-label">Core ${i}</div>
        <div class="core-value">${v.toFixed(1)}%</div>
        <div class="progress-bar-container">
          <div class="progress-bar-fill cpu${v >= alertasConfig.cpu ? ' danger' : ''}"
               style="width:${v}%"></div>
        </div>
      </div>
    `).join('');
  }
}

// ── RAM ───────────────────────────────────────────────────────
function atualizarRAM(ram) {
  if (!ram) return;

  const pct = ram.percentual ?? 0;
  setGauge('ram', pct);
  setText('ram-pct',  pct.toFixed(1) + '%');
  setText('ram-total', ram.total_gb + ' GB');
  setText('ram-used',  ram.usada_gb + ' GB');
  setText('ram-free',  ram.disponivel_gb + ' GB');

  const card  = document.getElementById('card-ram');
  const badge = document.getElementById('badge-ram');
  const alerta = pct >= alertasConfig.ram;
  card?.classList.toggle('alert-active', alerta);
  if (badge) badge.classList.toggle('visible', alerta);
}

// ── Disco ─────────────────────────────────────────────────────
// Armazena info de hardware de disco para enriquecer a lista de partições
let _hardwareDiscos = [];

/**
 * Retorna o percentual de uso da partição `selIdx` no array `discoArr`.
 * Faz o clamp do índice para evitar acesso fora dos limites.
 */
function _percentualDisco(discoArr, selIdx) {
  if (!discoArr?.length) return 0;
  const idx = Math.min(selIdx, discoArr.length - 1);
  return discoArr[idx]?.percentual ?? 0;
}

/** Popula os seletores de partição (card + gráfico) se o número de partições mudou. */
function _popularSeletoresPartição(particoes) {
  [
    {
      id: 'disk-selector',
      getIdx: () => discoSelecionadoIdx,
      setIdx: (v) => { discoSelecionadoIdx = v; },
      isInit: () => _diskSelectorInitialized,
      markInit: () => { _diskSelectorInitialized = true; },
    },
    {
      id: 'chart-disk-selector',
      getIdx: () => chartDiscoSelecionadoIdx,
      setIdx: (v) => { chartDiscoSelecionadoIdx = v; },
      isInit: () => _chartDiskSelectorInitialized,
      markInit: () => { _chartDiskSelectorInitialized = true; },
    },
  ].forEach(({ id, getIdx, setIdx, isInit, markInit }) => {
    const sel = document.getElementById(id);
    if (!sel) return;

    // Só repopula se a contagem de partições mudou
    if (sel.options.length === particoes.length) return;

    const prevIdx = getIdx();
    sel.innerHTML = particoes.map((p, idx) =>
      `<option value="${idx}">${escapeHtml(p.ponto_montagem)} (${escapeHtml(p.sistema_arquivos || 'N/A')})</option>`
    ).join('');

    let targetIdx = prevIdx < particoes.length ? prevIdx : 0;

    // Na primeira inicialização, prefere C:\ ou / como padrão
    if (!isInit()) {
      const cIdx = particoes.findIndex(p =>
        p.ponto_montagem.toUpperCase().startsWith('C:') ||
        p.ponto_montagem === '/'
      );
      if (cIdx >= 0) targetIdx = cIdx;
      markInit();
    }

    sel.value = targetIdx;
    setIdx(targetIdx);
  });
}

/** Renderiza o gauge/detalhes do card de Disco usando `discoSelecionadoIdx`. */
function _renderizarDisco(particoes) {
  const idx = Math.min(discoSelecionadoIdx, particoes.length - 1);
  const principal = particoes[idx];
  const pct = principal.percentual ?? 0;
  setGauge('disk', pct);
  setText('disk-pct',   pct.toFixed(1) + '%');
  setText('disk-total', principal.total_gb + ' GB');
  setText('disk-used',  principal.usado_gb + ' GB');
  setText('disk-free',  principal.livre_gb + ' GB');

  const card  = document.getElementById('card-disk');
  const badge = document.getElementById('badge-disk');
  const alerta = particoes.some(p => p.percentual >= alertasConfig.disco);
  card?.classList.toggle('alert-active', alerta);
  if (badge) badge.classList.toggle('visible', alerta);

  // Lista de todas as partições com tipo de armazenamento
  const listaEl = document.getElementById('disk-partitions');
  if (listaEl) {
    const driveInfo = _hardwareDiscos.length > 0 ? _hardwareDiscos[0] : null;
    const tipoLabel = driveInfo ? ` · <span style="color:var(--disk-light);">${escapeHtml(driveInfo.tipo)}</span>` : '';
    const modeloLabel = driveInfo
      ? `<div style="font-size:0.75rem;color:var(--text-sec);margin-top:0.15rem;">${escapeHtml(driveInfo.modelo || '')}</div>`
      : '';

    listaEl.innerHTML = particoes.map((p, i) => `
      <div class="metric-detail-item" style="grid-column: span 2;">
        <div class="detail-label">${escapeHtml(p.ponto_montagem)} (${escapeHtml(p.sistema_arquivos || 'N/A')})${i === 0 ? tipoLabel : ''}</div>
        ${i === 0 ? modeloLabel : ''}
        <div class="detail-value" style="margin-bottom:0.25rem">
          ${p.usado_gb} GB / ${p.total_gb} GB (${p.percentual}%)
        </div>
        <div class="progress-bar-container">
          <div class="progress-bar-fill disk${p.percentual >= alertasConfig.disco ? ' danger' : ''}"
               style="width:${p.percentual}%"></div>
        </div>
      </div>
    `).join('');
  }
}

function atualizarDisco(particoes) {
  if (!particoes?.length) return;

  _particoesCache = particoes;
  _popularSeletoresPartição(particoes);
  _renderizarDisco(particoes);
}

// ── Hardware detalhado ────────────────────────────────────────
function atualizarHardware(hardware) {
  if (!hardware) return;

  // Processador — sysinfo card
  const cpuNome = hardware.cpu?.nome ?? '—';
  const cpuFabricante = hardware.cpu?.fabricante ?? '';
  const cpuLabel = cpuNome !== 'Desconhecido'
    ? cpuNome
    : (cpuFabricante !== 'Desconhecido' ? cpuFabricante : '—');
  setText('sys-cpu-name', cpuLabel);

  // Modelo do processador no card de CPU
  setText('cpu-hw-name', cpuLabel);

  // RAM — sysinfo card (tipo + velocidade combinados)
  const ramTipo = hardware.ram?.tipo ?? 'Desconhecido';
  const ramVel  = hardware.ram?.velocidade ?? '—';
  const ramLabel = ramTipo !== 'Desconhecido'
    ? (ramVel !== '—' ? `${ramTipo} • ${ramVel}` : ramTipo)
    : '—';
  setText('sys-ram-type', ramLabel);

  // RAM — card de métricas: campos separados
  setText('ram-hw-type',  ramTipo !== 'Desconhecido' ? ramTipo : '—');
  setText('ram-hw-speed', ramVel);

  const slots = hardware.ram?.slots ?? [];
  if (slots.length > 0) {
    const detalhes = slots
      .map((s, i) => `${i + 1}: ${s.capacidade_gb} GB`)
      .join(' | ');
    setText('ram-hw-slots', `${slots.length} slot${slots.length > 1 ? 's' : ''} — ${detalhes}`);
  } else {
    setText('ram-hw-slots', '—');
  }

  // Discos — armazena para enriquecer a lista de partições
  _hardwareDiscos = hardware.discos ?? [];
}

// ── Sistema ───────────────────────────────────────────────────
function atualizarSistema(sys) {
  if (!sys) return;
  setText('sys-hostname', sys.hostname);
  setText('sys-os',       sys.os);
  setText('sys-arch',     sys.arquitetura);
  setText('sys-uptime',   sys.uptime);
}

// ── Processos ─────────────────────────────────────────────────
function atualizarProcessos(processos) {
  const tbody = document.getElementById('proc-tbody');
  if (!tbody || !processos?.length) return;

  tbody.innerHTML = processos.map((p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(p.nome)}</td>
      <td>${p.pid}</td>
      <td>
        <div class="proc-cpu-bar">
          <span style="min-width:3.5rem; color: var(--cpu-light);">${(p.cpu ?? 0).toFixed(1)}%</span>
          <div class="progress-bar-container" style="flex:1">
            <div class="progress-bar-fill cpu" style="width:${Math.min(p.cpu ?? 0, 100)}%"></div>
          </div>
        </div>
      </td>
      <td style="color: var(--ram-light);">${(p.ram ?? 0).toFixed(1)}%</td>
    </tr>
  `).join('');
}

// ============================================================
// Gauge SVG
// ============================================================
function setGauge(tipo, pct) {
  const pctClamp = Math.max(0, Math.min(100, pct));
  const offset   = GAUGE_C - (pctClamp / 100) * GAUGE_C;

  const fill  = document.getElementById(`gauge-fill-${tipo}`);
  const value = document.getElementById(`gauge-val-${tipo}`);

  if (fill)  fill.style.strokeDashoffset = offset;
  if (value) {
    value.textContent = Math.round(pctClamp) + '%';
    value.classList.toggle('danger', pctClamp >= alertasConfig[tipo === 'disk' ? 'disco' : tipo]);
  }
}

// ============================================================
// Gráficos Chart.js
// ============================================================
function criarGrafico(id, label, cor) {
  const ctx = document.getElementById(id)?.getContext('2d');
  if (!ctx) return null;

  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label,
        data: [],
        borderColor: cor,
        backgroundColor: cor + '22',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      animation: { duration: 300 },
      scales: {
        x: {
          ticks: { color: CORES.text, maxTicksLimit: 6, font: { size: 10 } },
          grid:  { color: CORES.border + '55' },
        },
        y: {
          min: 0,
          max: 100,
          ticks: {
            color: CORES.text,
            callback: (v) => v + '%',
            font: { size: 10 },
            maxTicksLimit: 5,
          },
          grid: { color: CORES.border + '55' },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (ctx) => ` ${ctx.parsed.y.toFixed(1)}%` },
        },
      },
    },
  });
}

function inicializarGraficos() {
  charts.cpu  = criarGrafico('chart-cpu',  'CPU',  CORES.cpu.primary);
  charts.ram  = criarGrafico('chart-ram',  'RAM',  CORES.ram.primary);
  charts.disk = criarGrafico('chart-disk', 'Disco', CORES.disk.primary);
}

function adicionarPontoGrafico(tipo, label, valor) {
  const chart = charts[tipo];
  if (!chart) return;

  const MAX = 60;
  chart.data.labels.push(label);
  chart.data.datasets[0].data.push(valor);

  if (chart.data.labels.length > MAX) {
    chart.data.labels.shift();
    chart.data.datasets[0].data.shift();
  }

  chart.update('none');
}

function reconstruirGraficos(historico) {
  if (!historico?.length) return;

  ['cpu', 'ram', 'disk'].forEach((tipo) => {
    const chart = charts[tipo];
    if (!chart) return;
    chart.data.labels = [];
    chart.data.datasets[0].data = [];
  });

  historico.forEach((item) => {
    const ts = new Date(item.timestamp).toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    adicionarPontoGrafico('cpu',  ts, item.cpu?.total ?? 0);
    adicionarPontoGrafico('ram',  ts, item.ram?.percentual ?? 0);
    adicionarPontoGrafico('disk', ts, _percentualDisco(item.disco, chartDiscoSelecionadoIdx));
  });
}

/** Reconstrói apenas o gráfico de disco com a partição selecionada. */
function _recalcularGraficoDisco() {
  const chart = charts.disk;
  if (!chart) return;

  chart.data.labels = [];
  chart.data.datasets[0].data = [];

  historicoLocal.forEach((item) => {
    const ts = new Date(item.timestamp).toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    chart.data.labels.push(ts);
    chart.data.datasets[0].data.push(_percentualDisco(item.disco, chartDiscoSelecionadoIdx));
  });

  chart.update('none');
}

// ============================================================
// Sliders de threshold
// ============================================================
function inicializarSliders() {
  ['cpu', 'ram', 'disk'].forEach((tipo) => {
    const slider = document.getElementById(`slider-${tipo}`);
    const display = document.getElementById(`val-${tipo}`);
    if (!slider || !display) return;

    slider.addEventListener('input', () => {
      display.textContent = slider.value + '%';
    });
  });

  document.getElementById('btn-salvar-alertas')?.addEventListener('click', salvarAlertas);
}

function sincronizarSliders(config) {
  const map = { cpu: 'cpu', ram: 'ram', disco: 'disk' };
  for (const [chave, id] of Object.entries(map)) {
    const slider  = document.getElementById(`slider-${id}`);
    const display = document.getElementById(`val-${id}`);
    if (slider)  slider.value = config[chave] ?? 80;
    if (display) display.textContent = (config[chave] ?? 80) + '%';
  }
}

async function salvarAlertas() {
  const payload = {
    cpu:   parseFloat(document.getElementById('slider-cpu')?.value  ?? 80),
    ram:   parseFloat(document.getElementById('slider-ram')?.value  ?? 80),
    disco: parseFloat(document.getElementById('slider-disk')?.value ?? 80),
  };

  try {
    const res = await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.sucesso) {
      alertasConfig = data.config;
      mostrarFeedback('✓ Alertas salvos!');
    }
  } catch (e) {
    console.error('Erro ao salvar alertas:', e);
  }
}

function mostrarFeedback(msg) {
  const btn = document.getElementById('btn-salvar-alertas');
  if (!btn) return;
  const original = btn.textContent;
  btn.textContent = msg;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 2000);
}

// ============================================================
// Alertas ativos
// ============================================================
function renderizarAlertasAtivos(alertas) {
  const lista = document.getElementById('alertas-lista');
  if (!lista) return;

  if (!alertas?.length) {
    lista.innerHTML = `
      <div class="alert-empty">
        <span>✅</span> Nenhum alerta no momento
      </div>`;
    return;
  }

  lista.innerHTML = alertas.map(a => `
    <div class="alert-item">
      <span class="alert-item-icon">⚠️</span>
      <span class="alert-item-msg">${escapeHtml(a.mensagem)}</span>
    </div>
  `).join('');
}

// ============================================================
// Utilitários
// ============================================================
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value ?? '--';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
