/**
 * Whether a Host header names this machine in a way a web page cannot fake: localhost, an IP address,
 * a name listed in ALLOWED_HOSTS, or (when shared on the LAN) an mDNS name such as my-mac.local.
 * A page that rebinds its own domain to 127.0.0.1 (DNS rebinding) still sends that domain, so it is refused.
 */
export function allowedHost(header: string | undefined, extra: readonly string[] = [], lan = false): boolean {
  if (!header) return false;
  let host = header.trim().toLowerCase();
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'));
  else host = host.replace(/:\d+$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || (lan && host.endsWith('.local'))) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(':') && /^[\da-f:.]+$/.test(host)) return true;
  return extra.includes(host);
}

/** The host name of a Host header, for messages. */
export function hostName(header: string | undefined): string {
  const host = (header ?? '').trim();
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
}
