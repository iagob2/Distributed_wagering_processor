# Distributed Wagering Processor

Serviço financeiro distribuído para iGaming, desenvolvido para o desafio técnico da Jungle Gaming. A implementação prioriza correção monetária, concorrência por carteira, idempotência persistente, ledger auditável e mensageria resiliente.

---

## Sumário

- [Stack](#stack)
- [Pré-requisitos](#pré-requisitos)
- [Quickstart](#quickstart)
- [Build e Testes](#build-e-testes)
- [Teste de Carga](#teste-de-carga)
- [Smoke Tests HTTP](#smoke-tests-http)
- [Autenticação](#autenticação)
- [Organização do Código](#organização-do-código)
- [Decisões Arquiteturais](#decisões-arquiteturais)

---

## Stack

| Camada                             | Tecnologia                    |
|------------------------------------|-------------------------------|
| Runtime, package manager e testes  | Bun 1.x                       |
| Linguagem                          | TypeScript strict              |
| Framework                          | NestJS 10                     |
| ORM                                | MikroORM 6                    |
| Banco                              | PostgreSQL 16                 |
| Mensageria                         | AWS SQS via LocalStack        |
| Identidade                         | Zitadel (extensão OIDC opcional) |

---

## Pré-requisitos

- Bun 1.x
- Docker Desktop com Compose v2
- Portas livres: `3000`, `5432`, `4566` e `8080`

---

## Quickstart

### 1. Instalar dependências

**Windows PowerShell:**
```powershell
bun install
Copy-Item .env.example .env
```

**Linux/macOS:**
```bash
bun install
cp .env.example .env
```

---

### 2. Subir a infraestrutura

```bash
docker compose up -d
docker ps
```

Aguarde os containers `wagering-postgres` e `wagering-localstack` ficarem com status `healthy`.

> O container `wagering-zitadel` é um ponto de extensão opcional para autenticação OIDC.

---

### 3. Aplicar a migration

Execute **uma vez**, assim que o PostgreSQL estiver saudável.

**Windows PowerShell:**
```powershell
Get-Content src/infrastructure/database/migrations/001_initial_schema.sql | docker exec -i wagering-postgres psql -U postgres -d wagering_db
```

**Linux/macOS:**
```bash
docker exec -i wagering-postgres psql -U postgres -d wagering_db < src/infrastructure/database/migrations/001_initial_schema.sql
```

A migration aplica:

- `BIGINT` para centavos
- `CHECK (balance >= 0)`
- Unicidade de carteira por `(player_id, currency)`
- Unicidade de transação por `(provider_id, external_transaction_id)`
- Constraints aritméticas do ledger
- Trigger contra `UPDATE`/`DELETE` no ledger

---

### 4. Iniciar a API

```bash
bun run start
```

Endpoints locais:

| Recurso        | URL                                      |
|----------------|------------------------------------------|
| Swagger UI     | http://localhost:3000/docs               |
| Liveness       | http://localhost:3000/health/live        |
| Readiness      | http://localhost:3000/health/ready       |
| Métricas       | http://localhost:3000/metrics            |

> **Porta em uso?** Se aparecer `EADDRINUSE`, encerre instâncias anteriores do Bun ou libere a porta 3000:
> ```powershell
> Get-NetTCPConnection -LocalPort 3000 -State Listen
> Stop-Process -Id <PID> -Force
> ```

---

## Build e Testes

### Compilação

Compilação limpa sem gerar testes em `dist/`:

```bash
bun run build
```

> O script usa `tsc` diretamente e exclui `tests/`, evitando que o Bun execute cópias compiladas dos testes.

---

### Suíte completa

Executa domínio, integração, interface e concorrência:

```bash
bun test
```

---

### Suítes individuais

| Escopo                                                | Comando                                                                      |
|-------------------------------------------------------|------------------------------------------------------------------------------|
| Domínio e regras financeiras                          | `bun test tests/domain`                                                      |
| Hash canônico                                         | `bun test tests/common`                                                      |
| PostgreSQL + LocalStack                               | `bun test tests/integration`                                                 |
| Concorrência real com banco e pool de conexões        | `bun test tests/concurrency`                                                 |
| Três workers independentes e crash recovery após commit sem ACK | `bun test tests/concurrency/multi-instance-concurrency.spec.ts`  |
| Três processos Bun reais, cada um com seu próprio ORM e pool | `bun test tests/concurrency/multi-process-os.spec.ts`             |
| Crash recovery usando o consumer oficial e redelivery do SQS | `bun test tests/integration/crash-recovery-ack.spec.ts`            |
| Conflito de lock nativo do PostgreSQL (55P03/NOWAIT)  | `bun test tests/integration/lock-conflict-55p03.spec.ts`                     |
| Poison message encaminhada para DLQ real no LocalStack | `bun test tests/integration/sqs-dlq.integration.spec.ts`                   |

---

### Cobertura da suíte

- Value Object `Money`, Aggregate Root `Wallet`, máquina de estados e regras `BET/WIN/LOSS/REFUND/ROLLBACK`
- Disputa concorrente de duas apostas de `80.00` sobre saldo inicial de `100.00`
- Rajada concorrente de 50 requisições com a mesma `Idempotency-Key`
- Três workers independentes disputando a mesma carteira e redelivery após crash
- Três processos OS reais disputando a mesma carteira
- Crash recovery com o consumer oficial após commit sem ACK
- Padrões Transactional Outbox, AWS SQS e Inbox Deduplication
- Encaminhamento de mensagens poison para a DLQ
- Conflito real `55P03` usando `FOR UPDATE NOWAIT`
- Reconciliação matemática entre o saldo materializado da carteira e os lançamentos do ledger

---

## Teste de Carga

O comando `bun run test:load` usa apenas Bun e a API local. Ele cria uma wallet isolada, executa requisições concorrentes e imprime JSON com throughput, p50, p95, p99, taxa de erro, status HTTP, conflitos de lock e lag da Outbox.

```bash
bun run test:load
```

Para ajustar a carga:

**Windows PowerShell:**
```powershell
$env:LOAD_REQUESTS = "100"
$env:LOAD_CONCURRENCY = "20"
bun run test:load
```

**Linux/macOS:**
```bash
LOAD_REQUESTS=100 LOAD_CONCURRENCY=20 bun run test:load
```

---

## Smoke Tests HTTP

Esta seção documenta o ciclo financeiro auditado com dados reais e orientações preventivas contra armadilhas comuns no terminal.

---

### Cuidados com a sintaxe no PowerShell

1. **Variável reservada `$PID`:** No PowerShell, `$PID` armazena o Process ID da sessão e é somente leitura. Usar `$pId` dispara erro de permissão (`VariableNotWritable`). Sempre utilize variáveis nomeadas como `$testPlayerId`.

2. **Concatenação acidental de parâmetros:** Nunca cole uma variável receptora colada no corpo da requisição. Exemplo incorreto:
```powershell
   # ERRADO — gera string malformada
   -Body $betBody$betResponse | Format-List
```
   Isso resulta em:
```json
   {"message":"JSON Parse error: Unable to parse JSON string","error":"Bad Request","statusCode":400}
```
   Sempre atribua a chamada e formate o output em linhas separadas.

---

### Semântica do Livro-Razão (Ledger)

A contabilidade formal da carteira do jogador segue regras estritas:

| Direção  | Significado                                                                 |
|----------|-----------------------------------------------------------------------------|
| `CREDIT` | Toda **entrada** de valor que aumenta o saldo (depósito inicial, WIN, REFUND) |
| `DEBIT`  | Toda **saída** de valor que reduz o saldo (aposta BET, saques)              |

---

### Execução no Windows PowerShell

Execute os passos sequencialmente com a API ativa.

#### Passo 1 — Verificar saúde da aplicação

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/health/ready"
```

Saída esperada:

```
status checks
------ ------
UP     @{database=UP; messaging=UP}
```

---

#### Passo 2 — Criar carteira com saldo inicial de R$ 100.000,00

```powershell
$testPlayerId = "player-smoke-" + (Get-Date -Format "yyyyMMddHHmmss")
$createBody = @{
    playerId = $testPlayerId
    initialBalance = @{
        amount = "100000.00"
        currency = "BRL"
    }
} | ConvertTo-Json

$wallet = Invoke-RestMethod -Uri "http://localhost:3000/wallets" -Method Post -ContentType "application/json" -Body $createBody
$testWalletId = $wallet.id
Write-Host "Carteira criada com sucesso!" -ForegroundColor Green
Write-Host "Wallet ID: $testWalletId"
$wallet | Format-List
```

Saída esperada:

```
id       : e9da796b-4bcb-4326-bc5d-8a4cb6601304
playerId : player-smoke-20260904124445
balance  : @{amount=100000.00; currency=BRL}
version  : 1
```

---

#### Passo 3 — Débito 1: Aposta de R$ 300,00 (BET)

```powershell
$txId1 = "tx-300-" + (Get-Date -Format "yyyyMMddHHmmss")
$betBody1 = @{
    providerId            = "provider-smoke"
    externalTransactionId = $txId1
    playerId              = $testPlayerId
    walletId              = $testWalletId
    roundId               = "round-smoke-001"
    gameId                = "fortune-chimp"
    kind                  = "BET"
    money                 = @{ amount = "300.00"; currency = "BRL" }
} | ConvertTo-Json
$headers1 = @{ "Idempotency-Key" = "provider-smoke:$txId1" }

$betResponse1 = Invoke-RestMethod -Uri "http://localhost:3000/wagering/transactions" `
    -Method Post -Headers $headers1 -ContentType "application/json" -Body $betBody1
$betResponse1 | Format-List
```

> Resultado contábil: saldo reduzido atomicamente de R$ 100.000,00 para **R$ 99.700,00**.

---

#### Passo 4 — Débitos subsequentes (R$ 30,00 e R$ 80.000,00)

```powershell
# Débito de R$ 30,00
$txId2 = "tx-30-" + (Get-Date -Format "yyyyMMddHHmmss")
$betBody2 = @{
    providerId            = "provider-smoke"
    externalTransactionId = $txId2
    playerId              = $testPlayerId
    walletId              = $testWalletId
    roundId               = "round-smoke-002"
    gameId                = "fortune-chimp"
    kind                  = "BET"
    money                 = @{ amount = "30.00"; currency = "BRL" }
} | ConvertTo-Json
$headers2 = @{ "Idempotency-Key" = "provider-smoke:$txId2" }
$betResponse2 = Invoke-RestMethod -Uri "http://localhost:3000/wagering/transactions" `
    -Method Post -Headers $headers2 -ContentType "application/json" -Body $betBody2
$betResponse2 | Format-List

# Débito de R$ 80.000,00
$txId3 = "tx-80k-" + (Get-Date -Format "yyyyMMddHHmmss")
$betBody3 = @{
    providerId            = "provider-smoke"
    externalTransactionId = $txId3
    playerId              = $testPlayerId
    walletId              = $testWalletId
    roundId               = "round-smoke-003"
    gameId                = "fortune-chimp"
    kind                  = "BET"
    money                 = @{ amount = "80000.00"; currency = "BRL" }
} | ConvertTo-Json
$headers3 = @{ "Idempotency-Key" = "provider-smoke:$txId3" }
$betResponse3 = Invoke-RestMethod -Uri "http://localhost:3000/wagering/transactions" `
    -Method Post -Headers $headers3 -ContentType "application/json" -Body $betBody3
$betResponse3 | Format-List
```

> Resultado acumulado: saldo residual consolidado em **R$ 19.640,00 BRL**.

---

#### Passo 5 — Rejeição por saldo insuficiente

Tentativa de nova aposta de R$ 80.000,00 com saldo disponível de apenas R$ 19.640,00:

```powershell
$excessTxId = "tx-excess-" + (Get-Date -Format "yyyyMMddHHmmss")
$excessBody = @{
    providerId            = "provider-smoke"
    externalTransactionId = $excessTxId
    playerId              = $testPlayerId
    walletId              = $testWalletId
    roundId               = "round-smoke-004"
    gameId                = "fortune-chimp"
    kind                  = "BET"
    money                 = @{ amount = "80000.00"; currency = "BRL" }
} | ConvertTo-Json
$excessHeaders = @{ "Idempotency-Key" = "provider-smoke:$excessTxId" }

try {
    Invoke-RestMethod -Uri "http://localhost:3000/wagering/transactions" `
        -Method Post -Headers $excessHeaders -ContentType "application/json" -Body $excessBody
} catch {
    Write-Host "Status retornado:" $_.Exception.Response.StatusCode.value__
    $_.ErrorDetails.Message
}
```

Saída esperada:

```
Status retornado: 422
{"transactionId":"67dcd598-736d-4865-8d3c-7fa3552287e7","status":"REJECTED","balance":{"amount":"19640.00","currency":"BRL"},"idempotentReplay":false,"failureCode":"INSUFFICIENT_FUNDS"}
```

---

#### Passo 6 — Auditar o livro-razão (ledger imutável)

```powershell
(Invoke-RestMethod -Uri "http://localhost:3000/wallets/$testWalletId/ledger").items |
    Format-Table direction, amount, balanceBefore, balanceAfter, createdAt
```

Saída do extrato auditado:

```
direction amount                            balanceBefore                      balanceAfter                       createdAt
--------- ------                            -------------                      ------------                       ---------
DEBIT     @{amount=80000.00; currency=BRL}  @{amount=99640.00; currency=BRL}  @{amount=19640.00; currency=BRL}  2026-09-04 15:49:16.689+00
DEBIT     @{amount=30.00; currency=BRL}     @{amount=99670.00; currency=BRL}  @{amount=99640.00; currency=BRL}  2026-09-04 15:48:38.475+00
DEBIT     @{amount=30.00; currency=BRL}     @{amount=99700.00; currency=BRL}  @{amount=99670.00; currency=BRL}  2026-09-04 15:48:23.024+00
DEBIT     @{amount=300.00; currency=BRL}    @{amount=100000.00; currency=BRL} @{amount=99700.00; currency=BRL}  2026-09-04 15:45:35.91+00
CREDIT    @{amount=100000.00; currency=BRL} @{amount=0.00; currency=BRL}      @{amount=100000.00; currency=BRL} 2026-09-04 15:44:47.439+00
```

> A tentativa rejeitada por saldo insuficiente **não produz lançamento no ledger**, garantindo que o extrato registre apenas mutações financeiras reais.

---

#### Passo 7 — Reconciliação matemática final

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/wallets/$testWalletId/reconciliation" -Method Post |
    Format-List
```

Saída esperada:

```
walletId          : e9da796b-4bcb-4326-bc5d-8a4cb6601304
storedBalance     : @{amount=19640.00; currency=BRL}
calculatedBalance : @{amount=19640.00; currency=BRL}
difference        : @{amount=0.00; currency=BRL}
consistent        : True
checkedEntries    : 5
```

---

#### Passo 8 — Comprovação da trigger de imutabilidade no PostgreSQL

```powershell
docker exec -it wagering-postgres psql -U postgres -d wagering_db -c "UPDATE ledger_entries SET amount = 99999 WHERE 1=1;"
```

Resposta gerada pelo motor PostgreSQL:

```
ERROR: Operação inválida: lançamentos no livro-razão (ledger) são imutáveis e puramente cumulativos (append-only).
CONTEXT: PL/pgSQL function prevent_ledger_modification() line 3 at RAISE
```

---

### Execução via cURL (Linux / macOS / Git Bash)

#### 1. Criar carteira

```bash
WALLET_RESP=$(curl -s -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{"playerId": "player-linux-001", "initialBalance": {"amount": "100000.00", "currency": "BRL"}}')

echo $WALLET_RESP
WALLET_ID=$(echo $WALLET_RESP | jq -r .id)
PLAYER_ID=$(echo $WALLET_RESP | jq -r .playerId)
```

#### 2. Submeter aposta de R$ 300,00

```bash
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-linux:tx-001" \
  -d "{
    \"providerId\": \"provider-linux\",
    \"externalTransactionId\": \"tx-001\",
    \"playerId\": \"$PLAYER_ID\",
    \"walletId\": \"$WALLET_ID\",
    \"roundId\": \"round-001\",
    \"gameId\": \"fortune-chimp\",
    \"kind\": \"BET\",
    \"money\": {\"amount\": \"300.00\", \"currency\": \"BRL\"}
  }" | jq .
```

#### 3. Consultar extrato contábil

```bash
curl -s "http://localhost:3000/wallets/$WALLET_ID/ledger?limit=50" | jq .
```

#### 4. Reconciliação contábil

```bash
curl -s -X POST "http://localhost:3000/wallets/$WALLET_ID/reconciliation" | jq .
```

---

## Autenticação

A Seção 2 do desafio técnico não pontua autenticação. O comportamento padrão usa `NoopAuthGuard`, permitindo testes locais e uso do Swagger sem token prévio.

Para extensibilidade, o projeto inclui `JwtAuthGuard` baseado em JWKS RS256 e uma instância Zitadel no Compose. Para usar autenticação real:

1. Ative o guard nos controllers.
2. Configure `IDP_ISSUER` e `IDP_JWKS_URI`.
3. Gere credenciais na mesma instância Zitadel.

> Credenciais de outra instalação retornam `invalid_client`.

---

### Observabilidade

Os logs do bootstrap e dos workers são emitidos como JSON estruturado com os campos:

- `correlationId`
- `messageId`
- `transactionId`
- `walletId`
- `providerId`

A métrica `db_lock_conflicts_total` é incrementada para:

| Código PostgreSQL | Situação                    |
|-------------------|-----------------------------|
| `40P01`           | Deadlock                    |
| `55P03`           | Lock timeout (NOWAIT)       |
| —                 | Mensagens de timeout/deadlock reconhecidas via SQS |

---

## Organização do Código

```
src/
├── domain/           # Regras puras: Money, Wallet, Ledger, WagerRuleEngine
├── application/      # Casos de uso e background workers
├── infrastructure/   # Entidades MikroORM, migrations, SQS e Outbox
└── interface/http/   # Controllers REST, DTOs e interceptores

tests/
├── domain/           # Testes unitários de domínio
├── integration/      # PostgreSQL + LocalStack (SQS, DLQ, crash recovery)
└── concurrency/      # Workers independentes e processos OS reais
```

---

### Visão geral dos pilares

| Pilar                        | Abordagem resumida                                                                 |
|------------------------------|------------------------------------------------------------------------------------|
| **Aritmética monetária**     | Valores em centavos como `BIGINT` no PostgreSQL; decimal apenas na camada HTTP     |
| **Bloqueio por carteira**    | `SELECT ... FOR UPDATE NOWAIT` com retry-and-backoff no código de aplicação        |
| **Idempotência persistente** | Constraint `UNIQUE (provider_id, external_transaction_id)` + replay da resposta original |
| **Transactional Outbox**     | Evento gravado na mesma transação que muta o saldo; worker faz polling para o SQS  |
| **Ledger append-only**       | Trigger PostgreSQL bloqueia qualquer `UPDATE`/`DELETE` na tabela `ledger_entries`  |
| **Inbox deduplication**      | Consumer verifica `message_id` antes de executar; mensagens poison vão para a DLQ  |
| **Crash recovery**           | Lock pessimista + redelivery SQS garantem retomada segura após falha sem ACK       |

> Para a análise completa de cada decisão, consulte [`ARCHITECTURE.md`](./ARCHITECTURE.md).
