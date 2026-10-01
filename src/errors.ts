/** Stable, machine-readable error codes returned by API and CLI. */
export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNPROCESSABLE"
  | "PERSISTENCE";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function validationError(message: string, details?: unknown): AppError {
  return new AppError("VALIDATION", message, details);
}
