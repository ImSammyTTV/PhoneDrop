// Picks how to reach the hub, shared by the phone web app and the desktop.
//
// Every known address is tried at once. Home-network addresses (tier 0) beat
// Tailscale addresses (tier 1): if Tailscale answers first, we wait briefly
// in case Wi-Fi answers too, so at home you always get the direct Wi-Fi path.
//
// candidates: [{ url, tier }] in order of preference within each tier.
// open(url) must return { promise, abort } where promise resolves to an open socket.
export function connectPreferred(candidates, open, { graceMs = 1500, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const attempts = candidates.map((c) => ({ ...c, status: 'pending', socket: null, handle: null }));
    let settled = false;
    let graceTimer = null;

    const best = () => attempts.filter((a) => a.status === 'open').sort((a, b) => a.tier - b.tier)[0] || null;

    function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(deadline);
      const winner = best();
      for (const a of attempts) if (a !== winner) a.handle?.abort();
      if (winner) resolve({ socket: winner.socket, url: winner.url, tier: winner.tier });
      else reject(new Error("Couldn't reach the hub"));
    }

    function evaluate() {
      const winner = best();
      if (!winner) {
        if (attempts.every((a) => a.status === 'failed')) settle();
        return;
      }
      if (!attempts.some((a) => a.status === 'pending' && a.tier < winner.tier)) settle();
      else graceTimer ??= setTimeout(settle, graceMs);
    }

    const deadline = setTimeout(settle, timeoutMs);
    if (!attempts.length) settle();
    for (const a of attempts) {
      a.handle = open(a.url);
      a.handle.promise.then(
        (socket) => {
          a.socket = socket;
          a.status = 'open';
          if (settled) a.handle.abort();
          else evaluate();
        },
        () => {
          a.status = 'failed';
          if (!settled) evaluate();
        },
      );
    }
  });
}

// Turns the hub's advertised addresses into connection candidates.
// endpoints: { lan: [http urls], tailscale: [http urls], httpsPort }
export function hubCandidates(endpoints, { secure = false, extra = [] } = {}) {
  const toWs = (httpUrl) => {
    const url = new URL(httpUrl);
    if (secure) {
      url.protocol = 'wss:';
      if (endpoints?.httpsPort) url.port = String(endpoints.httpsPort);
    } else {
      url.protocol = 'ws:';
    }
    return `${url.origin}/ws`;
  };
  const seen = new Set();
  const out = [];
  for (const [list, tier] of [[extra, null], [endpoints?.lan || [], 0], [endpoints?.tailscale || [], 1]]) {
    for (const item of list) {
      const httpUrl = typeof item === 'string' ? item : item.url;
      const url = toWs(httpUrl);
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, tier: tier ?? item.tier ?? (isTailscaleHost(new URL(httpUrl).hostname) ? 1 : 0) });
    }
  }
  return out;
}

export function isTailscaleHost(host) {
  const m = host.match(/^100\.(\d+)\./);
  return (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) || host.endsWith('.ts.net');
}

// "ws://host:port/ws" -> "http://host:port" (and wss -> https), for file transfers.
export const httpBase = (wsUrl) => wsUrl.replace(/^ws/, 'http').replace(/\/ws.*$/, '');
