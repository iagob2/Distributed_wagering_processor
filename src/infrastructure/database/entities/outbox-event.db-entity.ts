import { Entity, PrimaryKey, Property, Index } from '@mikro-orm/core';

@Entity({ tableName: 'outbox_events' })
export class OutboxEventDbEntity {
    @PrimaryKey({ type: 'uuid' })
    id!: string;

    @Property({ type: 'varchar', length: 128 })
    aggregateId!: string;

    @Property({ type: 'varchar', length: 100 })
    eventType!: string;

    @Property({ type: 'jsonb' })
    payload!: Record<string, unknown>;

    @Property({ type: 'timestamptz' })
    occurredAt!: Date;

    @Property({ type: 'integer', default: 0 })
    attempts: number = 0;

    @Index()
    @Property({ type: 'timestamptz' })
    nextAttemptAt: Date = new Date();

    @Property({ type: 'timestamptz', nullable: true })
    publishedAt?: Date;

    @Property({ type: 'timestamptz' })
    createdAt: Date = new Date();
}