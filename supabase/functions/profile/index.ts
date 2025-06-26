// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

console.log("Profile Function loaded")

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS'
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Auth validation
    const authHeader = req.headers.get('authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Create Supabase client with SERVICE_ROLE (can do everything)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Validate JWT and get user
    const jwt = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt)

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Route by HTTP method
    switch (req.method) {
      case 'GET':
        return await handleGetProfile(supabase, user.id)
      
      case 'PUT':
        return await handleUpdateProfile(supabase, user.id, req)
      
      default:
        return new Response(
          JSON.stringify({ error: 'Method not allowed' }),
          { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
    }

  } catch (error) {
    console.error('Unexpected error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

// GET /functions/v1/profile - Get user profile
async function handleGetProfile(supabase: SupabaseClient, userId: string) {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, username, faucet_used_at, cycles_balance, created_at, updated_at')
    .eq('id', userId)
    .single()

  if (error) {
    console.error('Database error:', error)
    return new Response(
      JSON.stringify({ error: 'Failed to fetch profile' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  if (!profile) {
    return new Response(
      JSON.stringify({ error: 'Profile not found' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  return new Response(
    JSON.stringify({
      id: profile.id,
      username: profile.username,
      faucetUsedAt: profile.faucet_used_at,
      cyclesBalance: profile.cycles_balance,
      createdAt: profile.created_at,
      updatedAt: profile.updated_at
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

// PUT /functions/v1/profile - Update user profile
async function handleUpdateProfile(supabase: SupabaseClient, userId: string, req: Request) {
  const { username } = await req.json()

  if (!username || typeof username !== 'string') {
    return new Response(
      JSON.stringify({ error: 'Username is required and must be a string' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .update({ username: username.trim() })
    .eq('id', userId)
    .select('id, username, faucet_used_at, cycles_balance, created_at, updated_at')
    .single()

  if (error) {
    console.error('Database error:', error)
    return new Response(
      JSON.stringify({ error: 'Failed to update profile' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  return new Response(
    JSON.stringify({
      id: profile.id,
      username: profile.username,
      faucetUsedAt: profile.faucet_used_at,
      cyclesBalance: profile.cycles_balance,
      createdAt: profile.created_at,
      updatedAt: profile.updated_at
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

/* To invoke locally:

  1. Run `supabase start`
  2. Get a valid JWT token by signing in
  3. Make HTTP requests:

  # Get profile
  curl -i --location --request GET 'http://127.0.0.1:54321/functions/v1/profile' \
    --header 'Authorization: Bearer YOUR_JWT_TOKEN'

  # Update profile
  curl -i --location --request PUT 'http://127.0.0.1:54321/functions/v1/profile' \
    --header 'Authorization: Bearer YOUR_JWT_TOKEN' \
    --header 'Content-Type: application/json' \
    --data '{"username":"newusername"}'

*/
