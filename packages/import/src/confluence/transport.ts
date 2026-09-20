/**
 * The HTTPS transport of an import: a `fetch`-shaped function whose connection
 * can only be made to a public address.
 *
 * Checking an address and then connecting to its name are two resolutions, and
 * a name server that answers "public" to the first and "127.0.0.1" to the second
 * walks straight through the check — DNS rebinding. The only place the check
 * cannot be raced is the one resolution the socket itself uses. So this
 * transport hands `https.request` a `lookup` of its own: it resolves the name,
 * refuses unless *every* address is public, and returns what it checked. The
 * address that was validated is the address that is dialled; there is no second
 * lookup to answer differently.
 *
 * TLS is untouched by this: the certificate is still verified against the host
 * name, and SNI still carries it. `https.request` does not follow redirects, so
 * a `3xx` comes back as the response it is. A response body is read up to a cap
 * and the socket destroyed past it, so the size of an answer is not the remote
 * server's to choose.
 *
 * A host name the operator has listed (`privateHosts`) may resolve to a private
 * range; nothing makes the loopback or link-local reachable. See `address.ts`.
 *
 * Literal IP addresses never reach `lookup` — there is nothing to resolve — and
 * are refused before a request is made, by `assertPublicHost`.
 */

import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

import { ImportError } from '../limits';
import { isAddressAllowed, NO_PRIVATE_HOSTS } from './address';
import type { PrivateHosts } from './address';

/** Resolves a name to every address it has. Replaced in tests. */
export type ResolveAll = (hostname: string) => Promise<LookupAddress[]>;

const NON_PUBLIC = 'ENONPUBLIC';

/** One wording for the refusal, wherever it is made. */
export const NON_PUBLIC_MESSAGE =
  'The Confluence address must be a public host. Addresses on a private network, the loopback and link-local ranges are not imported from. A Confluence on your own network can be opened by the operator of this wiki, by host name, with IMPORT_CONFLUENCE_PRIVATE_HOSTS.';

function systemResolve(hostname: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
}

/**
 * A `lookup` for `net.connect` that answers only with public addresses.
 *
 * It honours both calling conventions: a single address, and — what Node asks
 * for when it races address families — all of them. Either way the socket is
 * given exactly the addresses that were checked.
 */
export function createGuardedLookup(
  resolve: ResolveAll = systemResolve,
  privateHosts: PrivateHosts = NO_PRIVATE_HOSTS,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (
          addresses.length === 0 ||
          addresses.some((entry) => !isAddressAllowed(hostname, entry.address, privateHosts))
        ) {
          const error = Object.assign(new Error(`${hostname} does not resolve to a public address`), {
            code: NON_PUBLIC,
          });
          callback(error, '', 0);
          return;
        }
        if (typeof options === 'object' && options !== null && options.all === true) {
          (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses);
          return;
        }
        const first = addresses[0]!;
        callback(null, first.address, first.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, '', 0),
    );
  };
}

export interface GuardedFetchOptions {
  resolve?: ResolveAll;
  /** Host names the operator has opened on a private network. Empty by default. */
  privateHosts?: PrivateHosts;
  /** Largest response body read, in bytes. */
  maxResponseBytes: number;
  /** How long one request may take end to end, in ms. */
  timeoutMs?: number;
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * A `fetch` for `https:` URLs that connects to public addresses only, follows
 * no redirect, and reads no more than `maxResponseBytes`.
 */
export function createGuardedFetch(options: GuardedFetchOptions): typeof fetch {
  const lookup = createGuardedLookup(options.resolve, options.privateHosts);
  const timeoutMs = options.timeoutMs ?? 60_000;

  const guarded = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.protocol !== 'https:') {
        reject(new ImportError('validation', 'The Confluence address must use https'));
        return;
      }

      const outgoing = httpsRequest(
        url,
        {
          method: init?.method ?? 'GET',
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          lookup,
          timeout: timeoutMs,
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let total = 0;
          incoming.on('data', (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > options.maxResponseBytes) {
              incoming.destroy();
              reject(
                new ImportError('unavailable', 'Confluence answered with more than this import will read'),
              );
              return;
            }
            chunks.push(chunk);
          });
          incoming.on('error', reject);
          incoming.on('end', () => {
            const status = incoming.statusCode ?? 502;
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (value === undefined) continue;
              headers.set(name, Array.isArray(value) ? value.join(', ') : value);
            }
            // The body is already decoded to the bytes below; a length or an
            // encoding carried over from the wire would describe something else.
            headers.delete('content-length');
            headers.delete('content-encoding');
            headers.delete('transfer-encoding');
            resolve(
              new Response(NULL_BODY_STATUS.has(status) ? null : Buffer.concat(chunks), {
                status: status >= 200 && status <= 599 ? status : 502,
                headers,
              }),
            );
          });
        },
      );

      outgoing.on('timeout', () => outgoing.destroy(new Error('timed out')));
      outgoing.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === NON_PUBLIC) {
          reject(
            new ImportError(
              'validation',
              NON_PUBLIC_MESSAGE,
            ),
          );
          return;
        }
        // Never the underlying message: it can carry an address or a path, and
        // an error body is a place details leak.
        reject(new ImportError('unavailable', 'Confluence could not be reached'));
      });
      outgoing.end();
    });

  return guarded as typeof fetch;
}
