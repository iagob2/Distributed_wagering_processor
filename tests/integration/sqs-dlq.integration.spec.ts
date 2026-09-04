import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import {
    CreateQueueCommand,
    DeleteMessageCommand,
    DeleteQueueCommand,
    GetQueueUrlCommand,
    ReceiveMessageCommand,
    SendMessageCommand,
    SQSClient,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { SqsWagerConsumerService } from '../../src/infrastructure/messaging/sqs-wager-consumer.service';
import { SubmitWagerTransactionService } from '../../src/application/services/submit-wager-transaction.service';
import { MetricsService } from '../../src/common/metrics/metrics.service';

describe('Integration: poison message para DLQ', () => {
    let sqsClient: SQSClient;
    let inputQueueUrl: string;
    let dlqUrl: string;
    let consumer: SqsWagerConsumerService;

    beforeAll(async () => {
        sqsClient = new SQSClient({
            region: 'us-east-1',
            endpoint: 'http://127.0.0.1:4566',
            credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        });

        inputQueueUrl = await createFifoQueue('poison-input');
        dlqUrl = await createFifoQueue('poison-dlq');
        process.env.SQS_MAIN_QUEUE_URL = inputQueueUrl;
        process.env.SQS_DLQ_URL = dlqUrl;
        consumer = new SqsWagerConsumerService(
            sqsClient,
            {} as EntityManager,
            {} as SubmitWagerTransactionService,
            new MetricsService(),
        );
    });

    afterAll(async () => {
        await sqsClient.send(new DeleteQueueCommand({ QueueUrl: inputQueueUrl }));
        await sqsClient.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
        sqsClient.destroy();
    });

    it('encaminha envelope inválido para a DLQ e não produz efeito financeiro', async () => {
        await sqsClient.send(new SendMessageCommand({
            QueueUrl: inputQueueUrl,
            MessageBody: JSON.stringify({ messageId: 'poison-1', type: 'Unknown' }),
            MessageGroupId: 'poison-test',
            MessageDeduplicationId: 'poison-1',
        }));

        const received = await sqsClient.send(new ReceiveMessageCommand({
            QueueUrl: inputQueueUrl,
            MaxNumberOfMessages: 1,
            VisibilityTimeout: 30,
        }));
        const message = received.Messages?.[0];
        expect(message?.ReceiptHandle).toBeDefined();

        await (consumer as unknown as {
            handleMessage: (value: typeof message) => Promise<void>;
        }).handleMessage(message);

        const deadLetter = await sqsClient.send(new ReceiveMessageCommand({
            QueueUrl: dlqUrl,
            MaxNumberOfMessages: 1,
            VisibilityTimeout: 30,
        }));
        expect(deadLetter.Messages?.[0]?.Body).toBe(JSON.stringify({ messageId: 'poison-1', type: 'Unknown' }));

        const metrics = await consumer['metrics'].getMetricsFormatted();
        expect(metrics).toContain('dlq_messages_total');

        if (deadLetter.Messages?.[0]?.ReceiptHandle) {
            await sqsClient.send(new DeleteMessageCommand({
                QueueUrl: dlqUrl,
                ReceiptHandle: deadLetter.Messages[0].ReceiptHandle,
            }));
        }
    });

    async function createFifoQueue(prefix: string): Promise<string> {
        const name = `${prefix}-${crypto.randomUUID()}.fifo`;
        await sqsClient.send(new CreateQueueCommand({
            QueueName: name,
            Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
        }));
        const result = await sqsClient.send(new GetQueueUrlCommand({ QueueName: name }));
        return result.QueueUrl!;
    }
});
