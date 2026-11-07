// Node gives the first address 250ms, then tries the next.
// From this WSL host the router answers on IPv4 in about a second, and the
// NAT64 address does not answer. 250ms drops the call before IPv4 connects.

import dns from "node:dns";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

export function preferReachableAddress(): void {
  dns.setDefaultResultOrder("ipv4first");
  setDefaultAutoSelectFamilyAttemptTimeout(10_000);
}
