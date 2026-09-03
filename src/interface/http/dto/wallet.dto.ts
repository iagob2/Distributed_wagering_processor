import { IsString, IsNotEmpty, ValidateNested, Matches } from 'class-validator';
import { Type } from 'class-transformer';

export class MoneyDto {
    @IsString()
    @Matches(/^\d+(\.\d{2})?$/, {
        message: 'amount deve ser string decimal com até 2 casas (ex: "100.00")',
    })
    amount!: string;

    @IsString()
    @IsNotEmpty()
    currency!: string;
}

export class CreateWalletDto {
    @IsString()
    @IsNotEmpty()
    playerId!: string;

    @ValidateNested()
    @Type(() => MoneyDto)
    initialBalance!: MoneyDto;
}