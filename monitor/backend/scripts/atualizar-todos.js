// ─────────────────────────────────────────
//  Atualização diária de todos os clientes
//  Chama GET <cliente>/atualizar-tudo (SSE) em sequência.
//  Se o backend não estiver rodando, sobe `node server.js` em segundo plano.
//  Log: backend/logs/atualizar-YYYY-MM-DD.log
//  Uso: node scripts/atualizar-todos.js [cliente ...]
// ─────────────────────────────────────────
const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');

const BACKEND_DIR = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(BACKEND_DIR, '.env') });

const BASE_URL = `http://localhost:${process.env.PORT || 3001}`;
const TIMEOUT_MS = 20 * 60 * 1000; // por cliente

const CLIENTES = [
  { nome: 'BIC',              rota: '' },
  { nome: 'M Dias Branco',    rota: '/mdias' },
  { nome: 'Marilan',          rota: '/marilan' },
  { nome: 'Asa',              rota: '/asa' },
  { nome: 'Bombril',          rota: '/bombril' },
  { nome: 'Cicopal',          rota: '/cicopal' },
  { nome: 'Fini',             rota: '/fini' },
  { nome: 'Fruki',            rota: '/fruki' },
  { nome: 'Gallo',            rota: '/gallo' },
  { nome: 'Gtex',             rota: '/gtex' },
  { nome: 'M Dias Saudáveis', rota: '/mdiassaud' },
  { nome: 'Kibon',            rota: '/kibon' },
  { nome: 'Pepsico',          rota: '/pepsico' },
  { nome: 'Peccin',           rota: '/peccin' },
  { nome: 'Geral',            rota: '/geral' },  // extrações sem vínculo de indústria (usuários)
];

// ── Log ──────────────────────────────────
const pad = n => String(n).padStart(2, '0');
const hoje = new Date();
const logDir = path.join(BACKEND_DIR, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `atualizar-${hoje.getFullYear()}-${pad(hoje.getMonth()+1)}-${pad(hoje.getDate())}.log`);

function log(msg) {
  const d = new Date();
  const line = `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logFile, line + '\n');
}

// ── Backend ──────────────────────────────
async function backendOk() {
  try {
    const r = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch (_) {
    return false;
  }
}

async function garantirBackend() {
  if (await backendOk()) return;

  log('Backend fora do ar — iniciando node server.js…');
  const out = fs.openSync(path.join(logDir, 'server.log'), 'a');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR, detached: true, stdio: ['ignore', out, out], windowsHide: true,
  });
  child.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    if (await backendOk()) { log('Backend no ar.'); return; }
  }
  throw new Error('Backend não respondeu em 60 s.');
}

// ── SSE ──────────────────────────────────
async function atualizar(cliente) {
  const res = await fetch(`${BASE_URL}${cliente.rota}/atualizar-tudo`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const evento = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = evento.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
      if (!data) continue;
      const ev = JSON.parse(data);
      if (ev.error) throw new Error(ev.error);
      if (ev.done)  return;
      log(`  ${cliente.nome} ${String(ev.pct).padStart(3)}% ${ev.msg}`);
    }
  }
  throw new Error('Conexão encerrada sem evento final.');
}

// ── Alertas Slack (bic_system) ───────────
// Ao fim das cargas, pede ao bic_system para verificar anomalias/regressões e avisar no Slack.
// O que é enviado é configurado no portal: Visão Geral → Alertas Slack.
async function dispararAlertas() {
  const url   = (process.env.BIC_SYSTEM_URL || 'https://bic-system.vercel.app').replace(/\/$/, '');
  const token = process.env.ALERTAS_TOKEN;
  if (!token) { log('Alertas Slack: ALERTAS_TOKEN não configurado no .env — pulando.'); return; }
  try {
    const res = await fetch(`${url}/api/alertas/auto`, {
      method: 'POST',
      headers: { 'x-alertas-token': token },
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    log(j.enviado
      ? `Alertas Slack: enviado (${j.industrias} indústria(s), ${j.ocorrencias} ocorrência(s)).`
      : `Alertas Slack: nada enviado — ${j.motivo}.`);
  } catch (err) {
    log(`Alertas Slack: falhou — ${err.message}`);
  }
}

// ── Main ─────────────────────────────────
(async () => {
  const filtro = process.argv.slice(2).map(s => s.toLowerCase());
  const lista = filtro.length
    ? CLIENTES.filter(c => filtro.includes(c.nome.toLowerCase()) || filtro.includes(c.rota.slice(1)) || (c.rota === '' && filtro.includes('bic')))
    : CLIENTES;

  log(`===== Início da atualização (${lista.length} clientes) =====`);
  try {
    await garantirBackend();
  } catch (err) {
    log(`ERRO: ${err.message}`);
    process.exit(1);
  }

  const falhas = [];
  for (const cliente of lista) {
    const t0 = Date.now();
    log(`▶ ${cliente.nome}`);
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      try {
        await atualizar(cliente);
        log(`✔ ${cliente.nome} concluído em ${Math.round((Date.now() - t0) / 1000)} s`);
        break;
      } catch (err) {
        // Backend caiu no meio: sobe de novo e tenta uma segunda vez
        const caiu = !(await backendOk());
        if (tentativa === 1 && caiu) {
          log(`⚠ ${cliente.nome}: backend caiu (${err.message}) — reiniciando e tentando de novo…`);
          try { await garantirBackend(); continue; } catch (e) { err = e; }
        }
        falhas.push(cliente.nome);
        log(`✖ ${cliente.nome} falhou: ${err.message}`);
        break;
      }
    }
  }

  log(`===== Fim: ${lista.length - falhas.length} ok, ${falhas.length} falha(s)${falhas.length ? ' — ' + falhas.join(', ') : ''} =====`);

  // Só no ciclo completo (sem filtro de clientes)
  if (!filtro.length) await dispararAlertas();
  process.exit(falhas.length ? 1 : 0);
})();
