import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { verifyRebalanceEvent } from "@/lib/verifier";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { signature } = body;

    const store = getStore();
    const event = store.events.find(
      (e) => e.signature === signature || e.id === signature
    );

    if (!event) {
      return NextResponse.json(
        { error: `Event with signature or ID '${signature}' not found` },
        { status: 404 }
      );
    }

    const verificationResult = verifyRebalanceEvent(event);

    return NextResponse.json({
      success: true,
      result: verificationResult,
      event,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
