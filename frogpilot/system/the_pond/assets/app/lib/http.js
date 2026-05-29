export const CSRF_HEADERS = { "X-The-Pond-CSRF": "1" };
const JSON_HEADERS = { "Content-Type": "application/json", ...CSRF_HEADERS };

// Thrown for any non-2xx response, carrying the server's error message and status so callers can
// react and the toast layer can show something meaningful (REWRITE_PLAN §3.4).
export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export async function errorMessage(response) {
  try {
    const data = await response.json();
    return data.error || `Request failed (${response.status})`;
  } catch {
    // Body was not the JSON error envelope (e.g. an HTML error page); fall back to the status.
    return `Request failed (${response.status})`;
  }
}

async function request(method, url, { body, signal } = {}) {
  const options = { method, signal };
  if (body instanceof FormData) {
    // A multipart upload: hand the FormData straight to fetch and let the browser set Content-Type
    // (with its boundary). Setting it ourselves or JSON.stringify-ing the body would break the upload.
    options.headers = CSRF_HEADERS;
    options.body = body;
  } else if (body !== undefined) {
    options.headers = JSON_HEADERS;
    options.body = JSON.stringify(body);
  } else if (method !== "GET") {
    options.headers = CSRF_HEADERS;
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    throw new HttpError(await errorMessage(response), response.status);
  }

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get("Content-Type") || "";
  return contentType.includes("application/json") ? response.json() : response.text();
}

// The one network entry point. Every fetch in the app goes through here, so res.ok checking, JSON
// parsing, error shaping, and abort support are uniform instead of five divergent idioms
// (REWRITE_PLAN §3.4, §5.2).
export const http = {
  del: (url, options) => request("DELETE", url, options),
  get: (url, options) => request("GET", url, options),
  post: (url, body, options) => request("POST", url, { ...options, body }),
  put: (url, body, options) => request("PUT", url, { ...options, body }),
};

// The server's error message when the failure came through as a typed HttpError, otherwise the
// caller's fallback string. Shared so every view shows the backend's message consistently instead of
// re-deriving it (REWRITE_PLAN §5.2).
export function messageFor(error, fallback) {
  return error instanceof HttpError ? error.message : fallback;
}
