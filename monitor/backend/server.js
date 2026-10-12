require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { google } = require('googleapis');
const oracledb  = require('oracledb');
const XLSX      = require('xlsx');
const { Pool }  = require('pg');

const app    = express();
const PORT   = process.env.PORT || 3001;
const upload = multer({ storage: multer.memoryStorage() });

// ─────────────────────────────────────────
//  Acesso — o monitor só abre pelo BIC System (admin, Visão Geral → BIC Monitor)
//  • navegador: /auth/sso?t=<token de 2 min assinado pelo system> → cookie de sessão
//  • system chamando a API: Authorization: Bearer <token do system>
//  • agendamento diário (scripts/atualizar-todos.js): header x-monitor-token
// ─────────────────────────────────────────
const jwt = require('jsonwebtoken');
const MON_SECRET     = process.env.SYSTEM_JWT_SECRET || '';
const MON_TOKEN      = process.env.MONITOR_TOKEN || '';
const SYSTEM_ORIGINS = (process.env.SYSTEM_ORIGINS || 'https://bic-system.vercel.app,http://localhost:3004')
  .split(',').map(s => s.trim()).filter(Boolean);
const SESSAO_COOKIE  = 'monitor_sess';
const SESSAO_MS      = 12 * 60 * 60 * 1000;
const _ssoUsados     = new Map();   // jti → expira em (token de entrada vale uma vez)

app.use(cors({
  origin: (origin, cb) => cb(null, !origin || SYSTEM_ORIGINS.includes(origin)),
  allowedHeaders: ['Content-Type', 'Authorization', 'x-monitor-token'],
}));
app.use(express.json());

// Só o system pode embutir o monitor
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${SYSTEM_ORIGINS.join(' ')}`);
  next();
});

function lerCookie(req, nome) {
  const m = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(nome + '='));
  return m ? decodeURIComponent(m.slice(nome.length + 1)) : null;
}

function verificar(token, audience) {
  if (!MON_SECRET || !token) return null;
  try {
    const p = jwt.verify(token, MON_SECRET, { audience });
    return p && p.isAdmin ? p : null;
  } catch (_) { return null; }
}

const PAGINA_RESTRITA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>BIC Monitor</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#11121f;color:#e8eaf0;font-family:'Segoe UI',system-ui,sans-serif}
.c{max-width:420px;text-align:center;padding:32px;border:1px solid #2a2c42;border-radius:12px;background:#191a2b}
b{color:#F47920}a{color:#F47920}</style></head><body><div class="c"><h2>Acesso restrito</h2>
<p>O BIC Monitor abre pelo <b>BIC System</b>, com usuário administrador:<br>Visão Geral → <b>BIC Monitor</b>.</p>
<p><a href="https://bic-system.vercel.app/#/visao-geral/monitor">Abrir o BIC System</a></p></div></body></html>`;

app.get('/auth/sso', (req, res) => {
  const p = verificar(String(req.query.t || ''), 'bic-monitor');
  const agora = Date.now();
  for (const [k, exp] of _ssoUsados) if (exp < agora) _ssoUsados.delete(k);
  if (!p || !p.jti || _ssoUsados.has(p.jti)) return res.status(401).send(PAGINA_RESTRITA);
  _ssoUsados.set(p.jti, p.exp * 1000);

  const sessao = jwt.sign({ email: p.email, name: p.name, isAdmin: true }, MON_SECRET, { audience: 'bic-monitor-sess', expiresIn: SESSAO_MS / 1000 });
  // SameSite=None + Partitioned: funciona embutido no system (iframe) e em aba própria
  res.cookie(SESSAO_COOKIE, sessao, { httpOnly: true, secure: true, sameSite: 'none', partitioned: true, maxAge: SESSAO_MS, path: '/' });
  res.redirect(req.query.embed ? '/?embed=1' : '/');
});

app.get('/auth/sair', (req, res) => {
  res.clearCookie(SESSAO_COOKIE, { httpOnly: true, secure: true, sameSite: 'none', partitioned: true, path: '/' });
  res.send(PAGINA_RESTRITA);
});

app.use((req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth/')) return next();
  if (MON_TOKEN && req.get('x-monitor-token') === MON_TOKEN) return next();
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const user = (bearer && verificar(bearer, 'bic-monitor')) || verificar(lerCookie(req, SESSAO_COOKIE), 'bic-monitor-sess');
  if (user) { req.user = user; return next(); }
  if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') return res.status(401).send(PAGINA_RESTRITA);
  res.status(401).json({ error: 'Acesso restrito: abra o monitor pelo BIC System (admin).' });
});

// ─────────────────────────────────────────
//  Frontend — só os arquivos da interface (nunca backend/, .env ou credenciais)
// ─────────────────────────────────────────
const FRONT_DIR = path.join(__dirname, '..');
app.get('/', (req, res) => res.sendFile(path.join(FRONT_DIR, 'index.html')));
app.get(/^\/(index\.html|integracoes\.js|[\w-]+\.png)$/, (req, res) => res.sendFile(path.join(FRONT_DIR, req.params[0])));

// ─────────────────────────────────────────
//  PostgreSQL — pool de conexão
// ─────────────────────────────────────────
const pgPool = new Pool({
  host:     process.env.PG_HOST,
  port:     parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE,
  user:     process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

// ─────────────────────────────────────────
//  Oracle — conexão (Thin mode + TLS sem wallet)
// ─────────────────────────────────────────
async function getOracleConnection() {
  return oracledb.getConnection({
    user:          process.env.DB_USER,
    password:      process.env.DB_PASSWORD,
    connectString: process.env.DB_CONNECT_STRING,
  });
}

// ─────────────────────────────────────────
//  Google Drive — autenticação via service account
// ─────────────────────────────────────────
function getDriveClient() {
  const keyPath = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_PATH);
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Arquivo de credenciais não encontrado: ${keyPath}`);
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// ─────────────────────────────────────────
//  Utilitário — renomeia arquivo no Drive adicionando [OLD] antes da extensão
// ─────────────────────────────────────────
async function renameFileToOld(drive, fileId, currentName) {
  const dotIdx  = currentName.lastIndexOf('.');
  const nameOld = dotIdx !== -1
    ? currentName.slice(0, dotIdx) + ' [OLD]' + currentName.slice(dotIdx)
    : currentName + ' [OLD]';
  await drive.files.update({
    fileId,
    requestBody: { name: nameOld },
    supportsAllDrives: true,
  });
  console.log(`[Drive] Renomeado para "${nameOld}".`);
}

// ─────────────────────────────────────────
//  Utilitário — hash dos dados (não do arquivo: o xlsx embute timestamps)
// ─────────────────────────────────────────
function hashData(data) {
  const input = Buffer.isBuffer(data) ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(input).digest('hex');
}

// ─────────────────────────────────────────
//  Utilitário — sobe o XLSX do dia evitando duplicatas
//  Se já existe arquivo do dia com o mesmo dataHash, não sobe nada.
//  Caso contrário, renomeia os existentes para [OLD] e sobe o novo.
// ─────────────────────────────────────────
async function uploadDailyXlsx(drive, folderId, filename, buffer, dataHash) {
  const listResp = await drive.files.list({
    q:                         `'${folderId}' in parents and name = '${filename}' and trashed = false`,
    fields:                    'files(id, name, appProperties)',
    pageSize:                  100,
    supportsAllDrives:         true,
    includeItemsFromAllDrives: true,
  });
  const existentes = listResp.data.files || [];

  const igual = existentes.find(f => f.appProperties && f.appProperties.dataHash === dataHash);
  if (igual) {
    console.log(`[Drive] "${filename}" sem alterações — upload ignorado.`);
    return { id: igual.id, name: igual.name, skipped: true };
  }

  for (const f of existentes) {
    await renameFileToOld(drive, f.id, f.name);
  }

  const { Readable } = require('stream');
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);

  const resp = await drive.files.create({
    requestBody: { name: filename, parents: [folderId], appProperties: { dataHash } },
    media: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: stream },
    fields: 'id, name', supportsAllDrives: true,
  });
  return { ...resp.data, skipped: false };
}

// ─────────────────────────────────────────
//  Utilitário — parsear data do nome do arquivo
//  Formato: relatorio_DD-MM-YYYY.xlsx
// ─────────────────────────────────────────
function parseDateFromFilename(name) {
  const m = name.match(/relatorio_(\d{2})-(\d{2})-(\d{4})\.xlsx$/i);
  if (!m) return null;
  return new Date(`${m[3]}-${m[2]}-${m[1]}`); // YYYY-MM-DD
}

function buildFilename(date) {
  // Usa fuso horário de Brasília (America/Sao_Paulo) para nome do arquivo
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(date);
  const d  = parts.find(p => p.type === 'day').value;
  const mo = parts.find(p => p.type === 'month').value;
  const y  = parts.find(p => p.type === 'year').value;
  return `relatorio_${d}-${mo}-${y}.xlsx`;
}

// ─────────────────────────────────────────
//  Utilitário — próximo nome disponível na pasta
//  relatorio_DD-MM-YYYY.xlsx
//  relatorio_DD-MM-YYYY_1.xlsx, _2, _3 ...
// ─────────────────────────────────────────
async function resolveAvailableFilename(drive, folderId, baseName) {
  // baseName = "relatorio_DD-MM-YYYY"  (sem .xlsx)
  const listResp = await drive.files.list({
    q:                         `'${folderId}' in parents and trashed = false`,
    fields:                    'files(name)',
    pageSize:                  1000,
    supportsAllDrives:         true,
    includeItemsFromAllDrives: true,
  });
  const existing = new Set((listResp.data.files || []).map(f => f.name));

  if (!existing.has(`${baseName}.xlsx`)) return `${baseName}.xlsx`;

  for (let i = 1; i <= 999; i++) {
    const candidate = `${baseName}_${i}.xlsx`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error('Não foi possível encontrar nome disponível para o arquivo.');
}

// ─────────────────────────────────────────
//  Utilitário — gerar XLSX e salvar no Drive (histórico Oracle)
//  Pasta: GOOGLE_DRIVE_FOLDER_ID — não sobrescreve se já existir
// ─────────────────────────────────────────
async function saveRowsToDrive(rows) {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const filename = buildFilename(new Date());

    const wsData = rows.map(r => ({ holding: r.holding, customer: r.customer, anomes: r.anomes, valor: r.valor }));
    const ws     = XLSX.utils.json_to_sheet(wsData);
    const wb     = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Dados');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const up = await uploadDailyXlsx(drive, folderId, filename, buffer, hashData(wsData));
    if (!up.skipped) console.log(`[Drive] Histórico Oracle salvo: "${filename}".`);
  } catch (err) {
    console.error('[Drive] Erro ao salvar histórico Oracle:', err.message);
  }
}

// ─────────────────────────────────────────
//  GET /dados-atual — busca dados do Oracle
// ─────────────────────────────────────────
app.get('/dados-atual', async (req, res) => {
  let conn;
  try {
    conn = await getOracleConnection();

    const result = await conn.execute(
      `SELECT
         "HOLDING"                        AS "HOLDING",
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.bic_vendas_PARCEIRO v0
       WHERE "VENDA_DATA" BETWEEN TRUNC(SYSDATE, 'YEAR') AND SYSDATE
       GROUP BY
         "HOLDING",
         "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')
       ORDER BY HOLDING ASC`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const rows = result.rows.map(r => ({
      holding:  r.HOLDING      || '',
      customer: r.PARTNER_NAME || '',
      anomes:   r.ANO_MES_FIX  || '',
      valor:    Number(r.VENDA_VALOR) || 0,
    }));

    res.json(rows);

    // Salvar histórico no Drive de forma assíncrona (não bloqueia resposta)
    console.log(`[Drive] Iniciando saveRowsToDrive para ${rows.length} linhas...`);
    saveRowsToDrive(rows);
  } catch (err) {
    console.error('[Oracle] Erro:', err.message);
    res.status(500).json({ error: 'Erro ao consultar Oracle: ' + err.message });
  } finally {
    if (conn) {
      try { await conn.close(); } catch (_) {}
    }
  }
});

// ─────────────────────────────────────────
//  GET /listar-arquivos — lista todos os arquivos da pasta do Drive
// ─────────────────────────────────────────
app.get('/listar-arquivos', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

    const listResp = await drive.files.list({
      q:                         `'${folderId}' in parents and trashed = false`,
      fields:                    'files(id, name)',
      pageSize:                  1000,
      supportsAllDrives:         true,
      includeItemsFromAllDrives: true,
    });

    const files = (listResp.data.files || []).filter(f =>
      /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
    );

    files.sort((a, b) => {
      const da = parseDateFromFilename(a.name);
      const db = parseDateFromFilename(b.name);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return db - da; // mais recente primeiro
    });

    res.json(files.map(f => ({ id: f.id, name: f.name })));
  } catch (err) {
    console.error('[Drive] Erro ao listar arquivos:', err.message);
    res.status(500).json({ error: 'Erro ao listar arquivos do Drive: ' + err.message });
  }
});

// ─────────────────────────────────────────
//  GET /ultimo-arquivo — busca último arquivo do Drive
// ─────────────────────────────────────────
app.get('/ultimo-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

    let fileId   = req.query.fileId || null;
    let filename = null;

    if (!fileId) {
      // Sem fileId: busca o mais recente
      const listResp = await drive.files.list({
        q:                         `'${folderId}' in parents and trashed = false`,
        fields:                    'files(id, name)',
        pageSize:                  1000,
        supportsAllDrives:         true,
        includeItemsFromAllDrives: true,
      });

      const files = (listResp.data.files || []).filter(f =>
        /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
      );

      if (files.length === 0) {
        return res.status(404).json({ error: 'Nenhum arquivo encontrado na pasta do Drive.' });
      }

      files.sort((a, b) => {
        const da = parseDateFromFilename(a.name);
        const db = parseDateFromFilename(b.name);
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return db - da;
      });

      fileId   = files[0].id;
      filename = files[0].name;
    } else {
      // Com fileId: busca nome do arquivo
      const meta = await drive.files.get(
        { fileId, fields: 'name', supportsAllDrives: true }
      );
      filename = meta.data.name;
    }

    // Baixar conteúdo do arquivo
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );

    const buffer = Buffer.from(fileResp.data);

    res.json({
      filename,
      fileId,
      buffer: buffer.toString('base64'),
    });
  } catch (err) {
    console.error('[Drive] Erro ao buscar arquivo:', err.message);
    res.status(500).json({ error: 'Erro ao acessar Google Drive: ' + err.message });
  }
});

// ─────────────────────────────────────────
//  POST /upload-drive — salva arquivo no Drive
// ─────────────────────────────────────────
app.post('/upload-drive', upload.single('arquivo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  try {
    const drive    = getDriveClient();
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const filename = buildFilename(new Date());

    const up = await uploadDailyXlsx(drive, folderId, filename, req.file.buffer, hashData(req.file.buffer));

    res.json({
      success:  true,
      filename: up.name,
      fileId:   up.id,
      skipped:  up.skipped,
    });
  } catch (err) {
    console.error('[Drive] Erro ao fazer upload:', err.message);
    res.status(500).json({ error: 'Erro ao salvar no Google Drive: ' + err.message });
  }
});

// ─────────────────────────────────────────
//  POST /upload-log — salva PDF na pasta "Log audições"
//  Nome: relatorio_DD-MM-YYYY.pdf → _1, _2 ... se já existir
// ─────────────────────────────────────────
app.post('/upload-log', upload.single('arquivo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }
  try {
    const drive    = getDriveClient();
    const folderId = process.env.GOOGLE_DRIVE_LOG_FOLDER_ID;
    if (!folderId) throw new Error('GOOGLE_DRIVE_LOG_FOLDER_ID não configurado.');

    // Nome base com data de Brasília
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit', year: 'numeric',
    }).formatToParts(new Date());
    const d  = parts.find(p => p.type === 'day').value;
    const mo = parts.find(p => p.type === 'month').value;
    const y  = parts.find(p => p.type === 'year').value;
    const baseName = `relatorio_${d}-${mo}-${y}`;

    // Listar arquivos existentes na pasta para encontrar nome disponível
    const listResp = await drive.files.list({
      q:                         `'${folderId}' in parents and trashed = false`,
      fields:                    'files(name)',
      pageSize:                  1000,
      supportsAllDrives:         true,
      includeItemsFromAllDrives: true,
    });
    const existing = new Set((listResp.data.files || []).map(f => f.name));

    let filename = `${baseName}.pdf`;
    for (let i = 1; existing.has(filename); i++) {
      filename = `${baseName}_${i}.pdf`;
    }

    const { Readable } = require('stream');
    const stream = new Readable();
    stream.push(req.file.buffer);
    stream.push(null);

    const uploadResp = await drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType: 'application/pdf', body: stream },
      fields: 'id, name', supportsAllDrives: true,
    });

    console.log(`[Drive] Log PDF salvo: "${filename}" na pasta Log audições.`);
    res.json({ success: true, filename: uploadResp.data.name, fileId: uploadResp.data.id });
  } catch (err) {
    console.error('[Drive] Erro ao salvar log PDF:', err.message);
    res.status(500).json({ error: 'Erro ao salvar PDF no Drive: ' + err.message });
  }
});

// ─────────────────────────────────────────
//  GET /analise-inatividade — dias sem venda por distribuidora (janela d-60)
//  Retorna dados brutos de datas sem venda; o frontend agrupa por período.
//  Também salva o arquivo XLSX no Drive de forma assíncrona.
// ─────────────────────────────────────────
app.get('/analise-inatividade', async (req, res) => {
  let conn;
  try {
    conn = await getOracleConnection();

    // Janela fixa: hoje - 60 dias até hoje
    const cteBase = `
      WITH
        params AS (
          SELECT TRUNC(SYSDATE) - 60 AS DATA_INICIO,
                 TRUNC(SYSDATE)      AS DATA_FIM
          FROM dual
        ),
        calendario AS (
          SELECT p.DATA_INICIO + LEVEL - 1 AS DT
          FROM params p
          CONNECT BY p.DATA_INICIO + LEVEL - 1 <= p.DATA_FIM
        ),
        distribuidoras AS (
          SELECT DISTINCT PARTNER_NAME, MAX(CNPJ_CUSTOMER) AS CNPJ_CUSTOMER
          FROM sellers.bic_vendas_PARCEIRO
          WHERE VENDA_DATA >= (SELECT DATA_INICIO FROM params)
          GROUP BY PARTNER_NAME
        ),
        grade AS (
          SELECT d.PARTNER_NAME, d.CNPJ_CUSTOMER, c.DT,
                 TO_CHAR(c.DT, 'D') AS DIA_NUM
          FROM distribuidoras d
          CROSS JOIN calendario c
        ),
        vendas AS (
          SELECT PARTNER_NAME,
                 TRUNC(VENDA_DATA) AS DT,
                 SUM(VENDA_VALOR)  AS TOTAL_VENDA
          FROM sellers.bic_vendas_PARCEIRO
          WHERE VENDA_DATA >= (SELECT DATA_INICIO FROM params)
            AND VENDA_VALOR > 0
          GROUP BY PARTNER_NAME, TRUNC(VENDA_DATA)
        ),
        dias_sem_venda AS (
          SELECT g.PARTNER_NAME, g.CNPJ_CUSTOMER, g.DT, g.DIA_NUM
          FROM grade g
          LEFT JOIN vendas v
            ON v.PARTNER_NAME = g.PARTNER_NAME
           AND v.DT = g.DT
          WHERE v.DT IS NULL
        )`;

    // Datas individuais sem venda — o frontend agrupa por período/distribuidora/dia
    const resultDatas = await conn.execute(
      cteBase + `
      SELECT
        PARTNER_NAME,
        CNPJ_CUSTOMER,
        TO_CHAR(DT, 'DD/MM/YYYY') AS DATA_STR,
        TO_CHAR(DT, 'YYYY-MM-DD') AS DATA_ISO,
        DIA_NUM,
        (SELECT TO_CHAR(DATA_INICIO, 'DD/MM/YYYY') FROM params) AS DATA_INICIO_STR,
        (SELECT TO_CHAR(DATA_FIM,    'DD/MM/YYYY') FROM params) AS DATA_FIM_STR
      FROM dias_sem_venda
      ORDER BY PARTNER_NAME ASC, DT ASC`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const dataInicioStr = resultDatas.rows.length > 0 ? resultDatas.rows[0].DATA_INICIO_STR : null;
    const dataFimStr    = resultDatas.rows.length > 0 ? resultDatas.rows[0].DATA_FIM_STR    : null;

    // Agrupar datas individuais por partner + capturar CNPJ
    const detalhe = {};
    const cnpjMap = {};
    resultDatas.rows.forEach(r => {
      const p = r.PARTNER_NAME || '';
      if (!detalhe[p]) detalhe[p] = [];
      // DIA_NUM do Oracle: 1=Dom..7=Sáb → converter para JS: 0=Dom..6=Sáb
      detalhe[p].push({ data: r.DATA_STR, iso: r.DATA_ISO, diaNum: (Number(r.DIA_NUM) - 1 + 7) % 7 });
      if (!cnpjMap[p] && r.CNPJ_CUSTOMER) cnpjMap[p] = r.CNPJ_CUSTOMER;
    });

    res.json({ dataInicio: dataInicioStr, dataFim: dataFimStr, detalhe, cnpjMap });

    // Salvar XLSX no Drive de forma assíncrona (não bloqueia a resposta)
    saveInativToDrive({ dataInicio: dataInicioStr, dataFim: dataFimStr, detalhe, cnpjMap });
  } catch (err) {
    console.error('[Oracle] Erro /analise-inatividade:', err.message);
    res.status(500).json({ error: 'Erro ao consultar Oracle: ' + err.message });
  } finally {
    if (conn) {
      try { await conn.close(); } catch (_) {}
    }
  }
});

// ─────────────────────────────────────────
//  Utilitário — nome de arquivo de inatividade com data de Brasília
// ─────────────────────────────────────────
function buildInativFilename() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(new Date());
  const d  = parts.find(p => p.type === 'day').value;
  const mo = parts.find(p => p.type === 'month').value;
  const y  = parts.find(p => p.type === 'year').value;
  return { baseName: `inatividade_${d}-${mo}-${y}`, dateStr: `${d}-${mo}-${y}` };
}

// ─────────────────────────────────────────
//  Utilitário — gera XLSX de inatividade e salva no Drive (chamado pelo backend)
// ─────────────────────────────────────────
async function saveInativToDrive({ dataInicio, dataFim, detalhe, cnpjMap }) {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.GOOGLE_DRIVE_INATIV_FOLDER_ID;
    if (!folderId) { console.warn('[Drive] GOOGLE_DRIVE_INATIV_FOLDER_ID não configurado.'); return; }

    const { baseName } = buildInativFilename();
    const filename = `${baseName}.xlsx`;

    // Montar aba Detalhe com todas as datas brutas
    const nomeDia = ['Domingo','Segunda-feira','Terca-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sabado'];
    const detalheRows = [];
    Object.keys(detalhe).forEach(partner => {
      const cnpj = (cnpjMap || {})[partner] || '';
      (detalhe[partner] || []).forEach(d => {
        // diaNum já está em formato JS 0-6
        detalheRows.push({
          PARTNER_NAME: partner,
          CNPJ:         cnpj,
          DATA:         d.data,
          ISO:          d.iso,
          DIA_NUM:      d.diaNum,
          DIA_SEMANA:   nomeDia[d.diaNum] || '',
        });
      });
    });

    const agora = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date());

    const meta = [
      { CHAVE: 'dataInicio',          VALOR: dataInicio || '' },
      { CHAVE: 'dataFim',             VALOR: dataFim    || '' },
      { CHAVE: 'geradoEm',            VALOR: agora },
      { CHAVE: 'totalDistribuidoras', VALOR: Object.keys(detalhe).length },
      { CHAVE: 'totalOcorrencias',    VALOR: detalheRows.length },
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detalheRows), 'Detalhe');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(meta),        'Meta');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // geradoEm fica fora do hash — muda a cada execução
    const dataHash = hashData({ dataInicio, dataFim, detalheRows });
    const up = await uploadDailyXlsx(drive, folderId, filename, buffer, dataHash);
    if (!up.skipped) console.log(`[Drive] Inatividade salva no Drive: "${filename}" (${detalheRows.length} ocorrências).`);
  } catch (err) {
    console.error('[Drive] Erro ao salvar inatividade:', err.message);
  }
}

// ─────────────────────────────────────────
//  POST /upload-inatividade — salva XLSX na pasta de histórico de inatividade
// ─────────────────────────────────────────
app.post('/upload-inatividade', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  try {
    const drive    = getDriveClient();
    const folderId = process.env.GOOGLE_DRIVE_INATIV_FOLDER_ID;
    if (!folderId) throw new Error('GOOGLE_DRIVE_INATIV_FOLDER_ID não configurado.');

    const { baseName } = buildInativFilename();
    const filename = `${baseName}.xlsx`;

    const up = await uploadDailyXlsx(drive, folderId, filename, req.file.buffer, hashData(req.file.buffer));

    if (!up.skipped) console.log(`[Drive] Inatividade salva: "${filename}".`);
    res.json({ success: true, filename: up.name, fileId: up.id, skipped: up.skipped });
  } catch (err) {
    console.error('[Drive] Erro ao salvar inatividade:', err.message);
    res.status(500).json({ error: 'Erro ao salvar no Drive: ' + err.message });
  }
});

// ─────────────────────────────────────────
//  GET /listar-inatividade — lista arquivos XLSX de inatividade
// ─────────────────────────────────────────
app.get('/listar-inatividade', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.GOOGLE_DRIVE_INATIV_FOLDER_ID;
    if (!folderId) return res.json([]);

    const listResp = await drive.files.list({
      q:                         `'${folderId}' in parents and trashed = false`,
      fields:                    'files(id, name, createdTime)',
      orderBy:                   'createdTime desc',
      pageSize:                  1000,
      supportsAllDrives:         true,
      includeItemsFromAllDrives: true,
    });

    const files = (listResp.data.files || []).filter(f =>
      /^inatividade_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
    );

    res.json(files.map(f => ({ id: f.id, name: f.name, createdTime: f.createdTime })));
  } catch (err) {
    console.error('[Drive] Erro ao listar inatividade:', err.message);
    res.status(500).json({ error: 'Erro ao listar arquivos: ' + err.message });
  }
});

// ─────────────────────────────────────────
//  GET /get-inatividade?fileId= — baixa arquivo específico de inatividade
// ─────────────────────────────────────────
app.get('/get-inatividade', async (req, res) => {
  try {
    const drive  = getDriveClient();
    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório.' });

    const meta = await drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );

    const buffer = Buffer.from(fileResp.data);
    res.json({ filename: meta.data.name, fileId, buffer: buffer.toString('base64') });
  } catch (err) {
    console.error('[Drive] Erro ao baixar arquivo de inatividade:', err.message);
    res.status(500).json({ error: 'Erro ao acessar arquivo: ' + err.message });
  }
});

// ─────────────────────────────────────────
//  Utilitário — nome de arquivo de De-Para com data de Brasília
// ─────────────────────────────────────────
function buildDeParaFilename() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(new Date());
  const d  = parts.find(p => p.type === 'day').value;
  const mo = parts.find(p => p.type === 'month').value;
  const y  = parts.find(p => p.type === 'year').value;
  return { baseName: `depara_${d}-${mo}-${y}`, dateStr: `${d}-${mo}-${y}` };
}

// ─────────────────────────────────────────
//  Utilitário — gera XLSX de De-Para e salva no Drive
// ─────────────────────────────────────────
async function saveDeParaToDrive(rows) {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.GOOGLE_DRIVE_DEPARA_FOLDER_ID;
    if (!folderId) { console.warn('[Drive] GOOGLE_DRIVE_DEPARA_FOLDER_ID não configurado.'); return; }

    const { baseName } = buildDeParaFilename();
    const filename = `${baseName}.xlsx`;

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'De-Para');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const up = await uploadDailyXlsx(drive, folderId, filename, buffer, hashData(rows));
    if (!up.skipped) console.log(`[Drive] De-Para salvo no Drive: "${filename}" (${rows.length} linhas).`);
  } catch (err) {
    console.error('[Drive] Erro ao salvar De-Para:', err.message);
  }
}

// ─────────────────────────────────────────
//  GET /de-para — busca análise De>Para do Oracle e salva no Drive
// ─────────────────────────────────────────
app.get('/de-para', async (req, res) => {
  let conn;
  try {
    conn = await getOracleConnection();

    // Período fixo: últimos 90 dias (calculado no Oracle para evitar problemas de tipo)
    const dtFim    = new Date();
    const dtInicio = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const result = await conn.execute(
      `SELECT
         "CNPJ_CUSTOMER"            AS "CNPJ_CUSTOMER",
         "PARTNER_NAME"             AS "PARTNER_NAME",
         "PRODUTO_CODIGO_EAN"       AS "PRODUTO_CODIGO_EAN",
         "INTERNAL_CODE"            AS "INTERNAL_CODE",
         "SKU"                      AS "SKU",
         "PRODUTO_NOME"             AS "PRODUTO_NOME",
         "PARCEIRO_PRODUTO_CODIGO_EAN" AS "PARCEIRO_PRODUTO_CODIGO_EAN",
         "PARCEIRO_PRODUTO_NOME"    AS "PARCEIRO_PRODUTO_NOME",
         "SKU_PARTNER"              AS "SKU_PARTNER",
         "MATCH_UPDATED_BY"         AS "MATCH_UPDATED_BY",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.bic_vendas_PARCEIRO v0
       WHERE "VENDA_DATA" BETWEEN SYSDATE - 90 AND SYSDATE
         AND TO_CHAR("MATCH_UPDATED_BY") <> 'job_bq_bic_0'
         AND "IS_KIT" = 'NÃO'
       GROUP BY
         "CNPJ_CUSTOMER", "PARTNER_NAME",
         "PRODUTO_CODIGO_EAN", "INTERNAL_CODE", "SKU", "PRODUTO_NOME",
         "PARCEIRO_PRODUTO_CODIGO_EAN", "PARCEIRO_PRODUTO_NOME",
         "SKU_PARTNER", "MATCH_UPDATED_BY"
       ORDER BY VENDA_VALOR DESC`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const rows = result.rows.map(r => ({
      CNPJ_CUSTOMER:            r.CNPJ_CUSTOMER             || '',
      PARTNER_NAME:             r.PARTNER_NAME              || '',
      PRODUTO_CODIGO_EAN:       r.PRODUTO_CODIGO_EAN        || '',
      INTERNAL_CODE:            r.INTERNAL_CODE             || '',
      SKU:                      r.SKU                       || '',
      PRODUTO_NOME:             r.PRODUTO_NOME              || '',
      PARCEIRO_PRODUTO_CODIGO_EAN: r.PARCEIRO_PRODUTO_CODIGO_EAN || '',
      PARCEIRO_PRODUTO_NOME:    r.PARCEIRO_PRODUTO_NOME     || '',
      SKU_PARTNER:              r.SKU_PARTNER               || '',
      MATCH_UPDATED_BY:         r.MATCH_UPDATED_BY          || '',
      VENDA_VALOR:              Number(r.VENDA_VALOR)       || 0,
    }));

    // Formata período para exibição
    const fmtDate = d => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    res.json({ rows, periodo: { inicio: fmtDate(dtInicio), fim: fmtDate(dtFim) } });

    // Salvar no Drive de forma assíncrona
    saveDeParaToDrive(rows);
  } catch (err) {
    console.error('[Oracle] Erro /de-para:', err.message);
    res.status(500).json({ error: 'Erro ao consultar Oracle: ' + err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ─────────────────────────────────────────
//  GET /listar-depara — lista arquivos XLSX de De-Para no Drive
// ─────────────────────────────────────────
app.get('/listar-depara', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.GOOGLE_DRIVE_DEPARA_FOLDER_ID;
    if (!folderId) return res.json([]);

    const listResp = await drive.files.list({
      q:                         `'${folderId}' in parents and trashed = false`,
      fields:                    'files(id, name, createdTime)',
      orderBy:                   'createdTime desc',
      pageSize:                  1000,
      supportsAllDrives:         true,
      includeItemsFromAllDrives: true,
    });

    const files = (listResp.data.files || []).filter(f =>
      /^depara_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
    );

    res.json(files.map(f => ({ id: f.id, name: f.name, createdTime: f.createdTime })));
  } catch (err) {
    console.error('[Drive] Erro ao listar De-Para:', err.message);
    res.status(500).json({ error: 'Erro ao listar arquivos: ' + err.message });
  }
});

// ─────────────────────────────────────────
//  GET /get-depara?fileId= — baixa arquivo específico de De-Para
// ─────────────────────────────────────────
app.get('/get-depara', async (req, res) => {
  try {
    const drive  = getDriveClient();
    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório.' });

    const meta = await drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );

    const buffer = Buffer.from(fileResp.data);
    res.json({ filename: meta.data.name, fileId, buffer: buffer.toString('base64') });
  } catch (err) {
    console.error('[Drive] Erro ao baixar De-Para:', err.message);
    res.status(500).json({ error: 'Erro ao acessar arquivo: ' + err.message });
  }
});

// ─────────────────────────────────────────
//  Utilitário — gera XLSX de histórico de vendas e salva no Drive
// ─────────────────────────────────────────
async function saveHistoricoToDrive(rows) {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
    if (!folderId) { console.warn('[Drive] GOOGLE_DRIVE_HISTORICO_FOLDER_ID não configurado.'); return; }

    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit', year: 'numeric',
    }).formatToParts(new Date());
    const d  = parts.find(p => p.type === 'day').value;
    const mo = parts.find(p => p.type === 'month').value;
    const y  = parts.find(p => p.type === 'year').value;
    const baseName = `historico_${d}-${mo}-${y}`;
    const filename = `${baseName}.xlsx`;

    const wsData = rows.map(r => ({
      HOLDING:      r.holding,
      PARTNER_NAME: r.partnerName,
      CNPJ:         r.cnpj,
      ANO_MES:      r.anoMes,
      VENDA_VALOR:  r.valor,
    }));
    const ws = XLSX.utils.json_to_sheet(wsData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Histórico');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const up = await uploadDailyXlsx(drive, folderId, filename, buffer, hashData(wsData));
    if (!up.skipped) console.log(`[Drive] Histórico salvo no Drive: "${filename}" (${rows.length} linhas).`);
  } catch (err) {
    console.error('[Drive] Erro ao salvar histórico:', err.message);
  }
}

// ─────────────────────────────────────────
//  GET /historico-vendas — histórico de vendas por distribuidora/mês
// ─────────────────────────────────────────
app.get('/historico-vendas', async (req, res) => {
  let conn;
  try {
    conn = await getOracleConnection();

    const result = await conn.execute(
      `SELECT
         "HOLDING"                            AS "HOLDING",
         "PARTNER_NAME"                       AS "PARTNER_NAME",
         "CNPJ_CUSTOMER"                      AS "CNPJ_CUSTOMER",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')       AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)      AS "VENDA_VALOR"
       FROM sellers.bic_vendas_PARCEIRO v0
       GROUP BY
         "HOLDING",
         "PARTNER_NAME",
         "CNPJ_CUSTOMER",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')
       ORDER BY "PARTNER_NAME" ASC, "ANO_MES_FIX" ASC`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const rows = result.rows.map(r => ({
      holding:     r.HOLDING       || '',
      partnerName: r.PARTNER_NAME  || '',
      cnpj:        r.CNPJ_CUSTOMER || '',
      anoMes:      r.ANO_MES_FIX   || '',
      valor:       Number(r.VENDA_VALOR) || 0,
    }));

    res.json(rows);

    // Salvar no Drive de forma assíncrona
    saveHistoricoToDrive(rows);
  } catch (err) {
    console.error('[Oracle] Erro /historico-vendas:', err.message);
    res.status(500).json({ error: 'Erro ao consultar Oracle: ' + err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ─────────────────────────────────────────
//  Health check
// ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────
//  GET /atualizar-tudo — SSE: Oracle sellout + inatividade → Drive
//  Eventos: { pct, step, msg }   Evento final: { done: true }
// ─────────────────────────────────────────
app.get('/atualizar-tudo', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = (pct, step, msg) => {
    res.write(`data: ${JSON.stringify({ pct, step, msg })}\n\n`);
  };

  let conn;
  try {
    // ── PASSO 1: Conectar ao Oracle ──────────────────────
    emit(5, 1, 'Conectando ao Oracle…');
    conn = await getOracleConnection();

    // ── PASSO 2: Buscar dados de sellout ─────────────────
    emit(15, 2, 'Buscando dados de sellout (Oracle)…');
    const selloutResult = await conn.execute(
      `SELECT
         "HOLDING"                        AS "HOLDING",
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.bic_vendas_PARCEIRO v0
       WHERE "VENDA_DATA" BETWEEN TRUNC(SYSDATE, 'YEAR') AND SYSDATE
       GROUP BY
         "HOLDING",
         "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')
       ORDER BY HOLDING ASC`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const selloutRows = selloutResult.rows.map(r => ({
      holding:  r.HOLDING      || '',
      customer: r.PARTNER_NAME || '',
      anomes:   r.ANO_MES_FIX  || '',
      valor:    Number(r.VENDA_VALOR) || 0,
    }));
    emit(35, 2, `Sellout: ${selloutRows.length.toLocaleString('pt-BR')} registros obtidos.`);

    // ── PASSO 3: Buscar dados de inatividade ─────────────
    emit(40, 3, 'Buscando dados de inatividade (Oracle)…');
    const cteBase = `
      WITH
        params AS (
          SELECT TRUNC(SYSDATE) - 60 AS DATA_INICIO,
                 TRUNC(SYSDATE)      AS DATA_FIM
          FROM dual
        ),
        calendario AS (
          SELECT p.DATA_INICIO + LEVEL - 1 AS DT
          FROM params p
          CONNECT BY p.DATA_INICIO + LEVEL - 1 <= p.DATA_FIM
        ),
        distribuidoras AS (
          SELECT DISTINCT PARTNER_NAME, MAX(CNPJ_CUSTOMER) AS CNPJ_CUSTOMER
          FROM sellers.bic_vendas_PARCEIRO
          WHERE VENDA_DATA >= (SELECT DATA_INICIO FROM params)
          GROUP BY PARTNER_NAME
        ),
        grade AS (
          SELECT d.PARTNER_NAME, d.CNPJ_CUSTOMER, c.DT,
                 TO_CHAR(c.DT, 'D') AS DIA_NUM
          FROM distribuidoras d
          CROSS JOIN calendario c
        ),
        vendas AS (
          SELECT PARTNER_NAME,
                 TRUNC(VENDA_DATA) AS DT,
                 SUM(VENDA_VALOR)  AS TOTAL_VENDA
          FROM sellers.bic_vendas_PARCEIRO
          WHERE VENDA_DATA >= (SELECT DATA_INICIO FROM params)
            AND VENDA_VALOR > 0
          GROUP BY PARTNER_NAME, TRUNC(VENDA_DATA)
        ),
        dias_sem_venda AS (
          SELECT g.PARTNER_NAME, g.CNPJ_CUSTOMER, g.DT, g.DIA_NUM
          FROM grade g
          LEFT JOIN vendas v
            ON v.PARTNER_NAME = g.PARTNER_NAME
           AND v.DT = g.DT
          WHERE v.DT IS NULL
        )`;

    const resultDatas = await conn.execute(
      cteBase + `
      SELECT
        PARTNER_NAME,
        CNPJ_CUSTOMER,
        TO_CHAR(DT, 'DD/MM/YYYY') AS DATA_STR,
        TO_CHAR(DT, 'YYYY-MM-DD') AS DATA_ISO,
        DIA_NUM,
        (SELECT TO_CHAR(DATA_INICIO, 'DD/MM/YYYY') FROM params) AS DATA_INICIO_STR,
        (SELECT TO_CHAR(DATA_FIM,    'DD/MM/YYYY') FROM params) AS DATA_FIM_STR
      FROM dias_sem_venda
      ORDER BY PARTNER_NAME ASC, DT ASC`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const dataInicioStr = resultDatas.rows.length > 0 ? resultDatas.rows[0].DATA_INICIO_STR : null;
    const dataFimStr    = resultDatas.rows.length > 0 ? resultDatas.rows[0].DATA_FIM_STR    : null;
    const detalhe = {};
    const cnpjMap = {};
    resultDatas.rows.forEach(r => {
      const p = r.PARTNER_NAME || '';
      if (!detalhe[p]) detalhe[p] = [];
      detalhe[p].push({ data: r.DATA_STR, iso: r.DATA_ISO, diaNum: (Number(r.DIA_NUM) - 1 + 7) % 7 });
      if (!cnpjMap[p] && r.CNPJ_CUSTOMER) cnpjMap[p] = r.CNPJ_CUSTOMER;
    });
    emit(55, 3, `Inatividade: ${resultDatas.rows.length.toLocaleString('pt-BR')} registros obtidos.`);

    // ── PASSO 4 (Oracle): Buscar De-Para ─────────────────
    emit(60, 4, 'Buscando análise De-Para (Oracle)…');
    const deParaResult = await conn.execute(
      `SELECT
         "CNPJ_CUSTOMER"               AS "CNPJ_CUSTOMER",
         "PARTNER_NAME"                AS "PARTNER_NAME",
         "PRODUTO_CODIGO_EAN"          AS "PRODUTO_CODIGO_EAN",
         "INTERNAL_CODE"               AS "INTERNAL_CODE",
         "SKU"                         AS "SKU",
         "PRODUTO_NOME"                AS "PRODUTO_NOME",
         "PARCEIRO_PRODUTO_CODIGO_EAN" AS "PARCEIRO_PRODUTO_CODIGO_EAN",
         "PARCEIRO_PRODUTO_NOME"       AS "PARCEIRO_PRODUTO_NOME",
         "SKU_PARTNER"                 AS "SKU_PARTNER",
         "MATCH_UPDATED_BY"            AS "MATCH_UPDATED_BY",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.bic_vendas_PARCEIRO v0
       WHERE "VENDA_DATA" BETWEEN SYSDATE - 90 AND SYSDATE
         AND TO_CHAR("MATCH_UPDATED_BY") <> 'job_bq_bic_0'
         AND "IS_KIT" = 'NÃO'
       GROUP BY
         "CNPJ_CUSTOMER", "PARTNER_NAME",
         "PRODUTO_CODIGO_EAN", "INTERNAL_CODE", "SKU", "PRODUTO_NOME",
         "PARCEIRO_PRODUTO_CODIGO_EAN", "PARCEIRO_PRODUTO_NOME",
         "SKU_PARTNER", "MATCH_UPDATED_BY"
       ORDER BY VENDA_VALOR DESC`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const deParaRows = deParaResult.rows.map(r => ({
      CNPJ_CUSTOMER:               r.CNPJ_CUSTOMER             || '',
      PARTNER_NAME:                r.PARTNER_NAME              || '',
      PRODUTO_CODIGO_EAN:          r.PRODUTO_CODIGO_EAN        || '',
      INTERNAL_CODE:               r.INTERNAL_CODE             || '',
      SKU:                         r.SKU                       || '',
      PRODUTO_NOME:                r.PRODUTO_NOME              || '',
      PARCEIRO_PRODUTO_CODIGO_EAN: r.PARCEIRO_PRODUTO_CODIGO_EAN || '',
      PARCEIRO_PRODUTO_NOME:       r.PARCEIRO_PRODUTO_NOME     || '',
      SKU_PARTNER:                 r.SKU_PARTNER               || '',
      MATCH_UPDATED_BY:            r.MATCH_UPDATED_BY          || '',
      VENDA_VALOR:                 Number(r.VENDA_VALOR)       || 0,
    }));
    emit(68, 4, `De-Para: ${deParaRows.length.toLocaleString('pt-BR')} registros obtidos.`);

    // ── PASSO 5 (Oracle): Buscar Histórico de Vendas ─────
    emit(72, 5, 'Buscando histórico de vendas (Oracle)…');
    const historicoResult = await conn.execute(
      `SELECT
         "HOLDING"                       AS "HOLDING",
         "PARTNER_NAME"                  AS "PARTNER_NAME",
         "CNPJ_CUSTOMER"                 AS "CNPJ_CUSTOMER",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')  AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.bic_vendas_PARCEIRO v0
       GROUP BY
         "HOLDING",
         "PARTNER_NAME",
         "CNPJ_CUSTOMER",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')
       ORDER BY "PARTNER_NAME" ASC, "ANO_MES_FIX" ASC`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const historicoRows = historicoResult.rows.map(r => ({
      holding:     r.HOLDING       || '',
      partnerName: r.PARTNER_NAME  || '',
      cnpj:        r.CNPJ_CUSTOMER || '',
      anoMes:      r.ANO_MES_FIX   || '',
      valor:       Number(r.VENDA_VALOR) || 0,
    }));
    emit(78, 5, `Histórico: ${historicoRows.length.toLocaleString('pt-BR')} registros obtidos.`);

    await conn.close();
    conn = null;

    // ── PASSO 6: Salvar sellout no Drive ─────────────────
    emit(82, 6, 'Salvando relatório de sellout no Drive…');
    await saveRowsToDrive(selloutRows);
    emit(86, 6, 'Sellout salvo no Drive.');

    // ── PASSO 7: Salvar inatividade no Drive ─────────────
    emit(88, 7, 'Salvando snapshot de inatividade no Drive…');
    await saveInativToDrive({ dataInicio: dataInicioStr, dataFim: dataFimStr, detalhe, cnpjMap });
    emit(91, 7, 'Inatividade salva no Drive.');

    // ── PASSO 8: Salvar De-Para no Drive ──────────────────
    emit(93, 8, 'Salvando análise De-Para no Drive…');
    await saveDeParaToDrive(deParaRows);
    emit(96, 8, 'De-Para salvo no Drive.');

    // ── PASSO 9: Salvar Histórico no Drive ────────────────
    emit(97, 9, 'Salvando histórico de vendas no Drive…');
    await saveHistoricoToDrive(historicoRows);
    emit(99, 9, 'Histórico salvo no Drive.');

    // (Passo 10 — usuários — saiu daqui: agora é extração geral em /geral/atualizar-tudo)

    // ── PASSO 11: Batalha Naval no Drive ──────────────────
    emit(99, 11, 'Salvando Batalha Naval no Drive…');
    await saveBatalhaNavalToDrive();
    emit(100, 11, 'Batalha Naval salva no Drive.');

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[atualizar-tudo] Erro:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  } finally {
    if (conn) {
      try { await conn.close(); } catch (_) {}
    }
  }
});

// ─────────────────────────────────────────
//  GERAL — extrações sem vínculo de indústria
//  GET /geral/atualizar-tudo (SSE) — roda na atualização diária (scripts/atualizar-todos.js)
// ─────────────────────────────────────────

// Indústrias do portal e como cada uma marca suas distribuidoras no Postgres.
// Uma distribuidora só pertence à indústria se tiver OS DOIS:
//   1) partnership ativa com a organização da indústria (orgId = uuid_partnerships), e
//   2) o código da indústria em organization.project_list_array / organization.project (codigos)
//      ou em organization.group_name (grupos — só M Dias; o mBic do group_name é desconsiderado).
const INDUSTRIAS_USUARIOS = [
  { nome: 'BIC',              orgId: '4d4e55fc-9320-4813-9cad-8ea8c357879e', codigos: ['mBic'] },
  { nome: 'Asa',              orgId: '223dc5b2-5a36-4c77-b8cc-7e698143317e', codigos: ['ASA-IND'] },
  { nome: 'Bombril',          orgId: '7872e618-32b1-4551-a7fc-887a805328b4', codigos: ['BOMBRIL'] },
  { nome: 'Cicopal',          orgId: '66ce40b9-0a08-403e-a981-42413243b9f5', codigos: ['CICOPAL'] },
  { nome: 'Fini',             orgId: 'bef7ab53-d284-4cd5-bbbb-bb638eacd320', codigos: ['FINI'] },
  { nome: 'Fruki',            orgId: 'e2d95ccd-f0d3-434f-a2b9-e707f2e691f7', codigos: ['FRUKI'] },
  { nome: 'Gallo',            orgId: '9a778ecf-9835-4c10-b977-fd333f1c6a3f', codigos: ['GALLO'] },
  { nome: 'Gtex',             orgId: 'fc281653-c8ec-46f2-9c59-41f42ef3fd82', codigos: ['GTEX'] },
  { nome: 'Kibon',            orgId: '6d2fa84a-c01a-4c79-a8b2-3b557319ebc5', codigos: ['UNILEVER-KIBON'] },
  { nome: 'Marilan',          orgId: '6c09c425-a40e-4135-8be1-4d76f494d653', codigos: ['MARILAN'] },
  { nome: 'M Dias',           orgId: '04645518-424f-44a1-a1f8-7128a253b923', codigos: ['MDIAS', 'mDiasBranco'], grupos: ['mDiasBranco'] },
  { nome: 'M Dias Saudáveis', orgId: '0c30a4c7-6c65-4f2e-b7ea-c8dff61ef0f2', codigos: ['saudaveis'],            grupos: ['mDiasBrancoSaudaveis'] },
  { nome: 'Peccin',           orgId: '2bb30205-3b55-4bf7-bc72-5ce17793ed79', codigos: ['PECCIN'] },
  { nome: 'Pepsico',          orgId: 'a90f7541-97b5-4da5-a133-76422d1982f2', codigos: ['PEPSICO'] },  { nome: 'Ultracheese',      orgId: '27c5050f-b03a-40e2-ad18-5fee264974b9', codigos: ['ULTRACHEESE'] },
];

// Usuários de todas as organizações ativas (consulta aberta, sem filtro de indústria)
const SQL_USUARIOS_GERAL = `
  SELECT
    o.id::text   AS organization_id,
    o.account_name,
    uo.user_name,
    uo.user_id,
    uo.email,
    uo.profile_name,
    EXISTS (
      SELECT 1 FROM user_permission up
       WHERE up.id_user = uo.user_id
         AND up.id_permission = 'ed1fc65f-f7ba-457f-a8b2-dd963999ed4b'
         AND up.uuid_organization = uo.organization_id
    ) AS has_permission
  FROM public.user_organization AS uo
  JOIN organization o ON uo.organization_id = o.id AND o.delete_on IS NULL
  WHERE uo.profile_name <> 'VENDEDOR'
    AND uo.email NOT LIKE '%sellers%'
    AND uo.delete_on IS NULL
  ORDER BY o.account_name, uo.user_name
`;

// Códigos e parcerias de cada organização ativa
const SQL_VINCULOS_GERAL = `
  SELECT o.id::text AS organization_id,
         COALESCE(o.project_list_array, '{}') || CASE WHEN o.project IS NULL THEN '{}'::varchar[] ELSE ARRAY[o.project]::varchar[] END AS codigos,
         o.group_name AS grupo,
         ARRAY(SELECT p.uuid_partnerships FROM partnership p
                WHERE p.uuid_organization = o.id::text AND p.delete_on IS NULL AND p.finished_on IS NULL) AS parceiros
    FROM organization o
   WHERE o.delete_on IS NULL
`;

// Indústrias do portal de uma organização (vazio = nenhuma)
function industriasDaOrg(orgId, v) {
  const propria = INDUSTRIAS_USUARIOS.find(i => i.orgId === orgId);
  if (propria) return [{ ind: propria, tipo: 'Indústria' }];
  if (!v) return [];
  return INDUSTRIAS_USUARIOS
    .filter(i => (v.parceiros || []).includes(i.orgId)
      && ((v.codigos || []).some(c => i.codigos.includes(c)) || (i.grupos || []).includes(v.grupo)))
    .map(ind => ({ ind, tipo: 'Distribuidor' }));
}

// Uma linha por usuário × organização × indústria (só vínculos válidos)
async function consultarUsuariosGeral() {
  const [usu, vinc] = await Promise.all([pgPool.query(SQL_USUARIOS_GERAL), pgPool.query(SQL_VINCULOS_GERAL)]);
  const porOrg = new Map(vinc.rows.map(v => [v.organization_id, v]));
  const linhas = [];
  for (const r of usu.rows) {
    for (const { ind, tipo } of industriasDaOrg(r.organization_id, porOrg.get(r.organization_id))) {
      linhas.push({
        Industria:      ind.nome,
        Tipo:           tipo,
        Empresa:        r.account_name,
        Id_Organizacao: r.organization_id,
        Nome:           r.user_name,
        Id_Usuario:     r.user_id,
        Email:          r.email,
        Perfil:         r.profile_name,
        Tem_Permissao:  r.has_permission ? 'Sim' : 'Não',
      });
    }
  }
  return linhas;
}

// Snapshot diário: usuarios_DD-MM-AAAA.xlsx, aba "Usuarios", na pasta GOOGLE_DRIVE_USUARIOS_FOLDER_ID
async function saveUsuariosToDrive() {
  const drive    = getDriveClient();
  const folderId = process.env.GOOGLE_DRIVE_USUARIOS_FOLDER_ID;

  const now = new Date();
  const dd  = String(now.getDate()).padStart(2, '0');
  const mm  = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const filename = `usuarios_${dd}-${mm}-${yyyy}.xlsx`;

  const rows = await consultarUsuariosGeral();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Usuarios');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const up = await uploadDailyXlsx(drive, folderId, filename, buffer, hashData(rows));
  if (!up.skipped) console.log(`[Drive] Usuários (geral) salvos: "${filename}" (${rows.length} linhas).`);
  return { linhas: rows.length, skipped: !!up.skipped };
}

// ─────────────────────────────────────────
//  GERAL — Coordenadores (BigQuery, só manual — fora da atualização diária)
//  POST /geral/coordenadores → grava coordenadores_DD-MM-AAAA.xlsx na pasta dos usuários
//  Fonte: bigdata.partner_user_permission (usuários da indústria vinculados a cada distribuidora)
// ─────────────────────────────────────────
const SQL_COORDENADORES = 'SELECT * FROM `bigdata.partner_user_permission`';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function consultarCoordenadores() {
  const { BigQuery } = require('@google-cloud/bigquery');
  const bq = new BigQuery({ projectId: process.env.BIGQUERY_PROJECT_ID });
  const [rows] = await bq.query({ query: SQL_COORDENADORES });

  // Indústria pelo uuid (o organization_name da tabela varia: "BIC", "BIC BRASIL S.A.", "{nome_indistria}"…)
  const porOrg = new Map(INDUSTRIAS_USUARIOS.map(i => [i.orgId, i.nome]));
  const vistos = new Set();
  const linhas = [];
  for (const r of rows) {
    const idInd  = String(r.uuid_organization || '').trim();
    const idDist = String(r.uuid_organization_partner || '').trim();
    const email  = String(r.email || '').trim().toLowerCase();
    if (!UUID_RE.test(idDist) || !email.includes('@')) continue;
    const chave = `${idInd}|${idDist}|${email}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    linhas.push({
      Industria:      porOrg.get(idInd) || String(r.organization_name || '').trim(),
      Id_Industria:   idInd,
      Id_Organizacao: idDist,
      Empresa:        String(r.partner_name || '').trim(),
      Nome:           String(r.user_name || '').trim(),
      Email:          email,
    });
  }
  linhas.sort((a, b) => a.Industria.localeCompare(b.Industria, 'pt-BR') || a.Empresa.localeCompare(b.Empresa, 'pt-BR') || a.Nome.localeCompare(b.Nome, 'pt-BR'));
  return { linhas, lidas: rows.length };
}

async function saveCoordenadoresToDrive() {
  const drive    = getDriveClient();
  const folderId = process.env.GOOGLE_DRIVE_USUARIOS_FOLDER_ID;
  const now  = new Date();
  const dd   = String(now.getDate()).padStart(2, '0');
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const filename = `coordenadores_${dd}-${mm}-${now.getFullYear()}.xlsx`;

  const { linhas, lidas } = await consultarCoordenadores();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhas), 'Coordenadores');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const up = await uploadDailyXlsx(drive, folderId, filename, buffer, hashData(linhas));
  console.log(`[Drive] Coordenadores ${up.skipped ? 'sem mudança' : 'salvos'}: "${filename}" (${linhas.length} de ${lidas} linhas do BigQuery).`);

  const porIndustria = {};
  for (const l of linhas) porIndustria[l.Industria] = (porIndustria[l.Industria] || 0) + 1;
  return { arquivo: filename, linhas: linhas.length, lidas, skipped: !!up.skipped, porIndustria };
}

app.post('/geral/coordenadores', async (req, res) => {
  try {
    res.json({ ok: true, ...(await saveCoordenadoresToDrive()) });
  } catch (err) {
    console.error('[geral/coordenadores] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/geral/atualizar-tudo', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  const emit = (pct, step, msg) => res.write(`data: ${JSON.stringify({ pct, step, msg })}\n\n`);

  try {
    // ── PASSO 1: Usuários (Postgres → Drive) ─────────────
    emit(10, 1, 'Consultando usuários (PostgreSQL)…');
    const u = await saveUsuariosToDrive();
    emit(100, 1, u.skipped ? `Usuários sem mudança (${u.linhas}).` : `Usuários salvos no Drive (${u.linhas}).`);

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    console.error('[geral/atualizar-tudo] Erro:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

app.get('/usuarios', async (req, res) => {
  try {
    res.json(await consultarUsuariosGeral());
  } catch (err) {
    console.error('[PG] Erro /usuarios:', err.message);
    res.status(500).json({ error: 'Erro ao consultar PostgreSQL: ' + err.message });
  }
});

// ─────────────────────────────────────────
//  Batalha Naval — gerar e salvar no Drive
// ─────────────────────────────────────────
async function saveBatalhaNavalToDrive() {
  let conn;
  try {
    conn = await getOracleConnection();

    const result = await conn.execute(
      `SELECT
         "HOLDING"                              AS "HOLDING",
         "CNPJ_CUSTOMER"                        AS "CNPJ_CUSTOMER",
         "PARTNER_NAME"                         AS "PARTNER_NAME",
         TO_CHAR("VENDA_DATA", 'YYYY-MM-DD')    AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0)        AS "VENDA_VALOR"
       FROM sellers.bic_vendas_PARCEIRO
       WHERE "VENDA_DATA" >= ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -11)
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'MM'), 1)
       GROUP BY
         "HOLDING",
         "CNPJ_CUSTOMER",
         "PARTNER_NAME",
         "VENDA_DATA"
       ORDER BY "PARTNER_NAME", "VENDA_DATA"`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const rows = result.rows.map(r => ({
      HOLDING:       r.HOLDING,
      CNPJ_CUSTOMER: r.CNPJ_CUSTOMER,
      PARTNER_NAME:  r.PARTNER_NAME,
      VENDA_DATA:    r.VENDA_DATA,
      VENDA_VALOR:   r.VENDA_VALOR,
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Dados');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const drive    = getDriveClient();
    const folderId = process.env.GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    const now      = new Date();
    const pad      = n => String(n).padStart(2, '0');
    const dateStr  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const baseName = `batalha_naval_${dateStr}`;
    const fileName = `${baseName}.xlsx`;

    const up = await uploadDailyXlsx(drive, folderId, fileName, buffer, hashData(rows));
    if (!up.skipped) console.log(`[Drive] Batalha Naval salvo: "${fileName}" (${rows.length} linhas)`);
    return { fileName, rowCount: rows.length };
  } catch (err) {
    console.error('[Drive] Erro ao salvar Batalha Naval:', err.message);
    throw err;
  } finally {
    if (conn) await conn.close();
  }
}

// Dispara geração manual
app.post('/api/batalha-naval-atualizar', async (req, res) => {
  try {
    const result = await saveBatalhaNavalToDrive();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Arquivo mais recente no Drive
app.get('/api/batalha-naval-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado' });

    const listResp = await drive.files.list({
      q:                         `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields:                    'files(id, name, createdTime)',
      orderBy:                   'createdTime desc',
      pageSize:                  5,
      includeItemsFromAllDrives: true,
      supportsAllDrives:         true,
    });

    const files = listResp.data.files || [];
    if (!files.length) return res.json({ fileId: null, name: null, createdTime: null });
    const f = files[0];
    res.json({ fileId: f.id, name: f.name, createdTime: f.createdTime });
  } catch (err) {
    console.error('Erro /api/batalha-naval-arquivo:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Lê dados de um arquivo específico
app.get('/api/batalha-naval-dados', async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório' });

    const drive    = getDriveClient();
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );

    const wb   = XLSX.read(fileResp.data, { type: 'array' });
    const ws   = wb.Sheets['Dados'] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

    res.json({ rows });
  } catch (err) {
    console.error('Erro /api/batalha-naval-dados:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  M DIAS BRANCO — Tenant isolado
//  Oracle: MDIAS_DB_* | Drive: MDIAS_GOOGLE_DRIVE_*
//  Tabela: sellers.sellers_sellersv2_vendas_PARCEIRO
//  Sem holdings, sem CNPJ (batalha naval)
// ═══════════════════════════════════════════════════════════

async function getMDiasConn() {
  return oracledb.getConnection({
    user:          process.env.MDIAS_DB_USER,
    password:      process.env.MDIAS_DB_PASSWORD,
    connectString: process.env.MDIAS_DB_CONNECT_STRING,
  });
}

function buildBrDateStr() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(new Date());
  return {
    d:  parts.find(p => p.type === 'day').value,
    mo: parts.find(p => p.type === 'month').value,
    y:  parts.find(p => p.type === 'year').value,
  };
}

async function mdiasSaveXlsx(drive, folderId, filename, wsRows, sheetName) {
  const ws     = XLSX.utils.json_to_sheet(wsRows);
  const wb     = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return uploadDailyXlsx(drive, folderId, filename, buffer, hashData({ sheetName, wsRows }));
}

// ─── Comparativo Sellout MDias ────────────────────────────
app.get('/mdias/comparativo', async (req, res) => {
  let conn;
  try {
    conn = await getMDiasConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.sellers_sellersv2_vendas_PARCEIRO v0
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR')
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      customer: r.PARTNER_NAME || '',
      anomes:   r.ANO_MES_FIX  || '',
      valor:    Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    // Salvar no Drive de forma assíncrona
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.MDIAS_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
        console.log(`[Drive/MDias] Comparativo salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/MDias] Erro ao salvar comparativo:', e.message); }
    })();
  } catch (err) {
    console.error('[MDias/Oracle] Erro /mdias/comparativo:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

app.get('/mdias/listar-arquivos', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.MDIAS_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.json([]);
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)', orderBy: 'createdTime desc', pageSize: 1000,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const files = (listResp.data.files || []).filter(f =>
      /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
    );
    files.sort((a, b) => {
      const da = parseDateFromFilename(a.name);
      const db = parseDateFromFilename(b.name);
      if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
      return db - da;
    });
    res.json(files.map(f => ({ id: f.id, name: f.name })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/mdias/ultimo-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.MDIAS_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'MDIAS_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID não configurado.' });
    let fileId = req.query.fileId || null;
    let filename = null;
    if (!fileId) {
      const listResp = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name)', pageSize: 1000,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      const files = (listResp.data.files || []).filter(f =>
        /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
      );
      if (!files.length) return res.status(404).json({ error: 'Nenhum arquivo encontrado.' });
      files.sort((a, b) => {
        const da = parseDateFromFilename(a.name);
        const db = parseDateFromFilename(b.name);
        if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
        return db - da;
      });
      fileId = files[0].id; filename = files[0].name;
    } else {
      const meta = await drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
      filename = meta.data.name;
    }
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    res.json({ filename, fileId, buffer: Buffer.from(fileResp.data).toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/mdias/upload-drive', upload.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  try {
    const drive    = getDriveClient();
    const folderId = process.env.MDIAS_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) throw new Error('MDIAS_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID não configurado.');
    const filename = buildFilename(new Date());
    const up = await uploadDailyXlsx(drive, folderId, filename, req.file.buffer, hashData(req.file.buffer));
    res.json({ success: true, filename: up.name, fileId: up.id, skipped: up.skipped });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Batalha Naval MDias ──────────────────────────────────
async function mdiasSaveBatalhaNavalToDrive() {
  let conn;
  try {
    conn = await getMDiasConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                      AS "PARTNER_NAME",
         TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0)     AS "VENDA_VALOR"
       FROM sellers.sellers_sellersv2_vendas_PARCEIRO v0
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1))
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      PARTNER_NAME: r.PARTNER_NAME,
      VENDA_DATA:   r.VENDA_DATA,
      VENDA_VALOR:  r.VENDA_VALOR,
    }));
    const drive    = getDriveClient();
    const folderId = process.env.MDIAS_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) { console.warn('[Drive/MDias] MDIAS_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado.'); return { rows }; }
    const now     = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const fileName = `mdias_batalha_${dateStr}.xlsx`;
    await mdiasSaveXlsx(drive, folderId, fileName, rows, 'Dados');
    console.log(`[Drive/MDias] Batalha Naval salvo: "${fileName}" (${rows.length} linhas)`);
    return { fileName, rowCount: rows.length };
  } catch (err) {
    console.error('[Drive/MDias] Erro ao salvar Batalha Naval:', err.message);
    throw err;
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
}

app.post('/mdias/batalha-naval-atualizar', async (req, res) => {
  try {
    const result = await mdiasSaveBatalhaNavalToDrive();
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/mdias/batalha-naval-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.MDIAS_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'MDIAS_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado' });
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime)', orderBy: 'createdTime desc', pageSize: 5,
      includeItemsFromAllDrives: true, supportsAllDrives: true,
    });
    const files = listResp.data.files || [];
    if (!files.length) return res.json({ fileId: null, name: null, createdTime: null });
    const f = files[0];
    res.json({ fileId: f.id, name: f.name, createdTime: f.createdTime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/mdias/batalha-naval-dados', async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório' });
    const drive    = getDriveClient();
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    const wb   = XLSX.read(fileResp.data, { type: 'array' });
    const ws   = wb.Sheets['Dados'] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Histórico de Vendas MDias ────────────────────────────
app.get('/mdias/historico-vendas', async (req, res) => {
  let conn;
  try {
    conn = await getMDiasConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.sellers_sellersv2_vendas_PARCEIRO v0
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      partnerName: r.PARTNER_NAME || '',
      anoMes:      r.ANO_MES_FIX  || '',
      valor:       Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    // Salvar no Drive de forma assíncrona
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.MDIAS_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `mdias_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
        console.log(`[Drive/MDias] Histórico salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/MDias] Erro ao salvar histórico:', e.message); }
    })();
  } catch (err) {
    console.error('[MDias/Oracle] Erro /mdias/historico-vendas:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ─── Atualizar Tudo MDias — SSE ───────────────────────────
app.get('/mdias/atualizar-tudo', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = (pct, step, msg) => res.write(`data: ${JSON.stringify({ pct, step, msg })}\n\n`);
  let conn;
  try {
    emit(5,  1, 'Conectando ao Oracle MDias…');
    conn = await getMDiasConn();

    emit(20, 2, 'Buscando comparativo de sellout…');
    const compResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.sellers_sellersv2_vendas_PARCEIRO v0
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR') AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const compRows = compResult.rows.map(r => ({ customer: r.PARTNER_NAME || '', anomes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(38, 2, `Comparativo: ${compRows.length} registros.`);

    emit(42, 3, 'Buscando Batalha Naval…');
    const bnResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.sellers_sellersv2_vendas_PARCEIRO v0
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1)) AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const bnRows = bnResult.rows.map(r => ({ PARTNER_NAME: r.PARTNER_NAME, VENDA_DATA: r.VENDA_DATA, VENDA_VALOR: r.VENDA_VALOR }));
    emit(60, 3, `Batalha Naval: ${bnRows.length} registros.`);

    emit(65, 4, 'Buscando histórico de vendas…');
    const histResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.sellers_sellersv2_vendas_PARCEIRO v0
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const histRows = histResult.rows.map(r => ({ partnerName: r.PARTNER_NAME || '', anoMes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(78, 4, `Histórico: ${histRows.length} registros.`);

    await conn.close(); conn = null;

    emit(83, 5, 'Salvando comparativo no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.MDIAS_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = compRows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
      }
    }
    emit(88, 5, 'Comparativo salvo.');

    emit(90, 6, 'Salvando Batalha Naval no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.MDIAS_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
      if (folderId) {
        const now = new Date(); const pad = n => String(n).padStart(2, '0');
        const dateStr  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
        const fileName = `mdias_batalha_${dateStr}.xlsx`;
        await mdiasSaveXlsx(drive, folderId, fileName, bnRows, 'Dados');
      }
    }
    emit(94, 6, 'Batalha Naval salva.');

    emit(96, 7, 'Salvando histórico no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.MDIAS_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `mdias_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = histRows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
      }
    }
    emit(100, 7, 'Histórico salvo.');

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[MDias/atualizar-tudo] Erro:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ═══════════════════════════════════════════════════════════
//  MARILAN — Tenant isolado
//  Oracle: MARILAN_DB_* | Drive: MARILAN_GOOGLE_DRIVE_*
//  Tabela: sellers.MARILAN_VENDAS_PARCEIRO
//  Sem holdings, sem CNPJ
// ═══════════════════════════════════════════════════════════

async function getMarilanConn() {
  return oracledb.getConnection({
    user:          process.env.MARILAN_DB_USER,
    password:      process.env.MARILAN_DB_PASSWORD,
    connectString: process.env.MARILAN_DB_CONNECT_STRING,
  });
}

// ─── Comparativo Sellout Marilan ─────────────────────────
app.get('/marilan/comparativo', async (req, res) => {
  let conn;
  try {
    conn = await getMarilanConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.MARILAN_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR')
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      customer: r.PARTNER_NAME || '',
      anomes:   r.ANO_MES_FIX  || '',
      valor:    Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    // Salvar no Drive de forma assíncrona
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.MARILAN_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
        console.log(`[Drive/Marilan] Comparativo salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Marilan] Erro ao salvar comparativo:', e.message); }
    })();
  } catch (err) {
    console.error('[Marilan/Oracle] Erro /marilan/comparativo:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

app.get('/marilan/listar-arquivos', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.MARILAN_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.json([]);
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)', orderBy: 'createdTime desc', pageSize: 1000,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const files = (listResp.data.files || []).filter(f =>
      /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
    );
    files.sort((a, b) => {
      const da = parseDateFromFilename(a.name);
      const db = parseDateFromFilename(b.name);
      if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
      return db - da;
    });
    res.json(files.map(f => ({ id: f.id, name: f.name })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/marilan/ultimo-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.MARILAN_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'MARILAN_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID não configurado.' });
    let fileId = req.query.fileId || null;
    let filename = null;
    if (!fileId) {
      const listResp = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name)', pageSize: 1000,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      const files = (listResp.data.files || []).filter(f =>
        /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
      );
      if (!files.length) return res.status(404).json({ error: 'Nenhum arquivo encontrado.' });
      files.sort((a, b) => {
        const da = parseDateFromFilename(a.name);
        const db = parseDateFromFilename(b.name);
        if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
        return db - da;
      });
      fileId = files[0].id; filename = files[0].name;
    } else {
      const meta = await drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
      filename = meta.data.name;
    }
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    res.json({ filename, fileId, buffer: Buffer.from(fileResp.data).toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Batalha Naval Marilan ────────────────────────────────
async function marilanSaveBatalhaNavalToDrive() {
  let conn;
  try {
    conn = await getMarilanConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                      AS "PARTNER_NAME",
         TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0)     AS "VENDA_VALOR"
       FROM sellers.MARILAN_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1))
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      PARTNER_NAME: r.PARTNER_NAME,
      VENDA_DATA:   r.VENDA_DATA,
      VENDA_VALOR:  r.VENDA_VALOR,
    }));
    const drive    = getDriveClient();
    const folderId = process.env.MARILAN_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) { console.warn('[Drive/Marilan] MARILAN_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado.'); return { rows }; }
    const now     = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const fileName = `marilan_batalha_${dateStr}.xlsx`;
    await mdiasSaveXlsx(drive, folderId, fileName, rows, 'Dados');
    console.log(`[Drive/Marilan] Batalha Naval salvo: "${fileName}" (${rows.length} linhas)`);
    return { fileName, rowCount: rows.length };
  } catch (err) {
    console.error('[Drive/Marilan] Erro ao salvar Batalha Naval:', err.message);
    throw err;
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
}

app.post('/marilan/batalha-naval-atualizar', async (req, res) => {
  try {
    const result = await marilanSaveBatalhaNavalToDrive();
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/marilan/batalha-naval-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.MARILAN_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'MARILAN_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado' });
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime)', orderBy: 'createdTime desc', pageSize: 5,
      includeItemsFromAllDrives: true, supportsAllDrives: true,
    });
    const files = listResp.data.files || [];
    if (!files.length) return res.json({ fileId: null, name: null, createdTime: null });
    const f = files[0];
    res.json({ fileId: f.id, name: f.name, createdTime: f.createdTime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/marilan/batalha-naval-dados', async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório' });
    const drive    = getDriveClient();
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    const wb   = XLSX.read(fileResp.data, { type: 'array' });
    const ws   = wb.Sheets['Dados'] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Histórico de Vendas Marilan ──────────────────────────
app.get('/marilan/historico-vendas', async (req, res) => {
  let conn;
  try {
    conn = await getMarilanConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.MARILAN_VENDAS_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      partnerName: r.PARTNER_NAME || '',
      anoMes:      r.ANO_MES_FIX  || '',
      valor:       Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    // Salvar no Drive de forma assíncrona
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.MARILAN_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `marilan_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
        console.log(`[Drive/Marilan] Histórico salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Marilan] Erro ao salvar histórico:', e.message); }
    })();
  } catch (err) {
    console.error('[Marilan/Oracle] Erro /marilan/historico-vendas:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ─── Atualizar Tudo Marilan — SSE ─────────────────────────
app.get('/marilan/atualizar-tudo', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = (pct, step, msg) => res.write(`data: ${JSON.stringify({ pct, step, msg })}\n\n`);
  let conn;
  try {
    emit(5,  1, 'Conectando ao Oracle Marilan…');
    conn = await getMarilanConn();

    emit(20, 2, 'Buscando comparativo de sellout…');
    const compResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.MARILAN_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR') AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const compRows = compResult.rows.map(r => ({ customer: r.PARTNER_NAME || '', anomes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(38, 2, `Comparativo: ${compRows.length} registros.`);

    emit(42, 3, 'Buscando Batalha Naval…');
    const bnResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.MARILAN_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1)) AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const bnRows = bnResult.rows.map(r => ({ PARTNER_NAME: r.PARTNER_NAME, VENDA_DATA: r.VENDA_DATA, VENDA_VALOR: r.VENDA_VALOR }));
    emit(60, 3, `Batalha Naval: ${bnRows.length} registros.`);

    emit(65, 4, 'Buscando histórico de vendas…');
    const histResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.MARILAN_VENDAS_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const histRows = histResult.rows.map(r => ({ partnerName: r.PARTNER_NAME || '', anoMes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(78, 4, `Histórico: ${histRows.length} registros.`);

    await conn.close(); conn = null;

    emit(83, 5, 'Salvando comparativo no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.MARILAN_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = compRows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
      }
    }
    emit(88, 5, 'Comparativo salvo.');

    emit(90, 6, 'Salvando Batalha Naval no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.MARILAN_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
      if (folderId) {
        const now = new Date(); const pad = n => String(n).padStart(2, '0');
        const dateStr  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
        const fileName = `marilan_batalha_${dateStr}.xlsx`;
        await mdiasSaveXlsx(drive, folderId, fileName, bnRows, 'Dados');
      }
    }
    emit(94, 6, 'Batalha Naval salva.');

    emit(96, 7, 'Salvando histórico no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.MARILAN_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `marilan_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = histRows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
      }
    }
    emit(100, 7, 'Histórico salvo.');

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[Marilan/atualizar-tudo] Erro:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ═══════════════════════════════════════════════════════════
//  ASA — Tenant isolado
//  Oracle: mesmas credenciais BIC | Drive: ASA_GOOGLE_DRIVE_*
//  Tabela: sellers.ASA_vendas_PARCEIRO
//  Sem holdings, sem CNPJ
// ═══════════════════════════════════════════════════════════

async function getAsaConn() { return getGalloConn(); }

// ─── Comparativo Sellout Asa ─────────────────────────
app.get('/asa/comparativo', async (req, res) => {
  let conn;
  try {
    conn = await getAsaConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.ASA_vendas_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR')
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      customer: r.PARTNER_NAME || '',
      anomes:   r.ANO_MES_FIX  || '',
      valor:    Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    // Salvar no Drive de forma assíncrona
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.ASA_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
        console.log(`[Drive/Asa] Comparativo salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Asa] Erro ao salvar comparativo:', e.message); }
    })();
  } catch (err) {
    console.error('[Asa/Oracle] Erro /asa/comparativo:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

app.get('/asa/listar-arquivos', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.ASA_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.json([]);
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)', orderBy: 'createdTime desc', pageSize: 1000,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const files = (listResp.data.files || []).filter(f =>
      /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
    );
    files.sort((a, b) => {
      const da = parseDateFromFilename(a.name);
      const db = parseDateFromFilename(b.name);
      if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
      return db - da;
    });
    res.json(files.map(f => ({ id: f.id, name: f.name })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/asa/ultimo-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.ASA_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'ASA_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID não configurado.' });
    let fileId = req.query.fileId || null;
    let filename = null;
    if (!fileId) {
      const listResp = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name)', pageSize: 1000,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      const files = (listResp.data.files || []).filter(f =>
        /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
      );
      if (!files.length) return res.status(404).json({ error: 'Nenhum arquivo encontrado.' });
      files.sort((a, b) => {
        const da = parseDateFromFilename(a.name);
        const db = parseDateFromFilename(b.name);
        if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
        return db - da;
      });
      fileId = files[0].id; filename = files[0].name;
    } else {
      const meta = await drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
      filename = meta.data.name;
    }
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    res.json({ filename, fileId, buffer: Buffer.from(fileResp.data).toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Batalha Naval Asa ────────────────────────────────
async function asaSaveBatalhaNavalToDrive() {
  let conn;
  try {
    conn = await getAsaConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                      AS "PARTNER_NAME",
         TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0)     AS "VENDA_VALOR"
       FROM sellers.ASA_vendas_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1))
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      PARTNER_NAME: r.PARTNER_NAME,
      VENDA_DATA:   r.VENDA_DATA,
      VENDA_VALOR:  r.VENDA_VALOR,
    }));
    const drive    = getDriveClient();
    const folderId = process.env.ASA_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) { console.warn('[Drive/Asa] ASA_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado.'); return { rows }; }
    const now     = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const fileName = `asa_batalha_${dateStr}.xlsx`;
    await mdiasSaveXlsx(drive, folderId, fileName, rows, 'Dados');
    console.log(`[Drive/Asa] Batalha Naval salvo: "${fileName}" (${rows.length} linhas)`);
    return { fileName, rowCount: rows.length };
  } catch (err) {
    console.error('[Drive/Asa] Erro ao salvar Batalha Naval:', err.message);
    throw err;
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
}

app.post('/asa/batalha-naval-atualizar', async (req, res) => {
  try {
    const result = await asaSaveBatalhaNavalToDrive();
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/asa/batalha-naval-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.ASA_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'ASA_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado' });
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime)', orderBy: 'createdTime desc', pageSize: 5,
      includeItemsFromAllDrives: true, supportsAllDrives: true,
    });
    const files = listResp.data.files || [];
    if (!files.length) return res.json({ fileId: null, name: null, createdTime: null });
    const f = files[0];
    res.json({ fileId: f.id, name: f.name, createdTime: f.createdTime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/asa/batalha-naval-dados', async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório' });
    const drive    = getDriveClient();
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    const wb   = XLSX.read(fileResp.data, { type: 'array' });
    const ws   = wb.Sheets['Dados'] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Histórico de Vendas Asa ──────────────────────────
app.get('/asa/historico-vendas', async (req, res) => {
  let conn;
  try {
    conn = await getAsaConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.ASA_vendas_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      partnerName: r.PARTNER_NAME || '',
      anoMes:      r.ANO_MES_FIX  || '',
      valor:       Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    // Salvar no Drive de forma assíncrona
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.ASA_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `asa_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
        console.log(`[Drive/Asa] Histórico salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Asa] Erro ao salvar histórico:', e.message); }
    })();
  } catch (err) {
    console.error('[Asa/Oracle] Erro /asa/historico-vendas:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ─── Atualizar Tudo Asa — SSE ─────────────────────────
app.get('/asa/atualizar-tudo', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = (pct, step, msg) => res.write(`data: ${JSON.stringify({ pct, step, msg })}\n\n`);
  let conn;
  try {
    emit(5,  1, 'Conectando ao Oracle Asa…');
    conn = await getAsaConn();

    emit(20, 2, 'Buscando comparativo de sellout…');
    const compResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.ASA_vendas_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR') AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const compRows = compResult.rows.map(r => ({ customer: r.PARTNER_NAME || '', anomes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(38, 2, `Comparativo: ${compRows.length} registros.`);

    emit(42, 3, 'Buscando Batalha Naval…');
    const bnResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.ASA_vendas_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1)) AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const bnRows = bnResult.rows.map(r => ({ PARTNER_NAME: r.PARTNER_NAME, VENDA_DATA: r.VENDA_DATA, VENDA_VALOR: r.VENDA_VALOR }));
    emit(60, 3, `Batalha Naval: ${bnRows.length} registros.`);

    emit(65, 4, 'Buscando histórico de vendas…');
    const histResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.ASA_vendas_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const histRows = histResult.rows.map(r => ({ partnerName: r.PARTNER_NAME || '', anoMes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(78, 4, `Histórico: ${histRows.length} registros.`);

    await conn.close(); conn = null;

    emit(83, 5, 'Salvando comparativo no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.ASA_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = compRows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
      }
    }
    emit(88, 5, 'Comparativo salvo.');

    emit(90, 6, 'Salvando Batalha Naval no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.ASA_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
      if (folderId) {
        const now = new Date(); const pad = n => String(n).padStart(2, '0');
        const dateStr  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
        const fileName = `asa_batalha_${dateStr}.xlsx`;
        await mdiasSaveXlsx(drive, folderId, fileName, bnRows, 'Dados');
      }
    }
    emit(94, 6, 'Batalha Naval salva.');

    emit(96, 7, 'Salvando histórico no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.ASA_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `asa_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = histRows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
      }
    }
    emit(100, 7, 'Histórico salvo.');

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[Asa/atualizar-tudo] Erro:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ═══════════════════════════════════════════════════════════
//  BOMBRIL — Tenant isolado
//  Oracle: mesmas credenciais BIC | Drive: BOMBRIL_GOOGLE_DRIVE_*
//  Tabela: sellers.bombril_vendas_PARCEIRO
//  Sem holdings, sem CNPJ
// ═══════════════════════════════════════════════════════════

async function getBombrilConn() {
  return oracledb.getConnection({
    user:             process.env.DB_USER,
    password:         process.env.BOMBRIL_DB_PASSWORD,
    connectString:    process.env.BOMBRIL_DB_CONNECT_STRING,
  });
}

// ─── Comparativo Sellout Bombril ─────────────────────────
app.get('/bombril/comparativo', async (req, res) => {
  let conn;
  try {
    conn = await getBombrilConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.bombril_vendas_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR')
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      customer: r.PARTNER_NAME || '',
      anomes:   r.ANO_MES_FIX  || '',
      valor:    Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    // Salvar no Drive de forma assíncrona
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.BOMBRIL_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
        console.log(`[Drive/Bombril] Comparativo salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Bombril] Erro ao salvar comparativo:', e.message); }
    })();
  } catch (err) {
    console.error('[Bombril/Oracle] Erro /bombril/comparativo:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

app.get('/bombril/listar-arquivos', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.BOMBRIL_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.json([]);
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)', orderBy: 'createdTime desc', pageSize: 1000,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const files = (listResp.data.files || []).filter(f =>
      /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
    );
    files.sort((a, b) => {
      const da = parseDateFromFilename(a.name);
      const db = parseDateFromFilename(b.name);
      if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
      return db - da;
    });
    res.json(files.map(f => ({ id: f.id, name: f.name })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/bombril/ultimo-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.BOMBRIL_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'BOMBRIL_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID não configurado.' });
    let fileId = req.query.fileId || null;
    let filename = null;
    if (!fileId) {
      const listResp = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name)', pageSize: 1000,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      const files = (listResp.data.files || []).filter(f =>
        /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
      );
      if (!files.length) return res.status(404).json({ error: 'Nenhum arquivo encontrado.' });
      files.sort((a, b) => {
        const da = parseDateFromFilename(a.name);
        const db = parseDateFromFilename(b.name);
        if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
        return db - da;
      });
      fileId = files[0].id; filename = files[0].name;
    } else {
      const meta = await drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
      filename = meta.data.name;
    }
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    res.json({ filename, fileId, buffer: Buffer.from(fileResp.data).toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Batalha Naval Bombril ────────────────────────────────
async function bombrilSaveBatalhaNavalToDrive() {
  let conn;
  try {
    conn = await getBombrilConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                      AS "PARTNER_NAME",
         TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0)     AS "VENDA_VALOR"
       FROM sellers.bombril_vendas_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1))
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      PARTNER_NAME: r.PARTNER_NAME,
      VENDA_DATA:   r.VENDA_DATA,
      VENDA_VALOR:  r.VENDA_VALOR,
    }));
    const drive    = getDriveClient();
    const folderId = process.env.BOMBRIL_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) { console.warn('[Drive/Bombril] BOMBRIL_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado.'); return { rows }; }
    const now     = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const fileName = `bombril_batalha_${dateStr}.xlsx`;
    await mdiasSaveXlsx(drive, folderId, fileName, rows, 'Dados');
    console.log(`[Drive/Bombril] Batalha Naval salvo: "${fileName}" (${rows.length} linhas)`);
    return { fileName, rowCount: rows.length };
  } catch (err) {
    console.error('[Drive/Bombril] Erro ao salvar Batalha Naval:', err.message);
    throw err;
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
}

app.post('/bombril/batalha-naval-atualizar', async (req, res) => {
  try {
    const result = await bombrilSaveBatalhaNavalToDrive();
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/bombril/batalha-naval-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.BOMBRIL_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'BOMBRIL_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado' });
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime)', orderBy: 'createdTime desc', pageSize: 5,
      includeItemsFromAllDrives: true, supportsAllDrives: true,
    });
    const files = listResp.data.files || [];
    if (!files.length) return res.json({ fileId: null, name: null, createdTime: null });
    const f = files[0];
    res.json({ fileId: f.id, name: f.name, createdTime: f.createdTime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/bombril/batalha-naval-dados', async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório' });
    const drive    = getDriveClient();
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    const wb   = XLSX.read(fileResp.data, { type: 'array' });
    const ws   = wb.Sheets['Dados'] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Histórico de Vendas Bombril ──────────────────────────
app.get('/bombril/historico-vendas', async (req, res) => {
  let conn;
  try {
    conn = await getBombrilConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.bombril_vendas_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      partnerName: r.PARTNER_NAME || '',
      anoMes:      r.ANO_MES_FIX  || '',
      valor:       Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    // Salvar no Drive de forma assíncrona
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.BOMBRIL_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `bombril_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
        console.log(`[Drive/Bombril] Histórico salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Bombril] Erro ao salvar histórico:', e.message); }
    })();
  } catch (err) {
    console.error('[Bombril/Oracle] Erro /bombril/historico-vendas:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ─── Atualizar Tudo Bombril — SSE ─────────────────────────
app.get('/bombril/atualizar-tudo', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = (pct, step, msg) => res.write(`data: ${JSON.stringify({ pct, step, msg })}\n\n`);
  let conn;
  try {
    emit(5,  1, 'Conectando ao Oracle Bombril…');
    conn = await getBombrilConn();

    emit(20, 2, 'Buscando comparativo de sellout…');
    const compResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.bombril_vendas_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR') AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const compRows = compResult.rows.map(r => ({ customer: r.PARTNER_NAME || '', anomes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(38, 2, `Comparativo: ${compRows.length} registros.`);

    emit(42, 3, 'Buscando Batalha Naval…');
    const bnResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.bombril_vendas_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1)) AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const bnRows = bnResult.rows.map(r => ({ PARTNER_NAME: r.PARTNER_NAME, VENDA_DATA: r.VENDA_DATA, VENDA_VALOR: r.VENDA_VALOR }));
    emit(60, 3, `Batalha Naval: ${bnRows.length} registros.`);

    emit(65, 4, 'Buscando histórico de vendas…');
    const histResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.bombril_vendas_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const histRows = histResult.rows.map(r => ({ partnerName: r.PARTNER_NAME || '', anoMes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(78, 4, `Histórico: ${histRows.length} registros.`);

    await conn.close(); conn = null;

    emit(83, 5, 'Salvando comparativo no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.BOMBRIL_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = compRows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
      }
    }
    emit(88, 5, 'Comparativo salvo.');

    emit(90, 6, 'Salvando Batalha Naval no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.BOMBRIL_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
      if (folderId) {
        const now = new Date(); const pad = n => String(n).padStart(2, '0');
        const dateStr  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
        const fileName = `bombril_batalha_${dateStr}.xlsx`;
        await mdiasSaveXlsx(drive, folderId, fileName, bnRows, 'Dados');
      }
    }
    emit(94, 6, 'Batalha Naval salva.');

    emit(96, 7, 'Salvando histórico no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.BOMBRIL_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `bombril_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = histRows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
      }
    }
    emit(100, 7, 'Histórico salvo.');

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[Bombril/atualizar-tudo] Erro:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ═══════════════════════════════════════════════════════════
//  CICOPAL — Tenant isolado
//  Oracle: mesmas credenciais BIC | Drive: CICOPAL_GOOGLE_DRIVE_*
//  Tabela: sellers.CICOPAL_vendas_PARCEIRO
//  Sem holdings, sem CNPJ
// ═══════════════════════════════════════════════════════════

async function getCicopalConn() { return getGalloConn(); }

// ─── Comparativo Sellout Cicopal ─────────────────────────
app.get('/cicopal/comparativo', async (req, res) => {
  let conn;
  try {
    conn = await getCicopalConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.CICOPAL_vendas_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR')
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      customer: r.PARTNER_NAME || '',
      anomes:   r.ANO_MES_FIX  || '',
      valor:    Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    // Salvar no Drive de forma assíncrona
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.CICOPAL_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
        console.log(`[Drive/Cicopal] Comparativo salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Cicopal] Erro ao salvar comparativo:', e.message); }
    })();
  } catch (err) {
    console.error('[Cicopal/Oracle] Erro /cicopal/comparativo:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

app.get('/cicopal/listar-arquivos', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.CICOPAL_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.json([]);
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)', orderBy: 'createdTime desc', pageSize: 1000,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const files = (listResp.data.files || []).filter(f =>
      /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
    );
    files.sort((a, b) => {
      const da = parseDateFromFilename(a.name);
      const db = parseDateFromFilename(b.name);
      if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
      return db - da;
    });
    res.json(files.map(f => ({ id: f.id, name: f.name })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/cicopal/ultimo-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.CICOPAL_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'CICOPAL_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID não configurado.' });
    let fileId = req.query.fileId || null;
    let filename = null;
    if (!fileId) {
      const listResp = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name)', pageSize: 1000,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      const files = (listResp.data.files || []).filter(f =>
        /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
      );
      if (!files.length) return res.status(404).json({ error: 'Nenhum arquivo encontrado.' });
      files.sort((a, b) => {
        const da = parseDateFromFilename(a.name);
        const db = parseDateFromFilename(b.name);
        if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
        return db - da;
      });
      fileId = files[0].id; filename = files[0].name;
    } else {
      const meta = await drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
      filename = meta.data.name;
    }
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    res.json({ filename, fileId, buffer: Buffer.from(fileResp.data).toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Batalha Naval Cicopal ────────────────────────────────
async function cicopalSaveBatalhaNavalToDrive() {
  let conn;
  try {
    conn = await getCicopalConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                      AS "PARTNER_NAME",
         TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0)     AS "VENDA_VALOR"
       FROM sellers.CICOPAL_vendas_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1))
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      PARTNER_NAME: r.PARTNER_NAME,
      VENDA_DATA:   r.VENDA_DATA,
      VENDA_VALOR:  r.VENDA_VALOR,
    }));
    const drive    = getDriveClient();
    const folderId = process.env.CICOPAL_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) { console.warn('[Drive/Cicopal] CICOPAL_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado.'); return { rows }; }
    const now     = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const fileName = `cicopal_batalha_${dateStr}.xlsx`;
    await mdiasSaveXlsx(drive, folderId, fileName, rows, 'Dados');
    console.log(`[Drive/Cicopal] Batalha Naval salvo: "${fileName}" (${rows.length} linhas)`);
    return { fileName, rowCount: rows.length };
  } catch (err) {
    console.error('[Drive/Cicopal] Erro ao salvar Batalha Naval:', err.message);
    throw err;
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
}

app.post('/cicopal/batalha-naval-atualizar', async (req, res) => {
  try {
    const result = await cicopalSaveBatalhaNavalToDrive();
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/cicopal/batalha-naval-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.CICOPAL_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'CICOPAL_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado' });
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime)', orderBy: 'createdTime desc', pageSize: 5,
      includeItemsFromAllDrives: true, supportsAllDrives: true,
    });
    const files = listResp.data.files || [];
    if (!files.length) return res.json({ fileId: null, name: null, createdTime: null });
    const f = files[0];
    res.json({ fileId: f.id, name: f.name, createdTime: f.createdTime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/cicopal/batalha-naval-dados', async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório' });
    const drive    = getDriveClient();
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    const wb   = XLSX.read(fileResp.data, { type: 'array' });
    const ws   = wb.Sheets['Dados'] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Histórico de Vendas Cicopal ──────────────────────────
app.get('/cicopal/historico-vendas', async (req, res) => {
  let conn;
  try {
    conn = await getCicopalConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.CICOPAL_vendas_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      partnerName: r.PARTNER_NAME || '',
      anoMes:      r.ANO_MES_FIX  || '',
      valor:       Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    // Salvar no Drive de forma assíncrona
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.CICOPAL_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `cicopal_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
        console.log(`[Drive/Cicopal] Histórico salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Cicopal] Erro ao salvar histórico:', e.message); }
    })();
  } catch (err) {
    console.error('[Cicopal/Oracle] Erro /cicopal/historico-vendas:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ─── Atualizar Tudo Cicopal — SSE ─────────────────────────
app.get('/cicopal/atualizar-tudo', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = (pct, step, msg) => res.write(`data: ${JSON.stringify({ pct, step, msg })}\n\n`);
  let conn;
  try {
    emit(5,  1, 'Conectando ao Oracle Cicopal…');
    conn = await getCicopalConn();

    emit(20, 2, 'Buscando comparativo de sellout…');
    const compResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.CICOPAL_vendas_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR') AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const compRows = compResult.rows.map(r => ({ customer: r.PARTNER_NAME || '', anomes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(38, 2, `Comparativo: ${compRows.length} registros.`);

    emit(42, 3, 'Buscando Batalha Naval…');
    const bnResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.CICOPAL_vendas_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1)) AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const bnRows = bnResult.rows.map(r => ({ PARTNER_NAME: r.PARTNER_NAME, VENDA_DATA: r.VENDA_DATA, VENDA_VALOR: r.VENDA_VALOR }));
    emit(60, 3, `Batalha Naval: ${bnRows.length} registros.`);

    emit(65, 4, 'Buscando histórico de vendas…');
    const histResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.CICOPAL_vendas_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const histRows = histResult.rows.map(r => ({ partnerName: r.PARTNER_NAME || '', anoMes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(78, 4, `Histórico: ${histRows.length} registros.`);

    await conn.close(); conn = null;

    emit(83, 5, 'Salvando comparativo no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.CICOPAL_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = compRows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
      }
    }
    emit(88, 5, 'Comparativo salvo.');

    emit(90, 6, 'Salvando Batalha Naval no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.CICOPAL_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
      if (folderId) {
        const now = new Date(); const pad = n => String(n).padStart(2, '0');
        const dateStr  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
        const fileName = `cicopal_batalha_${dateStr}.xlsx`;
        await mdiasSaveXlsx(drive, folderId, fileName, bnRows, 'Dados');
      }
    }
    emit(94, 6, 'Batalha Naval salva.');

    emit(96, 7, 'Salvando histórico no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.CICOPAL_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `cicopal_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = histRows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
      }
    }
    emit(100, 7, 'Histórico salvo.');

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[Cicopal/atualizar-tudo] Erro:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ═══════════════════════════════════════════════════════════
//  FINI — Tenant isolado
//  Oracle: mesmas credenciais Marilan (bigeral2) | Drive: FINI_GOOGLE_DRIVE_*
//  Tabela: sellers.FINI_VENDAS_PARCEIRO
//  Sem holdings, sem CNPJ
// ═══════════════════════════════════════════════════════════

async function getFiniConn() {
  return getMarilanConn();
}

// ─── Comparativo Sellout Fini ─────────────────────────
app.get('/fini/comparativo', async (req, res) => {
  let conn;
  try {
    conn = await getFiniConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.FINI_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR')
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      customer: r.PARTNER_NAME || '',
      anomes:   r.ANO_MES_FIX  || '',
      valor:    Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.FINI_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
        console.log(`[Drive/Fini] Comparativo salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Fini] Erro ao salvar comparativo:', e.message); }
    })();
  } catch (err) {
    console.error('[Fini/Oracle] Erro /fini/comparativo:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

app.get('/fini/listar-arquivos', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.FINI_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.json([]);
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)', orderBy: 'createdTime desc', pageSize: 1000,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const files = (listResp.data.files || []).filter(f =>
      /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
    );
    files.sort((a, b) => {
      const da = parseDateFromFilename(a.name);
      const db = parseDateFromFilename(b.name);
      if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
      return db - da;
    });
    res.json(files.map(f => ({ id: f.id, name: f.name })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/fini/ultimo-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.FINI_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'FINI_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID não configurado.' });
    let fileId = req.query.fileId || null;
    let filename = null;
    if (!fileId) {
      const listResp = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name)', pageSize: 1000,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      const files = (listResp.data.files || []).filter(f =>
        /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
      );
      if (!files.length) return res.status(404).json({ error: 'Nenhum arquivo encontrado.' });
      files.sort((a, b) => {
        const da = parseDateFromFilename(a.name);
        const db = parseDateFromFilename(b.name);
        if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
        return db - da;
      });
      fileId = files[0].id; filename = files[0].name;
    } else {
      const meta = await drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
      filename = meta.data.name;
    }
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    res.json({ filename, fileId, buffer: Buffer.from(fileResp.data).toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Batalha Naval Fini ────────────────────────────────
async function finiSaveBatalhaNavalToDrive() {
  let conn;
  try {
    conn = await getFiniConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                      AS "PARTNER_NAME",
         TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0)     AS "VENDA_VALOR"
       FROM sellers.FINI_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1))
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      PARTNER_NAME: r.PARTNER_NAME,
      VENDA_DATA:   r.VENDA_DATA,
      VENDA_VALOR:  r.VENDA_VALOR,
    }));
    const drive    = getDriveClient();
    const folderId = process.env.FINI_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) { console.warn('[Drive/Fini] FINI_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado.'); return { rows }; }
    const now     = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const fileName = `fini_batalha_${dateStr}.xlsx`;
    await mdiasSaveXlsx(drive, folderId, fileName, rows, 'Dados');
    console.log(`[Drive/Fini] Batalha Naval salvo: "${fileName}" (${rows.length} linhas)`);
    return { fileName, rowCount: rows.length };
  } catch (err) {
    console.error('[Drive/Fini] Erro ao salvar Batalha Naval:', err.message);
    throw err;
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
}

app.post('/fini/batalha-naval-atualizar', async (req, res) => {
  try {
    const result = await finiSaveBatalhaNavalToDrive();
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/fini/batalha-naval-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.FINI_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'FINI_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado' });
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime)', orderBy: 'createdTime desc', pageSize: 5,
      includeItemsFromAllDrives: true, supportsAllDrives: true,
    });
    const files = listResp.data.files || [];
    if (!files.length) return res.json({ fileId: null, name: null, createdTime: null });
    const f = files[0];
    res.json({ fileId: f.id, name: f.name, createdTime: f.createdTime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/fini/batalha-naval-dados', async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório' });
    const drive    = getDriveClient();
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    const wb   = XLSX.read(fileResp.data, { type: 'array' });
    const ws   = wb.Sheets['Dados'] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Histórico de Vendas Fini ──────────────────────────
app.get('/fini/historico-vendas', async (req, res) => {
  let conn;
  try {
    conn = await getFiniConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.FINI_VENDAS_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      partnerName: r.PARTNER_NAME || '',
      anoMes:      r.ANO_MES_FIX  || '',
      valor:       Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.FINI_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `fini_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
        console.log(`[Drive/Fini] Histórico salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Fini] Erro ao salvar histórico:', e.message); }
    })();
  } catch (err) {
    console.error('[Fini/Oracle] Erro /fini/historico-vendas:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ─── Atualizar Tudo Fini — SSE ─────────────────────────
app.get('/fini/atualizar-tudo', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = (pct, step, msg) => res.write(`data: ${JSON.stringify({ pct, step, msg })}\n\n`);
  let conn;
  try {
    emit(5,  1, 'Conectando ao Oracle Fini…');
    conn = await getFiniConn();

    emit(20, 2, 'Buscando comparativo de sellout…');
    const compResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.FINI_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR') AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const compRows = compResult.rows.map(r => ({ customer: r.PARTNER_NAME || '', anomes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(38, 2, `Comparativo: ${compRows.length} registros.`);

    emit(42, 3, 'Buscando Batalha Naval…');
    const bnResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.FINI_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1)) AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const bnRows = bnResult.rows.map(r => ({ PARTNER_NAME: r.PARTNER_NAME, VENDA_DATA: r.VENDA_DATA, VENDA_VALOR: r.VENDA_VALOR }));
    emit(60, 3, `Batalha Naval: ${bnRows.length} registros.`);

    emit(65, 4, 'Buscando histórico de vendas…');
    const histResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.FINI_VENDAS_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const histRows = histResult.rows.map(r => ({ partnerName: r.PARTNER_NAME || '', anoMes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(78, 4, `Histórico: ${histRows.length} registros.`);

    await conn.close(); conn = null;

    emit(83, 5, 'Salvando comparativo no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.FINI_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = compRows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
      }
    }
    emit(88, 5, 'Comparativo salvo.');

    emit(90, 6, 'Salvando Batalha Naval no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.FINI_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
      if (folderId) {
        const now = new Date(); const pad = n => String(n).padStart(2, '0');
        const dateStr  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
        const fileName = `fini_batalha_${dateStr}.xlsx`;
        await mdiasSaveXlsx(drive, folderId, fileName, bnRows, 'Dados');
      }
    }
    emit(94, 6, 'Batalha Naval salva.');

    emit(96, 7, 'Salvando histórico no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.FINI_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `fini_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = histRows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
      }
    }
    emit(100, 7, 'Histórico salvo.');

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[Fini/atualizar-tudo] Erro:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ═══════════════════════════════════════════════════════════
//  FRUKI — Tenant isolado
//  Oracle: mesmas credenciais Marilan (bigeral2) | Drive: FRUKI_GOOGLE_DRIVE_*
//  Tabela: sellers.FRUKI_VENDAS_PARCEIRO
//  Sem holdings, sem CNPJ
// ═══════════════════════════════════════════════════════════

async function getFrukiConn() {
  return getMarilanConn();
}

// ─── Comparativo Sellout Fruki ─────────────────────────
app.get('/fruki/comparativo', async (req, res) => {
  let conn;
  try {
    conn = await getFrukiConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.FRUKI_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR')
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      customer: r.PARTNER_NAME || '',
      anomes:   r.ANO_MES_FIX  || '',
      valor:    Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.FRUKI_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
        console.log(`[Drive/Fruki] Comparativo salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Fruki] Erro ao salvar comparativo:', e.message); }
    })();
  } catch (err) {
    console.error('[Fruki/Oracle] Erro /fruki/comparativo:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

app.get('/fruki/listar-arquivos', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.FRUKI_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.json([]);
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)', orderBy: 'createdTime desc', pageSize: 1000,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const files = (listResp.data.files || []).filter(f =>
      /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
    );
    files.sort((a, b) => {
      const da = parseDateFromFilename(a.name);
      const db = parseDateFromFilename(b.name);
      if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
      return db - da;
    });
    res.json(files.map(f => ({ id: f.id, name: f.name })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/fruki/ultimo-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.FRUKI_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'FRUKI_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID não configurado.' });
    let fileId = req.query.fileId || null;
    let filename = null;
    if (!fileId) {
      const listResp = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name)', pageSize: 1000,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      const files = (listResp.data.files || []).filter(f =>
        /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
      );
      if (!files.length) return res.status(404).json({ error: 'Nenhum arquivo encontrado.' });
      files.sort((a, b) => {
        const da = parseDateFromFilename(a.name);
        const db = parseDateFromFilename(b.name);
        if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
        return db - da;
      });
      fileId = files[0].id; filename = files[0].name;
    } else {
      const meta = await drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
      filename = meta.data.name;
    }
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    res.json({ filename, fileId, buffer: Buffer.from(fileResp.data).toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Batalha Naval Fruki ────────────────────────────────
async function frukiSaveBatalhaNavalToDrive() {
  let conn;
  try {
    conn = await getFrukiConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                      AS "PARTNER_NAME",
         TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0)     AS "VENDA_VALOR"
       FROM sellers.FRUKI_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1))
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      PARTNER_NAME: r.PARTNER_NAME,
      VENDA_DATA:   r.VENDA_DATA,
      VENDA_VALOR:  r.VENDA_VALOR,
    }));
    const drive    = getDriveClient();
    const folderId = process.env.FRUKI_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) { console.warn('[Drive/Fruki] FRUKI_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado.'); return { rows }; }
    const now     = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const fileName = `fruki_batalha_${dateStr}.xlsx`;
    await mdiasSaveXlsx(drive, folderId, fileName, rows, 'Dados');
    console.log(`[Drive/Fruki] Batalha Naval salvo: "${fileName}" (${rows.length} linhas)`);
    return { fileName, rowCount: rows.length };
  } catch (err) {
    console.error('[Drive/Fruki] Erro ao salvar Batalha Naval:', err.message);
    throw err;
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
}

app.post('/fruki/batalha-naval-atualizar', async (req, res) => {
  try {
    const result = await frukiSaveBatalhaNavalToDrive();
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/fruki/batalha-naval-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.FRUKI_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'FRUKI_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado' });
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime)', orderBy: 'createdTime desc', pageSize: 5,
      includeItemsFromAllDrives: true, supportsAllDrives: true,
    });
    const files = listResp.data.files || [];
    if (!files.length) return res.json({ fileId: null, name: null, createdTime: null });
    const f = files[0];
    res.json({ fileId: f.id, name: f.name, createdTime: f.createdTime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/fruki/batalha-naval-dados', async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório' });
    const drive    = getDriveClient();
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    const wb   = XLSX.read(fileResp.data, { type: 'array' });
    const ws   = wb.Sheets['Dados'] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Histórico de Vendas Fruki ──────────────────────────
app.get('/fruki/historico-vendas', async (req, res) => {
  let conn;
  try {
    conn = await getFrukiConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.FRUKI_VENDAS_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      partnerName: r.PARTNER_NAME || '',
      anoMes:      r.ANO_MES_FIX  || '',
      valor:       Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.FRUKI_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `fruki_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
        console.log(`[Drive/Fruki] Histórico salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Fruki] Erro ao salvar histórico:', e.message); }
    })();
  } catch (err) {
    console.error('[Fruki/Oracle] Erro /fruki/historico-vendas:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ─── Atualizar Tudo Fruki — SSE ─────────────────────────
app.get('/fruki/atualizar-tudo', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = (pct, step, msg) => res.write(`data: ${JSON.stringify({ pct, step, msg })}\n\n`);
  let conn;
  try {
    emit(5,  1, 'Conectando ao Oracle Fruki…');
    conn = await getFrukiConn();

    emit(20, 2, 'Buscando comparativo de sellout…');
    const compResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.FRUKI_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR') AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const compRows = compResult.rows.map(r => ({ customer: r.PARTNER_NAME || '', anomes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(38, 2, `Comparativo: ${compRows.length} registros.`);

    emit(42, 3, 'Buscando Batalha Naval…');
    const bnResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.FRUKI_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1)) AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const bnRows = bnResult.rows.map(r => ({ PARTNER_NAME: r.PARTNER_NAME, VENDA_DATA: r.VENDA_DATA, VENDA_VALOR: r.VENDA_VALOR }));
    emit(60, 3, `Batalha Naval: ${bnRows.length} registros.`);

    emit(65, 4, 'Buscando histórico de vendas…');
    const histResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.FRUKI_VENDAS_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const histRows = histResult.rows.map(r => ({ partnerName: r.PARTNER_NAME || '', anoMes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(78, 4, `Histórico: ${histRows.length} registros.`);

    await conn.close(); conn = null;

    emit(83, 5, 'Salvando comparativo no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.FRUKI_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = compRows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
      }
    }
    emit(88, 5, 'Comparativo salvo.');

    emit(90, 6, 'Salvando Batalha Naval no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.FRUKI_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
      if (folderId) {
        const now = new Date(); const pad = n => String(n).padStart(2, '0');
        const dateStr  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
        const fileName = `fruki_batalha_${dateStr}.xlsx`;
        await mdiasSaveXlsx(drive, folderId, fileName, bnRows, 'Dados');
      }
    }
    emit(94, 6, 'Batalha Naval salva.');

    emit(96, 7, 'Salvando histórico no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.FRUKI_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `fruki_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = histRows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
      }
    }
    emit(100, 7, 'Histórico salvo.');

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[Fruki/atualizar-tudo] Erro:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ═══════════════════════════════════════════════════════════
//  GALLO — Tenant isolado
//  Oracle: mesmo user/pass BIC, connect string bigeral_low | Drive: GALLO_GOOGLE_DRIVE_*
//  Tabela: sellers.GALLO_vendas_PARCEIRO
//  Sem holdings, sem CNPJ
// ═══════════════════════════════════════════════════════════

async function getGalloConn() {
  return oracledb.getConnection({
    user:          process.env.DB_USER,
    password:      process.env.GALLO_DB_PASSWORD,
    connectString: process.env.GALLO_DB_CONNECT_STRING,
  });
}

// ─── Comparativo Sellout Gallo ─────────────────────────
app.get('/gallo/comparativo', async (req, res) => {
  let conn;
  try {
    conn = await getGalloConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.GALLO_vendas_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR')
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      customer: r.PARTNER_NAME || '',
      anomes:   r.ANO_MES_FIX  || '',
      valor:    Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.GALLO_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
        console.log(`[Drive/Gallo] Comparativo salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Gallo] Erro ao salvar comparativo:', e.message); }
    })();
  } catch (err) {
    console.error('[Gallo/Oracle] Erro /gallo/comparativo:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

app.get('/gallo/listar-arquivos', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.GALLO_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.json([]);
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)', orderBy: 'createdTime desc', pageSize: 1000,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const files = (listResp.data.files || []).filter(f =>
      /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
    );
    files.sort((a, b) => {
      const da = parseDateFromFilename(a.name);
      const db = parseDateFromFilename(b.name);
      if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
      return db - da;
    });
    res.json(files.map(f => ({ id: f.id, name: f.name })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/gallo/ultimo-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.GALLO_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'GALLO_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID não configurado.' });
    let fileId = req.query.fileId || null;
    let filename = null;
    if (!fileId) {
      const listResp = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name)', pageSize: 1000,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      const files = (listResp.data.files || []).filter(f =>
        /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
      );
      if (!files.length) return res.status(404).json({ error: 'Nenhum arquivo encontrado.' });
      files.sort((a, b) => {
        const da = parseDateFromFilename(a.name);
        const db = parseDateFromFilename(b.name);
        if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
        return db - da;
      });
      fileId = files[0].id; filename = files[0].name;
    } else {
      const meta = await drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
      filename = meta.data.name;
    }
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    res.json({ filename, fileId, buffer: Buffer.from(fileResp.data).toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Batalha Naval Gallo ────────────────────────────────
async function galloSaveBatalhaNavalToDrive() {
  let conn;
  try {
    conn = await getGalloConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                      AS "PARTNER_NAME",
         TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0)     AS "VENDA_VALOR"
       FROM sellers.GALLO_vendas_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1))
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      PARTNER_NAME: r.PARTNER_NAME,
      VENDA_DATA:   r.VENDA_DATA,
      VENDA_VALOR:  r.VENDA_VALOR,
    }));
    const drive    = getDriveClient();
    const folderId = process.env.GALLO_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) { console.warn('[Drive/Gallo] GALLO_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado.'); return { rows }; }
    const now     = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const fileName = `gallo_batalha_${dateStr}.xlsx`;
    await mdiasSaveXlsx(drive, folderId, fileName, rows, 'Dados');
    console.log(`[Drive/Gallo] Batalha Naval salvo: "${fileName}" (${rows.length} linhas)`);
    return { fileName, rowCount: rows.length };
  } catch (err) {
    console.error('[Drive/Gallo] Erro ao salvar Batalha Naval:', err.message);
    throw err;
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
}

app.post('/gallo/batalha-naval-atualizar', async (req, res) => {
  try {
    const result = await galloSaveBatalhaNavalToDrive();
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/gallo/batalha-naval-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.GALLO_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'GALLO_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado' });
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime)', orderBy: 'createdTime desc', pageSize: 5,
      includeItemsFromAllDrives: true, supportsAllDrives: true,
    });
    const files = listResp.data.files || [];
    if (!files.length) return res.json({ fileId: null, name: null, createdTime: null });
    const f = files[0];
    res.json({ fileId: f.id, name: f.name, createdTime: f.createdTime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/gallo/batalha-naval-dados', async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório' });
    const drive    = getDriveClient();
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    const wb   = XLSX.read(fileResp.data, { type: 'array' });
    const ws   = wb.Sheets['Dados'] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Histórico de Vendas Gallo ──────────────────────────
app.get('/gallo/historico-vendas', async (req, res) => {
  let conn;
  try {
    conn = await getGalloConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.GALLO_vendas_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      partnerName: r.PARTNER_NAME || '',
      anoMes:      r.ANO_MES_FIX  || '',
      valor:       Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.GALLO_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `gallo_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
        console.log(`[Drive/Gallo] Histórico salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Gallo] Erro ao salvar histórico:', e.message); }
    })();
  } catch (err) {
    console.error('[Gallo/Oracle] Erro /gallo/historico-vendas:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ─── Atualizar Tudo Gallo — SSE ─────────────────────────
app.get('/gallo/atualizar-tudo', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = (pct, step, msg) => res.write(`data: ${JSON.stringify({ pct, step, msg })}\n\n`);
  let conn;
  try {
    emit(5,  1, 'Conectando ao Oracle Gallo…');
    conn = await getGalloConn();

    emit(20, 2, 'Buscando comparativo de sellout…');
    const compResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.GALLO_vendas_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR') AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const compRows = compResult.rows.map(r => ({ customer: r.PARTNER_NAME || '', anomes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(38, 2, `Comparativo: ${compRows.length} registros.`);

    emit(42, 3, 'Buscando Batalha Naval…');
    const bnResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.GALLO_vendas_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1)) AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const bnRows = bnResult.rows.map(r => ({ PARTNER_NAME: r.PARTNER_NAME, VENDA_DATA: r.VENDA_DATA, VENDA_VALOR: r.VENDA_VALOR }));
    emit(60, 3, `Batalha Naval: ${bnRows.length} registros.`);

    emit(65, 4, 'Buscando histórico de vendas…');
    const histResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.GALLO_vendas_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const histRows = histResult.rows.map(r => ({ partnerName: r.PARTNER_NAME || '', anoMes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(78, 4, `Histórico: ${histRows.length} registros.`);

    await conn.close(); conn = null;

    emit(83, 5, 'Salvando comparativo no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.GALLO_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = compRows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
      }
    }
    emit(88, 5, 'Comparativo salvo.');

    emit(90, 6, 'Salvando Batalha Naval no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.GALLO_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
      if (folderId) {
        const now = new Date(); const pad = n => String(n).padStart(2, '0');
        const dateStr  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
        const fileName = `gallo_batalha_${dateStr}.xlsx`;
        await mdiasSaveXlsx(drive, folderId, fileName, bnRows, 'Dados');
      }
    }
    emit(94, 6, 'Batalha Naval salva.');

    emit(96, 7, 'Salvando histórico no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.GALLO_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `gallo_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = histRows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
      }
    }
    emit(100, 7, 'Histórico salvo.');

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[Gallo/atualizar-tudo] Erro:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ═══════════════════════════════════════════════════════════
//  GTEX — Tenant isolado
//  Oracle: mesmo user/pass BIC, connect string bigeral_low (igual Gallo) | Drive: GTEX_GOOGLE_DRIVE_*
//  Tabela: sellers.GTEX_VENDAS_PARCEIRO
//  Sem holdings, sem CNPJ
// ═══════════════════════════════════════════════════════════

async function getGtexConn() { return getGalloConn(); }

// ─── Comparativo Sellout Gtex ─────────────────────────
app.get('/gtex/comparativo', async (req, res) => {
  let conn;
  try {
    conn = await getGtexConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.GTEX_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR')
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      customer: r.PARTNER_NAME || '',
      anomes:   r.ANO_MES_FIX  || '',
      valor:    Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.GTEX_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
        console.log(`[Drive/Gtex] Comparativo salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Gtex] Erro ao salvar comparativo:', e.message); }
    })();
  } catch (err) {
    console.error('[Gtex/Oracle] Erro /gtex/comparativo:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

app.get('/gtex/listar-arquivos', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.GTEX_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.json([]);
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)', orderBy: 'createdTime desc', pageSize: 1000,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const files = (listResp.data.files || []).filter(f =>
      /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
    );
    files.sort((a, b) => {
      const da = parseDateFromFilename(a.name);
      const db = parseDateFromFilename(b.name);
      if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
      return db - da;
    });
    res.json(files.map(f => ({ id: f.id, name: f.name })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/gtex/ultimo-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.GTEX_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'GTEX_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID não configurado.' });
    let fileId = req.query.fileId || null;
    let filename = null;
    if (!fileId) {
      const listResp = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name)', pageSize: 1000,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      const files = (listResp.data.files || []).filter(f =>
        /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
      );
      if (!files.length) return res.status(404).json({ error: 'Nenhum arquivo encontrado.' });
      files.sort((a, b) => {
        const da = parseDateFromFilename(a.name);
        const db = parseDateFromFilename(b.name);
        if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
        return db - da;
      });
      fileId = files[0].id; filename = files[0].name;
    } else {
      const meta = await drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
      filename = meta.data.name;
    }
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    res.json({ filename, fileId, buffer: Buffer.from(fileResp.data).toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Batalha Naval Gtex ────────────────────────────────
async function gtexSaveBatalhaNavalToDrive() {
  let conn;
  try {
    conn = await getGtexConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                      AS "PARTNER_NAME",
         TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0)     AS "VENDA_VALOR"
       FROM sellers.GTEX_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1))
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      PARTNER_NAME: r.PARTNER_NAME,
      VENDA_DATA:   r.VENDA_DATA,
      VENDA_VALOR:  r.VENDA_VALOR,
    }));
    const drive    = getDriveClient();
    const folderId = process.env.GTEX_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) { console.warn('[Drive/Gtex] GTEX_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado.'); return { rows }; }
    const now     = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const fileName = `gtex_batalha_${dateStr}.xlsx`;
    await mdiasSaveXlsx(drive, folderId, fileName, rows, 'Dados');
    console.log(`[Drive/Gtex] Batalha Naval salvo: "${fileName}" (${rows.length} linhas)`);
    return { fileName, rowCount: rows.length };
  } catch (err) {
    console.error('[Drive/Gtex] Erro ao salvar Batalha Naval:', err.message);
    throw err;
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
}

app.post('/gtex/batalha-naval-atualizar', async (req, res) => {
  try {
    const result = await gtexSaveBatalhaNavalToDrive();
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/gtex/batalha-naval-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.GTEX_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'GTEX_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado' });
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime)', orderBy: 'createdTime desc', pageSize: 5,
      includeItemsFromAllDrives: true, supportsAllDrives: true,
    });
    const files = listResp.data.files || [];
    if (!files.length) return res.json({ fileId: null, name: null, createdTime: null });
    const f = files[0];
    res.json({ fileId: f.id, name: f.name, createdTime: f.createdTime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/gtex/batalha-naval-dados', async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório' });
    const drive    = getDriveClient();
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    const wb   = XLSX.read(fileResp.data, { type: 'array' });
    const ws   = wb.Sheets['Dados'] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Histórico de Vendas Gtex ──────────────────────────
app.get('/gtex/historico-vendas', async (req, res) => {
  let conn;
  try {
    conn = await getGtexConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.GTEX_VENDAS_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      partnerName: r.PARTNER_NAME || '',
      anoMes:      r.ANO_MES_FIX  || '',
      valor:       Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.GTEX_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `gtex_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
        console.log(`[Drive/Gtex] Histórico salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Gtex] Erro ao salvar histórico:', e.message); }
    })();
  } catch (err) {
    console.error('[Gtex/Oracle] Erro /gtex/historico-vendas:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ─── Atualizar Tudo Gtex — SSE ─────────────────────────
app.get('/gtex/atualizar-tudo', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = (pct, step, msg) => res.write(`data: ${JSON.stringify({ pct, step, msg })}\n\n`);
  let conn;
  try {
    emit(5,  1, 'Conectando ao Oracle Gtex…');
    conn = await getGtexConn();

    emit(20, 2, 'Buscando comparativo de sellout…');
    const compResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.GTEX_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR') AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const compRows = compResult.rows.map(r => ({ customer: r.PARTNER_NAME || '', anomes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(38, 2, `Comparativo: ${compRows.length} registros.`);

    emit(42, 3, 'Buscando Batalha Naval…');
    const bnResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.GTEX_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1)) AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const bnRows = bnResult.rows.map(r => ({ PARTNER_NAME: r.PARTNER_NAME, VENDA_DATA: r.VENDA_DATA, VENDA_VALOR: r.VENDA_VALOR }));
    emit(60, 3, `Batalha Naval: ${bnRows.length} registros.`);

    emit(65, 4, 'Buscando histórico de vendas…');
    const histResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.GTEX_VENDAS_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const histRows = histResult.rows.map(r => ({ partnerName: r.PARTNER_NAME || '', anoMes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(78, 4, `Histórico: ${histRows.length} registros.`);

    await conn.close(); conn = null;

    emit(83, 5, 'Salvando comparativo no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.GTEX_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = compRows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
      }
    }
    emit(88, 5, 'Comparativo salvo.');

    emit(90, 6, 'Salvando Batalha Naval no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.GTEX_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
      if (folderId) {
        const now = new Date(); const pad = n => String(n).padStart(2, '0');
        const dateStr  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
        const fileName = `gtex_batalha_${dateStr}.xlsx`;
        await mdiasSaveXlsx(drive, folderId, fileName, bnRows, 'Dados');
      }
    }
    emit(94, 6, 'Batalha Naval salva.');

    emit(96, 7, 'Salvando histórico no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.GTEX_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `gtex_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = histRows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
      }
    }
    emit(100, 7, 'Histórico salvo.');

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[Gtex/atualizar-tudo] Erro:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ═══════════════════════════════════════════════════════════
//  M DIAS SAUDÁVEIS — Tenant isolado
//  Oracle: mesmo MDIAS_DB_* / bisellers_low | Drive: MDIASSAUD_GOOGLE_DRIVE_*
//  Tabela: sellers.mdias_saudaveis_vendas_parceiro
//  Sem holdings, sem CNPJ
// ═══════════════════════════════════════════════════════════

async function getMdiasSaudConn() { return getMDiasConn(); }

// ─── Comparativo Sellout M Dias Saudáveis ─────────────────
app.get('/mdiassaud/comparativo', async (req, res) => {
  let conn;
  try {
    conn = await getMdiasSaudConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.mdias_saudaveis_vendas_parceiro
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR')
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      customer: r.PARTNER_NAME || '',
      anomes:   r.ANO_MES_FIX  || '',
      valor:    Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.MDIASSAUD_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
        console.log(`[Drive/MdiasSaud] Comparativo salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/MdiasSaud] Erro ao salvar comparativo:', e.message); }
    })();
  } catch (err) {
    console.error('[MdiasSaud/Oracle] Erro /mdiassaud/comparativo:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

app.get('/mdiassaud/listar-arquivos', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.MDIASSAUD_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.json([]);
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)', orderBy: 'createdTime desc', pageSize: 1000,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const files = (listResp.data.files || []).filter(f =>
      /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
    );
    files.sort((a, b) => {
      const da = parseDateFromFilename(a.name);
      const db = parseDateFromFilename(b.name);
      if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
      return db - da;
    });
    res.json(files.map(f => ({ id: f.id, name: f.name })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/mdiassaud/ultimo-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.MDIASSAUD_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'MDIASSAUD_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID não configurado.' });
    let fileId = req.query.fileId || null;
    let filename = null;
    if (!fileId) {
      const listResp = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name)', pageSize: 1000,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      const files = (listResp.data.files || []).filter(f =>
        /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
      );
      if (!files.length) return res.status(404).json({ error: 'Nenhum arquivo encontrado.' });
      files.sort((a, b) => {
        const da = parseDateFromFilename(a.name);
        const db = parseDateFromFilename(b.name);
        if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
        return db - da;
      });
      fileId = files[0].id; filename = files[0].name;
    } else {
      const meta = await drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
      filename = meta.data.name;
    }
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    res.json({ filename, fileId, buffer: Buffer.from(fileResp.data).toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Batalha Naval M Dias Saudáveis ───────────────────────
async function mdiassaudSaveBatalhaNavalToDrive() {
  let conn;
  try {
    conn = await getMdiasSaudConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                      AS "PARTNER_NAME",
         TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0)     AS "VENDA_VALOR"
       FROM sellers.mdias_saudaveis_vendas_parceiro
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1))
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      PARTNER_NAME: r.PARTNER_NAME,
      VENDA_DATA:   r.VENDA_DATA,
      VENDA_VALOR:  r.VENDA_VALOR,
    }));
    const drive    = getDriveClient();
    const folderId = process.env.MDIASSAUD_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) { console.warn('[Drive/MdiasSaud] MDIASSAUD_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado.'); return { rows }; }
    const now     = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const fileName = `mdiassaud_batalha_${dateStr}.xlsx`;
    await mdiasSaveXlsx(drive, folderId, fileName, rows, 'Dados');
    console.log(`[Drive/MdiasSaud] Batalha Naval salvo: "${fileName}" (${rows.length} linhas)`);
    return { fileName, rowCount: rows.length };
  } catch (err) {
    console.error('[Drive/MdiasSaud] Erro ao salvar Batalha Naval:', err.message);
    throw err;
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
}

app.post('/mdiassaud/batalha-naval-atualizar', async (req, res) => {
  try {
    const result = await mdiassaudSaveBatalhaNavalToDrive();
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/mdiassaud/batalha-naval-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.MDIASSAUD_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'MDIASSAUD_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado' });
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime)', orderBy: 'createdTime desc', pageSize: 5,
      includeItemsFromAllDrives: true, supportsAllDrives: true,
    });
    const files = listResp.data.files || [];
    if (!files.length) return res.json({ fileId: null, name: null, createdTime: null });
    const f = files[0];
    res.json({ fileId: f.id, name: f.name, createdTime: f.createdTime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/mdiassaud/batalha-naval-dados', async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório' });
    const drive    = getDriveClient();
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    const wb   = XLSX.read(fileResp.data, { type: 'array' });
    const ws   = wb.Sheets['Dados'] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Histórico de Vendas M Dias Saudáveis ─────────────────
app.get('/mdiassaud/historico-vendas', async (req, res) => {
  let conn;
  try {
    conn = await getMdiasSaudConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.mdias_saudaveis_vendas_parceiro
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      partnerName: r.PARTNER_NAME || '',
      anoMes:      r.ANO_MES_FIX  || '',
      valor:       Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.MDIASSAUD_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `mdiassaud_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
        console.log(`[Drive/MdiasSaud] Histórico salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/MdiasSaud] Erro ao salvar histórico:', e.message); }
    })();
  } catch (err) {
    console.error('[MdiasSaud/Oracle] Erro /mdiassaud/historico-vendas:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ─── Atualizar Tudo M Dias Saudáveis — SSE ────────────────
app.get('/mdiassaud/atualizar-tudo', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = (pct, step, msg) => res.write(`data: ${JSON.stringify({ pct, step, msg })}\n\n`);
  let conn;
  try {
    emit(5,  1, 'Conectando ao Oracle M Dias Saudáveis…');
    conn = await getMdiasSaudConn();

    emit(20, 2, 'Buscando comparativo de sellout…');
    const compResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.mdias_saudaveis_vendas_parceiro
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR') AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const compRows = compResult.rows.map(r => ({ customer: r.PARTNER_NAME || '', anomes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(38, 2, `Comparativo: ${compRows.length} registros.`);

    emit(42, 3, 'Buscando Batalha Naval…');
    const bnResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.mdias_saudaveis_vendas_parceiro
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1)) AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const bnRows = bnResult.rows.map(r => ({ PARTNER_NAME: r.PARTNER_NAME, VENDA_DATA: r.VENDA_DATA, VENDA_VALOR: r.VENDA_VALOR }));
    emit(60, 3, `Batalha Naval: ${bnRows.length} registros.`);

    emit(65, 4, 'Buscando histórico de vendas…');
    const histResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.mdias_saudaveis_vendas_parceiro
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const histRows = histResult.rows.map(r => ({ partnerName: r.PARTNER_NAME || '', anoMes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(78, 4, `Histórico: ${histRows.length} registros.`);

    await conn.close(); conn = null;

    emit(83, 5, 'Salvando comparativo no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.MDIASSAUD_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = compRows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
      }
    }
    emit(88, 5, 'Comparativo salvo.');

    emit(90, 6, 'Salvando Batalha Naval no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.MDIASSAUD_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
      if (folderId) {
        const now = new Date(); const pad = n => String(n).padStart(2, '0');
        const dateStr  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
        const fileName = `mdiassaud_batalha_${dateStr}.xlsx`;
        await mdiasSaveXlsx(drive, folderId, fileName, bnRows, 'Dados');
      }
    }
    emit(94, 6, 'Batalha Naval salva.');

    emit(96, 7, 'Salvando histórico no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.MDIASSAUD_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `mdiassaud_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = histRows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
      }
    }
    emit(100, 7, 'Histórico salvo.');

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[MdiasSaud/atualizar-tudo] Erro:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ═══════════════════════════════════════════════════════════
//  KIBON — Tenant isolado
//  Oracle: mesmo user/pass BIC, connect string bikibon_low (igual Bombril) | Drive: KIBON_GOOGLE_DRIVE_*
//  Tabela: sellers.sellers_kibon_vendas_parceiro
//  Coluna de valor: VENDA_VALOR_BRUTO (diferente dos demais)
//  Sem holdings, sem CNPJ
// ═══════════════════════════════════════════════════════════

async function getKibonConn() { return getBombrilConn(); }

// ─── Comparativo Sellout Kibon ────────────────────────────
app.get('/kibon/comparativo', async (req, res) => {
  let conn;
  try {
    conn = await getKibonConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                        AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')        AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR_BRUTO"), 0) AS "VENDA_VALOR_BRUTO"
       FROM sellers.sellers_kibon_vendas_parceiro
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR')
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      customer: r.PARTNER_NAME    || '',
      anomes:   r.ANO_MES_FIX     || '',
      valor:    Number(r.VENDA_VALOR_BRUTO) || 0,
    }));
    res.json(rows);
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.KIBON_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR_BRUTO: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
        console.log(`[Drive/Kibon] Comparativo salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Kibon] Erro ao salvar comparativo:', e.message); }
    })();
  } catch (err) {
    console.error('[Kibon/Oracle] Erro /kibon/comparativo:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

app.get('/kibon/listar-arquivos', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.KIBON_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.json([]);
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)', orderBy: 'createdTime desc', pageSize: 1000,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const files = (listResp.data.files || []).filter(f =>
      /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
    );
    files.sort((a, b) => {
      const da = parseDateFromFilename(a.name);
      const db = parseDateFromFilename(b.name);
      if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
      return db - da;
    });
    res.json(files.map(f => ({ id: f.id, name: f.name })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/kibon/ultimo-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.KIBON_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'KIBON_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID não configurado.' });
    let fileId = req.query.fileId || null;
    let filename = null;
    if (!fileId) {
      const listResp = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name)', pageSize: 1000,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      const files = (listResp.data.files || []).filter(f =>
        /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
      );
      if (!files.length) return res.status(404).json({ error: 'Nenhum arquivo encontrado.' });
      files.sort((a, b) => {
        const da = parseDateFromFilename(a.name);
        const db = parseDateFromFilename(b.name);
        if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
        return db - da;
      });
      fileId = files[0].id; filename = files[0].name;
    } else {
      const meta = await drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
      filename = meta.data.name;
    }
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    res.json({ filename, fileId, buffer: Buffer.from(fileResp.data).toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Batalha Naval Kibon ──────────────────────────────────
async function kibonSaveBatalhaNavalToDrive() {
  let conn;
  try {
    conn = await getKibonConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                        AS "PARTNER_NAME",
         TO_CHAR("VENDA_DATA", 'YYYY-MM-DD')   AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR_BRUTO"), 0) AS "VENDA_VALOR_BRUTO"
       FROM sellers.sellers_kibon_vendas_parceiro
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1))
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      PARTNER_NAME:      r.PARTNER_NAME,
      VENDA_DATA:        r.VENDA_DATA,
      VENDA_VALOR_BRUTO: r.VENDA_VALOR_BRUTO,
    }));
    const drive    = getDriveClient();
    const folderId = process.env.KIBON_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) { console.warn('[Drive/Kibon] KIBON_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado.'); return { rows }; }
    const now     = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const fileName = `kibon_batalha_${dateStr}.xlsx`;
    await mdiasSaveXlsx(drive, folderId, fileName, rows, 'Dados');
    console.log(`[Drive/Kibon] Batalha Naval salvo: "${fileName}" (${rows.length} linhas)`);
    return { fileName, rowCount: rows.length };
  } catch (err) {
    console.error('[Drive/Kibon] Erro ao salvar Batalha Naval:', err.message);
    throw err;
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
}

app.post('/kibon/batalha-naval-atualizar', async (req, res) => {
  try {
    const result = await kibonSaveBatalhaNavalToDrive();
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/kibon/batalha-naval-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.KIBON_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'KIBON_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado' });
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime)', orderBy: 'createdTime desc', pageSize: 5,
      includeItemsFromAllDrives: true, supportsAllDrives: true,
    });
    const files = listResp.data.files || [];
    if (!files.length) return res.json({ fileId: null, name: null, createdTime: null });
    const f = files[0];
    res.json({ fileId: f.id, name: f.name, createdTime: f.createdTime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/kibon/batalha-naval-dados', async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório' });
    const drive    = getDriveClient();
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    const wb   = XLSX.read(fileResp.data, { type: 'array' });
    const ws   = wb.Sheets['Dados'] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Histórico de Vendas Kibon ────────────────────────────
app.get('/kibon/historico-vendas', async (req, res) => {
  let conn;
  try {
    conn = await getKibonConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                        AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')        AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR_BRUTO"), 0) AS "VENDA_VALOR_BRUTO"
       FROM sellers.sellers_kibon_vendas_parceiro
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      partnerName: r.PARTNER_NAME    || '',
      anoMes:      r.ANO_MES_FIX     || '',
      valor:       Number(r.VENDA_VALOR_BRUTO) || 0,
    }));
    res.json(rows);
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.KIBON_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `kibon_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR_BRUTO: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
        console.log(`[Drive/Kibon] Histórico salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Kibon] Erro ao salvar histórico:', e.message); }
    })();
  } catch (err) {
    console.error('[Kibon/Oracle] Erro /kibon/historico-vendas:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ─── Atualizar Tudo Kibon — SSE ───────────────────────────
app.get('/kibon/atualizar-tudo', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = (pct, step, msg) => res.write(`data: ${JSON.stringify({ pct, step, msg })}\n\n`);
  let conn;
  try {
    emit(5,  1, 'Conectando ao Oracle Kibon…');
    conn = await getKibonConn();

    emit(20, 2, 'Buscando comparativo de sellout…');
    const compResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR_BRUTO"), 0) AS "VENDA_VALOR_BRUTO"
       FROM sellers.sellers_kibon_vendas_parceiro
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR') AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const compRows = compResult.rows.map(r => ({ customer: r.PARTNER_NAME || '', anomes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR_BRUTO) || 0 }));
    emit(38, 2, `Comparativo: ${compRows.length} registros.`);

    emit(42, 3, 'Buscando Batalha Naval…');
    const bnResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR_BRUTO"), 0) AS "VENDA_VALOR_BRUTO"
       FROM sellers.sellers_kibon_vendas_parceiro
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1)) AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const bnRows = bnResult.rows.map(r => ({ PARTNER_NAME: r.PARTNER_NAME, VENDA_DATA: r.VENDA_DATA, VENDA_VALOR_BRUTO: r.VENDA_VALOR_BRUTO }));
    emit(60, 3, `Batalha Naval: ${bnRows.length} registros.`);

    emit(65, 4, 'Buscando histórico de vendas…');
    const histResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR_BRUTO"), 0) AS "VENDA_VALOR_BRUTO"
       FROM sellers.sellers_kibon_vendas_parceiro
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const histRows = histResult.rows.map(r => ({ partnerName: r.PARTNER_NAME || '', anoMes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR_BRUTO) || 0 }));
    emit(78, 4, `Histórico: ${histRows.length} registros.`);

    await conn.close(); conn = null;

    emit(83, 5, 'Salvando comparativo no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.KIBON_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = compRows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR_BRUTO: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
      }
    }
    emit(88, 5, 'Comparativo salvo.');

    emit(90, 6, 'Salvando Batalha Naval no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.KIBON_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
      if (folderId) {
        const now = new Date(); const pad = n => String(n).padStart(2, '0');
        const dateStr  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
        const fileName = `kibon_batalha_${dateStr}.xlsx`;
        await mdiasSaveXlsx(drive, folderId, fileName, bnRows, 'Dados');
      }
    }
    emit(94, 6, 'Batalha Naval salva.');

    emit(96, 7, 'Salvando histórico no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.KIBON_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `kibon_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = histRows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR_BRUTO: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
      }
    }
    emit(100, 7, 'Histórico salvo.');

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[Kibon/atualizar-tudo] Erro:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ═══════════════════════════════════════════════════════════
//  PEPSICO — Tenant isolado
//  Oracle: mesmas credenciais Marilan (bigeral2) | Drive: PEPSICO_GOOGLE_DRIVE_*
//  Tabela: sellers.PEPSICO_VENDAS_PARCEIRO
//  Sem holdings, sem CNPJ
// ═══════════════════════════════════════════════════════════

async function getPepsicoConn() { return getMarilanConn(); }

// ─── Comparativo Sellout Pepsico ─────────────────────────
app.get('/pepsico/comparativo', async (req, res) => {
  let conn;
  try {
    conn = await getPepsicoConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.PEPSICO_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR')
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      customer: r.PARTNER_NAME || '',
      anomes:   r.ANO_MES_FIX  || '',
      valor:    Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    // Salvar no Drive de forma assíncrona
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.PEPSICO_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
        console.log(`[Drive/Pepsico] Comparativo salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Pepsico] Erro ao salvar comparativo:', e.message); }
    })();
  } catch (err) {
    console.error('[Pepsico/Oracle] Erro /pepsico/comparativo:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

app.get('/pepsico/listar-arquivos', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.PEPSICO_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.json([]);
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)', orderBy: 'createdTime desc', pageSize: 1000,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const files = (listResp.data.files || []).filter(f =>
      /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
    );
    files.sort((a, b) => {
      const da = parseDateFromFilename(a.name);
      const db = parseDateFromFilename(b.name);
      if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
      return db - da;
    });
    res.json(files.map(f => ({ id: f.id, name: f.name })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/pepsico/ultimo-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.PEPSICO_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'PEPSICO_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID não configurado.' });
    let fileId = req.query.fileId || null;
    let filename = null;
    if (!fileId) {
      const listResp = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name)', pageSize: 1000,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      const files = (listResp.data.files || []).filter(f =>
        /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
      );
      if (!files.length) return res.status(404).json({ error: 'Nenhum arquivo encontrado.' });
      files.sort((a, b) => {
        const da = parseDateFromFilename(a.name);
        const db = parseDateFromFilename(b.name);
        if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
        return db - da;
      });
      fileId = files[0].id; filename = files[0].name;
    } else {
      const meta = await drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
      filename = meta.data.name;
    }
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    res.json({ filename, fileId, buffer: Buffer.from(fileResp.data).toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Batalha Naval Pepsico ────────────────────────────────
async function pepsicoSaveBatalhaNavalToDrive() {
  let conn;
  try {
    conn = await getPepsicoConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                      AS "PARTNER_NAME",
         TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0)     AS "VENDA_VALOR"
       FROM sellers.PEPSICO_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1))
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      PARTNER_NAME: r.PARTNER_NAME,
      VENDA_DATA:   r.VENDA_DATA,
      VENDA_VALOR:  r.VENDA_VALOR,
    }));
    const drive    = getDriveClient();
    const folderId = process.env.PEPSICO_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) { console.warn('[Drive/Pepsico] PEPSICO_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado.'); return { rows }; }
    const now     = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const fileName = `pepsico_batalha_${dateStr}.xlsx`;
    await mdiasSaveXlsx(drive, folderId, fileName, rows, 'Dados');
    console.log(`[Drive/Pepsico] Batalha Naval salvo: "${fileName}" (${rows.length} linhas)`);
    return { fileName, rowCount: rows.length };
  } catch (err) {
    console.error('[Drive/Pepsico] Erro ao salvar Batalha Naval:', err.message);
    throw err;
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
}

app.post('/pepsico/batalha-naval-atualizar', async (req, res) => {
  try {
    const result = await pepsicoSaveBatalhaNavalToDrive();
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/pepsico/batalha-naval-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.PEPSICO_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'PEPSICO_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado' });
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime)', orderBy: 'createdTime desc', pageSize: 5,
      includeItemsFromAllDrives: true, supportsAllDrives: true,
    });
    const files = listResp.data.files || [];
    if (!files.length) return res.json({ fileId: null, name: null, createdTime: null });
    const f = files[0];
    res.json({ fileId: f.id, name: f.name, createdTime: f.createdTime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/pepsico/batalha-naval-dados', async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório' });
    const drive    = getDriveClient();
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    const wb   = XLSX.read(fileResp.data, { type: 'array' });
    const ws   = wb.Sheets['Dados'] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Histórico de Vendas Pepsico ──────────────────────────
app.get('/pepsico/historico-vendas', async (req, res) => {
  let conn;
  try {
    conn = await getPepsicoConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.PEPSICO_VENDAS_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      partnerName: r.PARTNER_NAME || '',
      anoMes:      r.ANO_MES_FIX  || '',
      valor:       Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    // Salvar no Drive de forma assíncrona
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.PEPSICO_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `pepsico_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
        console.log(`[Drive/Pepsico] Histórico salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Pepsico] Erro ao salvar histórico:', e.message); }
    })();
  } catch (err) {
    console.error('[Pepsico/Oracle] Erro /pepsico/historico-vendas:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ─── Atualizar Tudo Pepsico — SSE ─────────────────────────
app.get('/pepsico/atualizar-tudo', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = (pct, step, msg) => res.write(`data: ${JSON.stringify({ pct, step, msg })}\n\n`);
  let conn;
  try {
    emit(5,  1, 'Conectando ao Oracle Pepsico…');
    conn = await getPepsicoConn();

    emit(20, 2, 'Buscando comparativo de sellout…');
    const compResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.PEPSICO_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR') AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const compRows = compResult.rows.map(r => ({ customer: r.PARTNER_NAME || '', anomes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(38, 2, `Comparativo: ${compRows.length} registros.`);

    emit(42, 3, 'Buscando Batalha Naval…');
    const bnResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.PEPSICO_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1)) AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const bnRows = bnResult.rows.map(r => ({ PARTNER_NAME: r.PARTNER_NAME, VENDA_DATA: r.VENDA_DATA, VENDA_VALOR: r.VENDA_VALOR }));
    emit(60, 3, `Batalha Naval: ${bnRows.length} registros.`);

    emit(65, 4, 'Buscando histórico de vendas…');
    const histResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.PEPSICO_VENDAS_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const histRows = histResult.rows.map(r => ({ partnerName: r.PARTNER_NAME || '', anoMes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(78, 4, `Histórico: ${histRows.length} registros.`);

    await conn.close(); conn = null;

    emit(83, 5, 'Salvando comparativo no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.PEPSICO_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = compRows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
      }
    }
    emit(88, 5, 'Comparativo salvo.');

    emit(90, 6, 'Salvando Batalha Naval no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.PEPSICO_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
      if (folderId) {
        const now = new Date(); const pad = n => String(n).padStart(2, '0');
        const dateStr  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
        const fileName = `pepsico_batalha_${dateStr}.xlsx`;
        await mdiasSaveXlsx(drive, folderId, fileName, bnRows, 'Dados');
      }
    }
    emit(94, 6, 'Batalha Naval salva.');

    emit(96, 7, 'Salvando histórico no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.PEPSICO_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `pepsico_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = histRows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
      }
    }
    emit(100, 7, 'Histórico salvo.');

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[Pepsico/atualizar-tudo] Erro:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ═══════════════════════════════════════════════════════════
//  PECCIN — Tenant isolado
//  Oracle: mesmo user/pass BIC, connect string bikibon_low (igual Bombril/Kibon) | Drive: PECCIN_GOOGLE_DRIVE_*
//  Tabela: sellers.PECCIN_VENDAS_PARCEIRO
//  Sem holdings, sem CNPJ
// ═══════════════════════════════════════════════════════════

async function getPeccinConn() { return getBombrilConn(); }

// ─── Comparativo Sellout Peccin ──────────────────────────
app.get('/peccin/comparativo', async (req, res) => {
  let conn;
  try {
    conn = await getPeccinConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.PECCIN_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR')
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      customer: r.PARTNER_NAME || '',
      anomes:   r.ANO_MES_FIX  || '',
      valor:    Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.PECCIN_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
        console.log(`[Drive/Peccin] Comparativo salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Peccin] Erro ao salvar comparativo:', e.message); }
    })();
  } catch (err) {
    console.error('[Peccin/Oracle] Erro /peccin/comparativo:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

app.get('/peccin/listar-arquivos', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.PECCIN_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.json([]);
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)', orderBy: 'createdTime desc', pageSize: 1000,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const files = (listResp.data.files || []).filter(f =>
      /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
    );
    files.sort((a, b) => {
      const da = parseDateFromFilename(a.name);
      const db = parseDateFromFilename(b.name);
      if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
      return db - da;
    });
    res.json(files.map(f => ({ id: f.id, name: f.name })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/peccin/ultimo-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.PECCIN_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'PECCIN_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID não configurado.' });
    let fileId = req.query.fileId || null;
    let filename = null;
    if (!fileId) {
      const listResp = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name)', pageSize: 1000,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      const files = (listResp.data.files || []).filter(f =>
        /^relatorio_\d{2}-\d{2}-\d{4}.*\.xlsx$/i.test(f.name)
      );
      if (!files.length) return res.status(404).json({ error: 'Nenhum arquivo encontrado.' });
      files.sort((a, b) => {
        const da = parseDateFromFilename(a.name);
        const db = parseDateFromFilename(b.name);
        if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
        return db - da;
      });
      fileId = files[0].id; filename = files[0].name;
    } else {
      const meta = await drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
      filename = meta.data.name;
    }
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    res.json({ filename, fileId, buffer: Buffer.from(fileResp.data).toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Batalha Naval Peccin ─────────────────────────────────
async function peccinSaveBatalhaNavalToDrive() {
  let conn;
  try {
    conn = await getPeccinConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                      AS "PARTNER_NAME",
         TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0)     AS "VENDA_VALOR"
       FROM sellers.PECCIN_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1))
         AND "VENDA_DATA" <  ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      PARTNER_NAME: r.PARTNER_NAME,
      VENDA_DATA:   r.VENDA_DATA,
      VENDA_VALOR:  r.VENDA_VALOR,
    }));
    const drive    = getDriveClient();
    const folderId = process.env.PECCIN_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) { console.warn('[Drive/Peccin] PECCIN_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado.'); return { rows }; }
    const now     = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const fileName = `peccin_batalha_${dateStr}.xlsx`;
    await mdiasSaveXlsx(drive, folderId, fileName, rows, 'Dados');
    console.log(`[Drive/Peccin] Batalha Naval salvo: "${fileName}" (${rows.length} linhas)`);
    return { fileName, rowCount: rows.length };
  } catch (err) {
    console.error('[Drive/Peccin] Erro ao salvar Batalha Naval:', err.message);
    throw err;
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
}

app.post('/peccin/batalha-naval-atualizar', async (req, res) => {
  try {
    const result = await peccinSaveBatalhaNavalToDrive();
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/peccin/batalha-naval-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient();
    const folderId = process.env.PECCIN_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'PECCIN_GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado' });
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime)', orderBy: 'createdTime desc', pageSize: 5,
      includeItemsFromAllDrives: true, supportsAllDrives: true,
    });
    const files = listResp.data.files || [];
    if (!files.length) return res.json({ fileId: null, name: null, createdTime: null });
    const f = files[0];
    res.json({ fileId: f.id, name: f.name, createdTime: f.createdTime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/peccin/batalha-naval-dados', async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório' });
    const drive    = getDriveClient();
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }
    );
    const wb   = XLSX.read(fileResp.data, { type: 'array' });
    const ws   = wb.Sheets['Dados'] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Histórico de Vendas Peccin ───────────────────────────
app.get('/peccin/historico-vendas', async (req, res) => {
  let conn;
  try {
    conn = await getPeccinConn();
    const result = await conn.execute(
      `SELECT
         "PARTNER_NAME"                   AS "PARTNER_NAME",
         TO_CHAR(VENDA_DATA, 'YYYY-MM')   AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0)  AS "VENDA_VALOR"
       FROM sellers.PECCIN_VENDAS_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows.map(r => ({
      partnerName: r.PARTNER_NAME || '',
      anoMes:      r.ANO_MES_FIX  || '',
      valor:       Number(r.VENDA_VALOR) || 0,
    }));
    res.json(rows);
    (async () => {
      try {
        const drive    = getDriveClient();
        const folderId = process.env.PECCIN_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
        if (!folderId) return;
        const { d, mo, y } = buildBrDateStr();
        const filename = `peccin_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = rows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
        console.log(`[Drive/Peccin] Histórico salvo: "${filename}".`);
      } catch (e) { console.error('[Drive/Peccin] Erro ao salvar histórico:', e.message); }
    })();
  } catch (err) {
    console.error('[Peccin/Oracle] Erro /peccin/historico-vendas:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ─── Atualizar Tudo Peccin — SSE ──────────────────────────
app.get('/peccin/atualizar-tudo', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const emit = (pct, step, msg) => res.write(`data: ${JSON.stringify({ pct, step, msg })}\n\n`);
  let conn;
  try {
    emit(5,  1, 'Conectando ao Oracle Peccin…');
    conn = await getPeccinConn();

    emit(20, 2, 'Buscando comparativo de sellout…');
    const compResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.PECCIN_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= TRUNC(SYSDATE, 'YEAR') AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const compRows = compResult.rows.map(r => ({ customer: r.PARTNER_NAME || '', anomes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(38, 2, `Comparativo: ${compRows.length} registros.`);

    emit(42, 3, 'Buscando Batalha Naval…');
    const bnResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR("VENDA_DATA", 'YYYY-MM-DD') AS "VENDA_DATA",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.PECCIN_VENDAS_PARCEIRO
       WHERE "VENDA_DATA" >= LEAST(TRUNC(SYSDATE, 'YEAR'), ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1)) AND "VENDA_DATA" < ADD_MONTHS(TRUNC(SYSDATE, 'YEAR'), 12)
       GROUP BY "PARTNER_NAME", "VENDA_DATA"`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const bnRows = bnResult.rows.map(r => ({ PARTNER_NAME: r.PARTNER_NAME, VENDA_DATA: r.VENDA_DATA, VENDA_VALOR: r.VENDA_VALOR }));
    emit(60, 3, `Batalha Naval: ${bnRows.length} registros.`);

    emit(65, 4, 'Buscando histórico de vendas…');
    const histResult = await conn.execute(
      `SELECT "PARTNER_NAME" AS "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM') AS "ANO_MES_FIX",
         COALESCE(SUM("VENDA_VALOR"), 0) AS "VENDA_VALOR"
       FROM sellers.PECCIN_VENDAS_PARCEIRO
       GROUP BY "PARTNER_NAME", TO_CHAR(VENDA_DATA, 'YYYY-MM')`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const histRows = histResult.rows.map(r => ({ partnerName: r.PARTNER_NAME || '', anoMes: r.ANO_MES_FIX || '', valor: Number(r.VENDA_VALOR) || 0 }));
    emit(78, 4, `Histórico: ${histRows.length} registros.`);

    await conn.close(); conn = null;

    emit(83, 5, 'Salvando comparativo no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.PECCIN_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `relatorio_${d}-${mo}-${y}.xlsx`;
        const wsRows   = compRows.map(r => ({ PARTNER_NAME: r.customer, ANO_MES: r.anomes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Dados');
      }
    }
    emit(88, 5, 'Comparativo salvo.');

    emit(90, 6, 'Salvando Batalha Naval no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.PECCIN_GOOGLE_DRIVE_BATALHA_FOLDER_ID;
      if (folderId) {
        const now = new Date(); const pad = n => String(n).padStart(2, '0');
        const dateStr  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
        const fileName = `peccin_batalha_${dateStr}.xlsx`;
        await mdiasSaveXlsx(drive, folderId, fileName, bnRows, 'Dados');
      }
    }
    emit(94, 6, 'Batalha Naval salva.');

    emit(96, 7, 'Salvando histórico no Drive…');
    {
      const drive    = getDriveClient();
      const folderId = process.env.PECCIN_GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
      if (folderId) {
        const { d, mo, y } = buildBrDateStr();
        const filename = `peccin_historico_${d}-${mo}-${y}.xlsx`;
        const wsRows   = histRows.map(r => ({ PARTNER_NAME: r.partnerName, ANO_MES: r.anoMes, VENDA_VALOR: r.valor }));
        await mdiasSaveXlsx(drive, folderId, filename, wsRows, 'Histórico');
      }
    }
    emit(100, 7, 'Histórico salvo.');

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[Peccin/atualizar-tudo] Erro:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  } finally {
    if (conn) { try { await conn.close(); } catch (_) {} }
  }
});

// ─────────────────────────────────────────
//  Start
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  Backend rodando em http://localhost:${PORT}`);
  console.log(`    Oracle user   : ${process.env.DB_USER}`);
  console.log(`    Drive folder  : ${process.env.GOOGLE_DRIVE_FOLDER_ID}`);
});
