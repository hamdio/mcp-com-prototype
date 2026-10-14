// Delegated identity (plan.md §4). The real AuthClient calls the remote auth service.

export type CallerType = "agent" | "app";

export interface Principal {
  subject: string; // the user
  actor: string; // the agent or app acting for the user
  callerType: CallerType; // derived from the verified token only (D2)
  scopes: string[]; // granted to the actor (D3)
}

export interface AuthClient {
  /** Throws ToolError("unauthenticated") for a bad token; any other throw is treated as an outage. */
  verify(token: string): Promise<Principal>;
}
