import { supabase } from "./supabaseClient";

import {
  getStoredProjectPassword,
  getStoredSitePassword,
  PROJECT_PASSWORD_SESSION_KEY_PREFIX,
} from "./projectDatabase";

import type {
  AuditRole,
  ConfirmedByRole,
  Receipt,
  ReceiptAuditLog,
  ReceiptCategory,
  ReceiptRecord,
  ReceiptSide,
} from "../types/receipt";

type SupabaseReceiptRow = {
  id: string;
  project_id: string;

  submitter_store_name: string | null;
  submitter_purchase_date: string | null;
  submitter_amount: number | null;
  submitter_category: string | null;
  submitter_memo: string | null;
  submitter_image_path: string | null;
  submitter_registered_at: string | null;
  submitter_updated_at: string | null;

  accountant_store_name: string | null;
  accountant_purchase_date: string | null;
  accountant_amount: number | null;
  accountant_category: string | null;
  accountant_memo: string | null;
  accountant_image_path: string | null;
  accountant_registered_at: string | null;
  accountant_updated_at: string | null;

  is_confirmed: boolean;
  confirmed_at: string | null;
  confirmed_by_role: string | null;

  created_at: string;
  updated_at: string;
};

type SupabaseAuditLogRow = {
  id: string;
  project_id: string | null;
  receipt_id: string | null;
  action: string;
  role: string;
  detail: string;
  created_at: string;
};

const RECEIPT_IMAGE_BUCKET = "receipt-images";

function getStoredProjectIds(): string[] {
  return Object.keys(sessionStorage)
    .filter((key) =>
      key.startsWith(PROJECT_PASSWORD_SESSION_KEY_PREFIX)
    )
    .map((key) =>
      key.replace(PROJECT_PASSWORD_SESSION_KEY_PREFIX, "")
    )
    .filter(Boolean);
}

function requireSitePassword(): string {
  const sitePassword = getStoredSitePassword();

  if (!sitePassword) {
    throw new Error(
      "全体パスワードが保存されていません。もう一度システムに入室してください。"
    );
  }

  return sitePassword;
}

function requireProjectPassword(projectId: string): string {
  const projectPassword = getStoredProjectPassword(projectId);

  if (!projectPassword) {
    throw new Error(
      "プロジェクトのパスワードが保存されていません。もう一度プロジェクトに入室してください。"
    );
  }

  return projectPassword;
}

function isReceiptCategory(
  value: string | null
): value is ReceiptCategory {
  return (
    value === "食費" ||
    value === "交通費" ||
    value === "消耗品費" ||
    value === "通信費" ||
    value === "交際費" ||
    value === "医療費" ||
    value === "その他" ||
    value === "未分類"
  );
}

function toReceiptCategory(value: string | null): ReceiptCategory {
  return isReceiptCategory(value) ? value : "未分類";
}

function toConfirmedByRole(
  value: string | null
): ConfirmedByRole | null {
  if (value === "accountant" || value === "admin") {
    return value;
  }

  return null;
}

function toAuditRole(value: string): AuditRole {
  if (
    value === "submitter" ||
    value === "accountant" ||
    value === "admin"
  ) {
    return value;
  }

  return "admin";
}

function toReceiptAuditAction(
  action: string
): ReceiptAuditLog["action"] {
  if (
    action === "create" ||
    action === "update" ||
    action === "confirm" ||
    action === "unconfirm"
  ) {
    return action;
  }

  return "update";
}

function getImageExtension(blob: Blob): string {
  if (blob.type === "image/png") {
    return "png";
  }

  if (blob.type === "image/webp") {
    return "webp";
  }

  return "jpg";
}

function createStorageImagePath(params: {
  projectId: string;
  receiptId: string | null;
  side: ReceiptSide;
  image: Blob;
}): string {
  const extension = getImageExtension(params.image);
  const baseReceiptId = params.receiptId ?? crypto.randomUUID();

  return [
    params.projectId,
    baseReceiptId,
    params.side,
    `${Date.now()}-${crypto.randomUUID()}.${extension}`,
  ].join("/");
}

async function uploadReceiptImage(params: {
  projectId: string;
  receiptId: string | null;
  side: ReceiptSide;
  record: ReceiptRecord;
}): Promise<string | null> {
  if (!params.record.image) {
    return params.record.imagePath ?? null;
  }

  if (params.record.imagePath) {
    return params.record.imagePath;
  }

  const imagePath = createStorageImagePath({
    projectId: params.projectId,
    receiptId: params.receiptId,
    side: params.side,
    image: params.record.image,
  });

  const { error } = await supabase.storage
    .from(RECEIPT_IMAGE_BUCKET)
    .upload(imagePath, params.record.image, {
      cacheControl: "3600",
      upsert: true,
      contentType: params.record.image.type || "image/jpeg",
    });

  if (error) {
    throw new Error(error.message);
  }

  return imagePath;
}

async function downloadImageBlob(
  imagePath: string | null
): Promise<Blob | null> {
  if (!imagePath) {
    return null;
  }

  const { data, error } = await supabase.storage
    .from(RECEIPT_IMAGE_BUCKET)
    .download(imagePath);

  if (error) {
    console.warn(
      "領収書画像を取得できませんでした。",
      error.message
    );

    return null;
  }

  return data;
}

async function removeReceiptImagesFromStorage(
  imagePaths: Array<string | null | undefined>
): Promise<void> {
  const uniqueImagePaths = Array.from(
    new Set(
      imagePaths.filter(
        (imagePath): imagePath is string =>
          typeof imagePath === "string" && imagePath.trim() !== ""
      )
    )
  );

  if (uniqueImagePaths.length === 0) {
    return;
  }

  const { error } = await supabase.storage
    .from(RECEIPT_IMAGE_BUCKET)
    .remove(uniqueImagePaths);

  if (error) {
    console.warn(
      "領収書データは削除されましたが、Storage画像の削除に失敗しました。",
      error.message
    );
  }
}

function createRecord(params: {
  storeName: string | null;
  purchaseDate: string | null;
  amount: number | null;
  category: string | null;
  memo: string | null;
  image: Blob | null;
  imagePath: string | null;
  registeredAt: string | null;
  updatedAt: string | null;
}): ReceiptRecord | null {
  const hasRecord =
    params.storeName !== null ||
    params.purchaseDate !== null ||
    params.amount !== null ||
    params.category !== null ||
    params.memo !== null ||
    params.image !== null ||
    params.imagePath !== null ||
    params.registeredAt !== null;

  if (!hasRecord) {
    return null;
  }

  return {
    storeName: params.storeName ?? "",
    purchaseDate: params.purchaseDate ?? "",
    amount: params.amount ?? 0,
    category: toReceiptCategory(params.category),
    memo: params.memo ?? "",
    image: params.image,
    imagePath: params.imagePath,
    registeredAt: params.registeredAt ?? "",
    updatedAt: params.updatedAt ?? "",
  };
}

function convertSupabaseAuditLogToReceiptAuditLog(
  row: SupabaseAuditLogRow
): ReceiptAuditLog {
  return {
    id: row.id,
    action: toReceiptAuditAction(row.action),
    role: toAuditRole(row.role),
    detail: row.detail,
    createdAt: row.created_at,
  };
}

async function convertSupabaseReceiptToReceipt(params: {
  row: SupabaseReceiptRow;
  auditLogs: ReceiptAuditLog[];
}): Promise<Receipt> {
  const submitterImage = await downloadImageBlob(
    params.row.submitter_image_path
  );

  const accountantImage = await downloadImageBlob(
    params.row.accountant_image_path
  );

  const submitterRecord = createRecord({
    storeName: params.row.submitter_store_name,
    purchaseDate: params.row.submitter_purchase_date,
    amount: params.row.submitter_amount,
    category: params.row.submitter_category,
    memo: params.row.submitter_memo,
    image: submitterImage,
    imagePath: params.row.submitter_image_path,
    registeredAt: params.row.submitter_registered_at,
    updatedAt: params.row.submitter_updated_at,
  });

  const accountantRecord = createRecord({
    storeName: params.row.accountant_store_name,
    purchaseDate: params.row.accountant_purchase_date,
    amount: params.row.accountant_amount,
    category: params.row.accountant_category,
    memo: params.row.accountant_memo,
    image: accountantImage,
    imagePath: params.row.accountant_image_path,
    registeredAt: params.row.accountant_registered_at,
    updatedAt: params.row.accountant_updated_at,
  });

  return {
    id: params.row.id,
    projectId: params.row.project_id,
    submitterRecord,
    accountantRecord,
    isConfirmed: params.row.is_confirmed,
    confirmedAt: params.row.confirmed_at,
    confirmedByRole: toConfirmedByRole(params.row.confirmed_by_role),
    auditLogs: params.auditLogs,
    createdAt: params.row.created_at,
    updatedAt: params.row.updated_at,
  };
}

function areRecordsEquivalent(
  first: ReceiptRecord | null,
  second: ReceiptRecord | null
): boolean {
  if (!first && !second) {
    return true;
  }

  if (!first || !second) {
    return false;
  }

  const firstImageSize = first.image?.size ?? 0;
  const secondImageSize = second.image?.size ?? 0;
  const firstImageType = first.image?.type ?? "";
  const secondImageType = second.image?.type ?? "";

  return (
    first.storeName === second.storeName &&
    first.purchaseDate === second.purchaseDate &&
    first.amount === second.amount &&
    first.category === second.category &&
    first.memo === second.memo &&
    first.imagePath === second.imagePath &&
    firstImageSize === secondImageSize &&
    firstImageType === secondImageType
  );
}

async function getAuditLogsForProject(
  projectId: string
): Promise<SupabaseAuditLogRow[]> {
  const sitePassword = requireSitePassword();
  const projectPassword = requireProjectPassword(projectId);

  const { data, error } = await supabase.rpc("get_audit_logs", {
    p_site_password: sitePassword,
    p_project_id: projectId,
    p_project_password: projectPassword,
  });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as SupabaseAuditLogRow[];
}

async function getReceiptsForProject(
  projectId: string
): Promise<Receipt[]> {
  const sitePassword = requireSitePassword();
  const projectPassword = requireProjectPassword(projectId);

  const { data, error } = await supabase.rpc("get_receipts", {
    p_site_password: sitePassword,
    p_project_id: projectId,
    p_project_password: projectPassword,
  });

  if (error) {
    throw new Error(error.message);
  }

  const receiptRows = (data ?? []) as SupabaseReceiptRow[];
  const auditRows = await getAuditLogsForProject(projectId);

  const receipts = await Promise.all(
    receiptRows.map((row) => {
      const receiptAuditLogs = auditRows
        .filter((auditRow) => auditRow.receipt_id === row.id)
        .map(convertSupabaseAuditLogToReceiptAuditLog);

      return convertSupabaseReceiptToReceipt({
        row,
        auditLogs: receiptAuditLogs,
      });
    })
  );

  return receipts;
}

async function findExistingReceipt(
  projectId: string,
  receiptId: string
): Promise<Receipt | null> {
  const receipts = await getReceiptsForProject(projectId);

  return (
    receipts.find((receipt) => receipt.id === receiptId) ?? null
  );
}

async function findReceiptByReceiptId(
  receiptId: string
): Promise<Receipt | null> {
  const projectIds = getStoredProjectIds();

  for (const projectId of projectIds) {
    try {
      const receipts = await getReceiptsForProject(projectId);
      const targetReceipt = receipts.find(
        (receipt) => receipt.id === receiptId
      );

      if (targetReceipt) {
        return targetReceipt;
      }
    } catch (error) {
      console.warn(
        `プロジェクト ${projectId} の領収書検索に失敗しました。`,
        error
      );
    }
  }

  return null;
}

async function saveSingleRecord(params: {
  receiptId: string | null;
  projectId: string;
  side: ReceiptSide;
  record: ReceiptRecord;
}): Promise<SupabaseReceiptRow> {
  const sitePassword = requireSitePassword();
  const projectPassword = requireProjectPassword(params.projectId);

  const imagePath = await uploadReceiptImage({
    projectId: params.projectId,
    receiptId: params.receiptId,
    side: params.side,
    record: params.record,
  });

  const { data, error } = await supabase.rpc("save_receipt_record", {
    p_site_password: sitePassword,
    p_project_id: params.projectId,
    p_project_password: projectPassword,
    p_receipt_id: params.receiptId,
    p_side: params.side,
    p_store_name: params.record.storeName,
    p_purchase_date: params.record.purchaseDate,
    p_amount: params.record.amount,
    p_category: params.record.category,
    p_memo: params.record.memo,
    p_image_path: imagePath,
  });

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as SupabaseReceiptRow[];

  if (rows.length === 0) {
    throw new Error("保存した領収書を取得できませんでした。");
  }

  return rows[0];
}

export async function getAllReceipts(): Promise<Receipt[]> {
  const projectIds = getStoredProjectIds();

  if (projectIds.length === 0) {
    return [];
  }

  const receiptGroups = await Promise.all(
    projectIds.map(async (projectId) => {
      try {
        return await getReceiptsForProject(projectId);
      } catch (error) {
        console.warn(
          `プロジェクト ${projectId} の領収書を取得できませんでした。`,
          error
        );

        return [];
      }
    })
  );

  return receiptGroups
    .flat()
    .sort((first, second) =>
      second.createdAt.localeCompare(first.createdAt)
    );
}

export async function saveReceipt(receipt: Receipt): Promise<void> {
  const existingReceipt = await findExistingReceipt(
    receipt.projectId,
    receipt.id
  );

  let savedReceiptId: string | null = existingReceipt
    ? receipt.id
    : null;

  const shouldSaveSubmitterRecord =
    receipt.submitterRecord !== null &&
    !areRecordsEquivalent(
      receipt.submitterRecord,
      existingReceipt?.submitterRecord ?? null
    );

  const shouldSaveAccountantRecord =
    receipt.accountantRecord !== null &&
    !areRecordsEquivalent(
      receipt.accountantRecord,
      existingReceipt?.accountantRecord ?? null
    );

  if (shouldSaveSubmitterRecord && receipt.submitterRecord) {
    const savedRow = await saveSingleRecord({
      receiptId: savedReceiptId,
      projectId: receipt.projectId,
      side: "submitter",
      record: receipt.submitterRecord,
    });

    savedReceiptId = savedRow.id;
  }

  if (shouldSaveAccountantRecord && receipt.accountantRecord) {
    const savedRow = await saveSingleRecord({
      receiptId: savedReceiptId,
      projectId: receipt.projectId,
      side: "accountant",
      record: receipt.accountantRecord,
    });

    savedReceiptId = savedRow.id;
  }
}

export async function deleteReceipt(
  receiptId: string
): Promise<void> {
  const sitePassword = requireSitePassword();

  const targetReceipt = await findReceiptByReceiptId(receiptId);

  if (!targetReceipt) {
    throw new Error("削除対象の領収書が見つかりません。");
  }

  const projectPassword =
    requireProjectPassword(targetReceipt.projectId);

  const imagePathsToDelete = [
    targetReceipt.submitterRecord?.imagePath,
    targetReceipt.accountantRecord?.imagePath,
  ];

  const { error } = await supabase.rpc("delete_receipt", {
    p_site_password: sitePassword,
    p_project_id: targetReceipt.projectId,
    p_project_password: projectPassword,
    p_receipt_id: receiptId,
  });

  if (error) {
    throw new Error(error.message);
  }

  await removeReceiptImagesFromStorage(imagePathsToDelete);
}