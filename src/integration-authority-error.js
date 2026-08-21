export class IntegrationAuthorityError extends Error {
  constructor(code, message, { status = 503, details = {} } = {}) {
    super(message);
    this.name = "IntegrationAuthorityError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
    this.details = details;
  }
}

export function authorityFail(code, message, { status = 503, details = {} } = {}) {
  throw new IntegrationAuthorityError(code, message, { status, details });
}
