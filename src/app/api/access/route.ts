import { NextResponse } from "next/server";
import { availableModes } from "@/lib/ai/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which ways of paying for questions this deployment supports. Reveals no secrets. */
export function GET() {
  return NextResponse.json(availableModes());
}
