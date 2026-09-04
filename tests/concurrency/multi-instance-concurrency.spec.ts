import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { SQSClient, ChangeMessageVisibilityCommand, ReceiveMessageCommand, SendMessageCommand, CreateQueueCommand, GetQueueUrlCommand, DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { SubmitWagerTransactionService } from '../../src/application/services/submit-wager-transaction.service';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/entities/wager-transaction.entity';
import { WalletLedgerEntryDbEntity } from '../../src/infrastructure/database/entities/wallet-ledger-entry.db-entity';
import { WagerTransactionDbEntity } from '../../src/infrastructure/database/entities/wager-transaction.db-entity';
import { createTestContainerContext, destroyTestContext, TestContext } from '../helpers/test-setup';

describe('Resiliência distribuída: três workers e crash recovery', () => {
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
        const queueName = `crash-recovery-${randomUUID()}.fifo`;
        await sqsClient.send(new CreateQueueCommand({
            QueueName: queueName,
            Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
        }));
        const queue = await sqsClient.send(new GetQueueUrlCommand({ QueueName: queueName }));
        queueUrl = queue.QueueUrl!;
    });

    afterAll(async () => {
        if (queueUrl) await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        sqsClient.destroy();
        await destroyTestContext();
    });

    it('mantém a consistência quando três workers independentes disputam a mesma wallet', async () => {
        const walletId = randomUUID();
        const playerId = `multi-${randomUUID()}`;
        await ctx.createWallet(walletId, playerId, '1000.00', 'BRL');

        // Cada fork possui identidade map e conexão transacional próprias, como réplicas distintas.
        const workers = [1, 2, 3].map(() => {
            const em = ctx.orm.em.fork() as EntityManager;
            return new SubmitWagerTransactionService(em);
        });
        const requests = Array.from({ length: 30 }, (_, index) => {
            const worker = workers[index % workers.length];
            return worker.execute(`multi:${randomUUID()}`, {
                providerId: 'multi-instance-test',
                externalTransactionId: `multi-${index}-${randomUUID()}`,
                playerId,
                walletId,
                roundId: `round-${index}`,
                gameId: 'multi-instance',
                kind: WagerTransactionKind.Bet,
                money: { amount: '10.00', currency: 'BRL' },
            });
        });

        const results = await Promise.all(requests);
        expect(results.every((result) => result.body.status === WagerTransactionStatus.Processed)).toBe(true);

        const verifyEm = ctx.orm.em.fork() as EntityManager;
        const debits = await verifyEm.find(WalletLedgerEntryDbEntity, { walletId, direction: 'DEBIT' });
        expect(debits.length).toBe(30);
        const report = await ctx.getReconciliation(walletId);
        expect(report.consistent).toBe(true);
        expect(report.storedCents).toBe(70000n);
        expect(report.calculatedCents).toBe(70000n);
    });

    it('recupera redelivery após commit financeiro sem ACK sem duplicar o débito', async () => {
        const walletId = randomUUID();
        const playerId = `crash-${randomUUID()}`;
        const idempotencyKey = `crash:${randomUUID()}`;
        await ctx.createWallet(walletId, playerId, '100.00', 'BRL');

        const envelope = {
            messageId: randomUUID(),
            type: 'WagerTransactionRequested',
            occurredAt: new Date().toISOString(),
            data: {
                providerId: 'crash-recovery-test',
                externalTransactionId: `crash-${randomUUID()}`,
                idempotencyKey,
                playerId,
                walletId,
                roundId: 'crash-round',
                gameId: 'crash-recovery',
                kind: WagerTransactionKind.Bet,
                money: { amount: '30.00', currency: 'BRL' },
            },
        };

        const sent = await sqsClient.send(new SendMessageCommand({
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
        expect(message?.MessageId).toBe(sent.MessageId);
        expect(message?.ReceiptHandle).toBeDefined();

        // Simula crash depois do commit e antes do ACK: o efeito é aplicado, mas a mensagem não é deletada.
        const worker = new SubmitWagerTransactionService(ctx.orm.em.fork() as EntityManager);
        await worker.execute(idempotencyKey, envelope.data);
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
        expect(redelivery.Messages?.[0]?.MessageId).toBe(sent.MessageId);

        // Outra instância retoma a mensagem; a chave persistida devolve replay sem novo lançamento.
        const recoveryWorker = new SubmitWagerTransactionService(ctx.orm.em.fork() as EntityManager);
        const replay = await recoveryWorker.execute(idempotencyKey, envelope.data);
        expect(replay.body.idempotentReplay).toBe(true);
        expect(replay.body.balance.amount).toBe('70.00');

        const verifyEm = ctx.orm.em.fork() as EntityManager;
        const transactions = await verifyEm.find(WagerTransactionDbEntity, { idempotencyKey });
        const debits = await verifyEm.find(WalletLedgerEntryDbEntity, { walletId, direction: 'DEBIT' });
        expect(transactions.length).toBe(1);
        expect(debits.length).toBe(1);
    });
});
