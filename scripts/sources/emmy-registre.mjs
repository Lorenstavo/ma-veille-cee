import https from "node:https";
import tls from "node:tls";

export const SOURCE_URL = "https://www.emmy.fr/public/registre";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

// www.emmy.fr serves a truncated TLS chain: leaf -> DigiCert Global Root G2,
// skipping the actual issuing intermediate ("DigiCert Global G2 TLS RSA
// SHA256 2020 CA1"). Browsers paper over this via AIA chasing; Node's TLS
// stack does not, so every connection fails with "unable to verify the
// first certificate" (OpenSSL error 21) even though the leaf certificate
// itself is valid and correctly issued. Supplying the missing intermediate
// alongside Node's default trusted roots lets the client complete the chain
// itself. Fetched once from the server's own AIA "CA Issuers" URL
// (http://cacerts.digicert.com/DigiCertGlobalG2TLSRSASHA2562020CA1-1.crt)
// and pinned here so a run never depends on that URL being reachable.
// Re-fetch and update if www.emmy.fr ever rotates to a different issuer.
const DIGICERT_GLOBAL_G2_TLS_RSA_SHA256_2020_CA1 = `-----BEGIN CERTIFICATE-----
MIIEyDCCA7CgAwIBAgIQDPW9BitWAvR6uFAsI8zwZjANBgkqhkiG9w0BAQsFADBh
MQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3
d3cuZGlnaWNlcnQuY29tMSAwHgYDVQQDExdEaWdpQ2VydCBHbG9iYWwgUm9vdCBH
MjAeFw0yMTAzMzAwMDAwMDBaFw0zMTAzMjkyMzU5NTlaMFkxCzAJBgNVBAYTAlVT
MRUwEwYDVQQKEwxEaWdpQ2VydCBJbmMxMzAxBgNVBAMTKkRpZ2lDZXJ0IEdsb2Jh
bCBHMiBUTFMgUlNBIFNIQTI1NiAyMDIwIENBMTCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBAMz3EGJPprtjb+2QUlbFbSd7ehJWivH0+dbn4Y+9lavyYEEV
cNsSAPonCrVXOFt9slGTcZUOakGUWzUb+nv6u8W+JDD+Vu/E832X4xT1FE3LpxDy
FuqrIvAxIhFhaZAmunjZlx/jfWardUSVc8is/+9dCopZQ+GssjoP80j812s3wWPc
3kbW20X+fSP9kOhRBx5Ro1/tSUZUfyyIxfQTnJcVPAPooTncaQwywa8WV0yUR0J8
osicfebUTVSvQpmowQTCd5zWSOTOEeAqgJnwQ3DPP3Zr0UxJqyRewg2C/Uaoq2yT
zGJSQnWS+Jr6Xl6ysGHlHx+5fwmY6D36g39HaaECAwEAAaOCAYIwggF+MBIGA1Ud
EwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFHSFgMBmx9833s+9KTeqAx2+7c0XMB8G
A1UdIwQYMBaAFE4iVCAYlebjbuYP+vq5Eu0GF485MA4GA1UdDwEB/wQEAwIBhjAd
BgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwdgYIKwYBBQUHAQEEajBoMCQG
CCsGAQUFBzABhhhodHRwOi8vb2NzcC5kaWdpY2VydC5jb20wQAYIKwYBBQUHMAKG
NGh0dHA6Ly9jYWNlcnRzLmRpZ2ljZXJ0LmNvbS9EaWdpQ2VydEdsb2JhbFJvb3RH
Mi5jcnQwQgYDVR0fBDswOTA3oDWgM4YxaHR0cDovL2NybDMuZGlnaWNlcnQuY29t
L0RpZ2lDZXJ0R2xvYmFsUm9vdEcyLmNybDA9BgNVHSAENjA0MAsGCWCGSAGG/WwC
ATAHBgVngQwBATAIBgZngQwBAgEwCAYGZ4EMAQICMAgGBmeBDAECAzANBgkqhkiG
9w0BAQsFAAOCAQEAkPFwyyiXaZd8dP3A+iZ7U6utzWX9upwGnIrXWkOH7U1MVl+t
wcW1BSAuWdH/SvWgKtiwla3JLko716f2b4gp/DA/JIS7w7d7kwcsr4drdjPtAFVS
slme5LnQ89/nD/7d+MS5EHKBCQRfz5eeLjJ1js+aWNJXMX43AYGyZm0pGrFmCW3R
bpD0ufovARTFXFZkAdl9h6g4U5+LXUZtXMYnhIHUfoyMo5tS58aI7Dd8KvvwVVo4
chDYABPPTHPbqjc1qCmBaZx2vN4Ye5DUys/vZwP9BFohFrH/6j/f3IL16/RZkiMN
JCqVJUzKoZHm1Lesh3Sz8W2jmdv51b2EQJ8HmA==
-----END CERTIFICATE-----`;

// Node's `ca` TLS option *replaces* the default trust store rather than
// extending it, so the built-in roots must be re-included explicitly
// alongside the missing intermediate.
const TRUSTED_CA_WITH_EMMY_INTERMEDIATE = [...tls.rootCertificates, DIGICERT_GLOBAL_G2_TLS_RSA_SHA256_2020_CA1];

export function isEmmyRegistreUrl(url) {
  try { return new URL(url).hostname === "www.emmy.fr"; } catch { return false; }
}

export function createEmmyRegistreAgent() {
  return new https.Agent({ keepAlive: true, ca: TRUSTED_CA_WITH_EMMY_INTERMEDIATE });
}

const sharedAgent = createEmmyRegistreAgent();

function makeError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function requestOnce({ url, headers, agent, timeoutMs, redirects = 0 }) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") return Promise.reject(makeError("EMMY redirect is not HTTPS", "ERR_INVALID_PROTOCOL"));

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handler(value);
    };
    const request = https.request(parsedUrl, { method: "GET", headers, agent }, response => {
      const statusCode = response.statusCode || 0;
      const location = response.headers.location;
      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) { settle(reject, makeError("Too many EMMY redirects", "ERR_TOO_MANY_REDIRECTS")); return; }
        let nextUrl;
        try { nextUrl = new URL(location, parsedUrl).toString(); } catch { settle(reject, makeError("Invalid EMMY redirect", "ERR_INVALID_REDIRECT")); return; }
        requestOnce({ url: nextUrl, headers, agent, timeoutMs, redirects: redirects + 1 }).then(value => settle(resolve, value), error => settle(reject, error));
        return;
      }
      if (statusCode < 200 || statusCode >= 300) { response.resume(); settle(reject, makeError(`HTTP ${statusCode}`, `HTTP_${statusCode}`)); return; }
      const contentLength = Number(response.headers["content-length"] || 0);
      if (contentLength > MAX_RESPONSE_BYTES) { response.destroy(); settle(reject, makeError(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`, "ERR_RESPONSE_TOO_LARGE")); return; }
      const chunks = [];
      let received = 0;
      response.on("data", chunk => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) response.destroy(makeError(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`, "ERR_RESPONSE_TOO_LARGE"));
        else chunks.push(chunk);
      });
      response.on("error", error => settle(reject, error));
      response.on("end", () => settle(resolve, {
        finalUrl: parsedUrl.toString(),
        etag: response.headers.etag || null,
        lastModified: response.headers["last-modified"] || null,
        body: Buffer.concat(chunks)
      }));
    });
    const timer = setTimeout(() => request.destroy(makeError(`Request timeout after ${timeoutMs}ms`, "ETIMEDOUT")), timeoutMs);
    request.on("error", error => settle(reject, error));
    request.end();
  });
}

export async function checkEmmyRegistre({ url = SOURCE_URL, headers, agent = sharedAgent, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return requestOnce({ url, headers, agent, timeoutMs });
}
