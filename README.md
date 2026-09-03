# Distributed Wagering Processor

Serviço financeiro distribuído para iGaming, desenvolvido para o desafio técnico da Jungle Gaming. A implementação prioriza correção monetária, concorrência por carteira, idempotência persistente, ledger auditável e mensageria resiliente.

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime, package manager e testes | Bun 1.x |
| Linguagem | TypeScript strict |
| Framework | NestJS 10 |
| ORM | MikroORM 6 |
| Banco | PostgreSQL 16 |
| Mensageria | AWS SQS via LocalStack |
| Identidade | Zitadel como extensão OIDC opcional |

## Pré-requisitos

- Bun 1.x
- Docker Desktop com Compose v2
- Portas livres `3000`, `5432`, `4566` e `8080`

## Quickstart

### 1. Instalar dependências

```powershell
bun install
Copy-Item .env.example .env
```

No Linux/macOS:

```bash
bun install
cp .env.example .env
```

### 2. Subir a infraestrutura

```bash
docker compose up -d
docker ps
```

Aguarde `wagering-postgres` e `wagering-localstack` com status `healthy`. O `wagering-zitadel` é um ponto de extensão opcional para autenticação OIDC.

### 3. Aplicar a migration

Execute uma vez, depois que o PostgreSQL estiver saudável.

Windows PowerShell:

```powershell
Get-Content src/infrastructure/database/migrations/001_initial_schema.sql | docker exec -i wagering-postgres psql -U postgres -d wagering_db
```

Linux/macOS:

```bash
docker exec -i wagering-postgres psql -U postgres -d wagering_db < src/infrastructure/database/migrations/001_initial_schema.sql
```

A migration aplica `BIGINT` para centavos, `CHECK (balance >= 0)`, unicidade de wallet por `(player_id, currency)`, unicidade de transação por `(provider_id, external_transaction_id)`, constraints aritméticas do ledger e trigger contra `UPDATE`/`DELETE` no ledger.

### 4. Iniciar a API

```bash
bun run start
```

Endpoints locais:

- Swagger: http://localhost:3000/docs
- Liveness: http://localhost:3000/health/live
- Readiness: http://localhost:3000/health/ready
- Métricas: http://localhost:3000/metrics

Se aparecer `EADDRINUSE`, encerre a instância anterior do Bun ou libere a porta `3000` antes de executar novamente.

## Build e testes

```bash
# Compilação sem gerar testes em dist/
bun run build

# Suíte completa: domínio, integração, interface e concorrência
bun test

# Domínio e regras financeiras
bun test tests/domain

# Hash canônico
bun test tests/common

# PostgreSQL + LocalStack
bun test tests/integration

# Concorrência real com banco e pool de conexões
bun test tests/concurrency
```

A suíte validada localmente contém 34 testes e cobre:

- `Money`, `Wallet`, máquina de estados e regras `BET/WIN/LOSS/REFUND/ROLLBACK`;
- disputa de duas apostas de `80.00` sobre saldo `100.00`;
- rajada de 50 requisições com a mesma idempotency key;
- Outbox, SQS e Inbox;
- reconciliação entre saldo materializado e ledger.

O script `bun run build` usa `tsc` diretamente e exclui `tests/`, evitando que o Bun execute cópias compiladas dos testes.

## Smoke tests HTTP

### Health

```bash
curl -s http://localhost:3000/health/live
curl -s http://localhost:3000/health/ready
```

### Criar carteira

Use um `playerId` novo para cada execução, pois existe uma wallet por jogador e moeda.

```bash
curl -s -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "jogador-smoke-001",
    "initialBalance": { "amount": "100.00", "currency": "BRL" }
  }'
```

Copie o campo `id` retornado e defina-o como `WALLET_ID`.

PowerShell:

```powershell
$walletId = "COLE_O_ID_DA_CARTEIRA"
$playerId = "jogador-smoke-001"
```

### Submeter uma aposta

```bash
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-smoke:tx-001" \
  -d '{
    "providerId": "provider-smoke",
    "externalTransactionId": "tx-001",
    "playerId": "jogador-smoke-001",
    "walletId": "WALLET_ID",
    "roundId": "round-smoke-001",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "30.00", "currency": "BRL" }
  }'
```

A resposta esperada é `200`, com status `PROCESSED`, saldo `70.00` e `idempotentReplay: false`. Repetir a mesma chamada deve retornar a resposta original com `idempotentReplay: true`.

### Consultar ledger e reconciliação

```bash
curl -s "http://localhost:3000/wallets/WALLET_ID/ledger?limit=50"
curl -s -X POST http://localhost:3000/wallets/WALLET_ID/reconciliation
```

A reconciliação deve retornar `consistent: true`, saldo armazenado `70.00`, saldo calculado `70.00` e dois lançamentos: abertura `CREDIT` e aposta `DEBIT`.

## Autenticação

A Seção 2 do desafio não pontua autenticação. O comportamento padrão local usa `NoopAuthGuard`, deixando o motor testável sem depender de token.

Existe uma extensão `JwtAuthGuard` baseada em JWKS RS256 e configuração Zitadel no Compose. Para ativá-la em um ambiente real, substitua o guard nos controllers, configure `IDP_ISSUER`/`IDP_JWKS_URI` e gere credenciais na mesma instância Zitadel. Credenciais de outra instância retornam `invalid_client`.

## Organização

```text
src/domain/           regras puras, Money, Wallet, ledger e WagerRuleEngine
src/application/      use cases e workers
src/infrastructure/   entidades MikroORM, migration, SQS e Outbox
src/interface/http/   controllers e DTOs
tests/                 domínio, integração, interface e concorrência
```

As decisões, invariantes, trade-offs e limitações estão em [`ARCHITECTURE.md`](./ARCHITECTURE.md).
