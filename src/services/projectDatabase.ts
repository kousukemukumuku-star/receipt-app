import { supabase } from "./supabaseClient";

import type {
  Project,
  ProjectPasswordType,
} from "../types/project";

export const SITE_PASSWORD_SESSION_KEY =
  "receipt-site-password";

export const PROJECT_PASSWORD_SESSION_KEY_PREFIX =
  "receipt-project-password:";

type SupabaseProjectRow = {
  id: string;
  fiscal_year: string;
  name: string;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Supabaseとの通信中にエラーが発生しました。";
}

function requireSitePassword(sitePassword?: string): string {
  const password =
    sitePassword ??
    sessionStorage.getItem(SITE_PASSWORD_SESSION_KEY) ??
    "";

  if (!password) {
    throw new Error(
      "全体パスワードが保存されていません。もう一度システムに入室してください。"
    );
  }

  return password;
}

function requireProjectPassword(
  projectId: string,
  projectPassword?: string
): string {
  const password =
    projectPassword ??
    sessionStorage.getItem(
      `${PROJECT_PASSWORD_SESSION_KEY_PREFIX}${projectId}`
    ) ??
    "";

  if (!password) {
    throw new Error(
      "プロジェクトのパスワードが保存されていません。もう一度プロジェクトに入室してください。"
    );
  }

  return password;
}

function convertSupabaseProjectToProject(
  row: SupabaseProjectRow
): Project {
  return {
    id: row.id,
    fiscalYear: row.fiscal_year,
    name: row.name,
    submitterKey: "",
    accountantKey: "",
    adminKey: "",
    auditLogs: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function saveSitePasswordToSession(
  sitePassword: string
): void {
  sessionStorage.setItem(
    SITE_PASSWORD_SESSION_KEY,
    sitePassword
  );
}

export function clearSitePasswordFromSession(): void {
  sessionStorage.removeItem(SITE_PASSWORD_SESSION_KEY);
}

export function saveProjectPasswordToSession(
  projectId: string,
  projectPassword: string
): void {
  sessionStorage.setItem(
    `${PROJECT_PASSWORD_SESSION_KEY_PREFIX}${projectId}`,
    projectPassword
  );
}

export function clearProjectPasswordFromSession(
  projectId: string
): void {
  sessionStorage.removeItem(
    `${PROJECT_PASSWORD_SESSION_KEY_PREFIX}${projectId}`
  );
}

export function clearAllProjectPasswordsFromSession(): void {
  Object.keys(sessionStorage).forEach((key) => {
    if (key.startsWith(PROJECT_PASSWORD_SESSION_KEY_PREFIX)) {
      sessionStorage.removeItem(key);
    }
  });
}

export async function verifySiteAccessPassword(
  sitePassword: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc(
    "verify_site_access_password",
    {
      p_site_password: sitePassword,
    }
  );

  if (error) {
    throw new Error(error.message);
  }

  return Boolean(data);
}

export async function getAllProjects(
  sitePassword?: string
): Promise<Project[]> {
  const resolvedSitePassword =
    requireSitePassword(sitePassword);

  const { data, error } = await supabase.rpc(
    "list_projects",
    {
      p_site_password: resolvedSitePassword,
    }
  );

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as SupabaseProjectRow[];

  return rows.map(convertSupabaseProjectToProject);
}

export async function createProject(params: {
  sitePassword?: string;
  fiscalYear: string;
  name: string;
  submitterPassword: string;
  accountantPassword: string;
  adminPassword: string;
}): Promise<Project> {
  const resolvedSitePassword =
    requireSitePassword(params.sitePassword);

  const { data, error } = await supabase.rpc(
    "create_project",
    {
      p_site_password: resolvedSitePassword,
      p_fiscal_year: params.fiscalYear,
      p_name: params.name,
      p_submitter_password: params.submitterPassword,
      p_accountant_password: params.accountantPassword,
      p_admin_password: params.adminPassword,
    }
  );

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as SupabaseProjectRow[];

  if (rows.length === 0) {
    throw new Error("作成されたプロジェクトを取得できませんでした。");
  }

  return convertSupabaseProjectToProject(rows[0]);
}

export async function saveProject(
  project: Project,
  sitePassword?: string
): Promise<void> {
  await createProject({
    sitePassword,
    fiscalYear: project.fiscalYear,
    name: project.name,
    submitterPassword: project.submitterKey,
    accountantPassword: project.accountantKey,
    adminPassword: project.adminKey,
  });
}

export async function verifyProjectPassword(params: {
  sitePassword?: string;
  projectId: string;
  projectPassword: string;
}): Promise<"submitter" | "accountant" | "admin"> {
  const resolvedSitePassword =
    requireSitePassword(params.sitePassword);

  const { data, error } = await supabase.rpc(
    "verify_project_password",
    {
      p_site_password: resolvedSitePassword,
      p_project_id: params.projectId,
      p_project_password: params.projectPassword,
    }
  );

  if (error) {
    throw new Error(error.message);
  }

  if (
    data !== "submitter" &&
    data !== "accountant" &&
    data !== "admin"
  ) {
    throw new Error("プロジェクトの役割を判定できませんでした。");
  }

  return data;
}

export async function changeProjectPassword(params: {
  sitePassword?: string;
  projectId: string;
  projectPassword?: string;
  targetRole: ProjectPasswordType;
  newPassword: string;
}): Promise<void> {
  const resolvedSitePassword =
    requireSitePassword(params.sitePassword);

  const resolvedProjectPassword =
    requireProjectPassword(
      params.projectId,
      params.projectPassword
    );

  const { error } = await supabase.rpc(
    "change_project_password",
    {
      p_site_password: resolvedSitePassword,
      p_project_id: params.projectId,
      p_project_password: resolvedProjectPassword,
      p_target_role: params.targetRole,
      p_new_password: params.newPassword,
    }
  );

  if (error) {
    throw new Error(error.message);
  }
}

export async function changeSiteAccessPassword(params: {
  currentSitePassword: string;
  adminProjectId: string;
  adminProjectPassword?: string;
  newSitePassword: string;
}): Promise<void> {
  const resolvedAdminProjectPassword =
    requireProjectPassword(
      params.adminProjectId,
      params.adminProjectPassword
    );

  const { error } = await supabase.rpc(
    "change_site_access_password",
    {
      p_current_site_password: params.currentSitePassword,
      p_admin_project_id: params.adminProjectId,
      p_admin_project_password: resolvedAdminProjectPassword,
      p_new_site_password: params.newSitePassword,
    }
  );

  if (error) {
    throw new Error(error.message);
  }

  saveSitePasswordToSession(params.newSitePassword);
}

export async function deleteProject(
  projectId: string,
  sitePassword?: string,
  projectPassword?: string
): Promise<void> {
  const resolvedSitePassword =
    requireSitePassword(sitePassword);

  const resolvedProjectPassword =
    requireProjectPassword(projectId, projectPassword);

  const { error } = await supabase.rpc(
    "delete_project",
    {
      p_site_password: resolvedSitePassword,
      p_project_id: projectId,
      p_project_password: resolvedProjectPassword,
    }
  );

  if (error) {
    throw new Error(error.message);
  }

  clearProjectPasswordFromSession(projectId);
}

export async function deleteProjectByAdminPassword(params: {
  sitePassword?: string;
  projectId: string;
  adminPassword: string;
}): Promise<void> {
  await deleteProject(
    params.projectId,
    params.sitePassword,
    params.adminPassword
  );
}

export function getStoredSitePassword(): string {
  return sessionStorage.getItem(SITE_PASSWORD_SESSION_KEY) ?? "";
}

export function getStoredProjectPassword(
  projectId: string
): string {
  return (
    sessionStorage.getItem(
      `${PROJECT_PASSWORD_SESSION_KEY_PREFIX}${projectId}`
    ) ?? ""
  );
}

export function formatSupabaseProjectError(
  error: unknown
): string {
  return getErrorMessage(error);
}