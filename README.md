# Distributed Wagering Processor 🦧

Motor financeiro distribuído de alta disponibilidade e consistência estrita para plataformas de iGaming, construído com **NestJS**, **Bun 1.x**, **PostgreSQL** e **AWS SQS (LocalStack)**.

O sistema processa transações de apostas com correção monetária de ponto fixo, isolamento concorrente por carteira via locks pessimistas, livro-razão (*ledger*) puramente cumulativo (*append-only*), idempotência persistente e mensageria tolerante a falhas baseada nos padrões **Transactional Outbox** e **Inbox Pattern**.

---

## 1. Pré-requisitos

- **Bun:** `v1.1.x` ou superior instalado localmente.
- **Docker & Docker Compose:** Docker `v24+` e Compose `v2+`.
- **Git:** Para clonagem e versionamento.

---

## 2. Instruções de Setup Local

### Passo 1: Clonar o Repositório e Instalar Dependências

```bash
git clone [https://github.com/SEU_USUARIO/distributed-wagering-processor.git](https://github.com/SEU_USUARIO/distributed-wagering-processor.git)
cd distributed-wagering-processor
bun install
```

### Passo 2: Configurar Variáveis de Ambiente

Copie o arquivo de exemplo para o ambiente de desenvolvimento:

```bash
cp .env.example .env
```

### Passo 3: Inicializar a Infraestrutura em Containers

Suba os serviços locais (PostgreSQL e LocalStack SQS):

```bash
docker compose up -d
```

Verifique a saúde dos serviços:

```bash
docker ps
```

Aguarde até que os contêineres `wagering-postgres` e `wagering-localstack` estejam com status `healthy`.

### Passo 4: Executar as Migrations do Banco de Dados

Aplique o schema relacional, constraints e triggers no PostgreSQL:

#### Windows (PowerShell)

```powershell
Get-Content infra/database/migrations/001_initial_schema.sql | docker exec -i wagering-postgres psql -U postgres -d wagering_db
```

#### Linux/macOS (Bash)

```bash
docker exec -i wagering-postgres psql -U postgres -d wagering_db < infra/database/migrations/001_initial_schema.sql
```

### Passo 5: Iniciar a Aplicação

```bash
bun run start
```

A API inicializará na porta 3000.

## 3. Guia de Execução de Testes

Todas as suítes de testes foram projetadas para validar desde o modelo de domínio isolado até concorrência com instâncias reais de containers (sem mocks de banco ou mensageria).

### Testes Unitários de Domínio

Valida o Value Object Money, Aggregate Root Wallet, máquina de estados de WagerTransaction e equações contábeis do WalletLedgerEntry:

```bash
bun test tests/domain/
```

### Testes de Integração Real (PostgreSQL + SQS LocalStack)

Testa a atomicidade do ciclo Outbox $\rightarrow$ SQS FIFO $\rightarrow$ Inbox deduplicado:

```bash
bun test tests/integration/outbox-sqs-inbox.integration.spec.ts
```

### Testes de Concorrência Extrema (Stress & Race Conditions)

Executa rajadas concorrentes reais (Promise.all) contra o PostgreSQL:

- Disputa de Saldo: 2 apostas simultâneas de R$ 80 contra saldo inicial de R$ 100.
- Burst Idempotente: 50 requisições simultâneas com a mesma Idempotency-Key.

```bash
bun test tests/concurrency/
```

### Teste de Carga Diferencial (Throughput & Latência)

Executa rajadas de alto volume medindo percentis P50, P95 e P99:

```bash
bun run test:load
```

## 4. Endpoints Principais da API

### Carteiras (`/wallets`)

#### Criar Carteira: `POST /wallets`

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

Retorno (201 Created):

```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "100.00", "currency": "BRL" },
  "version": 1
}
```

#### Consultar Carteira: `GET /wallets/:walletId`

#### Extrato Contábil com Paginação por Cursor

`GET /wallets/:walletId/ledger?limit=50&cursor=...`

#### Auditoria e Reconciliação Matemática

`POST /wallets/:walletId/reconciliation`

### Apostas e Liquidação (`/wagering`)

#### Submeter Transação Financeira: `POST /wagering/transactions`

Header Obrigatório: `Idempotency-Key: provider-a:tx-1001`

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "tx-1001",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-tiger",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

Retorno (200 OK):

```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "balance": { "amount": "75.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

#### Consultar Transação: `GET /wagering/transactions/:transactionId`

## Observabilidade e Telemetria

- **Liveness Probe:** `GET /health/live` (Retorna 200 OK se o processo estiver ativo).
- **Readiness Probe:** `GET /health/ready` (Valida conectividade real com PostgreSQL e SQS; retorna 503 se degradado).
- **Métricas Prometheus:** `GET /metrics` (Exposição de contadores, gauges e histogramas em tempo real).
