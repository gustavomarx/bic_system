require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const XLSX = require('xlsx');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3004;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';

// ─── Middlewares ─────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..')));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ─── Firebase Admin ───────────────────────────────────────────────────────────
function getFirebaseAdmin() {
  if (admin.apps.length) return admin;
  const serviceAccount = process.env.FIREBASE_ADMIN_JSON
    ? JSON.parse(process.env.FIREBASE_ADMIN_JSON)
    : require(path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './credentials/firebase-service-account.json'));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers?.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('token').status(401).json({ error: 'Sessão expirada' });
  }
}

// Aplica auth em todas as rotas /api exceto as públicas
app.use('/api', (req, res, next) => {
  if (['/login', '/logout', '/health'].includes(req.path)) return next();
  requireAuth(req, res, next);
});

function isAdminEmail(email) {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
  return admins.includes(email.toLowerCase());
}

// POST /api/login — recebe Firebase ID token, verifica, cria sessão
app.post('/api/login', async (req, res) => {
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'Token obrigatório' });
  try {
    const decoded = await getFirebaseAdmin().auth().verifyIdToken(idToken);
    const email = decoded.email;
    const name = decoded.name || email.split('@')[0];
    const isAdmin = isAdminEmail(email);
    const token = jwt.sign({ email, name, isAdmin }, JWT_SECRET, { expiresIn: '7d' });
    res
      .cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      })
      .json({ ok: true, name, isAdmin });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(401).json({ error: 'Credenciais inválidas' });
  }
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('token').json({ ok: true });
});

// GET /api/me
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ email: req.user.email, name: req.user.name, isAdmin: !!req.user.isAdmin });
});

// ─── Admin — gestão de usuários Firebase ─────────────────────────────────────

function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Acesso restrito a administradores' });
  next();
}

// GET /api/admin/users — lista todos os usuários Firebase Auth
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await getFirebaseAdmin().auth().listUsers(1000);
    const users = result.users.map(u => ({
      uid:        u.uid,
      email:      u.email,
      name:       u.displayName || '',
      disabled:   u.disabled,
      createdAt:  u.metadata.creationTime,
      lastLogin:  u.metadata.lastSignInTime || null,
      isAdmin:    isAdminEmail(u.email),
    }));
    res.json({ users });
  } catch (err) {
    console.error('admin/users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users — cria novo usuário
app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });
  try {
    const user = await getFirebaseAdmin().auth().createUser({
      email,
      password,
      displayName: name || email.split('@')[0],
      emailVerified: true,
    });
    res.json({ ok: true, uid: user.uid });
  } catch (err) {
    const msg = err.code === 'auth/email-already-exists' ? 'E-mail já cadastrado' : err.message;
    res.status(400).json({ error: msg });
  }
});

// PATCH /api/admin/users/:uid — ativa/desativa usuário
app.patch('/api/admin/users/:uid', requireAuth, requireAdmin, async (req, res) => {
  const { disabled } = req.body || {};
  try {
    await getFirebaseAdmin().auth().updateUser(req.params.uid, { disabled: !!disabled });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:uid — remove usuário
app.delete('/api/admin/users/:uid', requireAuth, requireAdmin, async (req, res) => {
  try {
    await getFirebaseAdmin().auth().deleteUser(req.params.uid);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /login ou /login.html — serve login page com Firebase config injetada
function serveLogin(req, res) {
  const fs = require('fs');
  const loginPath = path.join(__dirname, '..', 'login.html');
  let html;
  try { html = fs.readFileSync(loginPath, 'utf8'); } catch { return res.status(404).send('login.html not found'); }
  const config = {
    apiKey:            process.env.FIREBASE_API_KEY            || '',
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN        || '',
    projectId:         process.env.FIREBASE_PROJECT_ID         || '',
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET     || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID|| '',
    appId:             process.env.FIREBASE_APP_ID             || '',
  };
  const script = `<script>window.__BIC_FIREBASE_CONFIG__ = ${JSON.stringify(config)}<\/script>`;
  html = html.replace('<!-- __FIREBASE_CONFIG_PLACEHOLDER__ -->', script);
  res.setHeader('Content-Type', 'text/html').send(html);
}

app.get('/login', serveLogin);
app.get('/login.html', serveLogin);

// ─── Google Drive auth ────────────────────────────────────────────────────────
function getDriveClient(readOnly = true) {
  const scopes = readOnly
    ? ['https://www.googleapis.com/auth/drive.readonly']
    : ['https://www.googleapis.com/auth/drive'];

  // Suporta service account via env var (Vercel) ou arquivo (local)
  const authConfig = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? { credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes }
    : { keyFile: path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_PATH), scopes };

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
// GET /api/paliativos?debug=1 — retorna o texto bruto do doc para diagnóstico
app.get('/api/paliativos', async (req, res) => {
  const docId = process.env.GOOGLE_DRIVE_PALIATIVO_DOC_ID;
  if (!docId) return res.status(500).json({ error: 'GOOGLE_DRIVE_PALIATIVO_DOC_ID não configurado' });

  try {
    const drive = getDriveClient(true);

    // Força busca sem cache adicionando um cabeçalho de controle
    const exportResp = await drive.files.export(
      { fileId: docId, mimeType: 'text/plain' },
      { responseType: 'text' }
    );
    const raw = exportResp.data;

    // Modo debug: retorna texto bruto para diagnóstico
    if (req.query.debug === '1') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(raw);
    }

    // ── Parser ─────────────────────────────────────────────────────────────

    // Normaliza texto: remove caracteres de controle mantendo \n
    const normalize = s => s.replace(/\r/g, '').replace(/[^\S\n]+/g, ' ').trim();

    // Extrai "Atualizado em: DD/MM/YYYY" — aceita com ou sem dois-pontos e variações de espaço
    const atualizadoMatch = raw.match(/Atualizado\s+em[:\s]\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    const atualizadoEm = atualizadoMatch ? atualizadoMatch[1] : null;

    // Separa por linha de underscores OU traços (5+ caracteres)
    const sections = raw.split(/^[_\-]{5,}\s*$/m);

    const holdings = [];

    // Helper: encontra índice de linha que contenha o label (case-insensitive, ignora pontuação)
    function findLabel(lines, label) {
      const norm = label.toLowerCase().replace(/[^a-záàãâéêíóôõúç\s]/gi, '').trim();
      return lines.findIndex(l => {
        const lNorm = l.toLowerCase().replace(/[^a-záàãâéêíóôõúç\s]/gi, '').trim();
        return lNorm === norm || l.toLowerCase().startsWith(label.toLowerCase());
      });
    }

    // Helper: pega valor — linha seguinte ao label OU inline "Label: valor"
    function fieldAfter(lines, label) {
      const idx = findLabel(lines, label);
      if (idx === -1) return null;
      // Verifica se o valor está na mesma linha "Label: Valor"
      const colonMatch = lines[idx].match(/^[^:]+:\s*(.+)/);
      if (colonMatch) return colonMatch[1].trim();
      // Caso contrário, pega a próxima linha não-vazia
      for (let i = idx + 1; i < lines.length; i++) {
        if (lines[i]) return lines[i];
      }
      return null;
    }

    for (const sec of sections) {
      const lines = sec.split('\n').map(l => normalize(l)).filter(Boolean);

      const respIdx = findLabel(lines, 'Responsável');
      const obsIdx  = findLabel(lines, 'Obs');
      if (respIdx === -1 || obsIdx === -1) continue;

      // Nome da holding: última linha antes de "Responsável" que não é cabeçalho
      let nome = '';
      for (let i = respIdx - 1; i >= 0; i--) {
        const l = lines[i];
        if (!l || /report de convers/i.test(l)) continue;
        nome = l;
        break;
      }
      if (!nome) continue;

      const responsavel = fieldAfter(lines, 'Responsável');
      const previsao    = fieldAfter(lines, 'Previsão');
      const customers   = fieldAfter(lines, 'Customers');
      const status      = fieldAfter(lines, 'Status Atual');

      // Ações: tudo depois de "Obs. / Ações", cada entrada começa com DD/MM/YYYY
      const acaoLines = lines.slice(obsIdx + 1);
      const acoes = [];
      let currentAcao = null;

      for (const line of acaoLines) {
        const dateMatch = line.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s*[–\-]\s*(.*)/);
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

    res.setHeader('Cache-Control', 'no-store');
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

// ─── Histórico de Vendas ──────────────────────────────────────────────────────

// GET /api/historico-arquivos — lista historico_DD-MM-YYYY.xlsx (mais recente primeiro)
app.get('/api/historico-arquivos', async (req, res) => {
  const folderId = process.env.GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
  if (!folderId) return res.status(500).json({ error: 'GOOGLE_DRIVE_HISTORICO_FOLDER_ID não configurado' });
  try {
    const drive = getDriveClient(true);
    const listResp = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'name desc',
      pageSize: 100,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    const files = (listResp.data.files || [])
      .map(f => {
        const date = extractDateFromName(f.name);
        return { id: f.id, name: f.name, date: date ? date.iso : null, dateFormatted: date ? date.formatted : null };
      })
      .filter(f => f.date !== null)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(files);
  } catch (err) {
    console.error('Erro ao listar histórico:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/historico-dados?fileId= — baixa e parseia arquivo de histórico de vendas
app.get('/api/historico-dados', async (req, res) => {
  const folderId = process.env.GOOGLE_DRIVE_HISTORICO_FOLDER_ID;
  if (!folderId) return res.status(500).json({ error: 'GOOGLE_DRIVE_HISTORICO_FOLDER_ID não configurado' });
  try {
    const drive = getDriveClient(true);
    let fileId = req.query.fileId;

    if (!fileId) {
      // Pega o mais recente
      const listResp = await drive.files.list({
        q: `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
        fields: 'files(id, name)',
        orderBy: 'name desc',
        pageSize: 1,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });
      const files = listResp.data.files || [];
      if (!files.length) return res.status(404).json({ error: 'Nenhum arquivo encontrado na pasta.' });
      fileId = files[0].id;
    }

    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );

    const workbook  = XLSX.read(fileResp.data, { type: 'array' });
    const sheetName = workbook.SheetNames.find(n => n === 'Histórico') || workbook.SheetNames[0];
    const rawRows   = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null });

    const rows = rawRows.map(r => ({
      holding:     String(r['HOLDING']      || r['holding']      || ''),
      partnerName: String(r['PARTNER_NAME'] || r['partner_name'] || r['PARTNER NAME'] || ''),
      cnpj:        String(r['CNPJ']         || r['cnpj']         || r['CNPJ_CUSTOMER'] || ''),
      anoMes:      String(r['ANO_MES']      || r['ano_mes']      || r['ANO_MES_FIX'] || ''),
      valor:       Number(r['VENDA_VALOR']  || r['venda_valor']  || 0),
    })).filter(r => r.partnerName && r.anoMes);

    res.json({ rows, fileId });
  } catch (err) {
    console.error('Erro ao baixar histórico:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Usuários — arquivo mais recente do Drive ─────────────────────────────────
app.get('/api/usuarios-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient(true);
    const folderId = process.env.GOOGLE_DRIVE_USUARIOS_FOLDER_ID;
    const listResp = await drive.files.list({
      q:                         `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields:                    'files(id, name, createdTime)',
      orderBy:                   'createdTime desc',
      supportsAllDrives:         true,
      includeItemsFromAllDrives: true,
    });
    const files = listResp.data.files || [];
    if (!files.length) return res.json(null);
    const f = files[0];
    res.json({ fileId: f.id, name: f.name, createdTime: f.createdTime });
  } catch (err) {
    console.error('Erro /api/usuarios-arquivo:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/usuarios-dados', async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório' });

    const drive    = getDriveClient(true);
    const fileResp = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );

    const wb          = XLSX.read(fileResp.data, { type: 'array' });
    const wsDistrib   = wb.Sheets['Distribuidores'];
    const wsIndustria = wb.Sheets['Industria'];

    const distribuidores = wsDistrib   ? XLSX.utils.sheet_to_json(wsDistrib)   : [];
    const industria      = wsIndustria ? XLSX.utils.sheet_to_json(wsIndustria) : [];

    res.json({ distribuidores, industria });
  } catch (err) {
    console.error('Erro /api/usuarios-dados:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Batalha Naval — leitura do Drive ────────────────────────────────────────
app.get('/api/batalha-naval-arquivos', async (req, res) => {
  try {
    const drive    = getDriveClient(true);
    const folderId = process.env.GOOGLE_DRIVE_BATALHA_FOLDER_ID;
    if (!folderId) return res.status(500).json({ error: 'GOOGLE_DRIVE_BATALHA_FOLDER_ID não configurado' });

    const listResp = await drive.files.list({
      q:                         `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields:                    'files(id, name, createdTime)',
      orderBy:                   'createdTime desc',
      pageSize:                  50,
      includeItemsFromAllDrives: true,
      supportsAllDrives:         true,
    });

    res.json({ files: listResp.data.files || [] });
  } catch (err) {
    console.error('Erro /api/batalha-naval-arquivos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/batalha-naval-arquivo', async (req, res) => {
  try {
    const drive    = getDriveClient(true);
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

app.get('/api/batalha-naval-dados', async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: 'fileId obrigatório' });

    const drive    = getDriveClient(true);
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

// SPA fallback — qualquer rota desconhecida serve o index.html (requer auth)
app.get('*', (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.redirect('/login.html');
  try {
    jwt.verify(token, JWT_SECRET);
    res.sendFile(path.join(__dirname, '..', 'index.html'));
  } catch {
    res.clearCookie('token').redirect('/login.html');
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`BIC Portal rodando em http://localhost:${PORT}`);
  console.log(`Acesso na rede: http://<SEU_IP_LOCAL>:${PORT}`);
});
