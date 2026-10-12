# BIC MONITOR — Documentação Completa do Projeto

> Comparador de relatórios de vendas BIC com análise de anomalias, integração Oracle e Google Drive, geração de PDF, alertas Slack e análise de inatividade por distribuidora.

---

## Estrutura de Arquivos

```
bic_monitor/
├── index.html                     (frontend principal — ~2837 linhas)
├── integracoes.js                 (mapeamento de integrações por CNPJ)
└── backend/
    ├── server.js                  (backend Node.js/Express — ~546 linhas)
    ├── package.json               (dependências)
    ├── .env.example               (template de configuração)
    ├── .env                       (variáveis de ambiente — não commitar)
    ├── test-oracle.js             (testes de conexão Oracle)
    └── credentials/
        └── service-account.json  (credenciais Google Drive — não commitar)
```

---

## Dependências

### Backend (`package.json`)

| Pacote        | Versão           | Uso                                |
|---------------|------------------|------------------------------------|
| express       | ^4.19.2          | Framework HTTP                     |
| cors          | ^2.8.5           | Cross-Origin Resource Sharing      |
| dotenv        | ^16.4.5          | Variáveis de ambiente              |
| oracledb      | ^6.5.1           | Driver Oracle (thin mode + TLS)    |
| googleapis    | ^144.0.0         | Google Drive API                   |
| multer        | ^1.4.5-lts.1     | Upload de arquivos (memoryStorage) |
| xlsx          | ^0.18.5          | Leitura/escrita Excel              |

### Frontend (CDNs)

| Biblioteca        | Versão | Uso                           |
|-------------------|--------|-------------------------------|
| XLSX              | 0.18.5 | Parse de Excel no navegador   |
| jsPDF             | 2.5.1  | Geração de PDF no navegador   |
| jsPDF AutoTable   | 3.8.2  | Tabelas em PDF                |
| Google Fonts      | —      | Inter + Material Symbols      |

### Scripts customizados

- **`integracoes.js`** — mapeamento `"NomeDistribuidora - ID": "tipo"` (sellers/ftp/temp)

---

## Configuração e Variáveis de Ambiente

```env
DB_USER=seu_usuario
DB_PASSWORD=sua_senha
DB_CONNECT_STRING=(description=(retry_count=20)(retry_delay=3)...)
GOOGLE_DRIVE_FOLDER_ID=id_da_pasta_de_relatorios
GOOGLE_DRIVE_LOG_FOLDER_ID=id_da_pasta_de_logs
GOOGLE_DRIVE_INATIV_FOLDER_ID=id_da_pasta_de_inatividade   # ← NOVO: pasta dedicada para histórico de inatividade
GOOGLE_SERVICE_ACCOUNT_PATH=./credentials/service-account.json
PORT=3001
```

> **Importante:** Crie uma nova pasta no Google Drive (ex: "Histórico Inatividade BIC"), compartilhe com o e-mail da Service Account e cole o ID aqui.

---

## Endpoints do Backend

### `GET /dados-atual`
- Busca dados atuais do Oracle (tabela `sellers.bic_vendas_PARCEIRO`)
- Filtra ano atual até hoje
- Resposta: `[{holding, customer, anomes, valor}]`
- Side-effect: salva histórico no Google Drive automaticamente

### `GET /ultimo-arquivo`
- Busca o arquivo Excel mais recente da pasta do Drive
- Query param opcional: `?fileId=` para buscar arquivo específico
- Resposta: `{filename, fileId, buffer (base64)}`
- Padrão de nome para filtrar: `relatorio_DD-MM-YYYY.xlsx`

### `GET /listar-arquivos`
- Lista todos os arquivos Excel da pasta do Drive
- Resposta: `[{id, name}]` ordenado por data (mais recente primeiro)

### `POST /upload-drive`
- Upload de arquivo Excel para pasta de histórico do Drive
- Body: FormData com arquivo XLSX
- Nome gerado: `relatorio_DD-MM-YYYY.xlsx` (fuso horário Brasília)
- Resposta: `{success, filename, fileId}`

### `POST /upload-log`
- Upload de PDF para pasta "Log audições" no Drive
- Body: FormData com arquivo PDF
- Nome gerado: `relatorio_DD-MM-YYYY.pdf` (com sufixo `_1`, `_2` se já existir)
- Requer: `GOOGLE_DRIVE_LOG_FOLDER_ID` no .env

### `GET /analise-inatividade`
- Retorna dados brutos de datas sem venda — janela fixa **d-60** (hoje − 60 dias até hoje)
- **Sem query param de período** — a filtragem por período é feita inteiramente no frontend
- Salva o XLSX no Drive de forma assíncrona ao final (`saveInativToDrive`)
- Resposta:
  ```json
  {
    "dataInicio": "DD/MM/YYYY",
    "dataFim":    "DD/MM/YYYY",
    "detalhe": {
      "NomeDistribuidora": [{"data": "DD/MM/YYYY", "iso": "YYYY-MM-DD", "diaNum": 1}]
    },
    "cnpjMap": {"NomeDistribuidora": "12.345.678/0001-90"}
  }
  ```
  > `diaNum` já convertido para padrão JS (0=Dom, 1=Seg…6=Sáb) — o Oracle retorna 1-7 (1=Dom), o backend converte com `(Number(DIA_NUM) - 1 + 7) % 7`

**Janela fixa no Oracle:**
- `DATA_INICIO = TRUNC(SYSDATE) - 60`
- `DATA_FIM = TRUNC(SYSDATE)`

**CTEs da query Oracle:**

1. **`params`** — janela fixa d-60
2. **`calendario`** — todos os dias da janela via `CONNECT BY`
3. **`distribuidoras`** — `DISTINCT PARTNER_NAME` + `MAX(CNPJ_CUSTOMER)` com venda na janela
4. **`grade`** — produto cartesiano: cada distribuidora × cada dia do calendário
5. **`vendas`** — soma de `VENDA_VALOR > 0` por distribuidora/dia
6. **`dias_sem_venda`** — LEFT JOIN grade × vendas, onde `v.DT IS NULL`

**Query única (datas individuais):** retorna `PARTNER_NAME`, `CNPJ_CUSTOMER`, `DATA_STR (DD/MM/YYYY)`, `DATA_ISO (YYYY-MM-DD)`, `DIA_NUM`, `DATA_INICIO_STR`, `DATA_FIM_STR` — **não há mais query de resumo no backend**.

**Campos da tabela Oracle:** `PARTNER_NAME`, `CNPJ_CUSTOMER`, `VENDA_DATA`, `VENDA_VALOR` (tabela `sellers.bic_vendas_PARCEIRO`)

---

### `POST /upload-inatividade`
- Upload de XLSX de inatividade para pasta dedicada no Drive
- Body: FormData com arquivo
- Nome gerado: `inatividade_DD-MM-YYYY.xlsx` (fuso Brasília) — deduplicação com sufixo `_1`, `_2`
- Requer: `GOOGLE_DRIVE_INATIV_FOLDER_ID` no .env
- Resposta: `{success, filename, fileId}`

### `GET /listar-inatividade`
- Lista arquivos XLSX de inatividade na pasta dedicada (filtro por regex `inatividade_DD-MM-YYYY*.xlsx`)
- Resposta: `[{id, name, createdTime}]` ordenado por `createdTime desc`
- Usado pelo frontend para popular o select de histórico e verificar badge do dia

**Implementação (server.js):**
```javascript
app.get('/listar-inatividade', async (req, res) => {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_PATH,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const drive = google.drive({ version: 'v3', auth });
    const folderId = process.env.GOOGLE_DRIVE_INATIV_FOLDER_ID;

    const listRes = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime desc',
      pageSize: 1000,
    });

    res.json(listRes.data.files || []);
  } catch (err) {
    console.error('Erro listar inatividade:', err);
    res.status(500).json({ error: err.message });
  }
});
```

---

### `GET /health`
- Health check: retorna `{status: 'ok', timestamp}`

---

## Lógica de Histórico de Inatividade (XLSX)

### Estrutura do arquivo salvo pelo backend (`saveInativToDrive`)

Nome: `inatividade_DD-MM-YYYY.xlsx` (gerado pelo backend ao receber a consulta Oracle)

**Aba 1 — `Detalhe`** (dados brutos d-60, todas as ocorrências)

| PARTNER_NAME | CNPJ | DATA | ISO | DIA_NUM | DIA_SEMANA |
|---|---|---|---|---|---|
| Distribuidora A | 12.345.678/0001-90 | 01/04/2025 | 2025-04-01 | 3 | Terca-feira |

Colunas: `PARTNER_NAME`, `CNPJ`, `DATA (DD/MM/YYYY)`, `ISO (YYYY-MM-DD)`, `DIA_NUM (0-6 JS)`, `DIA_SEMANA`

**Aba 2 — `Meta`**

| CHAVE | VALOR |
|---|---|
| dataInicio | 01/04/2025 |
| dataFim | 16/04/2025 |
| geradoEm | 16/04/2025 15:32 |
| totalDistribuidoras | 24 |
| totalOcorrencias | 87 |

> **Não há aba `Resumo`** — o resumo (agrupamento por distribuidora + dia da semana) é calculado no frontend a partir dos dados brutos.

---

### Quem salva o XLSX no Drive

**O backend** chama `saveInativToDrive()` de forma assíncrona logo após responder ao `GET /analise-inatividade` — **o frontend não faz upload**. `saveInativSnapshot` foi removida do frontend.

Deduplicação: se já existe `inatividade_DD-MM-YYYY.xlsx` no Drive, gera `_1`, `_2`, etc.

---

### Verificação de arquivo do dia (frontend)

`fetchInatividade()` chama `GET /listar-inatividade` antes de fazer a consulta Oracle:
- Se já existe arquivo do dia: exibe `confirm()` perguntando se quer atualizar
- Se o usuário cancelar: aborta sem consultar o Oracle
- Após a consulta: seta o badge de snapshot para `saving` e agenda `loadInativHistList()` após 4 s para atualizar o badge

---

### Filtragem por período — feita inteiramente no frontend

O backend retorna sempre os 60 dias brutos. O frontend filtra via `inativApplyPeriodo()`:

| Opção no select (`#inativDias`) | Janela aplicada no frontend |
|---------------------------------|-----------------------------|
| `d60` (padrão) | Todos os dados brutos (dataInicio → dataFim do Oracle) |
| `mes_passado` | Primeiro dia do mês passado → último dia do mês passado |
| `mes_atual` | Primeiro dia do mês atual → hoje |
| `semana_passada` | Segunda da semana passada → domingo da semana passada |
| `semana_atual` | Segunda da semana atual → hoje |

`inativApplyPeriodo()` recalcula `inativState.rows` e `inativState.detalhe` a partir de `inativState.rawDetalhe`.

---

### `GET /get-inatividade?fileId=`
- Baixa arquivo específico da pasta de inatividade (distinto da pasta de relatórios)
- Resposta: `{filename, fileId, buffer (base64)}`
- Usado por `loadInativSnapshot()` ao carregar snapshot histórico no frontend

---

## Interface do Usuário

### Header

- **`#todayBadge`** — badge com data atual (atualizado ao carregar)
- Título: "Monitoramento BIC — BI Daily Monitor"

---

### Navegação por Abas

| ID botão        | Aba ativada    | Conteúdo                       |
|-----------------|----------------|--------------------------------|
| `#tabBtnMonitor` | `#tabMonitor`  | Comparação de relatórios       |
| `#tabBtnInativ`  | `#tabInativ`   | Análise de inatividade         |

Função JS: `switchTab(tabName)`

---

### Aba 1 — Monitoramento

#### Upload e Carregar Dados

**Dropzones (drag-and-drop):**

| ID          | Slot   | Descrição                          |
|-------------|--------|------------------------------------|
| `#dropPrev` | prev   | Zona de drop para arquivo anterior |
| `#dropCurr` | curr   | Zona de drop para arquivo atual    |
| `#filePrev` | prev   | Input file oculto (aceita .xlsx/.csv) |
| `#fileCurr` | curr   | Input file oculto (aceita .xlsx/.csv) |

**Informações do arquivo carregado:**

| IDs (prev / curr)                             | Conteúdo exibido         |
|-----------------------------------------------|--------------------------|
| `#fileNamePrev` / `#fileNameCurr`             | Nome do arquivo          |
| `#fileDatePrev` / `#fileDateCurr`             | Data extraída do nome    |
| `#fileRowsPrev` / `#fileRowsCurr`             | Quantidade de linhas     |

**Dropdowns de seleção do Drive:**

| ID                | Slot   | Descrição                              |
|-------------------|--------|----------------------------------------|
| `#driveSelectPrev` | prev   | Seleciona arquivo anterior do Drive    |
| `#driveSelectCurr` | curr   | Seleciona arquivo atual do Drive       |

Populado por `loadDriveFileList()`.

**Botões de ação:**

| ID             | Ação                                                      |
|----------------|-----------------------------------------------------------|
| `#btnDrivePrev` | Busca arquivo mais recente do Drive para slot prev       |
| `#btnDriveCurr` | Busca arquivo mais recente do Drive para slot curr       |
| `#btnOracle`    | Busca dados atuais direto do Oracle                      |
| `#btnCompare`   | Executa comparação (desabilitado até ambos carregados)   |
| `#btnReset`     | Limpa tudo (estado + UI)                                 |
| `#btnReport`    | Abre modal de relatório resumido                         |

**Spinners de loading:**

| ID                  | Ativado quando           |
|---------------------|--------------------------|
| `#spinnerDrivePrev` | Buscando arquivo prev    |
| `#spinnerDriveCurr` | Buscando arquivo curr    |
| `#spinnerOracle`    | Buscando dados Oracle    |

Estilo: `.oculos-loader` (SVG animado).

**Loading indicator geral:**

- **`#loadingIndicator`** — aparece durante processamento de arquivos ("Processando arquivos...")

---

#### Estado Vazio

- **`#emptyState`** — visível até que a comparação seja executada, exibe instrução ao usuário

---

#### Resultados da Comparação

**Cards de Resumo (5 cards):**

| ID                    | Sub-label ID              | Conteúdo                             |
|-----------------------|---------------------------|--------------------------------------|
| `#cardPrev`           | `#cardPrevSub`            | Total do relatório anterior          |
| `#cardCurr`           | `#cardCurrSub`            | Total do relatório atual             |
| `#cardDiff`           | `#cardDiffSub`            | Diferença absoluta (com sinal)       |
| `#cardClosedAltered`  | `#cardClosedAlteredSub`   | Qtd de meses fechados alterados      |
| `#cardAnomalies`      | `#cardAnomaliesSub`       | Qtd de anomalias detectadas          |

Valores renderizados com animação `countUp`.

---

**Tabela de Meses (`#monthTableSection`):**

| ID                 | Descrição                              |
|--------------------|----------------------------------------|
| `#monthTable`      | Elemento `<table>`                     |
| `#monthTableBody`  | Tbody com linhas dinâmicas             |

Colunas: Mês | Valor Anterior | Valor Atual | Diferença | Delta % | Status

Badges de status:
- `badge-orange` → "Fechado alterado"
- `badge-blue` → "Corrente"
- `badge-green` → "Íntegro"

---

**Tabela de Holdings (`#holdingTableSection`):**

| ID                  | Descrição                              |
|---------------------|----------------------------------------|
| `#holdingTable`     | Elemento `<table>`                     |
| `#holdingTableBody` | Tbody com linhas dinâmicas             |
| `#holdingRowCount`  | Contador de linhas visíveis            |

Filtros:

| ID              | Tipo     | Filtra por                              |
|-----------------|----------|-----------------------------------------|
| `#filterMonth`  | select   | Mês específico ou "Todos"               |
| `#filterType`   | select   | todos / fechados alterados / corrente   |
| `#filterSearch` | text     | Nome da distribuidora (busca parcial)   |

Colunas: Ícone integração | Distribuidora | Mês | Valor Anterior | Valor Atual | Diferença | Delta % | Status

Classes de linha:

| Classe               | Significado                         |
|----------------------|-------------------------------------|
| `.tr-closed-changed` | Mês fechado com valor alterado      |
| `.tr-current`        | Mês corrente                        |
| `.tr-down`           | Queda de valor                      |
| `.tr-up`             | Alta de valor                       |
| `.tr-alt`            | Alternância de fundo                |

---

**Seção de Anomalias (`#anomalySection`):**

| ID               | Descrição                            |
|------------------|--------------------------------------|
| `#anomalyContent`| Container com os 3 blocos colapsíveis|

Blocos:
- **Desaparecidas** (vermelho) — holdings presentes no anterior e ausentes no atual
- **Novas** (azul) — holdings presentes no atual e ausentes no anterior
- **Meses removidos** (laranja) — meses inteiros que sumiram de uma holding

Cada bloco é gerado por `buildAnomalyBlock()` e é colapsível com header clicável.

---

**Área de Alerta Slack (`#slackArea`):**

- Texto formatado em Markdown compatível com Slack
- Botão "Copiar": copia para clipboard
- `#slackCopied` — feedback "✓ Copiado!" ao copiar
- Inclui: datas, meses alterados, holdings afetadas, anomalias

---

### Aba 2 — Análise de Inatividade

#### Controles Principais

| ID elemento             | Tipo     | Função                                                                      |
|-------------------------|----------|-----------------------------------------------------------------------------|
| `#btnInativ`            | button   | "Carregar do Oracle (d-60)" — dispara `fetchInatividade()`                  |
| `#spinnerInativ`        | svg      | Loader `.oculos-loader` durante fetch                                       |
| `#inativSnapshotBadge`  | span     | Badge cloud no header: `ok` (cloud_done) / `no` (cloud_off) / `saving` (cloud_upload) — atualizado por `setSnapshotBadge()` |
| `#inativSnapshotBadgeText` | span  | Texto do badge de snapshot                                                  |
| `#inativLoadControls`   | div      | Tela inicial com botão "Carregar do Oracle" — ocultada após primeiro fetch  |
| `#inativLoadBar`        | div      | Barra de filtros pós-carga — exibida por `inativShowFilterBar()`            |
| `#inativDias`           | select   | Período: `d60` / `mes_passado` / `mes_atual` / `semana_passada` / `semana_atual` — ao mudar dispara `inativApplyPeriodo()` |
| `#inativFilterPartner`  | text     | Filtro por nome da distribuidora — `oninput: inativApplyFilters()`          |
| `#diaChecksWrap`        | div      | Container dos checkboxes de dia da semana                                   |
| `#inativFilterRisk`     | select   | Filtro de risco: Todos / Alto (> 3 dias) / Médio (2–3 dias) / Baixo (0–1 dia) — `onchange: inativApplyFilters()` |
| `#inativSort`           | select   | Ordenação: desc / asc por qtdDiasSemVenda — `onchange: inativApplyFilters()` |
| `#inativPeriodBadge`    | span     | Badge que exibe intervalo de datas + qtd de ocorrências do período ativo     |
| `#inativHistSelect`     | select   | Dropdown de snapshots históricos do Drive (populado por `loadInativHistList()`) |
| `#btnInativHistLoad`    | button   | Carrega snapshot selecionado via `loadInativSnapshot()`                     |
| `#btnInativExportCsv`   | button   | Exporta dados filtrados como CSV via `exportInativCsv()` — visível após carregar dados |
| `#inativHistCount`      | span     | Badge com contagem de snapshots disponíveis                                 |
| `#inativHistEmpty`      | span     | Mensagem "nenhum snapshot" quando lista vazia                               |
| `#inativHistSpinner`    | svg      | Loader durante download de snapshot                                         |

**Checkboxes de dia da semana (`#diaChecksWrap`):**
- Classe container: `.dia-checks`
- Labels: `.dia-check-label` — adiciona `.checked` quando marcado, `.weekend` em Sáb/Dom
- **Padrão:** Segunda a Sexta marcados; Sábado e Domingo desmarcados
- Valores dos inputs: `Segunda-feira`, `Terca-feira`, `Quarta-feira`, `Quinta-feira`, `Sexta-feira`, `Sabado`, `Domingo`
- Handler: `onDiaCheckChange(cb)` — adiciona/remove classe `.checked` no label e chama `inativApplyFilters()`
- `getSelectedDias()` — retorna array dos valores dos checkboxes marcados

**Comportamento do filtro de dias:**
- Filtra a **tabela** normalmente por dia da semana
- Filtra o **ranking** pelo mesmo critério de dias — mas o ranking **não** é afetado pelos filtros de parceiro/risco
- Ao abrir o modal de detalhe, as datas exibidas respeitam os dias selecionados nos checkboxes

---

#### Ranking de Inatividade

**Container:** `#inativRanking` (oculto até carregar dados)

- **`#inativRankingGrid`** — grid de cards (`.ranking-card`) das distribuidoras
- Padrão: exibe top 8 distribuidoras com maior **total** de dias sem venda
- Score do card = soma de `qtdDiasSemVenda` por distribuidora (todas as linhas/dias)
- Risco do card calculado sobre a **média** por linha: `score / count_linhas_da_distribuidora`
- Cada card exibe: posição `#N`, label "Inconsistência total", nome, score animado, "dias sem venda (total) — ver detalhes"
- Clique no card → `openInativDetail(name)`

**Botão toggle (`#btnRankingToggle`):**
- Texto inicial: "Mostrar todos (N)"
- Ao clicar: `toggleRankingAll()` → mostra todos / volta ao top 8
- Texto após expandir: "Mostrar menos"
- Oculto automaticamente se houver ≤ 8 distribuidoras

**Classes de risco nos cards:**
- `.risk-high` (vermelho) — `.risk-mid` (laranja) — `.risk-low` (verde)

**Lógica de risco (`inativRisk(qtd)`):**
- `qtd > 3` → `'high'`
- `qtd >= 2` → `'mid'`
- `qtd < 2` (0 ou 1) → `'low'`

**Badge de risco (`inativRiskBadge(qtd)`):**
- `high` → `<span class="badge badge-red">🔴 Alto</span>`
- `mid`  → `<span class="badge badge-orange">🟡 Médio</span>`
- `low`  → `<span class="badge badge-green">🟢 Baixo</span>`

---

#### Tabela de Detalhamento (`#inativTableWrap`)

Oculta até carregar dados. Exibida abaixo do ranking.

Colunas: Distribuidora | Dia da Semana | Dias sem Venda | Nível de Risco

| ID               | Descrição                                     |
|------------------|-----------------------------------------------|
| `#inativTableBody` | Tbody com linhas dinâmicas                  |
| `#inativRowCount`  | "Exibindo N de M registros"                 |

Classes de linha por risco:
- `.tr-inativ-high` — fundo vermelho-dim
- `.tr-inativ-mid`  — fundo laranja-dim
- `.tr-inativ-low`  — fundo verde-dim

Ordenação padrão: maior `qtdDiasSemVenda` primeiro; desempate por nome do parceiro e `diaNum`.

---

#### Modal de Detalhe de Inatividade (`#inativModal`)

- Abre via `openInativDetail(name)` ao clicar num card do ranking
- As datas exibidas são filtradas pelos dias selecionados nos checkboxes da tela principal
- Se nenhuma data restante após filtro: exibe mensagem e oculta abas/footer

**Cabeçalho do modal:**
- `#inativModalTitle` — nome da distribuidora
- CNPJ exibido nas mensagens geradas (vem de `inativState.cnpjMap`)

**Abas do modal (`#inativModalTabNav`):**

| ID botão             | Aba ativa | Conteúdo                                                           |
|----------------------|-----------|--------------------------------------------------------------------|
| `#inativTabBtnDias`  | `dias`    | Lista cronológica de datas sem venda (data + dia da semana)        |
| `#inativTabBtnSemana`| `semana`  | Datas agrupadas por dia da semana, com badge de risco por grupo    |

- Aba padrão ao abrir: `dias`
- Troca via `switchInativTab(tab)` → chama `renderInativModalBody()`

**Aba "Por dias":** lista ordenada cronologicamente — cada item exibe `DD/MM/YYYY` + nome do dia da semana.

**Aba "Por semana":** grupos ordenados (Seg → Dom) — header colorido com risco + quantidade; datas como chips.

**Botões no footer (`#inativModalFooter`):**

| Botão                        | Função                                                                |
|------------------------------|-----------------------------------------------------------------------|
| "Mensagem pronta (WhatsApp)" | `copyInativMsg('whatsapp')` — copia mensagem informal                 |
| "Email pronto"               | `copyInativMsg('email')` — copia email formal                         |
| Botão X (header)             | Fecha modal diretamente via `classList.add('hidden')`                 |
| Clique no overlay            | `closeInativModal(e)` — fecha apenas se o target for o overlay        |

**Templates de mensagem (`copyInativMsg`):**

WhatsApp:
```
Bom dia, tudo bem?

Verifiquei aqui no nosso sistema que não recebemos vendas da [Nome] ([CNPJ]) nos dias [DD/MM/YYYY, DD/MM/YYYY, ...] para as Indústrias BIC. Poderia verificar se está correto, por gentileza?
```

Email (subject: `Ausência de Vendas — [Nome] ([CNPJ])`):
```
Bom dia,
Espero que esteja bem.

Durante o acompanhamento rotineiro das integrações, verificamos que a distribuidora [Nome] ([CNPJ]) não apresenta vendas registradas na base de dados da Sellers para as datas a seguir:

DD/MM/YYYY
DD/MM/YYYY
...

Vale destacar que as integrações estão ocorrendo normalmente no período, porém os dados de vendas não estão sendo retornados.
Para evitar impactos nas análises do mês, solicitamos que avaliem a situação e nos retornem com uma posição o mais breve possível.

Ficamos no aguardo do retorno.
```

- Usa `navigator.clipboard.writeText()` com fallback para `execCommand('copy')` via textarea temporária
- CNPJ é omitido da mensagem se não estiver disponível no `cnpjMap`

---

### Modal de Relatório

- Aberto por `#btnReport` → `openReport()`
- Renderiza `buildReportHTML()` em 4 seções:
  1. Resumo executivo
  2. Meses com alterações
  3. Distribuidoras com variação relevante
  4. Top 10 maiores diferenças

- Ao abrir, faz upload silencioso do PDF para pasta de logs: `uploadReportPDF()`

**Botões do modal:**

| Botão         | Função                               |
|---------------|--------------------------------------|
| Download PDF  | `generatePDF()` — baixa PDF local    |
| Fechar        | `closeReport()` / clique no overlay  |

---

### Toast (Notificações)

- **`.toast`** — aparece no canto inferior direito
- Tipos: `.success` (verde), `.error` (vermelho), `.info` (azul)
- Função: `showToast(msg, type, duration)`
- Timer global: `_toastTimer`

---

## Variáveis de Estado Global (JavaScript)

### Estado de Comparação

```javascript
const state = {
  prev: null,       // {rows, filename, dateStr}
  curr: null,       // {rows, filename, dateStr}
  result: null      // resultado da comparação
};
state.holdingRows   // linhas filtráveis da tabela de holdings
```

### Estado de Inatividade

```javascript
var inativState = {
  rows:         [],   // resumo agrupado por partner+diaSemana (período ativo) — [{partner, diaSemana, diaNum, qtdDiasSemVenda}]
  detalhe:      {},   // datas filtradas pelo período (partner → [{data, iso, diaNum}])
  cnpjMap:      {},   // {partner: 'XX.XXX.XXX/XXXX-XX'}
  rawDetalhe:   {},   // dados brutos d-60 do Oracle — nunca filtrado (partner → [{data, iso, diaNum}])
  rawDataInicio: '',  // 'DD/MM/YYYY' — start da janela d-60
  rawDataFim:    '',  // 'DD/MM/YYYY' — end da janela d-60
};

var _rankingAllVisible = false;
var _rankingAll        = [];
var _inativTab         = 'dias';        // aba ativa no modal: 'dias' | 'semana'
var _inativModalContext = null;         // {name, datas, dias, cnpj}
```

### Outras variáveis globais

| Variável      | Uso                              |
|---------------|----------------------------------|
| `_toastTimer` | Timer do toast ativo             |
| `_reportText` | Texto do relatório (cache)       |

---

## Funções JavaScript

### Upload e Processamento de Arquivos

| Função                                     | Descrição                                              |
|--------------------------------------------|--------------------------------------------------------|
| `handleDrag(e, which)`                     | Adiciona classe `drag-over` na dropzone                |
| `handleDragLeave(e, which)`               | Remove classe `drag-over`                              |
| `handleDrop(e, which)`                    | Trata drop e chama `processFile()`                     |
| `handleFile(e, which)`                    | Trata input[type="file"]                               |
| `processFile(file, which)`                | Lê arquivo XLSX/CSV, normaliza, atualiza UI            |
| `normalizeRows(rows)`                     | Detecta colunas dinamicamente, retorna estrutura padrão |
| `normalizeOracleRows(rows)`               | Normaliza dados vindos do Oracle                       |
| `updateUploadUI(which, filename, dateStr, rowCount)` | Atualiza elementos de info do arquivo       |
| `checkBothLoaded()`                       | Habilita botão Compare se ambos os slots preenchidos   |

### Google Drive

| Função                           | Descrição                                             |
|----------------------------------|-------------------------------------------------------|
| `loadDriveFileList()`            | Popula dropdowns com lista de arquivos do Drive       |
| `loadDriveFileIntoSlot(slot, data)` | Carrega arquivo base64 em slot prev/curr           |
| `fetchLatestFromDrive(slot)`     | GET `/ultimo-arquivo` e carrega no slot               |
| `fetchFromDriveById(slot)`       | Idem, com fileId do dropdown                          |
| `uploadFileToDrive(file)`        | POST `/upload-drive` com FormData                     |

### Oracle

| Função            | Descrição                                                      |
|-------------------|----------------------------------------------------------------|
| `fetchFromOracle()` | GET `/dados-atual`, normaliza dados, salva no Drive (async) |

### Comparação

| Função                          | Descrição                                                    |
|---------------------------------|--------------------------------------------------------------|
| `runComparison()`               | Chama `doComparison()` e renderiza resultados                |
| `doComparison()`                | Lógica central: agrupa, calcula deltas, detecta anomalias    |
| `aggregateByHoldingMonth(rows)` | Agrupa dados por holding e mês                               |
| `aggregateByMonth(rows)`        | Calcula totais mensais                                       |
| `getHoldings(rows)`             | Retorna lista de holdings únicos                             |
| `getMonthsForHolding(holding, rows)` | Retorna meses de uma holding específica                |

### Renderização

| Função                          | Descrição                                                    |
|---------------------------------|--------------------------------------------------------------|
| `renderResults(result)`         | Renderiza cards, tabelas e anomalias                         |
| `applyFilters()`                | Filtra tabela de holdings por mês/tipo/nome                  |
| `renderHoldingTable(rows)`      | Popula `holdingTableBody` com TR dinâmicas                   |
| `renderAnomalies()`             | Renderiza 3 blocos de anomalias                              |
| `buildAnomalyBlock(...)`        | Cria bloco colapsível de anomalia                            |

### Formatação

| Função             | Exemplo de saída                 |
|--------------------|----------------------------------|
| `fmtBRL(value)`    | `R$ 1.234,56`                    |
| `fmtBRLSigned(v)`  | `+R$ 100,00` / `-R$ 50,00`       |
| `fmtPct(value)`    | `+12,50%` / `-5,30%`             |
| `fmtMonth(anoMes)` | `"Jan/2024"` (de `"2024-01"`)    |
| `deltaClass(diff)` | `delta-pos` / `delta-neg` / `delta-zero` |
| `esc(s)`           | Escapa `&`, `<`, `>`, `"` (XSS) |

### Utilitários

| Função                              | Descrição                                        |
|-------------------------------------|--------------------------------------------------|
| `cap(s)`                            | Capitaliza primeira letra                        |
| `extractDateFromFilename(name)`     | Extrai data do nome (formato DD-MM-YYYY)         |
| `countUp(el, target, format, dur)`  | Animação de contagem para os cards               |
| `tick()`                            | Atualiza frame da animação countUp               |
| `showToast(msg, type, duration)`    | Exibe notificação (success/error/info)           |

### Relatório PDF

| Função              | Descrição                                                       |
|---------------------|-----------------------------------------------------------------|
| `openReport()`      | Abre modal, chama `buildReportHTML()`, faz upload PDF silencioso |
| `downloadReport()`  | Gera PDF e baixa localmente                                     |
| `generatePDFDoc()`  | Cria objeto jsPDF com cores, tabelas e formatação               |
| `generatePDFBlob()` | Retorna PDF como Blob                                           |
| `generatePDF()`     | Baixa PDF com nome `relatorio_bic_DD-MM-YYYY.pdf`               |
| `buildReportHTML()` | Gera HTML para exibição no modal (4 seções)                     |
| `buildReportData()` | Calcula: varPct, closedAltered, quedas/altas, top10             |
| `buildReportText()` | Texto puro formatado para Slack                                 |
| `uploadReportPDF()` | POST `/upload-log` silenciosamente ao abrir modal               |
| `closeReport()`     | Fecha modal de relatório                                        |

### Slack Alert

| Função              | Descrição                                                  |
|---------------------|------------------------------------------------------------|
| `copySlackAlert()`  | Monta e copia para clipboard texto Markdown Slack          |

### Inatividade

| Função                          | Descrição                                                                                     |
|---------------------------------|-----------------------------------------------------------------------------------------------|
| `fetchInatividade()`            | Verifica snapshot do dia → busca Oracle (d-60 sem param) → salva `rawDetalhe` → chama `inativApplyPeriodo()` → agenda `loadInativHistList()` |
| `inativApplyPeriodo()`          | Filtra `rawDetalhe` pela janela do período selecionado → recalcula `rows` e `detalhe` → atualiza badge e `inativApplyFilters()` |
| `periodoLabel(periodo, inicio, fim)` | Retorna string de label do período para o badge (`DD/MM → DD/MM · N ocorrências`)      |
| `inativShowFilterBar()`         | Oculta `#inativLoadControls`, exibe `#inativLoadBar`                                         |
| `setSnapshotBadge(status, text)`| Atualiza `#inativSnapshotBadge` — status: `ok` / `no` / `saving`                            |
| `loadInativHistList()`          | GET `/listar-inatividade` → popula `#inativHistSelect` → atualiza badge de snapshot do dia   |
| `loadInativSnapshot()`          | GET `/get-inatividade?fileId=` → lê abas Detalhe+Meta do XLSX → popula `rawDetalhe` → chama `inativApplyPeriodo()` |
| `exportInativCsv()`             | Exporta `inativState.rows` filtrado como CSV (respeita filtros partner/dias/risco ativos)    |
| `inativRisk(qtd)`               | `> 3 → 'high'`, `>= 2 → 'mid'`, `< 2 → 'low'`                                               |
| `inativRiskBadge(qtd)`          | Retorna HTML do badge colorido (🔴 Alto / 🟡 Médio / 🟢 Baixo)                               |
| `inativDiaLabel(d)`             | Corrige acentos: `'Terca-feira'→'Terça-feira'`, `'Sabado'→'Sábado'`                          |
| `renderInativRanking(rows)`     | Calcula totais, ordena desc, renderiza top 8, atualiza toggle                                 |
| `renderRankingCards(allRows, entries)` | Popula `#inativRankingGrid` com cards de risco animados                               |
| `toggleRankingAll()`            | Alterna `_rankingAllVisible`                                                                  |
| `openInativDetail(name)`        | Filtra datas por dias selecionados, popula `_inativModalContext`, abre `#inativModal`         |
| `switchInativTab(tab)`          | Alterna abas do modal de detalhe                                                              |
| `renderInativModalBody()`       | Renderiza conteúdo das abas `dias` / `semana`                                                 |
| `copyInativMsg(tipo)`           | Gera mensagem WhatsApp ou Email com datas e CNPJ                                              |
| `closeInativModal(e)`           | Fecha `#inativModal` pelo overlay                                                             |
| `getSelectedDias()`             | Retorna array de checkboxes marcados                                                          |
| `onDiaCheckChange(cb)`          | Handler dos checkboxes de dia                                                                 |
| `inativApplyFilters()`          | Aplica filtros: partner, dias, risco; ordena; atualiza tabela e ranking                       |

### Reset

| Função       | Descrição                                   |
|--------------|---------------------------------------------|
| `resetAll()` | Limpa state, reseta UI, esconde resultados  |

---

## Design System (CSS)

### Variáveis de Cor

```css
/* Backgrounds */
--bg:     #0f1117
--bg2:    #161a24
--bg3:    #1e2334
--bg4:    #252b3d

/* Textos */
--text:   #e8eaf0
--text2:  #9ca3b8
--text3:  #6b7394

/* Brand */
--accent: #4f8ef7
/* purple: #7b5bf7 (gradientes) */

/* Semânticas */
--red:    #e05252
--orange: #e0943a
--green:  #4caf7d
--blue:   #4f8ef7

/* Linhas de tabela */
--row-closed-changed, --row-down, --row-up, --row-current
```

### Classes de Componentes

**Botões:** `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-oracle`, `.btn-drive`, `.btn-report`, `.btn-reset`

**Cards:** `.card`, `.card-label`, `.card-value` + modificadores `.red`, `.orange`, `.green`, `.blue`, `.neutral`

**Badges:** `.badge-red`, `.badge-orange`, `.badge-green`, `.badge-blue`, `.badge-gray`

**Tags:** `.tag-red`, `.tag-orange`, `.tag-green`, `.tag-blue`

**Tabelas:** `thead th` → `--bg3`, `tbody tr:hover` → `--bg4`, `.tr-alt`, `.tr-closed-changed`, `.tr-current`, `.tr-down`, `.tr-up`

**Anomalias:** `.anomaly-block`, `.anomaly-item.disappeared` / `.new` / `.removed-month`

**Inatividade:** `.ranking-grid`, `.ranking-card`, `.risk-high`, `.risk-mid`, `.risk-low`, `.dia-checks`, `.dia-check-label.checked`, `.dia-check-label.weekend`

**Modal:** `.modal-overlay`, `.modal`, `.modal-tab-nav`, `.modal-tab-btn`

**Toast:** `.toast.show`, `.toast.success`, `.toast.error`, `.toast.info`

**Loading:** `.oculos-loader` (SVG animado)

---

## `integracoes.js` — Mapeamento de Integrações

```javascript
"A L F DA ROCHA COMERCIO LTDA - 794644": "sellers",
"BAHIA DIGITAL LTDA - 227315": "ftp",
// ...70+ entradas
```

**Tipos:** `sellers`, `ftp`, `temp`

---

## Fluxos de Uso

### Fluxo Principal — Comparação de Relatórios

```
1. Carregar arquivo anterior (upload local, Drive ou Oracle)
2. Carregar arquivo atual   (upload local, Drive ou Oracle)
3. Clicar "Comparar"
4. Sistema agrupa por holding/mês, calcula deltas, detecta anomalias
5. Resultados: 5 cards + tabela meses + tabela holdings + anomalias
6. Opcional: copiar alerta Slack ou abrir modal de relatório PDF
```

### Fluxo — Análise de Inatividade

```
1. Navegar para aba "Análise de Inatividade"
2. Clicar "Carregar do Oracle (d-60)"
3. Frontend verifica snapshot do dia em /listar-inatividade
   - Se sim: confirm() pergunta se quer atualizar; cancelar aborta
   - Se não: prossegue direto
4. Frontend chama GET /analise-inatividade (sem param de período)
5. Backend consulta Oracle (janela d-60), responde os dados brutos e salva XLSX no Drive em background
6. Frontend salva rawDetalhe e aplica período padrão (d60 = tudo)
7. Ranking top 8 + filtros + tabela exibidos
8. Após 4 s: loadInativHistList() atualiza badge de snapshot e o select de histórico
9. Usuário pode trocar período no select (mes_atual, etc.) → inativApplyPeriodo() filtra no frontend sem nova requisição Oracle
10. Carregar snapshot histórico: selecionar no dropdown → btnInativHistLoad → renderiza na UI igual ao Oracle
11. Exportar CSV: btnInativExportCsv exporta estado atual filtrado
```

---

## Integração Oracle Database

- **Modo:** Thin (sem Oracle Client)
- **TLS:** Sem wallet
- **Tabela principal:** `sellers.bic_vendas_PARCEIRO`
- **Campos:** `HOLDING`, `PARTNER_NAME`, `VENDA_DATA`, `VENDA_VALOR`, `CNPJ_CUSTOMER`

---

## Integração Google Drive

- **Auth:** Service Account
- **Scopes:** `https://www.googleapis.com/auth/drive`
- **Pastas:**
  - `GOOGLE_DRIVE_FOLDER_ID` — histórico de relatórios Excel
  - `GOOGLE_DRIVE_LOG_FOLDER_ID` — PDFs de auditoria
  - `GOOGLE_DRIVE_INATIV_FOLDER_ID` — ✅ NOVO: histórico XLSX de inatividade (janela 60 dias)

---

## Normalização de Dados

| Campo interno | Colunas aceitas                         |
|---------------|-----------------------------------------|
| `holding`     | HOLDING, Holding, holding               |
| `customer`    | PARTNER_NAME, customer, Customer, etc.  |
| `anoMes`      | ANOMES, anomes, AnoMes, etc.            |
| `vendaValor`  | VENDA_VALOR, valor, Valor, VALOR, etc.  |

---

## Lógicas de Negócio Especiais

- **Meses fechados alterados:** detectados quando o mês não é o corrente
- **Anomalias:** desaparecidas / novas / meses removidos
- **Deduplicação no Drive:** sufixo `_1`, `_2` para mesmo nome de arquivo
- **Fuso horário:** `America/Sao_Paulo` para nomes de arquivo
- **Upload automático:** snapshot Oracle → Drive em background
- **Janela fixa d-60:** backend consulta sempre `TRUNC(SYSDATE)-60 → TRUNC(SYSDATE)` — sem parâmetro de período
- **Filtragem de período no frontend:** `inativApplyPeriodo()` recorta `rawDetalhe` para qualquer janela (mes_atual, semana_passada, etc.) sem nova chamada Oracle
- **Save no backend:** `saveInativToDrive()` chamado assincronamente após `/analise-inatividade` — frontend não faz upload de XLSX
- **Snapshot histórico navegável:** select `#inativHistSelect` permite carregar qualquer snapshot do Drive e renderizar na mesma UI via `loadInativSnapshot()`
- **Export CSV:** `exportInativCsv()` exporta o estado filtrado ativo

---

## Considerações Técnicas

### Limitações Conhecidas
- Multer usa `memoryStorage` — adequado para arquivos < ~50MB
- Drive list com `pageSize: 1000`
- PDF gerado no navegador (sem server-side rendering)
- XLSX parsing síncrono no navegador — pode travar em arquivos grandes

### Segurança
- SQL preparado via `oracledb` (sem SQL injection)
- XSS protegido via `esc()`
- CORS habilitado — verificar origem em produção
- `service-account.json` e `.env` não commitados

### Performance
- XLSX parsing síncrono pode travar em arquivos grandes
- Query de inatividade com CTEs pode ser lenta em datasets grandes
- Toast sem fila — um toast de cada vez

---

## 💡 Ideias Futuras

### Prioritárias (baixo esforço, alto valor)
- **Toast de confirmação pós-save** — após confirmar que o XLSX apareceu no Drive (badge ficou `ok`), exibir `showToast('✓ Snapshot salvo no Drive', 'success')`

### Médio prazo
- **Análise de tendência histórica** — no outro projeto, consumir os arquivos do Drive para responder "qual distribuidora teve mais dias inativos nos últimos 3 meses?" com séries temporais
- **Detecção de padrão recorrente** — cruzar o histórico para identificar distribuidoras que repetem inatividade sempre na mesma semana/dia (ex.: sempre às sextas)
- **Alerta proativo por Slack** — ao salvar o snapshot, se alguma distribuidora tiver risco Alto por N dias consecutivos no histórico, disparar mensagem automática no Slack
- **Export CSV do histórico filtrado** — botão na aba de inatividade para baixar o histórico de 60 dias já filtrado pelos critérios ativos (parceiro, dia, risco)

### Longo prazo
- **Dashboard histórico** — página separada com gráfico de linha (dias sem venda por mês por distribuidora) construída sobre os arquivos acumulados no Drive
- **Comparação de períodos** — "mês atual vs mês passado" na análise de inatividade, igual ao que o monitoramento já faz com os relatórios de vendas
