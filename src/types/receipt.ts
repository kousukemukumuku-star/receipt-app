export const receiptCategories = [
  "食費",
  "交通費",
  "消耗品費",
  "通信費",
  "交際費",
  "医療費",
  "その他",
  "未分類",
] as const;

export type ReceiptCategory =
  (typeof receiptCategories)[number];

export type ReceiptSide = "submitter" | "accountant";

export type ConfirmedByRole = "accountant" | "admin";

export type AuditRole = "submitter" | "accountant" | "admin";

export type AuditAction =
  | "create"
  | "update"
  | "confirm"
  | "unconfirm";

export type ReceiptAuditLog = {
  id: string;
  action: AuditAction;
  role: AuditRole;
  detail: string;
  createdAt: string;
};

export type ReceiptRecord = {
  storeName: string;
  purchaseDate: string;
  amount: number;
  category: ReceiptCategory;
  memo: string;
  image: Blob | null;
  registeredAt: string;
  updatedAt: string;
};

export type Receipt = {
  id: string;
  projectId: string;
  submitterRecord: ReceiptRecord | null;
  accountantRecord: ReceiptRecord | null;
  isConfirmed: boolean;
  confirmedAt: string | null;
  confirmedByRole: ConfirmedByRole | null;
  auditLogs: ReceiptAuditLog[];
  createdAt: string;
  updatedAt: string;
};