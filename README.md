# BIC Portal — Sellout

Portal de visualização de dados de sellout dos distribuidores BIC.

## Stack
- Backend: Node.js + Express
- Frontend: HTML + CSS + JS vanilla (SPA)
- Fonte de dados: Google Drive (service account)

## Setup

### 1. Instalar dependências
```bash
cd backend
npm install
```

### 2. Configurar variáveis de ambiente
```bash
cp .env.example .env
# Edite .env com seus valores
```

### 3. Credenciais Google
Coloque o arquivo `service-account.json` em `backend/credentials/`.

### 4. Rodar
```bash
cd backend
npm start
# Acesse http://localhost:3000
```

## Estrutura
```
bic_system/
├── frontend/
│   └── index.html
├── backend/
│   ├── server.js
│   ├── package.json
│   ├── .env
│   ├── .env.example
│   └── credentials/
│       └── service-account.json  (não commitar)
└── README.md
```

## Variáveis de ambiente
| Variável | Descrição |
|---|---|
| `PORT` | Porta do servidor (padrão: 3000) |
| `GOOGLE_DRIVE_FOLDER_ID` | ID da pasta do Drive com os Excel |
| `GOOGLE_SERVICE_ACCOUNT_PATH` | Caminho para o JSON da service account |

## Padrão de arquivos Excel
`relatorio_DD-MM-YYYY.xlsx`

Colunas esperadas: `HOLDING`, `PARTNER_NAME`, `ANOMES`, `VENDA_VALOR`, `CNPJ_CUSTOMER`
