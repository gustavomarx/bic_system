require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3004;

// ─── Middlewares ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ─── Google Drive auth ────────────────────────────────────────────────────────
function getDriveClient(readOnly = true) {
  const scopes = readOnly
    ? ['https://www.googleapis.com/auth/drive.readonly']
    : ['https://www.googleapis.com/auth/drive'];

  let authConfig;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    // Produção: credenciais via variável de ambiente (base64)
    const credentials = JSON.parse(
      Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, 'base64').toString('utf-8')
    );
    authConfig = { credentials, scopes };
  } else {
    // Local: credenciais via arquivo
    authConfig = { keyFile: path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_PATH), scopes };
  }

  const auth = new google.auth.GoogleAuth(authConfig);
  return google.drive({ version: 'v3', auth });
}

// ─── Normalização de colunas ──────────────────────────────────────────────────
const COL_MAP = {
  holding: ['holding', 'HOLDING', 'Holding'],
  customer: ['customer', 'partner_name', 'PARTNER_NAME', 'PartnerName', 'partner name', 'distribuidor'],
  anoMes: ['anomes', 'ANOMES', 'AnoMes', 'ano_mes', 'ANO_MES', 'anoMes'],
  vendaValor: ['venda_valor', 'VENDA_VALOR', 'VendaValor', 'valor', 'Valor', 'VALOR'],
  cnpj: ['cnpj_customer', 'CNPJ_CUSTOMER', 'cnpj', 'CNPJ', 'Cnpj'],
};

function normalizeRow(rawRow) {
  const row = {};
  // normaliza chaves para lowercase sem espaços
  const keys = Object.keys(rawRow);

  for (const [field, aliases] of Object.entries(COL_MAP)) {
    const found = keys.find(k =>
      aliases.some(a => a.toLowerCase() === k.toLowerCase().trim())
    );
    row[field] = found !== undefined ? rawRow[found] : null;
  }
  return row;
}

// ─── Extrai data do nome do arquivo ──────────────────────────────────────────
function extractDateFromName(name) {
  // Suporta relatorio_DD-MM-YYYY.xlsx ou qualquer sufixo com DD-MM-YYYY
  const match = name.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (!match) return null;
  const [, d, m, y] = match;
  // Retorna objeto com campos já formatados — evita problemas de timezone
  return { iso: `${y}-${m}-${d}`, formatted: `${d}/${m}/${y}` };
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// GET /api/arquivos — lista arquivos Excel ordenados por data (mais recente primeiro)
app.get('/api/arquivos', async (req, res) => {
  try {
    const drive = getDriveClient();
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

    const response = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime, modifiedTime)',
      orderBy: 'name desc',
      pageSize: 100,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    const files = (response.data.files || [])
      .map(f => {
        const date = extractDateFromName(f.name);
        return {
          id: f.id,
          name: f.name,
          date: date ? date.iso : null,
          dateFormatted: date ? date.formatted : 'Data desconhecida',
        };
      })
      .filter(f => f.date !== null)
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json(files);
  } catch (err) {
    console.error('Erro ao listar arquivos:', err.message);
    res.status(500).json({ error: 'Erro ao listar arquivos do Drive', detail: err.message });
  }
});

// GET /api/arquivo?fileId= — baixa e parseia um arquivo Excel
app.get('/api/arquivo', async (req, res) => {
  const { fileId } = req.query;
  if (!fileId) return res.status(400).json({ error: 'fileId é obrigatório' });

  try {
    const drive = getDriveClient();

    // Baixa o arquivo como stream e coleta em buffer
    const response = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );

    const workbook = XLSX.read(response.data, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const rawData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null });

    const rows = rawData
      .map(normalizeRow)
      .filter(r => r.holding && r.vendaValor !== null);

    res.json(rows);
  } catch (err) {
    console.error('Erro ao baixar arquivo:', err.message);
    res.status(500).json({ error: 'Erro ao baixar/parsear arquivo', detail: err.message });
  }
});

// ─── Inatividade: lista snapshots ─────────────────────────────────────────────
// GET /api/inatividade-arquivos — lista arquivos inatividade_DD-MM-YYYY.xlsx
app.get('/api/inatividade-arquivos', async (req, res) => {
  try {
    const drive = getDriveClient();
    const folderId = process.env.GOOGLE_DRIVE_INATIV_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'GOOGLE_DRIVE_INATIV_FOLDER_ID não configurado' });

    const response = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'name desc',
      pageSize: 365,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    const files = (response.data.files || [])
      .map(f => {
        const date = extractDateFromName(f.name);
        return { id: f.id, name: f.name, date: date ? date.iso : null, dateFormatted: date ? date.formatted : null };
      })
      .filter(f => f.date !== null)
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json(files);
  } catch (err) {
    console.error('Erro ao listar inatividade:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inatividade-historico?limit=N — agrega N snapshots mais recentes em um único payload
// Retorna: { snapshots: [{date, dateFormatted, fileId, rows:[{partner,cnpj,data,iso,diaNum,diaSemana}]}] }
app.get('/api/inatividade-historico', async (req, res) => {
  try {
    const drive = getDriveClient();
    const folderId = process.env.GOOGLE_DRIVE_INATIV_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'GOOGLE_DRIVE_INATIV_FOLDER_ID não configurado' });

    const limit = Math.min(parseInt(req.query.limit) || 90, 365);

    // 1. Lista arquivos
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'name desc',
      pageSize: 365,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    const files = (listResp.data.files || [])
      .map(f => {
        const date = extractDateFromName(f.name);
        return { id: f.id, name: f.name, date: date ? date.iso : null, dateFormatted: date ? date.formatted : null };
      })
      .filter(f => f.date !== null)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, limit);

    if (!files.length) return res.json({ snapshots: [] });

    // 2. Baixa cada arquivo em paralelo (máximo 10 simultâneos para não saturar)
    const BATCH = 10;
    const snapshots = [];

    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async f => {
        try {
          const fileResp = await drive.files.get(
            { fileId: f.id, alt: 'media', supportsAllDrives: true },
            { responseType: 'arraybuffer' }
          );
          const wb = XLSX.read(fileResp.data, { type: 'array' });

          // Aba "Detalhe" contém as linhas brutas
          const sheetName = wb.SheetNames.find(n => n.toLowerCase() === 'detalhe') || wb.SheetNames[0];
          const raw = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });

          const rows = raw.map(r => ({
            partner:    String(r['PARTNER_NAME'] || r['partner_name'] || r['Partner_Name'] || '').trim(),
            cnpj:       String(r['CNPJ']         || r['cnpj']         || '').trim(),
            data:       String(r['DATA (DD/MM/YYYY)'] || r['DATA']    || r['data']        || '').trim(),
            iso:        String(r['ISO (YYYY-MM-DD)']  || r['ISO']     || r['iso']         || '').trim(),
            diaNum:     Number(r['DIA_NUM (0-6 JS)']  || r['DIA_NUM'] || r['diaNum']      || 0),
            diaSemana:  String(r['DIA_SEMANA']         || r['diaSemana'] || '').trim(),
          })).filter(r => r.partner && r.iso);

          return { date: f.date, dateFormatted: f.dateFormatted, fileId: f.id, rows };
        } catch (e) {
          console.error(`Erro ao processar ${f.name}:`, e.message);
          return null;
        }
      }));
      snapshots.push(...results.filter(Boolean));
    }

    // Ordena cronologicamente (mais antigo primeiro — bom para série temporal)
    snapshots.sort((a, b) => new Date(a.date) - new Date(b.date));

    res.json({ snapshots });
  } catch (err) {
    console.error('Erro ao agregar histórico de inatividade:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Distribuidores: helper ClickUp fetch ────────────────────────────────────
async function fetchDistribuidoresFromClickUp() {
  const token  = process.env.CLICKUP_TOKEN;
  const listId = process.env.CLICKUP_BIC_LIST_ID;
  if (!token)  throw new Error('CLICKUP_TOKEN não configurado no .env');
  if (!listId) throw new Error('CLICKUP_BIC_LIST_ID não configurado no .env');

  const headers = { Authorization: token, 'Content-Type': 'application/json' };

  // 1. Busca todas as tasks (paginado, máx 100 por página)
  let allTasks = [];
  let page = 0;
  while (true) {
    const url = `https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true&subtasks=false&page=${page}`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`ClickUp API erro ${resp.status}: ${txt}`);
    }
    const data = await resp.json();
    const tasks = data.tasks || [];
    allTasks = allTasks.concat(tasks);
    if (!data.last_page && tasks.length === 100) { page++; } else { break; }
  }

  // 2. Helper custom fields
  function cfVal(task, name) {
    const f = (task.custom_fields || []).find(f => f.name === name);
    if (!f || f.value === undefined || f.value === null || f.value === '') return null;
    if (f.type === 'drop_down' && f.type_config?.options) {
      const opt = f.type_config.options.find(o => o.orderindex === f.value || String(o.orderindex) === String(f.value));
      return opt ? { label: opt.name, color: opt.color } : null;
    }
    if (f.type === 'date' && f.value) {
      return new Date(parseInt(f.value)).toLocaleDateString('pt-BR');
    }
    if (f.type === 'currency') return f.value;
    return f.value;
  }

  // 3. Comentários em paralelo (batch de 15)
  const BATCH = 15;
  const commentMap = {};
  for (let i = 0; i < allTasks.length; i += BATCH) {
    const batch = allTasks.slice(i, i + BATCH);
    await Promise.all(batch.map(async task => {
      try {
        const r = await fetch(`https://api.clickup.com/api/v2/task/${task.id}/comment`, { headers });
        if (!r.ok) { commentMap[task.id] = []; return; }
        const d = await r.json();
        commentMap[task.id] = (d.comments || []).sort((a, b) => parseInt(b.date || 0) - parseInt(a.date || 0)).slice(0, 3).reverse().map(c => ({
          text: (c.comment || []).map(p => p.text || '').join('').trim(),
          author: c.user?.username || '',
          date: c.date ? new Date(parseInt(c.date)).toLocaleDateString('pt-BR') : '',
        })).filter(c => c.text);
      } catch { commentMap[task.id] = []; }
    }));
  }

  // 4. Monta payload
  const distribuidores = allTasks.map(t => ({
    id:           t.id,
    name:         t.name,
    status:       t.status?.status || '',
    statusColor:  t.status?.color || '#ccc',
    priority:     t.priority?.priority || null,
    priorityColor: t.priority?.color || null,
    url:          t.url,
    assignees:    (t.assignees || []).map(a => ({ name: a.username, initials: a.initials || a.username?.slice(0,2).toUpperCase(), color: a.color })),
    tags:         (t.tags || []).map(tg => tg.name),
    dueDate:      t.due_date ? new Date(parseInt(t.due_date)).toLocaleDateString('pt-BR') : null,
    dateCreated:  t.date_created ? new Date(parseInt(t.date_created)).toLocaleDateString('pt-BR') : null,
    dateUpdated:  t.date_updated ? new Date(parseInt(t.date_updated)).toLocaleDateString('pt-BR') : null,
    cnpj:         cfVal(t, 'CNPJ'),
    erp:          cfVal(t, 'ERP'),
    db:           cfVal(t, 'Banco de Dados'),
    modoIntegracao: cfVal(t, 'Modo de Integração'),
    faseIntegracao: cfVal(t, 'Fase de Integração'),
    tipodemanda:  cfVal(t, 'Tipo de Demanda'),
    acordo:       cfVal(t, 'Acordo Comercial'),
    liderProjeto: cfVal(t, 'Líder de Projeto'),
    ambiente:     cfVal(t, 'Ambiente'),
    regional:     cfVal(t, 'Regionais'),
    categoria:    cfVal(t, 'Categoria da Conexão pelo Cliente'),
    telefone:     cfVal(t, 'Telefone'),
    email:        cfVal(t, 'Email'),
    linkProjeto:  cfVal(t, 'Link do projeto'),
    layoutPaliativo: cfVal(t, 'Layout Paliativo'),
    dataCancelamento: cfVal(t, 'Data de Cancelamento'),
    dataDescontinuacao: cfVal(t, 'Data de Descontinuação'),
    dataConclusaoPaliativo: cfVal(t, 'Data Conclusão Paliativo'),
    dataInicioMtrix: cfVal(t, 'Data Início Mtrix'),
    dataConclusaoSellers: cfVal(t, 'Data Conclusão Sellers'),
    dataInicioSellers: cfVal(t, 'Data Início Sellers'),
    valorConexao: cfVal(t, 'Valor ($) por Conexão'),
    tipoBloqueio: cfVal(t, 'Tipo de Bloqueio'),
    description:  (t.text_content || '').trim(),
    comments:     commentMap[t.id] || [],
  }));

  distribuidores.sort((a, b) => {
    const na = parseInt(a.name.match(/^(\d+)/)?.[1] || '9999');
    const nb = parseInt(b.name.match(/^(\d+)/)?.[1] || '9999');
    return na - nb;
  });

  return distribuidores;
}

// GET /api/distribuidores — lê cache JSON do Drive (rápido)
app.get('/api/distribuidores', async (req, res) => {
  const folderId = process.env.GOOGLE_DRIVE_DIST_FOLDER_ID;
  if (!folderId) return res.status(500).json({ error: 'GOOGLE_DRIVE_DIST_FOLDER_ID não configurado no .env' });

  try {
    const drive = getDriveClient(true);

    // Busca o arquivo JSON mais recente na pasta de cache
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/json' and trashed=false`,
      fields: 'files(id, name, modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 5,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    const files = listResp.data.files || [];
    if (!files.length) {
      return res.status(404).json({ error: 'Nenhum cache encontrado. Use o botão "Forçar Atualização" para gerar.', noCache: true });
    }

    const latest = files[0];
    const fileResp = await drive.files.get(
      { fileId: latest.id, alt: 'media', supportsAllDrives: true },
      { responseType: 'text' }
    );

    const payload = JSON.parse(fileResp.data);
    res.json({ ...payload, cachedAt: latest.modifiedTime, fromCache: true });
  } catch (err) {
    console.error('Erro ao ler cache distribuidores:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/distribuidores-atualizar — busca do ClickUp e salva JSON no Drive
app.post('/api/distribuidores-atualizar', async (req, res) => {
  const folderId = process.env.GOOGLE_DRIVE_DIST_FOLDER_ID;
  if (!folderId) return res.status(500).json({ error: 'GOOGLE_DRIVE_DIST_FOLDER_ID não configurado no .env' });

  // SSE: envia progresso ao cliente
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function progress(pct, msg) {
    res.write(`data: ${JSON.stringify({ pct, msg })}\n\n`);
  }

  try {
    progress(5, 'Conectando ao ClickUp…');
    const token  = process.env.CLICKUP_TOKEN;
    const listId = process.env.CLICKUP_BIC_LIST_ID;
    if (!token || !listId) throw new Error('CLICKUP_TOKEN ou CLICKUP_BIC_LIST_ID não configurados');

    const headers = { Authorization: token, 'Content-Type': 'application/json' };

    // Passo 1: busca tasks
    progress(10, 'Buscando lista de distribuidores…');
    let allTasks = [];
    let page = 0;
    while (true) {
      const url = `https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true&subtasks=false&page=${page}`;
      const resp = await fetch(url, { headers });
      if (!resp.ok) { const t = await resp.text(); throw new Error(`ClickUp ${resp.status}: ${t}`); }
      const data = await resp.json();
      allTasks = allTasks.concat(data.tasks || []);
      if (!data.last_page && (data.tasks || []).length === 100) { page++; } else { break; }
    }
    progress(30, `${allTasks.length} distribuidores encontrados. Buscando detalhes…`);

    // Helper custom fields
    function cfVal(task, name) {
      const f = (task.custom_fields || []).find(f => f.name === name);
      if (!f || f.value === undefined || f.value === null || f.value === '') return null;
      if (f.type === 'drop_down' && f.type_config?.options) {
        const opt = f.type_config.options.find(o => o.orderindex === f.value || String(o.orderindex) === String(f.value));
        return opt ? { label: opt.name, color: opt.color } : null;
      }
      if (f.type === 'date' && f.value) return new Date(parseInt(f.value)).toLocaleDateString('pt-BR');
      if (f.type === 'currency') return f.value;
      return f.value;
    }

    // Passo 2: comentários em batches com progresso
    const BATCH = 15;
    const commentMap = {};
    for (let i = 0; i < allTasks.length; i += BATCH) {
      const batch = allTasks.slice(i, i + BATCH);
      await Promise.all(batch.map(async task => {
        try {
          const r = await fetch(`https://api.clickup.com/api/v2/task/${task.id}/comment`, { headers });
          if (!r.ok) { commentMap[task.id] = []; return; }
          const d = await r.json();
          commentMap[task.id] = (d.comments || []).sort((a, b) => parseInt(b.date || 0) - parseInt(a.date || 0)).slice(0, 3).reverse().map(c => ({
            text: (c.comment || []).map(p => p.text || '').join('').trim(),
            author: c.user?.username || '',
            date: c.date ? new Date(parseInt(c.date)).toLocaleDateString('pt-BR') : '',
          })).filter(c => c.text);
        } catch { commentMap[task.id] = []; }
      }));
      const pct = 30 + Math.round(((i + batch.length) / allTasks.length) * 50);
      progress(pct, `Comentários: ${Math.min(i + BATCH, allTasks.length)}/${allTasks.length}…`);
    }

    // Passo 3: monta payload
    progress(82, 'Montando dados…');
    const distribuidores = allTasks.map(t => ({
      id: t.id, name: t.name,
      status: t.status?.status || '', statusColor: t.status?.color || '#ccc',
      priority: t.priority?.priority || null, priorityColor: t.priority?.color || null,
      url: t.url,
      assignees: (t.assignees || []).map(a => ({ name: a.username, initials: a.initials || a.username?.slice(0,2).toUpperCase(), color: a.color })),
      tags: (t.tags || []).map(tg => tg.name),
      dueDate: t.due_date ? new Date(parseInt(t.due_date)).toLocaleDateString('pt-BR') : null,
      dateCreated: t.date_created ? new Date(parseInt(t.date_created)).toLocaleDateString('pt-BR') : null,
      dateUpdated: t.date_updated ? new Date(parseInt(t.date_updated)).toLocaleDateString('pt-BR') : null,
      cnpj: cfVal(t, 'CNPJ'), erp: cfVal(t, 'ERP'), db: cfVal(t, 'Banco de Dados'),
      modoIntegracao: cfVal(t, 'Modo de Integração'), faseIntegracao: cfVal(t, 'Fase de Integração'),
      tipodemanda: cfVal(t, 'Tipo de Demanda'), acordo: cfVal(t, 'Acordo Comercial'),
      liderProjeto: cfVal(t, 'Líder de Projeto'), ambiente: cfVal(t, 'Ambiente'),
      regional: cfVal(t, 'Regionais'), categoria: cfVal(t, 'Categoria da Conexão pelo Cliente'),
      telefone: cfVal(t, 'Telefone'), email: cfVal(t, 'Email'), linkProjeto: cfVal(t, 'Link do projeto'),
      layoutPaliativo: cfVal(t, 'Layout Paliativo'), dataCancelamento: cfVal(t, 'Data de Cancelamento'),
      dataDescontinuacao: cfVal(t, 'Data de Descontinuação'), dataConclusaoPaliativo: cfVal(t, 'Data Conclusão Paliativo'),
      dataInicioMtrix: cfVal(t, 'Data Início Mtrix'), dataConclusaoSellers: cfVal(t, 'Data Conclusão Sellers'),
      dataInicioSellers: cfVal(t, 'Data Início Sellers'), valorConexao: cfVal(t, 'Valor ($) por Conexão'),
      tipoBloqueio: cfVal(t, 'Tipo de Bloqueio'), description: (t.text_content || '').trim(),
      comments: commentMap[t.id] || [],
    }));
    distribuidores.sort((a, b) => {
      const na = parseInt(a.name.match(/^(\d+)/)?.[1] || '9999');
      const nb = parseInt(b.name.match(/^(\d+)/)?.[1] || '9999');
      return na - nb;
    });

    // Passo 4: salva no Drive
    progress(88, 'Salvando cache no Drive…');
    const drive = getDriveClient(false);
    const now = new Date();
    const fileName = `distribuidores_cache_${now.toISOString().slice(0,10)}.json`;
    const jsonContent = JSON.stringify({ distribuidores, total: distribuidores.length, generatedAt: now.toISOString() });

    // Remove arquivos antigos da pasta
    const oldList = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/json' and trashed=false`,
      fields: 'files(id)',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    await Promise.all((oldList.data.files || []).map(f =>
      drive.files.delete({ fileId: f.id, supportsAllDrives: true }).catch(() => {})
    ));

    // Upload novo arquivo
    const { Readable } = require('stream');
    await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
        mimeType: 'application/json',
      },
      media: {
        mimeType: 'application/json',
        body: Readable.from([jsonContent]),
      },
      supportsAllDrives: true,
    });

    progress(100, `Concluído! ${distribuidores.length} distribuidores atualizados.`);
    res.write(`data: ${JSON.stringify({ done: true, distribuidores, total: distribuidores.length })}\n\n`);
    res.end();
  } catch (err) {
    console.error('Erro ao atualizar distribuidores:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ─── Paliativos MTrix ────────────────────────────────────────────────────────
// GET /api/paliativos — exporta o Google Doc como texto e parseia holdings
app.get('/api/paliativos', async (req, res) => {
  const docId = process.env.GOOGLE_DRIVE_PALIATIVO_DOC_ID;
  if (!docId) return res.status(500).json({ error: 'GOOGLE_DRIVE_PALIATIVO_DOC_ID não configurado' });

  try {
    const drive = getDriveClient(true);

    // Exporta o Google Doc como texto plano via Drive API
    const exportResp = await drive.files.export(
      { fileId: docId, mimeType: 'text/plain' },
      { responseType: 'text' }
    );
    const raw = exportResp.data;

    // ── Parser ─────────────────────────────────────────────────────────────

    // Extrai "Atualizado em: DD/MM/YYYY"
    const atualizadoMatch = raw.match(/Atualizado em:\s*(\d{2}\/\d{2}\/\d{4})/);
    const atualizadoEm = atualizadoMatch ? atualizadoMatch[1] : null;

    // Cada holding individual está em seções separadas por "________________"
    const sections = raw.split(/_{5,}/);

    const holdings = [];

    for (const sec of sections) {
      const lines = sec.split('\n').map(l => l.trim()).filter(Boolean);

      // Seção de holding individual: contém "Responsável" e "Obs. / Ações"
      const respIdx = lines.findIndex(l => l === 'Responsável');
      const obsIdx  = lines.findIndex(l => l.startsWith('Obs. / Ações'));
      if (respIdx === -1 || obsIdx === -1) continue;

      // Nome da holding: última linha antes de "Responsável" que não é cabeçalho
      let nome = '';
      for (let i = respIdx - 1; i >= 0; i--) {
        const l = lines[i];
        if (!l || l.includes('Report de Conversão') || l === ' ') continue;
        nome = l;
        break;
      }
      if (!nome) continue;

      // Campo: pega o valor na linha seguinte ao label
      function fieldAfter(label) {
        const idx = lines.findIndex(l => l === label);
        return idx !== -1 && idx + 1 < lines.length ? lines[idx + 1] : null;
      }

      const responsavel = fieldAfter('Responsável');
      const previsao    = fieldAfter('Previsão');
      const customers   = fieldAfter('Customers');
      const status      = fieldAfter('Status Atual');

      // Ações: tudo depois de "Obs. / Ações", cada entrada começa com DD/MM/YYYY
      const acaoLines = lines.slice(obsIdx + 1);
      const acoes = [];
      let currentAcao = null;

      for (const line of acaoLines) {
        const dateMatch = line.match(/^(\d{2}\/\d{2}\/\d{4})\s*[–\-]\s*(.*)/);
        if (dateMatch) {
          if (currentAcao) acoes.push(currentAcao);
          currentAcao = { data: dateMatch[1], texto: dateMatch[2].trim() };
        } else if (currentAcao) {
          currentAcao.texto += ' ' + line;
        }
      }
      if (currentAcao) acoes.push(currentAcao);

      holdings.push({ nome, responsavel, previsao, customers, status, acoes });
    }

    // Remove duplicatas pelo nome (o doc tem tabela-resumo + seções individuais)
    const seen = new Set();
    const unique = holdings.filter(h => {
      if (seen.has(h.nome)) return false;
      seen.add(h.nome);
      return true;
    });

    res.json({ atualizadoEm, holdings: unique, total: unique.length });
  } catch (err) {
    console.error('Erro ao buscar paliativos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── De-Para ──────────────────────────────────────────────────────────────────

// GET /api/depara-arquivos — lista XLSXs na pasta De-Para (mais recente primeiro)
app.get('/api/depara-arquivos', async (req, res) => {
  const folderId = process.env.GOOGLE_DRIVE_DEPARA_FOLDER_ID;
  if (!folderId) return res.status(500).json({ error: 'GOOGLE_DRIVE_DEPARA_FOLDER_ID não configurado' });
  try {
    const drive = getDriveClient(true);
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime, modifiedTime)',
      orderBy: 'createdTime desc',
      pageSize: 50,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    res.json(listResp.data.files || []);
  } catch (err) {
    console.error('Erro ao listar De-Para:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/depara-arquivo?fileId= — baixa e parseia um XLSX de De-Para
app.get('/api/depara-arquivo', async (req, res) => {
  const { fileId } = req.query;
  if (!fileId) return res.status(400).json({ error: 'fileId é obrigatório' });
  try {
    const drive = getDriveClient(true);
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    const workbook = XLSX.read(fileResp.data, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null });
    res.json({ rows, sheetName });
  } catch (err) {
    console.error('Erro ao baixar De-Para:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/depara-download?fileId= — retorna o arquivo original como download
app.get('/api/depara-download', async (req, res) => {
  const { fileId } = req.query;
  if (!fileId) return res.status(400).json({ error: 'fileId é obrigatório' });
  try {
    const drive = getDriveClient(true);
    // Pega metadados do arquivo
    const meta = await drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
    const fileName = meta.data.name;

    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );

    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(fileResp.data));
  } catch (err) {
    console.error('Erro ao baixar arquivo De-Para:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/depara-upload — recebe XLSX preenchido e salva no Drive com data/hora
app.post('/api/depara-upload', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
  const folderId = process.env.GOOGLE_DRIVE_DEPARA_UPLOAD_FOLDER_ID;
  if (!folderId) return res.status(500).json({ error: 'GOOGLE_DRIVE_DEPARA_UPLOAD_FOLDER_ID não configurado' });

  const originalName = req.headers['x-file-name'] || 'depara_preenchido.xlsx';
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const ext = originalName.includes('.') ? '.' + originalName.split('.').pop() : '.xlsx';
  const baseName = originalName.replace(/\.[^.]+$/, '');
  const fileName = `${baseName}_${timestamp}${ext}`;

  try {
    const drive = getDriveClient(false);
    const { Readable } = require('stream');

    await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      media: {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        body: Readable.from([req.body]),
      },
      supportsAllDrives: true,
    });

    res.json({ ok: true, fileName });
  } catch (err) {
    console.error('Erro ao fazer upload De-Para:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback — qualquer rota desconhecida serve o index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`BIC Portal rodando em http://localhost:${PORT}`);
  console.log(`Acesso na rede: http://<SEU_IP_LOCAL>:${PORT}`);
});
