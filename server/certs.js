// Creates the hub's private certificate authority and HTTPS certificate, so
// phones can open the PhoneDrop app securely over your Wi-Fi. Pure JavaScript,
// so it works the same on Mac and Windows.
//
// The authority is name-constrained: even if its key leaked, it could only
// vouch for .local names, private network and Tailscale addresses, never real
// websites. It is created once; the server certificate is re-issued whenever
// this computer's name or addresses change, so phones never need setting up again.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import forge from 'node-forge';
import { lanAddresses, localHostname, tailscaleAddresses } from './network.js';

const { asn1, pki } = forge;
const DAY = 24 * 60 * 60 * 1000;
// Bumped when the authority's constraints change; version 2 added Tailscale.
const CA_VERSION = '2';

function newKeyPair() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }));
  return { privateKey: key, publicKey: pki.setRsaPublicKey(key.n, key.e) };
}

function newCertificate(publicKey, days) {
  const cert = pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = `01${crypto.randomBytes(15).toString('hex')}`; // positive, unique
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + days * DAY);
  return cert;
}

const ipBytes = (ip) => String.fromCharCode(...ip.split('.').map(Number));

// NameConstraints (RFC 5280 §4.2.1.10), which node-forge has no builder for.
function nameConstraints() {
  const subtree = (generalName) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [generalName]);
  const dns = (name) => subtree(asn1.create(asn1.Class.CONTEXT_SPECIFIC, 2, false, name));
  const ip = (net, mask) => subtree(asn1.create(asn1.Class.CONTEXT_SPECIFIC, 7, false, ipBytes(net) + ipBytes(mask)));
  const permitted = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
    dns('local'),
    dns('localhost'),
    ip('10.0.0.0', '255.0.0.0'),
    ip('172.16.0.0', '255.240.0.0'),
    ip('192.168.0.0', '255.255.0.0'),
    ip('127.0.0.0', '255.0.0.0'),
    ip('100.64.0.0', '255.192.0.0'), // Tailscale
  ]);
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [permitted]);
}

function createAuthority(host) {
  const keys = newKeyPair();
  const cert = newCertificate(keys.publicKey, 3650);
  const name = [{ name: 'organizationName', value: 'PhoneDrop' }, { name: 'commonName', value: `PhoneDrop Local CA (${host})` }];
  cert.setSubject(name);
  cert.setIssuer(name);
  cert.setExtensions([
    { name: 'basicConstraints', critical: true, cA: true, pathLenConstraint: 0 },
    { name: 'keyUsage', critical: true, keyCertSign: true, cRLSign: true },
    { name: 'subjectKeyIdentifier' },
    { id: '2.5.29.30', critical: true, value: nameConstraints() },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

function createServerCert(ca, host, ips) {
  const keys = newKeyPair();
  // 825 days is the longest validity iPhones accept.
  const cert = newCertificate(keys.publicKey, 825);
  cert.setSubject([{ name: 'commonName', value: host }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', critical: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: ca.cert.generateSubjectKeyIdentifier().getBytes() },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 2, value: host },
        ...['127.0.0.1', ...ips].map((ip) => ({ type: 7, ip })),
      ],
    },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

// Returns { key, cert } PEM strings for the HTTPS server, creating or
// refreshing files in `dir` as needed.
export function ensureCerts(dir) {
  const file = (name) => path.join(dir, name);
  const host = localHostname();
  const ips = [...lanAddresses(), ...tailscaleAddresses()];
  const names = ['localhost', host, '127.0.0.1', ...ips].join(',');
  fs.mkdirSync(dir, { recursive: true });

  let ca;
  try {
    if (fs.readFileSync(file('ca-version.txt'), 'utf8') !== CA_VERSION) throw new Error('outdated authority');
    ca = { cert: pki.certificateFromPem(fs.readFileSync(file('ca.pem'), 'utf8')), key: pki.privateKeyFromPem(fs.readFileSync(file('ca.key'), 'utf8')) };
  } catch {
    ca = createAuthority(host);
    fs.writeFileSync(file('ca.key'), pki.privateKeyToPem(ca.key), { mode: 0o600 });
    fs.writeFileSync(file('ca.pem'), pki.certificateToPem(ca.cert));
    fs.writeFileSync(file('ca-version.txt'), CA_VERSION);
    fs.rmSync(file('names.txt'), { force: true });
  }

  const current = fs.existsSync(file('names.txt')) ? fs.readFileSync(file('names.txt'), 'utf8') : '';
  if (current !== names || !fs.existsSync(file('cert.pem')) || !fs.existsSync(file('key.pem'))) {
    const server = createServerCert(ca, host, ips);
    fs.writeFileSync(file('key.pem'), pki.privateKeyToPem(server.key), { mode: 0o600 });
    fs.writeFileSync(file('cert.pem'), pki.certificateToPem(server.cert));
    fs.writeFileSync(file('names.txt'), names);
  }

  return { key: fs.readFileSync(file('key.pem'), 'utf8'), cert: fs.readFileSync(file('cert.pem'), 'utf8') };
}
