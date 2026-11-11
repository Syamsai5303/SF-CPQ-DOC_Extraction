export class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields; // optional { fieldName: message } for form errors
  }
}

export const badRequest = (msg, fields) => new HttpError(400, msg, fields);
export const fieldError = (field, msg) => new HttpError(400, msg, { [field]: msg });
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);
