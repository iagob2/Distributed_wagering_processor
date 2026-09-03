import { IsString, IsNotEmpty, IsEnum, ValidateNested, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { WagerTransactionKind } from '../../../domain/entities/wager-transaction.entity';
import { MoneyDto } from './wallet.dto';

export class SubmitWagerDto {
    @IsString()
    @IsNotEmpty()
    providerId!: string;

    @IsString()
    @IsNotEmpty()
    externalTransactionId!: string;

    @IsString()
    @IsNotEmpty()
    playerId!: string;

    @IsString()
    @IsNotEmpty()
    walletId!: string;

    @IsString()
    @IsNotEmpty()
    roundId!: string;

    @IsString()
    @IsNotEmpty()
    gameId!: string;

    @IsEnum(WagerTransactionKind)
    kind!: WagerTransactionKind;

    @ValidateNested()
    @Type(() => MoneyDto)
    money!: MoneyDto;

    @IsString()
    @IsOptional()
    referenceExternalTransactionId?: string;
}
