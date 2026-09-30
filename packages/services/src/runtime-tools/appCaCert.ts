import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";
import { getAppConfigDir } from "../paths.js";

// Self-signed CA for app scenarios (different from the debug packet capture agent set, only used in debug environment).
// When the program is started for the first time, a self-signed root CA is generated. The public key certificate is trusted by the agent sub-process through NODE_EXTRA_CA_CERTS.
// The private key is used by the egress proxy to do TLS re-signing. If it already exists, reuse it as it is to ensure that the certificate fingerprint is stable and does not drift after being trusted.

const APP_CA_CERT_FILE = "zcode-network-ca.pem";
const APP_CA_KEY_FILE = "zcode-network-ca.key";
const CA_VALIDITY_YEARS = 10;
const CA_KEY_BITS = 2048;

interface AppCaCertPaths {
  certPath: string;
  keyPath: string;
}

function getAppCaCertPaths(): AppCaCertPaths {
  const certDir = join(getAppConfigDir(), "certs");
  return {
    certPath: join(certDir, APP_CA_CERT_FILE),
    keyPath: join(certDir, APP_CA_KEY_FILE),
  };
}

/**
 * Ensures the app self-signed CA exists, generating one when it is missing. Returns the
 * certificate (public key) path.
 * Idempotent: when both the certificate and the private key already exist it returns
 * immediately without regenerating them.
 */
export function ensureAppCaCert(): string {
  const { certPath, keyPath } = getAppCaCertPaths();
  if (existsSync(certPath) && existsSync(keyPath)) {
    return certPath;
  }

  const { certPem, keyPem } = generateSelfSignedCa();
  mkdirSync(join(getAppConfigDir(), "certs"), { recursive: true });
  // The private key contains sensitive material, and the permissions are tightened to 0600; the public key certificate is readable.
  writeFileSync(certPath, certPem, { mode: 0o644 });
  writeFileSync(keyPath, keyPem, { mode: 0o600 });
  return certPath;
}

function generateSelfSignedCa(): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(CA_KEY_BITS);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  // Use a cryptographic random number as the sequence number, and clear the first byte to avoid being parsed into a negative number.
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  cert.serialNumber = serial.toString("hex");

  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + CA_VALIDITY_YEARS);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  const attrs = [
    { name: "commonName", value: "ZCode Network CA" },
    { name: "organizationName", value: "ZCode" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // Self-signed: issuer == subject
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", critical: true, keyCertSign: true, cRLSign: true, digitalSignature: true },
    { name: "subjectKeyIdentifier" },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}
