#!/usr/bin/env node
// Temporary diagnostic script — not part of the production watch pipeline.
// Run once from a GitHub Actions runner to characterise the ecologie.gouv.fr
// connectivity failure (DNS vs TCP connect vs TLS vs slow-server), then
// delete this file and its throwaway workflow.
import dns from "node:dns/promises";
import net from "node:net";
import https from "node:https";
import { setDefaultResultOrder } from "node:dns";

setDefaultResultOrder("ipv4first");

function log(...args) {
  console.log(`[diagnose]`, ...args);
}

async function diagnoseDns(hostname) {
  try {
    const start = Date.now();
    const addresses = await dns.resolve4(hostname);
    log(`DNS A ${hostname}: ${addresses.join(", ")} (${Date.now() - start}ms)`);
    return addresses;
  } catch (error) {
    log(`DNS A ${hostname} FAILED: ${error.message}`);
    return [];
  }
}

function diagnoseTcpConnect(address, port, timeoutMs) {
  return new Promise(resolve => {
    const start = Date.now();
    const socket = net.createConnection({ host: address, port, timeout: timeoutMs, family: 4 });
    socket.once("connect", () => {
      log(`TCP connect ${address}:${port}: OK (${Date.now() - start}ms)`);
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      log(`TCP connect ${address}:${port}: TIMEOUT after ${Date.now() - start}ms`);
      socket.destroy();
      resolve(false);
    });
    socket.once("error", error => {
      log(`TCP connect ${address}:${port}: ERROR ${error.code || error.message} after ${Date.now() - start}ms`);
      resolve(false);
    });
  });
}

function diagnoseHttps(hostname, path, timeoutMs) {
  return new Promise(resolve => {
    const start = Date.now();
    const request = https.request({ hostname, path, method: "GET", family: 4, timeout: timeoutMs, headers: { "user-agent": "ma-veille-cee-diagnostic/1.0" } }, response => {
      log(`HTTPS ${hostname}${path}: status=${response.statusCode} (${Date.now() - start}ms)`);
      response.resume();
      response.on("end", () => resolve(true));
    });
    request.on("timeout", () => {
      log(`HTTPS ${hostname}${path}: TIMEOUT after ${Date.now() - start}ms`);
      request.destroy();
      resolve(false);
    });
    request.on("error", error => {
      log(`HTTPS ${hostname}${path}: ERROR ${error.code || error.message} after ${Date.now() - start}ms`);
      resolve(false);
    });
    request.end();
  });
}

async function main() {
  log("=== ecologie.gouv.fr ===");
  const ecologieAddresses = await diagnoseDns("www.ecologie.gouv.fr");
  for (const address of ecologieAddresses) await diagnoseTcpConnect(address, 443, 15_000);
  await diagnoseHttps("www.ecologie.gouv.fr", "/politiques-publiques/energies", 45_000);

  log("=== control: boe.es (known-good from outside CI) ===");
  const boeAddresses = await diagnoseDns("www.boe.es");
  for (const address of boeAddresses) await diagnoseTcpConnect(address, 443, 15_000);

  log("=== control: ccomptes.fr ===");
  const ccomptesAddresses = await diagnoseDns("www.ccomptes.fr");
  for (const address of ccomptesAddresses) await diagnoseTcpConnect(address, 443, 15_000);

  log("=== outbound IP as seen by a third party ===");
  await diagnoseHttps("api.ipify.org", "/", 10_000);
}

main().catch(error => log("FATAL", error.message));
