# Architecture Decision Records - Distributed Wagering Processor

Este documento registra a fundamentação arquitetural, as decisões de engenharia (ADRs) e as garantias transacionais implementadas no **Distributed Wagering Processor** para o desafio técnico da Jungle Gaming.

O foco central do projeto foi blindar a consistência financeira, eliminar o risco de saldo negativo por concorrência e garantir entrega tolerante a falhas sem depender de memória volátil ou pressupostos frágeis de rede.

---

## 1. Visão Sistêmica e Topologia de Componentes

A aplicação foi separada estritamente em camadas inspiradas no Domain-Driven Design (DDD) e Clean Architecture:

```text
               +-----------------------+       +------------------------+
               |    HTTP Controllers   |       |  SQS Ingest Consumer   |
               |   (NestJS / Swagger)  |       | (wager-transactions)   |
               +-----------+-----------+       +------------+-----------+
                           |                               |
                           +---------------+---------------+
                                           |
                                           v
                       +---------------------------------------+
                       |     SubmitWagerTransactionService     |
                       |          (Application Core)           |
                       +------------------+--------------------+
                                          | (Mesmo Bloco ACID)
                                          v
               +-------------------------------------------------------+
               |                  PostgreSQL Engine                    |
               |  - idempotency_keys (Unique + Advisory Locks)         |
               |  - wallets (SELECT ... FOR UPDATE)                    |
               |  - wager_transactions (Máquina de Estados)            |
               |  - ledger_entries (Append-Only / Imutável)             |
               |  - inbox_messages (Deduplicação de Consumo)            |
               |  - outbox_events (Garantia Dual-Write)                 |
               +---------------------------+---------------------------+
                                           |
                                           v
                       +---------------------------------------+
                       |         OutboxPublisherWorker         |
                       |       (FOR UPDATE SKIP LOCKED)        |
                       +------------------+--------------------+
                                          |
                                          v
                       +---------------------------------------+
                       |          AWS SQS LocalStack           |
                       |           (wager-events.fifo)         |
                       +---------------------------------------+
```

### Princípios do Design

- **Domínio Isolado:** O núcleo (`Money`, `Wallet`, `WagerRuleEngine` e `WalletLedgerEntry`) não possui acoplamento com NestJS, MikroORM ou SDK da AWS.
- **Reutilização Transacional:** O consumidor do SQS e os controllers HTTP utilizam exatamente o mesmo caso de uso (`SubmitWagerTransactionService`), assegurando que regras de saldo, locks e ledger não sejam duplicadas.

---

## 2. Auditoria das Restrições Eliminatórias

O sistema possui defesas ativas contra as nove restrições invioláveis do desafio:

| # | Restrição Inviolável | Abordagem Implementada | Evidência |
|---:|---|---|---|
| 1 | Sem `number`, `float` ou `double` para dinheiro | Operações encapsuladas em `Money` via `Decimal.js`; persistência e cálculos contábeis em centavos. | `src/domain/value-objects/money.vo.ts` e colunas `BIGINT` na migration. |
| 2 | Idempotência sem cache em memória | Registro relacional transacional com hash canônico SHA-256 e advisory lock por chave. | Tabela `idempotency_keys`. |
| 3 | Não confiar apenas em SQS FIFO | A fila é somente transporte; a decisão financeira e a deduplicação ocorrem no PostgreSQL. | `sqs-wager-consumer.service.ts` e `inbox_messages`. |
| 4 | Sem eventos antes do commit | Transactional Outbox: o evento é persistido na mesma transação do saldo e do ledger. | `SubmitWagerTransactionService` e `outbox_events`. |
| 5 | Ledger imutável | A entidade não possui setters ou mutações; trigger SQL aborta `UPDATE` e `DELETE`. | `trg_protect_ledger_entries` na migration. |
| 6 | Sem lock global na aplicação | O lock é restrito à linha da carteira afetada. | `LockMode.PESSIMISTIC_WRITE`. |
| 7 | Sem read-calculate-update solto | A leitura e validação do saldo ocorrem sob lock na mesma transação do commit. | `WalletDbEntity` e caso de uso financeiro. |
| 8 | Suporte a múltiplas instâncias | Aplicação stateless; Outbox usa `SKIP LOCKED` e Inbox é persistente. | Testes de concorrência com conexões simultâneas. |
| 9 | Garantias no schema relacional | `CHECK`, `UNIQUE`, `FOREIGN KEY`, constraints aritméticas e trigger no DDL. | `001_initial_schema.sql`. |

---

## 3. Invariantes Financeiras e Integridade do Livro-Razão

- **Não-negatividade:** `wallet.balance >= 0` é defendida no agregado `Wallet` e por `CHECK` no PostgreSQL.
- **Unicidade de carteira:** Uma carteira é única pelo par `(player_id, currency)`.
- **Conservação contábil:**

  $$\text{wallet.balance} \equiv \sum \text{Créditos} - \sum \text{Débitos}$$

- **Correspondência 1:1:** Toda transação que altera saldo gera exatamente um lançamento no ledger.
- **Esterilidade de falhas:** Operações `REJECTED` e desfechos neutros `LOSS` não geram lançamentos financeiros.
- **Imutabilidade histórica:** O ledger é cumulativo e append-only.

O saldo materializado é auditável e precisa coincidir com o somatório de todo o histórico.

---

## 4. Arquitetura do Modelo de Domínio

### 4.1. Value Object: Money

`Money` possui construtor privado e factories estáticas. Valida formato decimal com escala de até duas casas, rejeita notação científica, valores negativos e caracteres inválidos. Suas operações são imutáveis e exigem moedas homogêneas, eliminando erros de ponto flutuante do IEEE 754.

### 4.2. Aggregate Root: Wallet

`Wallet` encapsula seu estado interno. As mutações via `debit()` e `credit()` validam a compatibilidade de moedas, protegem a invariante de saldo não-negativo, retornam o snapshot exato (`balanceBefore` e `balanceAfter`) e incrementam a versão monotonicamente.

### 4.3. WagerTransaction e WagerRuleEngine

A transação de aposta segue uma máquina de estados finita estrita:

- **Estado inicial:** `PENDING`.
- **Estado intermediário:** `PENDING_REFERENCE`.
- **Estados terminais e irreversíveis:** `PROCESSED`, `REJECTED` e `FAILED`.

O `WagerRuleEngine` atua de forma pura e define a transição contábil:

- `BET`: débito imediato; rejeição se o saldo for insuficiente.
- `WIN`: crédito do prêmio na carteira.
- `LOSS`: liquidação neutra, sem mutação financeira ou ledger.
- `REFUND` e `ROLLBACK`: compensações com referência explícita e proteção contra dupla reversão.

### 4.4. WalletLedgerEntry

A entidade é estruturalmente imutável. A factory valida a equação `balanceBefore ± amount = balanceAfter`, exige montante positivo e cria o snapshot contábil que será persistido no ledger.

---

## 5. Architecture Decision Records (ADRs)

### ADR-001 - Bloqueio Pessimista na Linha da Carteira

**Contexto:** Em plataformas de apostas com auto-bet, múltiplas requisições podem disputar o saldo da mesma carteira. Optimistic Locking causaria falhas de versão e retries agressivos; locks globais inviabilizariam o throughput.

**Decisão:** Usar `LockMode.PESSIMISTIC_WRITE` sobre o registro da carteira dentro da transação atômica.

**Consequências:** A linearização ocorre de forma determinística no PostgreSQL. Em duas apostas simultâneas de R$ 80 sobre saldo de R$ 100, uma é processada e a segunda lê o saldo atualizado de R$ 20 e é rejeitada. Jogadores distintos operam em paralelo.

### ADR-002 - Representação Monetária em Ponto Fixo

**Contexto:** Números de ponto flutuante em JavaScript podem produzir resultados como `0.1 + 0.2 = 0.30000000000000004`, o que é inaceitável em auditoria financeira.

**Decisão:** O contrato externo manipula strings decimais com duas casas, o domínio usa `Decimal.js` e a persistência armazena centavos inteiros em colunas `BIGINT`.

**Consequências:** Precisão matemática exata e nenhuma dependência de tipos flutuantes para valores financeiros.

### ADR-003 - Idempotência Persistente com Hash Canônico

**Contexto:** A ordenação diferente das chaves JSON pode produzir hashes divergentes para o mesmo payload lógico.

**Decisão:** O `CanonicalJsonHasher` ordena recursivamente os campos de negócio e calcula SHA-256. O header `Idempotency-Key` é persistido separadamente e não entra no hash.

**Consequências:** A mesma chave e payload retornam replay com `idempotentReplay: true`. A mesma chave com payload diferente resulta em `409 Conflict`. O advisory lock elimina a corrida na inserção da chave.

### ADR-004 - Transactional Outbox com SKIP LOCKED

**Contexto:** Publicar diretamente no SQS antes do commit cria o anti-padrão Dual-Write e pode gerar eventos fantasmas.

**Decisão:** Persistir o evento em `outbox_events` na mesma transação do saldo e do ledger. O `OutboxPublisherWorker` usa `FOR UPDATE SKIP LOCKED` e publica em `wager-events.fifo`.

**Consequências:** O commit financeiro não depende da disponibilidade do broker. Em falhas temporárias, o worker usa `next_attempt_at` e backoff exponencial. Múltiplas réplicas podem publicar sem disputar as mesmas linhas.

### ADR-005 - Consumo Idempotente com Inbox e ACK Pós-Commit

**Contexto:** SQS possui semântica at-least-once; uma mensagem pode ser entregue novamente após timeout no ACK.

**Decisão:** O consumidor consulta `inbox_messages` por `(consumer_name, message_id)`. O Inbox e a mutação contábil usam a mesma transação PostgreSQL. O `DeleteMessageCommand` é disparado somente depois do commit.

**Consequências:** Redeliveries identificadas pelo Inbox não repetem efeitos financeiros. Erros de negócio recebem ACK; falhas transitórias retornam para retry e DLQ após o limite configurado.

### ADR-006 - Máquina de Estados e Regras de Aposta

| Kind | Saldo | Ledger | Regra |
|---|---|---|---|
| `BET` | Débito | `DEBIT` | Rejeita se não houver saldo. |
| `WIN` | Crédito | `CREDIT` | Credita o prêmio. |
| `LOSS` | Nenhum | Nenhum | Registra o resultado sem movimento financeiro. |
| `REFUND` | Crédito | `CREDIT` | Reverte uma `BET` processada uma única vez. |
| `ROLLBACK` | Inversão | 1 lançamento | Reverte `BET`, `WIN` ou `REFUND` uma única vez. |

`OPENING` é interno e ocorre na criação da wallet. Referências ausentes ficam em `PENDING_REFERENCE` e são reprocessadas pelo worker.

### ADR-007 - Autenticação e Decisão de Escopo

A Seção 2 do desafio não pontua autenticação e não exige um mecanismo específico. Por isso, o comportamento padrão usa `NoopAuthGuard`, permitindo execução fluida dos testes e do Swagger.

A base inclui `JwtAuthGuard` para tokens RS256 via JWKS e o container Zitadel como extensão OIDC. A ativação do guard real exige credenciais criadas na mesma instância Zitadel; credenciais de outra instalação retornam `invalid_client`.

---

## 6. Schema Relacional e Defesas no Banco

A migration está em `src/infrastructure/database/migrations/001_initial_schema.sql` e aplica:

- `wallets`: `balance BIGINT NOT NULL`, `CHECK (balance >= 0)` e `UNIQUE (player_id, currency)`;
- `wager_transactions`: rastreabilidade por `wallet_id` e `UNIQUE (provider_id, external_transaction_id)`;
- `idempotency_keys`: hash SHA-256, resposta original e chave primária no header;
- `ledger_entries`: direção válida, montante positivo, saldos não-negativos e aritmética `balance_before ± amount = balance_after`;
- trigger de auditoria que cancela `UPDATE` e `DELETE` em `ledger_entries`;
- `outbox_events` e `inbox_messages`: suporte a polling concorrente e deduplicação persistente.

---

## 7. Observabilidade, Telemetria e Health Checks

- **Liveness:** `GET /health/live` verifica apenas se o processo está vivo, sem depender de rede.
- **Readiness:** `GET /health/ready` executa `SELECT 1` no PostgreSQL e consulta a fila SQS. Em falha, retorna `503 Service Unavailable`.
- **Métricas:** `GET /metrics` expõe métricas Prometheus, incluindo latência, transações por status, duplicatas, retries, DLQ, conflitos de lock e lag da Outbox.
- **Logs:** bootstrap e workers emitem JSON com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`; secrets e payloads financeiros completos não são registrados.
- **Conflitos de lock:** deadlocks (`40P01`), lock timeout (`55P03`) e mensagens reconhecidas de timeout/deadlock incrementam `db_lock_conflicts_total` antes de o erro ser propagado.

---

## 8. Validação Empírica e Resultados

A suíte é executada contra PostgreSQL e LocalStack reais, sem mocks nas camadas de persistência.

```powershell
bun run build
bun test
```

Resultado validado: **37 testes automatizados, 0 falhas**, incluindo os cenários multi-instância, crash recovery e DLQ.

### Cenários críticos

1. **Disputa concorrente de saldo:** carteira com R$ 100 recebendo duas apostas de R$ 80 via `Promise.all`. O resultado é uma transação `PROCESSED`, uma `REJECTED`, saldo final de R$ 20 e um único débito no ledger.
2. **Rajada idempotente:** 50 chamadas paralelas com a mesma `Idempotency-Key`. O sistema realiza um débito e retorna 49 replays com o mesmo snapshot.
3. **Operação fora de ordem:** um `ROLLBACK` sem referência fica em `PENDING_REFERENCE` e pode ser resolvido pelo worker após a chegada do evento referenciado.
4. **Reconciliação contínua:** o endpoint confirma `difference = 0.00` quando o saldo e o ledger estão consistentes.
5. **Três workers e crash recovery:** forks de EntityManager independentes disputam a mesma wallet; uma redelivery após commit sem ACK retorna replay e mantém um único débito.
6. **Poison message:** mensagem inválida é encaminhada para uma DLQ FIFO temporária e incrementa `dlq_messages_total`.

---

## 9. Trade-offs e Limitações Conhecidas

- **Vazão por hot wallet:** o lock pessimista limita a vazão da mesma carteira à latência de rede e disco do PostgreSQL. O custo é localizado e não bloqueia jogadores distintos.
- **Autenticação no ambiente padrão:** o `NoopAuthGuard` permanece ativo para execução sem atrito; o `JwtAuthGuard` está disponível como extensão.
- **Advisory lock:** `hashtext(idempotency_key)` pode teoricamente colidir entre chaves distintas. Uma colisão causaria apenas espera adicional, nunca corrupção financeira.
- **Volume histórico:** em produção com bilhões de registros, `ledger_entries` deve ser particionada por data com `PARTITION BY RANGE (created_at)`.
- **Teste de carga:** `bun run test:load` é nativo do Bun e imprime throughput, p50, p95, p99, taxa de erro, conflitos de lock e lag da Outbox. O relatório depende do ambiente executado e não é benchmark de produção.

---

## 10. Procedimento de Avaliação

```powershell
# 1. Instalar dependências e preparar o ambiente
bun install
Copy-Item .env.example .env

# 2. Subir containers reais
docker compose up -d

# 3. Aplicar a migration no PostgreSQL
Get-Content src/infrastructure/database/migrations/001_initial_schema.sql | docker exec -i wagering-postgres psql -U postgres -d wagering_db

# 4. Executar build e testes
bun run build
bun test
bun test tests/concurrency/multi-instance-concurrency.spec.ts
bun test tests/integration/sqs-dlq.integration.spec.ts

# Carga curta reproduzível
$env:LOAD_REQUESTS = "100"
$env:LOAD_CONCURRENCY = "20"
bun run test:load

# 5. Iniciar a API com Swagger e métricas
bun run start
```

Após a inicialização:

- Swagger: http://localhost:3000/docs
- Health: http://localhost:3000/health/ready
- Métricas: http://localhost:3000/metrics

Os smoke tests completos estão no [`README.md`](README.md).
