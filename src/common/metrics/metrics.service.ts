import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

@Injectable()
export class MetricsService {
    public readonly registry: Registry;

    public readonly transactionsTotal: Counter<string>;
    public readonly duplicateTransactionsTotal: Counter<string>;
    public readonly transactionRetriesTotal: Counter<string>;
    public readonly dlqMessagesTotal: Counter<string>;
    public readonly lockConflictsTotal: Counter<string>;
    public readonly outboxLagGauge: Gauge<string>;
    public readonly processingDurationSeconds: Histogram<string>;

    constructor() {
        this.registry = new Registry();

        this.transactionsTotal = new Counter({
            name: 'wager_transactions_total',
            help: 'Total de transações financeiras segmentadas por status, operação e provedor.',
            labelNames: ['status', 'kind', 'provider'],
            registers: [this.registry],
        });

        this.duplicateTransactionsTotal = new Counter({
            name: 'idempotency_duplicates_total',
            help: 'Total de chamadas duplicadas absorvidas pela camada de idempotência.',
            labelNames: ['provider'],
            registers: [this.registry],
        });

        this.transactionRetriesTotal = new Counter({
            name: 'transaction_retries_total',
            help: 'Contador de retries executados pelo worker de referências pendentes.',
            labelNames: ['kind'],
            registers: [this.registry],
        });

        this.dlqMessagesTotal = new Counter({
            name: 'dlq_messages_total',
            help: 'Volume acumulado de mensagens encaminhadas para a DLQ.',
            labelNames: ['queue_name'],
            registers: [this.registry],
        });

        this.lockConflictsTotal = new Counter({
            name: 'db_lock_conflicts_total',
            help: 'Contador de contenção ou timeout em locks pessimistas no PostgreSQL.',
            registers: [this.registry],
        });

        this.outboxLagGauge = new Gauge({
            name: 'outbox_lag_gauge',
            help: 'Contagem instantânea de eventos pendentes na tabela outbox.',
            registers: [this.registry],
        });

        this.processingDurationSeconds = new Histogram({
            name: 'wager_processing_duration_seconds',
            help: 'Histograma da latência de execução do caso de uso financeiro.',
            labelNames: ['operation'],
            buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
            registers: [this.registry],
        });
    }

    public async getMetricsFormatted(): Promise<string> {
        return await this.registry.metrics();
    }
}