import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

console.log("Cycles Function loaded")

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
}

// Constants
const CANISTER_CREATION_COST = 800_000_000_000n // 0.8 TC

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
        return await handleGetCyclesInfo(supabase, user.id)
      
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

// GET /functions/v1/cycles - Get cycles information
async function handleGetCyclesInfo(supabase: SupabaseClient, userId: string) {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('cycles_balance')
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

  const currentBalance = BigInt(profile.cycles_balance)
  const canCreateCanister = currentBalance >= CANISTER_CREATION_COST

  return new Response(
    JSON.stringify({
      cyclesBalance: profile.cycles_balance,
      canisterCreationCost: CANISTER_CREATION_COST.toString(),
      canCreateCanister,
      balanceFormatted: formatCycles(currentBalance)
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

// Helper function to format cycles in a human-readable way
function formatCycles(cycles: bigint): string {
  const trillion = 1_000_000_000_000n
  const billion = 1_000_000_000n
  const million = 1_000_000n

  if (cycles >= trillion) {
    const tc = cycles / trillion
    const remainder = (cycles % trillion) / (trillion / 100n)
    return remainder > 0n ? `${tc}.${remainder.toString().padStart(2, '0')} TC` : `${tc} TC`
  } else if (cycles >= billion) {
    const gc = cycles / billion
    const remainder = (cycles % billion) / (billion / 100n)
    return remainder > 0n ? `${gc}.${remainder.toString().padStart(2, '0')} GC` : `${gc} GC`
  } else if (cycles >= million) {
    const mc = cycles / million
    const remainder = (cycles % million) / (million / 100n)
    return remainder > 0n ? `${mc}.${remainder.toString().padStart(2, '0')} MC` : `${mc} MC`
  } else {
    return `${cycles} cycles`
  }
} 