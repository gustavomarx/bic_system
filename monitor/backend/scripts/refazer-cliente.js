// ─────────────────────────────────────────
//  Refaz a carga do dia de um ou mais clientes, descartando a atual
//  1. Renomeia os arquivos de hoje do cliente (comparativo, batalha, histórico) para [OLD]
//     — assim o monitor sempre sobe arquivo novo, mesmo se os dados não mudaram
//  2. Roda scripts/atualizar-todos.js <cliente> (sem disparar alertas no Slack)
//  3. Confere que há arquivo novo de hoje em cada pasta e manda os antigos para a lixeira do Drive
//  Se a atualização falhar, devolve os nomes originais e não apaga nada.
//  Uso: node scripts/refazer-cliente.js <cliente> [cliente ...]   (ex.: peccin marilan)
// ─────────────────────────────────────────
const path = require('path');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const BACKEND_DIR = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(BACKEND_DIR, '.env') });

// Variáveis das pastas: <PREFIXO>_GOOGLE_DRIVE_{COMPARATIVO,BATALHA,HISTORICO}_FOLDER_ID; o BIC não tem prefixo
const PASTAS_BIC = { comparativo: 'GOOGLE_DRIVE_FOLDER_ID', batalha: 'GOOGLE_DRIVE_BATALHA_FOLDER_ID', historico: 'GOOGLE_DRIVE_HISTORICO_FOLDER_ID' };

function pastasDoCliente(cliente) {
  const nomes = cliente === 'bic' ? PASTAS_BIC : {
    comparativo: `${cliente.toUpperCase()}_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID`,
    batalha:     `${cliente.toUpperCase()}_GOOGLE_DRIVE_BATALHA_FOLDER_ID`,
    historico:   `${cliente.toUpperCase()}_GOOGLE_DRIVE_HISTORICO_FOLDER_ID`,
  };
  const out = {};
  for (const [tipo, env] of Object.entries(nomes)) if (process.env[env]) out[tipo] = process.env[env];
  return out;
}

function hojeSP() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return { iso: `${g('year')}-${g('month')}-${g('day')}`, br: `${g('day')}-${g('month')}-${g('year')}`, compacto: `${g('year')}${g('month')}${g('day')}` };
}

const pad = n => String(n).padStart(2, '0');
function log(msg) {
  const d = new Date();
  console.log(`[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] ${msg}`);
}

function getDrive() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(BACKEND_DIR, process.env.GOOGLE_SERVICE_ACCOUNT_PATH),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// Arquivos de hoje na pasta: data de hoje no nome (DD-MM-YYYY ou YYYYMMDD)
async function arquivosDeHoje(drive, folderId, hoje) {
  const r = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and (name contains '${hoje.br}' or name contains '${hoje.compacto}')`,
    fields: 'files(id, name, createdTime)',
    pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  return r.data.files || [];
}

const comOld = nome => {
  if (nome.includes('[OLD]')) return nome;
  const i = nome.lastIndexOf('.');
  return i !== -1 ? nome.slice(0, i) + ' [OLD]' + nome.slice(i) : nome + ' [OLD]';
};

const renomear = (drive, id, name) => drive.files.update({ fileId: id, requestBody: { name }, supportsAllDrives: true });

function rodarAtualizacao(cliente) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, 'atualizar-todos.js'), cliente], { cwd: BACKEND_DIR, stdio: 'inherit' });
    child.on('exit', code => resolve(code === 0));
  });
}

async function refazer(drive, cliente, hoje) {
  const pastas = pastasDoCliente(cliente);
  if (!Object.keys(pastas).length) throw new Error(`nenhuma pasta do Drive configurada para "${cliente}" no .env do monitor`);

  // 1. Arquivos atuais de hoje → [OLD]
  const atuais = [];
  for (const [tipo, folderId] of Object.entries(pastas)) {
    for (const f of await arquivosDeHoje(drive, folderId, hoje)) atuais.push({ ...f, tipo, folderId });
  }
  if (!atuais.length) log(`${cliente}: nenhum arquivo de hoje no Drive — só vai atualizar.`);
  for (const f of atuais) {
    if (f.name !== comOld(f.name)) await renomear(drive, f.id, comOld(f.name));
    log(`${cliente}: atual marcado para descarte — ${f.tipo}: ${f.name}`);
  }

  // 2. Atualização
  const ok = await rodarAtualizacao(cliente);
  if (!ok) {
    for (const f of atuais) await renomear(drive, f.id, f.name);
    throw new Error('atualização falhou — arquivos atuais mantidos com o nome original, nada foi apagado');
  }

  // 3. Garante arquivo novo em cada pasta antes de apagar os antigos
  const idsAntigos = new Set(atuais.map(f => f.id));
  for (const [tipo, folderId] of Object.entries(pastas)) {
    const novos = (await arquivosDeHoje(drive, folderId, hoje)).filter(f => !idsAntigos.has(f.id) && !f.name.includes('[OLD]'));
    if (!novos.length) throw new Error(`atualização terminou mas não há arquivo novo de hoje em "${tipo}" — antigos mantidos como [OLD], nada foi apagado`);
  }

  // 4. Antigos → lixeira (recuperável pelo Drive)
  for (const f of atuais) {
    await drive.files.update({ fileId: f.id, requestBody: { trashed: true }, supportsAllDrives: true });
    log(`${cliente}: lixeira — ${f.tipo}: ${comOld(f.name)}`);
  }

  // 5. Confere que ficou só o novo
  for (const [tipo, folderId] of Object.entries(pastas)) {
    const restantes = await arquivosDeHoje(drive, folderId, hoje);
    const sobra = restantes.filter(f => idsAntigos.has(f.id) || f.name.includes('[OLD]'));
    if (sobra.length) throw new Error(`ainda há arquivo antigo em "${tipo}": ${sobra.map(f => f.name).join(', ')}`);
    log(`${cliente}: ${tipo} ok — ${restantes.map(f => f.name).join(', ')}`);
  }
}

(async () => {
  const clientes = process.argv.slice(2).map(s => s.toLowerCase());
  if (!clientes.length) {
    console.log('Uso: node scripts/refazer-cliente.js <cliente> [cliente ...]   (ex.: peccin marilan)');
    process.exit(1);
  }
  const drive = getDrive();
  const hoje  = hojeSP();
  const falhas = [];
  for (const c of clientes) {
    log(`===== Refazendo ${c} (${hoje.br}) =====`);
    try {
      await refazer(drive, c, hoje);
      log(`✔ ${c} refeito.`);
    } catch (err) {
      falhas.push(c);
      log(`✖ ${c}: ${err.message}`);
    }
  }
  process.exit(falhas.length ? 1 : 0);
})();
