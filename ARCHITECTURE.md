# Architecture Decision Records — Distributed Wagering Processor

Este documento explica as decisões técnicas do desafio **Distributed Wagering Processor** da Jungle Gaming e registra as garantias, trade-offs e limitações verificadas no código.

## 1. Visão sistêmica

```text
HTTP ───────────────┐
                    ├── SubmitWagerTransactionService ── PostgreSQL
SQS consumer ───────┘       ├── idempotency_keys
                             ├── wallet FOR UPDATE
                             ├── wager_transactions
                             ├── ledger_entries
                             └── outbox_events ── publisher ── wager-events.fifo

wager-transactions.fifo ── consumer ── inbox_messages
```

O domínio é isolado de NestJS, MikroORM e SQS. Controllers e consumers são adaptadores; o caso de uso financeiro é compartilhado entre HTTP e SQS.

## 2. Auditoria das restrições eliminatórias

| Restrição | Status | Evidência |
|---|---|---|
| Sem `number`, `float` ou `double` para dinheiro | Conforme | `Money` usa `Decimal.js`; persistência e cálculos de infraestrutura usam centavos em `BIGINT`/`bigint`. |
| Idempotência não depende de memória | Conforme | `idempotency_keys` persistente, hash canônico e advisory lock transacional por chave. |
| SQS não é a garantia financeira | Conforme | A decisão financeira ocorre no PostgreSQL, antes do ACK, com idempotência e locks. |
| Eventos somente após commit | Conforme | Eventos são gravados na Outbox na mesma transação; o publisher envia depois do commit. |
| Ledger imutável | Conforme | Entidade estruturalmente imutável e trigger SQL bloqueando `UPDATE`/`DELETE`. |
| Sem lock global | Conforme | `SELECT ... FOR UPDATE` é aplicado somente à wallet disputada. |
| Sem read-calculate-update livre | Conforme | Saldo é reidratado depois do lock pessimista e atualizado na mesma transação. |
| Múltiplas instâncias | Conforme | Estado compartilhado no PostgreSQL; Outbox usa `SKIP LOCKED`; Inbox e idempotência são persistentes. |
| Garantias no schema | Conforme | `CHECK`, `UNIQUE`, `FOREIGN KEY`, constraints aritméticas e trigger estão na migration SQL. |

## 3. Invariantes financeiras

- `wallet.balance >= 0` em código e no schema.
- Uma wallet é única por `(player_id, currency)`.
- O saldo materializado é reconciliável por:

  $$\text{wallet.balance} = \sum(\text{créditos}) - \sum(\text{débitos})$$

- Cada operação que altera saldo produz exatamente um lançamento correspondente.
- `REJECTED` e `LOSS` não criam lançamento financeiro.
- O ledger é append-only.
- Dinheiro entra e sai como string decimal com duas casas; internamente é `Decimal.js` e, na persistência, centavos inteiros.

## 4. Modelo de domínio

### Money

`Money` possui construtor privado e factories estáticas. Valida moeda, formato decimal, finitude, escala de até duas casas e não-negatividade. Operações retornam novas instâncias, preservando imutabilidade e evitando arredondamento binário de `number`.

### Wallet

`Wallet` é o Aggregate Root. `debit` e `credit` validam moeda, preservam saldo não-negativo e incrementam `version` somente quando ocorre mutação.

### WagerTransaction e WagerRuleEngine

A transação nasce `PENDING`. Os estados `PROCESSED`, `REJECTED` e `FAILED` são terminais. `OPENING` é reservado à criação interna da wallet. O `WagerRuleEngine` avalia sem mutar estado:

| Kind | Efeito | Ledger | Regra |
|---|---|---|---|
| `BET` | Débito | `DEBIT` | Rejeita saldo insuficiente. |
| `WIN` | Crédito | `CREDIT` | Crédito da rodada. |
| `LOSS` | Nenhum | Nenhum | Apenas registra o resultado. |
| `REFUND` | Crédito | `CREDIT` | Exige `BET` processada e referência válida. |
| `ROLLBACK` | Inversão | Inverso | Exige referência processada e impede dupla reversão. |

Referências ausentes tornam a transação `PENDING_REFERENCE`; o worker reprocessa com política de TTL/backoff e atualiza a resposta persistida de idempotência quando o estado final é conhecido.

### WalletLedgerEntry

A factory valida `balanceBefore ± amount = balanceAfter`, exige montante positivo e retorna uma entidade sem campos mutáveis. O schema repete essa proteção com `CHECK` e impede alterações históricas por trigger.

## 5. ADRs

### ADR-001 — Lock pessimista por wallet

**Decisão:** usar `LockMode.PESSIMISTIC_WRITE` na linha da wallet dentro da transação financeira.

**Motivo:** duas apostas concorrentes sobre a mesma wallet são serializadas pelo PostgreSQL. A segunda lê o saldo já atualizado e é rejeitada sem retry de aplicação. Wallets distintas continuam em paralelo. Optimistic locking com retries foi rejeitado para evitar tempestades sob contenção.

**Trade-off:** uma hot wallet é limitada pela latência e capacidade de escrita do PostgreSQL. Esse limite é localizado por wallet, não global.

### ADR-002 — Dinheiro como Decimal.js e BIGINT

A API recebe `{ amount: "25.00", currency: "BRL" }`. `Decimal.js` preserva precisão durante as operações; PostgreSQL armazena centavos em `BIGINT`. O domínio não depende de decorators ou tipos monetários do ORM.

### ADR-003 — Idempotência persistente e hash canônico

`CanonicalJsonHasher` ordena chaves recursivamente e calcula SHA-256 somente sobre campos de negócio. O header `Idempotency-Key` fica fora do hash.

- Mesma chave e mesmo hash: replay da resposta persistida.
- Mesma chave e hash diferente: `409 Conflict`.
- O advisory lock é transacional e reduz a janela entre consultar e inserir a chave.

### ADR-004 — Transactional Outbox

Wallet, transação, ledger, idempotência e eventos são persistidos no mesmo bloco transacional. O publisher faz `claim -> commit -> publish -> mark`, usando `FOR UPDATE SKIP LOCKED` para permitir múltiplas instâncias.

A fila `wager-events.fifo` é separada da fila de ingestão `wager-transactions.fifo`; isso evita que eventos de saída sejam interpretados como novas apostas.

Um crash depois do commit e antes do publish deixa o evento pendente na Outbox. Outra instância pode publicá-lo. Uma publicação repetida permanece segura por Inbox/idempotência downstream.

### ADR-005 — Inbox e ACK

O consumidor verifica `(consumerName, messageId)` em `inbox_messages`. O registro do Inbox e o efeito financeiro usam o mesmo contexto transacional do use case. O SQS só recebe ACK após commit.

Erros de negócio são terminais e recebem ACK. Erros transitórios alteram a visibilidade para retry; a redrive policy do LocalStack limita a entrega e encaminha para DLQ.

### ADR-006 — Autenticação

A autenticação vale zero pontos na Seção 2. O default de avaliação é `NoopAuthGuard`, deixando health checks e testes locais independentes de um IdP. Existe `JwtAuthGuard` como extensão OIDC/JWKS RS256, mas ele não é ativado por padrão.

O Zitadel no Compose é um ponto de extensão, não uma fonte automática das credenciais do avaliador. Um `client_id` precisa existir na mesma instância (`http://localhost:8080`); credenciais de outra instalação retornam `invalid_client`.

## 6. Schema e garantias no banco

A migration é [001_initial_schema.sql](src/infrastructure/database/migrations/001_initial_schema.sql) e cria:

- `wallets` com `CHECK (balance >= 0)` e `UNIQUE (player_id, currency)`;
- `wager_transactions` com FK para wallet e `UNIQUE (provider_id, external_transaction_id)`;
- `idempotency_keys` com chave primária no header e unicidade do par provider/transação externa;
- `ledger_entries` com montante positivo, saldo não-negativo, direção válida, aritmética e trigger append-only;
- `outbox_events` e `inbox_messages` para entrega at-least-once e deduplicação persistente.

## 7. Observabilidade e operação

- `GET /health/live`: processo ativo.
- `GET /health/ready`: PostgreSQL e SQS alcançáveis.
- `GET /metrics`: contadores de status, duplicatas, retries, DLQ, conflitos de lock, lag da Outbox e latência.
- Logs incluem contexto operacional sem registrar secrets ou payloads financeiros completos.

O worker SQS trata envelopes inválidos como mensagens descartáveis e não deixa a exceção escapar do loop de polling. Mensagens antigas na fila podem produzir avisos de payload incompatível; a fila de ingestão deve conter apenas `WagerTransactionRequested`.

## 8. Validação empírica

A suíte atual passa com **34 testes, 0 falhas e 205 asserções**:

```powershell
bun run build
bun test
```

Os cenários de maior risco são:

1. saldo inicial `100.00` e duas apostas concorrentes de `80.00`: exatamente uma `PROCESSED`, uma `REJECTED`, saldo `20.00` e um débito;
2. 50 requisições paralelas com a mesma chave: um débito e 49 replays;
3. Outbox publicada com `SKIP LOCKED` e Inbox protegida contra redelivery;
4. reconciliação do saldo materializado contra o ledger.

## 9. Limitações e próximos riscos

- A autenticação JWT está preparada, mas o modo padrão é no-op por decisão de escopo.
- A política de `PENDING_REFERENCE` usa TTL/backoff e pode ser refinada com colunas persistentes de tentativas.
- `ledger_entries` deve ser particionada por tempo em volumes de produção muito altos.
- O advisory lock usa `hashtext`, portanto uma colisão teórica de hash pode serializar chaves diferentes; não compromete a correção, apenas pode reduzir paralelismo em um caso extremo.
- O teste de carga diferencial não faz parte dos scripts atuais; os números de desempenho não devem ser inventados.

## 10. Comandos do avaliador

```powershell
bun install
Copy-Item .env.example .env
docker compose up -d
Get-Content src/infrastructure/database/migrations/001_initial_schema.sql | docker exec -i wagering-postgres psql -U postgres -d wagering_db
bun run build
bun test
bun run start
```

Depois, acessar http://localhost:3000/docs e executar os smoke tests descritos no [`README.md`](README.md).
