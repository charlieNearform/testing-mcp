export type ErrorCode =
  | "UnknownProject"
  | "InvalidConfig"
  | "WorkerFailure"
  | "PlanExpired"
  | "ValidationError"
  | "DaemonUnavailable";

export interface AppError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export function toAppError(
  code: ErrorCode,
  message: string,
  details?: unknown
): AppError {
  return { code, message, details };
}
