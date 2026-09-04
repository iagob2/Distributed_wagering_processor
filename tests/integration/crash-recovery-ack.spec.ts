import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import {
    ChangeMessageVisibilityCommand,
    CreateQueueCommand,
    DeleteQueueCommand,
    GetQueueUrlCommand,
    ReceiveMessageCommand,
    SendMessageCommand,
    SQSClient,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { createTestContainerContext, destroyTestContext, TestContext } from '../helpers/test-setup';
import { SqsWagerConsumerService } from '../../src/infrastructure/messaging/sqs-wager-consumer.service';
import { SubmitWagerTransactionService } from '../../src/application/services/submit-wager-transaction.service';
import { MetricsService } from '../../src/common/metrics/metrics.service';
import { WagerTransactionKind } from '../../src/domain/entities/wager-transaction.entity';
import { WalletLedgerEntryDbEntity } from '../../src/infrastructure/database/entities/wallet-ledger-entry.db-entity';
import { WagerTransactionDbEntity } from '../../src/infrastructure/database/entities/wager-transaction.db-entity';
import { InboxMessageDbEntity } from '../../src/infrastructure/database/entities/inbox-message.db-entity';

describe('Resilience: Crash between DB Commit and SQS ACK', () => {
    let ctx: TestContext;
    let sqsClient: SQSClient;
    let queueUrl: string;

    beforeAll(async () => {
        ctx = await createTestContainerContext();
        sqsClient = new SQSClient({
            region: 'us-east-1',
            endpoint: 'http://127.0.0.1:4566',
            credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        });
        const queueName = `crash-ack-${randomUUID()}.fifo`;
        await sqsClient.send(new CreateQueueCommand({
            QueueName: queueName,
            Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
        }));
        queueUrl = (await sqsClient.send(new GetQueueUrlCommand({ QueueName: queueName }))).QueueUrl!;
    });

    afterAll(async () => {
        await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        sqsClient.destroy();
        await destroyTestContext();
    });

    it('recupera a mensagem após commit sem ACK sem duplicar o débito', async () => {
        const walletId = randomUUID();
        const playerId = `crash-ack-${randomUUID()}`;
        const transactionId = `tx-${randomUUID()}`;
        const idempotencyKey = `idemp-${transactionId}`;
        await ctx.createWallet(walletId, playerId, '100.00', 'BRL');

        const envelope = {
            messageId: `msg-${randomUUID()}`,
            type: 'WagerTransactionRequested',
            occurredAt: new Date().toISOString(),
            data: {
                providerId: 'crash-provider',
                externalTransactionId: transactionId,
                idempotencyKey,
                playerId,
                walletId,
                roundId: 'round-crash',
                gameId: 'crash-game',
                kind: WagerTransactionKind.Bet,
                money: { amount: '25.00', currency: 'BRL' },
            },
        };

        await sqsClient.send(new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(envelope),
            MessageGroupId: walletId,
            MessageDeduplicationId: randomUUID(),
        }));
        const firstDelivery = await sqsClient.send(new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 1,
            VisibilityTimeout: 30,
        }));
        const message = firstDelivery.Messages?.[0];
        expect(message?.ReceiptHandle).toBeDefined();

        // Commita o efeito e simula a queda antes do DeleteMessageCommand.
        const firstWorker = new SubmitWagerTransactionService(ctx.orm.em.fork() as EntityManager);
        await firstWorker.execute(idempotencyKey, envelope.data);
        await sqsClient.send(new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message!.ReceiptHandle!,
            VisibilityTimeout: 0,
        }));

        const redelivery = await sqsClient.send(new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 1,
            VisibilityTimeout: 30,
        }));
        const redeliveredMessage = redelivery.Messages?.[0];
        expect(redeliveredMessage?.MessageId).toBe(message?.MessageId);

        process.env.SQS_MAIN_QUEUE_URL = queueUrl;
        const metrics = new MetricsService();
        const recoveryEm = ctx.orm.em.fork() as EntityManager;
        const recoveryService = new SubmitWagerTransactionService(recoveryEm, metrics);
        const consumer = new SqsWagerConsumerService(
            sqsClient,
            recoveryEm,
            recoveryService,
            metrics,
        );
        await (consumer as unknown as { handleMessage: (value: typeof redeliveredMessage) => Promise<void> })
            .handleMessage(redeliveredMessage);

        const verifyEm = ctx.orm.em.fork() as EntityManager;
        const transactions = await verifyEm.find(WagerTransactionDbEntity, { idempotencyKey });
        const debits = await verifyEm.find(WalletLedgerEntryDbEntity, { walletId, direction: 'DEBIT' });
        const inbox = await verifyEm.find(InboxMessageDbEntity, {
            messageId: envelope.messageId,
            consumerName: 'wager-engine-sqs-consumer',
        });

        expect(transactions).toHaveLength(1);
        expect(debits).toHaveLength(1);
        expect(inbox).toHaveLength(1);
        expect((await ctx.getReconciliation(walletId)).storedCents).toBe(7500n);
    });
});
