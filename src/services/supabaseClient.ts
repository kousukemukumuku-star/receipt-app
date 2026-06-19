import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;

const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as
  | string
  | undefined;

if (!supabaseUrl) {
  throw new Error(
    "VITE_SUPABASE_URL が設定されていません。.env.local を確認してください。"
  );
}

if (!supabaseAnonKey) {
  throw new Error(
    "VITE_SUPABASE_ANON_KEY が設定されていません。.env.local を確認してください。"
  );
}

export const supabase = createClient(
  supabaseUrl,
  supabaseAnonKey
);