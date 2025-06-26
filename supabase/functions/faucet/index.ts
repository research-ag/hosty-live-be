import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

console.log("Faucet Function loaded")

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
}

// Constants
const FAUCET_AMOUNT = 2_000_000_000_000n // 2 TC
const FAUCET_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000 // 1 week

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
        return await handleGetFaucetStatus(supabase, user.id)
      
      case 'POST':
        return await handleUseFaucet(supabase, user.id)
      
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

// GET /functions/v1/faucet - Check faucet eligibility
async function handleGetFaucetStatus(supabase: SupabaseClient, userId: string) {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('faucet_used_at, cycles_balance')
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

  const now = new Date()
  const lastUsed = profile.faucet_used_at ? new Date(profile.faucet_used_at) : null
  const canUseFaucet = !lastUsed || (now.getTime() - lastUsed.getTime()) >= FAUCET_COOLDOWN_MS
  
  let nextAvailableAt = null
  if (lastUsed && !canUseFaucet) {
    nextAvailableAt = new Date(lastUsed.getTime() + FAUCET_COOLDOWN_MS)
  }

  return new Response(
    JSON.stringify({
      canUseFaucet,
      cyclesBalance: profile.cycles_balance,
      faucetAmount: FAUCET_AMOUNT.toString(),
      lastUsedAt: profile.faucet_used_at,
      nextAvailableAt: nextAvailableAt?.toISOString() || null,
      cooldownMs: FAUCET_COOLDOWN_MS
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

// POST /functions/v1/faucet - Use faucet to get free cycles
async function handleUseFaucet(supabase: SupabaseClient, userId: string) {
  // Get current profile
  const { data: profile, error: fetchError } = await supabase
    .from('profiles')
    .select('faucet_used_at, cycles_balance')
    .eq('id', userId)
    .single()

  if (fetchError) {
    console.error('Database error:', fetchError)
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

  // Check if user can use faucet
  const now = new Date()
  const lastUsed = profile.faucet_used_at ? new Date(profile.faucet_used_at) : null
  const canUseFaucet = !lastUsed || (now.getTime() - lastUsed.getTime()) >= FAUCET_COOLDOWN_MS

  if (!canUseFaucet) {
    const nextAvailableAt = new Date(lastUsed!.getTime() + FAUCET_COOLDOWN_MS)
    return new Response(
      JSON.stringify({ 
        error: 'Faucet is on cooldown',
        nextAvailableAt: nextAvailableAt.toISOString(),
        cooldownMs: FAUCET_COOLDOWN_MS
      }),
      { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Update profile with new cycles and faucet usage timestamp
  const newBalance = BigInt(profile.cycles_balance) + FAUCET_AMOUNT
  const { data: updatedProfile, error: updateError } = await supabase
    .from('profiles')
    .update({ 
      cycles_balance: newBalance.toString(),
      faucet_used_at: now.toISOString()
    })
    .eq('id', userId)
    .select('cycles_balance, faucet_used_at')
    .single()

  if (updateError) {
    console.error('Database error:', updateError)
    return new Response(
      JSON.stringify({ error: 'Failed to update profile' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  return new Response(
    JSON.stringify({
      success: true,
      cyclesAdded: FAUCET_AMOUNT.toString(),
      newBalance: updatedProfile.cycles_balance,
      faucetUsedAt: updatedProfile.faucet_used_at,
      nextAvailableAt: new Date(now.getTime() + FAUCET_COOLDOWN_MS).toISOString()
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
} 