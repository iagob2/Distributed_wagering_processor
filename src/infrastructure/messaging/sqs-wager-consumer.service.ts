import {
    Injectable,
    OnModuleInit,
    OnModuleDestroy,
    Logger,
} from '@nestjs/common';
import {
    SQSClient,
    ReceiveMessageCommand,
    DeleteMessageCommand,
    ChangeMessageVisibilityCommand,
    Message,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { SubmitWagerTransactionService } from '../../application/services/submit-wager-transaction.service';
import { InboxMessageDbEntity } from '../database/entities/inbox-message.db-entity';
import { CanonicalJsonHasher } from '../../common/utils/canonical-json-hasher.util';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction.entity';

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

@Injectable()
export class SqsWagerConsumerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(SqsWagerConsumerService.name);
    private readonly consumerName = 'wager-engine-sqs-consumer';
    private readonly queueUrl =
        process.env.SQS_MAIN_QUEUE_URL ||
        'http://localhost:4566/000000000000/wager-transactions.fifo';

    private isRunning = false;
    private activeJobs = 0;

    constructor(
        private readonly sqsClient: SQSClient,
        private readonly em: EntityManager,
        private readonly submitService: SubmitWagerTransactionService,
    ) { }

    public onModuleInit(): void {
        this.isRunning = true;
        this.poll();
    }

    public async onModuleDestroy(): Promise<void> {
        this.logger.log('Recebido comando de shutdown. Aguardando conclusão dos workers ativos...');
        this.isRunning = false;

        // Graceful Shutdown: aguarda transações em andamento (limite de 10 segundos)
        const deadline = Date.now() + 10000;
        while (this.activeJobs > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
        this.logger.log('Consumidor SQS encerrado de forma limpa.');
    }

    private async poll(): Promise<void> {
        while (this.isRunning) {
            try {
                const response = await this.sqsClient.send(
                    new ReceiveMessageCommand({
                        QueueUrl: this.queueUrl,
                        MaxNumberOfMessages: 5,
                        WaitTimeSeconds: 10, // Long Polling nativo do SQS
                        VisibilityTimeout: 30,
                    }),
                );

                if (response.Messages && response.Messages.length > 0) {
                    await Promise.all(response.Messages.map((msg) => this.handleMessage(msg)));
                }
            } catch (err: unknown) {
                if (this.isRunning) {
                    const message = err instanceof Error ? err.message : String(err);
                    this.logger.error(`Erro no loop de consumo SQS: ${message}`);
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                }
            }
        }
    }

    private async handleMessage(message: Message): Promise<void> {
        this.activeJobs++;
        try {
            if (!message.Body || !message.ReceiptHandle) return;

            const envelope: SqsMessageEnvelope = JSON.parse(message.Body);
            const payloadHash = CanonicalJsonHasher.hash(
                envelope.data as unknown as Record<string, unknown>,
            );

            const forkEm = this.em.fork();

            // Execução ACID: Checagem de Inbox + Débito/Crédito + Registro de Inbox
            const result = await forkEm.transactional(async (txEm) => {
                const existingInbox = await txEm.findOne(InboxMessageDbEntity, {
                    messageId: envelope.messageId,
                    consumerName: this.consumerName,
                });

                if (existingInbox) {
                    this.logger.warn(`Mensagem duplicada ${envelope.messageId} ignorada pelo Inbox.`);
                    return { duplicate: true };
                }

                // Executa o mesmo Use Case chamado pela API HTTP
                await this.submitService.execute(envelope.data.idempotencyKey, envelope.data);

                // Registra o Inbox na mesma transação contábil
                const inboxDb = txEm.create(InboxMessageDbEntity, {
                    messageId: envelope.messageId,
                    consumerName: this.consumerName,
                    payloadHash,
                    receivedAt: new Date(),
                    processedAt: new Date(),
                });

                txEm.persist(inboxDb);
                return { duplicate: false };
            });

            // Ack estrito pós-commit: remove da fila com garantia de entrega
            await this.sqsClient.send(
                new DeleteMessageCommand({
                    QueueUrl: this.queueUrl,
                    ReceiptHandle: message.ReceiptHandle,
                }),
            );

            if (!result.duplicate) {
                this.logger.log(`Mensagem SQS ${envelope.messageId} processada e confirmada (ACK).`);
            }
        } catch (err: unknown) {
            const error = err as { code?: string; status?: number; message?: string };

            // Erros terminais de negócio sofrem ACK imediato para não travar mensagens na fila FIFO
            if (this.isTerminalBusinessError(error)) {
                this.logger.warn(
                    `Erro terminal de negócio na mensagem SQS ${message.MessageId}. Realizando ACK. Motivo: ${error.message}`,
                );
                await this.sqsClient.send(
                    new DeleteMessageCommand({
                        QueueUrl: this.queueUrl,
                        ReceiptHandle: message.ReceiptHandle!,
                    }),
                );
            } else {
                // Falhas transitórias (banco fora do ar, lock contention): devolve visibilidade para reprocessar
                this.logger.error(`Falha transitória na mensagem ${message.MessageId}. Reprogramando visibilidade.`);
                await this.sqsClient.send(
                    new ChangeMessageVisibilityCommand({
                        QueueUrl: this.queueUrl,
                        ReceiptHandle: message.ReceiptHandle!,
                        VisibilityTimeout: 5,
                    }),
                );
            }
        } finally {
            this.activeJobs--;
        }
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
            error.status === 409 ||
            error.status === 422
        );
    }
}