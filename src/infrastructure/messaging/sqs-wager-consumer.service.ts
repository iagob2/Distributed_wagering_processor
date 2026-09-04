import {
    Injectable,
    OnModuleInit,
    OnModuleDestroy,
} from '@nestjs/common';
import {
    SQSClient,
    ReceiveMessageCommand,
    DeleteMessageCommand,
    ChangeMessageVisibilityCommand,
    SendMessageCommand,
    Message,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { SubmitWagerTransactionService } from '../../application/services/submit-wager-transaction.service';
import { InboxMessageDbEntity } from '../database/entities/inbox-message.db-entity';
import { CanonicalJsonHasher } from '../../common/utils/canonical-json-hasher.util';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction.entity';
import { MetricsService } from '../../common/metrics/metrics.service';
import { StructuredLogger } from '../../common/logging/structured-logger';

export interface SqsMessageEnvelope {
    messageId: string;
    type: string;
    occurredAt: string;
    data: {
        providerId: string;
        externalTransactionId: string;
        idempotencyKey: string;
        playerId: string;
        walletId: string;
        roundId: string;
        gameId: string;
        kind: WagerTransactionKind;
        money: {
            amount: string;
            currency: string;
        };
        referenceExternalTransactionId?: string;
    };
}

/**
 * Consumidor at-least-once da fila de ingestão.
 *
 * Garantias:
 * - Dedup persistente via inbox (consumerName, messageId)
 * - Inbox + efeito financeiro na MESMA TX SQL (passa EntityManager ao use case)
 * - ACK (DeleteMessage) somente após commit bem-sucedido
 * - Erros de negócio → ACK (terminal); transitórios → visibility retry → DLQ LocalStack
 */
@Injectable()
export class SqsWagerConsumerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new StructuredLogger();
    private readonly consumerName = 'wager-engine-sqs-consumer';
    private readonly queueUrl =
        process.env.SQS_MAIN_QUEUE_URL ||
        'http://localhost:4566/000000000000/wager-transactions.fifo';
    private readonly dlqName = 'wager-transactions-dlq.fifo';
    private readonly dlqUrl =
        process.env.SQS_DLQ_URL ||
        'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';

    private isRunning = false;
    private activeJobs = 0;

    constructor(
        private readonly sqsClient: SQSClient,
        private readonly em: EntityManager,
        private readonly submitService: SubmitWagerTransactionService,
        private readonly metrics: MetricsService,
    ) { }

    public onModuleInit(): void {
        this.isRunning = true;
        void this.poll();
    }

    public async onModuleDestroy(): Promise<void> {
        this.logger.log('SIGTERM/shutdown: aguardando jobs SQS em andamento...');
        this.isRunning = false;
        const deadline = Date.now() + 10000;
        while (this.activeJobs > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
    }

    private async poll(): Promise<void> {
        while (this.isRunning) {
            try {
                const response = await this.sqsClient.send(
                    new ReceiveMessageCommand({
                        QueueUrl: this.queueUrl,
                        MaxNumberOfMessages: 5,
                        WaitTimeSeconds: 10,
                        VisibilityTimeout: 30,
                        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
                    }),
                );

                if (response.Messages && response.Messages.length > 0) {
                    await Promise.all(response.Messages.map((msg) => this.handleMessage(msg)));
                }
            } catch (err: unknown) {
                if (this.isRunning) {
                    const message = err instanceof Error ? err.message : String(err);
                    this.logger.error(`Erro no loop SQS: ${message}`);
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                }
            }
        }
    }

    private async handleMessage(message: Message): Promise<void> {
        this.activeJobs++;
        try {
            if (!message.Body || !message.ReceiptHandle) return;

            let envelope: SqsMessageEnvelope;
            try {
                envelope = JSON.parse(message.Body) as SqsMessageEnvelope;
            } catch {
                this.logger.warn(`Mensagem malformada ${message.MessageId}. Enviando para DLQ.`);
                await this.moveToDlq(message);
                await this.ack(message.ReceiptHandle);
                return;
            }

            // Eventos de outbox não devem ser reprocessados como apostas.
            if (!envelope.data?.walletId || !envelope.data?.idempotencyKey) {
                this.logger.warn(`Envelope sem payload de aposta ${message.MessageId}. Enviando para DLQ.`);
                await this.moveToDlq(message);
                await this.ack(message.ReceiptHandle);
                return;
            }

            const payloadHash = CanonicalJsonHasher.hash(
                envelope.data as unknown as Record<string, unknown>,
            );

            const forkEm = this.em.fork();

            await forkEm.transactional(async (txEm) => {
                const existingInbox = await txEm.findOne(InboxMessageDbEntity, {
                    messageId: envelope.messageId,
                    consumerName: this.consumerName,
                });

                if (existingInbox) {
                    this.metrics.duplicateTransactionsTotal.inc({
                        provider: envelope.data.providerId ?? 'sqs',
                    });
                    return;
                }

                // Mesma TX: efeitos financeiros + registro de inbox (anti dual-write).
                await this.submitService.execute(envelope.data.idempotencyKey, envelope.data, {
                    entityManager: txEm,
                    correlationId: envelope.messageId,
                });

                txEm.persist(
                    txEm.create(InboxMessageDbEntity, {
                        messageId: envelope.messageId,
                        consumerName: this.consumerName,
                        payloadHash,
                        receivedAt: new Date(),
                        processedAt: new Date(),
                    }),
                );
            });

            await this.ack(message.ReceiptHandle);
        } catch (err: unknown) {
            const error = err as { code?: string; status?: number; message?: string; getStatus?: () => number };
            const status = error.status ?? (typeof error.getStatus === 'function' ? error.getStatus() : undefined);
            this.logger.error(`Falha ao processar ${message.MessageId}: ${error.message}`);

            if (this.isTerminalBusinessError({ ...error, status })) {
                await this.ack(message.ReceiptHandle!);
            } else {
                this.metrics.transactionRetriesTotal.inc({ kind: 'sqs_redelivery' });
                // ReceiveCount → DLQ após maxReceiveCount=5 no LocalStack.
                const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
                if (receiveCount >= 5) {
                    this.metrics.dlqMessagesTotal.inc({ queue_name: this.dlqName });
                }
                await this.sqsClient.send(
                    new ChangeMessageVisibilityCommand({
                        QueueUrl: this.queueUrl,
                        ReceiptHandle: message.ReceiptHandle!,
                        VisibilityTimeout: 10,
                    }),
                );
            }
        } finally {
            this.activeJobs--;
        }
    }

    private async ack(receiptHandle: string): Promise<void> {
        await this.sqsClient.send(
            new DeleteMessageCommand({
                QueueUrl: this.queueUrl,
                ReceiptHandle: receiptHandle,
            }),
        );
    }

    private async moveToDlq(message: Message): Promise<void> {
        await this.sqsClient.send(
            new SendMessageCommand({
                QueueUrl: this.dlqUrl,
                MessageBody: message.Body ?? '',
                MessageGroupId: 'poison-messages',
                MessageDeduplicationId: message.MessageId ?? crypto.randomUUID(),
            }),
        );
        this.metrics.dlqMessagesTotal.inc({ queue_name: this.dlqName });
    }

    private isTerminalBusinessError(error: { code?: string; status?: number }): boolean {
        const terminalCodes = [
            'INSUFFICIENT_FUNDS',
            'INSUFFICIENT_FUNDS_FOR_REVERSAL',
            'INVALID_REFERENCE_METADATA',
            'REFERENCE_ALREADY_REVERSED',
            'INVALID_REFUND_TARGET',
            'INVALID_ROLLBACK_TARGET',
            'CURRENCY_MISMATCH',
            'IDEMPOTENCY_PAYLOAD_MISMATCH',
        ];

        return (
            (error.code !== undefined && terminalCodes.includes(error.code)) ||
            error.status === 400 ||
            error.status === 404 ||
            error.status === 409 ||
            error.status === 422
        );
    }
}
