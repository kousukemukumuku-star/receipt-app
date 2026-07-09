import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  ChangeEvent,
  FormEvent,
} from "react";

import { receiptCategories } from "./types/receipt";

import type {
  AuditRole,
  ConfirmedByRole,
  Receipt,
  ReceiptAuditLog,
  ReceiptCategory,
  ReceiptRecord,
  ReceiptSide,
} from "./types/receipt";

import type {
  Project,
  ProjectAuditLog,
  ProjectPasswordType,
} from "./types/project";

import { supabase } from "./services/supabaseClient";

import {
  changeProjectPassword as changeProjectPasswordInDatabase,
  changeSiteAccessPassword as changeSiteAccessPasswordInDatabase,
  clearAllProjectPasswordsFromSession,
  clearProjectPasswordFromSession,
  clearSitePasswordFromSession,
  createProject,
  deleteProjectByAdminPassword,
  getAllProjects,
  getStoredProjectPassword,
  getStoredSitePassword,
  saveProjectPasswordToSession,
  saveSitePasswordToSession,
  verifyProjectPassword,
  verifySiteAccessPassword,
} from "./services/projectDatabase";

import {
  deleteReceipt as deleteReceiptFromDatabase,
  getAllReceipts,
  saveReceipt,
} from "./services/receiptDatabase";

const SITE_UNLOCK_STORAGE_KEY =
  "receipt-site-unlocked";

const MAX_ORIGINAL_IMAGE_SIZE = 20 * 1024 * 1024;
const TARGET_COMPRESSED_IMAGE_SIZE = 800 * 1024;
const MAX_IMAGE_EDGE_LENGTH = 1600;

type ActiveView =
  | "projects"
  | "home"
  | "register"
  | "list"
  | "summary"
  | "settings"
  | "guide"
  | "policy";

type UserRole =
  | "submitter"
  | "accountant"
  | "admin";

type ReceiptStatusFilter =
  | ""
  | "unregistered"
  | "submitterOnly"
  | "accountantOnly"
  | "matched"
  | "mismatched"
  | "confirmed";

type LegacyProject = {
  id: string;
  fiscalYear?: string;
  name: string;
  submitterKey: string;
  accountantKey: string;
  adminKey: string;
  auditLogs?: ProjectAuditLog[];
  createdAt: string;
  updatedAt: string;
};

type LegacyReceipt = {
  id: string;
  projectId: string;
  storeName?: string;
  purchaseDate?: string;
  amount?: number;
  category?: ReceiptCategory;
  memo?: string;
  image?: Blob | null;
  imagePath?: string | null;
  createdAt?: string;
  updatedAt?: string;
  submitterRecord?: ReceiptRecord | null;
  accountantRecord?: ReceiptRecord | null;
  isConfirmed?: boolean;
  confirmedAt?: string | null;
  confirmedByRole?: ConfirmedByRole | null;
  auditLogs?: ReceiptAuditLog[];
};

function formatFileSize(size: number): string {
  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)}MB`;
  }

  return `${Math.round(size / 1024)}KB`;
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const imageUrl = URL.createObjectURL(blob);
    const imageElement = new Image();

    imageElement.onload = () => {
      URL.revokeObjectURL(imageUrl);
      resolve(imageElement);
    };

    imageElement.onerror = () => {
      URL.revokeObjectURL(imageUrl);
      reject(new Error("画像を読み込めませんでした。"));
    };

    imageElement.src = imageUrl;
  });
}

function canvasToJpegBlob(
  canvas: HTMLCanvasElement,
  quality: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("画像の圧縮に失敗しました。"));
          return;
        }

        resolve(blob);
      },
      "image/jpeg",
      quality
    );
  });
}

async function compressReceiptImage(file: File): Promise<Blob> {
  const imageElement = await loadImageFromBlob(file);

  const originalWidth = imageElement.naturalWidth;
  const originalHeight = imageElement.naturalHeight;

  const scale = Math.min(
    1,
    MAX_IMAGE_EDGE_LENGTH / Math.max(originalWidth, originalHeight)
  );

  const width = Math.max(1, Math.round(originalWidth * scale));
  const height = Math.max(1, Math.round(originalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("画像処理を開始できませんでした。");
  }

  context.drawImage(imageElement, 0, 0, width, height);

  const qualitySteps = [0.82, 0.72, 0.62, 0.52, 0.42];

  let smallestBlob: Blob | null = null;

  for (const quality of qualitySteps) {
    const compressedBlob = await canvasToJpegBlob(canvas, quality);

    if (!smallestBlob || compressedBlob.size < smallestBlob.size) {
      smallestBlob = compressedBlob;
    }

    if (compressedBlob.size <= TARGET_COMPRESSED_IMAGE_SIZE) {
      return compressedBlob;
    }
  }

  return smallestBlob && smallestBlob.size < file.size
    ? smallestBlob
    : file;
}

function getLocalDateString(): string {
  const currentDate = new Date();

  const localDate = new Date(
    currentDate.getTime() -
      currentDate.getTimezoneOffset() * 60_000
  );

  return localDate.toISOString().slice(0, 10);
}

function buildMemoWithSubmitterInfo(params: {
  studentId: string;
  submitterName: string;
  memo: string;
}): string {
  const trimmedMemo = params.memo.trim();

  if (!trimmedMemo) {
    return [
      "【提出者情報】",
      `学籍番号：${params.studentId.trim()}`,
      `氏名：${params.submitterName.trim()}`,
    ].join("\n");
  }

  return [
    "【提出者情報】",
    `学籍番号：${params.studentId.trim()}`,
    `氏名：${params.submitterName.trim()}`,
    "",
    "【補足メモ】",
    trimmedMemo,
  ].join("\n");
}

function parseMemoWithSubmitterInfo(memoText: string): {
  studentId: string;
  submitterName: string;
  memo: string;
} {
  const studentIdMatch = memoText.match(/学籍番号：(.+)/);
  const submitterNameMatch = memoText.match(/氏名：(.+)/);
  const memoParts = memoText.split("【補足メモ】");

  return {
    studentId: studentIdMatch?.[1]?.trim() ?? "",
    submitterName: submitterNameMatch?.[1]?.trim() ?? "",
    memo:
      memoParts.length > 1
        ? memoParts.slice(1).join("【補足メモ】").trim()
        : "",
  };
}

function getCurrentMonthString(): string {
  return getLocalDateString().slice(0, 7);
}

function getFiscalYearFromDateString(dateString: string): string {
  const date = new Date(dateString);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;

  return String(month >= 4 ? year : year - 1);
}

function getCurrentFiscalYearString(): string {
  return getFiscalYearFromDateString(getLocalDateString());
}

function getRoleLabel(
  role: UserRole | AuditRole | ConfirmedByRole | null
): string {
  if (role === "submitter") {
    return "提出者";
  }

  if (role === "accountant") {
    return "会計担当者";
  }

  if (role === "admin") {
    return "管理者";
  }

  return "未入室";
}

function getSideLabel(side: ReceiptSide): string {
  if (side === "submitter") {
    return "提出者側";
  }

  return "会計側";
}

function getProjectPasswordLabel(
  passwordType: ProjectPasswordType
): string {
  if (passwordType === "submitter") {
    return "提出者用パスワード";
  }

  if (passwordType === "accountant") {
    return "会計担当者用パスワード";
  }

  return "管理者用パスワード";
}

function getAuditActionLabel(action: ReceiptAuditLog["action"]): string {
  if (action === "create") {
    return "登録";
  }

  if (action === "update") {
    return "編集";
  }

  if (action === "confirm") {
    return "確認完了";
  }

  if (action === "unconfirm") {
    return "確認解除";
  }

  return "操作";
}

function getStatusFilterLabel(status: ReceiptStatusFilter): string {
  if (status === "unregistered") {
    return "未登録";
  }

  if (status === "submitterOnly") {
    return "提出者側のみ登録済み";
  }

  if (status === "accountantOnly") {
    return "会計側のみ登録済み";
  }

  if (status === "matched") {
    return "双方一致";
  }

  if (status === "mismatched") {
    return "相違あり";
  }

  if (status === "confirmed") {
    return "確認済み";
  }

  return "すべての状態";
}

function getPrimaryRecord(receipt: Receipt): ReceiptRecord | null {
  return receipt.accountantRecord ?? receipt.submitterRecord;
}

function getMismatchMessages(receipt: Receipt): string[] {
  const submitter = receipt.submitterRecord;
  const accountant = receipt.accountantRecord;

  if (!submitter || !accountant) {
    return [];
  }

  const messages: string[] = [];

  if (
    submitter.storeName.trim() !==
    accountant.storeName.trim()
  ) {
    messages.push(
      `店名が一致していません（提出者側：${submitter.storeName}／会計側：${accountant.storeName}）`
    );
  }

  if (submitter.purchaseDate !== accountant.purchaseDate) {
    messages.push(
      `日付が一致していません（提出者側：${submitter.purchaseDate}／会計側：${accountant.purchaseDate}）`
    );
  }

  if (submitter.amount !== accountant.amount) {
    messages.push(
      `金額が一致していません（提出者側：¥${submitter.amount.toLocaleString()}／会計側：¥${accountant.amount.toLocaleString()}）`
    );
  }

  if (submitter.category !== accountant.category) {
    messages.push(
      `カテゴリが一致していません（提出者側：${submitter.category}／会計側：${accountant.category}）`
    );
  }

  return messages;
}

function isReceiptMatched(receipt: Receipt): boolean {
  return (
    receipt.submitterRecord !== null &&
    receipt.accountantRecord !== null &&
    getMismatchMessages(receipt).length === 0
  );
}

function getReceiptStatusKey(
  receipt: Receipt
): Exclude<ReceiptStatusFilter, ""> {
  if (receipt.isConfirmed) {
    return "confirmed";
  }

  const submitter = receipt.submitterRecord;
  const accountant = receipt.accountantRecord;

  if (submitter && accountant) {
    return getMismatchMessages(receipt).length === 0
      ? "matched"
      : "mismatched";
  }

  if (submitter) {
    return "submitterOnly";
  }

  if (accountant) {
    return "accountantOnly";
  }

  return "unregistered";
}

function getReceiptStatus(receipt: Receipt): string {
  return getStatusFilterLabel(getReceiptStatusKey(receipt));
}

function getReceiptStatusClass(receipt: Receipt): string {
  return `status-${getReceiptStatusKey(receipt)}`;
}

function createAuditLog(
  action: ReceiptAuditLog["action"],
  role: AuditRole,
  detail: string,
  createdAt: string
): ReceiptAuditLog {
  return {
    id: crypto.randomUUID(),
    action,
    role,
    detail,
    createdAt,
  };
}

function normalizeProject(rawProject: LegacyProject): Project {
  return {
    id: rawProject.id,
    fiscalYear:
      rawProject.fiscalYear ??
      getFiscalYearFromDateString(rawProject.createdAt),
    name: rawProject.name,
    submitterKey: rawProject.submitterKey ?? "",
    accountantKey: rawProject.accountantKey ?? "",
    adminKey: rawProject.adminKey ?? "",
    auditLogs: rawProject.auditLogs ?? [],
    createdAt: rawProject.createdAt,
    updatedAt: rawProject.updatedAt,
  };
}

function normalizeReceipt(rawReceipt: LegacyReceipt): Receipt {
  if (
    "submitterRecord" in rawReceipt ||
    "accountantRecord" in rawReceipt
  ) {
    return {
      id: rawReceipt.id,
      projectId: rawReceipt.projectId,
      submitterRecord: rawReceipt.submitterRecord ?? null,
      accountantRecord: rawReceipt.accountantRecord ?? null,
      isConfirmed: rawReceipt.isConfirmed ?? false,
      confirmedAt: rawReceipt.confirmedAt ?? null,
      confirmedByRole: rawReceipt.confirmedByRole ?? null,
      auditLogs: rawReceipt.auditLogs ?? [],
      createdAt: rawReceipt.createdAt ?? new Date().toISOString(),
      updatedAt: rawReceipt.updatedAt ?? new Date().toISOString(),
    };
  }

  const currentTime = new Date().toISOString();

  return {
    id: rawReceipt.id,
    projectId: rawReceipt.projectId,
    submitterRecord: {
      storeName: rawReceipt.storeName ?? "",
      purchaseDate: rawReceipt.purchaseDate ?? getLocalDateString(),
      amount: rawReceipt.amount ?? 0,
      category: rawReceipt.category ?? "未分類",
      memo: rawReceipt.memo ?? "",
      image: rawReceipt.image ?? null,
      imagePath: rawReceipt.imagePath ?? null,
      registeredAt: rawReceipt.createdAt ?? currentTime,
      updatedAt: rawReceipt.updatedAt ?? currentTime,
    },
    accountantRecord: null,
    isConfirmed: false,
    confirmedAt: null,
    confirmedByRole: null,
    auditLogs: [
      createAuditLog(
        "create",
        "submitter",
        "旧形式の領収書を提出者側の登録として移行しました。",
        currentTime
      ),
    ],
    createdAt: rawReceipt.createdAt ?? currentTime,
    updatedAt: rawReceipt.updatedAt ?? currentTime,
  };
}

function App() {
  const [isSiteUnlocked, setIsSiteUnlocked] =
    useState(
      sessionStorage.getItem(SITE_UNLOCK_STORAGE_KEY) === "true" &&
        getStoredSitePassword() !== ""
    );

  const [sitePassword, setSitePassword] =
    useState("");

  const [sitePasswordError, setSitePasswordError] =
    useState("");

  const [currentSitePassword, setCurrentSitePassword] =
    useState("");

  const [newSitePassword, setNewSitePassword] =
    useState("");

  const [newSitePasswordConfirm, setNewSitePasswordConfirm] =
    useState("");

  const [activeView, setActiveView] =
    useState<ActiveView>("projects");

  const [selectedFiscalYear, setSelectedFiscalYear] =
    useState(getCurrentFiscalYearString());

  const [projects, setProjects] =
    useState<Project[]>([]);

  const [selectedProjectId, setSelectedProjectId] =
    useState<string | null>(null);

  const [currentRole, setCurrentRole] =
    useState<UserRole | null>(null);

  const [projectAccessKeys, setProjectAccessKeys] =
    useState<Record<string, string>>({});

  const [projectName, setProjectName] =
    useState("");

  const [projectFiscalYear, setProjectFiscalYear] =
    useState(getCurrentFiscalYearString());

  const [submitterKey, setSubmitterKey] =
    useState("");

  const [accountantKey, setAccountantKey] =
    useState("");

  const [adminKey, setAdminKey] =
    useState("");

  const [isProjectSaving, setIsProjectSaving] =
    useState(false);

  const [passwordType, setPasswordType] =
    useState<ProjectPasswordType>("admin");

  const [currentPassword, setCurrentPassword] =
    useState("");

  const [newPassword, setNewPassword] =
    useState("");

  const [newPasswordConfirm, setNewPasswordConfirm] =
    useState("");

  const [receipts, setReceipts] =
    useState<Receipt[]>([]);

  const [storeName, setStoreName] =
    useState("");

  const [purchaseDate, setPurchaseDate] =
    useState(getLocalDateString());

  const [amount, setAmount] =
    useState("");

  const [category, setCategory] =
    useState<ReceiptCategory | "">("未分類");

  const [memo, setMemo] =
    useState("");

  const [studentId, setStudentId] =
    useState("");

  const [submitterName, setSubmitterName] =
    useState("");

  const [image, setImage] =
    useState<Blob | null>(null);

  const [isCompressingImage, setIsCompressingImage] =
    useState(false);

  const [imageCompressionInfo, setImageCompressionInfo] =
    useState("");

  const [imagePreviewUrl, setImagePreviewUrl] =
    useState<string | null>(null);

  const [receiptImageUrls, setReceiptImageUrls] =
    useState<Record<string, string>>({});

  const [enlargedImageUrl, setEnlargedImageUrl] =
    useState<string | null>(null);

  const [editingId, setEditingId] =
    useState<string | null>(null);

  const [editingSide, setEditingSide] =
    useState<ReceiptSide>("submitter");

  const [isSaving, setIsSaving] =
    useState(false);

  const [isLoading, setIsLoading] =
    useState(true);

  const [searchText, setSearchText] =
    useState("");

  const [filterCategory, setFilterCategory] =
    useState<ReceiptCategory | "">("");

  const [filterMonth, setFilterMonth] =
    useState("");

  const [filterStatus, setFilterStatus] =
    useState<ReceiptStatusFilter>("");

  const [summaryMonth, setSummaryMonth] =
    useState(getCurrentMonthString());

  const fileInputRef =
    useRef<HTMLInputElement>(null);

  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? null;

  const fiscalYearOptions = useMemo(() => {
    const currentFiscalYear = Number(getCurrentFiscalYearString());

    const projectYears = projects.map((project) =>
      Number(project.fiscalYear)
    );

    const baseYears = [
      ...projectYears,
      currentFiscalYear,
      currentFiscalYear + 1,
    ];

    return Array.from(new Set(baseYears))
      .filter((year) => Number.isFinite(year))
      .sort((first, second) => second - first)
      .map((year) => String(year));
  }, [projects]);

  const selectedFiscalYearProjects = useMemo(() => {
    return projects.filter(
      (project) => project.fiscalYear === selectedFiscalYear
    );
  }, [projects, selectedFiscalYear]);

  const canCreateReceipt =
    currentRole === "submitter" ||
    currentRole === "accountant" ||
    currentRole === "admin";

  const canDeleteReceipt =
    currentRole === "admin";

  const canExportCsv =
    currentRole === "admin";

  const canConfirmReceipt =
    currentRole === "accountant" ||
    currentRole === "admin";

  const canUnconfirmReceipt =
    currentRole === "admin";

  const canOpenSettings =
    currentRole === "admin";

  const canWriteSide = (side: ReceiptSide): boolean => {
    if (currentRole === "admin") {
      return true;
    }

    if (side === "submitter") {
      return currentRole === "submitter";
    }

    return currentRole === "accountant";
  };

  const defaultSideForCurrentRole: ReceiptSide =
    currentRole === "accountant"
      ? "accountant"
      : "submitter";

  const effectiveFormSide: ReceiptSide =
    editingId
      ? editingSide
      : currentRole === "admin"
        ? editingSide
        : defaultSideForCurrentRole;

  const projectReceipts = useMemo(() => {
    if (!selectedProjectId) {
      return [];
    }

    return receipts.filter(
      (receipt) => receipt.projectId === selectedProjectId
    );
  }, [receipts, selectedProjectId]);

  const statusCounts = useMemo(() => {
    return {
      all: projectReceipts.length,
      unregistered: projectReceipts.filter(
        (receipt) => getReceiptStatusKey(receipt) === "unregistered"
      ).length,
      submitterOnly: projectReceipts.filter(
        (receipt) => getReceiptStatusKey(receipt) === "submitterOnly"
      ).length,
      accountantOnly: projectReceipts.filter(
        (receipt) => getReceiptStatusKey(receipt) === "accountantOnly"
      ).length,
      matched: projectReceipts.filter(
        (receipt) => getReceiptStatusKey(receipt) === "matched"
      ).length,
      mismatched: projectReceipts.filter(
        (receipt) => getReceiptStatusKey(receipt) === "mismatched"
      ).length,
      confirmed: projectReceipts.filter(
        (receipt) => getReceiptStatusKey(receipt) === "confirmed"
      ).length,
    };
  }, [projectReceipts]);

  const currentMonth = getCurrentMonthString();

  const currentMonthReceipts = useMemo(() => {
    return projectReceipts.filter((receipt) => {
      const primaryRecord = getPrimaryRecord(receipt);

      return primaryRecord?.purchaseDate.startsWith(currentMonth);
    });
  }, [projectReceipts, currentMonth]);

  const currentMonthTotal =
    currentMonthReceipts.reduce((total, receipt) => {
      const primaryRecord = getPrimaryRecord(receipt);

      return total + (primaryRecord?.amount ?? 0);
    }, 0);

  const recentReceipts =
    projectReceipts.slice(0, 3);

  const filteredReceipts = useMemo(() => {
    const normalizedSearchText =
      searchText.trim().toLowerCase();

    return projectReceipts.filter((receipt) => {
      const records = [
        receipt.submitterRecord,
        receipt.accountantRecord,
      ].filter(Boolean) as ReceiptRecord[];

      const searchableText = records
        .map((record) =>
          [
            record.storeName,
            record.memo,
            record.category,
          ].join(" ")
        )
        .join(" ")
        .toLowerCase();

      const primaryRecord = getPrimaryRecord(receipt);

      const matchesSearch =
        normalizedSearchText === "" ||
        searchableText.includes(normalizedSearchText);

      const matchesCategory =
        filterCategory === "" ||
        records.some((record) => record.category === filterCategory);

      const matchesMonth =
        filterMonth === "" ||
        primaryRecord?.purchaseDate.startsWith(filterMonth);

      const matchesStatus =
        filterStatus === "" ||
        getReceiptStatusKey(receipt) === filterStatus;

      return (
        matchesSearch &&
        matchesCategory &&
        matchesMonth &&
        matchesStatus
      );
    });
  }, [
    projectReceipts,
    searchText,
    filterCategory,
    filterMonth,
    filterStatus,
  ]);

  const filteredTotalAmount =
    filteredReceipts.reduce((total, receipt) => {
      const primaryRecord = getPrimaryRecord(receipt);

      return total + (primaryRecord?.amount ?? 0);
    }, 0);

  const summaryReceipts = useMemo(() => {
    return projectReceipts.filter((receipt) => {
      const primaryRecord = getPrimaryRecord(receipt);

      return primaryRecord?.purchaseDate.startsWith(summaryMonth);
    });
  }, [projectReceipts, summaryMonth]);

  const summaryTotal =
    summaryReceipts.reduce((total, receipt) => {
      const primaryRecord = getPrimaryRecord(receipt);

      return total + (primaryRecord?.amount ?? 0);
    }, 0);

  const categorySummary = useMemo(() => {
    return receiptCategories
      .map((categoryName) => {
        const categoryReceipts =
          summaryReceipts.filter((receipt) => {
            const primaryRecord = getPrimaryRecord(receipt);

            return primaryRecord?.category === categoryName;
          });

        const categoryTotal =
          categoryReceipts.reduce((total, receipt) => {
            const primaryRecord = getPrimaryRecord(receipt);

            return total + (primaryRecord?.amount ?? 0);
          }, 0);

        const percentage =
          summaryTotal > 0
            ? (categoryTotal / summaryTotal) * 100
            : 0;

        return {
          category: categoryName,
          amount: categoryTotal,
          count: categoryReceipts.length,
          percentage,
        };
      })
      .filter((summary) => summary.count > 0)
      .sort(
        (first, second) =>
          second.amount - first.amount
      );
  }, [summaryReceipts, summaryTotal]);

  const largestCategory =
    categorySummary[0] ?? null;

  const refreshProjects = async () => {
    const savedProjects = await getAllProjects();
    const normalizedProjects =
      savedProjects.map((project) =>
        normalizeProject(project as LegacyProject)
      );

    setProjects(normalizedProjects);
  };

  const refreshReceipts = async () => {
    const savedReceipts = await getAllReceipts();
    const normalizedReceipts =
      savedReceipts.map((receipt) =>
        normalizeReceipt(receipt as LegacyReceipt)
      );

    setReceipts(normalizedReceipts);
  };

  const resetProjectForm = () => {
    setProjectName("");
    setProjectFiscalYear(selectedFiscalYear);
    setSubmitterKey("");
    setAccountantKey("");
    setAdminKey("");
  };

  const resetPasswordForm = () => {
    setCurrentPassword("");
    setNewPassword("");
    setNewPasswordConfirm("");
  };

  const resetSitePasswordForm = () => {
    setCurrentSitePassword("");
    setNewSitePassword("");
    setNewSitePasswordConfirm("");
  };

  const resetForm = () => {
    setStoreName("");
    setPurchaseDate(getLocalDateString());
    setAmount("");
    setCategory("未分類");
    setMemo("");
    setStudentId("");
    setSubmitterName("");
    setImage(null);
    setIsCompressingImage(false);
    setImageCompressionInfo("");
    setEditingId(null);
    setEditingSide(defaultSideForCurrentRole);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const clearFilters = () => {
    setSearchText("");
    setFilterCategory("");
    setFilterMonth("");
    setFilterStatus("");
  };

  const escapeCsvValue = (value: string | number) => {
    const text = String(value);

    if (
      text.includes(",") ||
      text.includes('"') ||
      text.includes("\n")
    ) {
      return `"${text.replaceAll('"', '""')}"`;
    }

    return text;
  };

  useEffect(() => {
    if (!isSiteUnlocked) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    const loadProjects = async () => {
      try {
        setIsLoading(true);
        const savedProjects = await getAllProjects();

        if (!cancelled) {
          setProjects(savedProjects);
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "プロジェクトを読み込めませんでした。";

        alert(message);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadProjects();

    return () => {
      cancelled = true;
    };
  }, [isSiteUnlocked]);

  useEffect(() => {
    if (
      selectedProject &&
      selectedProject.fiscalYear !== selectedFiscalYear
    ) {
      clearProjectPasswordFromSession(selectedProject.id);
      setSelectedProjectId(null);
      setCurrentRole(null);
      setActiveView("projects");
      resetForm();
      clearFilters();
      resetPasswordForm();
      resetSitePasswordForm();
      setEnlargedImageUrl(null);
    }
  }, [selectedFiscalYear, selectedProject]);

  useEffect(() => {
    setProjectFiscalYear(selectedFiscalYear);
  }, [selectedFiscalYear]);

  useEffect(() => {
    if (!image) {
      setImagePreviewUrl(null);
      return;
    }

    const previewUrl = URL.createObjectURL(image);

    setImagePreviewUrl(previewUrl);

    return () => {
      URL.revokeObjectURL(previewUrl);
    };
  }, [image]);

  useEffect(() => {
    const newImageUrls: Record<string, string> = {};

    receipts.forEach((receipt) => {
      const primaryRecord = getPrimaryRecord(receipt);

      if (primaryRecord?.image) {
        newImageUrls[receipt.id] =
          URL.createObjectURL(primaryRecord.image);
      }
    });

    setReceiptImageUrls(newImageUrls);

    return () => {
      Object.values(newImageUrls).forEach((url) => {
        URL.revokeObjectURL(url);
      });
    };
  }, [receipts]);

  const handleSiteUnlock = async (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

    const enteredPassword = sitePassword.trim();

    if (!enteredPassword) {
      setSitePasswordError("全体パスワードを入力してください。");
      return;
    }

    try {
      const isValid =
        await verifySiteAccessPassword(enteredPassword);

      if (!isValid) {
        setSitePasswordError("全体パスワードが違います。");
        return;
      }

      saveSitePasswordToSession(enteredPassword);
      sessionStorage.setItem(SITE_UNLOCK_STORAGE_KEY, "true");

      setIsSiteUnlocked(true);
      setSitePassword("");
      setSitePasswordError("");
      setActiveView("projects");

      await refreshProjects();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "全体パスワードの確認に失敗しました。";

      setSitePasswordError(message);
    }
  };

  const handleSiteLock = () => {
    sessionStorage.removeItem(SITE_UNLOCK_STORAGE_KEY);
    clearSitePasswordFromSession();
    clearAllProjectPasswordsFromSession();

    setIsSiteUnlocked(false);
    setSelectedProjectId(null);
    setCurrentRole(null);
    setProjects([]);
    setReceipts([]);
    setActiveView("projects");
    resetForm();
    clearFilters();
    resetPasswordForm();
    resetSitePasswordForm();
    setEnlargedImageUrl(null);
  };

  const handleChangeSiteAccessPassword = async (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

    if (!selectedProject) {
      alert("先にプロジェクトを開いてください。");
      return;
    }

    if (currentRole !== "admin") {
      alert("全体パスワードを変更できるのは管理者のみです。");
      return;
    }

    if (!currentSitePassword.trim()) {
      alert("現在の全体パスワードを入力してください。");
      return;
    }

    if (!newSitePassword.trim()) {
      alert("新しい全体パスワードを入力してください。");
      return;
    }

    if (newSitePassword.length < 6) {
      alert("新しい全体パスワードは6文字以上にしてください。");
      return;
    }

    if (newSitePassword !== newSitePasswordConfirm) {
      alert("新しい全体パスワードと確認用パスワードが一致しません。");
      return;
    }

    if (newSitePassword === currentSitePassword) {
      alert("現在と同じ全体パスワードは設定できません。");
      return;
    }

    try {
      await changeSiteAccessPasswordInDatabase({
        currentSitePassword,
        adminProjectId: selectedProject.id,
        adminProjectPassword: getStoredProjectPassword(selectedProject.id),
        newSitePassword,
      });

      resetSitePasswordForm();

      alert(
        "全体パスワードを変更しました。次回入室時から新しい全体パスワードが必要です。"
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "全体パスワード変更に失敗しました。";

      alert(message);
    }
  };

  const handleFiscalYearChange = (
    event: ChangeEvent<HTMLSelectElement>
  ) => {
    setSelectedFiscalYear(event.target.value);
  };

  const handleOpenRegisterView = () => {
    resetForm();
    setEditingSide(defaultSideForCurrentRole);
    setActiveView("register");
  };

  const handleExportCsv = () => {
    if (!canExportCsv) {
      alert("CSV出力は管理者のみ使用できます。");
      return;
    }

    if (filteredReceipts.length === 0) {
      alert("出力できる領収書がありません。");
      return;
    }

    const header = [
      "年度",
      "状態",
      "確認日時",
      "確認者",
      "相違内容",
      "提出者側_日付",
      "提出者側_店名",
      "提出者側_カテゴリ",
      "提出者側_金額",
      "提出者側_メモ",
      "会計側_日付",
      "会計側_店名",
      "会計側_カテゴリ",
      "会計側_金額",
      "会計側_メモ",
      "操作履歴",
      "プロジェクト名",
    ];

    const rows = filteredReceipts.map((receipt) => [
      selectedProject?.fiscalYear ?? "",
      getReceiptStatus(receipt),
      receipt.confirmedAt ?? "",
      receipt.confirmedByRole
        ? getRoleLabel(receipt.confirmedByRole)
        : "",
      getMismatchMessages(receipt).join(" / "),
      receipt.submitterRecord?.purchaseDate ?? "",
      receipt.submitterRecord?.storeName ?? "",
      receipt.submitterRecord?.category ?? "",
      receipt.submitterRecord?.amount ?? "",
      receipt.submitterRecord?.memo ?? "",
      receipt.accountantRecord?.purchaseDate ?? "",
      receipt.accountantRecord?.storeName ?? "",
      receipt.accountantRecord?.category ?? "",
      receipt.accountantRecord?.amount ?? "",
      receipt.accountantRecord?.memo ?? "",
      receipt.auditLogs
        .map(
          (log) =>
            `${log.createdAt} ${getRoleLabel(log.role)} ${getAuditActionLabel(log.action)} ${log.detail}`
        )
        .join(" / "),
      selectedProject?.name ?? "",
    ]);

    const csvText = [header, ...rows]
      .map((row) =>
        row.map(escapeCsvValue).join(",")
      )
      .join("\n");

    const csvWithBom = "\uFEFF" + csvText;

    const blob = new Blob([csvWithBom], {
      type: "text/csv;charset=utf-8;",
    });

    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = `receipts-${
      selectedProject?.fiscalYear ?? selectedFiscalYear
    }-${
      selectedProject?.name ?? "project"
    }-${filterMonth || "all"}-${filterStatus || "all-status"}.csv`;
    link.click();

    URL.revokeObjectURL(url);
  };

  const handleCreateProject = async (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

    if (!projectFiscalYear.trim()) {
      alert("年度を選択してください。");
      return;
    }

    if (!projectName.trim()) {
      alert("プロジェクト名を入力してください。");
      return;
    }

    if (!submitterKey.trim()) {
      alert("提出者用パスワードを入力してください。");
      return;
    }

    if (!accountantKey.trim()) {
      alert("会計担当者用パスワードを入力してください。");
      return;
    }

    if (!adminKey.trim()) {
      alert("管理者用パスワードを入力してください。");
      return;
    }

    try {
      setIsProjectSaving(true);

      const createdProject = await createProject({
        fiscalYear: projectFiscalYear.trim(),
        name: projectName.trim(),
        submitterPassword: submitterKey.trim(),
        accountantPassword: accountantKey.trim(),
        adminPassword: adminKey.trim(),
      });

      await refreshProjects();

      setSelectedFiscalYear(createdProject.fiscalYear);
      resetProjectForm();

      alert(
        "プロジェクトを作成しました。パスワードを入力して入室してください。"
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "プロジェクトの作成に失敗しました。";

      alert(message);
    } finally {
      setIsProjectSaving(false);
    }
  };

  const handleOpenProject = async (project: Project) => {
    const enteredKey =
      projectAccessKeys[project.id]?.trim() ?? "";

    if (!enteredKey) {
      alert("パスワードを入力してください。");
      return;
    }

    try {
      const role = await verifyProjectPassword({
        projectId: project.id,
        projectPassword: enteredKey,
      });

      saveProjectPasswordToSession(project.id, enteredKey);

      setSelectedFiscalYear(project.fiscalYear);
      setSelectedProjectId(project.id);
      setCurrentRole(role);

      resetForm();
      clearFilters();
      resetPasswordForm();
      resetSitePasswordForm();

      setEditingSide(
        role === "accountant" ? "accountant" : "submitter"
      );

      setPasswordType("admin");

      await refreshReceipts();

      if (role === "submitter") {
        setActiveView("register");
        alert(
          "提出者として入室しました。領収書登録画面を開きます。"
        );
      } else {
        setActiveView("home");
        alert(`${getRoleLabel(role)}として入室しました。`);
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "プロジェクトに入室できませんでした。";

      alert(message);
    }
  };

  const handleCloseProject = () => {
    if (selectedProjectId) {
      clearProjectPasswordFromSession(selectedProjectId);
    }

    setSelectedProjectId(null);
    setCurrentRole(null);
    setReceipts([]);
    setActiveView("projects");
    resetForm();
    clearFilters();
    resetPasswordForm();
    resetSitePasswordForm();
    setEnlargedImageUrl(null);
  };

  const handleDeleteProject = async (project: Project) => {
    const enteredAdminKey = window.prompt(
      "このプロジェクトを削除するには、管理者用パスワードを入力してください。"
    );

    if (enteredAdminKey === null) {
      return;
    }

    const shouldDelete = window.confirm(
      "このプロジェクトを削除しますか？"
    );

    if (!shouldDelete) {
      return;
    }

    try {
      await deleteProjectByAdminPassword({
        projectId: project.id,
        adminPassword: enteredAdminKey,
      });

      await refreshProjects();

      if (selectedProjectId === project.id) {
        clearProjectPasswordFromSession(project.id);
        setSelectedProjectId(null);
        setCurrentRole(null);
        setReceipts([]);
      }

      alert("プロジェクトを削除しました。");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "プロジェクトの削除に失敗しました。";

      alert(message);
    }
  };

  const handleChangeProjectPassword = async (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

    if (!selectedProject) {
      alert("先にプロジェクトを開いてください。");
      return;
    }

    if (currentRole !== "admin") {
      alert("パスワードを変更できるのは管理者のみです。");
      return;
    }

    if (!currentPassword.trim()) {
      alert("現在の管理者用パスワードを入力してください。");
      return;
    }

    if (currentPassword !== getStoredProjectPassword(selectedProject.id)) {
      alert("現在の管理者用パスワードが違います。");
      return;
    }

    if (!newPassword.trim()) {
      alert("新しいパスワードを入力してください。");
      return;
    }

    if (newPassword.length < 4) {
      alert("新しいパスワードは4文字以上にしてください。");
      return;
    }

    if (newPassword !== newPasswordConfirm) {
      alert("新しいパスワードと確認用パスワードが一致しません。");
      return;
    }

    if (
      passwordType === "admin" &&
      newPassword === getStoredProjectPassword(selectedProject.id)
    ) {
      alert("現在と同じ管理者用パスワードは設定できません。");
      return;
    }

    try {
      await changeProjectPasswordInDatabase({
        projectId: selectedProject.id,
        projectPassword: getStoredProjectPassword(selectedProject.id),
        targetRole: passwordType,
        newPassword,
      });

      if (passwordType === "admin") {
        saveProjectPasswordToSession(selectedProject.id, newPassword);
      }

      resetPasswordForm();

      alert(`${getProjectPasswordLabel(passwordType)}を変更しました。`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "パスワード変更に失敗しました。";

      alert(message);
    }
  };

  const handleImageChange = async (
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const selectedFile =
      event.target.files?.[0];

    if (!selectedFile) {
      return;
    }

    if (!selectedFile.type.startsWith("image/")) {
      alert("画像ファイルを選択してください。");
      event.target.value = "";
      return;
    }

    if (selectedFile.size > MAX_ORIGINAL_IMAGE_SIZE) {
      alert("画像は20MB以下にしてください。");
      event.target.value = "";
      return;
    }

    try {
      setIsCompressingImage(true);
      setImageCompressionInfo("");

      const compressedImage =
        await compressReceiptImage(selectedFile);

      setImage(compressedImage);

      if (compressedImage.size < selectedFile.size) {
        setImageCompressionInfo(
          `画像を${formatFileSize(selectedFile.size)}から${formatFileSize(compressedImage.size)}に圧縮しました。`
        );
      } else {
        setImageCompressionInfo(
          `画像サイズ：${formatFileSize(compressedImage.size)}。圧縮は不要でした。`
        );
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "画像の圧縮に失敗しました。";

      alert(`${message} 元の画像を使用します。`);

      setImage(selectedFile);
      setImageCompressionInfo(
        `元の画像を使用します。画像サイズ：${formatFileSize(selectedFile.size)}`
      );
    } finally {
      setIsCompressingImage(false);
    }
  };

  const handleRemoveImage = () => {
    setImage(null);
    setImageCompressionInfo("");
    setIsCompressingImage(false);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

    if (isCompressingImage) {
      alert("画像の圧縮が終わるまでお待ちください。");
      return;
    }

    if (!selectedProject) {
      alert("先にプロジェクトを開いてください。");
      setActiveView("projects");
      return;
    }

    if (!currentRole) {
      alert("パスワードを入力して入室してください。");
      setActiveView("projects");
      return;
    }

    if (!canCreateReceipt && !editingId) {
      alert(
        "新規登録できるのは提出者、会計担当者、管理者です。"
      );
      return;
    }

    if (!canWriteSide(effectiveFormSide)) {
      alert(
        `${getSideLabel(effectiveFormSide)}を登録・編集する権限がありません。`
      );
      return;
    }

    const existingReceipt = editingId
      ? receipts.find((receipt) => receipt.id === editingId)
      : undefined;

    if (existingReceipt?.isConfirmed) {
      alert(
        "この領収書は確認済みのため編集できません。管理者が確認解除すると編集できます。"
      );
      return;
    }

    if (effectiveFormSide === "submitter") {
      if (!studentId.trim()) {
        alert("学籍番号を入力してください。");
        return;
      }

      if (!submitterName.trim()) {
        alert("氏名を入力してください。");
        return;
      }
    }

    if (!storeName.trim()) {
      alert("店名を入力してください。");
      return;
    }

    if (!purchaseDate) {
      alert("日付を入力してください。");
      return;
    }

    if (amount === "" || Number(amount) < 0) {
      alert("正しい金額を入力してください。");
      return;
    }

    if (!category) {
      alert("カテゴリを選択してください。");
      return;
    }

    const currentTime = new Date().toISOString();

    const memoToSave =
      effectiveFormSide === "submitter"
        ? buildMemoWithSubmitterInfo({
            studentId,
            submitterName,
            memo,
          })
        : memo.trim();

    const newRecord: ReceiptRecord = {
      storeName: storeName.trim(),
      purchaseDate,
      amount: Number(amount),
      category,
      memo: memoToSave,
      image,
      registeredAt: currentTime,
      updatedAt: currentTime,
    };

    if (editingId && !existingReceipt) {
      alert("編集対象の領収書が見つかりません。");
      return;
    }

    const existingSideRecord =
      effectiveFormSide === "submitter"
        ? existingReceipt?.submitterRecord
        : existingReceipt?.accountantRecord;

    const recordToSave: ReceiptRecord = {
      ...newRecord,
      imagePath: existingSideRecord?.imagePath ?? null,
      registeredAt: existingSideRecord?.registeredAt ?? currentTime,
    };

    const auditDetail = `${getSideLabel(effectiveFormSide)}の領収書情報を${
      existingSideRecord ? "編集" : "登録"
    }しました。`;

    const auditLog = createAuditLog(
      existingSideRecord ? "update" : "create",
      currentRole,
      auditDetail,
      currentTime
    );

    const receiptToSave: Receipt =
      existingReceipt
        ? {
            ...existingReceipt,
            submitterRecord:
              effectiveFormSide === "submitter"
                ? recordToSave
                : existingReceipt.submitterRecord,
            accountantRecord:
              effectiveFormSide === "accountant"
                ? recordToSave
                : existingReceipt.accountantRecord,
            auditLogs: [
              ...(existingReceipt.auditLogs ?? []),
              auditLog,
            ],
            updatedAt: currentTime,
          }
        : {
            id: crypto.randomUUID(),
            projectId: selectedProject.id,
            submitterRecord:
              effectiveFormSide === "submitter"
                ? recordToSave
                : null,
            accountantRecord:
              effectiveFormSide === "accountant"
                ? recordToSave
                : null,
            isConfirmed: false,
            confirmedAt: null,
            confirmedByRole: null,
            auditLogs: [auditLog],
            createdAt: currentTime,
            updatedAt: currentTime,
          };

    try {
      setIsSaving(true);

      await saveReceipt(receiptToSave);
      await refreshReceipts();

      alert(
        editingId
          ? `${getSideLabel(effectiveFormSide)}の内容を更新しました。`
          : `${getSideLabel(effectiveFormSide)}の領収書を保存しました。`
      );

      resetForm();
      setActiveView("list");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "保存に失敗しました。";

      alert(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditSide = (
    receipt: Receipt,
    side: ReceiptSide
  ) => {
    if (receipt.isConfirmed) {
      alert(
        "この領収書は確認済みのため編集できません。管理者が確認解除すると編集できます。"
      );
      return;
    }

    if (!canWriteSide(side)) {
      alert(
        `${getSideLabel(side)}を登録・編集する権限がありません。`
      );
      return;
    }

    const record =
      side === "submitter"
        ? receipt.submitterRecord
        : receipt.accountantRecord;

    setStoreName(record?.storeName ?? "");
    setPurchaseDate(record?.purchaseDate ?? getLocalDateString());
    setAmount(record ? String(record.amount) : "");
    setCategory(record?.category ?? "未分類");

    if (side === "submitter" && record?.memo) {
      const parsedMemo = parseMemoWithSubmitterInfo(record.memo);

      setStudentId(parsedMemo.studentId);
      setSubmitterName(parsedMemo.submitterName);
      setMemo(parsedMemo.memo);
    } else {
      setStudentId("");
      setSubmitterName("");
      setMemo(record?.memo ?? "");
    }

    setImage(record?.image ?? null);
    setIsCompressingImage(false);
    setImageCompressionInfo("");
    setEditingId(receipt.id);
    setEditingSide(side);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }

    setActiveView("register");

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  };

  const handleConfirmReceipt = async (receipt: Receipt) => {
    if (!selectedProject) {
      alert("先にプロジェクトを開いてください。");
      return;
    }

    if (!canConfirmReceipt) {
      alert("確認完了できるのは会計担当者または管理者のみです。");
      return;
    }

    if (receipt.isConfirmed) {
      alert("すでに確認済みです。");
      return;
    }

    if (!isReceiptMatched(receipt)) {
      alert(
        "提出者側と会計側が一致している領収書のみ確認完了できます。"
      );
      return;
    }

    try {
      const { error } = await supabase.rpc("confirm_receipt", {
        p_site_password: getStoredSitePassword(),
        p_project_id: selectedProject.id,
        p_project_password: getStoredProjectPassword(selectedProject.id),
        p_receipt_id: receipt.id,
      });

      if (error) {
        throw new Error(error.message);
      }

      await refreshReceipts();

      alert("確認完了にしました。");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "確認完了にできませんでした。";

      alert(message);
    }
  };

  const handleUnconfirmReceipt = async (receipt: Receipt) => {
    if (!selectedProject) {
      alert("先にプロジェクトを開いてください。");
      return;
    }

    if (!canUnconfirmReceipt) {
      alert("確認解除できるのは管理者のみです。");
      return;
    }

    const shouldUnconfirm = window.confirm(
      "この領収書の確認を解除しますか？"
    );

    if (!shouldUnconfirm) {
      return;
    }

    try {
      const { error } = await supabase.rpc("unconfirm_receipt", {
        p_site_password: getStoredSitePassword(),
        p_project_id: selectedProject.id,
        p_project_password: getStoredProjectPassword(selectedProject.id),
        p_receipt_id: receipt.id,
      });

      if (error) {
        throw new Error(error.message);
      }

      await refreshReceipts();

      alert("確認を解除しました。");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "確認解除に失敗しました。";

      alert(message);
    }
  };

  const handleDelete = async (receipt: Receipt) => {
    if (!canDeleteReceipt) {
      alert("削除できるのは管理者のみです。");
      return;
    }

    if (receipt.isConfirmed) {
      alert(
        "確認済みの領収書は削除できません。先に管理者が確認解除してください。"
      );
      return;
    }

    const shouldDelete = window.confirm(
      "この領収書を削除しますか？"
    );

    if (!shouldDelete) {
      return;
    }

    try {
      await deleteReceiptFromDatabase(receipt.id);
      await refreshReceipts();

      if (editingId === receipt.id) {
        resetForm();
      }

      alert("領収書を削除しました。");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "削除に失敗しました。";

      alert(message);
    }
  };

  const renderStatusBadge = (receipt: Receipt) => {
    return (
      <span className={`status-badge ${getReceiptStatusClass(receipt)}`}>
        {getReceiptStatus(receipt)}
      </span>
    );
  };

  const renderSideMiniStatus = (
    title: string,
    record: ReceiptRecord | null
  ) => {
    return (
      <div
        className={
          record
            ? "side-mini-card registered"
            : "side-mini-card empty"
        }
      >
        <span>{title}</span>
        <strong>{record ? "登録済み" : "未登録"}</strong>

        {record && (
          <small>
            {record.purchaseDate}／¥
            {record.amount.toLocaleString()}
          </small>
        )}
      </div>
    );
  };

  const renderRecord = (
    title: string,
    record: ReceiptRecord | null
  ) => {
    return (
      <section className="record-panel">
        <h4>{title}</h4>

        {record ? (
          <>
            <p>店名：{record.storeName}</p>
            <p>日付：{record.purchaseDate}</p>
            <p>カテゴリ：{record.category}</p>
            <p>金額：¥{record.amount.toLocaleString()}</p>

            {record.memo && <p>メモ：{record.memo}</p>}
          </>
        ) : (
          <p>未登録</p>
        )}
      </section>
    );
  };

  const renderMismatchDetails = (receipt: Receipt) => {
    const mismatchMessages = getMismatchMessages(receipt);

    if (mismatchMessages.length === 0) {
      return null;
    }

    return (
      <section className="alert-panel">
        <h4>相違内容</h4>

        <ul>
          {mismatchMessages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      </section>
    );
  };

  const renderConfirmationInfo = (receipt: Receipt) => {
    if (!receipt.isConfirmed) {
      return null;
    }

    return (
      <section className="success-panel">
        <h4>確認情報</h4>

        <p>確認日時：{receipt.confirmedAt}</p>

        <p>
          確認者：
          {receipt.confirmedByRole
            ? getRoleLabel(receipt.confirmedByRole)
            : "不明"}
        </p>
      </section>
    );
  };

  const renderAuditLogs = (receipt: Receipt) => {
    if (receipt.auditLogs.length === 0) {
      return (
        <section className="audit-panel">
          <h4>操作履歴</h4>
          <p>操作履歴はありません。</p>
        </section>
      );
    }

    const sortedLogs = [...receipt.auditLogs].sort(
      (first, second) =>
        second.createdAt.localeCompare(first.createdAt)
    );

    return (
      <section className="audit-panel">
        <h4>操作履歴</h4>

        <ul>
          {sortedLogs.map((log) => (
            <li key={log.id}>
              {log.createdAt}／{getRoleLabel(log.role)}／
              {getAuditActionLabel(log.action)}／{log.detail}
            </li>
          ))}
        </ul>
      </section>
    );
  };

  const renderReceiptCard = (receipt: Receipt) => {
    const primaryRecord = getPrimaryRecord(receipt);
    const storeName = primaryRecord?.storeName ?? "未登録の領収書";
    const date = primaryRecord?.purchaseDate ?? "日付未登録";
    const amount = primaryRecord?.amount ?? 0;
    const category = primaryRecord?.category ?? "未分類";
    const receiptImageUrl = receiptImageUrls[receipt.id];

    return (
      <article
        key={receipt.id}
        className={`receipt-card ${getReceiptStatusClass(receipt)}`}
      >
        <div className="receipt-card-header">
          {receiptImageUrl && (
            <button
              type="button"
              className="receipt-thumbnail-button"
              onClick={() => setEnlargedImageUrl(receiptImageUrl)}
              aria-label="領収書画像を拡大表示"
            >
              <img
                src={receiptImageUrl}
                alt="領収書画像"
                className="receipt-thumbnail"
              />
            </button>
          )}

          <div className="receipt-overview">
            <div className="receipt-title-row">
              <div>
                <h3>{storeName}</h3>
                <p>{date}／{category}</p>
              </div>

              {renderStatusBadge(receipt)}
            </div>

            <p className="receipt-amount">
              ¥{amount.toLocaleString()}
            </p>
          </div>
        </div>

        <div className="side-compare-grid">
          {renderSideMiniStatus("提出者側", receipt.submitterRecord)}
          {renderSideMiniStatus("会計側", receipt.accountantRecord)}
        </div>

        {getMismatchMessages(receipt).length > 0 && (
          <div className="mismatch-summary">
            相違があります。詳細を開いて確認してください。
          </div>
        )}

        {receipt.isConfirmed && (
          <p className="locked-message">
            確認済みのため編集できません。
          </p>
        )}

        <div className="card-actions">
          {!receipt.isConfirmed && canWriteSide("submitter") && (
            <button
              type="button"
              onClick={() => handleEditSide(receipt, "submitter")}
            >
              {receipt.submitterRecord
                ? "提出者側を編集"
                : "提出者側を登録"}
            </button>
          )}

          {!receipt.isConfirmed && canWriteSide("accountant") && (
            <button
              type="button"
              onClick={() => handleEditSide(receipt, "accountant")}
            >
              {receipt.accountantRecord
                ? "会計側を編集"
                : "会計側を登録"}
            </button>
          )}

          {canConfirmReceipt && !receipt.isConfirmed && (
            <button
              type="button"
              onClick={() => void handleConfirmReceipt(receipt)}
              disabled={!isReceiptMatched(receipt)}
            >
              確認完了
            </button>
          )}

          {canUnconfirmReceipt && receipt.isConfirmed && (
            <button
              type="button"
              onClick={() => void handleUnconfirmReceipt(receipt)}
            >
              確認解除
            </button>
          )}

          {canDeleteReceipt && (
            <button
              type="button"
              onClick={() => void handleDelete(receipt)}
            >
              削除
            </button>
          )}
        </div>

        {canConfirmReceipt &&
          !receipt.isConfirmed &&
          !isReceiptMatched(receipt) && (
            <p className="helper-message">
              確認完了は、提出者側と会計側が一致している場合のみ可能です。
            </p>
          )}

        <details className="receipt-details">
          <summary>詳細を表示</summary>

          {renderConfirmationInfo(receipt)}
          {renderMismatchDetails(receipt)}

          <div className="record-grid">
            {renderRecord("提出者側", receipt.submitterRecord)}
            {renderRecord("会計側", receipt.accountantRecord)}
          </div>

          {renderAuditLogs(receipt)}
        </details>
      </article>
    );
  };

  if (!isSiteUnlocked) {
    return (
      <div className="site-lock-screen">
        <section className="site-lock-card">
          <p className="site-lock-eyebrow">
            PRIMROSE FESTIVAL EXECUTIVE COMMITTEE
          </p>

          <h1>領収書管理システム</h1>

          <p>
            このシステムを利用するには、実行委員会内で共有された全体パスワードを入力してください。
          </p>

          <form onSubmit={handleSiteUnlock}>
            <label htmlFor="sitePassword">
              全体パスワード
            </label>

            <input
              id="sitePassword"
              type="password"
              value={sitePassword}
              onChange={(event) => {
                setSitePassword(event.target.value);
                setSitePasswordError("");
              }}
              placeholder="全体パスワードを入力"
            />

            {sitePasswordError && (
              <p className="error-message">
                {sitePasswordError}
              </p>
            )}

            <button type="submit">
              システムに入る
            </button>
          </form>

          <p className="helper-message">
            全体パスワードは、関係者以外に共有しないでください。
          </p>
        </section>
      </div>
    );
  }

  return (
    <div>
      <header>
        <h1>領収書管理システム</h1>

        <p>プロジェクト別・年度別 領収書管理</p>

        <div className="fiscal-year-selector">
          <label htmlFor="selectedFiscalYear">
            年度
          </label>

          <select
            id="selectedFiscalYear"
            value={selectedFiscalYear}
            onChange={handleFiscalYearChange}
          >
            {fiscalYearOptions.map((year) => (
              <option key={year} value={year}>
                {year}年度
              </option>
            ))}
          </select>
        </div>

        <p>
          選択中のプロジェクト：
          {selectedProject
            ? `${selectedProject.fiscalYear}年度 ${selectedProject.name}`
            : "未選択"}
        </p>

        <p>
          現在の役割：
          {getRoleLabel(currentRole)}
        </p>

        {selectedProject && (
          <button
            type="button"
            onClick={handleCloseProject}
          >
            プロジェクトを閉じる
          </button>
        )}

        <button
          type="button"
          onClick={handleSiteLock}
        >
          全体ロック
        </button>

        <nav>
          <button
            type="button"
            onClick={() => setActiveView("projects")}
          >
            プロジェクト管理
          </button>

          <button
            type="button"
            className="top-utility-button guide-button"
            onClick={() => setActiveView("guide")}
          >
            使用方法
          </button>

          <button
            type="button"
            className="top-utility-button policy-button"
            onClick={() => setActiveView("policy")}
          >
            規則・プライバシー
          </button>

          {selectedProject && (
            <>
              <button
                type="button"
                onClick={() => setActiveView("home")}
              >
                ホーム
              </button>

              <button
                type="button"
                onClick={handleOpenRegisterView}
              >
                領収書登録
              </button>

              <button
                type="button"
                onClick={() => setActiveView("list")}
              >
                照合一覧
              </button>

              <button
                type="button"
                onClick={() => setActiveView("summary")}
              >
                月別集計
              </button>

              {currentRole === "admin" && (
                <button
                  type="button"
                  onClick={() => setActiveView("settings")}
                >
                  プロジェクト設定
                </button>
              )}
            </>
          )}
        </nav>
      </header>

      <main>
       {activeView === "projects" && (
  <section>
    <h2>プロジェクト管理</h2>

    <section className="project-guide-panel">
      <h3>プロジェクトに入室する</h3>

      <p>
        年度を選択し、該当するプロジェクトのパスワードを入力して入室してください。
        入室後、役割に応じて領収書登録、照合一覧、月別集計などの機能が表示されます。
      </p>
    </section>

    <section>
      <h3>{selectedFiscalYear}年度のプロジェクト一覧</h3>

      {isLoading ? (
        <p>プロジェクトを読み込んでいます…</p>
      ) : selectedFiscalYearProjects.length === 0 ? (
        <p>
          {selectedFiscalYear}年度のプロジェクトはまだ作成されていません。
        </p>
      ) : (
        <div className="project-list">
          {selectedFiscalYearProjects.map((project) => (
            <article key={project.id} className="project-card">
              <div className="project-card-header">
                <div>
                  <h4>{project.name}</h4>

                  <p>年度：{project.fiscalYear}年度</p>

                  <p>
                    作成日：
                    {project.createdAt.slice(0, 10)}
                  </p>
                </div>

                <span
                  className={
                    selectedProjectId === project.id
                      ? "project-status-badge active"
                      : "project-status-badge"
                  }
                >
                  {selectedProjectId === project.id
                    ? `入室中（${getRoleLabel(currentRole)}）`
                    : "未入室"}
                </span>
              </div>

              <div className="project-access-area">
                <label htmlFor={`key-${project.id}`}>
                  パスワード
                </label>

                <input
                  id={`key-${project.id}`}
                  type="password"
                  value={projectAccessKeys[project.id] ?? ""}
                  onChange={(event) =>
                    setProjectAccessKeys(
                      (currentKeys) => ({
                        ...currentKeys,
                        [project.id]: event.target.value,
                      })
                    )
                  }
                  placeholder="役割別パスワードを入力"
                />

                <div className="project-card-actions">
                  <button
                    type="button"
                    className="primary-action-button"
                    onClick={() => void handleOpenProject(project)}
                  >
                    入室する
                  </button>

                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => void handleDeleteProject(project)}
                  >
                    削除
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>

    <details className="create-project-details">
      <summary>＋ 新規プロジェクトを作成する</summary>

      <section className="create-project-panel">
        <h3>新規プロジェクト作成</h3>

        <p>
          新しい年度・企画を管理する場合だけ作成してください。
          普段の利用では、上のプロジェクト一覧から入室します。
        </p>

        <form onSubmit={handleCreateProject}>
          <div>
            <label htmlFor="projectFiscalYear">
              年度
            </label>

            <select
              id="projectFiscalYear"
              value={projectFiscalYear}
              onChange={(event) =>
                setProjectFiscalYear(event.target.value)
              }
            >
              {fiscalYearOptions.map((year) => (
                <option key={year} value={year}>
                  {year}年度
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="projectName">
              プロジェクト名
            </label>

            <input
              id="projectName"
              type="text"
              value={projectName}
              onChange={(event) =>
                setProjectName(event.target.value)
              }
              placeholder="例：プリムローズ祭 2026"
            />
          </div>

          <div>
            <label htmlFor="submitterKey">
              提出者用パスワード
            </label>

            <p className="helper-message">
              領収書を提出する人に共有します。
            </p>

            <input
              id="submitterKey"
              type="password"
              value={submitterKey}
              onChange={(event) =>
                setSubmitterKey(event.target.value)
              }
              placeholder="提出者用パスワード"
            />
          </div>

          <div>
            <label htmlFor="accountantKey">
              会計担当者用パスワード
            </label>

            <p className="helper-message">
              領収書の照合・確認を行う人に共有します。
            </p>

            <input
              id="accountantKey"
              type="password"
              value={accountantKey}
              onChange={(event) =>
                setAccountantKey(event.target.value)
              }
              placeholder="会計担当者用パスワード"
            />
          </div>

          <div>
            <label htmlFor="adminKey">
              管理者用パスワード
            </label>

            <p className="helper-message">
              削除、確認解除、CSV出力、設定変更を行う責任者のみ使用します。
            </p>

            <input
              id="adminKey"
              type="password"
              value={adminKey}
              onChange={(event) =>
                setAdminKey(event.target.value)
              }
              placeholder="管理者用パスワード"
            />
          </div>

          <button
            type="submit"
            disabled={isProjectSaving}
          >
            {isProjectSaving
              ? "作成中…"
              : "プロジェクトを作成"}
          </button>
        </form>
      </section>
    </details>
  </section>
)}

        {activeView === "guide" && (
          <section>
            <h2>使用方法</h2>

            <section>
              <h3>1. 本システムの目的</h3>

              <p>
                本システムは、プリムローズ祭実行委員会などの企画運営において、領収書を年度及びプロジェクトごとに管理し、提出者側と会計側の記録を照合することを目的とする。また、領収書画像を保存するだけでなく、日付、店名、カテゴリ、金額、メモ、操作履歴を記録し、支出内容の確認や会計資料の整理に役立てる。
              </p>
            </section>

            <section>
              <h3>2. 基本的な流れ</h3>

              <p>
                実行委員会内で共有された全体パスワードを入力してシステムに入室する。その後、画面上部で年度を選択する。管理者がその年度のプロジェクトを作成し、提出者用、会計担当者用、管理者用のパスワードを設定する。各担当者は、自分の役割に応じたパスワードでプロジェクトに入室する。提出者は領収書画像や支出内容を登録し、会計担当者は会計側の記録を登録して提出者側の内容と照合する。内容が一致している場合、管理者が確認完了にする。
              </p>
            </section>

            <section>
              <h3>3. 年度別管理</h3>

              <p>
                画面上部の年度選択を切り替えると、その年度に属するプロジェクトだけが表示される。年度を切り替えた場合、別年度のプロジェクトは自動的に閉じられる。これにより、年度ごとの会計資料を混同せずに管理できる。
              </p>
            </section>

            <section>
              <h3>4. 役割ごとの使い方</h3>

              <h4>提出者</h4>

              <p>
                提出者は、自分が提出する領収書について、学籍番号、氏名、画像、日付、店名、カテゴリ、金額、メモを登録する。提出者は照合一覧や月別集計を確認できるが、会計側の記録やプロジェクト設定は変更できない。
              </p>

              <h4>会計担当者</h4>

              <p>
                会計担当者は、会計側の記録を登録・編集し、提出者側の内容と照合する。内容が一致している場合、領収書を確認済みにできる。
              </p>

              <h4>管理者</h4>

              <p>
                管理者は、提出者側・会計側の登録内容の管理、確認解除、削除、CSV出力、プロジェクト設定、パスワード変更、全体パスワード変更を行える。
              </p>
            </section>
          </section>
        )}

        {activeView === "home" && (
          <section>
            <h2>ホーム</h2>

            {!selectedProject && (
              <p>先にプロジェクトをパスワードで開いてください。</p>
            )}

            {selectedProject && (
              <>
                <section>
                  <h3>{selectedProject.name}</h3>

                  <p>年度：{selectedProject.fiscalYear}年度</p>

                  <p>このプロジェクトの領収書を管理します。</p>

                  <p>
                    入室中の役割：
                    {getRoleLabel(currentRole)}
                  </p>
                </section>

                <section>
                  <h3>ステータス状況</h3>

                  <div className="status-grid">
                    <div className="status-count-card">
                      <span>全件</span>
                      <strong>{statusCounts.all}</strong>
                    </div>

                    <div className="status-count-card status-submitterOnly">
                      <span>提出者側のみ</span>
                      <strong>{statusCounts.submitterOnly}</strong>
                    </div>

                    <div className="status-count-card status-accountantOnly">
                      <span>会計側のみ</span>
                      <strong>{statusCounts.accountantOnly}</strong>
                    </div>

                    <div className="status-count-card status-mismatched">
                      <span>相違あり</span>
                      <strong>{statusCounts.mismatched}</strong>
                    </div>

                    <div className="status-count-card status-matched">
                      <span>双方一致</span>
                      <strong>{statusCounts.matched}</strong>
                    </div>

                    <div className="status-count-card status-confirmed">
                      <span>確認済み</span>
                      <strong>{statusCounts.confirmed}</strong>
                    </div>
                  </div>
                </section>

                <section>
                  <h3>今月の支出</h3>

                  <p className="money-large">
                    ¥{currentMonthTotal.toLocaleString()}
                  </p>

                  <p>
                    今月の登録枚数：
                    {currentMonthReceipts.length}枚
                  </p>

                  <p>
                    このプロジェクトの登録枚数：
                    {projectReceipts.length}枚
                  </p>
                </section>

                <section>
                  <h3>最近の領収書</h3>

                  {recentReceipts.length === 0 ? (
                    <p>まだ領収書が登録されていません。</p>
                  ) : (
                    recentReceipts.map((receipt) =>
                      renderReceiptCard(receipt)
                    )
                  )}
                </section>
              </>
            )}
          </section>
        )}

        {activeView === "register" && (
          <section>
            <h2>{editingId ? "領収書を編集" : "領収書を登録"}</h2>

            {!selectedProject && (
              <p>先にプロジェクトをパスワードで開いてください。</p>
            )}

            {selectedProject &&
              ((editingId && canWriteSide(effectiveFormSide)) ||
                (!editingId && canCreateReceipt)) && (
                <form
                  className="receipt-form"
                  onSubmit={handleSubmit}
                >
                  <section className="form-hero">
                    <div>
                      <span className="form-eyebrow">
                        {editingId ? "編集中" : "新規登録"}
                      </span>

                      <h3>{getSideLabel(effectiveFormSide)}の領収書</h3>

                      <p>
                        プロジェクト：
                        {selectedProject.fiscalYear}年度 {selectedProject.name}
                      </p>

                      <p>操作中の役割：{getRoleLabel(currentRole)}</p>
                    </div>

                    <div className="form-side-badge">
                      {getSideLabel(effectiveFormSide)}
                    </div>
                  </section>

                  {currentRole === "admin" && !editingId && (
                    <section className="form-section">
                      <h3>登録する側</h3>

                      <select
                        id="editingSide"
                        value={editingSide}
                        onChange={(event) =>
                          setEditingSide(
                            event.target.value as ReceiptSide
                          )
                        }
                      >
                        <option value="submitter">提出者側</option>
                        <option value="accountant">会計側</option>
                      </select>
                    </section>
                  )}

                  <section className="form-section upload-section">
                    <div>
                      <h3>領収書画像</h3>

                      <p>
                        画像ファイルを選択してください。※画像は保存前に自動で圧縮されます。
                      </p>
                    </div>

                    <div className="upload-box">
                      <input
                        ref={fileInputRef}
                        id="receiptImage"
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={handleImageChange}
                      />

                      {imagePreviewUrl ? (
                        <div className="preview-box">
                          <img
                            src={imagePreviewUrl}
                            alt="選択した領収書"
                            className="receipt-preview-image"
                          />

                          <button
                            type="button"
                            onClick={handleRemoveImage}
                          >
                            画像を削除
                          </button>
                        </div>
                      ) : (
                        <p className="upload-empty-text">
                          画像の登録は必須です。※後から編集することもできます。
                        </p>
                      )}

                      {isCompressingImage && (
                        <p className="helper-message">
                          画像を圧縮しています…
                        </p>
                      )}

                      {imageCompressionInfo && (
                        <p className="helper-message">
                          {imageCompressionInfo}
                        </p>
                      )}
                    </div>
                  </section>

                  <section className="form-section">
                    <h3>基本情報</h3>

                    <div className="form-grid">
                      <div>
                        <label htmlFor="storeName">店名</label>

                        <input
                          id="storeName"
                          type="text"
                          value={storeName}
                          onChange={(event) =>
                            setStoreName(event.target.value)
                          }
                          placeholder="例：○○スーパー"
                        />
                      </div>

                      <div>
                        <label htmlFor="purchaseDate">日付</label>

                        <input
                          id="purchaseDate"
                          type="date"
                          value={purchaseDate}
                          onChange={(event) =>
                            setPurchaseDate(event.target.value)
                          }
                        />
                      </div>

                      <div>
                        <label htmlFor="amount">金額</label>

                        <input
                          id="amount"
                          type="number"
                          min="0"
                          step="1"
                          value={amount}
                          onChange={(event) =>
                            setAmount(event.target.value)
                          }
                          placeholder="例：1280"
                        />
                      </div>

                      <div>
                        <label htmlFor="category">カテゴリ</label>

                        <select
                          id="category"
                          value={category}
                          onChange={(event) =>
                            setCategory(
                              event.target.value as
                                | ReceiptCategory
                                | ""
                            )
                          }
                        >
                          <option value="">選択してください</option>

                          {receiptCategories.map((categoryName) => (
                            <option
                              key={categoryName}
                              value={categoryName}
                            >
                              {categoryName}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </section>

                  {effectiveFormSide === "submitter" && (
                    <section className="form-section">
                      <h3>提出者情報</h3>

                      <p className="helper-message">
                        会計確認のため、学籍番号と氏名を必ず入力してください。
                      </p>

                      <div className="form-grid">
                        <div>
                          <label htmlFor="studentId">学籍番号</label>

                          <input
                            id="studentId"
                            type="text"
                            value={studentId}
                            onChange={(event) =>
                              setStudentId(event.target.value)
                            }
                            placeholder="例：123456"
                          />
                        </div>

                        <div>
                          <label htmlFor="submitterName">氏名</label>

                          <input
                            id="submitterName"
                            type="text"
                            value={submitterName}
                            onChange={(event) =>
                              setSubmitterName(event.target.value)
                            }
                            placeholder="例：山田太郎"
                          />
                        </div>
                      </div>
                    </section>
                  )}

                  <section className="form-section">
                    <h3>補足メモ</h3>

                    <p className="helper-message">
                      補足メモは任意です。用途、購入理由、共有事項などがあれば記入してください。
                    </p>

                    <textarea
                      id="memo"
                      value={memo}
                      onChange={(event) =>
                        setMemo(event.target.value)
                      }
                      placeholder="例：ビンゴ大会の景品購入"
                    />
                  </section>

                  <div className="form-actions">
                    <button
                      type="submit"
                      disabled={isSaving || isCompressingImage}
                    >
                      {isCompressingImage
                        ? "画像圧縮中…"
                        : isSaving
                          ? "保存中…"
                          : editingId
                            ? "変更を保存する"
                            : "領収書を追加する"}
                    </button>

                    {editingId && (
                      <button
                        type="button"
                        onClick={resetForm}
                        disabled={isSaving || isCompressingImage}
                      >
                        編集をキャンセル
                      </button>
                    )}
                  </div>
                </form>
              )}
          </section>
        )}

        {activeView === "list" && (
          <section>
            <h2>照合一覧</h2>

            {!selectedProject && (
              <p>先にプロジェクトをパスワードで開いてください。</p>
            )}

            {selectedProject && (
              <>
                <p>
                  表示中のプロジェクト：
                  {selectedProject.fiscalYear}年度 {selectedProject.name}
                </p>

                <section className="filter-panel">
  <h3>検索・絞り込み</h3>

  <div className="search-row">
    <input
      type="search"
      value={searchText}
      onChange={(event) =>
        setSearchText(event.target.value)
      }
      placeholder="店名・メモ・カテゴリで検索"
    />
  </div>

  <div className="status-filter-buttons">
    {[
      {
        value: "",
        label: "すべて",
        count: statusCounts.all,
      },
      {
        value: "submitterOnly",
        label: "提出者側のみ",
        count: statusCounts.submitterOnly,
      },
      {
        value: "accountantOnly",
        label: "会計側のみ",
        count: statusCounts.accountantOnly,
      },
      {
        value: "mismatched",
        label: "相違あり",
        count: statusCounts.mismatched,
      },
      {
        value: "matched",
        label: "双方一致",
        count: statusCounts.matched,
      },
      {
        value: "confirmed",
        label: "確認済み",
        count: statusCounts.confirmed,
      },
    ].map((statusButton) => (
      <button
        key={statusButton.label}
        type="button"
        className={
          filterStatus === statusButton.value
            ? "status-filter-button active"
            : "status-filter-button"
        }
        onClick={() =>
          setFilterStatus(
            statusButton.value as ReceiptStatusFilter
          )
        }
      >
        <span>{statusButton.label}</span>
        <strong>{statusButton.count}</strong>
      </button>
    ))}
  </div>

  <div className="filter-grid">
    <div>
      <label htmlFor="filterCategory">
        カテゴリ
      </label>

      <select
        id="filterCategory"
        value={filterCategory}
        onChange={(event) =>
          setFilterCategory(
            event.target.value as ReceiptCategory | ""
          )
        }
      >
        <option value="">すべてのカテゴリ</option>

        {receiptCategories.map((categoryName) => (
          <option
            key={categoryName}
            value={categoryName}
          >
            {categoryName}
          </option>
        ))}
      </select>
    </div>

    <div>
      <label htmlFor="filterMonth">
        月
      </label>

      <input
        id="filterMonth"
        type="month"
        value={filterMonth}
        onChange={(event) =>
          setFilterMonth(event.target.value)
        }
      />
    </div>
  </div>

  <div className="filter-result-row">
    <div>
      <p>該当件数：{filteredReceipts.length}件</p>

      <p>
        該当金額合計：¥
        {filteredTotalAmount.toLocaleString()}
      </p>
    </div>

    <div className="filter-actions">
      <button
        type="button"
        onClick={clearFilters}
      >
        検索条件を解除
      </button>

      {canExportCsv ? (
        <button
          type="button"
          onClick={handleExportCsv}
        >
          CSV出力
        </button>
      ) : (
        <p>CSV出力は管理者のみ使用できます。</p>
      )}
    </div>
  </div>
</section>
                {isLoading ? (
                  <p>領収書を読み込んでいます…</p>
                ) : filteredReceipts.length === 0 ? (
                  <p>条件に一致する領収書がありません。</p>
                ) : (
                  <div className="receipt-list">
                    {filteredReceipts.map((receipt) =>
                      renderReceiptCard(receipt)
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {activeView === "summary" && (
          <section>
            <h2>月別集計</h2>

            {!selectedProject && (
              <p>先にプロジェクトをパスワードで開いてください。</p>
            )}

            {selectedProject && (
              <>
                <p>
                  集計中のプロジェクト：
                  {selectedProject.fiscalYear}年度 {selectedProject.name}
                </p>

                <div>
                  <label htmlFor="summaryMonth">集計する月</label>

                  <input
                    id="summaryMonth"
                    type="month"
                    value={summaryMonth}
                    onChange={(event) =>
                      setSummaryMonth(event.target.value)
                    }
                  />
                </div>

                <section>
                  <h3>集計結果</h3>

                  <p className="money-large">
                    月間合計：¥{summaryTotal.toLocaleString()}
                  </p>

                  <p>登録枚数：{summaryReceipts.length}枚</p>

                  <p>
                    平均金額：¥
                    {summaryReceipts.length > 0
                      ? Math.round(
                          summaryTotal / summaryReceipts.length
                        ).toLocaleString()
                      : "0"}
                  </p>

                  <p>
                    最も支出が多いカテゴリ：
                    {largestCategory
                      ? `${largestCategory.category}（¥${largestCategory.amount.toLocaleString()}）`
                      : "データなし"}
                  </p>
                </section>

                <section>
                  <h3>カテゴリ別集計</h3>

                  {categorySummary.length === 0 ? (
                    <p>この月の領収書はありません。</p>
                  ) : (
                    categorySummary.map((summary) => (
                      <article
                        key={summary.category}
                        className="summary-card"
                      >
                        <h4>{summary.category}</h4>

                        <p>
                          合計：¥
                          {summary.amount.toLocaleString()}
                        </p>

                        <p>件数：{summary.count}件</p>

                        <p>
                          割合：
                          {summary.percentage.toFixed(1)}%
                        </p>

                        <div className="summary-bar">
                          <div
                            className="summary-bar-fill"
                            style={{
                              width: `${summary.percentage}%`,
                            }}
                          />
                        </div>
                      </article>
                    ))
                  )}
                </section>
              </>
            )}
          </section>
        )}

        {activeView === "settings" && (
          <section>
            <h2>プロジェクト設定</h2>

            {!selectedProject && (
              <p>先にプロジェクトをパスワードで開いてください。</p>
            )}

            {selectedProject && !canOpenSettings && (
              <p>設定を変更できるのは、管理者のみです。</p>
            )}

            {selectedProject && canOpenSettings && (
              <>
                <section>
                  <h3>全体パスワード設定</h3>

                  <p>
                    全体パスワードは、このシステム自体に入室するためのパスワードです。
                    関係者以外に共有しないでください。
                  </p>

                  <form onSubmit={handleChangeSiteAccessPassword}>
                    <div>
                      <label htmlFor="currentSitePassword">
                        現在の全体パスワード
                      </label>

                      <input
                        id="currentSitePassword"
                        type="password"
                        value={currentSitePassword}
                        onChange={(event) =>
                          setCurrentSitePassword(event.target.value)
                        }
                        placeholder="現在の全体パスワード"
                      />
                    </div>

                    <div>
                      <label htmlFor="newSitePassword">
                        新しい全体パスワード
                      </label>

                      <input
                        id="newSitePassword"
                        type="password"
                        value={newSitePassword}
                        onChange={(event) =>
                          setNewSitePassword(event.target.value)
                        }
                        placeholder="6文字以上で入力"
                      />
                    </div>

                    <div>
                      <label htmlFor="newSitePasswordConfirm">
                        新しい全体パスワード確認
                      </label>

                      <input
                        id="newSitePasswordConfirm"
                        type="password"
                        value={newSitePasswordConfirm}
                        onChange={(event) =>
                          setNewSitePasswordConfirm(event.target.value)
                        }
                        placeholder="もう一度入力"
                      />
                    </div>

                    <button type="submit">
                      全体パスワードを変更
                    </button>
                  </form>
                </section>

                <section>
                  <h3>役割別パスワード変更</h3>

                  <p>
                    プロジェクト：
                    {selectedProject.fiscalYear}年度 {selectedProject.name}
                  </p>

                  <form onSubmit={handleChangeProjectPassword}>
                    <div>
                      <label htmlFor="passwordType">
                        変更するパスワード
                      </label>

                      <select
                        id="passwordType"
                        value={passwordType}
                        onChange={(event) =>
                          setPasswordType(
                            event.target.value as ProjectPasswordType
                          )
                        }
                      >
                        <option value="submitter">
                          提出者用パスワード
                        </option>

                        <option value="accountant">
                          会計担当者用パスワード
                        </option>

                        <option value="admin">
                          管理者用パスワード
                        </option>
                      </select>
                    </div>

                    <div>
                      <label htmlFor="currentPassword">
                        現在の管理者用パスワード
                      </label>

                      <input
                        id="currentPassword"
                        type="password"
                        value={currentPassword}
                        onChange={(event) =>
                          setCurrentPassword(event.target.value)
                        }
                        placeholder="現在の管理者用パスワード"
                      />
                    </div>

                    <div>
                      <label htmlFor="newPassword">
                        新しいパスワード
                      </label>

                      <input
                        id="newPassword"
                        type="password"
                        value={newPassword}
                        onChange={(event) =>
                          setNewPassword(event.target.value)
                        }
                        placeholder="新しいパスワード"
                      />
                    </div>

                    <div>
                      <label htmlFor="newPasswordConfirm">
                        新しいパスワード確認
                      </label>

                      <input
                        id="newPasswordConfirm"
                        type="password"
                        value={newPasswordConfirm}
                        onChange={(event) =>
                          setNewPasswordConfirm(event.target.value)
                        }
                        placeholder="もう一度入力"
                      />
                    </div>

                    <button type="submit">
                      役割別パスワードを変更
                    </button>
                  </form>
                </section>
              </>
            )}
          </section>
        )}

        {activeView === "policy" && (
          <section>
            <h2>規則・プライバシー</h2>

            <section>
              <h3>基本方針</h3>

              <p>
                プリムローズ祭実行委員会（以下、「委員会」という。）は、委員会が提供する領収書管理システムその他関連するサービスを利用する者（以下、「ユーザー」という。）の個人情報および会計資料の重要性を十分に認識し、その取り扱いにあたって以下の事項を遵守する。
              </p>
            </section>

            <section>
              <h3>1. 法令等</h3>

              <p>
                委員会は、個人情報および会計資料を取り扱うにあたり、個人情報の保護に関する法令、学校の定める規則、その他関連する規範を遵守する。
              </p>
            </section>

            <section>
              <h3>2. 取得する情報</h3>

              <p>
                委員会は、領収書管理システムの利用にあたり、年度、プロジェクト名、ユーザーの役割情報、領収書画像、日付、店名、カテゴリ、金額、メモ、学籍番号、氏名、登録・編集・確認に関する操作履歴、全体パスワード及び役割別パスワードによる入室に必要な情報、アクセス日時、利用端末に関する情報、その他会計確認および運営管理に必要な情報を取得する場合がある。
              </p>
            </section>

            <section>
              <h3>3. 利用目的</h3>

              <p>
                委員会は、取得した情報を、領収書及び支出内容の確認、年度別・プロジェクト別の会計資料の整理、提出者・会計担当者・管理者による照合、支出内容の集計、問い合わせ対応、会計確認、監査補助、次期以降の委員会への引き継ぎ、システムの保持・改善、その他プリムローズ祭の運営に必要な範囲で利用する。
              </p>
            </section>

            <section>
              <h3>4. 領収書画像の取り扱い</h3>

              <p>
                領収書画像は、支出内容を確認するための証憑として保存する。また、ユーザーは、領収書画像に不要な個人情報が写り込んでいないかを確認したうえで登録しなければならない。なお、委員会は、領収書画像を会計確認及び運営管理に必要な範囲でのみ利用し、目的外に利用してはならない。
              </p>
            </section>

            <section>
              <h3>5. 保存期間</h3>

              <p>
                委員会は、取得した情報を、会計確認、監査補助、引き継ぎその他運営上必要な期間保存する。保存された情報は、管理者による削除その他委員会が必要と認める措置が行われない限り、年度別およびプロジェクト別に保存される。
              </p>
            </section>

            <section>
              <h3>6. パスワード管理</h3>

              <p>
                ユーザーは、全体パスワード及び役割別パスワードを適切に管理し、関係者以外に共有しないものとする。パスワードが第三者に知られた可能性がある場合は、管理者または当該年度の担当者に速やかに連絡するものとする。
              </p>
            </section>

            <section>
              <h3>7. 委員会内における情報の共有</h3>

              <p>
                委員会は、取得した情報を、会計確認、運営管理、問い合わせ対応、監査補助、引き継ぎ等に必要な範囲で、委員会内の担当者または次期以降の委員会に共有する場合がある。
              </p>
            </section>

            <section>
              <h3>8. 第三者への提供</h3>

              <p>
                委員会は、法令に基づく場合、学校その他関係機関への報告が必要な場合、またはユーザーの同意がある場合を除き、取得した個人情報を第三者に提供してはならない。第三者に情報を提供する場合には、提供先において適切な管理が行われるよう必要な措置を講じる。
                
       
              </p>
            </section>

            <section>
              <h3>9. 安全管理措置</h3>

              <p>
                委員会は、取得した情報の紛失、破壊、改ざん、漏えい、不正アクセス等を防止するため、アクセス権限の管理、操作履歴の記録、パスワード管理、通信の暗号化、担当者への注意喚起等、必要かつ適切な安全管理措置を講じる。
              </p>
            </section>

            <section>
              <h3>10. 開示・訂正・削除等の申し出</h3>

              <p>
                ユーザー本人から、自己に関する情報の開示、訂正、削除等の申し出があった場合、委員会は必要な確認を行ったうえで、合理的な範囲で対応をとる。ただし、会計記録、監査、引き継ぎ、法令または学校の規則に基づき保存が必要な情報については、削除等に応じられない場合がある。
              </p>
            </section>

            <section>
              <h3>11. 外部サービスの利用</h3>

              <p>
                委員会は、システムの運用、データの保存、認証、問い合わせ対応等のために、外部サービスを利用する場合がある。この場合、委員会は利用目的の達成に必要な範囲で情報を取り扱い、外部サービスの利用規約およびプライバシーポリシーを確認したうえで、適切な管理に努める。
              </p>
            </section>

            <section>
              <h3>12. 継続的改善</h3>

              <p>
                委員会は、個人情報および会計資料の保護を適切に行うため、本方針を必要に応じて見直し、改善に努める。内容を変更した場合は、システム内、公式ウェブサイト、または委員会が適切と判断する方法で周知する。
              </p>
            </section>

            <section>
              <h3>13. お問い合わせ</h3>

              <p>
                本方針および委員会が提供するサービスにおける情報の取り扱いに関するお問い合わせは、当該年度のプリムローズ祭実行委員会の担当者までお願い申し上げる。
              </p>
            </section>
          </section>
        )}
      </main>

      {enlargedImageUrl && (
        <div
          className="image-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="領収書画像の拡大表示"
          onClick={() => setEnlargedImageUrl(null)}
        >
          <div
            className="image-modal-content"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="image-modal-close"
              onClick={() => setEnlargedImageUrl(null)}
            >
              閉じる
            </button>

            <img
              src={enlargedImageUrl}
              alt="拡大表示した領収書画像"
              className="image-modal-image"
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default App;