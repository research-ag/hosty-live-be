import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface DnsQuery {
  name: string;
  type: string;
  server?: string;
}

export interface DnsResult {
  name: string;
  type: string;
  server?: string;
  answers: string[];
  error?: string;
}

async function executeSingleDnsQuery(query: DnsQuery): Promise<DnsResult> {
  const { name, type, server } = query;

  try {
    // Build dig command
    const digArgs = [];

    // Add server if specified (format: @server)
    if (server) {
      digArgs.push(`@${server}`);
    }

    // Add domain name
    digArgs.push(name);

    // Add record type
    digArgs.push(type);

    // Add +short flag for clean output
    digArgs.push("+short");

    const command = `dig ${digArgs.join(" ")}`;
    console.log(`[DNS-QUERY] Executing: ${command}`);

    // Execute dig command
    const { stdout, stderr } = await execAsync(command, {
      timeout: 10000, // 10 second timeout
      maxBuffer: 1024 * 1024, // 1MB buffer
    });

    if (stderr) {
      console.error(`[DNS-QUERY] dig stderr for ${name}:`, stderr);
    }

    // Parse output - each line is an answer
    const answers = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    console.log(`[DNS-QUERY] Result for ${name} (${type}):`, answers);

    return {
      name,
      type,
      server,
      answers,
    };
  } catch (error) {
    console.error(`[DNS-QUERY] Error executing DNS query for ${name}:`, error);

    return {
      name,
      type,
      server,
      answers: [],
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function executeDnsQueries(
  queries: DnsQuery[]
): Promise<DnsResult[]> {
  console.log(`[DNS-QUERY] Processing ${queries.length} DNS queries`);

  // Execute all queries in parallel
  const results = await Promise.all(
    queries.map((query) => executeSingleDnsQuery(query))
  );

  return results;
}
