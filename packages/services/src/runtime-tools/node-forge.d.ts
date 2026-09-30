// node-forge 1.4.0 does not have its own types, and @types/node-forge is not installed.
// Only the minimum pki/md subset used by appCaCert.ts is declared here to avoid introducing additional dependencies.
declare module "node-forge" {
  interface ForgeKey {
    n?: unknown;
  }
  interface ForgeKeyPair {
    publicKey: ForgeKey;
    privateKey: ForgeKey;
  }
  interface ForgeCertAttr {
    name?: string;
    shortName?: string;
    type?: string;
    value?: string;
  }
  interface ForgeCertExtension {
    name: string;
    cA?: boolean;
    critical?: boolean;
    keyCertSign?: boolean;
    cRLSign?: boolean;
    digitalSignature?: boolean;
    keyEncipherment?: boolean;
    serverAuth?: boolean;
    clientAuth?: boolean;
  }
  interface ForgeMessageDigest {
    update(msg: string): ForgeMessageDigest;
  }
  interface ForgeCertificate {
    publicKey: ForgeKey;
    serialNumber: string;
    validity: { notBefore: Date; notAfter: Date };
    setSubject(attrs: ForgeCertAttr[]): void;
    setIssuer(attrs: ForgeCertAttr[]): void;
    setExtensions(exts: ForgeCertExtension[]): void;
    sign(key: ForgeKey, md?: ForgeMessageDigest): void;
  }
  interface ForgeStatic {
    pki: {
      rsa: { generateKeyPair(bits: number): ForgeKeyPair };
      createCertificate(): ForgeCertificate;
      certificateToPem(cert: ForgeCertificate): string;
      privateKeyToPem(key: ForgeKey): string;
    };
    md: { sha256: { create(): ForgeMessageDigest } };
  }
  const forge: ForgeStatic;
  export = forge;
}
