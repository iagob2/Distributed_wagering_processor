export abstract class DomainError extends Error {
    public abstract readonly code: string;

    constructor(message: string) {
        super(message);
        this.name = this.constructor.name;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export class InvalidMoneyFormatError extends DomainError {
    public readonly code = 'INVALID_MONEY_FORMAT';
    constructor(message: string) {
        super(message);
    }
}

export class CurrencyMismatchError extends DomainError {
    public readonly code = 'CURRENCY_MISMATCH';
    constructor(currentCurrency: string, expectedCurrency: string) {
        super(`Conflito de moedas: operação entre ${currentCurrency} e ${expectedCurrency} é proibida.`);
    }
}

export class NegativeMoneyError extends DomainError {
    public readonly code = 'NEGATIVE_MONEY';
    constructor(message = 'Valores monetários negativos não são permitidos nesta operação.') {
        super(message);
    }
}

export class InsufficientFundsError extends DomainError {
    public readonly code = 'INSUFFICIENT_FUNDS';
    constructor(currentBalance: string, requestedAmount: string) {
        super(`Saldo insuficiente: saldo atual ${currentBalance}, valor solicitado ${requestedAmount}.`);
    }
}

export class InvalidTransactionStateError extends DomainError {
    public readonly code = 'INVALID_TRANSACTION_STATE';
    constructor(message: string) {
        super(message);
    }
}