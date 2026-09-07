import { NextRequest, NextResponse } from "next/server";

// Static QRIS needs no API credentials. This route is reserved for a future provider webhook.
export async function POST(request: NextRequest) {
  const signature = request.headers.get("x-kawansela-signature");
  if (
    !process.env.QRIS_WEBHOOK_SECRET ||
    signature !== process.env.QRIS_WEBHOOK_SECRET
  )
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await request.json();
  return NextResponse.json(
    { accepted: true, provider: process.env.QRIS_PROVIDER ?? "unconfigured" },
    { status: 202 },
  );
}
