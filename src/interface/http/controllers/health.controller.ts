import { Controller, Get, Res, HttpStatus } from '@nestjs/common';

import type { Response } from 'express';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { MetricsService } from '../../../common/metrics/metrics.service';


import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Health & Ops')

@Controller()
export class HealthAndMetricsController {
    constructor(
        private readonly em: EntityManager,
        private readonly sqsClient: SQSClient,
        private readonly metricsService: MetricsService,
    ) { }

    @Get('health/live')
    public getLiveness(): { status: string } {
        return { status: 'UP' };
    }

    @Get('health/ready')
    public async getReadiness(@Res() res: Response): Promise<void> {
        const checks: Record<string, string> = { database: 'DOWN', messaging: 'DOWN' };
        let isHealthy = true;

        try {
            await this.em.getConnection().execute('SELECT 1');
            checks.database = 'UP';
        } catch {
            isHealthy = false;
        }

        try {
            await this.sqsClient.send(
                new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }),
            );
            checks.messaging = 'UP';
        } catch {
            isHealthy = false;
        }

        if (!isHealthy) {
            res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ status: 'DOWN', checks });
            return;
        }

        res.status(HttpStatus.OK).json({ status: 'UP', checks });
    }

    @Get('metrics')
    public async getMetrics(@Res() res: Response): Promise<void> {
        const metricsData = await this.metricsService.getMetricsFormatted();
        res.setHeader('Content-Type', this.metricsService.registry.contentType);
        res.status(HttpStatus.OK).send(metricsData);
    }
}