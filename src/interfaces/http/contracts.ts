export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    detail?: string;
  };
}
