import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { OutboxEventDbEntity } from '../database/entities/outbox-event.db-entity';

@Injectable()
export class OutboxPublisherWorker {
    private readonly logger = new Logger(OutboxPublisherWorker.name);
    private readonly queueUrl =
        process.env.SQS_MAIN_QUEUE_URL ||
        'http://localhost:4566/000000000000/wager-transactions.fifo';
    private readonly batchSize = 25;

    constructor(
        private readonly em: EntityManager,
        private readonly sqsClient: SQSClient,
    ) { }

    public async publishPendingBatch(): Promise<number> {
        const forkEm = this.em.fork();

        return await forkEm.transactional(async (txEm) => {
            const knex = txEm.getKnex();

            // Primitiva atômica: ignora registros sob lock de outras instâncias ativas
            const pendingRows = await knex('outbox_events')
                .select('id')
                .whereNull('published_at')
                .andWhere((qb) => {
                    qb.where('next_attempt_at', '<=', new Date());
                })
                .orderBy('created_at', 'asc')
                .limit(this.batchSize)
                .forUpdate()
                .skipLocked();

            const ids: string[] = pendingRows.map((r: { id: string }) => r.id);
            if (ids.length === 0) {
                return 0;
            }

            const events = await txEm.find(OutboxEventDbEntity, { id: { $in: ids } });

            for (const event of events) {
                try {
                    const body = JSON.stringify(event.payload);

                    await this.sqsClient.send(
                        new SendMessageCommand({
                            QueueUrl: this.queueUrl,
                            MessageBody: body,
                            MessageGroupId: event.aggregateId, // Garante entrega sequencial por Wallet
                            MessageDeduplicationId: event.id,   // Deduplicação primária no SQS FIFO
                        }),
                    );

                    event.publishedAt = new Date();
                } catch (err: unknown) {
                    event.attempts += 1;
                    // Exponential Backoff: 2s, 4s, 8s, 16s... limitado a 60s
                    const backoffSec = Math.min(Math.pow(2, event.attempts), 60);
                    event.nextAttemptAt = new Date(Date.now() + backoffSec * 1000);

                    const errorMessage = err instanceof Error ? err.message : String(err);
                    this.logger.warn(
                        `Falha transitória na publicação do evento ${event.id}. Retry em ${backoffSec}s. Erro: ${errorMessage}`,
                    );
                }
            }

            await txEm.flush();
            return events.length;
        });
    }
}