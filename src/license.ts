// Licence layers (plan.md §4a). The real LicenseClient calls the remote licensing service.

export const BASE_LICENSE = "base";

/** What a granted check returns. A plain entitlement check returns a lease whose release() does nothing. */
export interface LicenseLease {
  release(): Promise<void>;
}

export interface LicenseClient {
  /**
   * Checks (and, for floating seats, checks out) one licence layer for the user.
   * Throws ToolError("unlicensed", { feature }) when denied; any other throw is treated as an outage (L6).
   */
  acquire(subject: string, feature: string): Promise<LicenseLease>;
}
