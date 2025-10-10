/**
 * Unified authentication module supporting both:
 * 1. Supabase Auth (email/password) - existing users
 * 2. Internet Identity (principal) - new users
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import { create, verify, getNumericDate } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const jwtSecret = Deno.env.get("JWT_SECRET") || "default-jwt-secret-change-in-production";

// Create Supabase client at module level to avoid request context interference
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export interface AuthUser {
  id: string;           // Profile UUID (for DB queries)
  principal?: string;   // II principal (if using II auth)
}

/**
 * Generate JWT tokens for II authentication
 */
export async function generateTokens(principal: string): Promise<{
  accessToken: string;
  refreshToken: string;
}> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(jwtSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );

  const accessToken = await create(
    { alg: "HS256", typ: "JWT" },
    {
      principal,
      type: "access",
      exp: getNumericDate(60 * 60), // 1 hour
    },
    key
  );

  const refreshToken = await create(
    { alg: "HS256", typ: "JWT" },
    {
      principal,
      type: "refresh",
      exp: getNumericDate(60 * 60 * 24 * 7), // 7 days
    },
    key
  );

  return { accessToken, refreshToken };
}

/**
 * Validate custom JWT and extract principal
 */
async function validateCustomToken(token: string): Promise<string | null> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(jwtSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );

    const payload = await verify(token, key);
    
    // Check if token is expired
    if (payload.exp && payload.exp < Date.now() / 1000) {
      return null;
    }

    return payload.principal as string;
  } catch (error) {
    console.log("Custom JWT validation failed:", error);
    return null;
  }
}

/**
 * Get user from request - supports both Supabase Auth and II Auth
 */
export async function getUserFromRequest(
  req: Request
): Promise<AuthUser | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.replace("Bearer ", "");

  // // Strategy 1: Try Supabase Auth (for email/password users)
  // try {
  //   const { data: { user }, error } = await supabase.auth.getUser(token);
  //   if (!error && user) {
  //     // Valid Supabase user
  //     return { id: user.id };
  //   }
  // } catch (error) {
  //   console.log("Supabase auth validation failed, trying custom JWT:", error);
  // }

  // Strategy 2: Try custom JWT (for II users)
  const principal = await validateCustomToken(token);
  if (principal) {
    // Look up user profile by principal
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id, principal")
      .eq("principal", principal)
      .single();

    if (!profileError && profile) {
      return {
        id: profile.id,
        principal: profile.principal,
      };
    }
  }

  return null;
}

interface ProfileData {
  id: string;
  principal: string;
  free_canister_claimed_at: string | null;
  created_at: string;
  updated_at: string;
  username?: string;
}

/**
 * Get or create user profile for II authentication
 */
export async function getOrCreateUserByPrincipal(
  principal: string
): Promise<{ profile: ProfileData; tokens: { accessToken: string; refreshToken: string } }> {
  // Check if user already exists
  const { data: existingProfile, error: lookupError } = await supabase
    .from("profiles")
    .select("*")
    .eq("principal", principal)
    .single();

  if (!lookupError && existingProfile) {
    // Existing user - generate new tokens
    const tokens = await generateTokens(principal);
    return {
      profile: existingProfile,
      tokens,
    };
  }

  // New user - create profile
  const { data: newProfile, error: createError } = await supabase
    .from("profiles")
    .insert({
      principal,
    })
    .select()
    .single();

  if (createError || !newProfile) {
    throw new Error(`Failed to create profile: ${createError?.message || "Unknown error"}`);
  }

  // Generate tokens for new user
  const tokens = await generateTokens(principal);

  return {
    profile: newProfile,
    tokens,
  };
}

