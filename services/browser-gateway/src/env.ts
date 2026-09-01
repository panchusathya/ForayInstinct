export interface GatewayEnv {
  authSecret: string;
  brightdataCustomerId: string;
  brightdataPassword: string;
  brightdataZone: string;
  port: number;
}

/** Reads and validates the environment. Throws on any missing value: the
 * gateway is useless without Brightdata credentials, so fail at boot. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): GatewayEnv {
  const required = (name: string): string => {
    const value = source[name]?.trim();
    if (!value) {
      throw new Error(`Missing required environment variable ${name}`);
    }
    return value;
  };
  const rawPort = source.PORT?.trim();
  let port = 8_080;
  if (rawPort !== undefined && rawPort !== "") {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`Invalid PORT: ${rawPort}`);
    }
  }
  return {
    authSecret: required("GATEWAY_AUTH_SECRET"),
    brightdataCustomerId: required("BRIGHTDATA_CUSTOMER_ID"),
    brightdataPassword: required("BRIGHTDATA_PASSWORD"),
    brightdataZone: required("BRIGHTDATA_ZONE"),
    port,
  };
}

/**
 * Brightdata Browser API CDP endpoint. The password rides in the URL userinfo,
 * so it is percent-encoded to survive characters that would break parsing.
 */
export function brightdataEndpoint(env: GatewayEnv): string {
  const user = `brd-customer-${env.brightdataCustomerId}-zone-${env.brightdataZone}`;
  return `wss://${user}:${encodeURIComponent(env.brightdataPassword)}@brd.superproxy.io:9222`;
}
