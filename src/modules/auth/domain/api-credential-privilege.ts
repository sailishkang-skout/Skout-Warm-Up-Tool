export const API_CREDENTIAL_PRIVILEGES = ["TENANT", "OPERATOR"] as const;
export type ApiCredentialPrivilege = (typeof API_CREDENTIAL_PRIVILEGES)[number];
