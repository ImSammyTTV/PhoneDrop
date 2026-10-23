// Helpers for finding this computer on the local network and on Tailscale,
// and for telling your own devices apart from everyone else.
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export function isLoopback(addr = '') {
  return addr === '::1' || /^(::ffff:)?127\./.test(addr);
}

export function isPrivateAddress(addr = '') {
  const a = addr.replace(/^::ffff:/, '');
  if (isLoopback(a) || /^(10|192\.168|169\.254)\./.test(a)) return true;
  const m = a.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return /^(fc|fd|fe[89ab])/i.test(a); // IPv6 unique-local and link-local
}

// Tailscale gives each device an address in 100.64.0.0/10 (and fd7a:115c:a1e0::/48).
export function isTailscaleAddress(addr = '') {
  const a = addr.replace(/^::ffff:/, '');
  const m = a.match(/^100\.(\d+)\./);
  return (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) || /^fd7a:115c:a1e0:/i.test(a);
}

// Who the hub talks to: devices on your home network or your tailnet.
export function isAllowedAddress(addr = '') {
  return isPrivateAddress(addr) || isTailscaleAddress(addr);
}

// The name other devices on the Wi-Fi can reach this computer by (Bonjour/mDNS).
export function localHostname() {
  if (process.platform === 'darwin') {
    try {
      return `${execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim()}.local`;
    } catch {}
  }
  const host = os.hostname();
  return host.endsWith('.local') ? host : `${host.split('.')[0]}.local`;
}

// A friendly default device name, e.g. "Alex's MacBook Pro" or "DESKTOP-ABC123".
export function computerName() {
  if (process.platform === 'darwin') {
    try {
      return execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim();
    } catch {}
  }
  return process.env.COMPUTERNAME || os.hostname().split('.')[0];
}

const ipv4Addresses = () => Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i.family === 'IPv4' && !i.internal)
  .map((i) => i.address);

export function lanAddresses() {
  return ipv4Addresses().filter(isPrivateAddress);
}

export function tailscaleAddresses() {
  return ipv4Addresses().filter(isTailscaleAddress);
}
