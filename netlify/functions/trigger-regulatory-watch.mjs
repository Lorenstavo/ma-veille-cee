const GITHUB_DISPATCH_URL = "https://api.github.com/repos/Lorenstavo/ma-veille-cee/actions/workflows/regulatory-watch.yml/dispatches";
const GITHUB_API_VERSION = "2026-03-10";
const TIMEZONE = "Europe/Paris";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ERROR_BODY_LENGTH = 500;

function parisTime(date) {
  const values = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});

  return {
    weekday: values.weekday,
    hour: Number(values.hour),
    minute: Number(values.minute),
    display: `${values.weekday} ${values.hour}:${values.minute}:${values.second} (${TIMEZONE})`
  };
}

function isBusinessDispatchWindow(time) {
  return ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].includes(time.weekday)
    && time.hour === 8
    && time.minute >= 0
    && time.minute <= 29;
}

function sanitizeErrorBody(value, token) {
  return String(value || "")
    .replaceAll(token || "__no_token__", "[REDACTED]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_BODY_LENGTH);
}

function responseMessage(status) {
  if (status === 401) return "GitHub dispatch refused: authentication failed (401).";
  if (status === 403) return "GitHub dispatch refused: permission denied (403).";
  if (status === 404) return "GitHub dispatch refused: workflow or repository not found (404).";
  if (status === 422) return "GitHub dispatch refused: invalid workflow dispatch request (422).";
  if (status >= 500) return `GitHub dispatch failed: GitHub server error (${status}).`;
  return `GitHub dispatch returned an unexpected HTTP status (${status}).`;
}

async function readSafeResponseBody(response, token) {
  try {
    return sanitizeErrorBody(await response.text(), token);
  } catch {
    return "";
  }
}

export function getParisTime(date = new Date()) {
  return parisTime(date);
}

export function shouldDispatchAt(date = new Date()) {
  return isBusinessDispatchWindow(parisTime(date));
}

export function createRegulatoryWatchHandler({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  logger = console,
  timeoutMs = REQUEST_TIMEOUT_MS
} = {}) {
  return async function triggerRegulatoryWatch() {
    const token = env.GITHUB_TOKEN_REGULATORY_WATCH;
    const manualTest = env.REGULATORY_WATCH_MANUAL_TEST === "true";
    const localTime = parisTime(now());

    logger.info("Regulatory watch trigger");
    logger.info(`Mode: ${manualTest ? "TEST" : "NORMAL"}`);
    logger.info(`Paris time: ${localTime.display}`);

    if (!token) {
      logger.error("GitHub dispatch skipped: GITHUB_TOKEN_REGULATORY_WATCH is not configured.");
      return new Response("GitHub token not configured.", { status: 500 });
    }

    if (!manualTest && !isBusinessDispatchWindow(localTime)) {
      logger.info("GitHub dispatch skipped: outside the weekday 08:00-08:29 Europe/Paris window.");
      return new Response("Skipped outside dispatch window.", { status: 200 });
    }

    const dryRun = manualTest ? "true" : "false";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(GITHUB_DISPATCH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ref: "main", inputs: { dry_run: dryRun } }),
        signal: controller.signal
      });

      if (response.status === 200 || response.status === 204) {
        logger.info("GitHub dispatch: success");
        logger.info(`dry_run: ${dryRun}`);
        return new Response("GitHub workflow dispatched.", { status: 200 });
      }

      const body = await readSafeResponseBody(response, token);
      logger.error(responseMessage(response.status));
      if (body) logger.error(`GitHub error body (sanitized): ${body}`);
      return new Response(responseMessage(response.status), { status: 502 });
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      const reason = timedOut ? "GitHub dispatch timed out." : "GitHub dispatch failed due to a network error.";
      logger.error(reason);
      return new Response(reason, { status: 502 });
    } finally {
      clearTimeout(timeout);
    }
  };
}

export const handler = createRegulatoryWatchHandler();
export default handler;
