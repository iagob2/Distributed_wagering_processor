import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageDbEntity {
    @PrimaryKey({ type: 'varchar', length: 128 })
    messageId!: string;

    @PrimaryKey({ type: 'varchar', length: 64 })
    consumerName!: string;

    @Property({ type: 'varchar', length: 64 })
    payloadHash!: string;

    @Property({ type: 'timestamptz' })
    receivedAt: Date = new Date();

    @Property({ type: 'timestamptz', nullable: true })
    processedAt?: Date;
}