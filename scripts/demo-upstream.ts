/**
 * Tiny upstream API for the demo (C11). Serves a fixed JSON body, and can be
 * told to answer 500 or hang so GW-3 behaviour is shown rather than described.
 *
 * localhost only, and it is the only place an http (not https) upstream is
 * allowed, via ALLOW_INSECURE_UPSTREAM.
 */
export const DEMO_UPSTREAM_PORT = 4100;
