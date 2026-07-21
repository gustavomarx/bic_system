require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const XLSX = require('xlsx');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const uploadMemory = multer({ storage: multer.memoryStorage() });
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
    const modules = decoded.modules ?? null; // null = full access
    const tenants = decoded.tenants ?? ['bic']; // default BIC para usuários existentes
    const token = jwt.sign({ email, name, isAdmin, modules, tenants }, JWT_SECRET, { expiresIn: '7d' });
    res
      .cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      })
      .json({ ok: true, name, isAdmin, modules, tenants });
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
  res.json({ email: req.user.email, name: req.user.name, isAdmin: !!req.user.isAdmin, modules: req.user.modules ?? null, tenants: req.user.tenants ?? ['bic'] });
});

// PATCH /api/me — atualiza nome e/ou email do usuário autenticado
app.patch('/api/me', requireAuth, async (req, res) => {
  const { name, email } = req.body || {};
  try {
    const admin = getFirebaseAdmin();
    const user = await admin.auth().getUserByEmail(req.user.email);
    const updates = {};
    if (name  !== undefined) updates.displayName = name;
    if (email !== undefined && email !== req.user.email) updates.email = email;
    if (Object.keys(updates).length) await admin.auth().updateUser(user.uid, updates);
    const newEmail = email || req.user.email;
    const newName  = name  !== undefined ? name : req.user.name;
    const token = jwt.sign(
      { email: newEmail, name: newName, isAdmin: req.user.isAdmin, modules: req.user.modules ?? null, tenants: req.user.tenants ?? ['bic'] },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.cookie('token', token, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000,
    }).json({ ok: true, name: newName, email: newEmail });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/me/password — atualiza senha verificando a atual
app.patch('/api/me/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Senhas obrigatórias' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Nova senha deve ter pelo menos 6 caracteres' });
  try {
    // Verifica senha atual via Firebase REST API
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: req.user.email, password: currentPassword, returnSecureToken: false }) }
    );
    if (!verifyRes.ok) return res.status(401).json({ error: 'Senha atual incorreta' });
    const admin = getFirebaseAdmin();
    const user = await admin.auth().getUserByEmail(req.user.email);
    await admin.auth().updateUser(user.uid, { password: newPassword });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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
      modules:    u.customClaims?.modules ?? null,  // null = full access
      tenants:    u.customClaims?.tenants ?? ['bic'],
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

// PATCH /api/admin/users/:uid/modules — define módulos e/ou tenants permitidos via custom claims
app.patch('/api/admin/users/:uid/modules', requireAuth, requireAdmin, async (req, res) => {
  const { modules, tenants } = req.body || {};
  try {
    const user = await getFirebaseAdmin().auth().getUser(req.params.uid);
    const existing = user.customClaims || {};
    const newClaims = { ...existing };
    if ('modules' in req.body) newClaims.modules = Array.isArray(modules) ? modules : null;
    if ('tenants' in req.body) newClaims.tenants = Array.isArray(tenants) && tenants.length ? tenants : ['bic'];
    await getFirebaseAdmin().auth().setCustomUserClaims(req.params.uid, newClaims);
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

// ─── Tenant folder IDs ────────────────────────────────────────────────────────
function getTenantFolders(tenant) {
  if (tenant === 'mdias') {
    return {
      comparativo: process.env.MDIAS_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID,
      batalha:     process.env.MDIAS_GOOGLE_DRIVE_BATALHA_FOLDER_ID,
      historico:   process.env.MDIAS_GOOGLE_DRIVE_HISTORICO_FOLDER_ID,
    };
  }
  if (tenant === 'marilan') {
    return {
      comparativo: process.env.MARILAN_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID,
      batalha:     process.env.MARILAN_GOOGLE_DRIVE_BATALHA_FOLDER_ID,
      historico:   process.env.MARILAN_GOOGLE_DRIVE_HISTORICO_FOLDER_ID,
    };
  }
  if (tenant === 'asa') {
    return {
      comparativo: process.env.ASA_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID,
      batalha:     process.env.ASA_GOOGLE_DRIVE_BATALHA_FOLDER_ID,
      historico:   process.env.ASA_GOOGLE_DRIVE_HISTORICO_FOLDER_ID,
    };
  }
  if (tenant === 'bombril') {
    return {
      comparativo: process.env.BOMBRIL_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID,
      batalha:     process.env.BOMBRIL_GOOGLE_DRIVE_BATALHA_FOLDER_ID,
      historico:   process.env.BOMBRIL_GOOGLE_DRIVE_HISTORICO_FOLDER_ID,
    };
  }
  if (tenant === 'cicopal') {
    return {
      comparativo: process.env.CICOPAL_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID,
      batalha:     process.env.CICOPAL_GOOGLE_DRIVE_BATALHA_FOLDER_ID,
      historico:   process.env.CICOPAL_GOOGLE_DRIVE_HISTORICO_FOLDER_ID,
    };
  }
  if (tenant === 'pepsico') {
    return {
      comparativo: process.env.PEPSICO_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID,
      batalha:     process.env.PEPSICO_GOOGLE_DRIVE_BATALHA_FOLDER_ID,
      historico:   process.env.PEPSICO_GOOGLE_DRIVE_HISTORICO_FOLDER_ID,
    };
  }
  if (tenant === 'fini') {
    return {
      comparativo: process.env.FINI_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID,
      batalha:     process.env.FINI_GOOGLE_DRIVE_BATALHA_FOLDER_ID,
      historico:   process.env.FINI_GOOGLE_DRIVE_HISTORICO_FOLDER_ID,
    };
  }
  if (tenant === 'fruki') {
    return {
      comparativo: process.env.FRUKI_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID,
      batalha:     process.env.FRUKI_GOOGLE_DRIVE_BATALHA_FOLDER_ID,
      historico:   process.env.FRUKI_GOOGLE_DRIVE_HISTORICO_FOLDER_ID,
    };
  }
  if (tenant === 'gallo') {
    return {
      comparativo: process.env.GALLO_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID,
      batalha:     process.env.GALLO_GOOGLE_DRIVE_BATALHA_FOLDER_ID,
      historico:   process.env.GALLO_GOOGLE_DRIVE_HISTORICO_FOLDER_ID,
    };
  }
  if (tenant === 'gtex') {
    return {
      comparativo: process.env.GTEX_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID,
      batalha:     process.env.GTEX_GOOGLE_DRIVE_BATALHA_FOLDER_ID,
      historico:   process.env.GTEX_GOOGLE_DRIVE_HISTORICO_FOLDER_ID,
    };
  }
  if (tenant === 'mdiassaud') {
    return {
      comparativo: process.env.MDIASSAUD_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID,
      batalha:     process.env.MDIASSAUD_GOOGLE_DRIVE_BATALHA_FOLDER_ID,
      historico:   process.env.MDIASSAUD_GOOGLE_DRIVE_HISTORICO_FOLDER_ID,
    };
  }
  if (tenant === 'kibon') {
    return {
      comparativo: process.env.KIBON_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID,
      batalha:     process.env.KIBON_GOOGLE_DRIVE_BATALHA_FOLDER_ID,
      historico:   process.env.KIBON_GOOGLE_DRIVE_HISTORICO_FOLDER_ID,
    };
  }
  if (tenant === 'peccin') {
    return {
      comparativo: process.env.PECCIN_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID,
      batalha:     process.env.PECCIN_GOOGLE_DRIVE_BATALHA_FOLDER_ID,
      historico:   process.env.PECCIN_GOOGLE_DRIVE_HISTORICO_FOLDER_ID,
    };
  }
  return {
    comparativo: process.env.GOOGLE_DRIVE_FOLDER_ID,
    batalha:     process.env.GOOGLE_DRIVE_BATALHA_FOLDER_ID,
    historico:   process.env.GOOGLE_DRIVE_HISTORICO_FOLDER_ID,
  };
}

// ─── Normalização de colunas ──────────────────────────────────────────────────
const COL_MAP = {
  holding: ['holding', 'HOLDING', 'Holding'],
  customer: ['customer', 'partner_name', 'PARTNER_NAME', 'PartnerName', 'partner name', 'distribuidor'],
  anoMes: ['anomes', 'ANOMES', 'AnoMes', 'ano_mes', 'ANO_MES', 'anoMes'],
  vendaValor: ['venda_valor', 'VENDA_VALOR', 'venda_valor_bruto', 'VENDA_VALOR_BRUTO', 'VendaValor', 'valor', 'Valor', 'VALOR'],
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
    const folderId = getTenantFolders(req.query.tenant || 'bic').comparativo;

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
      .filter(f => f.date !== null && !/historico/i.test(f.name))
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

    const noHolding = ['mdias', 'marilan', 'asa', 'bombril', 'cicopal', 'fini', 'fruki', 'gallo', 'gtex', 'mdiassaud', 'kibon', 'pepsico', 'peccin'].includes(req.query.tenant || 'bic');
    const rows = rawData
      .map(normalizeRow)
      .filter(r => noHolding ? (r.customer && r.vendaValor !== null) : (r.holding && r.vendaValor !== null));

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
  const folderId = getTenantFolders(req.query.tenant || 'bic').historico;
  if (!folderId) return res.status(500).json({ error: 'HISTORICO folder não configurado para este tenant' });
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
  const folderId = getTenantFolders(req.query.tenant || 'bic').historico;
  if (!folderId) return res.status(500).json({ error: 'HISTORICO folder não configurado para este tenant' });
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
      valor:       Number(r['VENDA_VALOR_BRUTO'] || r['venda_valor_bruto'] || r['VENDA_VALOR'] || r['venda_valor'] || 0),
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
    const folderId = getTenantFolders(req.query.tenant || 'bic').batalha;
    if (!folderId) return res.status(500).json({ error: 'BATALHA folder não configurado para este tenant' });

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
    const folderId = getTenantFolders(req.query.tenant || 'bic').batalha;
    if (!folderId) return res.status(500).json({ error: 'BATALHA folder não configurado para este tenant' });

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

// GET /api/email-massa/debug — diagnóstico de matching coordenadores × sellout × usuários
app.get('/api/email-massa/debug', requireAuth, requireAdmin, async (req, res) => {
  try {
    const drive = getDriveClient(true);

    // Coordenadores do Firestore
    const db = getFirebaseAdmin().firestore();
    const coordDoc = await db.collection('system_config').doc('coordenadores').get();
    const coordMapa = coordDoc.exists ? (coordDoc.data().mapa || {}) : {};
    const coordKeys = Object.keys(coordMapa).slice(0, 30).map(k => ({ original: k, normalizado: normalizeStr(k) }));

    // Amostra de customers do sellout
    const selloutList = await drive.files.list({
      q: `'${process.env.GOOGLE_DRIVE_FOLDER_ID}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id,name)', orderBy: 'createdTime desc', pageSize: 1,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    let selloutCustomers = [];
    if (selloutList.data.files?.length) {
      const resp = await drive.files.get(
        { fileId: selloutList.data.files[0].id, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' }
      );
      const wb = XLSX.read(resp.data, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: null }).map(normalizeRow);
      const unique = new Map();
      for (const r of rows) {
        if (r.customer && !unique.has(r.customer)) unique.set(r.customer, normalizeStr(r.customer));
        if (unique.size >= 20) break;
      }
      selloutCustomers = [...unique.entries()].map(([orig, norm]) => ({ original: orig, normalizado: norm }));
    }

    // Amostra de Empresas do XLSX de usuários
    const usuList = await drive.files.list({
      q: `'${process.env.GOOGLE_DRIVE_USUARIOS_FOLDER_ID}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields: 'files(id,name)', orderBy: 'createdTime desc', pageSize: 1,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    let usuEmpresas = [];
    if (usuList.data.files?.length) {
      const resp = await drive.files.get(
        { fileId: usuList.data.files[0].id, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' }
      );
      const wb = XLSX.read(resp.data, { type: 'array' });
      const ws = wb.Sheets['Distribuidores'];
      const rows = ws ? XLSX.utils.sheet_to_json(ws, { defval: '' }) : [];
      const unique = new Map();
      for (const r of rows) {
        const emp = String(r.Empresa || '').trim();
        if (emp && !unique.has(emp)) unique.set(emp, normalizeStr(emp));
        if (unique.size >= 20) break;
      }
      usuEmpresas = [...unique.entries()].map(([orig, norm]) => ({ original: orig, normalizado: norm }));
    }

    res.json({ coordKeys, selloutCustomers, usuEmpresas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Gmail OAuth2 ────────────────────────────────────────────────────────────

function getGmailOAuth2Client(redirectUri) {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    redirectUri
  );
}

function getRedirectUri(req) {
  const host = req.get('host');
  const protocol = host.includes('localhost') ? 'http' : 'https';
  return `${protocol}://${host}/api/gmail/callback`;
}

async function getGmailTokens() {
  const db = getFirebaseAdmin().firestore();
  const doc = await db.collection('system_config').doc('gmail_token').get();
  return doc.exists ? doc.data() : null;
}

async function saveGmailTokens(tokens) {
  const db = getFirebaseAdmin().firestore();
  await db.collection('system_config').doc('gmail_token').set(tokens, { merge: true });
}

async function getAuthenticatedGmailClient(req) {
  const tokens = await getGmailTokens();
  if (!tokens) throw new Error('Gmail não autenticado. Acesse /api/gmail/auth para conectar.');
  const oauth2Client = getGmailOAuth2Client(getRedirectUri(req));
  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', async (newTokens) => {
    await saveGmailTokens(newTokens);
  });
  return oauth2Client;
}

// GET /api/gmail/auth — inicia fluxo OAuth2 (abre consent screen)
app.get('/api/gmail/auth', requireAuth, requireAdmin, (req, res) => {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
    return res.status(500).send('<p>❌ GMAIL_CLIENT_ID ou GMAIL_CLIENT_SECRET não configurados no .env</p>');
  }
  const oauth2Client = getGmailOAuth2Client(getRedirectUri(req));
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'],
    prompt: 'consent',
  });
  res.redirect(url);
});

// GET /api/gmail/callback — recebe código, troca por token, salva no Firestore
app.get('/api/gmail/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Código ausente');
  try {
    const oauth2Client = getGmailOAuth2Client(getRedirectUri(req));
    const { tokens } = await oauth2Client.getToken(code);
    await saveGmailTokens({ ...tokens, savedAt: new Date().toISOString() });
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2 style="color:#16a34a">✓ Gmail conectado com sucesso!</h2>
        <p>Pode fechar esta aba e voltar ao sistema.</p>
        <script>setTimeout(()=>window.close(),3000)</script>
      </body></html>
    `);
  } catch (err) {
    console.error('Gmail callback error:', err.message);
    res.status(500).send(`<p>Erro: ${err.message}</p>`);
  }
});

// GET /api/gmail/status — verifica se Gmail está autenticado
app.get('/api/gmail/status', requireAuth, async (req, res) => {
  try {
    const tokens = await getGmailTokens();
    if (!tokens) return res.json({ connected: false });
    const oauth2Client = getGmailOAuth2Client(getRedirectUri(req));
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    res.json({ connected: true, email: profile.data.emailAddress, savedAt: tokens.savedAt || null });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// ─── Coordenadores ────────────────────────────────────────────────────────────

// POST /api/coordenadores/importar — upload XLSX, parseia, salva no Firestore
app.post('/api/coordenadores/importar', requireAuth, requireAdmin, uploadMemory.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Arquivo obrigatório' });

    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!rows.length) return res.status(400).json({ error: 'Planilha vazia' });

    const colKeys    = Object.keys(rows[0]);
    // empresa/partner: chave de match com o sellout (partner_name ou organization_name)
    const empresaCol = colKeys.find(k => /^partner_name$/i.test(k))
                    || colKeys.find(k => /partner/i.test(k))
                    || colKeys.find(k => /organization_name/i.test(k));
    // coordenador: nome do VP / responsável
    const nomeCol    = colKeys.find(k => /^vp_name$/i.test(k))
                    || colKeys.find(k => /vp_name|coord/i.test(k));
    const emailCol   = colKeys.find(k => /^email$/i.test(k));

    if (!empresaCol || !emailCol) {
      return res.status(400).json({
        error: 'Colunas não identificadas automaticamente',
        colunas_encontradas: colKeys,
        esperado: 'partner_name (empresa) + email + (opcional) vp_name',
      });
    }

    // mapa: empresa_normalizada → [{ nome, email, empresaOriginal }]
    const mapa = {};
    for (const row of rows) {
      const empresa = String(row[empresaCol] || '').trim();
      const email   = String(row[emailCol]   || '').trim().toLowerCase();
      const nome    = nomeCol ? String(row[nomeCol] || '').trim() : email;
      if (!empresa || !email || !email.includes('@')) continue;
      if (!mapa[empresa]) mapa[empresa] = [];
      if (!mapa[empresa].find(c => c.email === email)) {
        mapa[empresa].push({ nome, email });
      }
    }

    const totalEmpresas = Object.keys(mapa).length;
    const totalCoord    = Object.values(mapa).reduce((acc, arr) => acc + arr.length, 0);

    const db = getFirebaseAdmin().firestore();
    await db.collection('system_config').doc('coordenadores').set({
      mapa,
      importadoEm: new Date().toISOString(),
      colunas: { empresa: empresaCol, nome: nomeCol || null, email: emailCol },
    });

    res.json({ ok: true, totalEmpresas, totalCoord, colunas: { empresa: empresaCol, nome: nomeCol, email: emailCol } });
  } catch (err) {
    console.error('Erro /api/coordenadores/importar:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/coordenadores — retorna mapeamento atual
app.get('/api/coordenadores', requireAuth, async (req, res) => {
  try {
    const db  = getFirebaseAdmin().firestore();
    const doc = await db.collection('system_config').doc('coordenadores').get();
    if (!doc.exists) return res.json({ mapa: {}, importadoEm: null });
    res.json(doc.data());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Email em Massa ───────────────────────────────────────────────────────────

function normalizeStr(str) {
  return String(str).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// GET /api/email-massa/holdings — cruza sellout + usuarios + coordenadores
app.get('/api/email-massa/holdings', requireAuth, async (req, res) => {
  try {
    const drive = getDriveClient(true);

    // 1. Sellout mais recente → mapa holding → Set<customer normalizado>
    const selloutList = await drive.files.list({
      q:         `'${process.env.GOOGLE_DRIVE_FOLDER_ID}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields:    'files(id, name, createdTime)',
      orderBy:   'createdTime desc',
      pageSize:  1,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    if (!selloutList.data.files?.length) return res.status(404).json({ error: 'Nenhum arquivo de sellout encontrado' });

    const selloutResp = await drive.files.get(
      { fileId: selloutList.data.files[0].id, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    const selloutRows = XLSX.utils.sheet_to_json(
      XLSX.read(selloutResp.data, { type: 'array' }).Sheets[XLSX.read(selloutResp.data, { type: 'array' }).SheetNames[0]],
      { defval: null }
    ).map(normalizeRow);

    const holdingCustomers = {};
    for (const row of selloutRows) {
      if (!row.holding || !row.customer) continue;
      const h = String(row.holding).trim();
      const c = normalizeStr(String(row.customer).trim());
      if (!holdingCustomers[h]) holdingCustomers[h] = new Set();
      holdingCustomers[h].add(c);
    }

    // 2. Usuários XLSX → mapa empresa normalizada → [{ nome, email }]
    const usuariosList = await drive.files.list({
      q:         `'${process.env.GOOGLE_DRIVE_USUARIOS_FOLDER_ID}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`,
      fields:    'files(id, name, createdTime)',
      orderBy:   'createdTime desc',
      pageSize:  1,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    if (!usuariosList.data.files?.length) return res.status(404).json({ error: 'Nenhum arquivo de usuários encontrado' });

    const usuariosResp = await drive.files.get(
      { fileId: usuariosList.data.files[0].id, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    const usuariosWb  = XLSX.read(usuariosResp.data, { type: 'array' });
    const wsDistrib   = usuariosWb.Sheets['Distribuidores'];
    const distribRows = wsDistrib ? XLSX.utils.sheet_to_json(wsDistrib, { defval: '' }) : [];

    const empresaEmails = {};
    for (const d of distribRows) {
      const empresa = normalizeStr(String(d.Empresa || '').trim());
      const email   = String(d.Email || '').trim().toLowerCase();
      const nome    = String(d.Nome  || '').trim();
      if (!empresa || !email || !email.includes('@')) continue;
      if (!empresaEmails[empresa]) empresaEmails[empresa] = [];
      empresaEmails[empresa].push({ nome, email });
    }

    // 3. Coordenadores do Firestore
    const db       = getFirebaseAdmin().firestore();
    const coordDoc = await db.collection('system_config').doc('coordenadores').get();
    const coordMapa = coordDoc.exists ? (coordDoc.data().mapa || {}) : {};

    // 4. Montar grupos
    const holdings        = [];
    const empresasComHolding = new Set();

    for (const [holding, customersSet] of Object.entries(holdingCustomers)) {
      const emailsMap = new Map();
      const empresasMatch = [];

      for (const custNorm of customersSet) {
        const matches = empresaEmails[custNorm] || [];
        if (matches.length) {
          empresasMatch.push(custNorm);
          empresasComHolding.add(custNorm);
          for (const m of matches) emailsMap.set(m.email, m);
        }
      }

      // Coordenadores: casar pelo nome da empresa (customer), não pelo nome da holding
      const coordMap = new Map();
      for (const custNorm of customersSet) {
        const coordKey = Object.keys(coordMapa).find(k => normalizeStr(k) === custNorm);
        if (coordKey) {
          for (const c of coordMapa[coordKey]) {
            if (!coordMap.has(c.email)) coordMap.set(c.email, c);
          }
        }
      }
      const coordenadores = [...coordMap.values()];

      holdings.push({
        holding,
        empresas:      [...customersSet],
        empresasMatch,
        emails:        [...emailsMap.values()],
        coordenadores,
        totalEmpresas: customersSet.size,
        totalEmails:   emailsMap.size,
      });
    }

    // Usuários sem holding
    const semHolding = [];
    for (const [empNorm, emailsArr] of Object.entries(empresaEmails)) {
      if (!empresasComHolding.has(empNorm)) semHolding.push(...emailsArr);
    }

    holdings.sort((a, b) => a.holding.localeCompare(b.holding));
    res.json({ holdings, semHolding });
  } catch (err) {
    console.error('Erro /api/email-massa/holdings:', err.message);
  res.status(500).json({ error: err.message });
  }
});

function buildEmailRaw({ to, cc, bcc, subject, html }) {
  const lines = [
    `To: ${to}`,
    cc  ? `Cc: ${cc}`   : null,
    bcc ? `Bcc: ${bcc}` : null,
    'Content-Type: text/html; charset=utf-8',
    'MIME-Version: 1.0',
    `Subject: =?utf-8?B?${Buffer.from(subject).toString('base64')}?=`,
    '',
    html,
  ].filter(l => l !== null);
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

// POST /api/email-massa/enviar — SSE, 1 email por holding
app.post('/api/email-massa/enviar', requireAuth, requireAdmin, async (req, res) => {
  const { holdings, assunto, corpo, cc = [], cco = [] } = req.body || {};
  if (!holdings?.length)  return res.status(400).json({ error: 'Nenhuma holding selecionada' });
  if (!assunto?.trim())   return res.status(400).json({ error: 'Assunto obrigatório' });
  if (!corpo?.trim())     return res.status(400).json({ error: 'Corpo obrigatório' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const oauth2Client = await getAuthenticatedGmailClient(req);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    send({ tipo: 'inicio', total: holdings.length });

    for (let i = 0; i < holdings.length; i++) {
      const h = holdings[i];
      send({ tipo: 'iniciando', holding: h.holding, indice: i + 1, total: holdings.length });

      try {
        const toList  = h.emails.map(e => e.email);
        const ccList  = [...(h.coordenadores || []).map(c => c.email), ...cc].filter(Boolean);
        const bccList = [...cco].filter(Boolean);

        // Substitui {{holding}} pelo nome real da holding
        const holdingNome = h.holding;
        const assuntoFinal = assunto.replace(/\{\{holding\}\}/gi, holdingNome);
        const corpoFinal   = corpo.replace(/\{\{holding\}\}/gi, holdingNome);

        const raw = buildEmailRaw({
          to:      toList.join(', '),
          cc:      ccList.length  ? ccList.join(', ')  : null,
          bcc:     bccList.length ? bccList.join(', ') : null,
          subject: assuntoFinal,
          html:    corpoFinal,
        });

        await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });

        send({ tipo: 'enviado', holding: h.holding, indice: i + 1, total: holdings.length, totalEmails: toList.length });
      } catch (err) {
        send({ tipo: 'erro', holding: h.holding, indice: i + 1, total: holdings.length, erro: err.message });
      }

      if (i < holdings.length - 1) await new Promise(r => setTimeout(r, 500));
    }

    send({ tipo: 'concluido', total: holdings.length });
  } catch (err) {
    send({ tipo: 'erro_fatal', erro: err.message });
  }
  res.end();
});

// SPA fallback — qualquer rota desconhecida serve o index.html (requer auth)
app.get('*', (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.redirect('/login');
  try {
    jwt.verify(token, JWT_SECRET);
    res.sendFile(path.join(__dirname, '..', 'index.html'));
  } catch {
    res.clearCookie('token').redirect('/login');
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`BIC Portal rodando em http://localhost:${PORT}`);
  console.log(`Acesso na rede: http://<SEU_IP_LOCAL>:${PORT}`);
});
