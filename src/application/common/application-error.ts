export class ApplicationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}
