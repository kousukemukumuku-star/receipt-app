export type ProjectPasswordType =
  | "submitter"
  | "accountant"
  | "admin";

export type ProjectAuditRole =
  | "submitter"
  | "accountant"
  | "admin";

export type ProjectAuditAction =
  | "create"
  | "passwordChange";

export type ProjectAuditLog = {
  id: string;
  action: ProjectAuditAction;
  role: ProjectAuditRole;
  detail: string;
  createdAt: string;
};

export type Project = {
  id: string;
  fiscalYear: string;
  name: string;
  submitterKey: string;
  accountantKey: string;
  adminKey: string;
  auditLogs: ProjectAuditLog[];
  createdAt: string;
  updatedAt: string;
};