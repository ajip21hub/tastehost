import { connection } from "next/server";
import { llmConfig, llmLabel } from "@/lib/llm";
import { qlooConfigured } from "@/lib/qloo";

export async function GET() {
  await connection();
  return Response.json({ qloo: qlooConfigured() ? "configured" : "sample-data", llm: llmLabel(llmConfig()) });
}
