import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { OutboxEventDbEntity } from '../database/entities/outbox-event.db-entity';
import { MetricsService } from '../../common/metrics/metrics.service';

/**
 * Publica eventos do Transactional Outbox para a fila de eventos (não a de ingestão).
 *
 * Padrão claim → commit → publish → mark:
 * 1) FOR UPDATE SKIP LOCKED reclama o lote (multi-instância sem deadlock)
 * 2) Commit libera locks antes do I/O SQS
 * 3) Mark published / scheduleRetry em TX curta
 */
@Injectable()
export class OutboxPublisherWorker {
    private readonly logger = new Logger(OutboxPublisherWorker.name);
    private readonly queueUrl =
        process.env.SQS_EVENTS_QUEUE_URL ||
        'http://localhost:4566/000000000000/wager-events.fifo';
    private readonly batchSize = 25;

    constructor(
        private readonly em: EntityManager,
        private readonly sqsClient: SQSClient,
        private readonly metrics: MetricsService,
    ) { }

    public async publishPendingBatch(): Promise<number> {
        const claimed = await this.claimBatch();
        if (claimed.length === 0) {
            await this.refreshLagGauge();
            return 0;
        }

        let published = 0;
        for (const event of claimed) {
            try {
                await this.sqsClient.send(
                    new SendMessageCommand({
                        QueueUrl: this.queueUrl,
                        MessageBody: JSON.stringify(event.payload),
                        MessageGroupId: event.aggregateId,
                        MessageDeduplicationId: event.id,
                    }),
                );
                await this.markPublished(event.id);
                published++;
            } catch (err: unknown) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                await this.scheduleRetry(event.id, event.attempts + 1);
                this.logger.warn(
                    `Falha ao publicar outbox ${event.id}. Retry agendado. Erro: ${errorMessage}`,
                );
            }
        }

        await this.refreshLagGauge();
        return published;
    }

    private async claimBatch(): Promise<
        Array<{ id: string; aggregateId: string; payload: Record<string, unknown>; attempts: number }>
    > {
        const forkEm = this.em.fork();
        return await forkEm.transactional(async (txEm) => {
            const knex = txEm.getKnex();
            const pendingRows = await knex('outbox_events')
                .select('id')
                .whereNull('published_at')
                .andWhere('next_attempt_at', '<=', new Date())
                .orderBy('created_at', 'asc')
                .limit(this.batchSize)
                .forUpdate()
                .skipLocked();

            const ids: string[] = pendingRows.map((r: { id: string }) => r.id);
            if (ids.length === 0) return [];

            // Empurra next_attempt_at para frente (lease curto) para outra instância não reclamar.
            const leaseUntil = new Date(Date.now() + 30_000);
            await knex('outbox_events').whereIn('id', ids).update({ next_attempt_at: leaseUntil });

            const events = await txEm.find(OutboxEventDbEntity, { id: { $in: ids } });
            return events.map((e) => ({
                id: e.id,
                aggregateId: e.aggregateId,
                payload: e.payload,
                attempts: e.attempts,
            }));
        });
    }

    private async markPublished(id: string): Promise<void> {
        const forkEm = this.em.fork();
        await forkEm.transactional(async (txEm) => {
            const event = await txEm.findOne(OutboxEventDbEntity, { id });
            if (!event || event.publishedAt) return;
            event.publishedAt = new Date();
            await txEm.flush();
        });
    }

    private async scheduleRetry(id: string, attempts: number): Promise<void> {
        const forkEm = this.em.fork();
        await forkEm.transactional(async (txEm) => {
            const event = await txEm.findOne(OutboxEventDbEntity, { id });
            if (!event || event.publishedAt) return;
            event.attempts = attempts;
            const backoffSec = Math.min(Math.pow(2, attempts), 60);
            event.nextAttemptAt = new Date(Date.now() + backoffSec * 1000);
            await txEm.flush();
        });
        this.metrics.transactionRetriesTotal.inc({ kind: 'outbox' });
    }

    private async refreshLagGauge(): Promise<void> {
        try {
            const forkEm = this.em.fork();
            const knex = forkEm.getKnex();
            const row = await knex('outbox_events')
                .whereNull('published_at')
                .count<{ count: string }>('* as count')
                .first();
            this.metrics.outboxLagGauge.set(Number(row?.count ?? 0));
        } catch {
            // Métrica best-effort
        }
    }
}
