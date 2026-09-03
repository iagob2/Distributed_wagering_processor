#!/usr/bin/env bash
set -euo pipefail

echo "=============================================="
echo "Inicializando filas FIFO no LocalStack SQS..."
echo "=============================================="

# 1. Cria a Dead Letter Queue (DLQ)
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true

# 2. Obtém o ARN da DLQ
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)

echo "DLQ criada com ARN: ${DLQ_ARN}"

# 3. Cria a fila principal vinculada à DLQ (máx 5 tentativas)
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"true\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

# 4. Cria a fila para eventos da Outbox (separada da ingestão de apostas)
awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true

echo "=============================================="
echo "===> Filas SQS criadas com sucesso!"
awslocal sqs list-queues
echo "=============================================="
