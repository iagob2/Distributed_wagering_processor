import {
    Controller,
    Post,
    Get,
    Param,
    Body,
    Headers,
    Res,
    UseGuards,
    UseInterceptors,
    NotFoundException,
} from '@nestjs/common';
import type { Response } from 'express';
import { EntityManager } from '@mikro-orm/postgresql';
import { SubmitWagerDto } from '../dto/wager.dto';
import { SubmitWagerTransactionService } from '../../../application/services/submit-wager-transaction.service';
import { IdempotencyValidationInterceptor } from '../../../common/interceptors/idempotency.interceptor';

import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';

import { MetricsService } from '../../../common/metrics/metrics.service';
import { WagerTransactionDbEntity } from '../../../infrastructure/database/entities/wager-transaction.db-entity';
import { Money } from '../../../domain/value-objects/money.vo';

import { ApiTags, ApiOperation, ApiBearerAuth, ApiSecurity, ApiHeader, ApiResponse } from '@nestjs/swagger';

@ApiTags('Wagering')
@ApiBearerAuth('bearer-token')
@ApiSecurity('Idempotency-Key')


@Controller()
@UseGuards(JwtAuthGuard)
export class WageringController {
    constructor(
        private readonly submitService: SubmitWagerTransactionService,
        private readonly metricsService: MetricsService,
        private readonly em: EntityManager,
    ) { }

    @Post('wagering/transactions')
    @ApiOperation({
        summary: 'Submeter transação de aposta',
        description: 'Processa débitos (BET) e créditos (WIN/REFUND) com garantia de concorrência e idempotência.',
    })
    @ApiHeader({
        name: 'idempotency-key',
        description: 'Chave única de idempotência. Impede cobrança duplicada caso a mesma requisição seja reenviada.',
        example: 'provider-smoke:tx-001',
        required: true,
    })
    @UseInterceptors(IdempotencyValidationInterceptor)
    public async submitTransaction(
        @Headers('idempotency-key') idempotencyKey: string,
        @Body() dto: SubmitWagerDto,
        @Res() res: Response,
    ) {
        const start = performance.now();

        const { statusCode, body } = await this.submitService.execute(idempotencyKey, dto);

        // Telemetria Prometheus
        const durationSec = (performance.now() - start) / 1000;
        this.metricsService.processingDurationSeconds.observe({ operation: dto.kind }, durationSec);
        this.metricsService.transactionsTotal.inc({
            status: body.status,
            kind: dto.kind,
            provider: dto.providerId,
        });

        if (body.idempotentReplay) {
            this.metricsService.duplicateTransactionsTotal.inc({ provider: dto.providerId });
        }

        res.status(statusCode).json(body);
    }

    @Get('wagering/transactions/:transactionId')
    public async getTransactionById(@Param('transactionId') transactionId: string) {
        const tx = await this.em.findOne(WagerTransactionDbEntity, { id: transactionId });
        if (!tx) throw new NotFoundException(`Transação ${transactionId} não encontrada.`);

        return {
            id: tx.id,
            providerId: tx.providerId,
            externalTransactionId: tx.externalTransactionId,
            walletId: tx.walletId,
            playerId: tx.playerId,
            roundId: tx.roundId,
            kind: tx.kind,
            money: Money.fromCents(tx.amount, tx.currency).toJSON(),
            status: tx.status,
            failureCode: tx.failureCode,
            createdAt: tx.createdAt,
            processedAt: tx.processedAt,
        };
    }

    @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
    public async getByProviderExternalId(
        @Param('providerId') providerId: string,
        @Param('externalTransactionId') externalTransactionId: string,
    ) {
        const tx = await this.em.findOne(WagerTransactionDbEntity, {
            providerId,
            externalTransactionId,
        });

        if (!tx) throw new NotFoundException('Transação não localizada para o provedor informado.');

        return {
            id: tx.id,
            providerId: tx.providerId,
            externalTransactionId: tx.externalTransactionId,
            status: tx.status,
            money: Money.fromCents(tx.amount, tx.currency).toJSON(),
            createdAt: tx.createdAt,
        };
    }
}