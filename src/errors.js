export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Express error handler: every error leaves the API as { error: { code, message } }. */
export function errorHandler(err, _req, res, _next) {
  if (err?.name === "ZodError") {
    const details = err.issues.map((i) => ({
      field: i.path.join("."),
      message: i.message,
    }));
    return res
      .status(400)
      .json({
        error: {
          code: "invalid_input",
          message: details[0]?.message || "Please check the form.",
          details,
        },
      });
  }
  if (err?.type === "entity.parse.failed")
    return res
      .status(400)
      .json({
        error: {
          code: "invalid_json",
          message: "The request body is not valid JSON.",
        },
      });
  if (err?.type === "entity.too.large")
    return res
      .status(413)
      .json({
        error: { code: "too_large", message: "The request is too large." },
      });
  if (err instanceof HttpError)
    return res
      .status(err.status)
      .json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      });
  console.error(err);
  res
    .status(500)
    .json({
      error: {
        code: "server_error",
        message:
          "Something went wrong. Please try again or contact the clinic.",
      },
    });
}
