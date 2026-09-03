import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver, EntityManager } from '@mikro-orm/postgresql';
import { SQSClient, PurgeQueueCommand } from '@aws-sdk/client-sqs';
import { OutboxEventDbEntity } from '../../src/infrastructure/database/entities/outbox-event.db-entity';
import { InboxMessageDbEntity } from '../../src/infrastructure/database/entities/inbox-message.db-entity';
import { WalletDbEntity } from '../../src/infrastructure/database/entities/wallet.db-entity';
import { OutboxPublisherWorker } from '../../src/infrastructure/messaging/outbox-publisher.worker';
import { randomUUID } from 'crypto';

describe('Integration: Outbox -> SQS -> Inbox Pattern', () => {
    let orm: MikroORM;
    let em: EntityManager;
    let sqsClient: SQSClient;
    const queueUrl =
        process.env.SQS_MAIN_QUEUE_URL ||
        'http://localhost:4566/000000000000/wager-transactions.fifo';

    beforeAll(async () => {
        try {
            // 1. Inicializa com o driver do PostgreSQL explícito (MikroORM v6)
            orm = await MikroORM.init({
                driver: PostgreSqlDriver,
                entities: [OutboxEventDbEntity, InboxMessageDbEntity, WalletDbEntity],
                dbName: 'wagering_db',
                user: 'postgres',
                password: 'postgrespassword',
                host: '127.0.0.1', // Usar 127.0.0.1 evita problemas de resolução DNS do localhost no Windows
                port: 5432,
                debug: false,
            });

            em = orm.em.fork() as EntityManager;

            // 2. Inicializa o cliente SQS conectado ao LocalStack
            sqsClient = new SQSClient({
                region: 'us-east-1',
                endpoint: 'http://127.0.0.1:4566',
                credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
            });

            // Limpa a fila antes dos testes
            try {
                await sqsClient.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
            } catch {
                // Ignora caso a fila já esteja vazia
            }
        } catch (error) {
            console.error('Falha detalhada ao inicializar o banco/SQS no beforeAll:', error);
            throw error;
        }
    });

    afterAll(async () => {
        // Evita o crash caso o beforeAll falhe
        if (orm) {
            await orm.close();
        }
        if (sqsClient) {
            sqsClient.destroy();
        }
    });

    it('deve persistir evento na Outbox e despachar com sucesso para o SQS via SKIP LOCKED', async () => {
        const eventId = randomUUID();
        const aggregateId = randomUUID();

        const event = em.create(OutboxEventDbEntity, {
            id: eventId,
            aggregateId,
            eventType: 'WalletBalanceChanged',
            payload: {
                walletId: aggregateId,
                amount: '50.00',
                currency: 'BRL',
            },
            occurredAt: new Date(),
            attempts: 0,
            nextAttemptAt: new Date(),
            createdAt: new Date(),
        });

        await em.persistAndFlush(event);

        const publisher = new OutboxPublisherWorker(em, sqsClient);
        const publishedCount = await publisher.publishPendingBatch();

        expect(publishedCount).toBeGreaterThanOrEqual(1);

        const updatedEvent = await em.fork().findOne(OutboxEventDbEntity, { id: eventId });
        expect(updatedEvent?.publishedAt).not.toBeNull();
        expect(updatedEvent?.attempts).toBe(0);
    });

    it('deve registrar mensagem no Inbox e impedir duplicidade em caso de reentrega (At-Least-Once)', async () => {
        const forkEm = em.fork();
        const messageId = `msg-${randomUUID()}`;
        const consumerName = 'wager-engine-sqs-consumer';
        const payloadHash = 'hash-integracao-123';

        const firstDelivery = forkEm.create(InboxMessageDbEntity, {
            messageId,
            consumerName,
            payloadHash,
            receivedAt: new Date(),
            processedAt: new Date(),
        });

        await forkEm.persistAndFlush(firstDelivery);

        const checkInbox = await em.fork().findOne(InboxMessageDbEntity, {
            messageId,
            consumerName,
        });

        expect(checkInbox).not.toBeNull();
        expect(checkInbox?.messageId).toBe(messageId);
        expect(checkInbox?.consumerName).toBe(consumerName);

        const duplicateDelivery = em.fork().create(InboxMessageDbEntity, {
            messageId,
            consumerName,
            payloadHash,
            receivedAt: new Date(),
            processedAt: new Date(),
        });

        expect(em.fork().persistAndFlush(duplicateDelivery)).rejects.toThrow();
    });
});