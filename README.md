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

Windows PowerShell:

```powershell
bun install
Copy-Item .env.example .env
```

Linux/macOS:

```bash
bun install
cp .env.example .env
```

### 2. Subir a infraestrutura

```bash
docker compose up -d
docker ps
```

Aguarde `wagering-postgres` e `wagering-localstack` ficarem com status `healthy`. O `wagering-zitadel` é um ponto de extensão opcional para autenticação OIDC.

### 3. Aplicar a migration

Execute uma vez, assim que o PostgreSQL estiver saudável.

Windows PowerShell:

```powershell
Get-Content src/infrastructure/database/migrations/001_initial_schema.sql | docker exec -i wagering-postgres psql -U postgres -d wagering_db
```

Linux/macOS:

```bash
docker exec -i wagering-postgres psql -U postgres -d wagering_db < src/infrastructure/database/migrations/001_initial_schema.sql
```

A migration aplica `BIGINT` para centavos, `CHECK (balance >= 0)`, unicidade de carteira por `(player_id, currency)`, unicidade de transação por `(provider_id, external_transaction_id)`, constraints aritméticas do ledger e trigger contra `UPDATE`/`DELETE` no ledger.

### 4. Iniciar a API

```bash
bun run start
```

Endpoints locais:

- Swagger UI: http://localhost:3000/docs
- Liveness: http://localhost:3000/health/live
- Readiness: http://localhost:3000/health/ready
- Métricas: http://localhost:3000/metrics

Se aparecer o erro `EADDRINUSE`, encerre instâncias anteriores do Bun ou libere a porta `3000` antes de executar novamente:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen
Stop-Process -Id <PID> -Force
```

## Build e testes

```bash
# Compilação limpa sem gerar testes em dist/
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

A suíte cobre:

- Value Object `Money`, Aggregate Root `Wallet`, máquina de estados e regras `BET/WIN/LOSS/REFUND/ROLLBACK`;
- disputa concorrente de duas apostas de `80.00` sobre saldo inicial de `100.00`;
- rajada concorrente de 50 requisições com a mesma `Idempotency-Key`;
- padrões Transactional Outbox, AWS SQS e Inbox Deduplication;
- reconciliação matemática entre o saldo materializado da carteira e os lançamentos do ledger.

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

Copie o campo `id` retornado e substitua `WALLET_ID` nos comandos seguintes.

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

### Criar carteira e apostar no Windows PowerShell

```powershell
$playerId = "player-smoke-" + (Get-Date -Format "yyyyMMddHHmmss")
$createBody = @{
    playerId = $playerId
    initialBalance = @{
        amount = "100.00"
        currency = "BRL"
    }
} | ConvertTo-Json

$wallet = Invoke-RestMethod `
    -Uri "http://localhost:3000/wallets" `
    -Method Post `
    -ContentType "application/json" `
    -Body $createBody

$walletId = $wallet.id
$txId = "tx-" + (Get-Date -Format "yyyyMMddHHmmss")
$betBody = @{
    providerId = "provider-smoke"
    externalTransactionId = $txId
    playerId = $playerId
    walletId = $walletId
    roundId = "round-smoke-001"
    gameId = "fortune-chimp"
    kind = "BET"
    money = @{
        amount = "30.00"
        currency = "BRL"
    }
} | ConvertTo-Json
$headers = @{ "Idempotency-Key" = "provider-smoke:$txId" }

Invoke-RestMethod `
    -Uri "http://localhost:3000/wagering/transactions" `
    -Method Post `
    -Headers $headers `
    -ContentType "application/json" `
    -Body $betBody | Format-List
```

### Reconciliação e ledger

```bash
curl -s "http://localhost:3000/wallets/WALLET_ID/ledger?limit=50"
curl -s -X POST http://localhost:3000/wallets/WALLET_ID/reconciliation
```

A reconciliação deve retornar `consistent: true`, saldo armazenado `70.00`, saldo calculado `70.00` e dois lançamentos: abertura `CREDIT` e aposta `DEBIT`. A aposta rejeitada por saldo insuficiente não gera lançamento.

### Testar saldo insuficiente no PowerShell

```powershell
$excessId = "tx-excess-" + (Get-Date -Format "yyyyMMddHHmmss")
$excessBody = @{
    providerId = "provider-smoke"
    externalTransactionId = $excessId
    playerId = $playerId
    walletId = $walletId
    roundId = "round-smoke-002"
    gameId = "fortune-chimp"
    kind = "BET"
    money = @{
        amount = "80.00"
        currency = "BRL"
    }
} | ConvertTo-Json
$excessHeaders = @{ "Idempotency-Key" = "provider-smoke:$excessId" }

try {
    Invoke-RestMethod `
        -Uri "http://localhost:3000/wagering/transactions" `
        -Method Post `
        -Headers $excessHeaders `
        -ContentType "application/json" `
        -Body $excessBody
} catch {
    $_.ErrorDetails.Message
}
```

O resultado esperado é HTTP `422`, status `REJECTED` e saldo preservado em `70.00`.

## Autenticação

A Seção 2 do desafio técnico não pontua autenticação. O comportamento padrão usa `NoopAuthGuard`, permitindo testes locais e uso do Swagger sem token prévio.

Para extensibilidade, o projeto inclui `JwtAuthGuard` baseado em JWKS RS256 e uma instância Zitadel no Compose. Para usar autenticação real, ative o guard nos controllers, configure `IDP_ISSUER` e `IDP_JWKS_URI` e gere credenciais na mesma instância Zitadel. Credenciais de outra instalação retornam `invalid_client`.

## Organização do código

```text
src/domain/           Regras puras, Money, Wallet, Ledger e WagerRuleEngine
src/application/      Casos de uso e background workers
src/infrastructure/   Entidades MikroORM, migrations, SQS e Outbox
src/interface/http/   Controllers REST, DTOs e interceptores
tests/                 Suítes de domínio, integração, interface e concorrência
```

O detalhamento das decisões arquiteturais, invariantes financeiras, trade-offs e limitações está em [`ARCHITECTURE.md`](./ARCHITECTURE.md).
