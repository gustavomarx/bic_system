# BIC System — Contexto Completo do Projeto

> Documento de referência técnica cobrindo o **BIC System Portal** (dashboard) e o **BIC Monitor** (gerador de dados), suas integrações, módulos, stacks e fluxo de dados.
>
> **Multitenant** (adicionado 2026-06-17): suporta 14 tenants + **Visão Geral** (dashboard).
>
> **Monitor dentro do system** (2026-10-12): o bic_monitor foi incorporado em `bic_system/monitor/` (git subtree, com histórico). Continua rodando **localmente** na porta 3001 (Oracle, proxy do Postgres e BigQuery desta máquina) e é aberto pelo system em Visão Geral → **BIC Monitor**, só para admin, via SSO. A pasta `workspace/bic_monitor` e o repo GitHub `bic_monitor` ficaram obsoletos. Seletor no topo do sidebar. Permissões por tenant nas custom claims Firebase (`tenants: ['bic','mdias',...]`).

---

## Visão Geral

O ecossistema é composto por dois sistemas Node.js que trabalham em conjunto:

| Sistema | Porta | Papel |
|---------|-------|-------|
| **bic_system** | 3004 | Portal de visualização de dados de sellout para distribuidores |
| **bic_monitor** | 3001 | Coleta dados do Oracle, gera snapshots e alimenta o portal |

O **bic_monitor** (pasta `monitor/`) é a fonte de dados — ele consulta Oracle, Postgres e BigQuery, gera arquivos XLSX e os salva no Google Drive. O **bic_system** lê esses arquivos do Drive e os apresenta como dashboard interativo. Só o system vai para a Vercel (`.vercelignore` contém `monitor/`).

---

## Arquitetura de Integração

```
┌─────────────┐
│   Oracle DB  │  (source of truth — sellers.bic_vendas_PARCEIRO)
└──────┬───────┘
       │
       v
┌──────────────────┐         Google Drive (pasta compartilhada)
│   bic_monitor    │ ──────────────────────────────────────────┐
│  (port 3001)     │  salva XLSX, PDFs, JSON                   │
│                  │                                            │
│ - Vendas Oracle  │                                            v
│ - Inatividade    │                               ┌────────────────────┐
│ - De-Para        │                               │   bic_system       │
│ - Batalha Naval  │                               │   (port 3004)      │
└──────────────────┘                               │                    │
       │                                           │ - Lê Drive         │
       │ PostgreSQL                                │ - Lê ClickUp       │
       v                                           │ - Exibe dashboard  │
  organizations DB                                 └────────────────────┘
                                                            │
                                                      ClickUp API
                                                   (distribuidores)
```

Além do Oracle, o monitor lê o **Postgres** `organizations` (proxy 127.0.0.1:6543 — usuários Geral) e o **BigQuery** `bigdata.partner_user_permission` (coordenadores, manual). O system abre o monitor por **SSO (JWT) + iframe** (ver módulo 12).

---

## Stack Tecnológica

### bic_system (Portal)

| Camada | Tecnologia |
|--------|-----------|
| Runtime | Node.js + Express 4.18.2 |
| Frontend | HTML5 + CSS + JavaScript vanilla (SPA, ~7.100 linhas em `index.html`) |
| Auth | Firebase Auth + JWT (cookie `httpOnly`) |
| Google API | `googleapis ^140.0.1` |
| Excel | `xlsx ^0.18.5` |
| Upload | `multer ^1.4.5` |
| Extras | `cors`, `dotenv`, `cookie-parser`, `jsonwebtoken`, `firebase-admin` |

### bic_monitor (Gerador de dados)

| Camada | Tecnologia |
|--------|-----------|
| Runtime | Node.js + Express |
| Banco principal | Oracle DB (`oracledb ^6.5.1`, modo thin, TLS sem wallet) |
| Banco secundário | PostgreSQL (`pg ^8.20.0`) via Cloud SQL Auth Proxy (127.0.0.1:6543, IAM `gustavo@sellers.com.br`, sem senha) |
| BigQuery | `@google-cloud/bigquery` (ADC do gcloud, projeto `flow-prod-303615`) — só coordenadores, manual |
| Auth | `jsonwebtoken` (SSO vindo do system) |
| Upload | `multer ^1.4.5-lts.1` |
| Google API | `googleapis ^144.0.0` |
| Excel | `xlsx ^0.18.5` |
| Frontend | HTML5 + CSS + JavaScript vanilla (~4.700 linhas) |

---

## Estrutura de Diretórios — bic_system

```
bic_system/
├── index.html                       # UI + JS + CSS (SPA completa)
├── package.json
├── context.md
├── README.md
├── backend/
│   ├── server.js                    # API Express (todas as rotas)
│   ├── package.json
│   ├── .env                         # configurado localmente (não versionado)
│   ├── .env.example
│   └── credentials/                 # service-account.json, gmail-tokens.json (não versionados)
├── frontend/
│   └── (imagens: ftp.png, sellers.png)
├── .vercelignore                    # contém monitor/ (monitor não vai para a Vercel)
└── monitor/                         # BIC Monitor (ex-repo bic_monitor), roda local na 3001
    ├── index.html                   # UI do monitor (dark, shell no padrão do system)
    ├── integracoes.js
    ├── PROJETO.md
    ├── .gitignore                   # .env, credentials/, logs/, node_modules/
    └── backend/
        ├── server.js                # API Express do monitor
        ├── .env / .env.example      # .env fora do git
        ├── credentials/             # service-account.json (fora do git)
        ├── logs/
        └── scripts/
            └── atualizar-todos.js   # tarefa diária (Windows, 8h): todas as indústrias + Geral + alertas Slack
```

---

## Autenticação

- Login via **Firebase Auth** (email/senha) na tela `/login`
- Backend verifica ID token Firebase → gera **JWT** salvo em cookie `httpOnly`
- Middleware `requireAuth` valida JWT em todas as rotas `/api` — recusa tokens com `aud` (tokens do BIC Monitor usam a mesma chave e não valem como sessão do system)
- Middleware `requireAdmin` restringe rotas sensíveis ao email definido em `ADMIN_EMAILS`
- Módulos por usuário: custom claims Firebase (`modules: string[]` ou `null` = acesso total)
- **Hash navigation** (`#modulo`) → ao carregar, redireciona direto para o módulo se tiver permissão

**Endpoints de perfil:**
- `GET /api/me` — perfil do usuário atual
- `PATCH /api/me` — atualizar nome/email
- `PATCH /api/me/password` — trocar senha

---

## Módulos — bic_system

> **Lista completa (BIC):** comparativo · batalha · inatividade · historico · depara · distribuidores · paliativos · usuarios · ranking *(em breve)* · evolucao *(em breve)* · admin-users *(admin only)*

### 1. Comparativo de Sellout

Compara dois relatórios XLSX (anterior vs. atual) exibindo tendências de vendas por holding/parceiro/mês com linhas coloridas (subiu/caiu/novo/sumiu).

**APIs:**
- `GET /api/arquivos` → lista `relatorio_DD-MM-YYYY.xlsx` na pasta Drive
- `GET /api/arquivo?fileId=` → baixa e parseia XLSX com normalização de colunas

**Normalização de colunas:**
```js
{
  holding:    ['holding', 'HOLDING', 'Holding'],
  customer:   ['customer', 'partner_name', 'PARTNER_NAME', ...],
  anoMes:     ['anomes', 'ANOMES', 'AnoMes', ...],
  vendaValor: ['venda_valor', 'VENDA_VALOR', 'valor', ...],
  cnpj:       ['cnpj_customer', 'CNPJ_CUSTOMER', 'cnpj', ...]
}
```

---

### 2. Batalha Naval

Grid de vendas por dia do mês. Linhas = distribuidoras, colunas = dias. Células coloridas: verde (> 0), vermelho (< 0), `—` (sem movimentação).

**APIs:**
- `GET /api/batalha-naval-arquivos` → lista até 5 arquivos recentes no Drive
- `GET /api/batalha-naval-arquivo` → arquivo mais recente (metadata)
- `GET /api/batalha-naval-dados?fileId=` → parseia aba "Dados" do XLSX

**Funcionalidades:**
- Seletores: **Holding** (inclui "Todas") + **Mês/Ano**
- Filtro de busca por distribuidora
- Filtro de dias da semana (chips Dom–Sáb)
- **Checkbox ✓ por distribuidora** — persistido em `localStorage` (`bn_checks`); botão "Desmarcar todos"
- **Ordenação por coluna** — clique no cabeçalho ordena por nome, valor do dia ou status do check; segundo clique inverte; indicador ▲/▼
- Export CSV com metadados, totais e filtros aplicados
- Histórico de arquivos no Drive (dropdown)

**Alertas visuais (adicionado 2026-07-31):**

| Condição | Linha | Células da janela |
|---|---|---|
| Gap ≥ 4 dias seguidos sem movimentação (mid-mês, retomou depois) | Fundo amarelo | Células do gap em amarelo forte |
| Atraso ≥ 4 dias sem movimentação (trailing — sem retomada até hoje) | Fundo vermelho | Células do atraso em vermelho forte |
| Sem nenhuma movimentação no mês | Fundo cinza + badge "sem vendas" | — |

- **Movimentação** = qualquer valor ≠ 0 (venda positiva **ou** devolução negativa). Valor zero não quebra gap.
- Mês atual: referência = dia de hoje. Meses passados: referência = último dia do mês.
- Prioridade visual: cinza > vermelho > amarelo.
- **Helper:** `bnComputeAlertas(p, idx, diasNoMes, todayDay)` → `{ midGaps, maxMidGap, atraso, atrasoStart, atrasoEnd, lastSaleDay, noSale }`

**Chips de filtro (linha abaixo dos dias da semana):**
- `Gap 4d` — exibe só orgs com gap mid-mês ≥ 4 dias consecutivos
- `Atraso >3d` — exibe só orgs com trailing ≥ 4 dias sem movimentação
- `Sem vendas` — exibe só orgs sem nenhuma movimentação no mês
- `Sem cores` — toggle: oculta cores de alerta sem afetar filtros ativos

**`batalhaState`:** `{ rows, fileId, loaded, diasSemana, searchDistrib, sortCol, sortAsc, filtroGap, filtroAtraso, filtroSemVendas, ocultarAlertas }`

---

### 3. Dias sem Venda (Inatividade)

Monitora períodos de inatividade de distribuidores dentro de janela móvel de 60 dias.

**APIs:**
- `GET /api/inatividade-arquivos` → lista snapshots no Drive
- `GET /api/inatividade-historico?limit=N` → agrega os últimos N snapshots (lê aba `Detalhe`)

**Abas:** Ranking Geral | Padrão Recorrente

---

### 4. Histórico de Vendas

Dados históricos por holding/parceiro/período. Pivot por ano ou mês.

**APIs:**
- `GET /api/historico-arquivos`
- `GET /api/historico-dados?fileId=`

---

### 5. Análise De → Para

Mapeamento de produtos distribuidor → BIC. Download de template, upload preenchido, histórico de versões.

**APIs:**
- `GET /api/depara-arquivos`
- `GET /api/depara-arquivo?fileId=`
- `GET /api/depara-download?fileId=`
- `POST /api/depara-upload`

---

### 6. Distribuidores

Diretório completo de distribuidores (fonte: ClickUp). 20+ campos customizados, últimos 3 comentários por distribuidor.

**APIs:**
- `GET /api/distribuidores` → lê JSON cache no Drive
- `POST /api/distribuidores-atualizar` → sincroniza ClickUp via SSE (progresso 0–100%)

---

### 7. Paliativos MTrix

Rastreia soluções paliativas por holding a partir de Google Doc.

**APIs:**
- `GET /api/paliativos` → exporta Doc como texto, parseia seções
- `GET /api/paliativos?debug=1` → texto bruto

---

### 8. Usuários (Visão Geral) — reformulado 2026-10-12

Saiu do tenant BIC e foi para a **Visão Geral**, cobrindo todas as indústrias. Itens no menu logo abaixo de "Painel Geral":
- **Usuários** (`usuarios`) — lista com filtro por indústria (`#usu-ind`), chips de resumo, coluna Indústria quando "Todas", coluna Perfil. Não-admin só vê as indústrias dos seus tenants.
- **Envio de E-mail** (`usuarios-email`, submenu, só admin) — tela separada.

**Fonte:** `usuarios_DD-MM-AAAA.xlsx` (aba "Usuarios": Industria, Tipo, Empresa, Id_Organizacao, Nome, Id_Usuario, Email, Perfil, Tem_Permissao) gerado pelo monitor em `/geral/atualizar-tudo` na pasta `GOOGLE_DRIVE_USUARIOS_FOLDER_ID`. Leituras da pasta filtram pelo prefixo do nome (`usuarios_` / `coordenadores_`).

**Regra de vínculo distribuidora ↔ indústria** (monitor, `INDUSTRIAS_USUARIOS`): partnership ativa com a org da indústria **E** código da indústria em `project_list_array`/`project` (ou `group_name` só para mDiasBranco/mDiasBrancoSaudaveis; mBic no group_name é ignorado). 14 indústrias do portal + Ultracheese; Braveo fora. Sem VENDEDOR e sem e-mails @sellers.

**APIs:**
- `GET /api/usuarios-geral` → linhas filtradas pelas indústrias do usuário (sem `Id_Organizacao`)
- `GET /api/usuarios-arquivo`, `GET /api/usuarios-dados?fileId=` → legado BIC (`usuariosBic` aceita formato novo e antigo)

#### Envio de E-mail em massa

**Fluxo:** escolhe a **indústria** → carrega grupos por **customer**; na BIC também por **holding** (como era antes).
- Só distribuidores com `Tem_Permissao = 'Sim'` (BI permitido), como na tela de usuários.
- Coordenadores entram em CC automaticamente (casados pelo id da distribuidora; fallback pelo nome).

**Coordenadores** (2026-10-12): vêm do BigQuery `bigdata.partner_user_permission`, consulta **só manual** feita pelo monitor (`POST /geral/coordenadores`). Gera `coordenadores_DD-MM-AAAA.xlsx` (Industria, Id_Industria, Id_Organizacao, Empresa, Nome, Email) na pasta dos usuários. O botão "📥 Atualizar coordenadores" do system pega um SSO e chama o monitor local com `Authorization: Bearer`. Se a indústria não tiver linhas no arquivo, usa o mapa antigo do Firestore (`system_config`).

**APIs:**
| Endpoint | Descrição |
|---|---|
| `GET /api/gmail/auth` · `/callback` · `/status` | OAuth2 Gmail (token no Firestore `system_config/gmail_token`) |
| `GET /api/email-massa/grupos?tenant&modo` | Grupos por customer ou holding (admin) |
| `GET /api/email-massa/holdings` | Legado |
| `GET /api/coordenadores?tenant` | `{fonte: 'bigquery'|'firestore', total, arquivo, importadoEm}` |
| `POST /api/coordenadores/importar` | Upload XLSX manual (legado) |
| `POST /api/email-massa/enviar` | SSE — 1 e-mail por grupo; aceita `modo` e `industria` |
| `POST /api/validacao-mensal/importar` | Parseia CSV/XLSX de fechamento; retorna dados sem persistir |

**Comportamento do envio:**
- `TO`: e-mails dos distribuidores do grupo · `CC`: coordenadores + avulsos · `BCC`: avulsos ocultos
- Tags: `{{holding}}`, `{{industria}}`, `{{referencia}}`, `{{prazo}}`, `{{tabela_validacao}}`
- Editor rich text (contenteditable) ou modo HTML raw

**Credenciais Gmail** (Google Cloud project: `storied-key-493919-a7`):
```
GMAIL_CLIENT_ID=<ver .env ou Vercel>
GMAIL_CLIENT_SECRET=<ver .env ou Vercel>
```
Também configuradas nas **Env Vars do Vercel**.

---

#### Validação Mensal — Opt-in de Fechamento (adicionado 2026-07-28)

Funcionalidade para envio de email com dados de fechamento por holding, permitindo que distribuidores validem seus números antes de confirmar na plataforma Sellers.

**Fluxo:**
1. Admin faz upload de CSV/XLSX com colunas: `HOLDING` (opcional), `Customer`, `Tipo de Operação`, `Venda Valor` — resposta inclui `totalCustomers`
2. Backend parseia e retorna os dados — **sem salvar em banco** (in-memory por sessão)
3. Frontend armazena em `usuariosState.validacaoMensal` com prompt de mês de referência
4. No modal de email, botão "📋 Template Validação Mensal" preenche corpo + assunto
5. No envio, `validacaoLinhas` e `validacaoReferencia` passam no body do POST
6. Backend injeta `{{tabela_validacao}}` por holding antes de enviar

**Template de email:**
- Estrutura: cabeçalho → tabela de dados → prazo → tutorial (PASSO 1–4)
- Tabela agrupada por Customer com alternância de fundo; total líquido ao final
- Valores formatados como BRL (`R$ X.XXX,XX`); negativos como `- R$ X.XXX,XX`
- Tipos de operação normalizados: `VENDA→Venda`, `DEVOLUCAO→Devolução`, `TRANSFERENCIA→Transferência`, `BONIFICACAO→Bonificação`

**Tags disponíveis no editor:**
| Tag | Substituição |
|-----|-------------|
| `{{holding}}` | Nome da holding |
| `{{referencia}}` | Mês de referência (ex: Julho/2026) |
| `{{prazo}}` | Prazo configurável no modal (ex: 01/08/2026 até 06/08/2026) |
| `{{tabela_validacao}}` | Tabela HTML com dados de fechamento da holding |

**Campo Prazo:**
- Auto-calculado: mês seguinte ao da referência (ex: ref=Julho/2026 → `01/08/2026 até 06/08/2026`)
- Editável no modal; valor persistido em `_emPrazoEditado` entre aberturas
- Resetado ao importar nova validação

**Helpers backend:**
- `parseBRLNum(str)` — detecta formato EN (`-859.59`) vs BR (`1.234,56`) antes de parsear
- `formatBRL(str)` — formata como moeda BRL
- `tipoLabel(tipo)` — mapeia UPPERCASE para labels PT-BR com acentos
- `buildValidacaoTable(linhas, nome, referencia, modo)` — gera HTML da tabela por holding ou, em modo customer, filtrando pelo customer (nome normalizado)

---

### 9. Ranking de Distribuidores *(em breve)*

Módulo planejado — aparece no sidebar com badge "Em breve". Sem API implementada.

---

### 10. Evolução Histórica *(em breve)*

Módulo planejado — aparece no sidebar com badge "Em breve". Sem API implementada.

---

### 11. Admin — Gestão de Usuários

Acessível apenas para admins (`ADMIN_EMAILS`). Gerencia usuários Firebase Auth: criar, ativar/desativar, remover, definir permissões de módulos.

**APIs:**
- `GET /api/admin/users`
- `POST /api/admin/users`
- `PATCH /api/admin/users/:uid`
- `DELETE /api/admin/users/:uid`
- `PATCH /api/admin/users/:uid/modules`

### 12. BIC Monitor (Visão Geral, admin) — 2026-10-12

Item **🖥️ BIC Monitor** (`monitor`) logo após "Gestão de Acesso", visível só para admin na Visão Geral. Abre o monitor local num iframe (`allow="local-network-access"`) com barra de Recarregar / "Abrir em nova aba".

**SSO:**
1. `GET /api/monitor/sso` (requireAuth + requireAdmin) assina JWT com `JWT_SECRET`, `aud: 'bic-monitor'`, 2 min, `jti` de uso único → `{ base, token, url }` (`base` = `MONITOR_URL`, padrão `http://localhost:3001`).
2. Monitor `GET /auth/sso?t=` valida com `SYSTEM_JWT_SECRET` (= `JWT_SECRET` do system), queima o `jti` e grava cookie `monitor_sess` (`aud: 'bic-monitor-sess'`, 12h, httpOnly, secure, `sameSite: 'none'`, `partitioned`).
3. Middleware do monitor aceita: `/health` e `/auth/*` livres; `x-monitor-token` (agendamento); `Bearer` com `aud bic-monitor` (chamadas do system); cookie de sessão. Senão "Acesso restrito" (HTML) ou 401.

**Proteções:** CORS e CSP `frame-ancestors` restritos a `SYSTEM_ORIGINS`; header `Access-Control-Allow-Private-Network`; o monitor só serve `index.html`, `integracoes.js` e `*.png` (nada de `backend/`).

**Chrome — Local Network Access:** na primeira vez pela Vercel o Chrome pede "acesso à rede local"; é preciso **Permitir** (vale também para o botão de coordenadores). Pelo `localhost:3004` não pede. O monitor só funciona nesta máquina, com o servidor rodando.

---

### Alertas Slack (Visão Geral, admin)

Alertas de anomalia no canal `#anomalia-bic-system`, config no Firestore. Disparados por `POST /api/alertas/auto` (token `ALERTAS_TOKEN`) ao final do `monitor/backend/scripts/atualizar-todos.js` (tarefa diária das 8h).

---

## Multitenant — 14 Tenants

| Tenant | Badge | Módulos disponíveis |
|--------|-------|---------------------|
| `bic`       | BIC | comparativo, batalha, inatividade, historico, depara, distribuidores, paliativos, ranking*, evolucao* |
| `asa`       | ASA | comparativo, batalha, historico |
| `bombril`   | BOM | comparativo, batalha, historico |
| `cicopal`   | CIC | comparativo, batalha, historico |
| `fini`      | FIN | comparativo, batalha, historico |
| `fruki`     | FRK | comparativo, batalha, historico |
| `gallo`     | GAL | comparativo, batalha, historico |
| `gtex`      | GTX | comparativo, batalha, historico |
| `kibon`     | KBN | comparativo, batalha, historico |
| `mdias`     | MD  | comparativo, batalha, historico |
| `mdiassaud` | MDS | comparativo, batalha, historico |
| `marilan`   | MRL | comparativo, batalha, historico |
| `peccin`    | PCC | comparativo, batalha, historico |
| `unilever`   | ULV | comparativo, batalha, historico |

*em breve · **Visão Geral** (dashboard): Painel Geral, Usuários, Envio de E-mail*, Alertas*, Gestão de Acesso*, BIC Monitor* (*só admin)

**Como funciona:**
- Seletor de tenant no topo do sidebar (`.bic-badge` → dropdown dinâmico)
- `currentTenant` global controla qual tenant está ativo
- Todas as chamadas API tenant-específicas passam `?tenant=<id>`
- Backend usa `getTenantFolders(tenant)` para escolher o folder ID correto no Drive
- Tenants sem HOLDING (todos exceto BIC): `noHolding = true`; filtro holding oculto no Comparativo e Batalha Naval
- Permissões no Firebase custom claims: `tenants: ['bic']` | `['mdias']` | combinações livres
- Admin panel: seção "Tenants" no modal de permissões (salvo junto com módulos no mesmo endpoint `/api/admin/users/:uid/modules`)

**Env vars por tenant** (padrão `<TENANT>_GOOGLE_DRIVE_<TIPO>_FOLDER_ID`):

| Tenant | Env var — comparativo | batalha | historico |
|--------|----------------------|---------|-----------|
| `bic`       | `GOOGLE_DRIVE_FOLDER_ID` | `GOOGLE_DRIVE_BATALHA_FOLDER_ID` | `GOOGLE_DRIVE_HISTORICO_FOLDER_ID` |
| `mdias`     | `MDIAS_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID` | `MDIAS_GOOGLE_DRIVE_BATALHA_FOLDER_ID` | `MDIAS_GOOGLE_DRIVE_HISTORICO_FOLDER_ID` |
| `mdiassaud` | `MDIASSAUD_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID` | `MDIASSAUD_...` | `MDIASSAUD_...` |
| `marilan`   | `MARILAN_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID` | `MARILAN_...` | `MARILAN_...` |
| `asa`       | `ASA_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID` | `ASA_...` | `ASA_...` |
| `bombril`   | `BOMBRIL_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID` | `BOMBRIL_...` | `BOMBRIL_...` |
| `cicopal`   | `CICOPAL_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID` | `CICOPAL_...` | `CICOPAL_...` |
| `fini`      | `FINI_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID` | `FINI_...` | `FINI_...` |
| `fruki`     | `FRUKI_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID` | `FRUKI_...` | `FRUKI_...` |
| `gallo`     | `GALLO_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID` | `GALLO_...` | `GALLO_...` |
| `gtex`      | `GTEX_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID` | `GTEX_...` | `GTEX_...` |
| `kibon`     | `KIBON_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID` | `KIBON_...` | `KIBON_...` |

**Env vars MDias (exemplo com valores):**
```
MDIAS_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID=1pvIcp77pJ-UCd9h7q-LVd9YeRm1Cj7Oz
MDIAS_GOOGLE_DRIVE_BATALHA_FOLDER_ID=14nRdRkB4lxvSq_TGHLEm6mXg69C4McY9
MDIAS_GOOGLE_DRIVE_HISTORICO_FOLDER_ID=1Lhf053Y-YXAuLe44qOcC2irgxSJRxBDi
```

**Env vars Marilan:**
```
MARILAN_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID=123oJQPMLwYfP6ujwNzzO3DyMl9RZS5R5
MARILAN_GOOGLE_DRIVE_BATALHA_FOLDER_ID=1AJNepT9TbI_uClHUap_X9tEJeUz7bVNz
MARILAN_GOOGLE_DRIVE_HISTORICO_FOLDER_ID=1np-fQl97bL6WJi1DTnXcqT4AdUJIkHrU
```

**Env vars Fini:**
```
FINI_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID=1-9NtxgSGSr9e66oTghRZ6pG8aIv_CODe
FINI_GOOGLE_DRIVE_BATALHA_FOLDER_ID=16yOzLLMcXcaP8Fsk-qnKTd4aHGW2RwdC
FINI_GOOGLE_DRIVE_HISTORICO_FOLDER_ID=1F7DC2ch9PhVMh53Hj66Ic8TCa_qmxKup
```

---

## Variáveis de Ambiente — bic_system `.env`

```env
PORT=3004
JWT_SECRET=
ADMIN_EMAILS=gustavo@sellers.com.br

# Firebase
FIREBASE_API_KEY=
FIREBASE_AUTH_DOMAIN=
FIREBASE_PROJECT_ID=bic-system-ab183
FIREBASE_STORAGE_BUCKET=
FIREBASE_MESSAGING_SENDER_ID=
FIREBASE_APP_ID=
FIREBASE_SERVICE_ACCOUNT_PATH=./credentials/firebase-service-account.json
# Em produção (Vercel): FIREBASE_ADMIN_JSON={...json...}

# Google Drive
GOOGLE_DRIVE_FOLDER_ID=               # sellout
GOOGLE_DRIVE_INATIV_FOLDER_ID=
GOOGLE_DRIVE_DIST_FOLDER_ID=
GOOGLE_DRIVE_PALIATIVO_DOC_ID=
GOOGLE_DRIVE_DEPARA_FOLDER_ID=
GOOGLE_DRIVE_DEPARA_UPLOAD_FOLDER_ID=
GOOGLE_DRIVE_HISTORICO_FOLDER_ID=
GOOGLE_DRIVE_USUARIOS_FOLDER_ID=
GOOGLE_DRIVE_BATALHA_FOLDER_ID=
GOOGLE_SERVICE_ACCOUNT_PATH=./credentials/service-account.json
# Em produção (Vercel): GOOGLE_SERVICE_ACCOUNT_JSON={...json...}

# Tenants adicionais (comparativo/batalha/historico por tenant)
MDIAS_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID=
MDIAS_GOOGLE_DRIVE_BATALHA_FOLDER_ID=
MDIAS_GOOGLE_DRIVE_HISTORICO_FOLDER_ID=
MDIASSAUD_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID=
MDIASSAUD_GOOGLE_DRIVE_BATALHA_FOLDER_ID=
MDIASSAUD_GOOGLE_DRIVE_HISTORICO_FOLDER_ID=
MARILAN_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID=
MARILAN_GOOGLE_DRIVE_BATALHA_FOLDER_ID=
MARILAN_GOOGLE_DRIVE_HISTORICO_FOLDER_ID=
ASA_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID=
ASA_GOOGLE_DRIVE_BATALHA_FOLDER_ID=
ASA_GOOGLE_DRIVE_HISTORICO_FOLDER_ID=
BOMBRIL_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID=
BOMBRIL_GOOGLE_DRIVE_BATALHA_FOLDER_ID=
BOMBRIL_GOOGLE_DRIVE_HISTORICO_FOLDER_ID=
CICOPAL_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID=
CICOPAL_GOOGLE_DRIVE_BATALHA_FOLDER_ID=
CICOPAL_GOOGLE_DRIVE_HISTORICO_FOLDER_ID=
FINI_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID=
FINI_GOOGLE_DRIVE_BATALHA_FOLDER_ID=
FINI_GOOGLE_DRIVE_HISTORICO_FOLDER_ID=
FRUKI_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID=
FRUKI_GOOGLE_DRIVE_BATALHA_FOLDER_ID=
FRUKI_GOOGLE_DRIVE_HISTORICO_FOLDER_ID=
GALLO_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID=
GALLO_GOOGLE_DRIVE_BATALHA_FOLDER_ID=
GALLO_GOOGLE_DRIVE_HISTORICO_FOLDER_ID=
GTEX_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID=
GTEX_GOOGLE_DRIVE_BATALHA_FOLDER_ID=
GTEX_GOOGLE_DRIVE_HISTORICO_FOLDER_ID=
KIBON_GOOGLE_DRIVE_COMPARATIVO_FOLDER_ID=
KIBON_GOOGLE_DRIVE_BATALHA_FOLDER_ID=
KIBON_GOOGLE_DRIVE_HISTORICO_FOLDER_ID=

# ClickUp
CLICKUP_TOKEN=
CLICKUP_BIC_LIST_ID=901325453294

# Gmail OAuth2
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=

# BIC Monitor / alertas
MONITOR_URL=http://localhost:3001   # opcional; base do monitor no SSO
ALERTAS_TOKEN=                      # usado pelo atualizar-todos.js do monitor
```

## Variáveis de Ambiente — monitor `monitor/backend/.env` (fora do git)

Ver `monitor/backend/.env.example`. Além de Oracle (`DB_*`, `<TENANT>_DB_*`) e pastas do Drive:
```env
PORT=3001
PG_HOST=127.0.0.1        # Cloud SQL Auth Proxy
PG_PORT=6543
PG_DATABASE=organizations
PG_USER=gustavo@sellers.com.br
PG_PASSWORD=             # vazio (IAM)
BIGQUERY_PROJECT_ID=flow-prod-303615
SYSTEM_JWT_SECRET=       # = JWT_SECRET do system
MONITOR_TOKEN=           # chave do agendamento (x-monitor-token)
SYSTEM_ORIGINS=https://bic-system.vercel.app,http://localhost:3004
BIC_SYSTEM_URL=          # para disparar /api/alertas/auto
ALERTAS_TOKEN=
```

---

## Padrões de Nomenclatura de Arquivos no Drive

| Tipo | Padrão |
|------|--------|
| Relatório de vendas | `relatorio_DD-MM-YYYY.xlsx` |
| Snapshot de inatividade | `inatividade_DD-MM-YYYY.xlsx` |
| Template De-Para | `depara_DD-MM-YYYY.xlsx` |
| Histórico | `historico_DD-MM-YYYY.xlsx` |
| Log de auditoria | `relatorio_DD-MM-YYYY.pdf` |
| Cache distribuidores | `distribuidores.json` |
| Usuários (todas as indústrias) | `usuarios_DD-MM-YYYY.xlsx` |
| Coordenadores (BigQuery) | `coordenadores_DD-MM-YYYY.xlsx` |

---

## Padrões de Código

- **SPA sem framework:** módulos ativados por toggle de classe no sidebar (`data-module`)
- **Column normalization:** mapeamento case-insensitive de variantes de nomes de coluna
- **SSE:** operações longas (sync ClickUp, envio de emails) respondem com `text/event-stream`
- **Batch paralelo:** chamadas ClickUp em lotes de 10–15 para evitar rate limiting
- **localStorage:** estado persistente no cliente (ex: `bn_checks` na Batalha Naval)
- **Firestore:** configurações persistentes no servidor (token Gmail, coordenadores)

---

## Execução Local

```bash
cd bic_system/backend && npm install && npm start
# acesso: http://localhost:3004

cd bic_system/monitor/backend && npm install && node server.js
# monitor: http://localhost:3001 (acesso direto mostra "Acesso restrito"; entrar pelo system)
```

- Proxy do Cloud SQL precisa estar rodando em 127.0.0.1:6543 (também às 8h, para a tarefa diária).
- Tarefa do Windows **"BIC Monitor - Atualizar relatorios"** (8h) roda `bic_system/monitor/backend/scripts/atualizar-todos.js`.
- `start-all.sh` e `iniciate.exe/services.py` já apontam para `bic_system/monitor/backend`.

**Pré-requisitos:**
- Node.js 18+
- `credentials/service-account.json` (Google Drive — projeto monitor-bic)
- `credentials/firebase-service-account.json` (Firebase Admin — projeto bic-system-ab183)
- `.env` preenchido

## Deploy

- **Vercel** — deploy automático via push para `main` (GitHub: `gustavomarx/bic_system`)
- URL produção: `https://bic-system.vercel.app`
- Variáveis sensíveis configuradas no painel Vercel (incluindo JSONs de service account inline)
- O monitor **não** é publicado (`.vercelignore`); roda só nesta máquina
